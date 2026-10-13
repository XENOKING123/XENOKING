/*
 * http_sce.c — PS5 transport (SPEC §4.2): libSceNet / libSceSsl / libSceHttp2
 * resolved at runtime with dlopen/dlsym so the payload never carries a
 * DT_NEEDED on libraries that may be absent or renamed on a firmware.
 *
 * Two backends share one code path through a function table:
 *   - "sceHttp2" (preferred): sceHttp2Init / CreateTemplate / CreateRequestWithURL …
 *   - "sceHttp"  (fallback):  the v1 API, which needs a connection object
 *     between the template and the request.
 * Every optional symbol (timeouts, auto-redirect, abort, SSL callback) is
 * looked up by name, logged once when missing and skipped.
 *
 * Request lifetime: one template + one request per xhttp_open(); the reader
 * streams with 256 KiB sceHttp*ReadData calls and checks the cancel flag
 * between reads; xhttp_abort() calls *AbortRequest when it resolved.
 * Redirects are followed manually (301/302/303/307/308) so the final URL is
 * known and the Range header is re-sent on the new location.
 */
#include "http_client.h"
#include "log.h"
#include "util.h"

#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- Sony prototypes (as function pointer types) ------------------------- */
typedef int (*fn_sceNetInit)(void);
typedef int (*fn_sceNetPoolCreate)(const char *, int, int);
typedef int (*fn_sceSslInit)(size_t);
/* Http2 */
typedef int (*fn_h2_Init)(int, int, size_t, int);
typedef int (*fn_h2_CreateTemplate)(int, const char *, int, int);
typedef int (*fn_h2_DeleteTemplate)(int);
typedef int (*fn_h2_CreateRequestWithURL)(int, const char *, const char *, uint64_t);
typedef int (*fn_h2_DeleteRequest)(int);
typedef int (*fn_h2_AddRequestHeader)(int, const char *, const char *, uint32_t);
typedef int (*fn_h2_SendRequest)(int, const void *, size_t);
typedef int (*fn_h2_GetStatusCode)(int, int *);
typedef int (*fn_h2_GetAllResponseHeaders)(int, char **, size_t *);
typedef int (*fn_h2_ReadData)(int, void *, size_t);
typedef int (*fn_h2_AbortRequest)(int);
typedef int (*fn_h2_SetTimeout)(int, uint32_t);          /* usec */
typedef int (*fn_h2_SetAutoRedirect)(int, int);
/* Http (v1) */
typedef int (*fn_h1_Init)(int, int, size_t);
typedef int (*fn_h1_CreateTemplate)(int, const char *, int, int);
typedef int (*fn_h1_DeleteTemplate)(int);
typedef int (*fn_h1_CreateConnectionWithURL)(int, const char *, int);
typedef int (*fn_h1_DeleteConnection)(int);
typedef int (*fn_h1_CreateRequestWithURL)(int, int, const char *, uint64_t);
typedef int (*fn_h1_DeleteRequest)(int);
typedef int (*fn_h1_SslCallback)(int, unsigned int, void *const *, int, void *);
typedef int (*fn_h1_SetSslCallback)(int, fn_h1_SslCallback, void *);
typedef int (*fn_h1_SetResponseHeaderMaxSize)(int, size_t);

enum { SCE_HTTP_METHOD_GET = 0, SCE_HTTP_METHOD_POST = 1, SCE_HTTP_METHOD_HEAD = 2, SCE_HTTP_METHOD_PUT = 4, SCE_HTTP_METHOD_DELETE = 5 };

typedef struct sce_api {
  int v2;                    /* 1 = sceHttp2, 0 = sceHttp */
  int ctx;                   /* http context id */
  /* common (both backends, same signatures) */
  fn_h2_DeleteTemplate DeleteTemplate;
  fn_h2_DeleteRequest DeleteRequest;
  fn_h2_AddRequestHeader AddRequestHeader;
  fn_h2_SendRequest SendRequest;
  fn_h2_GetStatusCode GetStatusCode;
  fn_h2_GetAllResponseHeaders GetAllResponseHeaders;
  fn_h2_ReadData ReadData;
  fn_h2_AbortRequest AbortRequest;              /* optional */
  fn_h2_SetTimeout SetConnectTimeOut, SetRecvTimeOut, SetSendTimeOut;   /* optional */
  fn_h2_SetAutoRedirect SetAutoRedirect;        /* optional */
  /* v2 only */
  fn_h2_CreateTemplate h2_CreateTemplate;
  fn_h2_CreateRequestWithURL h2_CreateRequestWithURL;
  /* v1 only */
  fn_h1_CreateTemplate h1_CreateTemplate;
  fn_h1_CreateConnectionWithURL h1_CreateConnectionWithURL;
  fn_h1_DeleteConnection h1_DeleteConnection;
  fn_h1_CreateRequestWithURL h1_CreateRequestWithURL;
  fn_h1_SetSslCallback h1_SetSslCallback;      /* optional */
  fn_h1_SetResponseHeaderMaxSize h1_SetResponseHeaderMaxSize;   /* optional */
} sce_api;

struct xhttp_conn {
  int tmpl, conn, req;
  volatile int *cancel;
  volatile int aborted;
  int head_only;
  int eof;
};

static pthread_once_t init_once = PTHREAD_ONCE_INIT;
static int g_available;
static int g_init_rc = -1;
static sce_api A;
static char g_backend[16] = "none";
static int g_net_mem = -1, g_ssl_ctx = -1;

/* ---- loading -------------------------------------------------------------- */

static void *load_lib(const char *name) {
  const char *const dirs[] = {"", "/system/common/lib/", "/system_ex/common/lib/", "/system/priv/lib/"};
  for (size_t i = 0; i < XS_ARRAY_LEN(dirs); i++) {
    char path[160];
    xsnprintf(path, sizeof path, "%s%s", dirs[i], name);
    void *h = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
    if (h) { LOGI("http: loaded %s", path); return h; }
  }
  const char *e = dlerror();
  LOGW("http: dlopen(%s) failed: %s", name, e ? e : "unknown");
  return NULL;
}

static void *sym(void *lib, const char *name, int required) {
  void *p = lib ? dlsym(lib, name) : NULL;
  if (!p) p = dlsym(RTLD_DEFAULT, name);
  if (!p) {
    if (required) LOGW("http: required symbol %s is missing", name);
    else LOGI("http: optional symbol %s not available", name);
  }
  return p;
}

static int bind_v2(void *lib) {
  A.v2 = 1;
  A.h2_CreateTemplate = (fn_h2_CreateTemplate)sym(lib, "sceHttp2CreateTemplate", 1);
  A.DeleteTemplate = (fn_h2_DeleteTemplate)sym(lib, "sceHttp2DeleteTemplate", 1);
  A.h2_CreateRequestWithURL = (fn_h2_CreateRequestWithURL)sym(lib, "sceHttp2CreateRequestWithURL", 1);
  A.DeleteRequest = (fn_h2_DeleteRequest)sym(lib, "sceHttp2DeleteRequest", 1);
  A.AddRequestHeader = (fn_h2_AddRequestHeader)sym(lib, "sceHttp2AddRequestHeader", 1);
  A.SendRequest = (fn_h2_SendRequest)sym(lib, "sceHttp2SendRequest", 1);
  A.GetStatusCode = (fn_h2_GetStatusCode)sym(lib, "sceHttp2GetStatusCode", 1);
  A.GetAllResponseHeaders = (fn_h2_GetAllResponseHeaders)sym(lib, "sceHttp2GetAllResponseHeaders", 1);
  A.ReadData = (fn_h2_ReadData)sym(lib, "sceHttp2ReadData", 1);
  A.AbortRequest = (fn_h2_AbortRequest)sym(lib, "sceHttp2AbortRequest", 0);
  A.SetConnectTimeOut = (fn_h2_SetTimeout)sym(lib, "sceHttp2SetConnectTimeOut", 0);
  A.SetRecvTimeOut = (fn_h2_SetTimeout)sym(lib, "sceHttp2SetRecvTimeOut", 0);
  A.SetSendTimeOut = (fn_h2_SetTimeout)sym(lib, "sceHttp2SetSendTimeOut", 0);
  A.SetAutoRedirect = (fn_h2_SetAutoRedirect)sym(lib, "sceHttp2SetAutoRedirect", 0);
  return A.h2_CreateTemplate && A.DeleteTemplate && A.h2_CreateRequestWithURL && A.DeleteRequest && A.AddRequestHeader &&
         A.SendRequest && A.GetStatusCode && A.GetAllResponseHeaders && A.ReadData;
}

static int bind_v1(void *lib) {
  A.v2 = 0;
  A.h1_CreateTemplate = (fn_h1_CreateTemplate)sym(lib, "sceHttpCreateTemplate", 1);
  A.DeleteTemplate = (fn_h2_DeleteTemplate)sym(lib, "sceHttpDeleteTemplate", 1);
  A.h1_CreateConnectionWithURL = (fn_h1_CreateConnectionWithURL)sym(lib, "sceHttpCreateConnectionWithURL", 1);
  A.h1_DeleteConnection = (fn_h1_DeleteConnection)sym(lib, "sceHttpDeleteConnection", 1);
  A.h1_CreateRequestWithURL = (fn_h1_CreateRequestWithURL)sym(lib, "sceHttpCreateRequestWithURL", 1);
  A.DeleteRequest = (fn_h2_DeleteRequest)sym(lib, "sceHttpDeleteRequest", 1);
  A.AddRequestHeader = (fn_h2_AddRequestHeader)sym(lib, "sceHttpAddRequestHeader", 1);
  A.SendRequest = (fn_h2_SendRequest)sym(lib, "sceHttpSendRequest", 1);
  A.GetStatusCode = (fn_h2_GetStatusCode)sym(lib, "sceHttpGetStatusCode", 1);
  A.GetAllResponseHeaders = (fn_h2_GetAllResponseHeaders)sym(lib, "sceHttpGetAllResponseHeaders", 1);
  A.ReadData = (fn_h2_ReadData)sym(lib, "sceHttpReadData", 1);
  A.AbortRequest = (fn_h2_AbortRequest)sym(lib, "sceHttpAbortRequest", 0);
  A.SetConnectTimeOut = (fn_h2_SetTimeout)sym(lib, "sceHttpSetConnectTimeOut", 0);
  A.SetRecvTimeOut = (fn_h2_SetTimeout)sym(lib, "sceHttpSetRecvTimeOut", 0);
  A.SetSendTimeOut = (fn_h2_SetTimeout)sym(lib, "sceHttpSetSendTimeOut", 0);
  A.SetAutoRedirect = (fn_h2_SetAutoRedirect)sym(lib, "sceHttpSetAutoRedirect", 0);
  A.h1_SetSslCallback = (fn_h1_SetSslCallback)sym(lib, "sceHttpsSetSslCallback", 0);
  A.h1_SetResponseHeaderMaxSize = (fn_h1_SetResponseHeaderMaxSize)sym(lib, "sceHttpSetResponseHeaderMaxSize", 0);
  return A.h1_CreateTemplate && A.DeleteTemplate && A.h1_CreateConnectionWithURL && A.h1_DeleteConnection &&
         A.h1_CreateRequestWithURL && A.DeleteRequest && A.AddRequestHeader && A.SendRequest && A.GetStatusCode &&
         A.GetAllResponseHeaders && A.ReadData;
}

static void do_init(void) {
  void *net = load_lib("libSceNet.sprx");
  void *ssl = load_lib("libSceSsl.sprx");
  fn_sceNetInit NetInit = (fn_sceNetInit)sym(net, "sceNetInit", 1);
  fn_sceNetPoolCreate NetPoolCreate = (fn_sceNetPoolCreate)sym(net, "sceNetPoolCreate", 1);
  fn_sceSslInit SslInit = (fn_sceSslInit)sym(ssl, "sceSslInit", 1);
  if (!NetInit || !NetPoolCreate || !SslInit) { xhttp_set_error("libSceNet/libSceSsl unavailable"); return; }
  int rc = NetInit();
  if (rc != 0 && (unsigned)rc != 0x804101C0u /* already initialized */) LOGW("http: sceNetInit -> 0x%08x", (unsigned)rc);
  g_net_mem = NetPoolCreate("xeno-store", 1 << 20, 0);
  if (g_net_mem < 0) { xhttp_set_error("sceNetPoolCreate failed 0x%08x", (unsigned)g_net_mem); return; }
  g_ssl_ctx = SslInit(512 * 1024);
  if (g_ssl_ctx < 0) { xhttp_set_error("sceSslInit failed 0x%08x", (unsigned)g_ssl_ctx); return; }

  void *h2 = load_lib("libSceHttp2.sprx");
  fn_h2_Init H2Init = (fn_h2_Init)sym(h2, "sceHttp2Init", h2 != NULL);
  if (h2 && H2Init && bind_v2(h2)) {
    A.ctx = H2Init(g_net_mem, g_ssl_ctx, 1 << 20, 32);
    if (A.ctx >= 0) { xstrlcpy(g_backend, "sceHttp2", sizeof g_backend); g_available = 1; g_init_rc = 0; LOGI("http: sceHttp2 ready (ctx %d)", A.ctx); return; }
    LOGW("http: sceHttp2Init -> 0x%08x, trying sceHttp", (unsigned)A.ctx);
  }
  memset(&A, 0, sizeof A);
  void *h1 = load_lib("libSceHttp.sprx");
  fn_h1_Init H1Init = (fn_h1_Init)sym(h1, "sceHttpInit", 1);
  if (h1 && H1Init && bind_v1(h1)) {
    A.ctx = H1Init(g_net_mem, g_ssl_ctx, 2 << 20);
    if (A.ctx >= 0) { xstrlcpy(g_backend, "sceHttp", sizeof g_backend); g_available = 1; g_init_rc = 0; LOGI("http: sceHttp ready (ctx %d)", A.ctx); return; }
    LOGW("http: sceHttpInit -> 0x%08x", (unsigned)A.ctx);
  }
  xhttp_set_error("no usable Sony HTTP library on this firmware");
  LOGE("http: downloads unavailable — neither sceHttp2 nor sceHttp could be initialized");
}

int xhttp_global_init(void) {
  pthread_once(&init_once, do_init);
  return g_init_rc;
}

int xhttp_available(void) { return g_available; }
const char *xhttp_backend_name(void) { return g_backend; }

/* ---- request ------------------------------------------------------------- */

static int ssl_accept_any(int id, unsigned int err, void *const *certs, int n, void *arg) {
  (void)id; (void)err; (void)certs; (void)n; (void)arg;
  return 0;
}

static void conn_release(xhttp_conn *c) {
  if (!c) return;
  if (c->req >= 0 && A.DeleteRequest) A.DeleteRequest(c->req);
  if (c->conn >= 0 && !A.v2 && A.h1_DeleteConnection) A.h1_DeleteConnection(c->conn);
  if (c->tmpl >= 0 && A.DeleteTemplate) A.DeleteTemplate(c->tmpl);
  free(c);
}

static int method_code(const char *m) {
  if (strcmp(m, "POST") == 0) return SCE_HTTP_METHOD_POST;
  if (strcmp(m, "HEAD") == 0) return SCE_HTTP_METHOD_HEAD;
  if (strcmp(m, "PUT") == 0) return SCE_HTTP_METHOD_PUT;
  if (strcmp(m, "DELETE") == 0) return SCE_HTTP_METHOD_DELETE;
  return SCE_HTTP_METHOD_GET;
}

static void apply_timeouts(int tmpl, const xhttp_req *req) {
  uint32_t cms = (uint32_t)(req->connect_timeout_ms > 0 ? req->connect_timeout_ms : 10000);
  uint32_t rms = (uint32_t)(req->recv_timeout_ms > 0 ? req->recv_timeout_ms : 30000);
  if (A.SetConnectTimeOut) A.SetConnectTimeOut(tmpl, cms * 1000u);
  if (A.SetRecvTimeOut) A.SetRecvTimeOut(tmpl, rms * 1000u);
  if (A.SetSendTimeOut) A.SetSendTimeOut(tmpl, rms * 1000u);
  if (A.SetAutoRedirect) A.SetAutoRedirect(tmpl, 0);   /* redirects are followed here */
}

/* Adds Range, Content-Length and the caller's extra headers. */
static int add_headers(int req_id, const xhttp_req *req) {
  char v[64];
  if (req->range_start >= 0) {
    if (req->range_end >= 0) xsnprintf(v, sizeof v, "bytes=%lld-%lld", (long long)req->range_start, (long long)req->range_end);
    else xsnprintf(v, sizeof v, "bytes=%lld-", (long long)req->range_start);
    if (A.AddRequestHeader(req_id, "Range", v, 0) != 0) { xhttp_set_error("cannot add Range header"); return -1; }
  }
  A.AddRequestHeader(req_id, "Accept", "*/*", 0);
  if (req->extra_headers) {
    char copy[2048];
    xstrlcpy(copy, req->extra_headers, sizeof copy);
    for (char *line = strtok(copy, "\r\n"); line; line = strtok(NULL, "\r\n")) {
      char *colon = strchr(line, ':');
      if (!colon) continue;
      *colon = 0;
      char *val = colon + 1;
      while (*val == ' ') val++;
      A.AddRequestHeader(req_id, line, val, 0);
    }
  }
  return 0;
}

/* Parses the raw response header block (status line + headers). */
static void parse_response_headers(xhttp_conn *c, xhttp_resp *resp) {
  char *hdr = NULL;
  size_t len = 0;
  if (A.GetAllResponseHeaders(c->req, &hdr, &len) != 0 || !hdr || !len) return;
  char *copy = malloc(len + 1);
  if (!copy) return;
  memcpy(copy, hdr, len);
  copy[len] = 0;
  char *line = copy;
  if (util_istarts_with(line, "HTTP/")) { char *nl = strchr(line, '\n'); line = nl ? nl + 1 : line + strlen(line); }
  while (*line) {
    char *nl = strchr(line, '\n');
    if (nl) *nl = 0;
    size_t l = strlen(line);
    if (l && line[l - 1] == '\r') line[l - 1] = 0;
    char *colon = strchr(line, ':');
    if (colon) xhttp_resp_header(resp, line, (size_t)(colon - line), colon + 1, strlen(colon + 1));
    if (!nl) break;
    line = nl + 1;
  }
  free(copy);
}

static int is_redirect(int s) { return s == 301 || s == 302 || s == 303 || s == 307 || s == 308; }

/* One request/response exchange on url; fills resp, returns the conn. */
static xhttp_conn *do_request(const xhttp_req *req, const char *method, const char *url, xhttp_resp *resp) {
  xhttp_conn *c = calloc(1, sizeof *c);
  if (!c) { xhttp_set_error("out of memory"); return NULL; }
  c->tmpl = c->conn = c->req = -1;
  c->cancel = req->cancel_flag;
  c->head_only = strcmp(method, "HEAD") == 0;
  const char *ua = req->user_agent ? req->user_agent : XHTTP_DEFAULT_UA;
  if (A.v2) {
    c->tmpl = A.h2_CreateTemplate(A.ctx, ua, 3, 1);
    if (c->tmpl < 0) { xhttp_set_error("sceHttp2CreateTemplate 0x%08x", (unsigned)c->tmpl); conn_release(c); return NULL; }
    apply_timeouts(c->tmpl, req);
    c->req = A.h2_CreateRequestWithURL(c->tmpl, method, url, (uint64_t)req->body_len);
    if (c->req < 0) { xhttp_set_error("sceHttp2CreateRequestWithURL 0x%08x", (unsigned)c->req); conn_release(c); return NULL; }
  } else {
    c->tmpl = A.h1_CreateTemplate(A.ctx, ua, 2 /* HTTP/1.1 */, 1);
    if (c->tmpl < 0) { xhttp_set_error("sceHttpCreateTemplate 0x%08x", (unsigned)c->tmpl); conn_release(c); return NULL; }
    apply_timeouts(c->tmpl, req);
    if (A.h1_SetResponseHeaderMaxSize) A.h1_SetResponseHeaderMaxSize(c->tmpl, 0x4000);
    if (req->insecure_tls && A.h1_SetSslCallback) A.h1_SetSslCallback(c->tmpl, ssl_accept_any, NULL);
    c->conn = A.h1_CreateConnectionWithURL(c->tmpl, url, 1);
    if (c->conn < 0) { xhttp_set_error("sceHttpCreateConnectionWithURL 0x%08x", (unsigned)c->conn); conn_release(c); return NULL; }
    c->req = A.h1_CreateRequestWithURL(c->conn, method_code(method), url, (uint64_t)req->body_len);
    if (c->req < 0) { xhttp_set_error("sceHttpCreateRequestWithURL 0x%08x", (unsigned)c->req); conn_release(c); return NULL; }
  }
  if (add_headers(c->req, req) != 0) { conn_release(c); return NULL; }
  int rc = A.SendRequest(c->req, req->body_len ? req->body : NULL, req->body_len);
  if (rc != 0) { xhttp_set_error("%sSendRequest 0x%08x", A.v2 ? "sceHttp2" : "sceHttp", (unsigned)rc); conn_release(c); return NULL; }
  int status = 0;
  if (A.GetStatusCode(c->req, &status) != 0) { xhttp_set_error("GetStatusCode failed"); conn_release(c); return NULL; }
  xhttp_resp_reset(resp);
  resp->status = status;
  parse_response_headers(c, resp);
  return c;
}

int xhttp_open(const xhttp_req *req, xhttp_conn **out, xhttp_resp *resp) {
  *out = NULL;
  xhttp_resp_reset(resp);
  xhttp_set_error("");
  if (xhttp_global_init() != 0 || !g_available) { xhttp_set_error("Sony HTTP library unavailable"); return -1; }
  char url[2048];
  xstrlcpy(url, req->url, sizeof url);
  xurl u;
  if (util_url_parse(url, &u) != 0) { xhttp_set_error("malformed URL"); return -1; }
  if (u.has_userinfo) { xhttp_set_error("URLs with credentials are not allowed"); return -1; }
  const char *method = req->method ? req->method : "GET";
  xhttp_req cur = *req;
  for (int hops = 0;; hops++) {
    if (req->cancel_flag && *req->cancel_flag) { xhttp_set_error("cancelled"); return -1; }
    xhttp_conn *c = do_request(&cur, method, url, resp);
    if (!c) return -1;
    if (is_redirect(resp->status) && resp->location[0] && hops < req->follow_redirects) {
      char next[2048];
      if (util_url_resolve(url, resp->location, next, sizeof next) != 0) { xhttp_set_error("bad redirect"); conn_release(c); return -1; }
      conn_release(c);
      xstrlcpy(url, next, sizeof url);
      if (resp->status == 303 && strcmp(method, "HEAD") != 0) { method = "GET"; cur.body = NULL; cur.body_len = 0; }
      LOGD("http: redirect %d -> %s", resp->status, url);
      continue;
    }
    xstrlcpy(resp->location, url, sizeof resp->location);
    if (c->head_only || resp->status == 204 || resp->status == 304) c->eof = 1;
    *out = c;
    return 0;
  }
}

int xhttp_read(xhttp_conn *c, void *buf, size_t cap) {
  if (!c || cap == 0) return -1;
  if (c->eof) return 0;
  if (c->aborted || (c->cancel && *c->cancel)) { xhttp_set_error("cancelled"); return -1; }
  if (cap > (256u << 10)) cap = 256u << 10;
  int n = A.ReadData(c->req, buf, cap);
  if (n > 0) return n;
  if (n == 0) { c->eof = 1; return 0; }
  if (c->aborted || (c->cancel && *c->cancel)) xhttp_set_error("cancelled");
  else xhttp_set_error("%sReadData 0x%08x", A.v2 ? "sceHttp2" : "sceHttp", (unsigned)n);
  return -1;
}

void xhttp_abort(xhttp_conn *c) {
  if (!c) return;
  c->aborted = 1;
  if (c->req >= 0 && A.AbortRequest) A.AbortRequest(c->req);
}

void xhttp_close(xhttp_conn *c) { conn_release(c); }
