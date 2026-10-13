/*
 * cx_enrich.c — see cx_enrich.h.
 *
 * Network: GET https://store.steampowered.com/api/storesearch/?term=<title>&cc=us&l=en
 * then https://store.steampowered.com/api/appdetails?appids=<id>&cc=us&l=en.
 * Only store.steampowered.com is contacted (host build: a loopback mock
 * through XENO_STEAM_BASE for the tests). Safe mode skips the network.
 */
#include "cx_enrich.h"
#include "catalog.h"
#include "cx_common.h"
#include "http_client.h"
#include "log.h"
#include "settings.h"
#include "util.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ENRICH_MAX_AGE_S (30 * 24 * 3600)
#define ENRICH_MAX_SHOTS 10

typedef struct base_info {
  char title[256], platform[8], developer[128], publisher[128], hero[512], cover[512], releaseDate[16];
  char about[2048];
  char screenshots[ENRICH_MAX_SHOTS][512];
  int nshots;
  char features[512];     /* JSON array text or "" */
  char languages[512];
  int64_t steamId;
  int metacritic, ageRating;
  int found;
} base_info;

static void visit_game(jv g, void *user) {
  base_info *b = user;
  b->found = 1;
  xstrlcpy(b->title, jv_get_str(g, "title", ""), sizeof b->title);
  xstrlcpy(b->platform, jv_get_str(g, "platform", ""), sizeof b->platform);
  xstrlcpy(b->developer, jv_get_str(g, "developer", ""), sizeof b->developer);
  xstrlcpy(b->publisher, jv_get_str(g, "publisher", ""), sizeof b->publisher);
  xstrlcpy(b->hero, jv_get_str(g, "hero", ""), sizeof b->hero);
  xstrlcpy(b->cover, jv_get_str(g, "cover", ""), sizeof b->cover);
  xstrlcpy(b->releaseDate, jv_get_str(g, "releaseDate", ""), sizeof b->releaseDate);
  xstrlcpy(b->about, jv_get_str(g, "about", jv_get_str(g, "description", "")), sizeof b->about);
  b->steamId = jv_get_i64(g, "steamId", 0);
  b->metacritic = (int)jv_get_i64(g, "metacritic", 0);
  b->ageRating = (int)jv_get_i64(g, "ageRating", 0);
  JV_FOREACH(s, jv_get(g, "screenshots")) {
    const char *u = jv_str(s, NULL);
    if (u && util_istarts_with(u, "http") && b->nshots < ENRICH_MAX_SHOTS) xstrlcpy(b->screenshots[b->nshots++], u, 512);
  }
  jv f = jv_get(g, "features");
  if (jv_type(f) == JV_ARR && jv_len(f)) { jw w; jw_init(&w); jw_value(&w, f); size_t l; char *t = jw_detach(&w, &l); if (t) { xstrlcpy(b->features, t, sizeof b->features); free(t); } }
  jv l = jv_get(g, "languages");
  if (jv_type(l) == JV_ARR && jv_len(l)) { jw w; jw_init(&w); jw_value(&w, l); size_t n; char *t = jw_detach(&w, &n); if (t) { xstrlcpy(b->languages, t, sizeof b->languages); free(t); } }
}

/* Title cleanup for the Steam search: strip ™®, bracketed tags, edition words. */
static void search_term(const char *title, char *out, size_t cap) {
  char tmp[300];
  xstrlcpy(tmp, title, sizeof tmp);
  size_t o = 0;
  int skip = 0;
  for (const char *p = tmp; *p && o + 1 < cap; p++) {
    unsigned char c = (unsigned char)*p;
    if (c == '[' || c == '(') { skip = 1; continue; }
    if (c == ']' || c == ')') { skip = 0; continue; }
    if (skip) continue;
    if (c >= 0x80) { /* drop ™ ® and other symbols, keep latin letters via fold later */ out[o++] = (char)c; continue; }
    if (c == ':' || c == '-' || c == '|') { out[o++] = ' '; continue; }
    out[o++] = (char)c;
  }
  out[o] = 0;
  static const char *const cut[] = {" Deluxe Edition", " Ultimate Edition", " Gold Edition", " Complete Edition", " Definitive Edition",
                                    " Game of the Year Edition", " GOTY", " Remastered", " Director's Cut", " PS5", " PS4", " Edition"};
  for (size_t i = 0; i < XS_ARRAY_LEN(cut); i++) { const char *h = util_strcasestr(out, cut[i]); if (h) *((char *)h) = 0; }
  /* strip ™ / ® (UTF-8 sequences) */
  char *w = out;
  for (char *r = out; *r;) {
    if ((unsigned char)r[0] == 0xE2 && (unsigned char)r[1] == 0x84 && (unsigned char)r[2] == 0xA2) { r += 3; continue; }
    if ((unsigned char)r[0] == 0xC2 && (unsigned char)r[1] == 0xAE) { r += 2; continue; }
    *w++ = *r++;
  }
  *w = 0;
  util_trim(out);
}

static void strip_html(const char *in, char *out, size_t cap) {
  size_t o = 0;
  int tag = 0, space = 0;
  for (const char *p = in; *p && o + 1 < cap; p++) {
    if (*p == '<') { tag = 1; if (util_istarts_with(p, "<br") || util_istarts_with(p, "<p") || util_istarts_with(p, "</p") || util_istarts_with(p, "<li")) { if (o && out[o - 1] != '\n') out[o++] = '\n'; } continue; }
    if (*p == '>') { tag = 0; continue; }
    if (tag) continue;
    if (*p == ' ' || *p == '\t' || *p == '\r') { if (!space && o) out[o++] = ' '; space = 1; continue; }
    space = 0;
    out[o++] = *p;
  }
  out[o] = 0;
  util_html_unescape(out);
  util_trim(out);
}

/* Failed lookups are not retried for a while so an offline console does not
 * stall every game page on a connect timeout. */
#define MISS_TTL_S 600
#define MISS_MAX 64
static pthread_mutex_t miss_mu = PTHREAD_MUTEX_INITIALIZER;
static struct { char id[128]; time_t at; } misses[MISS_MAX];
static int miss_next;

static int recently_missed(const char *id) {
  time_t now = util_now();
  int r = 0;
  pthread_mutex_lock(&miss_mu);
  for (int i = 0; i < MISS_MAX; i++) if (misses[i].id[0] && strcmp(misses[i].id, id) == 0 && now - misses[i].at < MISS_TTL_S) { r = 1; break; }
  pthread_mutex_unlock(&miss_mu);
  return r;
}

static void note_miss(const char *id) {
  pthread_mutex_lock(&miss_mu);
  xstrlcpy(misses[miss_next].id, id, sizeof misses[0].id);
  misses[miss_next].at = util_now();
  miss_next = (miss_next + 1) % MISS_MAX;
  pthread_mutex_unlock(&miss_mu);
}

static const char *steam_base(void) {
  const char *o = cx_base_override("STEAM");
  return *o ? o : "https://store.steampowered.com";
}

static int steam_host_ok(const char *url) {
  char host[256];
  util_url_host(url, host, sizeof host);
  return util_host_matches(host, "store.steampowered.com") || cx_host_is_loopback(host);
}

/* Fetches from Steam and writes the result object (without cached flag). Returns 0 when something was found. */
static int steam_fetch(base_info *b, jw *w) {
  int64_t appid = b->steamId;
  char url[1024];
  cx_http o = {0};
  o.timeout_ms = 10000;
  o.max_bytes = 2u << 20;
  o.headers = "Accept: application/json\r\n";
  if (!appid) {
    char term[300], enc[900];
    search_term(b->title, term, sizeof term);
    if (strlen(term) < 2) return -1;
    cx_url_encode(term, enc, sizeof enc);
    xsnprintf(url, sizeof url, "%s/api/storesearch/?term=%s&cc=us&l=en", steam_base(), enc);
    if (!steam_host_ok(url)) return -1;
    int status = 0;
    size_t len = 0;
    char *txt = cx_fetch(url, &o, &status, &len, NULL);
    if (!txt || status != 200) { LOGD("enrich: storesearch %s -> %d", term, status); free(txt); return -1; }
    jdoc *d = json_parse(txt, len, 20000, 16);
    free(txt);
    if (!d) return -1;
    char want[300];
    util_fold(term, want, sizeof want);
    int64_t best = 0;
    int best_score = -1;
    JV_FOREACH(it, jv_get(json_root(d), "items")) {
      char have[300];
      util_fold(jv_get_str(it, "name", ""), have, sizeof have);
      int score = strcmp(have, want) == 0 ? 100 : util_starts_with(have, want) ? 70 : strstr(have, want) ? 50 : (jv_len(jv_get(json_root(d), "items")) == 1 ? 20 : 0);
      if (score > best_score) { best_score = score; best = jv_get_i64(it, "id", 0); }
    }
    json_free(d);
    if (!best || best_score < 20) return -1;
    appid = best;
  }
  xsnprintf(url, sizeof url, "%s/api/appdetails?appids=%lld&cc=us&l=en", steam_base(), (long long)appid);
  if (!steam_host_ok(url)) return -1;
  int status = 0;
  size_t len = 0;
  char *txt = cx_fetch(url, &o, &status, &len, NULL);
  if (!txt || status != 200) { free(txt); return -1; }
  jdoc *d = json_parse(txt, len, 50000, 16);
  free(txt);
  if (!d) return -1;
  char key[24];
  xsnprintf(key, sizeof key, "%lld", (long long)appid);
  jv app = jv_get(json_root(d), key);
  jv data = jv_get(app, "data");
  if (!jv_get_bool(app, "success", 0) || !jv_ok(data)) { json_free(d); return -1; }
  /* screenshots */
  jw_key(w, "screenshots"); jw_arr_begin(w);
  int n = 0;
  JV_FOREACH(s, jv_get(data, "screenshots")) {
    const char *u = jv_get_str(s, "path_full", "");
    if (util_istarts_with(u, "http") && n < ENRICH_MAX_SHOTS) { jw_str(w, u); n++; }
  }
  for (int i = 0; n == 0 && i < b->nshots; i++) { jw_str(w, b->screenshots[i]); n++; }
  jw_arr_end(w);
  char about[4096];
  strip_html(jv_get_str(data, "about_the_game", jv_get_str(data, "short_description", "")), about, sizeof about);
  jw_kv_str(w, "about", about[0] ? about : b->about);
  char devs[256] = "";
  JV_FOREACH(dv, jv_get(data, "developers")) { const char *s = jv_str(dv, NULL); if (s) { if (devs[0]) xstrlcat(devs, ", ", sizeof devs); xstrlcat(devs, s, sizeof devs); } }
  jw_kv_str(w, "developer", devs[0] ? devs : b->developer);
  char pubs[256] = "";
  JV_FOREACH(pv, jv_get(data, "publishers")) { const char *s = jv_str(pv, NULL); if (s) { if (pubs[0]) xstrlcat(pubs, ", ", sizeof pubs); xstrlcat(pubs, s, sizeof pubs); } }
  jw_kv_str(w, "publisher", pubs[0] ? pubs : b->publisher);
  int64_t mc = jv_get_i64(jv_get(data, "metacritic"), "score", 0);
  if (mc > 0) jw_kv_int(w, "metacritic", (int)mc); else if (b->metacritic > 0) jw_kv_int(w, "metacritic", b->metacritic); else jw_kv_null(w, "metacritic");
  jw_key(w, "features"); jw_arr_begin(w);
  int nf = 0;
  JV_FOREACH(c, jv_get(data, "categories")) { const char *s = jv_get_str(c, "description", ""); if (*s && nf < 24) { jw_str(w, s); nf++; } }
  jw_arr_end(w);
  jw_key(w, "genres"); jw_arr_begin(w);
  JV_FOREACH(gv, jv_get(data, "genres")) { const char *s = jv_get_str(gv, "description", ""); if (*s) jw_str(w, s); }
  jw_arr_end(w);
  /* supported_languages: "English<strong>*</strong>, French, ..." */
  char langs[1024];
  strip_html(jv_get_str(data, "supported_languages", ""), langs, sizeof langs);
  jw_key(w, "languages"); jw_arr_begin(w);
  int nl = 0;
  for (char *tok = strtok(langs, ","); tok && nl < 40; tok = strtok(NULL, ",")) {
    util_trim(tok);
    char *star = strchr(tok, '*');
    if (star) *star = 0;
    char *br = strstr(tok, "languages with full");
    if (br) *br = 0;
    util_trim(tok);
    if (*tok && strlen(tok) < 40) { jw_str(w, tok); nl++; }
  }
  jw_arr_end(w);
  const char *rd = jv_get_str(jv_get(data, "release_date"), "date", "");
  jw_kv_str(w, "releaseDate", rd[0] ? rd : b->releaseDate);
  int64_t age = 0;
  jv ra = jv_get(data, "required_age");
  if (jv_type(ra) == JV_NUM) age = jv_i64(ra, 0); else if (jv_type(ra) == JV_STR) age = util_parse_int(jv_str(ra, "0"), 0);
  if (age > 0) jw_kv_int(w, "ageRating", (int)age); else if (b->ageRating > 0) jw_kv_int(w, "ageRating", b->ageRating); else jw_kv_null(w, "ageRating");
  jw_kv_i64(w, "steamId", appid);
  jw_kv_str(w, "headerImage", jv_get_str(data, "header_image", ""));
  jw_kv_str(w, "website", jv_get_str(data, "website", ""));
  jw_kv_str(w, "source", "steam");
  json_free(d);
  return 0;
}

static void write_catalog_only(base_info *b, jw *w) {
  jw_key(w, "screenshots"); jw_arr_begin(w);
  for (int i = 0; i < b->nshots; i++) jw_str(w, b->screenshots[i]);
  jw_arr_end(w);
  jw_kv_str(w, "about", b->about);
  jw_kv_str(w, "developer", b->developer);
  jw_kv_str(w, "publisher", b->publisher);
  if (b->metacritic > 0) jw_kv_int(w, "metacritic", b->metacritic); else jw_kv_null(w, "metacritic");
  jw_key(w, "features");
  if (b->features[0]) jw_raw(w, b->features, strlen(b->features)); else { jw_arr_begin(w); jw_arr_end(w); }
  jw_key(w, "languages");
  if (b->languages[0]) jw_raw(w, b->languages, strlen(b->languages)); else { jw_arr_begin(w); jw_arr_end(w); }
  jw_kv_str(w, "releaseDate", b->releaseDate);
  if (b->ageRating > 0) jw_kv_int(w, "ageRating", b->ageRating); else jw_kv_null(w, "ageRating");
  if (b->steamId) jw_kv_i64(w, "steamId", b->steamId); else jw_kv_null(w, "steamId");
  jw_kv_str(w, "source", "catalog");
}

int cx_enrich_json(const char *gameId, int refresh, jw *w) {
  if (!cx_id_valid(gameId, 120)) return -1;
  base_info b;
  memset(&b, 0, sizeof b);
  if (catalog_visit_game(gameId, visit_game, &b) != 0) return -1;
  char dir[700], path[900];
  xsnprintf(dir, sizeof dir, "%s/enrich", cx_data_dir());
  xsnprintf(path, sizeof path, "%s/%s.json", dir, gameId);
  settings_t s;
  settings_get(&s);
  time_t mt = util_file_mtime(path);
  int fresh = mt > 0 && util_now() - mt < ENRICH_MAX_AGE_S;
  if (!refresh && fresh) {
    size_t len;
    char *txt = util_read_file(path, &len, 1 << 20);
    if (txt) {
      jdoc *d = json_parse(txt, len, 20000, 16);
      free(txt);
      if (d) {
        jw_kv_bool(w, "cached", 1);
        jw_kv_i64(w, "fetchedAt", (int64_t)mt);
        JV_FOREACH(m, json_root(d)) { jw_key(w, jv_key(m)); jw_value(w, m); }
        json_free(d);
        return 0;
      }
    }
  }
  int online = xhttp_available() && !s.safeMode;
  if (online && !refresh && recently_missed(gameId)) online = 0;
  if (online) {
    jw tmp;
    jw_init(&tmp);
    jw_obj_begin(&tmp);
    if (steam_fetch(&b, &tmp) == 0) {
      jw_obj_end(&tmp);
      size_t len;
      char *txt = jw_detach(&tmp, &len);
      if (txt) {
        util_mkdir_p(dir);
        util_write_file_atomic(path, txt, len);
        jdoc *d = json_parse(txt, len, 20000, 16);
        free(txt);
        if (d) {
          jw_kv_bool(w, "cached", 0);
          jw_kv_i64(w, "fetchedAt", (int64_t)util_now());
          JV_FOREACH(m, json_root(d)) { jw_key(w, jv_key(m)); jw_value(w, m); }
          json_free(d);
          return 0;
        }
      }
    } else { jw_free(&tmp); note_miss(gameId); }
  }
  /* stale cache beats nothing */
  if (mt > 0) {
    size_t len;
    char *txt = util_read_file(path, &len, 1 << 20);
    if (txt) {
      jdoc *d = json_parse(txt, len, 20000, 16);
      free(txt);
      if (d) {
        jw_kv_bool(w, "cached", 1);
        jw_kv_bool(w, "stale", 1);
        jw_kv_i64(w, "fetchedAt", (int64_t)mt);
        JV_FOREACH(m, json_root(d)) { jw_key(w, jv_key(m)); jw_value(w, m); }
        json_free(d);
        return 0;
      }
    }
  }
  jw_kv_bool(w, "cached", 0);
  jw_kv_bool(w, "offline", !online);
  write_catalog_only(&b, w);
  return 0;
}
