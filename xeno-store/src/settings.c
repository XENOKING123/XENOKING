/*
 * settings.c — see settings.h. Each file is written atomically (.tmp +
 * rename) and re-read on startup; missing or corrupt files fall back to the
 * §9 defaults so the store always boots.
 */
#include "settings.h"
#include "log.h"
#include "util.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static pthread_mutex_t settings_mu = PTHREAD_MUTEX_INITIALIZER;
static settings_t S;
static char data_dir[512];

typedef struct collection {
  char id[64], name[96], icon[32];
  char (*ids)[SET_ID_LEN];
  int n;
} collection_t;

static char (*favorites)[SET_ID_LEN];
static int n_favorites;
static collection_t collections[SET_MAX_COLLECTIONS];
static int n_collections;
static char recent[SET_RECENT_KEEP][SET_ID_LEN];
static int n_recent;

#define DEFAULT_CATALOG_URL "https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/catalog/xeno-catalog.json"
#define DEFAULT_REVISION_URL "https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/catalog/revision.json"
#define DEFAULT_UPDATES_FEED "https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/updates/payloads.json"

/* ---- defaults ----------------------------------------------------------- */

static void set_source(settings_t *s, const char *id, int enabled) {
  for (int i = 0; i < s->n_sources; i++)
    if (strcmp(s->sources[i].id, id) == 0) { s->sources[i].enabled = enabled; return; }
  if (s->n_sources < SET_MAX_SOURCES) {
    xstrlcpy(s->sources[s->n_sources].id, id, sizeof s->sources[0].id);
    s->sources[s->n_sources].enabled = enabled;
    s->n_sources++;
  }
}

static void settings_defaults(settings_t *s) {
  memset(s, 0, sizeof *s);
  xstrlcpy(s->language, "auto", sizeof s->language);
  xstrlcpy(s->theme, "xeno-gold", sizeof s->theme);
  xstrlcpy(s->cardSize, "m", sizeof s->cardSize);
  s->reduceMotion = 0; s->sounds = 1; s->hints = 1; s->showPs4 = 1; s->adultFilter = 0;
  xstrlcpy(s->defaultRoot, "/data", sizeof s->defaultRoot);
  s->connections = 8; s->concurrentJobs = 1; s->maxBytesPerSec = 0;
  s->verifyHashes = 1; s->autoInstallPkg = 1; s->shadowMountScan = 1; s->keepAwake = 1;
  s->retryMax = 8; s->allowInsecureTls = 0;
  set_source(s, "archive", 1); set_source(s, "vikingfile", 1); set_source(s, "dlpsgame", 1); set_source(s, "other", 1);
  s->sourcesAcknowledged = 0;
  s->catalogAutoRefresh = 1;
  xstrlcpy(s->catalogUrl, DEFAULT_CATALOG_URL, sizeof s->catalogUrl);
  xstrlcpy(s->catalogRevisionUrl, DEFAULT_REVISION_URL, sizeof s->catalogRevisionUrl);
  s->toasts = 1; s->onComplete = 1; s->onFail = 1; s->onInstall = 1;
  s->updatesAutoCheck = 1;
  xstrlcpy(s->updatesFeed, DEFAULT_UPDATES_FEED, sizeof s->updatesFeed);
}

/* ---- JSON (de)serialization --------------------------------------------- */

static void write_settings(jw *w, const settings_t *s) {
  jw_obj_begin(w);
  jw_kv_int(w, "v", 1);
  jw_key(w, "general"); jw_obj_begin(w);
  jw_kv_str(w, "language", s->language); jw_kv_str(w, "theme", s->theme); jw_kv_str(w, "cardSize", s->cardSize);
  jw_kv_bool(w, "reduceMotion", s->reduceMotion); jw_kv_bool(w, "sounds", s->sounds); jw_kv_bool(w, "hints", s->hints);
  jw_kv_bool(w, "showPs4", s->showPs4); jw_kv_bool(w, "adultFilter", s->adultFilter);
  jw_obj_end(w);
  jw_key(w, "downloads"); jw_obj_begin(w);
  jw_kv_str(w, "defaultRoot", s->defaultRoot); jw_kv_int(w, "connections", s->connections);
  jw_kv_int(w, "concurrentJobs", s->concurrentJobs); jw_kv_i64(w, "maxBytesPerSec", s->maxBytesPerSec);
  jw_kv_bool(w, "verifyHashes", s->verifyHashes); jw_kv_bool(w, "autoInstallPkg", s->autoInstallPkg);
  jw_kv_bool(w, "shadowMountScan", s->shadowMountScan); jw_kv_bool(w, "keepAwake", s->keepAwake);
  jw_kv_int(w, "retryMax", s->retryMax); jw_kv_bool(w, "allowInsecureTls", s->allowInsecureTls);
  jw_kv_str(w, "scheduleStart", s->scheduleStart); jw_kv_str(w, "scheduleEnd", s->scheduleEnd);
  jw_obj_end(w);
  jw_key(w, "sources"); jw_obj_begin(w);
  jw_key(w, "enabled"); jw_obj_begin(w);
  for (int i = 0; i < s->n_sources; i++) jw_kv_bool(w, s->sources[i].id, s->sources[i].enabled);
  jw_obj_end(w);
  jw_kv_bool(w, "acknowledged", s->sourcesAcknowledged);
  jw_obj_end(w);
  jw_key(w, "catalog"); jw_obj_begin(w);
  jw_kv_bool(w, "autoRefresh", s->catalogAutoRefresh); jw_kv_str(w, "url", s->catalogUrl);
  jw_kv_str(w, "revisionUrl", s->catalogRevisionUrl); jw_kv_i64(w, "lastCheck", (int64_t)s->catalogLastCheck);
  jw_obj_end(w);
  jw_key(w, "notifications"); jw_obj_begin(w);
  jw_kv_bool(w, "toasts", s->toasts); jw_kv_bool(w, "onComplete", s->onComplete);
  jw_kv_bool(w, "onFail", s->onFail); jw_kv_bool(w, "onInstall", s->onInstall);
  jw_obj_end(w);
  jw_key(w, "updates"); jw_obj_begin(w);
  jw_kv_bool(w, "autoCheck", s->updatesAutoCheck); jw_kv_str(w, "feed", s->updatesFeed);
  jw_kv_i64(w, "lastCheck", (int64_t)s->updatesLastCheck);
  jw_obj_end(w);
  jw_key(w, "pairing"); jw_obj_begin(w);
  jw_kv_str(w, "pin", s->pin);
  jw_obj_end(w);
  jw_obj_end(w);
}

static void merge_str(jv o, const char *k, char *dst, size_t cap) {
  jv v = jv_get(o, k);
  if (jv_type(v) == JV_STR) xstrlcpy(dst, jv_str(v, ""), cap);
}

static void merge_bool(jv o, const char *k, int *dst) {
  jv v = jv_get(o, k);
  if (jv_type(v) == JV_BOOL || jv_type(v) == JV_NUM) *dst = jv_bool(v, *dst);
}

static void merge_int(jv o, const char *k, int *dst, int lo, int hi) {
  jv v = jv_get(o, k);
  if (jv_type(v) != JV_NUM && jv_type(v) != JV_STR) return;
  int64_t x = jv_i64(v, *dst);
  if (x < lo) x = lo;
  if (x > hi) x = hi;
  *dst = (int)x;
}

static int valid_hhmm(const char *s) {
  if (!*s) return 1;
  if (strlen(s) != 5 || s[2] != ':') return 0;
  int h = atoi(s), m = atoi(s + 3);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

static int validate(settings_t *s, char *err, size_t errcap) {
  static const char *const themes[] = {"xeno-gold", "midnight", "oled", "crimson", "emerald", "royal", "ice"};
  int ok = 0;
  for (size_t i = 0; i < XS_ARRAY_LEN(themes); i++) if (strcmp(s->theme, themes[i]) == 0) ok = 1;
  if (!ok) { xsnprintf(err, errcap, "unknown theme"); return -1; }
  if (strcmp(s->cardSize, "s") && strcmp(s->cardSize, "m") && strcmp(s->cardSize, "l")) { xsnprintf(err, errcap, "cardSize must be s|m|l"); return -1; }
  if (!valid_hhmm(s->scheduleStart) || !valid_hhmm(s->scheduleEnd)) { xsnprintf(err, errcap, "schedule times must be HH:MM"); return -1; }
  if (s->pin[0]) {
    if (strlen(s->pin) != 4) { xsnprintf(err, errcap, "pin must be 4 digits"); return -1; }
    for (int i = 0; i < 4; i++) if (s->pin[i] < '0' || s->pin[i] > '9') { xsnprintf(err, errcap, "pin must be 4 digits"); return -1; }
  }
  if (s->catalogUrl[0] && !util_istarts_with(s->catalogUrl, "http")) { xsnprintf(err, errcap, "catalog url must be http(s)"); return -1; }
  if (s->defaultRoot[0] != '/' && s->defaultRoot[0] != '.') { xsnprintf(err, errcap, "defaultRoot must be a path"); return -1; }
  if (s->maxBytesPerSec < 0) s->maxBytesPerSec = 0;
  return 0;
}

static int merge_into(settings_t *s, jv o, char *err, size_t errcap) {
  jv g = jv_get(o, "general");
  if (jv_ok(g)) {
    merge_str(g, "language", s->language, sizeof s->language);
    merge_str(g, "theme", s->theme, sizeof s->theme);
    merge_str(g, "cardSize", s->cardSize, sizeof s->cardSize);
    merge_bool(g, "reduceMotion", &s->reduceMotion); merge_bool(g, "sounds", &s->sounds);
    merge_bool(g, "hints", &s->hints); merge_bool(g, "showPs4", &s->showPs4); merge_bool(g, "adultFilter", &s->adultFilter);
  }
  jv d = jv_get(o, "downloads");
  if (jv_ok(d)) {
    merge_str(d, "defaultRoot", s->defaultRoot, sizeof s->defaultRoot);
    merge_int(d, "connections", &s->connections, 1, 16);
    merge_int(d, "concurrentJobs", &s->concurrentJobs, 1, 4);
    jv m = jv_get(d, "maxBytesPerSec");
    if (jv_type(m) == JV_NUM) { int64_t x = jv_i64(m, 0); s->maxBytesPerSec = x < 0 ? 0 : x; }
    merge_bool(d, "verifyHashes", &s->verifyHashes); merge_bool(d, "autoInstallPkg", &s->autoInstallPkg);
    merge_bool(d, "shadowMountScan", &s->shadowMountScan); merge_bool(d, "keepAwake", &s->keepAwake);
    merge_int(d, "retryMax", &s->retryMax, 0, 50);
    merge_bool(d, "allowInsecureTls", &s->allowInsecureTls);
    merge_str(d, "scheduleStart", s->scheduleStart, sizeof s->scheduleStart);
    merge_str(d, "scheduleEnd", s->scheduleEnd, sizeof s->scheduleEnd);
  }
  jv src = jv_get(o, "sources");
  if (jv_ok(src)) {
    jv en = jv_get(src, "enabled");
    JV_FOREACH(it, en) {
      const char *k = jv_key(it);
      if (k && *k && strlen(k) < 32) set_source(s, k, jv_bool(it, 1));
    }
    merge_bool(src, "acknowledged", &s->sourcesAcknowledged);
  }
  jv c = jv_get(o, "catalog");
  if (jv_ok(c)) {
    merge_bool(c, "autoRefresh", &s->catalogAutoRefresh);
    merge_str(c, "url", s->catalogUrl, sizeof s->catalogUrl);
    merge_str(c, "revisionUrl", s->catalogRevisionUrl, sizeof s->catalogRevisionUrl);
    jv lc = jv_get(c, "lastCheck");
    if (jv_type(lc) == JV_NUM) s->catalogLastCheck = (time_t)jv_i64(lc, 0);
    if (!s->catalogUrl[0]) xstrlcpy(s->catalogUrl, DEFAULT_CATALOG_URL, sizeof s->catalogUrl);
    if (!s->catalogRevisionUrl[0]) xstrlcpy(s->catalogRevisionUrl, DEFAULT_REVISION_URL, sizeof s->catalogRevisionUrl);
  }
  jv n = jv_get(o, "notifications");
  if (jv_ok(n)) {
    merge_bool(n, "toasts", &s->toasts); merge_bool(n, "onComplete", &s->onComplete);
    merge_bool(n, "onFail", &s->onFail); merge_bool(n, "onInstall", &s->onInstall);
  }
  jv u = jv_get(o, "updates");
  if (jv_ok(u)) {
    merge_bool(u, "autoCheck", &s->updatesAutoCheck);
    merge_str(u, "feed", s->updatesFeed, sizeof s->updatesFeed);
    jv lc = jv_get(u, "lastCheck");
    if (jv_type(lc) == JV_NUM) s->updatesLastCheck = (time_t)jv_i64(lc, 0);
    if (!s->updatesFeed[0]) xstrlcpy(s->updatesFeed, DEFAULT_UPDATES_FEED, sizeof s->updatesFeed);
  }
  jv p = jv_get(o, "pairing");
  if (jv_ok(p)) merge_str(p, "pin", s->pin, sizeof s->pin);
  return validate(s, err, errcap);
}

/* ---- persistence -------------------------------------------------------- */

static int save_json(const char *name, jw *w) {
  char path[600];
  xsnprintf(path, sizeof path, "%s/%s", data_dir, name);
  size_t len;
  char *txt = jw_detach(w, &len);
  if (!txt) return -1;
  int rc = util_write_file_atomic(path, txt, len);
  free(txt);
  if (rc != 0) LOGW("settings: cannot write %s", path);
  return rc;
}

static jdoc *load_json(const char *name) {
  char path[600];
  xsnprintf(path, sizeof path, "%s/%s", data_dir, name);
  size_t len;
  char *txt = util_read_file(path, &len, 8u << 20);
  if (!txt) return NULL;
  jdoc *d = json_parse(txt, len, 50000, 16);
  free(txt);
  if (!d) LOGW("settings: %s is not valid JSON, using defaults", name);
  return d;
}

static void save_settings_locked(void) {
  jw w;
  jw_init(&w);
  write_settings(&w, &S);
  save_json("settings.json", &w);
}

static void save_favorites_locked(void) {
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_key(&w, "ids"); jw_arr_begin(&w);
  for (int i = 0; i < n_favorites; i++) jw_str(&w, favorites[i]);
  jw_arr_end(&w);
  jw_obj_end(&w);
  save_json("favorites.json", &w);
}

static void write_collections_locked(jw *w) {
  jw_arr_begin(w);
  for (int i = 0; i < n_collections; i++) {
    jw_obj_begin(w);
    jw_kv_str(w, "id", collections[i].id);
    jw_kv_str(w, "name", collections[i].name);
    jw_kv_str(w, "icon", collections[i].icon);
    jw_key(w, "ids"); jw_arr_begin(w);
    for (int j = 0; j < collections[i].n; j++) jw_str(w, collections[i].ids[j]);
    jw_arr_end(w);
    jw_obj_end(w);
  }
  jw_arr_end(w);
}

static void save_collections_locked(void) {
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_key(&w, "collections");
  write_collections_locked(&w);
  jw_obj_end(&w);
  save_json("collections.json", &w);
}

static void save_recent_locked(void) {
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_key(&w, "ids"); jw_arr_begin(&w);
  for (int i = 0; i < n_recent; i++) jw_str(&w, recent[i]);
  jw_arr_end(&w);
  jw_obj_end(&w);
  save_json("recent.json", &w);
}

static int valid_id(const char *id) {
  size_t n = id ? strlen(id) : 0;
  if (n == 0 || n >= SET_ID_LEN) return 0;
  for (size_t i = 0; i < n; i++) if ((unsigned char)id[i] < 0x20) return 0;
  return 1;
}

static int load_favorites_locked(jv ids) {
  n_favorites = 0;
  JV_FOREACH(it, ids) {
    const char *id = jv_str(it, NULL);
    if (!valid_id(id) || n_favorites >= SET_MAX_FAVORITES) continue;
    int dup = 0;
    for (int i = 0; i < n_favorites; i++) if (strcmp(favorites[i], id) == 0) { dup = 1; break; }
    if (dup) continue;
    xstrlcpy(favorites[n_favorites++], id, SET_ID_LEN);
  }
  return 0;
}

static void free_collections_locked(void) {
  for (int i = 0; i < n_collections; i++) free(collections[i].ids);
  memset(collections, 0, sizeof collections);
  n_collections = 0;
}

static void default_collections_locked(void) {
  free_collections_locked();
  collection_t *c = &collections[0];
  xstrlcpy(c->id, "wishlist", sizeof c->id);
  xstrlcpy(c->name, "Wishlist", sizeof c->name);
  xstrlcpy(c->icon, "star", sizeof c->icon);
  c->ids = calloc(SET_MAX_COLLECTION_IDS, SET_ID_LEN);
  c->n = 0;
  n_collections = c->ids ? 1 : 0;
}

static int load_collections_locked(jv list, char *err, size_t errcap) {
  if (jv_type(list) != JV_ARR) { xsnprintf(err, errcap, "collections must be an array"); return -1; }
  if (jv_len(list) > SET_MAX_COLLECTIONS) { xsnprintf(err, errcap, "too many collections (max %d)", SET_MAX_COLLECTIONS); return -1; }
  free_collections_locked();
  JV_FOREACH(it, list) {
    const char *id = jv_get_str(it, "id", NULL);
    const char *name = jv_get_str(it, "name", "");
    if (!id || !*id || strlen(id) >= 64) continue;
    collection_t *c = &collections[n_collections];
    xstrlcpy(c->id, id, sizeof c->id);
    xstrlcpy(c->name, *name ? name : id, sizeof c->name);
    xstrlcpy(c->icon, jv_get_str(it, "icon", "folder"), sizeof c->icon);
    c->ids = calloc(SET_MAX_COLLECTION_IDS, SET_ID_LEN);
    if (!c->ids) break;
    c->n = 0;
    JV_FOREACH(g, jv_get(it, "ids")) {
      const char *gid = jv_str(g, NULL);
      if (valid_id(gid) && c->n < SET_MAX_COLLECTION_IDS) xstrlcpy(c->ids[c->n++], gid, SET_ID_LEN);
    }
    n_collections++;
  }
  return 0;
}

static void load_recent_locked(jv ids) {
  n_recent = 0;
  JV_FOREACH(it, ids) {
    const char *id = jv_str(it, NULL);
    if (valid_id(id) && n_recent < SET_RECENT_KEEP) xstrlcpy(recent[n_recent++], id, SET_ID_LEN);
  }
}

void settings_init(const char *dir) {
  char err[128];
  pthread_mutex_lock(&settings_mu);
  xstrlcpy(data_dir, dir, sizeof data_dir);
  settings_defaults(&S);
  if (!favorites) favorites = calloc(SET_MAX_FAVORITES, SET_ID_LEN);
  jdoc *d = load_json("settings.json");
  if (d) {
    settings_t tmp = S;
    if (merge_into(&tmp, json_root(d), err, sizeof err) == 0) S = tmp;
    else LOGW("settings.json rejected (%s), using defaults", err);
    json_free(d);
  } else {
    save_settings_locked();
  }
  d = load_json("favorites.json");
  if (d) { load_favorites_locked(jv_get(json_root(d), "ids")); json_free(d); }
  d = load_json("collections.json");
  if (!d || load_collections_locked(jv_get(json_root(d), "collections"), err, sizeof err) != 0 || n_collections == 0)
    default_collections_locked();
  if (d) json_free(d);
  d = load_json("recent.json");
  if (d) { load_recent_locked(jv_get(json_root(d), "ids")); json_free(d); }
  pthread_mutex_unlock(&settings_mu);
  LOGI("settings loaded (theme=%s, root=%s, connections=%d, favorites=%d)", S.theme, S.defaultRoot, S.connections, n_favorites);
}

void settings_get(settings_t *out) {
  pthread_mutex_lock(&settings_mu);
  *out = S;
  pthread_mutex_unlock(&settings_mu);
}

int settings_merge(jv obj, char *err, size_t errcap) {
  if (jv_type(obj) != JV_OBJ) { xsnprintf(err, errcap, "settings must be an object"); return -1; }
  pthread_mutex_lock(&settings_mu);
  settings_t tmp = S;
  int rc = merge_into(&tmp, obj, err, errcap);
  if (rc == 0) { S = tmp; save_settings_locked(); }
  pthread_mutex_unlock(&settings_mu);
  return rc;
}

void settings_write_json(jw *w) {
  pthread_mutex_lock(&settings_mu);
  write_settings(w, &S);
  pthread_mutex_unlock(&settings_mu);
}

int settings_source_enabled(const char *source_id) {
  int en = 1;
  pthread_mutex_lock(&settings_mu);
  for (int i = 0; i < S.n_sources; i++)
    if (strcmp(S.sources[i].id, source_id) == 0) { en = S.sources[i].enabled; break; }
  pthread_mutex_unlock(&settings_mu);
  return en;
}

void settings_touch_catalog_check(void) {
  pthread_mutex_lock(&settings_mu);
  S.catalogLastCheck = util_now();
  save_settings_locked();
  pthread_mutex_unlock(&settings_mu);
}

void settings_touch_updates_check(void) {
  pthread_mutex_lock(&settings_mu);
  S.updatesLastCheck = util_now();
  save_settings_locked();
  pthread_mutex_unlock(&settings_mu);
}

/* ---- favorites ---------------------------------------------------------- */

void settings_favorites_json(jw *w) {
  pthread_mutex_lock(&settings_mu);
  jw_key(w, "ids"); jw_arr_begin(w);
  for (int i = 0; i < n_favorites; i++) jw_str(w, favorites[i]);
  jw_arr_end(w);
  pthread_mutex_unlock(&settings_mu);
}

int settings_favorites_set(jv ids) {
  if (jv_type(ids) != JV_ARR) return -1;
  pthread_mutex_lock(&settings_mu);
  load_favorites_locked(ids);
  save_favorites_locked();
  pthread_mutex_unlock(&settings_mu);
  return 0;
}

int settings_favorite_toggle(const char *id) {
  if (!valid_id(id)) return -1;
  int state;
  pthread_mutex_lock(&settings_mu);
  int idx = -1;
  for (int i = 0; i < n_favorites; i++) if (strcmp(favorites[i], id) == 0) { idx = i; break; }
  if (idx >= 0) {
    memmove(favorites[idx], favorites[idx + 1], (size_t)(n_favorites - idx - 1) * SET_ID_LEN);
    n_favorites--;
    state = 0;
  } else {
    if (n_favorites >= SET_MAX_FAVORITES) { pthread_mutex_unlock(&settings_mu); return -1; }
    xstrlcpy(favorites[n_favorites++], id, SET_ID_LEN);
    state = 1;
  }
  save_favorites_locked();
  pthread_mutex_unlock(&settings_mu);
  return state;
}

int settings_is_favorite(const char *id) {
  int r = 0;
  pthread_mutex_lock(&settings_mu);
  for (int i = 0; i < n_favorites; i++) if (strcmp(favorites[i], id) == 0) { r = 1; break; }
  pthread_mutex_unlock(&settings_mu);
  return r;
}

int settings_favorites_list(char (*out)[SET_ID_LEN], int max) {
  pthread_mutex_lock(&settings_mu);
  int n = n_favorites < max ? n_favorites : max;
  for (int i = 0; i < n; i++) xstrlcpy(out[i], favorites[i], SET_ID_LEN);
  pthread_mutex_unlock(&settings_mu);
  return n;
}

/* ---- collections -------------------------------------------------------- */

void settings_collections_json(jw *w) {
  pthread_mutex_lock(&settings_mu);
  jw_key(w, "collections");
  write_collections_locked(w);
  pthread_mutex_unlock(&settings_mu);
}

int settings_collections_set(jv list, char *err, size_t errcap) {
  pthread_mutex_lock(&settings_mu);
  int rc = load_collections_locked(list, err, errcap);
  if (rc == 0) save_collections_locked();
  pthread_mutex_unlock(&settings_mu);
  return rc;
}

/* ---- recent ------------------------------------------------------------- */

void settings_recent_json(jw *w) {
  pthread_mutex_lock(&settings_mu);
  jw_key(w, "ids"); jw_arr_begin(w);
  for (int i = 0; i < n_recent; i++) jw_str(w, recent[i]);
  jw_arr_end(w);
  pthread_mutex_unlock(&settings_mu);
}

void settings_recent_add(const char *id) {
  if (!valid_id(id)) return;
  pthread_mutex_lock(&settings_mu);
  int idx = -1;
  for (int i = 0; i < n_recent; i++) if (strcmp(recent[i], id) == 0) { idx = i; break; }
  if (idx >= 0) { memmove(recent[idx], recent[idx + 1], (size_t)(n_recent - idx - 1) * SET_ID_LEN); n_recent--; }
  if (n_recent == SET_RECENT_KEEP) n_recent--;   /* drop the oldest (last) */
  memmove(recent[1], recent[0], (size_t)n_recent * SET_ID_LEN);
  xstrlcpy(recent[0], id, SET_ID_LEN);
  n_recent++;
  save_recent_locked();
  pthread_mutex_unlock(&settings_mu);
}

/* ---- export / import ---------------------------------------------------- */

void settings_export_json(jw *w) {
  pthread_mutex_lock(&settings_mu);
  jw_kv_int(w, "v", 1);
  jw_kv_i64(w, "exportedAt", (int64_t)util_now());
  jw_key(w, "settings"); write_settings(w, &S);
  jw_key(w, "favorites"); jw_arr_begin(w);
  for (int i = 0; i < n_favorites; i++) jw_str(w, favorites[i]);
  jw_arr_end(w);
  jw_key(w, "collections"); write_collections_locked(w);
  jw_key(w, "recent"); jw_arr_begin(w);
  for (int i = 0; i < n_recent; i++) jw_str(w, recent[i]);
  jw_arr_end(w);
  pthread_mutex_unlock(&settings_mu);
}

int settings_import_json(jv obj, char *err, size_t errcap) {
  if (jv_type(obj) != JV_OBJ) { xsnprintf(err, errcap, "import must be an object"); return -1; }
  pthread_mutex_lock(&settings_mu);
  jv s = jv_get(obj, "settings");
  if (jv_ok(s)) {
    settings_t tmp = S;
    if (merge_into(&tmp, s, err, errcap) != 0) { pthread_mutex_unlock(&settings_mu); return -1; }
    S = tmp;
    save_settings_locked();
  }
  jv f = jv_get(obj, "favorites");
  if (jv_type(f) == JV_ARR) { load_favorites_locked(f); save_favorites_locked(); }
  jv c = jv_get(obj, "collections");
  if (jv_type(c) == JV_ARR) {
    if (load_collections_locked(c, err, errcap) != 0) { default_collections_locked(); pthread_mutex_unlock(&settings_mu); return -1; }
    if (n_collections == 0) default_collections_locked();
    save_collections_locked();
  }
  jv r = jv_get(obj, "recent");
  if (jv_type(r) == JV_ARR) { load_recent_locked(r); save_recent_locked(); }
  pthread_mutex_unlock(&settings_mu);
  return 0;
}
