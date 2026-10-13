/*
 * ext_downloads.c — download-engine extension routes (SPEC §17.5, §17.13,
 * §17.14, §17.16) registered through the api.h hooks:
 *   GET  /api/stats · POST /api/stats/reset          lifetime statistics (stats.json)
 *   GET  /api/game/best?id=&fw=                      auto best version with reasons
 *   POST /api/queue/set                              install sets (ordered group of jobs)
 *   GET  /api/downloads/groups                       install-set status
 *   GET  /api/debrid · PUT /api/debrid · DELETE /api/debrid/{service}
 *   POST /api/library/transfer                       copy/move between drives (job type "copy")
 *   POST /api/downloads/rest-mode/simulate           host-only test hook (wake-up event)
 * ext_downloads_tick() refreshes the debrid host lists daily and flushes
 * the statistics file.
 */
#include "api.h"
#include "catalog.h"
#include "dl.h"
#include "dlx_debrid.h"
#include "dlx_stats.h"
#include "log.h"
#include "settings.h"
#include "storage.h"
#include "sys.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int status_for(const char *code) {
  if (strcmp(code, "not_found") == 0 || strcmp(code, "bad_release") == 0 || strcmp(code, "no_release") == 0) return 404;
  if (strcmp(code, "exists") == 0) return 409;
  if (strcmp(code, "forbidden") == 0) return 403;
  if (strcmp(code, "no_space") == 0 || strcmp(code, "root_unavailable") == 0 || strcmp(code, "same_drive") == 0) return 422;
  if (strcmp(code, "downloads_unavailable") == 0) return 503;
  if (strcmp(code, "network") == 0 || strcmp(code, "service_error") == 0) return 502;
  if (strcmp(code, "bad_key") == 0 || strcmp(code, "not_connected") == 0) return 401;
  if (strcmp(code, "limit") == 0 || strcmp(code, "unsupported_host") == 0) return 422;
  return 400;
}

/* ---- stats ---------------------------------------------------------------- */

static void h_stats(api_ctx *c) {
  jw w;
  api_begin(&w);
  dlx_stats_json(&w);
  api_send(c, &w);
}

static void h_stats_reset(api_ctx *c) {
  dlx_stats_reset();
  jw w;
  api_begin(&w);
  dlx_stats_json(&w);
  api_send(c, &w);
}

/* ---- best version (SPEC §17.5) ------------------------------------------- */

/* "13.60" / "9.00" / ">= 7.61" → 1360 / 900 / 761; 0 when absent. */
static int fw_num(const char *s) {
  if (!s) return 0;
  while (*s && (*s < '0' || *s > '9')) s++;
  if (!*s) return 0;
  int major = atoi(s);
  while (*s >= '0' && *s <= '9') s++;
  int minor = 0;
  if (*s == '.') { s++; char buf[3] = {0, 0, 0}; for (int i = 0; i < 2 && *s >= '0' && *s <= '9'; i++) buf[i] = *s++; if (buf[0] && !buf[1]) buf[1] = '0'; minor = atoi(buf); }
  return major * 100 + minor;
}

typedef struct cand {
  int idx;                     /* position in releases[] */
  int kindRank, compatRank, directRank, verifiedRank, prefRank;
  char version[32];
  int64_t size;
  char kind[16], format[16], id[128];
  int verified, direct, hash, requires;
} cand;

static int cand_cmp(const void *a, const void *b) {
  const cand *x = a, *y = b;
  if (x->kindRank != y->kindRank) return x->kindRank - y->kindRank;
  if (x->compatRank != y->compatRank) return x->compatRank - y->compatRank;
  if (x->directRank != y->directRank) return x->directRank - y->directRank;
  if (x->verifiedRank != y->verifiedRank) return x->verifiedRank - y->verifiedRank;
  if (x->prefRank != y->prefRank) return x->prefRank - y->prefRank;
  int v = util_semver_cmp(y->version, x->version);   /* newest first */
  if (v != 0) return v;
  int64_t sx = x->size > 0 ? x->size : INT64_MAX, sy = y->size > 0 ? y->size : INT64_MAX;
  if (sx != sy) return sx < sy ? -1 : 1;
  return x->idx - y->idx;
}

typedef struct best_ctx {
  jw *w;
  int fw;                      /* 0 = unknown */
  char fwText[16];
  char prefer[12];
  int found;
} best_ctx;

static int release_is_direct(jv r) {
  const char *src = jv_get_str(r, "sourceId", "");
  const char *fmt = jv_get_str(r, "format", "");
  if (util_strieq(fmt, "PAGE")) return 0;
  if (strcmp(src, "archive") == 0 || strcmp(src, "xeno") == 0) return 1;
  return util_istarts_with(jv_get_str(r, "url", ""), "http") && !jv_get_str(r, "browserUrl", "")[0];
}

static void best_visit(jv g, void *user) {
  best_ctx *b = user;
  jv rels = jv_get(g, "releases");
  int n = (int)jv_len(rels);
  if (n <= 0) return;
  cand *cs = calloc((size_t)n, sizeof *cs);
  if (!cs) return;
  int m = 0, idx = 0;
  JV_FOREACH(r, rels) {
    cand *cd = &cs[m];
    cd->idx = idx++;
    xstrlcpy(cd->id, jv_get_str(r, "id", ""), sizeof cd->id);
    xstrlcpy(cd->kind, jv_get_str(r, "kind", "game"), sizeof cd->kind);
    xstrlcpy(cd->format, jv_get_str(r, "format", ""), sizeof cd->format);
    xstrlcpy(cd->version, jv_get_str(r, "version", ""), sizeof cd->version);
    cd->size = jv_get_i64(r, "sizeBytes", 0);
    cd->kindRank = util_strieq(cd->kind, "update") || util_strieq(cd->kind, "dlc") ? 2 : util_strieq(cd->kind, "backport") ? 1 : 0;
    const char *req = jv_get_str(r, "requiresFw", "");
    if (!req[0]) req = jv_get_str(r, "compat", "");
    cd->requires = fw_num(req);
    cd->compatRank = (b->fw > 0 && cd->requires > 0 && cd->requires > b->fw) ? 1 : 0;
    cd->direct = release_is_direct(r);
    cd->directRank = util_strieq(cd->format, "PAGE") ? 3 : cd->direct ? 0 : jv_get_str(r, "browserUrl", "")[0] ? 1 : 2;
    cd->hash = jv_get_str(r, "sha256", "")[0] != 0;
    cd->verified = jv_get_str(r, "verifiedAt", "")[0] != 0 || jv_get_bool(r, "consoleVerified", 0) || cd->hash;
    cd->verifiedRank = cd->verified ? 0 : 1;
    cd->prefRank = (!util_strieq(b->prefer, "auto") && util_strieq(cd->format, b->prefer)) ? 0 : 1;
    m++;
  }
  qsort(cs, (size_t)m, sizeof *cs, cand_cmp);
  const cand *best = &cs[0];
  jv rel = jv_at(rels, (size_t)best->idx);
  jw *w = b->w;
  jw_kv_str(w, "fw", b->fwText);
  jw_kv_str(w, "releaseId", best->id);
  jw_key(w, "release");
  jw_value(w, rel);
  /* reasons */
  jw_key(w, "reasons"); jw_arr_begin(w);
  /* "newest"/"smallest" are judged among the usable releases of the same
   * kind: compatible with the console firmware and not a web page. */
  int same_kind = 0, newest = best->version[0] != 0, smallest = best->size > 0;
  for (int i = 0; i < m; i++) {
    if (strcmp(cs[i].kind, best->kind) != 0 || cs[i].compatRank != 0 || util_strieq(cs[i].format, "PAGE")) continue;
    same_kind++;
    if (cs[i].version[0] && util_semver_cmp(cs[i].version, best->version) > 0) newest = 0;
    if (cs[i].size > 0 && cs[i].size < best->size) smallest = 0;
  }
  if (b->fw > 0 && best->compatRank == 0) {
    jw_obj_begin(w); jw_kv_str(w, "code", "compat"); jw_key(w, "vars"); jw_obj_begin(w); jw_kv_str(w, "fw", b->fwText);
    if (best->requires > 0) { char rq[16]; xsnprintf(rq, sizeof rq, "%d.%02d", best->requires / 100, best->requires % 100); jw_kv_str(w, "requires", rq); }
    jw_obj_end(w); jw_obj_end(w);
  }
  if (best->direct) { jw_obj_begin(w); jw_kv_str(w, "code", best->verified ? "verified" : "direct"); jw_key(w, "vars"); jw_obj_begin(w); jw_obj_end(w); jw_obj_end(w); }
  if (best->hash) { jw_obj_begin(w); jw_kv_str(w, "code", "hash"); jw_key(w, "vars"); jw_obj_begin(w); jw_obj_end(w); jw_obj_end(w); }
  if (newest && best->version[0] && same_kind > 1) { jw_obj_begin(w); jw_kv_str(w, "code", "newest"); jw_key(w, "vars"); jw_obj_begin(w); jw_kv_str(w, "v", best->version); jw_obj_end(w); jw_obj_end(w); }
  if (smallest && same_kind > 1) { char sz[32]; util_fmt_bytes(best->size, sz, sizeof sz); jw_obj_begin(w); jw_kv_str(w, "code", "smallest"); jw_key(w, "vars"); jw_obj_begin(w); jw_kv_str(w, "size", sz); jw_obj_end(w); jw_obj_end(w); }
  if (best->prefRank == 0) { jw_obj_begin(w); jw_kv_str(w, "code", "preferred"); jw_key(w, "vars"); jw_obj_begin(w); jw_kv_str(w, "format", best->format); jw_obj_end(w); jw_obj_end(w); }
  if (same_kind == 1) { jw_obj_begin(w); jw_kv_str(w, "code", "onlyOne"); jw_key(w, "vars"); jw_obj_begin(w); jw_obj_end(w); jw_obj_end(w); }
  if (util_strieq(best->format, "PAGE")) { jw_obj_begin(w); jw_kv_str(w, "code", "pageOnly"); jw_key(w, "vars"); jw_obj_begin(w); jw_obj_end(w); jw_obj_end(w); }
  jw_arr_end(w);
  jw_key(w, "alternatives"); jw_arr_begin(w);
  for (int i = 1; i < m && i < 4; i++) jw_str(w, cs[i].id);
  jw_arr_end(w);
  jw_kv_int(w, "candidates", m);
  b->found = 1;
  free(cs);
}

static void h_game_best(api_ctx *c) {
  char id[160], fw[16];
  http_query_get(c->req, "id", id, sizeof id);
  http_query_get(c->req, "fw", fw, sizeof fw);
  if (!id[0]) { api_error(c, 400, "bad_request", "id is required"); return; }
  settings_t s;
  settings_get(&s);
  best_ctx b;
  memset(&b, 0, sizeof b);
  const char *fwsrc = fw[0] ? fw : sys_fw_version();
  b.fw = fw_num(fwsrc);
  if (b.fw > 0) xsnprintf(b.fwText, sizeof b.fwText, "%d.%02d", b.fw / 100, b.fw % 100);
  else xstrlcpy(b.fwText, "", sizeof b.fwText);
  xstrlcpy(b.prefer, s.preferFormat[0] ? s.preferFormat : "auto", sizeof b.prefer);
  jw w;
  api_begin(&w);
  b.w = &w;
  if (catalog_visit_game(id, best_visit, &b) != 0) { jw_free(&w); api_error(c, 404, "not_found", "Unknown game id"); return; }
  if (!b.found) { jw_free(&w); api_error(c, 404, "no_release", "No downloads listed for this game"); return; }
  api_send(c, &w);
}

/* ---- install sets (SPEC §17.13) ------------------------------------------ */

#define SET_MAX_ITEMS 24

typedef struct set_item { char releaseId[128]; char kind[16]; int64_t size; int order; } set_item;

typedef struct set_ctx {
  const char *base;
  int want_update, want_dlc, want_backport;
  int fw;
  set_item items[SET_MAX_ITEMS];
  int n;
  char err[256];
} set_ctx;

static void set_add(set_ctx *sc, const char *id, const char *kind, int64_t size) {
  if (!id || !*id || sc->n >= SET_MAX_ITEMS) return;
  for (int i = 0; i < sc->n; i++) if (strcmp(sc->items[i].releaseId, id) == 0) return;
  set_item *it = &sc->items[sc->n++];
  xstrlcpy(it->releaseId, id, sizeof it->releaseId);
  xstrlcpy(it->kind, kind && *kind ? kind : "game", sizeof it->kind);
  it->size = size;
}

/* Builds the set from base + also flags: latest update, every DLC, the
 * backport for the console firmware. */
static void set_visit(jv g, void *user) {
  set_ctx *sc = user;
  jv rels = jv_get(g, "releases");
  char best_update[128] = "", best_update_v[32] = "", best_bp[128] = "";
  int64_t best_update_size = 0, best_bp_size = 0;
  int best_bp_fw = -1;
  int base_seen = 0;
  JV_FOREACH(r, rels) {
    const char *id = jv_get_str(r, "id", "");
    const char *kind = jv_get_str(r, "kind", "game");
    const char *fmt = jv_get_str(r, "format", "");
    if (strcmp(id, sc->base) == 0) { base_seen = 1; set_add(sc, id, kind, jv_get_i64(r, "sizeBytes", 0)); continue; }
    if (util_strieq(fmt, "PAGE")) continue;
    if (sc->want_update && util_strieq(kind, "update")) {
      const char *v = jv_get_str(r, "version", "");
      if (!best_update[0] || util_semver_cmp(v, best_update_v) > 0) { xstrlcpy(best_update, id, sizeof best_update); xstrlcpy(best_update_v, v, sizeof best_update_v); best_update_size = jv_get_i64(r, "sizeBytes", 0); }
    } else if (sc->want_dlc && util_strieq(kind, "dlc")) {
      set_add(sc, id, "dlc", jv_get_i64(r, "sizeBytes", 0));
    } else if (sc->want_backport && util_strieq(kind, "backport")) {
      const char *bp = jv_get_str(r, "backportFw", "");
      if (!bp[0]) bp = jv_get_str(r, "requiresFw", "");
      int bfw = fw_num(bp);
      int fits = sc->fw <= 0 || bfw <= 0 || bfw <= sc->fw;
      if (fits && bfw > best_bp_fw) { best_bp_fw = bfw; xstrlcpy(best_bp, id, sizeof best_bp); best_bp_size = jv_get_i64(r, "sizeBytes", 0); }
    }
  }
  if (!base_seen) { xsnprintf(sc->err, sizeof sc->err, "Unknown release %s", sc->base); return; }
  if (best_update[0]) set_add(sc, best_update, "update", best_update_size);
  if (best_bp[0]) set_add(sc, best_bp, "backport", best_bp_size);
}

typedef struct kind_lookup { const char *id; char kind[16]; int64_t size; int found; } kind_lookup;

static void kind_visit(jv g, void *user) {
  kind_lookup *k = user;
  JV_FOREACH(r, jv_get(g, "releases")) {
    if (strcmp(jv_get_str(r, "id", ""), k->id) == 0) {
      xstrlcpy(k->kind, jv_get_str(r, "kind", "game"), sizeof k->kind);
      k->size = jv_get_i64(r, "sizeBytes", 0);
      k->found = 1;
      return;
    }
  }
}

static int order_of(const char *installOrder, const char *kind) {
  char tmp[64];
  xstrlcpy(tmp, installOrder[0] ? installOrder : "game,backport,update,dlc", sizeof tmp);
  int pos = 0;
  char *save = NULL;
  for (char *tok = strtok_r(tmp, ",", &save); tok; tok = strtok_r(NULL, ",", &save), pos++) if (util_strieq(tok, kind)) return pos;
  return util_strieq(kind, "app") || util_strieq(kind, "bundle") ? 0 : 99;
}

static int item_cmp(const void *a, const void *b) {
  const set_item *x = a, *y = b;
  if (x->order != y->order) return x->order - y->order;
  return strcmp(x->releaseId, y->releaseId);
}

static int body_tristate(api_ctx *c, const char *key) {
  jv v = jv_get(c->body, key);
  if (!jv_ok(v) || jv_type(v) == JV_NULL) return -1;
  return jv_bool(v, 0) ? 1 : 0;
}

static void h_queue_set(api_ctx *c) {
  if (!jv_ok(c->body)) { api_error(c, 400, "bad_request", "JSON body required"); return; }
  const char *gameId = api_body_str(c, "gameId", "");
  if (!gameId[0]) { api_error(c, 400, "bad_request", "gameId is required"); return; }
  settings_t s;
  settings_get(&s);
  set_ctx sc;
  memset(&sc, 0, sizeof sc);
  sc.fw = fw_num(sys_fw_version());
  jv items = jv_get(c->body, "items");
  if (jv_type(items) == JV_ARR && jv_len(items) > 0) {
    JV_FOREACH(it, items) {
      const char *rid = jv_type(it) == JV_STR ? jv_str(it, "") : jv_get_str(it, "releaseId", "");
      if (!rid[0]) continue;
      kind_lookup k = { rid, "", 0, 0 };
      if (catalog_visit_game(gameId, kind_visit, &k) != 0) { api_error(c, 404, "bad_release", "Unknown game"); return; }
      if (!k.found) { char m[200]; xsnprintf(m, sizeof m, "Unknown release %s", rid); api_error(c, 404, "bad_release", m); return; }
      const char *kind = jv_type(it) == JV_OBJ ? jv_get_str(it, "kind", "") : "";
      set_add(&sc, rid, kind[0] ? kind : k.kind, k.size);
    }
  } else {
    sc.base = api_body_str(c, "base", api_body_str(c, "releaseId", ""));
    if (!sc.base[0]) { api_error(c, 400, "bad_request", "items[] or base is required"); return; }
    jv also = jv_get(c->body, "also");
    sc.want_update = jv_get_bool(also, "update", 1);
    sc.want_dlc = jv_get_bool(also, "dlc", 0);
    sc.want_backport = jv_get_bool(also, "backport", 0);
    if (catalog_visit_game(gameId, set_visit, &sc) != 0) { api_error(c, 404, "bad_release", "Unknown game"); return; }
    if (sc.err[0]) { api_error(c, 404, "bad_release", sc.err); return; }
  }
  if (sc.n == 0) { api_error(c, 400, "bad_request", "The set is empty"); return; }
  for (int i = 0; i < sc.n; i++) sc.items[i].order = order_of(s.installOrder, sc.items[i].kind);
  qsort(sc.items, (size_t)sc.n, sizeof sc.items[0], item_cmp);
  /* whole-set space check before the first job is created */
  const char *rootPath = api_body_str(c, "root", "");
  storage_root root;
  if (rootPath[0] ? storage_find_root(rootPath, &root) != 0 : 1) {
    storage_root roots[STORAGE_MAX_ROOTS];
    int n = storage_get_roots(roots, STORAGE_MAX_ROOTS), found = 0;
    for (int i = 0; i < n; i++) if ((rootPath[0] && strcmp(roots[i].path, rootPath) == 0) || (!rootPath[0] && roots[i].is_default)) { root = roots[i]; found = 1; break; }
    if (!found && !rootPath[0] && n) { root = roots[0]; found = 1; }
    if (!found) { api_error(c, 422, "root_unavailable", "The chosen drive is not available"); return; }
  }
  int64_t total = 0;
  for (int i = 0; i < sc.n; i++) total += sc.items[i].size > 0 ? sc.items[i].size : 0;
  int64_t after_queue = root.free - dl_remaining_on_root(root.path);
  if (total > 0 && after_queue < total + DL_RESERVE_BYTES) {
    char a[32], b[32], m[256];
    util_fmt_bytes(total, a, sizeof a);
    util_fmt_bytes(after_queue, b, sizeof b);
    xsnprintf(m, sizeof m, "Not enough free space on %s for the whole set: need %s + 256 MB reserve, have %s after the queue", root.label, a, b);
    api_error(c, 422, "no_space", m);
    return;
  }
  char group[16];
  util_rand_id("g_", group, sizeof group);
  const char *verify = api_body_str(c, "verify", "auto");
  int verify_flag = util_strieq(verify, "none") || util_strieq(verify, "size") ? 0 : util_strieq(verify, "sha256") ? 1 : -1;
  char ids[SET_MAX_ITEMS][16];
  int made = 0;
  char code[32], msg[256];
  for (int i = 0; i < sc.n; i++) {
    dl_add_req r;
    memset(&r, 0, sizeof r);
    r.gameId = gameId;
    r.releaseId = sc.items[i].releaseId;
    r.root = root.path;
    r.connections = (int)jv_get_i64(c->body, "connections", 0);
    r.verify = verify_flag;
    r.autoInstall = body_tristate(c, "autoInstall");
    r.overwrite = jv_get_bool(c->body, "overwrite", 0);
    r.body = c->body;
    r.via = api_body_str(c, "via", "");
    r.kind = sc.items[i].kind;
    r.group = group;
    r.groupOrder = i + 1;
    r.mirrors = jv_get(c->body, "mirrors");
    if (dl_add(&r, ids[made], sizeof ids[made], code, sizeof code, msg, sizeof msg) != 0) {
      /* roll back: a half set would install in the wrong order */
      for (int k = 0; k < made; k++) { char c2[32], m2[256]; jv none = { NULL, 0xFFFFFFFFu }; dl_action(ids[k], "remove", none, c2, sizeof c2, m2, sizeof m2); }
      char m[320];
      xsnprintf(m, sizeof m, "%s (set step %d/%d, %s)", msg, i + 1, sc.n, sc.items[i].kind);
      api_error(c, status_for(code), code, m);
      return;
    }
    made++;
  }
  LOGI("install set %s: %d job(s) for %s", group, made, gameId);
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "group", group);
  jw_key(&w, "jobs"); jw_arr_begin(&w);
  for (int i = 0; i < made; i++) dl_job_json(&w, ids[i], 0);
  jw_arr_end(&w);
  api_send(c, &w);
}

static void h_groups(api_ctx *c) {
  dl_group_status *gs = calloc(64, sizeof *gs);
  if (!gs) { api_error(c, 500, "oom", "Out of memory"); return; }
  int n = dl_group_statuses(gs, 64);
  jw w;
  api_begin(&w);
  jw_key(&w, "groups"); jw_arr_begin(&w);
  for (int i = 0; i < n; i++) {
    jw_obj_begin(&w);
    jw_kv_str(&w, "id", gs[i].id); jw_kv_str(&w, "gameId", gs[i].gameId); jw_kv_str(&w, "title", gs[i].title);
    jw_kv_int(&w, "total", gs[i].total); jw_kv_int(&w, "downloaded", gs[i].downloaded); jw_kv_int(&w, "installed", gs[i].installed);
    jw_kv_int(&w, "failed", gs[i].failed); jw_kv_int(&w, "pending", gs[i].pending);
    jw_kv_str(&w, "status", gs[i].status); jw_kv_str(&w, "pausedAt", gs[i].pausedAt); jw_kv_str(&w, "pausedJobId", gs[i].pausedJobId);
    jw_obj_end(&w);
  }
  jw_arr_end(&w);
  free(gs);
  api_send(c, &w);
}

/* ---- debrid (SPEC §17.14) -------------------------------------------------- */

static void h_debrid_get(api_ctx *c) {
  settings_t s;
  settings_get(&s);
  jw w;
  api_begin(&w);
  jw_kv_str(&w, "preferred", s.debrid.preferred);
  jw_key(&w, "services");
  dlx_debrid_services_json(&w);
  api_send(c, &w);
}

static void h_debrid_put(api_ctx *c) {
  if (!jv_ok(c->body)) { api_error(c, 400, "bad_request", "JSON body required"); return; }
  const char *service = api_body_str(c, "service", api_body_str(c, "id", ""));
  const char *key = api_body_str(c, "apiKey", api_body_str(c, "key", ""));
  char code[32], err[256];
  if (dlx_debrid_connect(service, key, code, sizeof code, err, sizeof err) != 0) { api_error(c, status_for(code), code, err); return; }
  h_debrid_get(c);
}

static void h_debrid_delete(api_ctx *c) {
  char err[256];
  if (!dlx_debrid_known(c->params[0])) { api_error(c, 404, "not_found", "Unknown debrid service"); return; }
  if (dlx_debrid_disconnect(c->params[0], err, sizeof err) != 0) { api_error(c, 400, "bad_request", err); return; }
  h_debrid_get(c);
}

/* ---- copy / move (SPEC §17.16) ------------------------------------------- */

static void h_transfer(api_ctx *c) {
  if (!jv_ok(c->body)) { api_error(c, 400, "bad_request", "JSON body required"); return; }
  const char *path = api_body_str(c, "path", "");
  const char *toRoot = api_body_str(c, "toRoot", api_body_str(c, "root", ""));
  if (!path[0] || !toRoot[0]) { api_error(c, 400, "bad_request", "path and toRoot are required"); return; }
  char id[16], code[32], msg[256];
  if (dl_add_copy_job(path, toRoot, jv_get_bool(c->body, "move", 0), jv_get_bool(c->body, "overwrite", 0), id, sizeof id, code, sizeof code, msg, sizeof msg) != 0) {
    api_error(c, status_for(code), code, msg);
    return;
  }
  jw w;
  api_begin(&w);
  jw_key(&w, "job");
  dl_job_json(&w, id, 0);
  api_send(c, &w);
}

#ifdef XENO_HOST
static void h_rest_simulate(api_ctx *c) {
  dl_simulate_wake();
  jw w;
  api_begin(&w);
  jw_kv_bool(&w, "simulated", 1);
  api_send(c, &w);
}
#endif

/* ---- registration ---------------------------------------------------------- */

static const api_route ROUTES[] = {
  { "GET", "/api/stats", h_stats },
  { "POST", "/api/stats/reset", h_stats_reset },
  { "GET", "/api/game/best", h_game_best },
  { "POST", "/api/queue/set", h_queue_set },
  { "GET", "/api/downloads/groups", h_groups },
  { "GET", "/api/debrid", h_debrid_get },
  { "PUT", "/api/debrid", h_debrid_put },
  { "POST", "/api/debrid", h_debrid_put },
  { "DELETE", "/api/debrid/{service}", h_debrid_delete },
  { "POST", "/api/library/transfer", h_transfer },
#ifdef XENO_HOST
  { "POST", "/api/downloads/rest-mode/simulate", h_rest_simulate },
#endif
};

void ext_downloads_init(void) {
  if (api_register_routes(ROUTES, XS_ARRAY_LEN(ROUTES)) != 0) LOGE("ext_downloads: route table full");
  else LOGI("ext_downloads: %zu route(s) registered", XS_ARRAY_LEN(ROUTES));
}

void ext_downloads_tick(void) {
  dlx_debrid_tick();
  dlx_stats_flush(0);
}
