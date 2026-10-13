/*
 * cx_homebrew.c — see cx_homebrew.h.
 *
 * pkg-zone card format (as proven by a shipped payload):
 *   <article class="pkg …"> … /details/<id> … class="title font-bold">Title
 *   … class="number …">1.2 … text-gray-300">Author … "Supports PS5" …
 * Covers: https://pkg-zone.com/images/<id>/cover.png, downloads
 * https://pkg-zone.com/download/ps5|ps4/<id>/latest.
 */
#include "cx_homebrew.h"
#include "catalog.h"
#include "cx_common.h"
#include "http_client.h"
#include "log.h"
#include "settings.h"
#include "storage.h"
#include "util.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HB_MAX_AGE_S (7 * 24 * 3600)
#define HB_MAX_PAGES 40
#define HB_MAX_ITEMS 2000
#define HB_PAGE_MAX (2u << 20)
#define IMG_MAX (8u << 20)

static pthread_mutex_t hb_mu = PTHREAD_MUTEX_INITIALIZER;
static volatile int refreshing;
static time_t last_failed_fetch;
#define HB_RETRY_S 600

static const char *const IMAGE_HOSTS[] = {"pkg-zone.com", "prosperopatches.com", "orbispatches.com", "image.api.playstation.com",
                                          "store.playstation.com", "steamstatic.com", "steampowered.com", "raw.githubusercontent.com",
                                          "githubusercontent.com", "archive.org", "pixeldrain.com", "supabase.co", "catbox.moe"};

static const char *pkgzone_base(void) {
  const char *o = cx_base_override("PKGZONE");
  return *o ? o : "https://pkg-zone.com";
}

static void cache_path(char *out, size_t cap) { xsnprintf(out, cap, "%s/homebrew.json", cx_data_dir()); }

/* ---- HTML helpers ------------------------------------------------------- */

/* Text that follows `marker` up to the next '<' (after the next '>' when
 * after_gt is set), entities decoded and trimmed. */
static int text_after(const char *seg, const char *end, const char *marker, int after_gt, char *out, size_t cap) {
  out[0] = 0;
  const char *p = util_strcasestr(seg, marker);
  if (!p || p >= end) return -1;
  p += strlen(marker);
  if (after_gt) { while (p < end && *p != '>') p++; if (p >= end) return -1; p++; }
  size_t o = 0;
  while (p < end && *p != '<' && o + 1 < cap) out[o++] = *p++;
  out[o] = 0;
  util_html_unescape(out);
  util_trim(out);
  return out[0] ? 0 : -1;
}

static int id_after_details(const char *seg, const char *end, char *out, size_t cap) {
  out[0] = 0;
  const char *p = strstr(seg, "/details/");
  if (!p || p >= end) return -1;
  p += 9;
  size_t o = 0;
  while (p < end && o + 1 < cap) {
    char c = *p;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-') out[o++] = c;
    else break;
    p++;
  }
  out[o] = 0;
  return o ? 0 : -1;
}

static const char *guess_category(const char *title, const char *explicit) {
  if (explicit && *explicit) return explicit;
  static const struct { const char *kw; const char *cat; } map[] = {
    {"emulator", "Emulator"}, {"emu", "Emulator"}, {"retroarch", "Emulator"}, {"ppsspp", "Emulator"}, {"dolphin", "Emulator"},
    {"pcsx", "Emulator"}, {"duckstation", "Emulator"}, {"flycast", "Emulator"}, {"mupen", "Emulator"}, {"snes", "Emulator"},
    {"player", "Media"}, {"media", "Media"}, {"video", "Media"}, {"music", "Media"}, {"ftp", "Tool"}, {"manager", "Tool"},
    {"loader", "Tool"}, {"dumper", "Tool"}, {"tool", "Tool"}, {"store", "Tool"}, {"browser", "Tool"}, {"mount", "Tool"},
    {"game", "Game"}, {"port", "Game"},
  };
  for (size_t i = 0; i < XS_ARRAY_LEN(map); i++) if (util_strcasestr(title, map[i].kw)) return map[i].cat;
  return "App";
}

int cx_homebrew_parse_page(const char *html, size_t len, jw *w, int *count) {
  const char *p = html, *end = html + len;
  int n = 0;
  while (p < end && n < 200) {
    const char *art = util_strcasestr(p, "<article");
    if (!art || art >= end) break;
    const char *tag_end = strchr(art, '>');
    if (!tag_end) break;
    const char *close = util_strcasestr(tag_end, "</article>");
    const char *seg_end = close ? close : end;
    p = seg_end;
    /* class="pkg …" on the article tag */
    char cls[256] = "";
    const char *ca = util_strcasestr(art, "class=\"");
    if (!ca || ca > tag_end) continue;
    ca += 7;
    size_t ci = 0;
    while (ca < tag_end && *ca != '"' && ci + 1 < sizeof cls) cls[ci++] = *ca++;
    cls[ci] = 0;
    if (!(strcmp(cls, "pkg") == 0 || util_starts_with(cls, "pkg ") || strstr(cls, " pkg ") || util_ends_with(cls, " pkg"))) continue;
    char id[64], title[200], version[40], author[100];
    if (id_after_details(tag_end, seg_end, id, sizeof id) != 0) continue;
    if (text_after(tag_end, seg_end, "class=\"title font-bold", 1, title, sizeof title) != 0) continue;
    if (text_after(tag_end, seg_end, "class=\"number", 1, version, sizeof version) != 0) version[0] = 0;
    if (text_after(tag_end, seg_end, "text-gray-300\">", 0, author, sizeof author) != 0) author[0] = 0;
    int ps5 = util_strcasestr(tag_end, "Supports PS5") != NULL && util_strcasestr(tag_end, "Supports PS5") < seg_end;
    char cover[300], details[300], dl5[300], dl4[300];
    xsnprintf(cover, sizeof cover, "%s/images/%s/cover.png", pkgzone_base(), id);
    xsnprintf(details, sizeof details, "%s/details/%s", pkgzone_base(), id);
    xsnprintf(dl5, sizeof dl5, "%s/download/ps5/%s/latest", pkgzone_base(), id);
    xsnprintf(dl4, sizeof dl4, "%s/download/ps4/%s/latest", pkgzone_base(), id);
    jw_obj_begin(w);
    jw_kv_str(w, "id", id);
    jw_kv_str(w, "title", title);
    jw_kv_str(w, "version", version);
    jw_kv_str(w, "author", author);
    jw_kv_bool(w, "supportsPs5", ps5);
    jw_kv_str(w, "cover", cover);
    jw_kv_str(w, "details", details);
    jw_kv_str(w, "downloadPs5", ps5 ? dl5 : "");
    jw_kv_str(w, "downloadPs4", dl4);
    jw_kv_str(w, "category", guess_category(title, ""));
    jw_kv_str(w, "source", "pkg-zone");
    jw_obj_end(w);
    n++;
    if (count) (*count)++;
  }
  return n;
}

static int fetch_listing(jw *items, int *total) {
  char ua[160];
  xsnprintf(ua, sizeof ua, "User-Agent: Mozilla/5.0 (PlayStation 5) XENO-STORE/%s\r\nAccept: text/html\r\n", XENO_VERSION);
  int pages = 0;
  for (int page = 1; page <= HB_MAX_PAGES && *total < HB_MAX_ITEMS; page++) {
    char url[300];
    xsnprintf(url, sizeof url, "%s/?page=%d", pkgzone_base(), page);
    char host[256];
    util_url_host(url, host, sizeof host);
    if (!util_host_matches(host, "pkg-zone.com") && !cx_host_is_loopback(host)) return -1;
    cx_http o = {0};
    o.headers = ua;
    o.timeout_ms = 15000;
    o.max_bytes = HB_PAGE_MAX;
    int status = 0;
    size_t len = 0;
    char *html = cx_fetch(url, &o, &status, &len, NULL);
    if (!html || status != 200) { LOGW("homebrew: page %d -> HTTP %d", page, status); free(html); return pages ? 0 : -1; }
    int got = cx_homebrew_parse_page(html, len, items, total);
    free(html);
    pages++;
    if (got == 0) break;
    util_sleep_ms(300);   /* polite */
  }
  return 0;
}

static int refresh_cache(void) {
  if (refreshing) return -1;
  refreshing = 1;
  jw items;
  jw_init(&items);
  jw_arr_begin(&items);
  int total = 0;
  int rc = fetch_listing(&items, &total);
  jw_arr_end(&items);
  size_t il;
  char *it = jw_detach(&items, &il);
  if (rc == 0 && it && total > 0) {
    jw w;
    jw_init(&w);
    jw_obj_begin(&w);
    jw_kv_i64(&w, "fetchedAt", (int64_t)util_now());
    jw_kv_str(&w, "source", pkgzone_base());
    jw_kv_int(&w, "count", total);
    jw_kv_raw(&w, "items", it, il);
    jw_obj_end(&w);
    char path[700];
    cache_path(path, sizeof path);
    pthread_mutex_lock(&hb_mu);
    cx_write_json(path, &w);
    pthread_mutex_unlock(&hb_mu);
    LOGI("homebrew: pkg-zone listing cached (%d apps)", total);
  } else rc = -1;
  free(it);
  refreshing = 0;
  return rc;
}

void cx_homebrew_init(void) {}

typedef struct merge_ctx { jw *w; const char *q; const char *category; int n; jdoc *inst; char seen[HB_MAX_ITEMS][64]; int nseen; } merge_ctx;

static int matches(const merge_ctx *m, const char *title, const char *author, const char *id, const char *cat) {
  if (m->category && *m->category && !util_strieq(cat, m->category)) return 0;
  if (!m->q || !*m->q) return 1;
  char f[160], h[400];
  util_fold(m->q, f, sizeof f);
  util_trim(f);
  if (!f[0]) return 1;
  util_fold(title, h, sizeof h); if (strstr(h, f)) return 1;
  util_fold(author, h, sizeof h); if (strstr(h, f)) return 1;
  util_fold(id, h, sizeof h); if (strstr(h, f)) return 1;
  return 0;
}

static void installed_fields(merge_ctx *m, const char *id, const char *version) {
  jv rec = m->inst ? jv_get(json_root(m->inst), id) : jv_get(json_root(m->inst), "");
  const char *tid = m->inst && jv_ok(rec) ? jv_get_str(rec, "titleId", "") : "";
  const char *iv = m->inst && jv_ok(rec) ? jv_get_str(rec, "version", "") : "";
  int installed = (tid[0] && storage_title_installed(tid)) || (cx_titleid_valid(id) && storage_title_installed(id));
  jw_kv_bool(m->w, "installed", installed);
  jw_kv_str(m->w, "installedVersion", installed ? iv : "");
  jw_kv_str(m->w, "installedTitleId", installed ? (tid[0] ? tid : id) : "");
  jw_kv_bool(m->w, "updateAvailable", installed && iv[0] && version[0] && util_semver_cmp(version, iv) > 0);
}

static void emit_cached(merge_ctx *m, jv item) {
  const char *id = jv_get_str(item, "id", "");
  if (!*id || m->nseen >= HB_MAX_ITEMS) return;
  for (int i = 0; i < m->nseen; i++) if (strcmp(m->seen[i], id) == 0) return;
  xstrlcpy(m->seen[m->nseen++], id, 64);
  if (!matches(m, jv_get_str(item, "title", ""), jv_get_str(item, "author", ""), id, jv_get_str(item, "category", ""))) return;
  jw_obj_begin(m->w);
  JV_FOREACH(f, item) { jw_key(m->w, jv_key(f)); jw_value(m->w, f); }
  installed_fields(m, id, jv_get_str(item, "version", ""));
  jw_obj_end(m->w);
  m->n++;
}

static void visit_catalog(jv g, void *user) {
  merge_ctx *m = user;
  if (!util_strieq(jv_get_str(g, "platform", ""), "HOMEBREW")) return;
  const char *id = jv_get_str(g, "slug", jv_get_str(g, "id", ""));
  if (!*id || m->nseen >= HB_MAX_ITEMS) return;
  for (int i = 0; i < m->nseen; i++) if (strcmp(m->seen[i], id) == 0) return;
  xstrlcpy(m->seen[m->nseen++], id, 64);
  const char *title = jv_get_str(g, "title", "");
  const char *author = jv_get_str(g, "author", jv_get_str(g, "publisher", ""));
  const char *cat = guess_category(title, jv_get_str(g, "category", ""));
  if (!matches(m, title, author, id, cat)) return;
  char version[40] = "", dl5[1024] = "", dl4[1024] = "";
  int ps5 = jv_get_bool(g, "supportsPs5", 0);
  JV_FOREACH(r, jv_get(g, "releases")) {
    const char *url = jv_get_str(r, "url", "");
    const char *v = jv_get_str(r, "version", "");
    if (!version[0] && *v) xstrlcpy(version, v, sizeof version);
    if (strstr(url, "/ps5/") || util_strcasestr(jv_get_str(r, "notes", ""), "ps5")) { if (!dl5[0]) xstrlcpy(dl5, url, sizeof dl5); ps5 = 1; }
    else if (!dl4[0]) xstrlcpy(dl4, url, sizeof dl4);
  }
  jw_obj_begin(m->w);
  jw_kv_str(m->w, "id", id);
  jw_kv_str(m->w, "gameId", jv_get_str(g, "id", ""));
  jw_kv_str(m->w, "title", title);
  jw_kv_str(m->w, "version", version);
  jw_kv_str(m->w, "author", author);
  jw_kv_bool(m->w, "supportsPs5", ps5);
  jw_kv_str(m->w, "cover", jv_get_str(g, "cover", ""));
  jw_kv_str(m->w, "details", jv_get_str(g, "homepage", ""));
  jw_kv_str(m->w, "downloadPs5", dl5);
  jw_kv_str(m->w, "downloadPs4", dl4);
  jw_kv_str(m->w, "category", cat);
  jw_kv_str(m->w, "description", jv_get_str(g, "description", ""));
  jw_kv_i64(m->w, "size", jv_get_i64(g, "sizeMax", 0));
  jw_kv_str(m->w, "source", "catalog");
  installed_fields(m, id, version);
  jw_obj_end(m->w);
  m->n++;
}

int cx_homebrew_json(int refresh, const char *q, const char *category, jw *w) {
  char path[700];
  cache_path(path, sizeof path);
  time_t mt = util_file_mtime(path);
  int stale = mt <= 0 || util_now() - mt >= HB_MAX_AGE_S;
  settings_t s;
  settings_get(&s);
  int fetched = 0;
  int retry_ok = refresh || !last_failed_fetch || util_now() - last_failed_fetch >= HB_RETRY_S;
  if ((refresh || stale) && retry_ok && xhttp_available() && !s.safeMode) {
    fetched = refresh_cache() == 0;
    last_failed_fetch = fetched ? 0 : util_now();
  }
  merge_ctx *m = calloc(1, sizeof *m);
  if (!m) return -1;
  m->w = w;
  m->q = q;
  m->category = category;
  char ip[700];
  xsnprintf(ip, sizeof ip, "%s/installed.json", cx_data_dir());
  m->inst = cx_json_file(ip, 1 << 20, 20000);
  jw_key(w, "items");
  jw_arr_begin(w);
  pthread_mutex_lock(&hb_mu);
  jdoc *cache = cx_json_file(path, 16u << 20, 400000);
  pthread_mutex_unlock(&hb_mu);
  int cached_items = 0;
  if (cache) {
    JV_FOREACH(it, jv_get(json_root(cache), "items")) { emit_cached(m, it); cached_items++; }
  }
  catalog_visit_games(visit_catalog, m);
  jw_arr_end(w);
  jw_kv_int(w, "count", m->n);
  jw_key(w, "categories"); jw_arr_begin(w);
  const char *cats[] = {"Emulator", "Tool", "Game", "Media", "App"};
  for (size_t i = 0; i < XS_ARRAY_LEN(cats); i++) jw_str(w, cats[i]);
  jw_arr_end(w);
  jw_kv_i64(w, "fetchedAt", cache ? jv_get_i64(json_root(cache), "fetchedAt", 0) : 0);
  jw_kv_bool(w, "cached", cache != NULL && !fetched);
  jw_kv_bool(w, "live", fetched);
  jw_kv_int(w, "pkgZoneItems", cached_items);
  jw_kv_str(w, "source", pkgzone_base());
  if (cache) json_free(cache);
  if (m->inst) json_free(m->inst);
  free(m);
  return 0;
}

int cx_homebrew_record_installed(const char *id, const char *titleId, const char *version, char *err, size_t errcap) {
  if (!cx_id_valid(id, 63)) { xsnprintf(err, errcap, "invalid id"); return -1; }
  if (titleId && *titleId && !cx_titleid_valid(titleId)) { xsnprintf(err, errcap, "invalid titleId"); return -1; }
  char ip[700];
  xsnprintf(ip, sizeof ip, "%s/installed.json", cx_data_dir());
  jdoc *d = cx_json_file(ip, 1 << 20, 20000);
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  if (d) {
    JV_FOREACH(m, json_root(d)) { const char *k = jv_key(m); if (!k || strcmp(k, id) == 0) continue; jw_key(&w, k); jw_value(&w, m); }
    json_free(d);
  }
  jw_key(&w, id); jw_obj_begin(&w);
  jw_kv_str(&w, "titleId", titleId ? titleId : "");
  jw_kv_str(&w, "version", version ? version : "");
  jw_kv_i64(&w, "installedAt", (int64_t)util_now());
  jw_obj_end(&w);
  jw_obj_end(&w);
  pthread_mutex_lock(&hb_mu);
  int rc = cx_write_json(ip, &w);
  pthread_mutex_unlock(&hb_mu);
  if (rc != 0) { xsnprintf(err, errcap, "cannot write installed.json"); return -1; }
  return 0;
}

/* ---- image proxy -------------------------------------------------------- */

static int image_type_ok(const char *ct, const char *url) {
  if (util_istarts_with(ct, "image/")) return 1;
  if (ct[0] && !util_istarts_with(ct, "application/octet-stream") && !util_istarts_with(ct, "binary/")) return 0;
  char path[1536];
  xurl u;
  if (util_url_parse(url, &u) != 0) return 0;
  xstrlcpy(path, u.path, sizeof path);
  char *qm = strchr(path, '?');
  if (qm) *qm = 0;
  return util_iends_with(path, ".png") || util_iends_with(path, ".jpg") || util_iends_with(path, ".jpeg") || util_iends_with(path, ".webp") || util_iends_with(path, ".gif");
}

void cx_image_proxy(http_req *req, const char *url) {
  xurl u;
  if (!util_istarts_with(url, "http") || util_url_parse(url, &u) != 0 || u.has_userinfo) { http_send_error(req, 400, "bad_request", "url must be http(s)"); return; }
  char host[256];
  util_url_host(url, host, sizeof host);
  if (!cx_host_in(host, IMAGE_HOSTS, XS_ARRAY_LEN(IMAGE_HOSTS)) && !cx_host_is_loopback(host)) { http_send_error(req, 403, "forbidden", "image host is not allowed"); return; }
  if (!xhttp_available()) { http_send_error(req, 503, "downloads_unavailable", "network transport unavailable"); return; }
  cx_http o = {0};
  o.timeout_ms = 15000;
  o.max_bytes = IMG_MAX;
  o.headers = "Accept: image/*\r\n";
  xhttp_resp resp;
  int status = 0;
  size_t len = 0;
  char *body = cx_fetch(url, &o, &status, &len, &resp);
  if (!body) { http_send_error(req, 502, "fetch_failed", xhttp_last_error()); return; }
  if (status != 200) { free(body); http_send_error(req, 502, "fetch_failed", "image host answered with an error"); return; }
  if (!image_type_ok(resp.content_type, url)) { free(body); http_send_error(req, 415, "not_an_image", "the URL did not return an image"); return; }
  char ct[96];
  xstrlcpy(ct, util_istarts_with(resp.content_type, "image/") ? resp.content_type : "image/png", sizeof ct);
  http_send(req, 200, ct, body, len, "Cache-Control: public, max-age=86400\r\n");
  free(body);
}
