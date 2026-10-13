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
#define DEFAULT_UPDATES_BASE "https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/updates/"
#define DEFAULT_FEATURED_URL DEFAULT_UPDATES_BASE "featured.json"
#define DEFAULT_MESSAGES_URL DEFAULT_UPDATES_BASE "messages.json"
#define DEFAULT_COMPANIONS_URL DEFAULT_UPDATES_BASE "companions.json"
#define DEFAULT_SAVES_BACKEND_URL DEFAULT_UPDATES_BASE "saves-backend.json"
#define DEFAULT_INSTALL_ORDER "game,backport,update,dlc"

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
  /* Phase 2 */
  s->largeText = 0; s->highContrast = 0; s->safeMode = 0; s->screensaver = 1;
  s->screensaverMinutes = 3; s->controllerSwapConfirm = 0; s->mdns = 1;
  xstrlcpy(s->preferFormat, "auto", sizeof s->preferFormat);
  s->turboStart = 1; s->autoInstallSets = 1;
  xstrlcpy(s->installOrder, DEFAULT_INSTALL_ORDER, sizeof s->installOrder);
  s->restModeAutoResume = 1; s->extractZip = 1; s->deleteArchiveAfterExtract = 1;
  xstrlcpy(s->debrid.preferred, "auto", sizeof s->debrid.preferred);
  xstrlcpy(s->featuredUrl, DEFAULT_FEATURED_URL, sizeof s->featuredUrl);
  xstrlcpy(s->messagesUrl, DEFAULT_MESSAGES_URL, sizeof s->messagesUrl);
  xstrlcpy(s->companionsUrl, DEFAULT_COMPANIONS_URL, sizeof s->companionsUrl);
  xstrlcpy(s->savesBackendUrl, DEFAULT_SAVES_BACKEND_URL, sizeof s->savesBackendUrl);
  s->saves.autoBackup = 1;
  xstrlcpy(s->saves.backend.kind, "github", sizeof s->saves.backend.kind);
  xstrlcpy(s->saves.backend.bucket, "ps5-saves", sizeof s->saves.backend.bucket);
  xstrlcpy(s->saves.backend.garlicFunction, "garlic-savedb", sizeof s->saves.backend.garlicFunction);
  xstrlcpy(s->saves.uploadHost, "pixeldrain", sizeof s->saves.uploadHost);
}

void settings_saves_root(const settings_t *s, char *out, size_t cap) {
  xstrlcpy(out, s->saves.backupRoot[0] ? s->saves.backupRoot : s->defaultRoot, cap);
}

/* ---- JSON (de)serialization --------------------------------------------- */

static void write_settings(jw *w, const settings_t *s) {
  jw_obj_begin(w);
  jw_kv_int(w, "v", 1);
  jw_key(w, "general"); jw_obj_begin(w);
  jw_kv_str(w, "language", s->language); jw_kv_str(w, "theme", s->theme); jw_kv_str(w, "cardSize", s->cardSize);
  jw_kv_bool(w, "reduceMotion", s->reduceMotion); jw_kv_bool(w, "sounds", s->sounds); jw_kv_bool(w, "hints", s->hints);
  jw_kv_bool(w, "showPs4", s->showPs4); jw_kv_bool(w, "adultFilter", s->adultFilter);
  jw_kv_bool(w, "largeText", s->largeText); jw_kv_bool(w, "highContrast", s->highContrast);
  jw_kv_bool(w, "safeMode", s->safeMode); jw_kv_bool(w, "screensaver", s->screensaver);
  jw_kv_int(w, "screensaverMinutes", s->screensaverMinutes);
  jw_kv_bool(w, "controllerSwapConfirm", s->controllerSwapConfirm); jw_kv_bool(w, "mdns", s->mdns);
  jw_obj_end(w);
  jw_key(w, "downloads"); jw_obj_begin(w);
  jw_kv_str(w, "defaultRoot", s->defaultRoot); jw_kv_int(w, "connections", s->connections);
  jw_kv_int(w, "concurrentJobs", s->concurrentJobs); jw_kv_i64(w, "maxBytesPerSec", s->maxBytesPerSec);
  jw_kv_bool(w, "verifyHashes", s->verifyHashes); jw_kv_bool(w, "autoInstallPkg", s->autoInstallPkg);
  jw_kv_bool(w, "shadowMountScan", s->shadowMountScan); jw_kv_bool(w, "keepAwake", s->keepAwake);
  jw_kv_int(w, "retryMax", s->retryMax); jw_kv_bool(w, "allowInsecureTls", s->allowInsecureTls);
  jw_kv_str(w, "scheduleStart", s->scheduleStart); jw_kv_str(w, "scheduleEnd", s->scheduleEnd);
  jw_kv_str(w, "preferFormat", s->preferFormat); jw_kv_bool(w, "turboStart", s->turboStart);
  jw_kv_bool(w, "autoInstallSets", s->autoInstallSets); jw_kv_str(w, "installOrder", s->installOrder);
  jw_kv_bool(w, "restModeAutoResume", s->restModeAutoResume); jw_kv_bool(w, "extractZip", s->extractZip);
  jw_kv_bool(w, "deleteArchiveAfterExtract", s->deleteArchiveAfterExtract);
  jw_obj_end(w);
  jw_key(w, "debrid"); jw_obj_begin(w);
  jw_key(w, "realdebrid"); jw_obj_begin(w); jw_kv_str(w, "apiKey", s->debrid.realdebrid.apiKey); jw_obj_end(w);
  jw_key(w, "alldebrid"); jw_obj_begin(w); jw_kv_str(w, "apiKey", s->debrid.alldebrid.apiKey); jw_obj_end(w);
  jw_key(w, "torbox"); jw_obj_begin(w); jw_kv_str(w, "apiKey", s->debrid.torbox.apiKey); jw_obj_end(w);
  jw_key(w, "premiumize"); jw_obj_begin(w); jw_kv_str(w, "apiKey", s->debrid.premiumize.apiKey); jw_obj_end(w);
  jw_kv_str(w, "preferred", s->debrid.preferred);
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
  jw_kv_str(w, "featuredUrl", s->featuredUrl); jw_kv_str(w, "messagesUrl", s->messagesUrl);
  jw_kv_str(w, "companionsUrl", s->companionsUrl); jw_kv_str(w, "savesBackendUrl", s->savesBackendUrl);
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
  jw_key(w, "saves"); jw_obj_begin(w);
  jw_kv_str(w, "backupRoot", s->saves.backupRoot); jw_kv_bool(w, "autoBackup", s->saves.autoBackup);
  jw_key(w, "indexUrls"); jw_arr_begin(w);
  for (int i = 0; i < s->saves.n_indexUrls; i++) jw_str(w, s->saves.indexUrls[i]);
  jw_arr_end(w);
  jw_key(w, "backend"); jw_obj_begin(w);
  jw_kv_str(w, "kind", s->saves.backend.kind); jw_kv_str(w, "url", s->saves.backend.url);
  jw_kv_str(w, "anonKey", s->saves.backend.anonKey); jw_kv_str(w, "bucket", s->saves.backend.bucket);
  jw_kv_str(w, "garlicFunction", s->saves.backend.garlicFunction);
  jw_obj_end(w);
  jw_kv_str(w, "uploadHost", s->saves.uploadHost); jw_kv_str(w, "uploadEndpoint", s->saves.uploadEndpoint);
  jw_kv_str(w, "submitEndpoint", s->saves.submitEndpoint); jw_kv_str(w, "nickname", s->saves.nickname);
  jw_obj_end(w);
  jw_key(w, "browse"); jw_obj_begin(w);
  jw_key(w, "presets"); jw_arr_begin(w);
  for (int i = 0; i < s->browse.n_presets; i++) {
    jw_obj_begin(w);
    jw_kv_str(w, "name", s->browse.presets[i].name);
    if (s->browse.presets[i].filters[0]) jw_kv_raw(w, "filters", s->browse.presets[i].filters, strlen(s->browse.presets[i].filters));
    else { jw_key(w, "filters"); jw_obj_begin(w); jw_obj_end(w); }
    jw_kv_str(w, "sort", s->browse.presets[i].sort);
    jw_obj_end(w);
  }
  jw_arr_end(w);
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

static const char *const PREFER_FORMATS[] = {"auto", "exFAT", "FFPFSC", "PKG"};
static const char *const DEBRID_CHOICES[] = {"auto", "direct", "realdebrid", "alldebrid", "torbox", "premiumize"};
static const char *const BACKEND_KINDS[] = {"supabase", "github", "none"};
static const char *const UPLOAD_HOSTS[] = {"pixeldrain", "catbox", "custom"};

/* Case-insensitive match against a choice list; rewrites the canonical
 * spelling. "" picks the first entry (the default). */
static int normalize_choice(char *val, size_t cap, const char *const *choices, size_t n) {
  if (!val[0]) { xstrlcpy(val, choices[0], cap); return 0; }
  for (size_t i = 0; i < n; i++)
    if (util_strieq(val, choices[i])) { xstrlcpy(val, choices[i], cap); return 0; }
  return -1;
}

/* installOrder: comma list of the four kinds; missing kinds are appended in
 * the default order so every kind always has a position. */
static int normalize_install_order(char *val, size_t cap) {
  static const char *const kinds[] = {"game", "backport", "update", "dlc"};
  int seen[4] = {0, 0, 0, 0};
  char tmp[64], out[64] = "";
  xstrlcpy(tmp, val, sizeof tmp);
  for (char *tok = strtok(tmp, ", "); tok; tok = strtok(NULL, ", ")) {
    util_trim(tok);
    util_lower(tok);
    int k = -1;
    for (int i = 0; i < 4; i++) if (strcmp(tok, kinds[i]) == 0) k = i;
    if (k < 0) return -1;
    if (seen[k]) continue;
    seen[k] = 1;
    if (out[0]) xstrlcat(out, ",", sizeof out);
    xstrlcat(out, kinds[k], sizeof out);
  }
  for (int i = 0; i < 4; i++) if (!seen[i]) { if (out[0]) xstrlcat(out, ",", sizeof out); xstrlcat(out, kinds[i], sizeof out); }
  xstrlcpy(val, out, cap);
  return 0;
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
  /* Phase 2 */
  if (s->screensaverMinutes < 1) s->screensaverMinutes = 1;
  if (s->screensaverMinutes > 30) s->screensaverMinutes = 30;
  if (normalize_choice(s->preferFormat, sizeof s->preferFormat, PREFER_FORMATS, XS_ARRAY_LEN(PREFER_FORMATS)) != 0) {
    xsnprintf(err, errcap, "preferFormat must be auto|exFAT|FFPFSC|PKG"); return -1;
  }
  if (normalize_install_order(s->installOrder, sizeof s->installOrder) != 0) {
    xsnprintf(err, errcap, "installOrder must list game, backport, update, dlc"); return -1;
  }
  if (normalize_choice(s->debrid.preferred, sizeof s->debrid.preferred, DEBRID_CHOICES, XS_ARRAY_LEN(DEBRID_CHOICES)) != 0) {
    xsnprintf(err, errcap, "debrid.preferred must be auto|direct|realdebrid|alldebrid|torbox|premiumize"); return -1;
  }
  if (normalize_choice(s->saves.backend.kind, sizeof s->saves.backend.kind, BACKEND_KINDS, XS_ARRAY_LEN(BACKEND_KINDS)) != 0) {
    xsnprintf(err, errcap, "saves.backend.kind must be supabase|github|none"); return -1;
  }
  if (normalize_choice(s->saves.uploadHost, sizeof s->saves.uploadHost, UPLOAD_HOSTS, XS_ARRAY_LEN(UPLOAD_HOSTS)) != 0) {
    xsnprintf(err, errcap, "saves.uploadHost must be pixeldrain|catbox|custom"); return -1;
  }
  const char *const urls[] = {s->featuredUrl, s->messagesUrl, s->companionsUrl, s->savesBackendUrl, s->catalogRevisionUrl,
                              s->saves.backend.url, s->saves.uploadEndpoint, s->saves.submitEndpoint};
  for (size_t i = 0; i < XS_ARRAY_LEN(urls); i++)
    if (urls[i][0] && !util_istarts_with(urls[i], "http")) { xsnprintf(err, errcap, "urls must be http(s)"); return -1; }
  for (int i = 0; i < s->saves.n_indexUrls; i++)
    if (!util_istarts_with(s->saves.indexUrls[i], "http")) { xsnprintf(err, errcap, "saves.indexUrls must be http(s)"); return -1; }
  if (s->saves.backupRoot[0] && s->saves.backupRoot[0] != '/' && s->saves.backupRoot[0] != '.') { xsnprintf(err, errcap, "saves.backupRoot must be a path"); return -1; }
  for (const unsigned char *p = (const unsigned char *)s->saves.nickname; *p; p++)
    if (*p < 0x20) { xsnprintf(err, errcap, "nickname has control characters"); return -1; }
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
    merge_bool(g, "largeText", &s->largeText); merge_bool(g, "highContrast", &s->highContrast);
    merge_bool(g, "safeMode", &s->safeMode); merge_bool(g, "screensaver", &s->screensaver);
    merge_int(g, "screensaverMinutes", &s->screensaverMinutes, 1, 30);
    merge_bool(g, "controllerSwapConfirm", &s->controllerSwapConfirm); merge_bool(g, "mdns", &s->mdns);
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
    merge_str(d, "preferFormat", s->preferFormat, sizeof s->preferFormat);
    merge_bool(d, "turboStart", &s->turboStart); merge_bool(d, "autoInstallSets", &s->autoInstallSets);
    merge_str(d, "installOrder", s->installOrder, sizeof s->installOrder);
    merge_bool(d, "restModeAutoResume", &s->restModeAutoResume); merge_bool(d, "extractZip", &s->extractZip);
    merge_bool(d, "deleteArchiveAfterExtract", &s->deleteArchiveAfterExtract);
  }
  jv db = jv_get(o, "debrid");
  if (jv_ok(db)) {
    struct { const char *k; char *dst; } svc[] = {{"realdebrid", s->debrid.realdebrid.apiKey}, {"alldebrid", s->debrid.alldebrid.apiKey},
                                                {"torbox", s->debrid.torbox.apiKey}, {"premiumize", s->debrid.premiumize.apiKey}};
    for (size_t i = 0; i < XS_ARRAY_LEN(svc); i++) {
      jv e = jv_get(db, svc[i].k);
      if (jv_type(e) == JV_OBJ) merge_str(e, "apiKey", svc[i].dst, SET_DEBRID_KEY_LEN);
      else if (jv_type(e) == JV_STR) xstrlcpy(svc[i].dst, jv_str(e, ""), SET_DEBRID_KEY_LEN);   /* {"torbox":"key"} shorthand */
      else if (jv_type(e) == JV_NULL) svc[i].dst[0] = 0;
      util_trim(svc[i].dst);
      for (unsigned char *p = (unsigned char *)svc[i].dst; *p; p++) if (*p < 0x21 || *p > 0x7e) { svc[i].dst[0] = 0; break; }
    }
    merge_str(db, "preferred", s->debrid.preferred, sizeof s->debrid.preferred);
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
    merge_str(c, "featuredUrl", s->featuredUrl, sizeof s->featuredUrl);
    merge_str(c, "messagesUrl", s->messagesUrl, sizeof s->messagesUrl);
    merge_str(c, "companionsUrl", s->companionsUrl, sizeof s->companionsUrl);
    merge_str(c, "savesBackendUrl", s->savesBackendUrl, sizeof s->savesBackendUrl);
    if (!s->featuredUrl[0]) xstrlcpy(s->featuredUrl, DEFAULT_FEATURED_URL, sizeof s->featuredUrl);
    if (!s->messagesUrl[0]) xstrlcpy(s->messagesUrl, DEFAULT_MESSAGES_URL, sizeof s->messagesUrl);
    if (!s->companionsUrl[0]) xstrlcpy(s->companionsUrl, DEFAULT_COMPANIONS_URL, sizeof s->companionsUrl);
    if (!s->savesBackendUrl[0]) xstrlcpy(s->savesBackendUrl, DEFAULT_SAVES_BACKEND_URL, sizeof s->savesBackendUrl);
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
  jv sv = jv_get(o, "saves");
  if (jv_ok(sv)) {
    merge_str(sv, "backupRoot", s->saves.backupRoot, sizeof s->saves.backupRoot);
    merge_bool(sv, "autoBackup", &s->saves.autoBackup);
    jv iu = jv_get(sv, "indexUrls");
    if (jv_type(iu) == JV_ARR) {
      s->saves.n_indexUrls = 0;
      JV_FOREACH(it, iu) {
        const char *u = jv_str(it, NULL);
        if (!u || !*u || strlen(u) >= 512 || s->saves.n_indexUrls >= SET_MAX_INDEX_URLS) continue;
        int dup = 0;
        for (int i = 0; i < s->saves.n_indexUrls; i++) if (strcmp(s->saves.indexUrls[i], u) == 0) dup = 1;
        if (!dup) xstrlcpy(s->saves.indexUrls[s->saves.n_indexUrls++], u, 512);
      }
    }
    jv be = jv_get(sv, "backend");
    if (jv_type(be) == JV_OBJ) {
      merge_str(be, "kind", s->saves.backend.kind, sizeof s->saves.backend.kind);
      merge_str(be, "url", s->saves.backend.url, sizeof s->saves.backend.url);
      merge_str(be, "anonKey", s->saves.backend.anonKey, sizeof s->saves.backend.anonKey);
      merge_str(be, "bucket", s->saves.backend.bucket, sizeof s->saves.backend.bucket);
      merge_str(be, "garlicFunction", s->saves.backend.garlicFunction, sizeof s->saves.backend.garlicFunction);
      util_trim(s->saves.backend.url);
      size_t ul = strlen(s->saves.backend.url);
      while (ul > 0 && s->saves.backend.url[ul - 1] == '/') s->saves.backend.url[--ul] = 0;
      util_trim(s->saves.backend.anonKey);
      if (!s->saves.backend.bucket[0]) xstrlcpy(s->saves.backend.bucket, "ps5-saves", sizeof s->saves.backend.bucket);
      if (!s->saves.backend.garlicFunction[0]) xstrlcpy(s->saves.backend.garlicFunction, "garlic-savedb", sizeof s->saves.backend.garlicFunction);
    }
    merge_str(sv, "uploadHost", s->saves.uploadHost, sizeof s->saves.uploadHost);
    merge_str(sv, "uploadEndpoint", s->saves.uploadEndpoint, sizeof s->saves.uploadEndpoint);
    merge_str(sv, "submitEndpoint", s->saves.submitEndpoint, sizeof s->saves.submitEndpoint);
    merge_str(sv, "nickname", s->saves.nickname, sizeof s->saves.nickname);
    util_trim(s->saves.nickname);
  }
  jv br = jv_get(o, "browse");
  if (jv_ok(br)) {
    jv pr = jv_get(br, "presets");
    if (jv_type(pr) == JV_ARR) {
      s->browse.n_presets = 0;
      JV_FOREACH(it, pr) {
        if (jv_type(it) != JV_OBJ || s->browse.n_presets >= SET_MAX_PRESETS) continue;
        const char *name = jv_get_str(it, "name", "");
        if (!*name) continue;
        int dup = 0;
        for (int i = 0; i < s->browse.n_presets; i++) if (strcmp(s->browse.presets[i].name, name) == 0) dup = 1;
        if (dup) continue;
        settings_preset *pp = &s->browse.presets[s->browse.n_presets];
        xstrlcpy(pp->name, name, sizeof pp->name);
        util_trim(pp->name);
        xstrlcpy(pp->sort, jv_get_str(it, "sort", ""), sizeof pp->sort);
        pp->filters[0] = 0;
        jv f = jv_get(it, "filters");
        if (jv_ok(f) && jv_type(f) != JV_NULL) {
          jw fw;
          jw_init(&fw);
          jw_value(&fw, f);
          size_t fl;
          char *ft = jw_detach(&fw, &fl);
          if (ft) {
            if (fl < SET_PRESET_FILTERS_LEN) memcpy(pp->filters, ft, fl + 1);
            else { xsnprintf(err, errcap, "preset filters too large (max %d bytes)", SET_PRESET_FILTERS_LEN - 1); free(ft); return -1; }
            free(ft);
          }
        }
        s->browse.n_presets++;
      }
    }
  }
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
