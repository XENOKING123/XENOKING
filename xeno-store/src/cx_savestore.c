/*
 * cx_savestore.c — see cx_savestore.h.
 *
 * The merged index is rebuilt at most once an hour (or on refresh=1) from
 * every configured source and kept as JSON text; requests parse it, filter
 * and attach the compatibility fields computed against this console.
 */
#include "cx_savestore.h"
#include "catalog.h"
#include "cx_accounts.h"
#include "cx_common.h"
#include "cx_feeds.h"
#include "cx_jobs.h"
#include "cx_savemount.h"
#include "cx_saves.h"
#include "http_client.h"
#include "log.h"
#include "settings.h"
#include "storage.h"
#include "util.h"
#include "zip.h"

#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define INDEX_MAX_AGE_S 3600
#define INDEX_MAX_ROWS 2000
#define ROW_KEY_LEN 72
#define DEFAULT_SAVES_INDEX "https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/updates/saves.json"
#define SAVE_ZIP_MAX (2LL << 30)
#define UPLOAD_MAX (512LL << 20)
#define CATBOX_MAX (200LL << 20)

static pthread_mutex_t store_mu = PTHREAD_MUTEX_INITIALIZER;
static char *merged_text;
static size_t merged_len;
static time_t merged_at;
static volatile int building;

static const char *const DOWNLOAD_HOSTS[] = {"pixeldrain.com", "catbox.moe", "github.com", "githubusercontent.com", "archive.org",
                                             "supabase.co", "garlicsaves.com", "gofile.io", "buzzheavier.com", "mediafire.com"};

/* ---- backend config ----------------------------------------------------- */

typedef struct backend {
  char kind[12], url[256], anonKey[512], bucket[64], fn[64];
} backend;

static void backend_get(backend *b) {
  memset(b, 0, sizeof *b);
  settings_t s;
  settings_get(&s);
  /* settings override the published saves-backend.json */
  if (strcmp(s.saves.backend.kind, "supabase") == 0 && s.saves.backend.url[0] && s.saves.backend.anonKey[0]) {
    xstrlcpy(b->kind, "supabase", sizeof b->kind);
    xstrlcpy(b->url, s.saves.backend.url, sizeof b->url);
    xstrlcpy(b->anonKey, s.saves.backend.anonKey, sizeof b->anonKey);
    xstrlcpy(b->bucket, s.saves.backend.bucket, sizeof b->bucket);
    xstrlcpy(b->fn, s.saves.backend.garlicFunction, sizeof b->fn);
    return;
  }
  if (strcmp(s.saves.backend.kind, "none") == 0) { xstrlcpy(b->kind, "none", sizeof b->kind); return; }
  xstrlcpy(b->kind, "github", sizeof b->kind);
  jdoc *d = cx_feed_doc(CX_FEED_SAVES_BACKEND);
  if (!d) return;
  jv r = json_root(d);
  if (strcmp(jv_get_str(r, "kind", ""), "supabase") == 0 && jv_get_str(r, "url", "")[0] && jv_get_str(r, "anonKey", "")[0]) {
    xstrlcpy(b->kind, "supabase", sizeof b->kind);
    xstrlcpy(b->url, jv_get_str(r, "url", ""), sizeof b->url);
    size_t ul = strlen(b->url);
    while (ul > 0 && b->url[ul - 1] == '/') b->url[--ul] = 0;
    xstrlcpy(b->anonKey, jv_get_str(r, "anonKey", ""), sizeof b->anonKey);
    xstrlcpy(b->bucket, jv_get_str(r, "bucket", "ps5-saves"), sizeof b->bucket);
    xstrlcpy(b->fn, jv_get_str(r, "garlicFunction", "garlic-savedb"), sizeof b->fn);
  }
  json_free(d);
}

static int backend_host_ok(const backend *b, const char *url) {
  char host[256], bh[256];
  util_url_host(url, host, sizeof host);
  util_url_host(b->url, bh, sizeof bh);
  return (bh[0] && strcmp(host, bh) == 0) || util_host_matches(host, "supabase.co") || cx_host_is_loopback(host);
}

static void supabase_headers(const backend *b, char *out, size_t cap, const char *extra) {
  xsnprintf(out, cap, "apikey: %s\r\nAuthorization: Bearer %s\r\n%s", b->anonKey, b->anonKey, extra ? extra : "");
}

/* Cached request (any method/headers) under <data>/feeds/<name>.json. */
static char *cached_request(const char *name, const char *url, const cx_http *opt, int max_age, int force, size_t *len, int *from_cache) {
  char path[700];
  xsnprintf(path, sizeof path, "%s/feeds/%s.json", cx_data_dir(), name);
  time_t mt = util_file_mtime(path);
  if (from_cache) *from_cache = 0;
  if (!force && mt > 0 && util_now() - mt < max_age) {
    char *t = util_read_file(path, len, 8u << 20);
    if (t) { if (from_cache) *from_cache = 1; return t; }
  }
  if (xhttp_available()) {
    int status = 0;
    size_t l = 0;
    char *t = cx_fetch(url, opt, &status, &l, NULL);
    if (t && status >= 200 && status < 300) {
      jdoc *d = json_parse(t, l, 400000, 32);
      if (d) {
        json_free(d);
        char dir[700];
        xsnprintf(dir, sizeof dir, "%s/feeds", cx_data_dir());
        util_mkdir_p(dir);
        util_write_file_atomic(path, t, l);
        if (len) *len = l;
        return t;
      }
    }
    if (t) LOGW("savestore: %s returned HTTP %d", name, status); else LOGW("savestore: %s failed: %s", name, xhttp_last_error());
    free(t);
  }
  char *t = util_read_file(path, len, 8u << 20);
  if (t && from_cache) *from_cache = 1;
  return t;
}

/* ---- row normalization -------------------------------------------------- */

static const char *infer_category(const char *cat, const char *text) {
  static const char *const cats[] = {"starter", "platinum", "checkpoint", "modded", "chapter", "other"};
  if (cat && *cat) for (size_t i = 0; i < XS_ARRAY_LEN(cats); i++) if (util_strieq(cat, cats[i])) return cats[i];
  if (!text) return "other";
  if (util_strcasestr(text, "100%") || util_strcasestr(text, "platinum")) return "platinum";
  if (util_strcasestr(text, "start") || util_strcasestr(text, "ng+") || util_strcasestr(text, "max")) return "starter";
  if (util_strcasestr(text, "trophy") || util_strcasestr(text, "boss")) return "checkpoint";
  if (util_strcasestr(text, "mod") || util_strcasestr(text, "glitch")) return "modded";
  if (util_strcasestr(text, "chapter")) return "chapter";
  return "other";
}

typedef struct dedupe {
  char (*keys)[ROW_KEY_LEN];
  int n;
} dedupe;

static int seen_key(dedupe *d, const char *key) {
  if (!key || !*key) return 0;
  for (int i = 0; i < d->n; i++) if (strcmp(d->keys[i], key) == 0) return 1;
  if (d->n < INDEX_MAX_ROWS) xstrlcpy(d->keys[d->n++], key, ROW_KEY_LEN);
  return 0;
}

static void write_row(jw *w, const char *id, const char *titleId, const char *gameId, const char *title, const char *category,
                      const char *name, const char *description, const char *author, const char *gameVersion, const char *region,
                      const char *dirName, int64_t size, const char *sha256, const char *url, const char *mirror, const char *format,
                      const char *createdAt, int downloads, const char *status, jv tags, const char *screenshot, const char *source,
                      const char *storagePath, const char *garlicId, const char *cover, int needsResign) {
  jw_obj_begin(w);
  jw_kv_str(w, "id", id);
  jw_kv_str(w, "titleId", titleId);
  jw_kv_str(w, "gameId", gameId);
  jw_kv_str(w, "title", title);
  jw_kv_str(w, "category", category);
  jw_kv_str(w, "name", name);
  jw_kv_str(w, "description", description);
  jw_kv_str(w, "author", author);
  jw_kv_str(w, "gameVersion", gameVersion);
  jw_kv_str(w, "region", region);
  jw_kv_str(w, "dirName", dirName);
  jw_kv_i64(w, "size", size);
  jw_kv_str(w, "sha256", sha256);
  jw_kv_str(w, "url", url);
  jw_kv_str(w, "mirror", mirror);
  jw_kv_str(w, "format", format);
  jw_kv_str(w, "createdAt", createdAt);
  jw_kv_int(w, "downloads", downloads);
  jw_kv_str(w, "status", status);
  jw_key(w, "tags");
  if (jv_ok(tags) && jv_type(tags) == JV_ARR) jw_value(w, tags); else { jw_arr_begin(w); jw_arr_end(w); }
  jw_kv_str(w, "screenshot", screenshot);
  jw_kv_str(w, "source", source);
  jw_kv_str(w, "storagePath", storagePath);
  jw_kv_str(w, "garlicId", garlicId);
  jw_kv_str(w, "cover", cover);
  jw_kv_bool(w, "needsResign", needsResign);
  jw_obj_end(w);
}

static int add_index_rows(jw *w, jv root, const char *source, dedupe *dd, int *count) {
  jv arr = jv_get(root, "saves");
  if (jv_type(arr) != JV_ARR) arr = root;
  if (jv_type(arr) != JV_ARR) return 0;
  int n = 0;
  JV_FOREACH(it, arr) {
    if (*count >= INDEX_MAX_ROWS) break;
    const char *tid = jv_get_str(it, "titleId", "");
    const char *url = jv_get_str(it, "url", "");
    const char *status = jv_get_str(it, "status", "published");
    if (!cx_titleid_valid(tid) || tid[0] != 'P' || !util_istarts_with(url, "http")) continue;
    if (strcmp(status, "published") != 0) continue;
    const char *sha = jv_get_str(it, "sha256", "");
    const char *id = jv_get_str(it, "id", "");
    char key[ROW_KEY_LEN];
    if (sha[0]) xsnprintf(key, sizeof key, "sha:%s", sha); else xsnprintf(key, sizeof key, "id:%s", id);
    if (!id[0] || seen_key(dd, key)) continue;
    char gid[128] = "";
    xstrlcpy(gid, jv_get_str(it, "gameId", ""), sizeof gid);
    cat_game g;
    if (!gid[0] && catalog_match_titleid(tid, &g) == 0) xstrlcpy(gid, g.id, sizeof gid);
    write_row(w, id, tid, gid, jv_get_str(it, "title", ""), infer_category(jv_get_str(it, "category", ""), jv_get_str(it, "description", "")),
              jv_get_str(it, "name", ""), jv_get_str(it, "description", ""), jv_get_str(it, "author", ""), jv_get_str(it, "gameVersion", ""),
              jv_get_str(it, "region", ""), jv_get_str(it, "dirName", ""), jv_get_i64(it, "size", 0), sha, url, jv_get_str(it, "mirror", ""),
              jv_get_str(it, "format", "xeno-save-zip"), jv_get_str(it, "createdAt", ""), (int)jv_get_i64(it, "downloads", 0), status,
              jv_get(it, "tags"), jv_get_str(it, "screenshot", ""), source, "", "", jv_get_str(it, "cover", ""), jv_get_bool(it, "needsResign", 1));
    (*count)++;
    n++;
  }
  return n;
}

static int add_supabase_rows(jw *w, jv arr, const backend *b, dedupe *dd, int *count) {
  if (jv_type(arr) != JV_ARR) return 0;
  int n = 0;
  (void)b;
  JV_FOREACH(it, arr) {
    if (*count >= INDEX_MAX_ROWS) break;
    const char *tid = jv_get_str(it, "title_id", "");
    const char *status = jv_get_str(it, "status", "published");
    if (!cx_titleid_valid(tid) || tid[0] != 'P' || strcmp(status, "published") != 0) continue;
    const char *uuid = jv_get_str(it, "id", "");
    const char *garlic = jv_get_str(it, "garlic_id", "");
    const char *path = jv_get_str(it, "file_path", "");
    const char *fname = jv_get_str(it, "file_name", "");
    if (!uuid[0]) continue;
    char key[ROW_KEY_LEN];
    if (garlic[0]) xsnprintf(key, sizeof key, "garlic:%s", garlic); else xsnprintf(key, sizeof key, "sb:%s", uuid);
    if (seen_key(dd, key)) continue;
    char id[80];
    xsnprintf(id, sizeof id, "sb:%s", uuid);
    char gid[128] = "";
    cat_game g;
    if (catalog_match_titleid(tid, &g) == 0) xstrlcpy(gid, g.id, sizeof gid);
    const char *notes = jv_get_str(it, "notes", "");
    const char *url = util_istarts_with(fname, "http") ? fname : "";
    char cover[512] = "";
    if (jv_get_str(it, "cover_path", "")[0]) xsnprintf(cover, sizeof cover, "/api/saves/store/%s/cover", id);
    write_row(w, id, tid, gid, jv_get_str(it, "game", ""), infer_category(jv_get_str(it, "category", ""), notes),
              fname[0] && !util_istarts_with(fname, "http") ? fname : jv_get_str(it, "game", ""), notes, jv_get_str(it, "shared_by", ""),
              jv_get_str(it, "game_version", ""), jv_get_str(it, "region", ""), "", jv_get_i64(it, "file_size", 0), jv_get_str(it, "sha256", ""),
              url, "", "xeno-save-zip", jv_get_str(it, "created_at", ""), (int)jv_get_i64(it, "downloads", 0), status, jv_get(it, "tags"), "",
              garlic[0] ? "garlic" : "supabase", path, garlic, cover, 1);
    (*count)++;
    n++;
  }
  return n;
}

static void build_merged(int force) {
  if (building) return;
  building = 1;
  settings_t s;
  settings_get(&s);
  backend b;
  backend_get(&b);
  dedupe dd;
  dd.keys = calloc(INDEX_MAX_ROWS, ROW_KEY_LEN);
  dd.n = 0;
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_key(&w, "sources"); jw_arr_begin(&w);
  jw jr;
  jw_init(&jr);
  jw_arr_begin(&jr);
  int count = 0;
  if (!dd.keys) { jw_free(&jr); jw_free(&w); building = 0; return; }
  /* GitHub index feeds */
  const char *urls[SET_MAX_INDEX_URLS + 1];
  int nu = 0;
  if (strcmp(b.kind, "none") != 0) urls[nu++] = DEFAULT_SAVES_INDEX;
  for (int i = 0; i < s.saves.n_indexUrls; i++) urls[nu++] = s.saves.indexUrls[i];
  for (int i = 0; i < nu; i++) {
    if (!cx_feed_host_allowed(urls[i])) { LOGW("savestore: index host not allowed: %s", urls[i]); continue; }
    char name[48], h[8];
    uint32_t hash = 2166136261u;
    for (const unsigned char *p = (const unsigned char *)urls[i]; *p; p++) hash = (hash ^ *p) * 16777619u;
    xsnprintf(h, sizeof h, "%06x", hash & 0xffffff);
    xsnprintf(name, sizeof name, "saves-index-%s", h);
    size_t len = 0;
    int fc = 0;
    cx_http o = {0};
    o.headers = "Cache-Control: no-cache\r\n";
    o.max_bytes = 8u << 20;
    char *txt = cached_request(name, urls[i], &o, INDEX_MAX_AGE_S, force, &len, &fc);
    int added = 0;
    if (txt) {
      jdoc *d = json_parse(txt, len, 400000, 32);
      if (d) { added = add_index_rows(&jr, json_root(d), "github", &dd, &count); json_free(d); }
      free(txt);
    }
    jw_obj_begin(&w); jw_kv_str(&w, "kind", "github"); jw_kv_str(&w, "url", urls[i]); jw_kv_int(&w, "rows", added); jw_kv_bool(&w, "ok", txt != NULL); jw_kv_bool(&w, "cached", fc); jw_obj_end(&w);
  }
  /* Supabase REST + Garlic rows via the edge function */
  if (strcmp(b.kind, "supabase") == 0) {
    char hdr[1200], url[600];
    supabase_headers(&b, hdr, sizeof hdr, "Accept: application/json\r\n");
    xsnprintf(url, sizeof url, "%s/rest/v1/ps5_save_collection?select=*&order=created_at.desc&limit=2000", b.url);
    cx_http o = {0};
    o.headers = hdr;
    o.max_bytes = 8u << 20;
    size_t len = 0;
    int fc = 0, added = 0;
    char *txt = backend_host_ok(&b, url) ? cached_request("saves-supabase", url, &o, INDEX_MAX_AGE_S, force, &len, &fc) : NULL;
    if (txt) { jdoc *d = json_parse(txt, len, 400000, 32); if (d) { added = add_supabase_rows(&jr, json_root(d), &b, &dd, &count); json_free(d); } free(txt); }
    jw_obj_begin(&w); jw_kv_str(&w, "kind", "supabase"); jw_kv_str(&w, "url", b.url); jw_kv_int(&w, "rows", added); jw_kv_bool(&w, "ok", txt != NULL); jw_kv_bool(&w, "cached", fc); jw_obj_end(&w);
    if (b.fn[0]) {
      char furl[600];
      xsnprintf(furl, sizeof furl, "%s/functions/v1/%s", b.url, b.fn);
      supabase_headers(&b, hdr, sizeof hdr, "Content-Type: application/json\r\n");
      cx_http fo = {0};
      fo.method = "POST";
      fo.headers = hdr;
      fo.body = "{\"action\":\"list\"}";
      fo.body_len = strlen(fo.body);
      fo.max_bytes = 8u << 20;
      fo.timeout_ms = 30000;
      len = 0; fc = 0; added = 0;
      txt = backend_host_ok(&b, furl) ? cached_request("saves-garlic", furl, &fo, INDEX_MAX_AGE_S, force, &len, &fc) : NULL;
      if (txt) {
        jdoc *d = json_parse(txt, len, 400000, 32);
        if (d) {
          jv r = json_root(d);
          jv arr = jv_type(r) == JV_ARR ? r : jv_get(r, "saves");
          if (jv_type(arr) != JV_ARR) arr = jv_get(r, "rows");
          if (jv_type(arr) != JV_ARR) arr = jv_get(r, "data");
          added = add_supabase_rows(&jr, arr, &b, &dd, &count);
          json_free(d);
        }
        free(txt);
      }
      jw_obj_begin(&w); jw_kv_str(&w, "kind", "garlic"); jw_kv_str(&w, "url", furl); jw_kv_int(&w, "rows", added); jw_kv_bool(&w, "ok", txt != NULL); jw_kv_bool(&w, "cached", fc); jw_obj_end(&w);
    }
  }
  jw_arr_end(&w);
  jw_arr_end(&jr);
  size_t rl;
  char *rows = jw_detach(&jr, &rl);
  jw_key(&w, "saves");
  if (rows) jw_raw(&w, rows, rl); else { jw_arr_begin(&w); jw_arr_end(&w); }
  free(rows);
  jw_kv_int(&w, "count", count);
  jw_kv_i64(&w, "updatedAt", (int64_t)util_now());
  jw_obj_end(&w);
  size_t len;
  char *txt = jw_detach(&w, &len);
  free(dd.keys);
  pthread_mutex_lock(&store_mu);
  free(merged_text);
  merged_text = txt;
  merged_len = txt ? len : 0;
  merged_at = util_now();
  pthread_mutex_unlock(&store_mu);
  building = 0;
  LOGI("savestore: index rebuilt (%d rows)", count);
}

static jdoc *merged_doc(int refresh) {
  pthread_mutex_lock(&store_mu);
  int stale = !merged_text || util_now() - merged_at >= INDEX_MAX_AGE_S;
  pthread_mutex_unlock(&store_mu);
  if (stale || refresh) build_merged(refresh);
  pthread_mutex_lock(&store_mu);
  jdoc *d = merged_text ? json_parse(merged_text, merged_len, 400000, 32) : NULL;
  pthread_mutex_unlock(&store_mu);
  return d;
}

void cx_savestore_init(void) {}
void cx_savestore_tick(void) {}

/* ---- installed version -------------------------------------------------- */

static int read_content_version(const char *path, char *out, size_t cap) {
  jdoc *d = cx_json_file(path, 1 << 20, 20000);
  if (!d) return -1;
  const char *v = jv_get_str(json_root(d), "contentVersion", "");
  if (!*v) v = jv_get_str(json_root(d), "masterVersion", "");
  if (!*v) v = jv_get_str(json_root(d), "version", "");
  int rc = -1;
  if (*v) { xstrlcpy(out, v, cap); rc = 0; }
  json_free(d);
  return rc;
}

int cx_installed_version(const char *titleId, char *out, size_t cap, char *source, size_t scap) {
  out[0] = 0;
  if (source) source[0] = 0;
  if (!cx_titleid_valid(titleId)) return -1;
  char p[800];
  xsnprintf(p, sizeof p, "%s/%s/param.json", cx_appmeta_root(), titleId);
  if (read_content_version(p, out, cap) == 0) { if (source) xstrlcpy(source, "appmeta", scap); return 0; }
  xsnprintf(p, sizeof p, "%s/%s/sce_sys/param.json", storage_user_app_dir(), titleId);
  if (read_content_version(p, out, cap) == 0) { if (source) xstrlcpy(source, "app", scap); return 0; }
  return -1;
}

/* ---- list with compatibility -------------------------------------------- */

static int row_matches_q(jv row, const char *q) {
  if (!q || !*q) return 1;
  char f[160], h[600];
  util_fold(q, f, sizeof f);
  util_trim(f);
  if (!f[0]) return 1;
  const char *keys[] = {"title", "titleId", "author", "name", "description"};
  for (size_t i = 0; i < XS_ARRAY_LEN(keys); i++) {
    util_fold(jv_get_str(row, keys[i], ""), h, sizeof h);
    if (strstr(h, f)) return 1;
  }
  return 0;
}

static void compat_json(jw *w, jv row) {
  const char *tid = jv_get_str(row, "titleId", "");
  const char *sv = jv_get_str(row, "gameVersion", "");
  int installed = storage_title_installed(tid);
  char iv[32] = "", src[12] = "";
  if (installed) cx_installed_version(tid, iv, sizeof iv, src, sizeof src);
  jw_kv_bool(w, "installed", installed);
  jw_kv_str(w, "installedVersion", iv);
  const char *compat;
  char text[200];
  int cmp = 0;
  if (!installed) {
    compat = "not_installed";
    xsnprintf(text, sizeof text, "Game not installed");
    /* another region of the same game installed? */
    const char *gid = jv_get_str(row, "gameId", "");
    cat_game g;
    if (gid[0] && catalog_find_game(gid, &g) == 0) {
      for (int i = 0; i < g.ntitleIds; i++)
        if (strcmp(g.titleIds[i], tid) != 0 && storage_title_installed(g.titleIds[i])) {
          jw_kv_bool(w, "otherRegion", 1);
          jw_kv_str(w, "installedTitleId", g.titleIds[i]);
          xsnprintf(text, sizeof text, "You have %s installed — a save never loads on a different title ID", g.titleIds[i]);
          break;
        }
    }
  } else if (!sv[0] || !iv[0]) {
    compat = "unknown";
    xsnprintf(text, sizeof text, "Version unknown — check before installing");
  } else {
    cmp = util_semver_cmp(sv, iv);
    if (cmp > 0) { compat = "update_game"; xsnprintf(text, sizeof text, "Made on %s, you have %s — update the game first", sv, iv); }
    else if (cmp == 0) { compat = "match"; xsnprintf(text, sizeof text, "Matches your %s", iv); }
    else { compat = "match"; xsnprintf(text, sizeof text, "Made on %s, you have %s (newer game loads older saves)", sv, iv); }
  }
  jw_kv_int(w, "versionCompare", cmp);
  jw_kv_str(w, "compat", compat);
  jw_kv_str(w, "compatText", text);
}

int cx_savestore_list_json(const char *titleId, const char *category, const char *q, int refresh, jw *w) {
  jdoc *d = merged_doc(refresh);
  jw_key(w, "saves");
  jw_arr_begin(w);
  int n = 0;
  if (d) {
    JV_FOREACH(row, jv_get(json_root(d), "saves")) {
      if (titleId && *titleId && !util_strieq(jv_get_str(row, "titleId", ""), titleId)) continue;
      if (category && *category && !util_strieq(jv_get_str(row, "category", ""), category)) continue;
      if (!row_matches_q(row, q)) continue;
      jw_obj_begin(w);
      JV_FOREACH(m, row) { jw_key(w, jv_key(m)); jw_value(w, m); }
      compat_json(w, row);
      jw_obj_end(w);
      n++;
    }
  }
  jw_arr_end(w);
  jw_kv_int(w, "count", n);
  jw_key(w, "sources");
  if (d && jv_ok(jv_get(json_root(d), "sources"))) jw_value(w, jv_get(json_root(d), "sources")); else { jw_arr_begin(w); jw_arr_end(w); }
  jw_kv_i64(w, "updatedAt", d ? jv_get_i64(json_root(d), "updatedAt", 0) : 0);
  backend b;
  backend_get(&b);
  jw_kv_str(w, "backend", b.kind);
  jw_kv_str(w, "engine", cx_tier_name(cx_savemount_tier()));
  if (d) json_free(d);
  return 0;
}

/* Copies a row by id into a small struct for the job worker. */
typedef struct row_copy {
  char id[80], titleId[12], title[160], name[160], url[1024], mirror[512], sha256[65], storagePath[256], garlicId[24], dirName[32], source[12];
  int64_t size;
} row_copy;

static int find_row(const char *id, row_copy *out) {
  jdoc *d = merged_doc(0);
  if (!d) return -1;
  int rc = -1;
  JV_FOREACH(row, jv_get(json_root(d), "saves")) {
    if (strcmp(jv_get_str(row, "id", ""), id) != 0) continue;
    memset(out, 0, sizeof *out);
    xstrlcpy(out->id, id, sizeof out->id);
    xstrlcpy(out->titleId, jv_get_str(row, "titleId", ""), sizeof out->titleId);
    xstrlcpy(out->title, jv_get_str(row, "title", ""), sizeof out->title);
    xstrlcpy(out->name, jv_get_str(row, "name", ""), sizeof out->name);
    xstrlcpy(out->url, jv_get_str(row, "url", ""), sizeof out->url);
    xstrlcpy(out->mirror, jv_get_str(row, "mirror", ""), sizeof out->mirror);
    xstrlcpy(out->sha256, jv_get_str(row, "sha256", ""), sizeof out->sha256);
    xstrlcpy(out->storagePath, jv_get_str(row, "storagePath", ""), sizeof out->storagePath);
    xstrlcpy(out->garlicId, jv_get_str(row, "garlicId", ""), sizeof out->garlicId);
    xstrlcpy(out->dirName, jv_get_str(row, "dirName", ""), sizeof out->dirName);
    xstrlcpy(out->source, jv_get_str(row, "source", ""), sizeof out->source);
    out->size = jv_get_i64(row, "size", 0);
    rc = 0;
    break;
  }
  json_free(d);
  return rc;
}

/* ---- supabase helpers --------------------------------------------------- */

static int supabase_sign(const backend *b, const char *path, char *out, size_t cap) {
  char url[700], hdr[1200];
  char enc[600];
  util_url_encode_path(path, enc, sizeof enc);
  xsnprintf(url, sizeof url, "%s/storage/v1/object/sign/%s/%s", b->url, b->bucket, enc);
  supabase_headers(b, hdr, sizeof hdr, "Content-Type: application/json\r\n");
  cx_http o = {0};
  o.method = "POST";
  o.headers = hdr;
  o.body = "{\"expiresIn\":3600}";
  o.body_len = strlen(o.body);
  int status = 0;
  size_t len = 0;
  if (!backend_host_ok(b, url)) return -1;
  char *t = cx_fetch(url, &o, &status, &len, NULL);
  int rc = -1;
  if (t && status >= 200 && status < 300) {
    jdoc *d = json_parse(t, len, 1000, 8);
    if (d) {
      const char *su = jv_get_str(json_root(d), "signedURL", jv_get_str(json_root(d), "signedUrl", ""));
      if (*su) { if (util_istarts_with(su, "http")) xstrlcpy(out, su, cap); else xsnprintf(out, cap, "%s/storage/v1%s", b->url, su); rc = 0; }
      json_free(d);
    }
  }
  free(t);
  return rc;
}

int cx_savestore_cover_url(const char *id, char *out, size_t cap) {
  out[0] = 0;
  jdoc *d = merged_doc(0);
  if (!d) return -1;
  int rc = -1;
  JV_FOREACH(row, jv_get(json_root(d), "saves")) {
    if (strcmp(jv_get_str(row, "id", ""), id) != 0) continue;
    const char *cover = jv_get_str(row, "cover", "");
    if (util_istarts_with(cover, "http")) { xstrlcpy(out, cover, cap); rc = 0; break; }
    /* supabase row: cover_path lives in the bucket */
    if (util_starts_with(id, "sb:")) {
      backend b;
      backend_get(&b);
      if (strcmp(b.kind, "supabase") == 0) {
        /* cover path is <storagePath without .zip>-cover.png by convention; fall back to the raw list */
        const char *sp = jv_get_str(row, "storagePath", "");
        char cp[300];
        xstrlcpy(cp, sp, sizeof cp);
        char *dot = strrchr(cp, '.');
        if (dot) *dot = 0;
        xstrlcat(cp, "-cover.png", sizeof cp);
        if (cp[0] && supabase_sign(&b, cp, out, cap) == 0) rc = 0;
      }
    }
    break;
  }
  json_free(d);
  return rc;
}

/* ---- install / download jobs -------------------------------------------- */

typedef struct inst_arg {
  row_copy row;
  uint32_t uid;
  int backup_first, download_only;
  char dest[1100];
} inst_arg;

static int dl_progress(void *user, int64_t done, int64_t total) {
  cx_job *j = user;
  cx_job_progress(j, done, total > 0 ? total : j->total, "Downloading");
  return cx_job_cancelled(j);
}

static int download_host_ok(const backend *b, const char *url) {
  char host[256];
  util_url_host(url, host, sizeof host);
  return cx_host_in(host, DOWNLOAD_HOSTS, XS_ARRAY_LEN(DOWNLOAD_HOSTS)) || cx_host_is_loopback(host) || (b && backend_host_ok(b, url));
}

static int fetch_zip(cx_job *j, inst_arg *a, char *err, size_t errcap) {
  backend b;
  backend_get(&b);
  row_copy *r = &a->row;
  if (r->garlicId[0] && strcmp(b.kind, "supabase") == 0 && b.fn[0]) {
    /* Garlic row: the edge function streams the zip or returns a URL */
    char url[600], hdr[1200], body[96];
    xsnprintf(url, sizeof url, "%s/functions/v1/%s", b.url, b.fn);
    supabase_headers(&b, hdr, sizeof hdr, "Content-Type: application/json\r\n");
    xsnprintf(body, sizeof body, "{\"action\":\"download\",\"id\":%s}", r->garlicId);
    cx_http o = {0};
    o.method = "POST";
    o.headers = hdr;
    o.body = body;
    o.body_len = strlen(body);
    o.timeout_ms = 60000;
    if (!backend_host_ok(&b, url)) { xsnprintf(err, errcap, "backend host not allowed"); return -1; }
    if (cx_download_file(url, &o, a->dest, "", SAVE_ZIP_MAX, dl_progress, j, &j->cancel, err, errcap) != 0) return -1;
    if (util_istarts_with(cx_download_last_type(), "application/json")) {
      size_t len = 0;
      char *t = util_read_file(a->dest, &len, 1 << 20);
      char next[1024] = "";
      if (t) { jdoc *d = json_parse(t, len, 1000, 8); if (d) { xstrlcpy(next, jv_get_str(json_root(d), "url", jv_get_str(json_root(d), "download_url", "")), sizeof next); json_free(d); } free(t); }
      util_unlink_quiet(a->dest);
      if (!util_istarts_with(next, "http") || !download_host_ok(&b, next)) { xsnprintf(err, errcap, "the backend did not return a download"); return -1; }
      return cx_download_file(next, NULL, a->dest, r->sha256, SAVE_ZIP_MAX, dl_progress, j, &j->cancel, err, errcap);
    }
    return 0;
  }
  if (r->storagePath[0] && strcmp(b.kind, "supabase") == 0) {
    char signed_url[1200];
    if (supabase_sign(&b, r->storagePath, signed_url, sizeof signed_url) != 0) { xsnprintf(err, errcap, "could not sign the storage URL"); return -1; }
    return cx_download_file(signed_url, NULL, a->dest, r->sha256, SAVE_ZIP_MAX, dl_progress, j, &j->cancel, err, errcap);
  }
  const char *urls[2] = {r->url, r->mirror};
  int tried = 0;
  for (int i = 0; i < 2; i++) {
    if (!util_istarts_with(urls[i], "http")) continue;
    if (!download_host_ok(&b, urls[i])) { xsnprintf(err, errcap, "download host not allowed"); continue; }
    tried = 1;
    if (cx_download_file(urls[i], NULL, a->dest, r->sha256, SAVE_ZIP_MAX, dl_progress, j, &j->cancel, err, errcap) == 0) return 0;
    if (cx_job_cancelled(j)) return -1;
  }
  if (!tried && !err[0]) xsnprintf(err, errcap, "the index row has no download URL");
  return -1;
}

static int install_worker(cx_job *j, void *p) {
  inst_arg *a = p;
  char err[256] = "";
  cx_job_progress(j, 0, a->row.size, "Downloading");
  if (storage_ensure_parent_dir(a->dest) != 0) { cx_job_fail(j, "io", "Cannot create the community saves folder"); return -1; }
  if (fetch_zip(j, a, err, sizeof err) != 0) { cx_job_fail(j, cx_job_cancelled(j) ? "cancelled" : "download_failed", err); util_unlink_quiet(a->dest); return -1; }
  char sha[65] = "";
  cx_sha256_file(a->dest, sha);
  jw rw;
  jw_init(&rw);
  jw_obj_begin(&rw);
  jw_kv_str(&rw, "zipPath", a->dest);
  jw_kv_str(&rw, "sha256", sha);
  jw_kv_i64(&rw, "size", util_file_size(a->dest));
  jw_kv_str(&rw, "titleId", a->row.titleId);
  if (a->download_only) {
    jw_obj_end(&rw);
    cx_job_set_result(j, &rw);
    cx_job_progress(j, 1, 1, "Downloaded");
    return 0;
  }
  cx_job_progress(j, 0, 0, "Installing to your saves");
  char base[1024], code[32], e2[256];
  cx_saves_backup_dir(base, sizeof base);
  cx_import_result ir;
  if (cx_savemount_import_zip(a->uid, a->row.titleId, a->row.dirName, a->dest, a->backup_first, base, &ir, code, sizeof code, e2, sizeof e2) != 0) {
    jw_free(&rw);
    cx_job_fail(j, code, e2);
    return -1;
  }
  jw_kv_str(&rw, "tier", ir.tier);
  jw_kv_str(&rw, "style", ir.style);
  jw_kv_str(&rw, "preBackup", ir.preBackup);
  jw_kv_int(&rw, "files", ir.files);
  jw_kv_i64(&rw, "bytes", ir.bytes);
  jw_kv_str(&rw, "accountId", ir.accountId);
  jw_obj_end(&rw);
  cx_job_set_result(j, &rw);
  cx_job_progress(j, 1, 1, "Save installed — launch the game");
  return 0;
}

int cx_savestore_install(const char *id, uint32_t uid, int backup_first, int download_only, char *job_id, size_t idcap, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  inst_arg *a = calloc(1, sizeof *a);
  if (!a) { xstrlcpy(code, "oom", ccap); xsnprintf(err, errcap, "out of memory"); return -1; }
  if (!id || !*id || find_row(id, &a->row) != 0) { free(a); xstrlcpy(code, "not_found", ccap); xsnprintf(err, errcap, "unknown save id"); return -1; }
  if (!uid) uid = cx_user_foreground();
  if (!download_only && cx_user_find(uid, NULL) != 0) { free(a); xsnprintf(err, errcap, "unknown user"); return -1; }
  if (!xhttp_available()) { free(a); xstrlcpy(code, "downloads_unavailable", ccap); xsnprintf(err, errcap, "network transport unavailable"); return -1; }
  a->uid = uid;
  a->backup_first = backup_first;
  a->download_only = download_only;
  settings_t s;
  settings_get(&s);
  storage_root sr;
  if (storage_find_root(s.defaultRoot, &sr) != 0) {
    storage_root roots[STORAGE_MAX_ROOTS];
    if (storage_get_roots(roots, STORAGE_MAX_ROOTS) < 1) { free(a); xstrlcpy(code, "root_unavailable", ccap); xsnprintf(err, errcap, "no drive available"); return -1; }
    sr = roots[0];
  }
  char tdir[64], fname[200], safe_id[80];
  if (storage_sanitize_filename(a->row.title[0] ? a->row.title : a->row.titleId, tdir, sizeof tdir) != 0) xstrlcpy(tdir, a->row.titleId, sizeof tdir);
  if (storage_sanitize_filename(a->row.id, safe_id, sizeof safe_id) != 0) xstrlcpy(safe_id, "save", sizeof safe_id);
  xsnprintf(fname, sizeof fname, "%s_%s.zip", a->row.titleId, safe_id);
  xsnprintf(a->dest, sizeof a->dest, "%s/xeno-store/saves/community/%s/%s", sr.path, tdir, fname);
  char title[256];
  xsnprintf(title, sizeof title, "%s — %s", a->row.title[0] ? a->row.title : a->row.titleId, a->row.name[0] ? a->row.name : a->row.id);
  if (cx_job_start(download_only ? "save-download" : "save-install", title, install_worker, a, job_id, idcap) != 0) { free(a); xstrlcpy(code, "busy", ccap); xsnprintf(err, errcap, "too many operations running"); return -1; }
  return 0;
}

/* ---- export ------------------------------------------------------------- */

int cx_savestore_export(uint32_t uid, const char *titleId, const char *dirName, jw *w, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  if (!uid) uid = cx_user_foreground();
  if (cx_user_find(uid, NULL) != 0) { xsnprintf(err, errcap, "unknown user"); return -1; }
  if (!cx_titleid_valid(titleId)) { xsnprintf(err, errcap, "invalid title id"); return -1; }
  if (dirName && *dirName && !cx_dirname_valid(dirName)) { xsnprintf(err, errcap, "invalid save directory name"); return -1; }
  char dn[32] = "";
  if (dirName && *dirName) xstrlcpy(dn, dirName, sizeof dn);
  else {
    char tdir[1024];
    if (cx_save_title_dir(uid, titleId, "", tdir, sizeof tdir, NULL, 0) == 0) {
      char names[8][32];
      if (cx_saves_dirnames(tdir, names, 8) > 0) xstrlcpy(dn, names[0], sizeof dn);
    }
  }
  char base[1024], stamp[24], dest[1200];
  cx_saves_backup_dir(base, sizeof base);
  cx_stamp(stamp, sizeof stamp);
  xsnprintf(dest, sizeof dest, "%s/export/%s_%s_%s.zip", base, titleId, dn[0] ? dn : "save", stamp);
  cx_export_result r;
  if (cx_savemount_export(uid, titleId, dn, dest, &r, err, errcap) != 0) { xstrlcpy(code, "export_failed", ccap); return -1; }
  jw_kv_str(w, "zipPath", r.zipPath);
  jw_kv_raw(w, "manifest", r.manifest, strlen(r.manifest));
  jw_kv_str(w, "sha256", r.sha256);
  jw_kv_i64(w, "size", r.size);
  jw_kv_int(w, "files", r.files);
  jw_kv_str(w, "format", r.format);
  jw_kv_str(w, "tier", r.tier);
  jw_kv_bool(w, "accountIdStripped", r.accountIdStripped);
  jw_kv_bool(w, "shareable", strcmp(r.format, "xeno-save-zip") == 0);
  jw_kv_str(w, "titleId", titleId);
  jw_kv_str(w, "dirName", dn);
  char iv[32] = "";
  cx_installed_version(titleId, iv, sizeof iv, NULL, 0);
  jw_kv_str(w, "gameVersion", iv);
  cat_game g;
  if (catalog_match_titleid(titleId, &g) == 0) { jw_kv_str(w, "gameId", g.id); jw_kv_str(w, "title", g.title); jw_kv_str(w, "cover", g.cover); jw_kv_str(w, "region", g.region); }
  return 0;
}

/* ---- upload ------------------------------------------------------------- */

static char *read_whole(const char *path, int64_t max, size_t *len, char *err, size_t errcap) {
  int64_t sz = util_file_size(path);
  if (sz < 0) { xsnprintf(err, errcap, "file not found"); return NULL; }
  if (sz > max) { xsnprintf(err, errcap, "file is larger than the %lld MB limit of this host", (long long)(max >> 20)); return NULL; }
  char *buf = util_read_file(path, len, (size_t)max + 1);
  if (!buf) xsnprintf(err, errcap, "cannot read the file");
  return buf;
}

static int multipart_post(const char *url, const char *field, const char *extra_fields, const char *fname, const char *data, size_t len,
                          char **resp, size_t *rlen, int *status, char *err, size_t errcap) {
  char boundary[48];
  char rnd[20];
  util_rand_hex(rnd, 16);
  xsnprintf(boundary, sizeof boundary, "----XenoStore%s", rnd);
  char head[1024];
  int hl = xsnprintf(head, sizeof head, "%s--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\nContent-Type: application/zip\r\n\r\n",
                     extra_fields ? extra_fields : "", boundary, field, fname);
  char tail[80];
  int tl = xsnprintf(tail, sizeof tail, "\r\n--%s--\r\n", boundary);
  size_t total = (size_t)hl + len + (size_t)tl;
  char *body = malloc(total);
  if (!body) { xsnprintf(err, errcap, "out of memory"); return -1; }
  memcpy(body, head, (size_t)hl);
  memcpy(body + hl, data, len);
  memcpy(body + hl + len, tail, (size_t)tl);
  char hdr[160];
  xsnprintf(hdr, sizeof hdr, "Content-Type: multipart/form-data; boundary=%s\r\n", boundary);
  cx_http o = {0};
  o.method = "POST";
  o.headers = hdr;
  o.body = body;
  o.body_len = total;
  o.timeout_ms = 600000;
  o.max_bytes = 1 << 20;
  *resp = cx_fetch(url, &o, status, rlen, NULL);
  free(body);
  if (!*resp) { xsnprintf(err, errcap, "upload failed: %s", xhttp_last_error()); return -1; }
  return 0;
}

int cx_savestore_upload(const char *zipPath, const char *host, jw *w, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  if (!cx_saves_zip_allowed(zipPath)) { xstrlcpy(code, "forbidden", ccap); xsnprintf(err, errcap, "zipPath must be an export below <drive>/xeno-store/saves/"); return -1; }
  if (!xhttp_available()) { xstrlcpy(code, "downloads_unavailable", ccap); xsnprintf(err, errcap, "network transport unavailable"); return -1; }
  settings_t s;
  settings_get(&s);
  char h[12];
  xstrlcpy(h, host && *host ? host : s.saves.uploadHost, sizeof h);
  util_lower(h);
  const char *fname = util_basename(zipPath);
  char sha[65] = "";
  cx_sha256_file(zipPath, sha);
  int64_t size = util_file_size(zipPath);
  char url[1024] = "";
  if (strcmp(h, "pixeldrain") == 0) {
    const char *base = cx_base_override("PIXELDRAIN");
    if (!*base) base = "https://pixeldrain.com";
    size_t len = 0;
    char *data = read_whole(zipPath, UPLOAD_MAX, &len, err, errcap);
    if (!data) return -1;
    char enc[300], u[600];
    cx_url_encode(fname, enc, sizeof enc);
    xsnprintf(u, sizeof u, "%s/api/file/%s", base, enc);
    cx_http o = {0};
    o.method = "PUT";
    o.headers = "Content-Type: application/zip\r\n";
    o.body = data;
    o.body_len = len;
    o.timeout_ms = 600000;
    o.max_bytes = 1 << 20;
    int status = 0;
    size_t rl = 0;
    char *resp = cx_fetch(u, &o, &status, &rl, NULL);
    free(data);
    if (!resp) { xstrlcpy(code, "upload_failed", ccap); xsnprintf(err, errcap, "pixeldrain upload failed: %s", xhttp_last_error()); return -1; }
    jdoc *d = json_parse(resp, rl, 1000, 8);
    const char *id = d ? jv_get_str(json_root(d), "id", "") : "";
    if (status >= 200 && status < 300 && *id) xsnprintf(url, sizeof url, "%s/api/file/%s", base, id);
    else { xstrlcpy(code, "upload_failed", ccap); xsnprintf(err, errcap, "pixeldrain answered HTTP %d%s%s", status, d ? ": " : "", d ? jv_get_str(json_root(d), "message", "") : ""); }
    if (d) json_free(d);
    free(resp);
  } else if (strcmp(h, "catbox") == 0) {
    const char *base = cx_base_override("CATBOX");
    if (!*base) base = "https://catbox.moe";
    size_t len = 0;
    char *data = read_whole(zipPath, CATBOX_MAX, &len, err, errcap);
    if (!data) return -1;
    char u[600];
    xsnprintf(u, sizeof u, "%s/user/api.php", base);
    char *resp = NULL;
    size_t rl = 0;
    int status = 0;
    /* catbox wants reqtype=fileupload before the file part */
    {
      char b2[48], r2[20];
      util_rand_hex(r2, 16);
      xsnprintf(b2, sizeof b2, "----XenoStore%s", r2);
      char head[600];
      int hl = xsnprintf(head, sizeof head, "--%s\r\nContent-Disposition: form-data; name=\"reqtype\"\r\n\r\nfileupload\r\n--%s\r\nContent-Disposition: form-data; name=\"fileToUpload\"; filename=\"%s\"\r\nContent-Type: application/zip\r\n\r\n", b2, b2, fname);
      char tail[80];
      int tl = xsnprintf(tail, sizeof tail, "\r\n--%s--\r\n", b2);
      size_t total = (size_t)hl + len + (size_t)tl;
      char *body = malloc(total);
      if (!body) { free(data); xsnprintf(err, errcap, "out of memory"); return -1; }
      memcpy(body, head, (size_t)hl); memcpy(body + hl, data, len); memcpy(body + hl + len, tail, (size_t)tl);
      free(data);
      char hdr[160];
      xsnprintf(hdr, sizeof hdr, "Content-Type: multipart/form-data; boundary=%s\r\n", b2);
      cx_http o = {0};
      o.method = "POST"; o.headers = hdr; o.body = body; o.body_len = total; o.timeout_ms = 600000; o.max_bytes = 1 << 20;
      resp = cx_fetch(u, &o, &status, &rl, NULL);
      free(body);
    }
    if (!resp) { xstrlcpy(code, "upload_failed", ccap); xsnprintf(err, errcap, "catbox upload failed: %s", xhttp_last_error()); return -1; }
    util_trim(resp);
    if (status >= 200 && status < 300 && util_istarts_with(resp, "http")) xstrlcpy(url, resp, sizeof url);
    else { xstrlcpy(code, "upload_failed", ccap); xsnprintf(err, errcap, "catbox answered HTTP %d: %.80s", status, resp); }
    free(resp);
  } else if (strcmp(h, "custom") == 0) {
    if (!util_istarts_with(s.saves.uploadEndpoint, "http")) { xsnprintf(err, errcap, "set Settings → Saves → Upload endpoint first"); return -1; }
    size_t len = 0;
    char *data = read_whole(zipPath, UPLOAD_MAX, &len, err, errcap);
    if (!data) return -1;
    char *resp = NULL;
    size_t rl = 0;
    int status = 0;
    int rc = multipart_post(s.saves.uploadEndpoint, "file", "", fname, data, len, &resp, &rl, &status, err, errcap);
    free(data);
    if (rc != 0) { xstrlcpy(code, "upload_failed", ccap); return -1; }
    util_trim(resp);
    jdoc *d = json_parse(resp, rl, 1000, 8);
    if (d) { xstrlcpy(url, jv_get_str(json_root(d), "url", ""), sizeof url); json_free(d); }
    else if (util_istarts_with(resp, "http")) xstrlcpy(url, resp, sizeof url);
    if (status < 200 || status >= 300 || !url[0]) { xstrlcpy(code, "upload_failed", ccap); xsnprintf(err, errcap, "upload endpoint answered HTTP %d without a url", status); }
    free(resp);
  } else { xsnprintf(err, errcap, "host must be pixeldrain, catbox or custom"); return -1; }
  if (!url[0]) return -1;
  jw_kv_str(w, "url", url);
  jw_kv_str(w, "sha256", sha);
  jw_kv_i64(w, "size", size);
  jw_kv_str(w, "host", h);
  jw_kv_str(w, "name", fname);
  LOGI("savestore: uploaded %s to %s", fname, h);
  return 0;
}

/* ---- submit ------------------------------------------------------------- */

int cx_savestore_submit(jv meta, jw *w, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  if (jv_type(meta) != JV_OBJ) { xsnprintf(err, errcap, "JSON object required"); return -1; }
  const char *tid = jv_get_str(meta, "titleId", "");
  const char *url = jv_get_str(meta, "url", "");
  const char *desc = jv_get_str(meta, "description", "");
  if (!cx_titleid_valid(tid) || tid[0] != 'P') { xsnprintf(err, errcap, "titleId must be a PS5 id (PPSA…)"); return -1; }
  if (!util_istarts_with(url, "http")) { xsnprintf(err, errcap, "url must be the uploaded zip link"); return -1; }
  if (strlen(desc) > 300) { xsnprintf(err, errcap, "description must be 300 characters or less"); return -1; }
  settings_t s;
  settings_get(&s);
  const char *nick = jv_get_str(meta, "author", jv_get_str(meta, "nickname", ""));
  if (!*nick) nick = s.saves.nickname;
  const char *category = infer_category(jv_get_str(meta, "category", ""), desc);
  /* canonical JSON block (what the intake Action parses) */
  jw bw;
  jw_init(&bw);
  jw_obj_begin(&bw);
  jw_kv_str(&bw, "titleId", tid);
  jw_kv_str(&bw, "gameId", jv_get_str(meta, "gameId", ""));
  jw_kv_str(&bw, "title", jv_get_str(meta, "title", ""));
  jw_kv_str(&bw, "category", category);
  jw_kv_str(&bw, "name", jv_get_str(meta, "name", ""));
  jw_kv_str(&bw, "description", desc);
  jw_kv_str(&bw, "author", nick);
  jw_kv_str(&bw, "gameVersion", jv_get_str(meta, "gameVersion", ""));
  jw_kv_str(&bw, "region", jv_get_str(meta, "region", ""));
  jw_kv_str(&bw, "dirName", jv_get_str(meta, "dirName", ""));
  jw_kv_i64(&bw, "size", jv_get_i64(meta, "size", 0));
  jw_kv_str(&bw, "sha256", jv_get_str(meta, "sha256", ""));
  jw_kv_str(&bw, "url", url);
  jw_kv_str(&bw, "format", "xeno-save-zip");
  jw_kv_str(&bw, "kind", "ps5");
  jw_key(&bw, "tags");
  if (jv_type(jv_get(meta, "tags")) == JV_ARR) jw_value(&bw, jv_get(meta, "tags")); else { jw_arr_begin(&bw); jw_arr_end(&bw); }
  jw_obj_end(&bw);
  size_t bl;
  char *block = jw_detach(&bw, &bl);
  if (!block) { xstrlcpy(code, "oom", ccap); xsnprintf(err, errcap, "out of memory"); return -1; }
  /* GitHub issue URL (always available as the fallback / phone hand-off) */
  char title[300], enc_title[900];
  xsnprintf(title, sizeof title, "[save] %s — %s", jv_get_str(meta, "title", tid), jv_get_str(meta, "name", category));
  cx_url_encode(title, enc_title, sizeof enc_title);
  char body[2400];
  xsnprintf(body, sizeof body, "<!-- Submitted from XENO STORE %s. Keep the JSON block below unchanged. -->\n\n```json\n%s\n```\n", XENO_VERSION, block);
  char *enc_body = malloc(strlen(body) * 3 + 1);
  if (!enc_body) { free(block); xstrlcpy(code, "oom", ccap); xsnprintf(err, errcap, "out of memory"); return -1; }
  cx_url_encode(body, enc_body, strlen(body) * 3 + 1);
  char *issue = malloc(strlen(enc_body) + 1200);
  if (!issue) { free(block); free(enc_body); xstrlcpy(code, "oom", ccap); xsnprintf(err, errcap, "out of memory"); return -1; }
  xsnprintf(issue, strlen(enc_body) + 1200, "https://github.com/XENOKING123/XENOKING/issues/new?template=save-submission.md&labels=save-submission&title=%s&body=%s", enc_title, enc_body);
  free(enc_body);
  const char *method = "github";
  char inserted_id[80] = "";
  backend b;
  backend_get(&b);
  if (strcmp(b.kind, "supabase") == 0 && xhttp_available()) {
    jw rw;
    jw_init(&rw);
    jw_obj_begin(&rw);
    jw_kv_str(&rw, "title_id", tid);
    jw_kv_str(&rw, "game", jv_get_str(meta, "title", ""));
    jw_kv_str(&rw, "shared_by", nick);
    jw_kv_str(&rw, "notes", desc);
    jw_kv_str(&rw, "file_path", jv_get_str(meta, "storagePath", ""));
    jw_kv_str(&rw, "file_name", url);
    jw_kv_i64(&rw, "file_size", jv_get_i64(meta, "size", 0));
    jw_kv_str(&rw, "category", category);
    jw_kv_str(&rw, "game_version", jv_get_str(meta, "gameVersion", ""));
    jw_kv_str(&rw, "region", jv_get_str(meta, "region", ""));
    jw_kv_str(&rw, "source", "xeno");
    jw_kv_str(&rw, "status", "pending");
    jw_key(&rw, "tags");
    if (jv_type(jv_get(meta, "tags")) == JV_ARR) jw_value(&rw, jv_get(meta, "tags")); else { jw_arr_begin(&rw); jw_arr_end(&rw); }
    jw_obj_end(&rw);
    size_t rl;
    char *row = jw_detach(&rw, &rl);
    char u[600], hdr[1300];
    xsnprintf(u, sizeof u, "%s/rest/v1/ps5_save_collection", b.url);
    supabase_headers(&b, hdr, sizeof hdr, "Content-Type: application/json\r\nPrefer: return=representation\r\n");
    if (row && backend_host_ok(&b, u)) {
      cx_http o = {0};
      o.method = "POST"; o.headers = hdr; o.body = row; o.body_len = rl; o.timeout_ms = 30000;
      int status = 0;
      size_t len = 0;
      char *resp = cx_fetch(u, &o, &status, &len, NULL);
      if (resp && status >= 200 && status < 300) {
        method = "supabase";
        jdoc *d = json_parse(resp, len, 2000, 8);
        if (d) { jv r = json_root(d); jv first = jv_type(r) == JV_ARR ? jv_at(r, 0) : r; xstrlcpy(inserted_id, jv_get_str(first, "id", ""), sizeof inserted_id); json_free(d); }
      } else LOGW("savestore: supabase insert failed (HTTP %d) — falling back to the GitHub issue", status);
      free(resp);
    }
    free(row);
  } else if (util_istarts_with(s.saves.submitEndpoint, "http") && xhttp_available()) {
    cx_http o = {0};
    o.method = "POST"; o.headers = "Content-Type: application/json\r\n"; o.body = block; o.body_len = bl; o.timeout_ms = 30000;
    int status = 0;
    size_t len = 0;
    char *resp = cx_fetch(s.saves.submitEndpoint, &o, &status, &len, NULL);
    if (resp && status >= 200 && status < 300) method = "custom";
    else LOGW("savestore: custom submit failed (HTTP %d) — falling back to the GitHub issue", status);
    free(resp);
  }
  jw_kv_str(w, "method", method);
  jw_kv_str(w, "issueUrl", issue);
  jw_kv_str(w, "qr", issue);
  if (inserted_id[0]) jw_kv_str(w, "id", inserted_id);
  jw_kv_raw(w, "submission", block, bl);
  jw_kv_str(w, "note", strcmp(method, "github") == 0 ? "Open the link (or scan the QR) on your phone and press Submit new issue — the save is reviewed before it appears in the store."
                                                      : "Submitted — the save appears in the store once it is approved.");
  free(block);
  free(issue);
  return 0;
}
