/*
 * server.c — see server.h.
 *
 * Design: one acceptor thread pushes accepted sockets into a small ring;
 * HTTP_WORKERS worker threads pop them, read one request (bounded by
 * HTTP_MAX_* and a 15 s socket timeout), route it and close. There is no
 * keep-alive on purpose: the PS5 WebKit and phones open few connections and
 * "one request per connection" keeps the parser trivially robust.
 *
 * Static routes are served from the embedded assets (assets.h), gzip when
 * the client accepts it and a pre-compressed variant exists, with ETag/304.
 */
#include "server.h"
#include "api.h"
#include "assets.h"
#include "catalog.h"
#include "config.h"
#include "install.h"
#include "log.h"
#include "util.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

#define CONN_RING 64
#define CORS_HEADERS                                                                              \
  "Access-Control-Allow-Origin: *\r\n"                                                            \
  "Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS\r\n"                                 \
  "Access-Control-Allow-Headers: Content-Type, X-XENO-PIN, Authorization, If-None-Match, Range\r\n" \
  "Access-Control-Expose-Headers: ETag, Content-Length, Content-Range\r\n"
/* Defence-in-depth headers on every response (SPEC §15): never sniff a
 * content type, never leak the store URL as a referrer to a third party. */
#define SECURITY_HEADERS            \
  "X-Content-Type-Options: nosniff\r\n" \
  "Referrer-Policy: no-referrer\r\n"

static int listen_fd = -1;
static volatile int running = 0;
static volatile int force_rebind = 0;   /* host test hook (SIGUSR1) forces a listener rebuild */
static int g_listen_port = 0;
static pthread_t acceptor_th, worker_th[HTTP_WORKERS];
static pthread_mutex_t ring_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t ring_cv = PTHREAD_COND_INITIALIZER;
static int ring[CONN_RING];
static int ring_head, ring_count;

/* ---- low-level I/O ------------------------------------------------------ */

static int send_all(int fd, const void *buf, size_t n) {
  const char *p = buf;
  size_t off = 0;
  while (off < n) {
    ssize_t w = send(fd, p + off, n - off, MSG_NOSIGNAL);
    if (w < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        struct pollfd pf = { fd, POLLOUT, 0 };
        if (poll(&pf, 1, HTTP_READ_TIMEOUT_S * 1000) <= 0) return -1;
        continue;
      }
      return -1;
    }
    off += (size_t)w;
  }
  return 0;
}

const char *http_status_text(int s) {
  switch (s) {
    case 200: return "OK";
    case 204: return "No Content";
    case 206: return "Partial Content";
    case 304: return "Not Modified";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 409: return "Conflict";
    case 413: return "Payload Too Large";
    case 416: return "Range Not Satisfiable";
    case 422: return "Unprocessable Entity";
    case 500: return "Internal Server Error";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    default: return "Unknown";
  }
}

void http_send(http_req *r, int status, const char *content_type, const void *body, size_t len,
               const char *extra_headers) {
  if (r->responded) return;
  r->responded = 1;
  char hdr[2048];
  int n = xsnprintf(hdr, sizeof hdr,
                    "HTTP/1.1 %d %s\r\n"
                    "Content-Type: %s\r\n"
                    "Content-Length: %zu\r\n"
                    "Connection: close\r\n"
                    "Server: XENO-STORE/%s\r\n" SECURITY_HEADERS CORS_HEADERS "%s\r\n",
                    status, http_status_text(status), content_type ? content_type : "application/octet-stream",
                    len, XENO_VERSION, extra_headers ? extra_headers : "");
  if (send_all(r->fd, hdr, (size_t)n) != 0) return;
  if (strcmp(r->method, "HEAD") != 0 && body && len) send_all(r->fd, body, len);
}

void http_send_json(http_req *r, int status, jw *w) {
  size_t len = 0;
  char *txt = jw_detach(w, &len);
  if (!txt) { http_send_error(r, 500, "oom", "Out of memory while building the response"); return; }
  http_send(r, status, "application/json; charset=utf-8", txt, len, "Cache-Control: no-store\r\n");
  free(txt);
}

void http_send_error(http_req *r, int status, const char *code, const char *message) {
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_kv_bool(&w, "ok", 0);
  jw_kv_str(&w, "error", code);
  jw_kv_str(&w, "message", message);
  jw_kv_int(&w, "status", status);
  jw_obj_end(&w);
  http_send_json(r, status, &w);
}

/* ---- query string ------------------------------------------------------- */

int http_query_get(const http_req *r, const char *key, char *out, size_t cap) {
  size_t kl = strlen(key);
  const char *p = r->query;
  if (cap) out[0] = 0;
  while (*p) {
    const char *amp = strchr(p, '&');
    size_t plen = amp ? (size_t)(amp - p) : strlen(p);
    if (plen >= kl && strncmp(p, key, kl) == 0 && (plen == kl || p[kl] == '=')) {
      if (plen > kl) util_url_decode(p + kl + 1, plen - kl - 1, out, cap);
      return 1;
    }
    if (!amp) break;
    p = amp + 1;
  }
  return 0;
}

int http_query_int(const http_req *r, const char *key, int dflt) {
  char v[32];
  if (!http_query_get(r, key, v, sizeof v) || !v[0]) return dflt;
  return util_parse_int(v, dflt);
}

/* ---- request parsing ---------------------------------------------------- */

/* Reads until the header terminator; returns the header block (NUL
 * terminated) in buf and leaves any body bytes after *hdr_len. */
static int read_request_head(int fd, char *buf, size_t cap, size_t *total, size_t *hdr_len) {
  size_t len = 0;
  for (;;) {
    if (len >= 4) {
      buf[len] = 0;
      char *term = strstr(buf, "\r\n\r\n");
      size_t tl = 4;
      if (!term) { term = strstr(buf, "\n\n"); tl = 2; }
      if (term) { *hdr_len = (size_t)(term - buf) + tl; *total = len; return 0; }
    }
    if (len + 1 >= cap) return -2;   /* headers too large */
    ssize_t n = recv(fd, buf + len, cap - len - 1, 0);
    if (n < 0) { if (errno == EINTR) continue; return -1; }
    if (n == 0) return -1;
    len += (size_t)n;
  }
}

static int path_is_safe(const char *p) {
  if (p[0] != '/') return 0;
  for (const unsigned char *c = (const unsigned char *)p; *c; c++) if (*c < 0x20 || *c == 0x7f) return 0;
  if (strstr(p, "/../") || util_ends_with(p, "/..") || strstr(p, "/./")) return 0;
  if (strstr(p, "\\")) return 0;
  return 1;
}

static void parse_header_line(http_req *r, char *line, int64_t *content_length) {
  char *colon = strchr(line, ':');
  if (!colon) return;
  *colon = 0;
  char *v = colon + 1;
  while (*v == ' ' || *v == '\t') v++;
  util_trim(v);
  if (util_strieq(line, "Content-Length")) { int64_t cl; if (util_parse_i64(v, &cl) == 0) *content_length = cl; }
  else if (util_strieq(line, "Accept-Encoding")) r->accepts_gzip = util_strcasestr(v, "gzip") != NULL;
  else if (util_strieq(line, "If-None-Match")) xstrlcpy(r->if_none_match, v, sizeof r->if_none_match);
  else if (util_strieq(line, "Range")) xstrlcpy(r->range, v, sizeof r->range);
  else if (util_strieq(line, "X-XENO-PIN")) xstrlcpy(r->pin, v, sizeof r->pin);
  else if (util_strieq(line, "Content-Type")) xstrlcpy(r->content_type, v, sizeof r->content_type);
  else if (util_strieq(line, "Host")) { xstrlcpy(r->host, v, sizeof r->host); r->host_count++; }
  else if (util_strieq(line, "Origin")) { xstrlcpy(r->origin, v, sizeof r->origin); r->origin_count++; }
  else if (util_strieq(line, "Sec-Fetch-Site")) { xstrlcpy(r->sec_fetch_site, v, sizeof r->sec_fetch_site); util_lower(r->sec_fetch_site); r->site_count++; }
  else if (util_strieq(line, "Authorization")) xstrlcpy(r->authorization, v, sizeof r->authorization);
}

/* Returns 0 ok, otherwise an HTTP status to answer with. */
static int parse_request(http_req *r, char *buf, size_t total, size_t hdr_len) {
  char first_body_byte = buf[hdr_len];   /* NUL-terminate the head without losing the body */
  buf[hdr_len] = 0;
  char *line = buf;
  char *nl = strchr(line, '\n');
  if (!nl) return 400;
  *nl = 0;
  if (nl > line && nl[-1] == '\r') nl[-1] = 0;
  if (strlen(line) >= HTTP_MAX_REQLINE) return 414;
  char *sp1 = strchr(line, ' ');
  if (!sp1) return 400;
  *sp1 = 0;
  char *target = sp1 + 1;
  char *sp2 = strchr(target, ' ');
  if (sp2) *sp2 = 0;
  if (strlen(line) >= sizeof r->method) return 400;
  xstrlcpy(r->method, line, sizeof r->method);
  util_upper(r->method);
  char *q = strchr(target, '?');
  if (q) { *q = 0; xstrlcpy(r->query, q + 1, sizeof r->query); }
  char decoded[1024];
  int dn = util_url_decode(target, strlen(target), decoded, sizeof decoded);
  /* an embedded %00 would silently truncate the path: reject it explicitly */
  if (strlen(target) >= sizeof decoded - 1 || strlen(decoded) != (size_t)dn || !path_is_safe(decoded)) return 400;
  xstrlcpy(r->path, decoded, sizeof r->path);
  int64_t content_length = 0;
  for (line = nl + 1; *line;) {
    nl = strchr(line, '\n');
    if (!nl) break;
    *nl = 0;
    if (nl > line && nl[-1] == '\r') nl[-1] = 0;
    parse_header_line(r, line, &content_length);
    line = nl + 1;
  }
  buf[hdr_len] = first_body_byte;
  if (content_length < 0) return 400;
  if (content_length > (int64_t)HTTP_MAX_BODY) {
    /* Drain up to 8 MiB so the client can read the 413 instead of hitting EPIPE. */
    int64_t left = content_length - (int64_t)(total - hdr_len);
    char sink[4096];
    while (left > 0 && content_length <= (8LL << 20)) {
      ssize_t n = recv(r->fd, sink, sizeof sink, 0);
      if (n <= 0) break;
      left -= n;
    }
    return 413;
  }
  if (content_length > 0) {
    r->body = malloc((size_t)content_length + 1);
    if (!r->body) return 500;
    size_t have = total - hdr_len;
    if (have > (size_t)content_length) have = (size_t)content_length;
    memcpy(r->body, buf + hdr_len, have);
    while (have < (size_t)content_length) {
      ssize_t n = recv(r->fd, r->body + have, (size_t)content_length - have, 0);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) return 400;
      have += (size_t)n;
    }
    r->body[content_length] = 0;
    r->body_len = (size_t)content_length;
  }
  return 0;
}

/* ---- static routes ------------------------------------------------------ */

static void send_asset(http_req *r, const xs_asset *a, const char *ctype, const char *etag, const char *cache) {
  char extra[512];
  if (etag && r->if_none_match[0] && strcmp(r->if_none_match, etag) == 0) {
    xsnprintf(extra, sizeof extra, "ETag: %s\r\nCache-Control: %s\r\n", etag, cache);
    http_send(r, 304, ctype, NULL, 0, extra);
    return;
  }
  int gz = r->accepts_gzip && a->gz && a->gz_len;
  xsnprintf(extra, sizeof extra, "%s%s%sCache-Control: %s\r\nVary: Accept-Encoding\r\n",
            etag ? "ETag: " : "", etag ? etag : "", etag ? "\r\n" : "", cache);
  if (gz) xstrlcat(extra, "Content-Encoding: gzip\r\n", sizeof extra);
  http_send(r, 200, ctype, gz ? a->gz : a->data, gz ? a->gz_len : a->len, extra);
}

static void route_index(http_req *r) {
  char etag[64];
  xsnprintf(etag, sizeof etag, "\"ui-%s\"", XENO_BUILD_HASH);
  send_asset(r, &xs_index_html, "text/html; charset=utf-8", etag, "no-cache");
}

static void route_catalog(http_req *r) {
  catalog_blob *b = catalog_blob_acquire();
  if (!b) { http_send_error(r, 503, "no_catalog", "The catalog is not loaded"); return; }
  xs_asset a = { b->data, b->len, b->gz, b->gz_len };
  send_asset(r, &a, "application/json; charset=utf-8", b->etag, "no-cache");
  catalog_blob_release(b);
}

static void route_i18n(http_req *r) {
  const char *code = r->path + 6;   /* "/i18n/" */
  size_t n = strlen(code);
  if (n < 7 || !util_ends_with(code, ".json") || n - 5 > 16) { http_send_error(r, 404, "not_found", "Unknown locale"); return; }
  char want[24];
  memcpy(want, code, n - 5);
  want[n - 5] = 0;
  for (size_t i = 0; i < xs_i18n_count; i++) {
    if (strcmp(xs_i18n[i].code, want) == 0) {
      char etag[80];
      xsnprintf(etag, sizeof etag, "\"i18n-%s-%s\"", want, XENO_BUILD_HASH);
      send_asset(r, &xs_i18n[i].a, "application/json; charset=utf-8", etag, "no-cache");
      return;
    }
  }
  http_send_error(r, 404, "not_found", "Locale not embedded");
}

static void route_manifest(http_req *r) {
  static const char manifest[] =
      "{\"name\":\"XENO STORE\",\"short_name\":\"XENO\",\"start_url\":\"/\",\"display\":\"standalone\","
      "\"background_color\":\"#060b1c\",\"theme_color\":\"#ffce4a\",\"description\":\"PS5 game store and download manager\","
      "\"icons\":[{\"src\":\"/icon.png\",\"sizes\":\"512x512\",\"type\":\"image/png\"}]}";
  http_send(r, 200, "application/manifest+json", manifest, sizeof manifest - 1, "Cache-Control: no-cache\r\n");
}

/* /pkgsrv/<token>: range-capable serving of a staged .pkg, loopback only. */
static void route_pkgsrv(http_req *r) {
  if (!r->client_is_loopback) { http_send_error(r, 403, "forbidden", "pkgsrv is loopback only"); return; }
  const char *token = r->path + 8;
  char path[1024];
  if (!*token || strchr(token, '/') || install_pkgsrv_lookup(token, path, sizeof path) != 0) {
    http_send_error(r, 404, "not_found", "Unknown package token");
    return;
  }
  int fd = open(path, O_RDONLY);
  struct stat st;
  if (fd < 0 || fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) {
    if (fd >= 0) close(fd);
    http_send_error(r, 404, "not_found", "Package file missing");
    return;
  }
  int64_t total = (int64_t)st.st_size, start = 0, end = total - 1;
  int partial = 0;
  if (util_istarts_with(r->range, "bytes=")) {
    long long a = -1, b = -1;
    const char *spec = r->range + 6;
    if (spec[0] == '-') { b = atoll(spec + 1); a = total - b; b = total - 1; }
    else { a = atoll(spec); const char *dash = strchr(spec, '-'); b = (dash && dash[1]) ? atoll(dash + 1) : total - 1; }
    if (a < 0 || a >= total || b < a) {
      close(fd);
      char cr[64];
      xsnprintf(cr, sizeof cr, "Content-Range: bytes */%lld\r\n", (long long)total);
      http_send(r, 416, "text/plain", "range", 5, cr);
      return;
    }
    if (b >= total) b = total - 1;
    start = a; end = b; partial = 1;
  }
  int64_t len = end - start + 1;
  char hdr[768];
  int n = xsnprintf(hdr, sizeof hdr,
                    "HTTP/1.1 %d %s\r\nContent-Type: application/octet-stream\r\nContent-Length: %lld\r\n"
                    "Accept-Ranges: bytes\r\nConnection: close\r\n" SECURITY_HEADERS CORS_HEADERS,
                    partial ? 206 : 200, partial ? "Partial Content" : "OK", (long long)len);
  if (partial) n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "Content-Range: bytes %lld-%lld/%lld\r\n", (long long)start, (long long)end, (long long)total);
  n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "\r\n");
  r->responded = 1;
  if (send_all(r->fd, hdr, (size_t)n) != 0 || strcmp(r->method, "HEAD") == 0) { close(fd); return; }
  char *buf = malloc(256u << 10);
  if (!buf) { close(fd); return; }
  int64_t off = start;
  while (off <= end) {
    size_t want = (size_t)XS_MIN((int64_t)(256u << 10), end - off + 1);
    ssize_t rd = pread(fd, buf, want, off);
    if (rd <= 0) break;
    if (send_all(r->fd, buf, (size_t)rd) != 0) break;
    off += rd;
  }
  free(buf);
  close(fd);
}

/* Route table for non-API paths; extend here for new static resources. */
typedef struct static_route { const char *path; int prefix; void (*fn)(http_req *); } static_route;

static void route_logo(http_req *r) { send_asset(r, &xs_logo_jpg, "image/jpeg", "\"logo-" XENO_BUILD_HASH "\"", "max-age=86400"); }
static void route_icon(http_req *r) { send_asset(r, &xs_icon_png, "image/png", "\"icon-" XENO_BUILD_HASH "\"", "max-age=86400"); }

static const static_route STATIC_ROUTES[] = {
  { "/", 0, route_index },
  { "/index.html", 0, route_index },
  { "/logo.jpg", 0, route_logo },
  { "/icon.png", 0, route_icon },
  { "/manifest.webmanifest", 0, route_manifest },
  { "/catalog.json", 0, route_catalog },
  { "/i18n/", 1, route_i18n },
  { "/pkgsrv/", 1, route_pkgsrv },
};

/* DNS-rebind defence (SPEC §15, Orbit parity). Accept only Host values that
 * name this console on the LAN — a literal IPv4, "localhost", or a name in a
 * local-use namespace (*.local / *.home.arpa / *.localhost). No DNS lookup is
 * done: a public name an attacker points at the console with a hostile
 * resolver is refused on the Host header alone. An optional ":port" must match
 * the port we are listening on. Returns 1 when the Host is one of ours. */
static int host_is_local(const char *host, int port) {
  if (!host || !*host) return 0;
  size_t len = strlen(host);
  if (len > 259) return 0;
  char h[260];
  memcpy(h, host, len + 1);
  if (h[0] == '[') return 0;                 /* bracketed IPv6 — we serve IPv4 only */
  char *colon = strrchr(h, ':');
  if (colon) {
    *colon = 0;
    const char *p = colon + 1;
    if (!*p) return 0;
    long pr = 0;
    for (; *p; p++) { if (*p < '0' || *p > '9') return 0; pr = pr * 10 + (*p - '0'); if (pr > 65535) return 0; }
    if (port > 0 && pr != port) return 0;
  }
  len = strlen(h);
  if (len == 0 || len > 253) return 0;
  if (h[len - 1] == '.') { h[--len] = 0; if (!len) return 0; }
  size_t label = 0;
  for (size_t i = 0; i < len; i++) {
    char ch = h[i];
    if (ch >= 'A' && ch <= 'Z') h[i] = ch = (char)(ch - 'A' + 'a');
    if (ch == '.') { if (!label || h[i - 1] == '-') return 0; label = 0; }
    else {
      int ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-';
      if (!ok || (!label && ch == '-') || ++label > 63) return 0;
    }
  }
  if (!label || h[len - 1] == '-') return 0;
  if (strcmp(h, "localhost") == 0) return 1;
  struct in_addr a;
  if (inet_pton(AF_INET, h, &a) == 1) return 1;
  static const char *suffix[] = { ".home.arpa", ".local", ".localhost" };
  for (size_t i = 0; i < XS_ARRAY_LEN(suffix); i++) {
    size_t n = strlen(suffix[i]);
    if (len > n && strcmp(h + len - n, suffix[i]) == 0) return 1;
  }
  return 0;
}

/* Request-authority gate run before any routing. Returns 1 to allow, 0 after
 * answering the request with a 403 (the browser on the console and a phone on
 * the LAN both pass; evil.com in the Host header does not). */
static int security_gate(http_req *r) {
  if (r->host_count != 1 || r->origin_count > 1 || r->site_count > 1) {
    http_send_error(r, 403, "forbidden", "Request authority headers are malformed.");
    return 0;
  }
  if (!host_is_local(r->host, g_cfg.port)) {
    http_send_error(r, 403, "forbidden",
                    "Reach XENO STORE by the console's IP address or a .local / .home.arpa name.");
    return 0;
  }
  if (r->origin[0]) {
    char expected[300];
    xsnprintf(expected, sizeof expected, "http://%s", r->host);
    if (!util_strieq(r->origin, expected)) {
      http_send_error(r, 403, "forbidden", "Origin does not match this console.");
      return 0;
    }
  }
  if ((util_starts_with(r->path, "/api/") || strcmp(r->path, "/api") == 0) && r->sec_fetch_site[0] &&
      strcmp(r->sec_fetch_site, "same-origin") != 0 && strcmp(r->sec_fetch_site, "none") != 0) {
    http_send_error(r, 403, "forbidden", "Open XENO STORE directly on this console or your local network.");
    return 0;
  }
  return 1;
}

static void dispatch(http_req *r) {
  if (!security_gate(r)) return;
  if (strcmp(r->method, "OPTIONS") == 0) { http_send(r, 204, "text/plain", NULL, 0, "Access-Control-Max-Age: 600\r\n"); return; }
  if (util_starts_with(r->path, "/api/") || strcmp(r->path, "/api") == 0) { api_handle(r); return; }
  if (strcmp(r->method, "GET") != 0 && strcmp(r->method, "HEAD") != 0) {
    http_send_error(r, 405, "method_not_allowed", "Only GET is supported for static resources");
    return;
  }
  for (size_t i = 0; i < XS_ARRAY_LEN(STATIC_ROUTES); i++) {
    const static_route *s = &STATIC_ROUTES[i];
    if ((s->prefix && util_starts_with(r->path, s->path)) || (!s->prefix && strcmp(r->path, s->path) == 0)) { s->fn(r); return; }
  }
  http_send_error(r, 404, "not_found", "No such route");
}

/* ---- connection handling ------------------------------------------------ */

static void handle_connection(int fd, const struct sockaddr_in *peer) {
  http_req r;
  memset(&r, 0, sizeof r);
  r.fd = fd;
  struct timeval tv = { HTTP_READ_TIMEOUT_S, 0 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
  inet_ntop(AF_INET, &peer->sin_addr, r.client_ip, sizeof r.client_ip);
  r.client_is_loopback = (ntohl(peer->sin_addr.s_addr) >> 24) == 127;

  size_t cap = HTTP_MAX_REQLINE + HTTP_MAX_HEADERS + 1;
  char *buf = malloc(cap);
  if (!buf) { close(fd); return; }
  size_t total = 0, hdr_len = 0;
  int rc = read_request_head(fd, buf, cap, &total, &hdr_len);
  if (rc == -2) { xstrlcpy(r.method, "GET", sizeof r.method); http_send_error(&r, 431, "headers_too_large", "Request headers exceed 16 KiB"); }
  else if (rc == 0) {
    int st = parse_request(&r, buf, total, hdr_len);
    if (st == 0) dispatch(&r);
    else {
      if (!r.method[0]) xstrlcpy(r.method, "GET", sizeof r.method);
      http_send_error(&r, st, st == 413 ? "body_too_large" : st == 414 ? "uri_too_long" : "bad_request",
                      st == 413 ? "Request body exceeds 1 MiB" : "Malformed request");
    }
  }
  free(buf);
  free(r.body);
  shutdown(fd, SHUT_WR);
  close(fd);
}

static void *worker_main(void *arg) {
  (void)arg;
  for (;;) {
    pthread_mutex_lock(&ring_mu);
    while (running && ring_count == 0) pthread_cond_wait(&ring_cv, &ring_mu);
    if (!running && ring_count == 0) { pthread_mutex_unlock(&ring_mu); return NULL; }
    int fd = ring[ring_head];
    ring_head = (ring_head + 1) % CONN_RING;
    ring_count--;
    pthread_cond_broadcast(&ring_cv);
    pthread_mutex_unlock(&ring_mu);
    struct sockaddr_in peer;
    socklen_t pl = sizeof peer;
    memset(&peer, 0, sizeof peer);
    getpeername(fd, (struct sockaddr *)&peer, &pl);
    handle_connection(fd, &peer);
  }
}

/* Binds a fresh listening socket on `port`. Returns the fd or -1 (errno kept). */
static int bind_listener(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_ANY);
  a.sin_port = htons((uint16_t)port);
  if (bind(fd, (struct sockaddr *)&a, sizeof a) != 0 || listen(fd, 64) != 0) {
    int e = errno;
    close(fd);
    errno = e;
    return -1;
  }
  return fd;
}

/* The listener still reports as a listening socket. A stale fd whose network
 * stack was reset after a sleep/wake can keep fd >= 0 while refusing every
 * connection — checked separately by listener_refused(). */
static int listener_listening(int fd) {
  if (fd < 0) return 0;
  int on = 0;
  socklen_t sl = sizeof on;
  if (getsockopt(fd, SOL_SOCKET, SO_ACCEPTCONN, &on, &sl) != 0) return 0;
  return on != 0;
}

/* A loopback connect to our own port is actively refused (the listener is
 * gone), as opposed to merely busy. Only ECONNREFUSED is conclusive; a full
 * backlog or resource limit is inconclusive and ignored. */
static int listener_refused(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 0;
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) { close(fd); return 0; }
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  a.sin_port = htons((uint16_t)port);
  int rc = connect(fd, (struct sockaddr *)&a, sizeof a);
  int err = rc == 0 ? 0 : errno;
  if (err == EINPROGRESS || err == EWOULDBLOCK) {
    struct pollfd pf = { fd, POLLOUT, 0 };
    socklen_t el = sizeof err;
    err = 0;
    if (poll(&pf, 1, 50) > 0 && getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &el) != 0) err = 0;
  }
  close(fd);
  return err == ECONNREFUSED;
}

/* Self-healing listener (SPEC §17.15): a watchdog closes a dead :port socket
 * and rebinds with 500 ms → 8 s backoff so downloads survive a network blip.
 * Runs in the acceptor thread, which is the only owner of listen_fd. */
static void *acceptor_main(void *arg) {
  (void)arg;
  int64_t next_check = 0;
  int refused = 0;
  unsigned backoff = 500;
  while (running) {
    if (listen_fd < 0) {   /* (re)bind with bounded backoff */
      for (unsigned slept = 0; running && slept < backoff; slept += 50) util_sleep_ms(50);
      if (!running) break;
      int fd = bind_listener(g_listen_port);
      if (fd < 0) { LOGW("server: rebind on :%d failed (%s), retrying", g_listen_port, strerror(errno)); backoff = backoff < 8000 ? backoff * 2 : 8000; continue; }
      listen_fd = fd;
      backoff = 500;
      refused = 0;
      next_check = 0;
      LOGW("server: listener rebound on :%d", g_listen_port);
      continue;
    }
    struct pollfd pf = { listen_fd, POLLIN, 0 };
    int pr = poll(&pf, 1, 250);
    if (!running) break;
    if (force_rebind || (pf.revents & (POLLERR | POLLNVAL | POLLHUP)) || (pr < 0 && errno != EINTR)) {
      force_rebind = 0;
      LOGW("server: listener on :%d is unhealthy — rebinding", g_listen_port);
      close(listen_fd);
      listen_fd = -1;
      continue;
    }
    int64_t now = util_now_ms();
    if (now >= next_check) {
      next_check = now + 2000;
      if (!listener_listening(listen_fd)) { close(listen_fd); listen_fd = -1; LOGW("server: listener stopped listening — rebinding"); continue; }
      if (listener_refused(g_listen_port)) { if (++refused >= 3) { close(listen_fd); listen_fd = -1; refused = 0; LOGW("server: listener refusing connections — rebinding"); continue; } }
      else refused = 0;
    }
    if (pr <= 0) continue;
    struct sockaddr_in peer;
    socklen_t pl = sizeof peer;
    int fd = accept(listen_fd, (struct sockaddr *)&peer, &pl);
    if (fd < 0) { if (errno == EINTR || errno == EAGAIN) continue; util_sleep_ms(50); continue; }
    pthread_mutex_lock(&ring_mu);
    while (running && ring_count == CONN_RING) pthread_cond_wait(&ring_cv, &ring_mu);
    if (!running) { pthread_mutex_unlock(&ring_mu); close(fd); break; }
    ring[(ring_head + ring_count) % CONN_RING] = fd;
    ring_count++;
    pthread_cond_broadcast(&ring_cv);
    pthread_mutex_unlock(&ring_mu);
  }
  return NULL;
}

#ifdef XENO_HOST
/* Host test hook: SIGUSR1 forces one listener rebuild so the self-healing
 * path can be exercised without taking the console's network interface down. */
static void on_force_rebind(int sig) { (void)sig; force_rebind = 1; }
#endif

int server_start(int port) {
  signal(SIGPIPE, SIG_IGN);
#ifdef XENO_HOST
  signal(SIGUSR1, on_force_rebind);
#endif
  g_listen_port = port;
  listen_fd = bind_listener(port);
  if (listen_fd < 0) return -1;
  running = 1;
  for (int i = 0; i < HTTP_WORKERS; i++) {
    if (pthread_create(&worker_th[i], NULL, worker_main, NULL) != 0) { LOGE("server: cannot create worker %d", i); return -1; }
  }
  if (pthread_create(&acceptor_th, NULL, acceptor_main, NULL) != 0) { LOGE("server: cannot create acceptor"); return -1; }
  LOGI("server: listening on :%d (%d workers)", port, HTTP_WORKERS);
  return 0;
}

void server_stop(void) {
  if (!running) return;
  pthread_mutex_lock(&ring_mu);
  running = 0;
  pthread_cond_broadcast(&ring_cv);
  pthread_mutex_unlock(&ring_mu);
  pthread_join(acceptor_th, NULL);
  for (int i = 0; i < HTTP_WORKERS; i++) pthread_join(worker_th[i], NULL);
  if (listen_fd >= 0) close(listen_fd);
  listen_fd = -1;
  LOGI("server: stopped");
}
