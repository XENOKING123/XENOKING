/*
 * dlx_debrid.c — see dlx_debrid.h.
 *
 * Adapters (SPEC §17.14), one per service, each a thin function over
 * xhttp_fetch():
 *   Real-Debrid  GET  /user, GET /hosts/domains, POST /unrestrict/link (link=)      → download
 *   AllDebrid    GET  /user?agent=&apikey=, GET /hosts?agent=, GET /link/unlock?… → data.link
 *   Premiumize   GET  /account/info?apikey=, GET /services/list, POST /transfer/directdl (src=) → content[0].link
 *   TorBox       GET  /user/me, POST /webdl/createwebdownload (link=), poll /webdl/mylist?id=
 *                until download_finished, GET /webdl/requestdl?token=&web_id=&file_id= → url
 * Keys stay in settings.json and are only ever sent to their own service.
 * Base URLs can be redirected to a loopback mock on the host build through
 * XENO_RD_BASE / XENO_AD_BASE / XENO_TB_BASE / XENO_PM_BASE (tests).
 */
#include "dlx_debrid.h"
#include "http_client.h"
#include "log.h"
#include "settings.h"
#include "util.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_HOSTS 400
#define HOST_LEN 64
#define HOSTS_TTL_S (24 * 3600)
#define RETRY_AFTER_FAIL_S (10 * 60)
#define TICK_EVERY_S 60
#define API_TIMEOUT_MS 15000
#define TORBOX_POLL_MS 3000
#define TORBOX_POLL_MAX_MS 90000
#define RESP_MAX (1u << 20)

enum { RD = 0, AD, TB, PM };

typedef struct svc_def { const char *id, *name, *base, *env; } svc_def;
static const svc_def SVC[DLX_DEBRID_N] = {
  { "realdebrid", "Real-Debrid", "https://api.real-debrid.com/rest/1.0", "XENO_RD_BASE" },
  { "alldebrid", "AllDebrid", "https://api.alldebrid.com/v4", "XENO_AD_BASE" },
  { "torbox", "TorBox", "https://api.torbox.app/v1/api", "XENO_TB_BASE" },
  { "premiumize", "Premiumize", "https://www.premiumize.me/api", "XENO_PM_BASE" },
};

typedef struct svc_cache {
  char user[64], expires[40], lastError[160];
  char (*hosts)[HOST_LEN];
  int nhosts;
  int hostsKnown;         /* a list was fetched at least once */
  time_t fetchedAt;
  time_t lastTry;         /* last refresh attempt (failed ones back off 10 min) */
  volatile int refreshing;
} svc_cache;

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static svc_cache C[DLX_DEBRID_N];
static char g_cache_path[600];
static time_t g_last_tick;

/* ---- helpers ------------------------------------------------------------- */

static int svc_index(const char *id) {
  if (!id) return -1;
  for (int i = 0; i < DLX_DEBRID_N; i++) if (util_strieq(id, SVC[i].id)) return i;
  return -1;
}

const char *dlx_debrid_name(const char *id) { int i = svc_index(id); return i < 0 ? NULL : SVC[i].name; }
int dlx_debrid_known(const char *id) { return svc_index(id) >= 0; }

static void base_url(int si, char *out, size_t cap) {
#ifdef XENO_HOST
  const char *o = getenv(SVC[si].env);
  if (o && util_istarts_with(o, "http")) { xstrlcpy(out, o, cap); size_t l = strlen(out); while (l > 1 && out[l - 1] == '/') out[--l] = 0; return; }
#endif
  xstrlcpy(out, SVC[si].base, cap);
}

static void get_key(int si, char *out, size_t cap) {
  settings_t s;
  settings_get(&s);
  const char *k = si == RD ? s.debrid.realdebrid.apiKey : si == AD ? s.debrid.alldebrid.apiKey : si == TB ? s.debrid.torbox.apiKey : s.debrid.premiumize.apiKey;
  xstrlcpy(out, k, cap);
}

int dlx_debrid_connected(const char *id) {
  int si = svc_index(id);
  if (si < 0) return 0;
  char k[SET_DEBRID_KEY_LEN];
  get_key(si, k, sizeof k);
  return k[0] != 0;
}

/* application/x-www-form-urlencoded value */
static void form_encode(const char *in, char *out, size_t cap) {
  static const char hex[] = "0123456789ABCDEF";
  size_t o = 0;
  for (const unsigned char *p = (const unsigned char *)in; *p && o + 4 < cap; p++) {
    unsigned char c = *p;
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') out[o++] = (char)c;
    else { out[o++] = '%'; out[o++] = hex[c >> 4]; out[o++] = hex[c & 15]; }
  }
  out[o] = 0;
}

/* One API call. Returns the malloc'd body (or NULL on transport error) and
 * the HTTP status. `auth` = Bearer key or NULL. */
static char *call(int si, const char *method, const char *path, const char *auth, const char *form, int *status, size_t *len, volatile int *cancel) {
  char base[512], url[2048], headers[512] = "";
  base_url(si, base, sizeof base);
  xsnprintf(url, sizeof url, "%s%s", base, path);
  if (auth && *auth) xsnprintf(headers, sizeof headers, "Authorization: Bearer %s\r\n", auth);
  if (form) xstrlcat(headers, "Content-Type: application/x-www-form-urlencoded\r\n", sizeof headers);
  xstrlcat(headers, "Accept: application/json\r\n", sizeof headers);
  xhttp_req r;
  memset(&r, 0, sizeof r);
  r.method = method;
  r.url = url;
  r.range_start = r.range_end = -1;
  r.follow_redirects = 3;
  r.connect_timeout_ms = API_TIMEOUT_MS;
  r.recv_timeout_ms = API_TIMEOUT_MS;
  r.extra_headers = headers;
  r.body = form;
  r.body_len = form ? strlen(form) : 0;
  r.cancel_flag = cancel;
  xhttp_resp resp;
  size_t l = 0;
  char *body = xhttp_fetch(&r, &resp, RESP_MAX, &l);
  *status = body ? resp.status : 0;
  if (len) *len = l;
  return body;
}

static jdoc *parse(const char *txt, size_t len) { return txt ? json_parse(txt, len, 20000, 16) : NULL; }

static void set_err(dlx_debrid_result *o, const char *code, const char *fmt, const char *a, const char *b) {
  xstrlcpy(o->errorCode, code, sizeof o->errorCode);
  xsnprintf(o->error, sizeof o->error, fmt, a ? a : "", b ? b : "");
}

/* Maps a service's error text/code to plain words. */
static void map_error(int si, dlx_debrid_result *o, const char *code, const char *message) {
  const char *name = SVC[si].name;
  char lc[200], lm[300];
  xstrlcpy(lc, code ? code : "", sizeof lc);
  xstrlcpy(lm, message ? message : "", sizeof lm);
  util_lower(lc);
  util_lower(lm);
  if (strstr(lc, "unsupported") || strstr(lc, "not_supported") || strstr(lc, "hoster_not") || strstr(lc, "host_not") ||
      strstr(lm, "not supported") || strstr(lm, "unsupported")) {
    set_err(o, "unsupported_host", "%s says this host is not supported", name, NULL);
  } else if (strstr(lc, "auth") || strstr(lc, "token") || strstr(lc, "apikey") || strstr(lc, "bad_login") || strstr(lm, "invalid api") || strstr(lm, "unauthorized")) {
    set_err(o, "bad_key", "%s rejected the API key — check it in Settings → Debrid", name, NULL);
  } else if (strstr(lc, "too_large") || strstr(lc, "limit") || strstr(lc, "quota") || strstr(lc, "traffic") || strstr(lm, "limit") || strstr(lm, "quota") || strstr(lm, "traffic")) {
    if (message && *message) set_err(o, "limit", "%s: %s — pick a smaller format or download directly", name, message);
    else set_err(o, "limit", "%s says your plan's limit is reached — pick a smaller format or download directly", name, NULL);
  } else if (strstr(lc, "premium") || strstr(lm, "premium")) {
    set_err(o, "limit", "%s needs an active premium plan for this host", name, NULL);
  } else if (strstr(lc, "unavailable") || strstr(lm, "unavailable") || strstr(lm, "not found") || strstr(lm, "dead")) {
    set_err(o, "service_error", "%s says the file is unavailable on the host", name, NULL);
  } else if (message && *message) {
    set_err(o, "service_error", "%s: %s", name, message);
  } else if (code && *code) {
    set_err(o, "service_error", "%s returned %s", name, code);
  } else {
    set_err(o, "service_error", "%s did not accept the link", name, NULL);
  }
}

static void transport_err(int si, dlx_debrid_result *o) {
  set_err(o, "network", "Could not reach %s (%s)", SVC[si].name, xhttp_last_error());
}

/* ---- cache file ----------------------------------------------------------- */

static void cache_save_locked(void) {
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_key(&w, "services"); jw_obj_begin(&w);
  for (int i = 0; i < DLX_DEBRID_N; i++) {
    jw_key(&w, SVC[i].id); jw_obj_begin(&w);
    jw_kv_str(&w, "user", C[i].user);
    jw_kv_str(&w, "expires", C[i].expires);
    jw_kv_i64(&w, "fetchedAt", (int64_t)C[i].fetchedAt);
    jw_kv_bool(&w, "hostsKnown", C[i].hostsKnown);
    jw_key(&w, "hosts"); jw_arr_begin(&w);
    for (int k = 0; k < C[i].nhosts; k++) jw_str(&w, C[i].hosts[k]);
    jw_arr_end(&w);
    jw_obj_end(&w);
  }
  jw_obj_end(&w);
  jw_obj_end(&w);
  size_t len;
  char *txt = jw_detach(&w, &len);
  if (txt) { util_write_file_atomic(g_cache_path, txt, len); free(txt); }
}

static void cache_load_locked(void) {
  size_t len;
  char *txt = util_read_file(g_cache_path, &len, 2u << 20);
  if (!txt) return;
  jdoc *d = json_parse(txt, len, 20000, 8);
  free(txt);
  if (!d) return;
  jv svcs = jv_get(json_root(d), "services");
  for (int i = 0; i < DLX_DEBRID_N; i++) {
    jv o = jv_get(svcs, SVC[i].id);
    if (!jv_ok(o)) continue;
    xstrlcpy(C[i].user, jv_get_str(o, "user", ""), sizeof C[i].user);
    xstrlcpy(C[i].expires, jv_get_str(o, "expires", ""), sizeof C[i].expires);
    C[i].fetchedAt = (time_t)jv_get_i64(o, "fetchedAt", 0);
    C[i].hostsKnown = jv_get_bool(o, "hostsKnown", 0);
    C[i].nhosts = 0;
    JV_FOREACH(h, jv_get(o, "hosts")) {
      const char *s = jv_str(h, NULL);
      if (s && *s && C[i].nhosts < MAX_HOSTS) xstrlcpy(C[i].hosts[C[i].nhosts++], s, HOST_LEN);
    }
  }
  json_free(d);
}

void dlx_debrid_init(const char *data_dir) {
  pthread_mutex_lock(&mu);
  xsnprintf(g_cache_path, sizeof g_cache_path, "%s/debrid-hosts.json", data_dir);
  for (int i = 0; i < DLX_DEBRID_N; i++) {
    memset(&C[i], 0, sizeof C[i]);
    C[i].hosts = calloc(MAX_HOSTS, HOST_LEN);
  }
  cache_load_locked();
  pthread_mutex_unlock(&mu);
}

/* ---- per-service: user --------------------------------------------------- */

static void unix_to_iso(int64_t t, char *out, size_t cap) {
  if (t > 0) util_iso8601((time_t)t, out, cap);
  else if (cap) out[0] = 0;
}

/* Validates the key; fills user/expires. 0 ok, -1 with o->error. */
static int check_user(int si, const char *key, char *user, size_t ucap, char *expires, size_t ecap, dlx_debrid_result *o) {
  int status = 0;
  size_t len = 0;
  char path[512];
  char *body = NULL;
  user[0] = expires[0] = 0;
  switch (si) {
    case RD: body = call(si, "GET", "/user", key, NULL, &status, &len, NULL); break;
    case AD: { char ek[400]; form_encode(key, ek, sizeof ek); xsnprintf(path, sizeof path, "/user?agent=xeno-store&apikey=%s", ek); body = call(si, "GET", path, NULL, NULL, &status, &len, NULL); break; }
    case TB: body = call(si, "GET", "/user/me?settings=false", key, NULL, &status, &len, NULL); break;
    default: { char ek[400]; form_encode(key, ek, sizeof ek); xsnprintf(path, sizeof path, "/account/info?apikey=%s", ek); body = call(si, "GET", path, NULL, NULL, &status, &len, NULL); break; }
  }
  if (!body) { transport_err(si, o); return -1; }
  jdoc *d = parse(body, len);
  free(body);
  if (!d) { set_err(o, "service_error", "%s sent an unreadable answer", SVC[si].name, NULL); return -1; }
  jv r = json_root(d);
  int rc = -1;
  if (si == RD) {
    if (status == 200 && jv_get_str(r, "username", "")[0]) {
      xstrlcpy(user, jv_get_str(r, "username", ""), ucap);
      xstrlcpy(expires, jv_get_str(r, "expiration", ""), ecap);
      rc = 0;
    } else map_error(si, o, status == 401 || status == 403 ? "bad_token" : jv_get_str(r, "error", ""), jv_get_str(r, "error", status == 401 ? "bad token" : ""));
  } else if (si == AD) {
    if (strcmp(jv_get_str(r, "status", ""), "success") == 0) {
      jv u = jv_get(jv_get(r, "data"), "user");
      xstrlcpy(user, jv_get_str(u, "username", ""), ucap);
      unix_to_iso(jv_get_i64(u, "premiumUntil", 0), expires, ecap);
      rc = 0;
    } else { jv e = jv_get(r, "error"); map_error(si, o, jv_get_str(e, "code", "AUTH"), jv_get_str(e, "message", "")); }
  } else if (si == TB) {
    if (jv_get_bool(r, "success", 0)) {
      jv dta = jv_get(r, "data");
      const char *email = jv_get_str(dta, "email", "");
      xstrlcpy(user, email[0] ? email : jv_get_str(dta, "customer", "TorBox user"), ucap);
      xstrlcpy(expires, jv_get_str(dta, "premium_expires_at", ""), ecap);
      rc = 0;
    } else map_error(si, o, jv_get_str(r, "error", status == 401 || status == 403 ? "AUTH" : ""), jv_get_str(r, "detail", ""));
  } else {
    if (strcmp(jv_get_str(r, "status", ""), "success") == 0) {
      const char *cid = jv_get_str(r, "customer_id", "");
      if (jv_type(jv_get(r, "customer_id")) == JV_NUM) xsnprintf(user, ucap, "%lld", (long long)jv_get_i64(r, "customer_id", 0));
      else xstrlcpy(user, cid[0] ? cid : "Premiumize user", ucap);
      unix_to_iso(jv_get_i64(r, "premium_until", 0), expires, ecap);
      rc = 0;
    } else map_error(si, o, "AUTH", jv_get_str(r, "message", "invalid API key"));
  }
  json_free(d);
  return rc;
}

/* ---- per-service: hosts -------------------------------------------------- */

static void add_host(char (*hosts)[HOST_LEN], int *n, const char *h) {
  if (!h || !*h || *n >= MAX_HOSTS) return;
  char v[HOST_LEN];
  xstrlcpy(v, h, sizeof v);
  util_lower(v);
  util_trim(v);
  if (util_starts_with(v, "www.")) memmove(v, v + 4, strlen(v + 4) + 1);
  if (!v[0]) return;
  for (int i = 0; i < *n; i++) if (strcmp(hosts[i], v) == 0) return;
  xstrlcpy(hosts[(*n)++], v, HOST_LEN);
}

/* Fetches the supported-host list into hosts/n. 1 fetched, 0 no list for
 * this service, -1 transport/parse error. */
static int fetch_hosts(int si, const char *key, char (*hosts)[HOST_LEN], int *n) {
  *n = 0;
  int status = 0;
  size_t len = 0;
  char *body = NULL, path[512];
  switch (si) {
    case RD: body = call(si, "GET", "/hosts/domains", key, NULL, &status, &len, NULL); break;
    case AD: body = call(si, "GET", "/hosts?agent=xeno-store", NULL, NULL, &status, &len, NULL); break;
    case PM: { char ek[400]; form_encode(key, ek, sizeof ek); xsnprintf(path, sizeof path, "/services/list?apikey=%s", ek); body = call(si, "GET", path, NULL, NULL, &status, &len, NULL); break; }
    default: return 0;   /* TorBox publishes no host list: it is tried and tells us */
  }
  if (!body || status != 200) { free(body); return -1; }
  jdoc *d = parse(body, len);
  free(body);
  if (!d) return -1;
  jv r = json_root(d);
  if (si == RD) {
    JV_FOREACH(h, r) add_host(hosts, n, jv_str(h, NULL));
  } else if (si == AD) {
    jv hs = jv_get(jv_get(r, "data"), "hosts");
    JV_FOREACH(h, hs) {
      if (!jv_get_bool(h, "status", 1)) continue;
      JV_FOREACH(dmn, jv_get(h, "domains")) add_host(hosts, n, jv_str(dmn, NULL));
      add_host(hosts, n, jv_get_str(h, "name", ""));
    }
  } else {
    JV_FOREACH(h, jv_get(r, "directdl")) add_host(hosts, n, jv_str(h, NULL));
  }
  json_free(d);
  return 1;
}

static void refresh_service(int si, const char *key, int with_hosts) {
  char user[64], expires[40];
  dlx_debrid_result o;
  memset(&o, 0, sizeof o);
  int urc = check_user(si, key, user, sizeof user, expires, sizeof expires, &o);
  char (*hosts)[HOST_LEN] = calloc(MAX_HOSTS, HOST_LEN);
  int n = 0, hrc = 0;
  if (hosts && with_hosts && urc == 0) hrc = fetch_hosts(si, key, hosts, &n);
  pthread_mutex_lock(&mu);
  if (urc == 0) { xstrlcpy(C[si].user, user, sizeof C[si].user); xstrlcpy(C[si].expires, expires, sizeof C[si].expires); C[si].lastError[0] = 0; }
  else xstrlcpy(C[si].lastError, o.error, sizeof C[si].lastError);
  if (hosts && hrc == 1) { memcpy(C[si].hosts, hosts, (size_t)MAX_HOSTS * HOST_LEN); C[si].nhosts = n; C[si].hostsKnown = 1; }
  if (urc == 0) C[si].fetchedAt = util_now();
  C[si].refreshing = 0;
  cache_save_locked();
  pthread_mutex_unlock(&mu);
  free(hosts);
  if (urc == 0) LOGI("debrid: %s ok (%s, %d host%s)", SVC[si].name, user, n, n == 1 ? "" : "s");
  else LOGW("debrid: %s check failed: %s", SVC[si].name, o.error);
}

typedef struct refresh_arg { int si; char key[SET_DEBRID_KEY_LEN]; } refresh_arg;

static void *refresh_thread(void *arg) {
  refresh_arg *ra = arg;
  refresh_service(ra->si, ra->key, 1);
  free(ra);
  return NULL;
}

void dlx_debrid_tick(void) {
  time_t now = util_now();
  if (now - g_last_tick < TICK_EVERY_S) return;
  g_last_tick = now;
  if (!xhttp_available()) return;
  for (int i = 0; i < DLX_DEBRID_N; i++) {
    char key[SET_DEBRID_KEY_LEN];
    get_key(i, key, sizeof key);
    if (!key[0]) continue;
    pthread_mutex_lock(&mu);
    int stale = !C[i].refreshing && (now - C[i].fetchedAt >= HOSTS_TTL_S) && (now - C[i].lastTry >= RETRY_AFTER_FAIL_S);
    if (stale) { C[i].refreshing = 1; C[i].lastTry = now; }
    pthread_mutex_unlock(&mu);
    if (!stale) continue;
    refresh_arg *ra = calloc(1, sizeof *ra);
    if (!ra) { pthread_mutex_lock(&mu); C[i].refreshing = 0; pthread_mutex_unlock(&mu); continue; }
    ra->si = i;
    xstrlcpy(ra->key, key, sizeof ra->key);
    pthread_t th;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (pthread_create(&th, &attr, refresh_thread, ra) != 0) { free(ra); pthread_mutex_lock(&mu); C[i].refreshing = 0; pthread_mutex_unlock(&mu); }
    pthread_attr_destroy(&attr);
  }
}

/* ---- public: services / connect / disconnect --------------------------- */

void dlx_debrid_services_json(jw *w) {
  jw_arr_begin(w);
  for (int i = 0; i < DLX_DEBRID_N; i++) {
    char key[SET_DEBRID_KEY_LEN];
    get_key(i, key, sizeof key);
    pthread_mutex_lock(&mu);
    jw_obj_begin(w);
    jw_kv_str(w, "id", SVC[i].id);
    jw_kv_str(w, "name", SVC[i].name);
    jw_kv_bool(w, "connected", key[0] != 0);
    jw_kv_str(w, "user", key[0] ? C[i].user : "");
    jw_kv_str(w, "expires", key[0] ? C[i].expires : "");
    jw_kv_bool(w, "hostsKnown", C[i].hostsKnown);
    jw_kv_i64(w, "hostsUpdatedAt", (int64_t)C[i].fetchedAt);
    jw_kv_str(w, "error", key[0] ? C[i].lastError : "");
    jw_key(w, "hosts"); jw_arr_begin(w);
    for (int k = 0; k < C[i].nhosts; k++) jw_str(w, C[i].hosts[k]);
    jw_arr_end(w);
    jw_obj_end(w);
    pthread_mutex_unlock(&mu);
  }
  jw_arr_end(w);
}

static int store_key(int si, const char *key, char *err, size_t errcap) {
  jw p;
  jw_init(&p);
  jw_obj_begin(&p);
  jw_key(&p, "debrid"); jw_obj_begin(&p);
  jw_key(&p, SVC[si].id); jw_obj_begin(&p); jw_kv_str(&p, "apiKey", key); jw_obj_end(&p);
  jw_obj_end(&p);
  jw_obj_end(&p);
  size_t len;
  char *txt = jw_detach(&p, &len);
  if (!txt) { xsnprintf(err, errcap, "Out of memory"); return -1; }
  jdoc *d = json_parse(txt, len, 100, 8);
  free(txt);
  if (!d) { xsnprintf(err, errcap, "Cannot build the settings patch"); return -1; }
  int rc = settings_merge(json_root(d), err, errcap);
  json_free(d);
  return rc;
}

int dlx_debrid_connect(const char *id, const char *apiKey, char *code, size_t ccap, char *err, size_t errcap) {
  int si = svc_index(id);
  if (si < 0) { xstrlcpy(code, "bad_service", ccap); xsnprintf(err, errcap, "Unknown debrid service '%s' (realdebrid, alldebrid, torbox or premiumize)", id ? id : ""); return -1; }
  char key[SET_DEBRID_KEY_LEN];
  xstrlcpy(key, apiKey ? apiKey : "", sizeof key);
  util_trim(key);
  for (unsigned char *p = (unsigned char *)key; *p; p++) if (*p < 0x21 || *p > 0x7e) { xstrlcpy(code, "bad_request", ccap); xsnprintf(err, errcap, "The API key contains characters that are not allowed"); return -1; }
  if (!key[0]) { xstrlcpy(code, "bad_request", ccap); xsnprintf(err, errcap, "apiKey is required"); return -1; }
  if (!xhttp_available()) { xstrlcpy(code, "downloads_unavailable", ccap); xsnprintf(err, errcap, "Network transport unavailable"); return -1; }
  char user[64], expires[40];
  dlx_debrid_result o;
  memset(&o, 0, sizeof o);
  if (check_user(si, key, user, sizeof user, expires, sizeof expires, &o) != 0) {
    xstrlcpy(code, o.errorCode[0] ? o.errorCode : "service_error", ccap);
    xstrlcpy(err, o.error, errcap);
    return -1;
  }
  if (store_key(si, key, err, errcap) != 0) { xstrlcpy(code, "invalid_settings", ccap); return -1; }
  pthread_mutex_lock(&mu);
  xstrlcpy(C[si].user, user, sizeof C[si].user);
  xstrlcpy(C[si].expires, expires, sizeof C[si].expires);
  C[si].lastError[0] = 0;
  C[si].fetchedAt = util_now();
  pthread_mutex_unlock(&mu);
  /* host list: synchronous (bounded by the API timeout) so the answer is complete */
  char (*hosts)[HOST_LEN] = calloc(MAX_HOSTS, HOST_LEN);
  if (hosts) {
    int n = 0;
    int hrc = fetch_hosts(si, key, hosts, &n);
    pthread_mutex_lock(&mu);
    if (hrc == 1) { memcpy(C[si].hosts, hosts, (size_t)MAX_HOSTS * HOST_LEN); C[si].nhosts = n; C[si].hostsKnown = 1; }
    cache_save_locked();
    pthread_mutex_unlock(&mu);
    free(hosts);
  }
  LOGI("debrid: %s connected as %s", SVC[si].name, user);
  return 0;
}

int dlx_debrid_disconnect(const char *id, char *err, size_t errcap) {
  int si = svc_index(id);
  if (si < 0) { xsnprintf(err, errcap, "Unknown debrid service"); return -1; }
  if (store_key(si, "", err, errcap) != 0) return -1;
  pthread_mutex_lock(&mu);
  C[si].user[0] = C[si].expires[0] = C[si].lastError[0] = 0;
  C[si].fetchedAt = 0;
  cache_save_locked();
  pthread_mutex_unlock(&mu);
  LOGI("debrid: %s disconnected", SVC[si].name);
  return 0;
}

/* ---- host support / pick -------------------------------------------------- */

int dlx_debrid_host_supported(const char *service, const char *host) {
  int si = svc_index(service);
  if (si < 0 || !host || !*host) return 0;
  char h[256];
  xstrlcpy(h, host, sizeof h);
  util_lower(h);
  if (util_starts_with(h, "www.")) memmove(h, h + 4, strlen(h + 4) + 1);
  pthread_mutex_lock(&mu);
  int rc = -1;
  if (C[si].hostsKnown) {
    rc = 0;
    for (int k = 0; k < C[si].nhosts; k++) if (util_host_matches(h, C[si].hosts[k])) { rc = 1; break; }
  }
  pthread_mutex_unlock(&mu);
  return rc;
}

int dlx_debrid_pick(const char *via, const char *url, char *out, size_t cap, char *err, size_t errcap) {
  out[0] = 0;
  if (!via || !*via || util_strieq(via, "direct")) return 0;
  char host[256];
  util_url_host(url, host, sizeof host);
  if (!util_strieq(via, "auto")) {
    int si = svc_index(via);
    if (si < 0) { xsnprintf(err, errcap, "Unknown download service '%s'", via); return -1; }
    if (!dlx_debrid_connected(SVC[si].id)) { xsnprintf(err, errcap, "%s is not connected — add your API key in Settings → Debrid", SVC[si].name); return -1; }
    xstrlcpy(out, SVC[si].id, cap);
    return 0;
  }
  /* auto: a connected service that lists the host, else one whose list is
   * unknown (TorBox, or a list not fetched yet), else direct. */
  int unknown = -1;
  for (int i = 0; i < DLX_DEBRID_N; i++) {
    if (!dlx_debrid_connected(SVC[i].id)) continue;
    int s = dlx_debrid_host_supported(SVC[i].id, host);
    if (s == 1) { xstrlcpy(out, SVC[i].id, cap); return 0; }
    if (s < 0 && unknown < 0) unknown = i;
  }
  if (unknown >= 0) xstrlcpy(out, SVC[unknown].id, cap);
  return 0;
}

/* ---- resolve -------------------------------------------------------------- */

static int rd_resolve(const char *key, const char *url, dlx_debrid_result *o, volatile int *cancel) {
  char eu[4200], form[4300];
  form_encode(url, eu, sizeof eu);
  xsnprintf(form, sizeof form, "link=%s", eu);
  int status = 0;
  size_t len = 0;
  char *body = call(RD, "POST", "/unrestrict/link", key, form, &status, &len, cancel);
  if (!body) { transport_err(RD, o); return -1; }
  jdoc *d = parse(body, len);
  free(body);
  if (!d) { set_err(o, "service_error", "%s sent an unreadable answer", SVC[RD].name, NULL); return -1; }
  jv r = json_root(d);
  int rc = -1;
  const char *dl = jv_get_str(r, "download", "");
  if (status == 200 && util_istarts_with(dl, "http")) {
    xstrlcpy(o->url, dl, sizeof o->url);
    xstrlcpy(o->filename, jv_get_str(r, "filename", ""), sizeof o->filename);
    o->size = (long long)jv_get_i64(r, "filesize", -1);
    rc = 0;
  } else {
    char code[64];
    xsnprintf(code, sizeof code, "%s", jv_get_str(r, "error", status == 401 ? "bad_token" : status == 403 ? "permission_denied" : ""));
    int ec = (int)jv_get_i64(r, "error_code", 0);
    if (ec == 16 || ec == 17) xstrlcpy(code, "hoster_unsupported", sizeof code);
    else if (ec == 8 || ec == 9 || ec == 10) xstrlcpy(code, "bad_token", sizeof code);
    else if (ec == 36 || ec == 35) xstrlcpy(code, "traffic_limit", sizeof code);
    map_error(RD, o, code, jv_get_str(r, "error", ""));
  }
  json_free(d);
  return rc;
}

static int ad_resolve(const char *key, const char *url, dlx_debrid_result *o, volatile int *cancel) {
  char eu[4200], ek[400], path[4700];
  form_encode(url, eu, sizeof eu);
  form_encode(key, ek, sizeof ek);
  xsnprintf(path, sizeof path, "/link/unlock?agent=xeno-store&apikey=%s&link=%s", ek, eu);
  int status = 0;
  size_t len = 0;
  char *body = call(AD, "GET", path, NULL, NULL, &status, &len, cancel);
  if (!body) { transport_err(AD, o); return -1; }
  jdoc *d = parse(body, len);
  free(body);
  if (!d) { set_err(o, "service_error", "%s sent an unreadable answer", SVC[AD].name, NULL); return -1; }
  jv r = json_root(d);
  int rc = -1;
  if (strcmp(jv_get_str(r, "status", ""), "success") == 0) {
    jv dta = jv_get(r, "data");
    const char *link = jv_get_str(dta, "link", "");
    if (util_istarts_with(link, "http")) {
      xstrlcpy(o->url, link, sizeof o->url);
      xstrlcpy(o->filename, jv_get_str(dta, "filename", ""), sizeof o->filename);
      o->size = (long long)jv_get_i64(dta, "filesize", -1);
      rc = 0;
    } else set_err(o, "service_error", "%s answered without a download link", SVC[AD].name, NULL);
  } else {
    jv e = jv_get(r, "error");
    map_error(AD, o, jv_get_str(e, "code", ""), jv_get_str(e, "message", ""));
  }
  json_free(d);
  return rc;
}

static int pm_resolve(const char *key, const char *url, dlx_debrid_result *o, volatile int *cancel) {
  char eu[4200], ek[400], path[520], form[4300];
  form_encode(url, eu, sizeof eu);
  form_encode(key, ek, sizeof ek);
  xsnprintf(path, sizeof path, "/transfer/directdl?apikey=%s", ek);
  xsnprintf(form, sizeof form, "src=%s", eu);
  int status = 0;
  size_t len = 0;
  char *body = call(PM, "POST", path, NULL, form, &status, &len, cancel);
  if (!body) { transport_err(PM, o); return -1; }
  jdoc *d = parse(body, len);
  free(body);
  if (!d) { set_err(o, "service_error", "%s sent an unreadable answer", SVC[PM].name, NULL); return -1; }
  jv r = json_root(d);
  int rc = -1;
  if (strcmp(jv_get_str(r, "status", ""), "success") == 0) {
    jv first = jv_at(jv_get(r, "content"), 0);
    const char *link = jv_get_str(first, "link", "");
    if (util_istarts_with(link, "http")) {
      xstrlcpy(o->url, link, sizeof o->url);
      const char *p = jv_get_str(first, "path", "");
      const char *base = strrchr(p, '/');
      xstrlcpy(o->filename, base ? base + 1 : p, sizeof o->filename);
      o->size = (long long)jv_get_i64(first, "size", -1);
      rc = 0;
    } else set_err(o, "service_error", "%s answered without a download link", SVC[PM].name, NULL);
  } else map_error(PM, o, "", jv_get_str(r, "message", ""));
  json_free(d);
  return rc;
}

static int tb_resolve(const char *key, const char *url, dlx_debrid_result *o, volatile int *cancel) {
  char eu[4200], form[4300];
  form_encode(url, eu, sizeof eu);
  xsnprintf(form, sizeof form, "link=%s", eu);
  int status = 0;
  size_t len = 0;
  char *body = call(TB, "POST", "/webdl/createwebdownload", key, form, &status, &len, cancel);
  if (!body) { transport_err(TB, o); return -1; }
  jdoc *d = parse(body, len);
  free(body);
  if (!d) { set_err(o, "service_error", "%s sent an unreadable answer", SVC[TB].name, NULL); return -1; }
  jv r = json_root(d);
  if (!jv_get_bool(r, "success", 0)) {
    map_error(TB, o, jv_get_str(r, "error", status == 401 || status == 403 ? "AUTH" : ""), jv_get_str(r, "detail", ""));
    json_free(d);
    return -1;
  }
  jv dta = jv_get(r, "data");
  long long web_id = (long long)jv_get_i64(dta, "webdownload_id", jv_get_i64(dta, "id", -1));
  json_free(d);
  if (web_id < 0) { set_err(o, "service_error", "%s did not return a download id", SVC[TB].name, NULL); return -1; }
  /* poll until the file is cached on TorBox */
  int64_t t0 = util_now_ms();
  long long file_id = -1;
  int finished = 0;
  for (;;) {
    if (cancel && *cancel) { set_err(o, "cancelled", "Cancelled", NULL, NULL); return -1; }
    char path[128];
    xsnprintf(path, sizeof path, "/webdl/mylist?id=%lld", web_id);
    body = call(TB, "GET", path, key, NULL, &status, &len, cancel);
    if (!body) { transport_err(TB, o); return -1; }
    d = parse(body, len);
    free(body);
    if (!d) { set_err(o, "service_error", "%s sent an unreadable answer", SVC[TB].name, NULL); return -1; }
    r = json_root(d);
    jv item = jv_get(r, "data");
    if (jv_type(item) == JV_ARR) item = jv_at(item, 0);
    const char *state = jv_get_str(item, "download_state", "");
    int done = jv_get_bool(item, "download_finished", 0) || strcmp(state, "completed") == 0 || strcmp(state, "cached") == 0;
    int failed = !jv_get_bool(r, "success", 1) || strstr(state, "fail") || strstr(state, "error");
    if (done) {
      jv f0 = jv_at(jv_get(item, "files"), 0);
      file_id = (long long)jv_get_i64(f0, "id", 0);
      xstrlcpy(o->filename, jv_get_str(f0, "name", jv_get_str(item, "name", "")), sizeof o->filename);
      o->size = (long long)jv_get_i64(f0, "size", jv_get_i64(item, "size", -1));
      finished = 1;
    }
    if (failed) { map_error(TB, o, jv_get_str(r, "error", state), jv_get_str(r, "detail", "the download failed on TorBox")); json_free(d); return -1; }
    json_free(d);
    if (finished) break;
    if (util_now_ms() - t0 > TORBOX_POLL_MAX_MS) { set_err(o, "service_error", "%s is still fetching this file — try again in a minute", SVC[TB].name, NULL); return -1; }
    util_sleep_ms(TORBOX_POLL_MS);
  }
  char ek[400], path[640];
  form_encode(key, ek, sizeof ek);
  xsnprintf(path, sizeof path, "/webdl/requestdl?token=%s&web_id=%lld&file_id=%lld", ek, web_id, file_id);
  body = call(TB, "GET", path, key, NULL, &status, &len, cancel);
  if (!body) { transport_err(TB, o); return -1; }
  d = parse(body, len);
  free(body);
  if (!d) { set_err(o, "service_error", "%s sent an unreadable answer", SVC[TB].name, NULL); return -1; }
  r = json_root(d);
  int rc = -1;
  const char *link = jv_type(jv_get(r, "data")) == JV_STR ? jv_get_str(r, "data", "") : jv_get_str(jv_get(r, "data"), "url", "");
  if (jv_get_bool(r, "success", 0) && util_istarts_with(link, "http")) { xstrlcpy(o->url, link, sizeof o->url); rc = 0; }
  else map_error(TB, o, jv_get_str(r, "error", ""), jv_get_str(r, "detail", ""));
  json_free(d);
  return rc;
}

int dlx_debrid_resolve(const char *service, const char *url, volatile int *cancel, dlx_debrid_result *out) {
  memset(out, 0, sizeof *out);
  out->size = -1;
  int si = svc_index(service);
  if (si < 0) { set_err(out, "bad_service", "Unknown download service '%s'", service, NULL); return -1; }
  xstrlcpy(out->service, SVC[si].id, sizeof out->service);
  xstrlcpy(out->label, SVC[si].name, sizeof out->label);
  char key[SET_DEBRID_KEY_LEN];
  get_key(si, key, sizeof key);
  if (!key[0]) { set_err(out, "not_connected", "%s is not connected — add your API key in Settings → Debrid", SVC[si].name, NULL); return -1; }
  if (!xhttp_available()) { set_err(out, "network", "Network transport unavailable", NULL, NULL); return -1; }
  int rc;
  switch (si) {
    case RD: rc = rd_resolve(key, url, out, cancel); break;
    case AD: rc = ad_resolve(key, url, out, cancel); break;
    case TB: rc = tb_resolve(key, url, out, cancel); break;
    default: rc = pm_resolve(key, url, out, cancel); break;
  }
  if (rc == 0) {
    xurl u;
    if (util_url_parse(out->url, &u) != 0 || u.has_userinfo) { set_err(out, "service_error", "%s returned a link XENO STORE cannot use", SVC[si].name, NULL); return -1; }
    if (strcmp(out->errorCode, "unsupported_host") != 0) {
      pthread_mutex_lock(&mu);
      C[si].lastError[0] = 0;
      pthread_mutex_unlock(&mu);
    }
  }
  return rc;
}
