/*
 * api.c — see api.h. Every handler builds its reply with the JSON writer and
 * answers through api_send()/api_error(); the envelope rules of SPEC §6 are
 * enforced here (ok:true on success, {ok:false,error,message} on failure).
 *
 * Mutating requests (non-GET) require the X-XENO-PIN header when
 * settings.pairing.pin is set (SPEC §15).
 */
#include "api.h"
#include "assets.h"
#include "catalog.h"
#include "config.h"
#include "dl.h"
#include "http_client.h"
#include "install.h"
#include "log.h"
#include "settings.h"
#include "storage.h"
#include "sys.h"
#include "update.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct api_ctx {
  http_req *req;
  jdoc *doc;          /* parsed body (NULL when absent/invalid) */
  jv body;
  char params[3][96]; /* {captures} in route order */
  int nparams;
} api_ctx;

typedef void (*api_handler)(api_ctx *c);

typedef struct api_route {
  const char *method;
  const char *pattern;   /* "/api/queue/{id}/{action}" */
  api_handler fn;
} api_route;

/* ---- envelope helpers --------------------------------------------------- */

static void api_begin(jw *w) {
  jw_init(w);
  jw_obj_begin(w);
  jw_kv_bool(w, "ok", 1);
}

static void api_send(api_ctx *c, jw *w) {
  jw_obj_end(w);
  http_send_json(c->req, 200, w);
}

static void api_error(api_ctx *c, int status, const char *code, const char *msg) {
  http_send_error(c->req, status, code, msg);
}

static int status_for_code(const char *code) {
  if (strcmp(code, "not_found") == 0 || strcmp(code, "bad_release") == 0) return 404;
  if (strcmp(code, "exists") == 0) return 409;
  if (strcmp(code, "no_space") == 0 || strcmp(code, "root_unavailable") == 0) return 422;
  if (strcmp(code, "downloads_unavailable") == 0) return 503;
  return 400;
}

static const char *body_str(api_ctx *c, const char *key, const char *dflt) { return jv_get_str(c->body, key, dflt); }

/* ---- system ------------------------------------------------------------- */

static void storage_summary_json(jw *w) {
  storage_root roots[STORAGE_MAX_ROOTS];
  int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
  jw_arr_begin(w);
  for (int i = 0; i < n; i++) {
    jw_obj_begin(w);
    jw_kv_str(w, "path", roots[i].path);
    jw_kv_str(w, "label", roots[i].label);
    jw_kv_str(w, "kind", roots[i].kind);
    jw_kv_i64(w, "free", roots[i].free);
    jw_kv_i64(w, "total", roots[i].total);
    jw_kv_bool(w, "writable", roots[i].writable);
    jw_kv_bool(w, "default", roots[i].is_default);
    jw_obj_end(w);
  }
  jw_arr_end(w);
}

static void h_status(api_ctx *c) {
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "app", XENO_APP_NAME);
  jw_kv_str(&w, "version", XENO_VERSION);
  jw_kv_str(&w, "build", XENO_BUILD_HASH);
  jw_kv_str(&w, "platform", sys_platform());
  jw_kv_str(&w, "fw", sys_fw_version());
  char ip[48];
  sys_local_ip(ip, sizeof ip);
  jw_kv_str(&w, "ip", ip);
  jw_kv_int(&w, "port", g_cfg.port);
  jw_kv_i64(&w, "uptime", (int64_t)(util_now() - g_cfg.started_at));
  jw_kv_bool(&w, "downloadsAvailable", xhttp_available());
  jw_kv_str(&w, "transport", xhttp_backend_name());
  jw_key(&w, "catalog"); jw_obj_begin(&w); catalog_status_json(&w); jw_obj_end(&w);
  dl_summary s;
  dl_summary_get(&s);
  jw_key(&w, "queue"); jw_obj_begin(&w);
  jw_kv_int(&w, "active", s.active); jw_kv_int(&w, "queued", s.queued); jw_kv_int(&w, "paused", s.paused);
  jw_kv_int(&w, "failed", s.failed); jw_kv_int(&w, "done", s.done); jw_kv_i64(&w, "speed", s.speed);
  jw_kv_i64(&w, "remaining", s.remaining); jw_kv_i64(&w, "eta", s.eta); jw_kv_bool(&w, "keepAwake", s.keepAwake);
  jw_obj_end(&w);
  jw_key(&w, "storage"); storage_summary_json(&w);
  jw_key(&w, "update"); jw_obj_begin(&w); update_status_json(&w); jw_obj_end(&w);
  jw_key(&w, "notices"); jw_arr_begin(&w);
  if (!xhttp_available()) {
    jw_obj_begin(&w); jw_kv_str(&w, "id", "downloads_unavailable");
    jw_kv_str(&w, "text", "Downloads unavailable on this firmware (network libraries did not load). Browsing still works."); jw_obj_end(&w);
  }
  if (XENO_ASSETS_PLACEHOLDER_CATALOG) {
    jw_obj_begin(&w); jw_kv_str(&w, "id", "catalog_placeholder");
    jw_kv_str(&w, "text", "This build has no embedded catalog yet — refresh the catalog from Settings."); jw_obj_end(&w);
  }
  jw_arr_end(&w);
  api_send(c, &w);
}

static void h_log(api_ctx *c) {
  int lines = http_query_int(c->req, "lines", 200);
  if (lines < 1) lines = 1;
  if (lines > 400) lines = 400;
  char (*buf)[LOG_LINE_MAX] = malloc((size_t)lines * LOG_LINE_MAX);
  if (!buf) { api_error(c, 500, "oom", "Out of memory"); return; }
  int n = log_recent(buf, lines);
  jw w;
  api_begin(&w);
  jw_key(&w, "lines"); jw_arr_begin(&w);
  for (int i = 0; i < n; i++) jw_str(&w, buf[i]);
  jw_arr_end(&w);
  free(buf);
  api_send(c, &w);
}

static void h_toast(api_ctx *c) {
  const char *text = body_str(c, "text", "");
  if (!*text) { api_error(c, 400, "bad_request", "text is required"); return; }
  sys_toast("%s", text);
  jw w;
  api_begin(&w);
  api_send(c, &w);
}

static void h_stop(api_ctx *c) {
  dl_save_queue();
  sys_toast("XENO STORE stopping");
  jw w;
  api_begin(&w);
  jw_kv_bool(&w, "stopping", 1);
  api_send(c, &w);
  LOGI("stop requested via API by %s", c->req->client_ip);
  g_cfg.stop_requested = 1;
}

static void h_update_check(api_ctx *c) {
  char err[256];
  int rc = update_check(err, sizeof err);
  jw w;
  api_begin(&w);
  update_status_json(&w);
  if (rc != 0) jw_kv_str(&w, "warning", err);
  api_send(c, &w);
}

static void h_update_apply(api_ctx *c) {
  char path[600], err[256];
  if (update_apply(path, sizeof path, err, sizeof err) != 0) { api_error(c, 502, "update_failed", err); return; }
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "path", path);
  jw_kv_bool(&w, "restartRequired", 1);
  api_send(c, &w);
}

/* ---- catalog ------------------------------------------------------------ */

static void h_catalog_info(api_ctx *c) {
  jw w;
  api_begin(&w);
  catalog_info_json(&w);
  api_send(c, &w);
}

static void h_catalog_refresh(api_ctx *c) {
  char err[256];
  int updated = 0;
  int force = jv_get_bool(c->body, "force", 0) || http_query_int(c->req, "force", 0);
  int rc = catalog_refresh(force, &updated, err, sizeof err);
  if (rc != 0) { api_error(c, 502, "refresh_failed", err); return; }
  jw w;
  api_begin(&w);
  jw_kv_bool(&w, "updated", updated);
  jw_kv_i64(&w, "revision", catalog_revision());
  api_send(c, &w);
}

static void h_catalog_search(api_ctx *c) {
  char q[256], platform[16];
  http_query_get(c->req, "q", q, sizeof q);
  http_query_get(c->req, "platform", platform, sizeof platform);
  int limit = http_query_int(c->req, "limit", 50);
  jw w;
  api_begin(&w);
  catalog_search(q, platform, limit, &w);
  api_send(c, &w);
}

static void h_links_check(api_ctx *c) {
  jv urls = jv_get(c->body, "urls");
  if (jv_type(urls) != JV_ARR) { api_error(c, 400, "bad_request", "urls must be an array"); return; }
  if (!xhttp_available()) { api_error(c, 503, "downloads_unavailable", "Network transport unavailable"); return; }
  jw w;
  api_begin(&w);
  catalog_links_check(urls, &w);
  api_send(c, &w);
}

static void h_links_resolve(api_ctx *c) {
  const char *url = body_str(c, "url", "");
  if (!util_istarts_with(url, "http")) { api_error(c, 400, "bad_request", "url must be http(s)"); return; }
  if (!xhttp_available()) { api_error(c, 503, "downloads_unavailable", "Network transport unavailable"); return; }
  char err[256];
  jw w;
  api_begin(&w);
  int rc = catalog_links_resolve(url, &w, err, sizeof err);
  if (rc != 0) jw_kv_str(&w, "warning", err);
  api_send(c, &w);
}

/* ---- queue -------------------------------------------------------------- */

static void h_queue_get(api_ctx *c) {
  jw w;
  api_begin(&w);
  dl_queue_json(&w, http_query_int(c->req, "history", 0));
  api_send(c, &w);
}

static int body_tristate(api_ctx *c, const char *key) {
  jv v = jv_get(c->body, key);
  if (!jv_ok(v) || jv_type(v) == JV_NULL) return -1;
  return jv_bool(v, 0) ? 1 : 0;
}

static void h_queue_add(api_ctx *c) {
  if (!jv_ok(c->body)) { api_error(c, 400, "bad_request", "JSON body required"); return; }
  dl_add_req r;
  memset(&r, 0, sizeof r);
  r.gameId = body_str(c, "gameId", "");
  r.releaseId = body_str(c, "releaseId", "");
  r.root = body_str(c, "root", "");
  r.url = body_str(c, "url", "");
  r.filename = body_str(c, "filename", "");
  r.format = body_str(c, "format", "");
  r.title = body_str(c, "title", "");
  r.sha256 = body_str(c, "sha256", "");
  r.mirrors = jv_get(c->body, "mirrors");
  r.size = jv_get_i64(c->body, "size", 0);
  r.connections = (int)jv_get_i64(c->body, "connections", 0);
  r.verify = body_tristate(c, "verify");
  r.autoInstall = body_tristate(c, "autoInstall");
  r.overwrite = jv_get_bool(c->body, "overwrite", 0);
  char id[16], code[32], msg[256];
  if (dl_add(&r, id, sizeof id, code, sizeof code, msg, sizeof msg) != 0) { api_error(c, status_for_code(code), code, msg); return; }
  jw w;
  api_begin(&w);
  jw_key(&w, "job");
  dl_job_json(&w, id, 0);
  api_send(c, &w);
}

static void h_queue_action(api_ctx *c) {
  const char *id = c->params[0], *action = c->params[1];
  char code[32], msg[256];
  if (dl_action(id, action, c->body, code, sizeof code, msg, sizeof msg) != 0) { api_error(c, status_for_code(code), code, msg); return; }
  jw w;
  api_begin(&w);
  if (strcmp(action, "remove") != 0) { jw_key(&w, "job"); dl_job_json(&w, id, 0); }
  else jw_kv_str(&w, "removed", id);
  api_send(c, &w);
}

static void h_queue_log(api_ctx *c) {
  jw w;
  api_begin(&w);
  if (dl_job_log_json(&w, c->params[0]) != 0) { jw_free(&w); api_error(c, 404, "not_found", "No such job"); return; }
  api_send(c, &w);
}

static void h_queue_clear(api_ctx *c) {
  int n = dl_clear(jv_get(c->body, "states"));
  jw w;
  api_begin(&w);
  jw_kv_int(&w, "removed", n);
  api_send(c, &w);
}

static void h_space(api_ctx *c) {
  char root[256], bytes_s[32];
  http_query_get(c->req, "root", root, sizeof root);
  http_query_get(c->req, "bytes", bytes_s, sizeof bytes_s);
  int64_t bytes = 0;
  util_parse_i64(bytes_s, &bytes);
  if (bytes < 0) bytes = 0;
  storage_root sr;
  if (!root[0]) {
    storage_root roots[STORAGE_MAX_ROOTS];
    int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
    int found = 0;
    for (int i = 0; i < n; i++) if (roots[i].is_default) { sr = roots[i]; found = 1; break; }
    if (!found && n) { sr = roots[0]; found = 1; }
    if (!found) { api_error(c, 422, "root_unavailable", "No storage root is available"); return; }
  } else if (storage_find_root(root, &sr) != 0) {
    api_error(c, 422, "root_unavailable", "Unknown storage root");
    return;
  }
  int64_t after_queue = sr.free - dl_remaining_on_root(sr.path);
  int64_t after_this = after_queue - bytes;
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "root", sr.path);
  jw_kv_i64(&w, "free", sr.free);
  jw_kv_i64(&w, "afterQueue", after_queue);
  jw_kv_i64(&w, "afterThis", after_this);
  jw_kv_bool(&w, "fits", after_this >= DL_RESERVE_BYTES);
  api_send(c, &w);
}

/* ---- storage & library -------------------------------------------------- */

static void h_storage(api_ctx *c) {
  storage_scan_roots();
  jw w;
  api_begin(&w);
  jw_key(&w, "roots");
  storage_summary_json(&w);
  api_send(c, &w);
}

static void h_storage_default(api_ctx *c) {
  const char *root = body_str(c, "root", "");
  if (storage_find_root(root, NULL) != 0) { api_error(c, 422, "root_unavailable", "Unknown storage root"); return; }
  jw patch;
  jw_init(&patch);
  jw_obj_begin(&patch); jw_key(&patch, "downloads"); jw_obj_begin(&patch); jw_kv_str(&patch, "defaultRoot", root); jw_obj_end(&patch); jw_obj_end(&patch);
  size_t len;
  char *txt = jw_detach(&patch, &len);
  char err[128] = "";
  int rc = -1;
  if (txt) {
    jdoc *d = json_parse(txt, len, 100, 8);
    if (d) { rc = settings_merge(json_root(d), err, sizeof err); json_free(d); }
    free(txt);
  }
  if (rc != 0) { api_error(c, 400, "bad_request", err[0] ? err : "Cannot save default root"); return; }
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "root", root);
  api_send(c, &w);
}

static void h_library(api_ctx *c) {
  if (http_query_int(c->req, "scan", 1)) storage_scan_roots();
  jw w;
  api_begin(&w);
  storage_library_json(&w);
  api_send(c, &w);
}

static void h_library_delete(api_ctx *c) {
  const char *path = body_str(c, "path", "");
  char err[256];
  if (!*path) { api_error(c, 400, "bad_request", "path is required"); return; }
  if (storage_library_delete(path, err, sizeof err) != 0) { api_error(c, 403, "forbidden", err); return; }
  jw w;
  api_begin(&w);
  api_send(c, &w);
}

static void h_library_install(api_ctx *c) {
  const char *path = body_str(c, "path", "");
  if (!*path) { api_error(c, 400, "bad_request", "path is required"); return; }
  if (!storage_library_path_allowed(path)) { api_error(c, 403, "forbidden", "Path is not in the last library scan"); return; }
  char id[16], msg[256];
  if (dl_add_install_job(path, id, sizeof id, msg, sizeof msg) != 0) { api_error(c, 422, "install_failed", msg); return; }
  jw w;
  api_begin(&w);
  jw_key(&w, "job");
  dl_job_json(&w, id, 0);
  api_send(c, &w);
}

static void h_shadowmount_scan(api_ctx *c) {
  char status[160];
  int available = install_shadowmount_scan(status, sizeof status);
  jw w;
  api_begin(&w);
  jw_kv_bool(&w, "available", available);
  jw_kv_str(&w, "status", status);
  api_send(c, &w);
}

/* ---- settings, favorites, collections, recent ---------------------------- */

static void h_settings_get(api_ctx *c) {
  jw w;
  api_begin(&w);
  jw_key(&w, "settings");
  settings_write_json(&w);
  api_send(c, &w);
}

static void h_settings_put(api_ctx *c) {
  char err[160];
  if (!jv_ok(c->body)) { api_error(c, 400, "bad_request", "JSON object required"); return; }
  jv obj = jv_ok(jv_get(c->body, "settings")) ? jv_get(c->body, "settings") : c->body;
  if (settings_merge(obj, err, sizeof err) != 0) { api_error(c, 400, "invalid_settings", err); return; }
  storage_scan_roots();
  h_settings_get(c);
}

static void h_favorites_get(api_ctx *c) {
  jw w;
  api_begin(&w);
  settings_favorites_json(&w);
  api_send(c, &w);
}

static void h_favorites_put(api_ctx *c) {
  if (settings_favorites_set(jv_get(c->body, "ids")) != 0) { api_error(c, 400, "bad_request", "ids must be an array"); return; }
  h_favorites_get(c);
}

static void h_favorites_toggle(api_ctx *c) {
  const char *id = body_str(c, "id", "");
  int st = settings_favorite_toggle(id);
  if (st < 0) { api_error(c, 400, "bad_request", "id is required"); return; }
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "id", id);
  jw_kv_bool(&w, "favorite", st);
  api_send(c, &w);
}

static void h_collections_get(api_ctx *c) {
  jw w;
  api_begin(&w);
  settings_collections_json(&w);
  api_send(c, &w);
}

static void h_collections_put(api_ctx *c) {
  char err[160];
  jv list = jv_ok(jv_get(c->body, "collections")) ? jv_get(c->body, "collections") : c->body;
  if (settings_collections_set(list, err, sizeof err) != 0) { api_error(c, 400, "bad_request", err); return; }
  h_collections_get(c);
}

static void h_recent_get(api_ctx *c) {
  jw w;
  api_begin(&w);
  settings_recent_json(&w);
  api_send(c, &w);
}

static void h_recent_add(api_ctx *c) {
  const char *id = body_str(c, "id", "");
  if (!*id) { api_error(c, 400, "bad_request", "id is required"); return; }
  settings_recent_add(id);
  h_recent_get(c);
}

static void h_export(api_ctx *c) {
  jw w;
  api_begin(&w);
  settings_export_json(&w);
  api_send(c, &w);
}

static void h_import(api_ctx *c) {
  char err[160];
  if (settings_import_json(c->body, err, sizeof err) != 0) { api_error(c, 400, "bad_request", err); return; }
  storage_scan_roots();
  jw w;
  api_begin(&w);
  jw_kv_bool(&w, "imported", 1);
  api_send(c, &w);
}

static void h_pair(api_ctx *c) {
  char ip[48], url[96];
  sys_local_ip(ip, sizeof ip);
  xsnprintf(url, sizeof url, "http://%s:%d/", ip, g_cfg.port);
  settings_t s;
  settings_get(&s);
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "url", url);
  jw_kv_str(&w, "ip", ip);
  jw_kv_int(&w, "port", g_cfg.port);
  jw_kv_bool(&w, "pinRequired", s.pin[0] != 0);
  api_send(c, &w);
}

/* ---- routing ------------------------------------------------------------ */

static const api_route ROUTES[] = {
  { "GET", "/api/status", h_status },
  { "GET", "/api/log", h_log },
  { "POST", "/api/system/toast", h_toast },
  { "POST", "/api/system/stop", h_stop },
  { "GET", "/api/update/check", h_update_check },
  { "POST", "/api/update/check", h_update_check },
  { "POST", "/api/update/apply", h_update_apply },
  { "GET", "/api/catalog/info", h_catalog_info },
  { "POST", "/api/catalog/refresh", h_catalog_refresh },
  { "GET", "/api/catalog/search", h_catalog_search },
  { "POST", "/api/links/check", h_links_check },
  { "POST", "/api/links/resolve", h_links_resolve },
  { "GET", "/api/queue", h_queue_get },
  { "POST", "/api/queue", h_queue_add },
  { "POST", "/api/queue/clear", h_queue_clear },
  { "GET", "/api/queue/{id}/log", h_queue_log },
  { "POST", "/api/queue/{id}/{action}", h_queue_action },
  { "GET", "/api/space", h_space },
  { "GET", "/api/storage", h_storage },
  { "POST", "/api/storage/default", h_storage_default },
  { "GET", "/api/library", h_library },
  { "POST", "/api/library/delete", h_library_delete },
  { "POST", "/api/library/install", h_library_install },
  { "POST", "/api/shadowmount/scan", h_shadowmount_scan },
  { "GET", "/api/settings", h_settings_get },
  { "PUT", "/api/settings", h_settings_put },
  { "GET", "/api/favorites", h_favorites_get },
  { "PUT", "/api/favorites", h_favorites_put },
  { "POST", "/api/favorites/toggle", h_favorites_toggle },
  { "GET", "/api/collections", h_collections_get },
  { "PUT", "/api/collections", h_collections_put },
  { "GET", "/api/recent", h_recent_get },
  { "POST", "/api/recent", h_recent_add },
  { "GET", "/api/export", h_export },
  { "POST", "/api/import", h_import },
  { "GET", "/api/pair", h_pair },
};

/* Matches path against pattern segment by segment; fills captures. */
static int route_match(const char *pattern, const char *path, api_ctx *c) {
  const char *p = pattern, *s = path;
  c->nparams = 0;
  while (*p && *s) {
    if (*p == '{') {
      const char *close = strchr(p, '}');
      if (!close) return 0;
      const char *seg_end = strchr(s, '/');
      size_t n = seg_end ? (size_t)(seg_end - s) : strlen(s);
      if (n == 0 || n >= sizeof c->params[0] || c->nparams >= 3) return 0;
      memcpy(c->params[c->nparams], s, n);
      c->params[c->nparams][n] = 0;
      c->nparams++;
      p = close + 1;
      s += n;
      continue;
    }
    if (*p != *s) return 0;
    p++; s++;
  }
  return *p == 0 && *s == 0;
}

void api_init(void) {}

void api_handle(http_req *req) {
  api_ctx c;
  memset(&c, 0, sizeof c);
  c.req = req;
  c.body.d = NULL;
  c.body.i = 0xFFFFFFFFu;
  int method_seen = 0;
  const api_route *hit = NULL;
  for (size_t i = 0; i < XS_ARRAY_LEN(ROUTES); i++) {
    api_ctx probe = c;
    if (!route_match(ROUTES[i].pattern, req->path, &probe)) continue;
    method_seen = 1;
    if (strcmp(ROUTES[i].method, req->method) == 0 || (strcmp(req->method, "HEAD") == 0 && strcmp(ROUTES[i].method, "GET") == 0)) {
      hit = &ROUTES[i];
      c = probe;
      break;
    }
  }
  if (!hit) {
    if (method_seen) http_send_error(req, 405, "method_not_allowed", "Method not allowed for this route");
    else http_send_error(req, 404, "not_found", "Unknown API route");
    return;
  }
  if (strcmp(req->method, "GET") != 0 && strcmp(req->method, "HEAD") != 0) {
    settings_t s;
    settings_get(&s);
    if (s.pin[0] && strcmp(s.pin, req->pin) != 0) {
      http_send_error(req, 401, "pin_required", "This XENO STORE requires the pairing PIN (X-XENO-PIN header)");
      return;
    }
  }
  if (req->body && req->body_len) {
    c.doc = json_parse(req->body, req->body_len, 100000, 32);
    if (c.doc) c.body = json_root(c.doc);
    else if (strcmp(req->method, "GET") != 0) { http_send_error(req, 400, "bad_json", "Request body is not valid JSON"); return; }
  }
  hit->fn(&c);
  json_free(c.doc);
  if (!req->responded) http_send_error(req, 500, "no_response", "Handler produced no response");
}
