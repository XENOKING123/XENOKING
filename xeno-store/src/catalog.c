/*
 * catalog.c — see catalog.h.
 *
 * The current catalog is an immutable "state" (parsed DOM + search index +
 * served blob). A refresh builds a new state and swaps the pointer under
 * catalog_mu; readers that already hold a blob reference keep it alive via
 * the refcount, so a swap never frees memory that a response is streaming.
 */
#define XENO_ASSETS_IMPL 1
#include "assets.h"

#include "catalog.h"
#include "config.h"
#include "http_client.h"
#include "log.h"
#include "settings.h"
#include "util.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct cat_idx {
  uint32_t node;
  char *ftitle;      /* folded title */
  char *fpub;        /* folded publisher */
  char id[128];
  char platform[8];
  char tids[CAT_MAX_TITLEIDS][16];
  int ntids;
} cat_idx;

typedef struct cat_state {
  jdoc *doc;
  catalog_blob *blob;
  cat_idx *idx;
  int n_idx;
  int64_t revision;
  char generatedAt[40];
  int games, releases;
  char source[12];        /* embedded | cached */
  time_t updatedAt;
} cat_state;

static pthread_mutex_t catalog_mu = PTHREAD_MUTEX_INITIALIZER;
static cat_state *cur;
static int64_t embedded_rev = -1, cached_rev = -1;
static char data_dir[512];
static const char *const ALLOWED_HOSTS[] = {"dlpsgame.com", "archive.org", "raw.githubusercontent.com", "github.com",
                                            "api.github.com", "prosperopatches.com", "orbispatches.com", "vikingfile.com"};

/* ---- blob refcount ------------------------------------------------------ */

static void blob_free(catalog_blob *b) {
  if (!b) return;
  if (!b->embedded) free(b->data);
  free(b);
}

catalog_blob *catalog_blob_acquire(void) {
  pthread_mutex_lock(&catalog_mu);
  catalog_blob *b = cur ? cur->blob : NULL;
  if (b) b->refs++;
  pthread_mutex_unlock(&catalog_mu);
  return b;
}

void catalog_blob_release(catalog_blob *b) {
  if (!b) return;
  pthread_mutex_lock(&catalog_mu);
  int dead = (--b->refs == 0);
  pthread_mutex_unlock(&catalog_mu);
  if (dead) blob_free(b);
}

/* ---- state construction ------------------------------------------------- */

static void state_free(cat_state *s) {
  if (!s) return;
  for (int i = 0; i < s->n_idx; i++) { free(s->idx[i].ftitle); free(s->idx[i].fpub); }
  free(s->idx);
  json_free(s->doc);
  if (s->blob) {
    pthread_mutex_lock(&catalog_mu);
    int dead = (--s->blob->refs == 0);
    pthread_mutex_unlock(&catalog_mu);
    if (dead) blob_free(s->blob);
  }
  free(s);
}

static jv node(const jdoc *d, uint32_t i) { jv v = { d, i }; return v; }

static int build_index(cat_state *s) {
  jv games = jv_get(json_root(s->doc), "games");
  size_t n = jv_len(games);
  s->idx = calloc(n ? n : 1, sizeof *s->idx);
  if (!s->idx) return -1;
  char fold[600];
  JV_FOREACH(g, games) {
    cat_idx *e = &s->idx[s->n_idx];
    e->node = g.i;
    xstrlcpy(e->id, jv_get_str(g, "id", ""), sizeof e->id);
    xstrlcpy(e->platform, jv_get_str(g, "platform", ""), sizeof e->platform);
    util_fold(jv_get_str(g, "title", ""), fold, sizeof fold);
    e->ftitle = util_strdup(fold);
    util_fold(jv_get_str(g, "publisher", ""), fold, sizeof fold);
    e->fpub = util_strdup(fold);
    JV_FOREACH(t, jv_get(g, "titleIds")) {
      const char *tid = jv_str(t, NULL);
      if (tid && e->ntids < CAT_MAX_TITLEIDS) { xstrlcpy(e->tids[e->ntids], tid, 16); util_upper(e->tids[e->ntids]); e->ntids++; }
    }
    s->releases += (int)jv_len(jv_get(g, "releases"));
    s->n_idx++;
  }
  s->games = s->n_idx;
  return 0;
}

/* Parses + validates catalog text and builds a state. `text` must stay valid
 * for the life of the state when embedded (it points into assets.h). */
static cat_state *state_build(const unsigned char *text, size_t len, const unsigned char *gz, size_t gz_len,
                              int embedded, const char *source, char *err, size_t errcap) {
  jdoc *doc = json_parse((const char *)text, len, 900000, 32);
  if (!doc) { xsnprintf(err, errcap, "catalog is not valid JSON"); return NULL; }
  jv root = json_root(doc);
  if (jv_type(root) != JV_OBJ || jv_type(jv_get(root, "games")) != JV_ARR) {
    json_free(doc);
    xsnprintf(err, errcap, "catalog has no games array");
    return NULL;
  }
  if (jv_get_i64(root, "schemaVersion", 1) != 1) {
    json_free(doc);
    xsnprintf(err, errcap, "unsupported catalog schemaVersion");
    return NULL;
  }
  cat_state *s = calloc(1, sizeof *s);
  catalog_blob *b = calloc(1, sizeof *b);
  if (!s || !b) { free(s); free(b); json_free(doc); xsnprintf(err, errcap, "out of memory"); return NULL; }
  s->doc = doc;
  s->revision = jv_get_i64(root, "revision", 0);
  xstrlcpy(s->generatedAt, jv_get_str(root, "generatedAt", ""), sizeof s->generatedAt);
  xstrlcpy(s->source, source, sizeof s->source);
  s->updatedAt = util_now();
  if (embedded) { b->data = (unsigned char *)text; b->embedded = 1; }
  else {
    b->data = malloc(len);
    if (!b->data) { free(b); state_free(s); xsnprintf(err, errcap, "out of memory"); return NULL; }
    memcpy(b->data, text, len);
  }
  b->len = len;
  b->gz = gz;
  b->gz_len = gz_len;
  b->revision = s->revision;
  xsnprintf(b->etag, sizeof b->etag, "\"c%lld-%zu\"", (long long)s->revision, len);
  b->refs = 1;
  s->blob = b;
  if (build_index(s) != 0) { state_free(s); xsnprintf(err, errcap, "out of memory"); return NULL; }
  return s;
}

static void state_install(cat_state *s) {
  pthread_mutex_lock(&catalog_mu);
  cat_state *old = cur;
  cur = s;
  pthread_mutex_unlock(&catalog_mu);
  state_free(old);
}

static void cache_paths(char *json, size_t jcap, char *meta, size_t mcap) {
  xsnprintf(json, jcap, "%s/catalog.json", data_dir);
  xsnprintf(meta, mcap, "%s/catalog.meta.json", data_dir);
}

int catalog_init(const char *dir) {
  char err[128];
  xstrlcpy(data_dir, dir, sizeof data_dir);
  cat_state *emb = state_build(xs_catalog_json.data, xs_catalog_json.len, xs_catalog_json.gz, xs_catalog_json.gz_len, 1,
                               "embedded", err, sizeof err);
  if (!emb) { LOGE("embedded catalog unusable: %s", err); return -1; }
  embedded_rev = emb->revision;
  state_install(emb);
  LOGI("catalog: embedded revision %lld, %d games, %d releases", (long long)emb->revision, emb->games, emb->releases);

  char jpath[600], mpath[600];
  cache_paths(jpath, sizeof jpath, mpath, sizeof mpath);
  size_t len;
  char *txt = util_read_file(jpath, &len, 48u << 20);
  if (txt) {
    cat_state *c = state_build((unsigned char *)txt, len, NULL, 0, 0, "cached", err, sizeof err);
    if (c) {
      cached_rev = c->revision;
      c->updatedAt = util_file_mtime(jpath);
      if (c->revision > embedded_rev) {
        LOGI("catalog: using cached revision %lld (%d games)", (long long)c->revision, c->games);
        state_install(c);
      } else {
        LOGI("catalog: cached revision %lld is not newer than embedded, ignoring", (long long)c->revision);
        state_free(c);
      }
    } else {
      LOGW("catalog: cached copy rejected (%s)", err);
    }
    free(txt);
  }
  return 0;
}

int64_t catalog_revision(void) {
  pthread_mutex_lock(&catalog_mu);
  int64_t r = cur ? cur->revision : 0;
  pthread_mutex_unlock(&catalog_mu);
  return r;
}

int catalog_game_count(void) {
  pthread_mutex_lock(&catalog_mu);
  int n = cur ? cur->games : 0;
  pthread_mutex_unlock(&catalog_mu);
  return n;
}

int catalog_release_count(void) {
  pthread_mutex_lock(&catalog_mu);
  int n = cur ? cur->releases : 0;
  pthread_mutex_unlock(&catalog_mu);
  return n;
}

void catalog_status_json(jw *w) {
  pthread_mutex_lock(&catalog_mu);
  jw_kv_i64(w, "revision", cur ? cur->revision : 0);
  jw_kv_str(w, "generatedAt", cur ? cur->generatedAt : "");
  jw_kv_int(w, "games", cur ? cur->games : 0);
  jw_kv_int(w, "releases", cur ? cur->releases : 0);
  jw_kv_str(w, "source", cur ? cur->source : "embedded");
  jw_kv_i64(w, "updatedAt", cur ? (int64_t)cur->updatedAt : 0);
  pthread_mutex_unlock(&catalog_mu);
}

void catalog_info_json(jw *w) {
  catalog_status_json(w);
  pthread_mutex_lock(&catalog_mu);
  jw_key(w, "sources");
  if (cur) jw_value(w, jv_get(json_root(cur->doc), "sources"));
  else { jw_arr_begin(w); jw_arr_end(w); }
  jw_key(w, "genres");
  if (cur && jv_ok(jv_get(json_root(cur->doc), "genres"))) jw_value(w, jv_get(json_root(cur->doc), "genres"));
  else { jw_arr_begin(w); jw_arr_end(w); }
  jw_kv_i64(w, "embeddedRevision", embedded_rev);
  jw_kv_i64(w, "cachedRevision", cached_rev);
  jw_kv_str(w, "name", cur ? jv_get_str(json_root(cur->doc), "name", XENO_APP_NAME " Catalog") : "");
  jw_kv_bool(w, "placeholder", XENO_ASSETS_PLACEHOLDER_CATALOG != 0);
  pthread_mutex_unlock(&catalog_mu);
}

/* ---- refresh ------------------------------------------------------------ */

static char *fetch_text(const char *url, int timeout_ms, size_t max, size_t *len, xhttp_resp *resp) {
  xhttp_req r;
  memset(&r, 0, sizeof r);
  r.url = url;
  r.range_start = r.range_end = -1;
  r.follow_redirects = 5;
  r.connect_timeout_ms = timeout_ms;
  r.recv_timeout_ms = timeout_ms;
  r.extra_headers = "Cache-Control: no-cache\r\n";
  return xhttp_fetch(&r, resp, max, len);
}

int catalog_refresh(int force, int *updated, char *err, size_t errcap) {
  *updated = 0;
  err[0] = 0;
  settings_t s;
  settings_get(&s);
  if (!xhttp_available()) { xsnprintf(err, errcap, "network transport unavailable"); return -1; }
  int64_t current = catalog_revision();
  int64_t remote = -1;
  xhttp_resp resp;
  size_t len;
  settings_touch_catalog_check();
  if (s.catalogRevisionUrl[0]) {
    char *txt = fetch_text(s.catalogRevisionUrl, 15000, 1 << 20, &len, &resp);
    if (txt && resp.status == 200) {
      jdoc *d = json_parse(txt, len, 1000, 8);
      if (d) { remote = jv_get_i64(json_root(d), "revision", -1); json_free(d); }
    }
    if (!txt) LOGW("catalog: revision check failed: %s", xhttp_last_error());
    free(txt);
    if (remote >= 0 && remote <= current) {
      LOGI("catalog: remote revision %lld not newer than %lld", (long long)remote, (long long)current);
      return 0;
    }
    if (remote < 0 && !force) { xsnprintf(err, errcap, "Could not read revision.json (%s)", xhttp_last_error()); return -1; }
  }
  char *txt = fetch_text(s.catalogUrl, 60000, 48u << 20, &len, &resp);
  if (!txt) { xsnprintf(err, errcap, "Catalog download failed: %s", xhttp_last_error()); return -1; }
  if (resp.status != 200) { xsnprintf(err, errcap, "Catalog download returned HTTP %d", resp.status); free(txt); return -1; }
  cat_state *ns = state_build((unsigned char *)txt, len, NULL, 0, 0, "cached", err, errcap);
  if (!ns) { free(txt); return -1; }
  if (ns->revision <= current && !force) {
    LOGI("catalog: downloaded revision %lld is not newer", (long long)ns->revision);
    state_free(ns);
    free(txt);
    return 0;
  }
  char jpath[600], mpath[600];
  cache_paths(jpath, sizeof jpath, mpath, sizeof mpath);
  if (util_write_file_atomic(jpath, txt, len) != 0) LOGW("catalog: cannot write %s", jpath);
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_kv_i64(&w, "revision", ns->revision);
  jw_kv_i64(&w, "fetchedAt", (int64_t)util_now());
  jw_kv_str(&w, "url", s.catalogUrl);
  jw_kv_i64(&w, "bytes", (int64_t)len);
  jw_obj_end(&w);
  size_t ml;
  char *meta = jw_detach(&w, &ml);
  if (meta) { util_write_file_atomic(mpath, meta, ml); free(meta); }
  free(txt);
  cached_rev = ns->revision;
  LOGI("catalog: refreshed to revision %lld (%d games, %d releases)", (long long)ns->revision, ns->games, ns->releases);
  state_install(ns);
  *updated = 1;
  return 0;
}

/* ---- lookups ------------------------------------------------------------ */

static void fill_game(jv g, cat_game *out) {
  memset(out, 0, sizeof *out);
  xstrlcpy(out->id, jv_get_str(g, "id", ""), sizeof out->id);
  xstrlcpy(out->slug, jv_get_str(g, "slug", ""), sizeof out->slug);
  xstrlcpy(out->title, jv_get_str(g, "title", ""), sizeof out->title);
  xstrlcpy(out->platform, jv_get_str(g, "platform", ""), sizeof out->platform);
  xstrlcpy(out->region, jv_get_str(g, "region", ""), sizeof out->region);
  xstrlcpy(out->publisher, jv_get_str(g, "publisher", ""), sizeof out->publisher);
  xstrlcpy(out->cover, jv_get_str(g, "cover", ""), sizeof out->cover);
  xstrlcpy(out->hero, jv_get_str(g, "hero", ""), sizeof out->hero);
  xstrlcpy(out->releaseDate, jv_get_str(g, "releaseDate", ""), sizeof out->releaseDate);
  out->sizeMin = jv_get_i64(g, "sizeMin", 0);
  out->sizeMax = jv_get_i64(g, "sizeMax", 0);
  out->verified = jv_get_bool(g, "verified", 0);
  out->featured = (int)jv_get_i64(g, "featured", 0);
  out->popularity = jv_get_dbl(g, "popularity", 0);
  JV_FOREACH(t, jv_get(g, "titleIds")) {
    const char *tid = jv_str(t, NULL);
    if (tid && out->ntitleIds < CAT_MAX_TITLEIDS) xstrlcpy(out->titleIds[out->ntitleIds++], tid, 16);
  }
}

static void fill_release(jv r, cat_release *out) {
  memset(out, 0, sizeof *out);
  xstrlcpy(out->id, jv_get_str(r, "id", ""), sizeof out->id);
  xstrlcpy(out->titleId, jv_get_str(r, "titleId", ""), sizeof out->titleId);
  xstrlcpy(out->region, jv_get_str(r, "region", ""), sizeof out->region);
  xstrlcpy(out->version, jv_get_str(r, "version", ""), sizeof out->version);
  xstrlcpy(out->format, jv_get_str(r, "format", ""), sizeof out->format);
  xstrlcpy(out->kind, jv_get_str(r, "kind", "game"), sizeof out->kind);
  xstrlcpy(out->provider, jv_get_str(r, "provider", ""), sizeof out->provider);
  xstrlcpy(out->sourceId, jv_get_str(r, "sourceId", ""), sizeof out->sourceId);
  xstrlcpy(out->filename, jv_get_str(r, "filename", ""), sizeof out->filename);
  xstrlcpy(out->url, jv_get_str(r, "url", ""), sizeof out->url);
  xstrlcpy(out->browserUrl, jv_get_str(r, "browserUrl", ""), sizeof out->browserUrl);
  xstrlcpy(out->sha256, jv_get_str(r, "sha256", ""), sizeof out->sha256);
  xstrlcpy(out->md5, jv_get_str(r, "md5", ""), sizeof out->md5);
  xstrlcpy(out->password, jv_get_str(r, "password", ""), sizeof out->password);
  out->sizeBytes = jv_get_i64(r, "sizeBytes", 0);
  out->consoleVerified = jv_get_bool(r, "consoleVerified", 0);
  out->verified = jv_get_str(r, "verifiedAt", "")[0] != 0 || out->consoleVerified;
  JV_FOREACH(m, jv_get(r, "mirrors")) {
    const char *u = jv_str(m, NULL);
    if (u && out->nmirrors < CAT_MAX_MIRRORS && util_istarts_with(u, "http")) xstrlcpy(out->mirrors[out->nmirrors++], u, 1024);
  }
  util_lower(out->sha256);
}

static jv find_game_node_locked(const char *gameId) {
  jv none = { NULL, 0xFFFFFFFFu };
  if (!cur || !gameId) return none;
  for (int i = 0; i < cur->n_idx; i++)
    if (strcmp(cur->idx[i].id, gameId) == 0) return node(cur->doc, cur->idx[i].node);
  return none;
}

int catalog_find_game(const char *gameId, cat_game *out) {
  pthread_mutex_lock(&catalog_mu);
  jv g = find_game_node_locked(gameId);
  int rc = jv_ok(g) ? 0 : -1;
  if (rc == 0) fill_game(g, out);
  pthread_mutex_unlock(&catalog_mu);
  return rc;
}

int catalog_find_release(const char *gameId, const char *releaseId, cat_game *g, cat_release *r) {
  int rc = -1;
  pthread_mutex_lock(&catalog_mu);
  jv gn = find_game_node_locked(gameId);
  if (jv_ok(gn)) {
    JV_FOREACH(rel, jv_get(gn, "releases")) {
      if (strcmp(jv_get_str(rel, "id", ""), releaseId) == 0) {
        fill_game(gn, g);
        fill_release(rel, r);
        rc = 0;
        break;
      }
    }
  }
  pthread_mutex_unlock(&catalog_mu);
  return rc;
}

static int mirror_rank(jv rel, const cat_release *primary) {
  const char *src = jv_get_str(rel, "sourceId", "");
  int direct = strcmp(src, "archive") == 0 || strcmp(src, "xeno") == 0;
  int verified = jv_get_str(rel, "verifiedAt", "")[0] || jv_get_bool(rel, "consoleVerified", 0) || jv_get_str(rel, "sha256", "")[0];
  if (direct && verified) return 0;
  if (strcmp(jv_get_str(rel, "provider", ""), primary->provider) == 0) return 1;
  return 2;
}

int catalog_collect_mirrors(const char *gameId, const cat_release *r, char (*out)[1024], int max) {
  int n = 0;
  for (int i = 0; i < r->nmirrors && n < max; i++) xstrlcpy(out[n++], r->mirrors[i], 1024);
  pthread_mutex_lock(&catalog_mu);
  jv gn = find_game_node_locked(gameId);
  if (jv_ok(gn)) {
    for (int rank = 0; rank <= 2 && n < max; rank++) {
      JV_FOREACH(rel, jv_get(gn, "releases")) {
        if (n >= max) break;
        const char *url = jv_get_str(rel, "url", "");
        if (!util_istarts_with(url, "http") || strcmp(url, r->url) == 0) continue;
        if (!util_strieq(jv_get_str(rel, "format", ""), r->format)) continue;
        if (util_strieq(r->format, "PAGE")) continue;
        int64_t sz = jv_get_i64(rel, "sizeBytes", 0);
        if (r->sizeBytes > 0 && sz > 0 && sz != r->sizeBytes) continue;
        if (!settings_source_enabled(jv_get_str(rel, "sourceId", "other"))) continue;
        if (mirror_rank(rel, r) != rank) continue;
        int dup = 0;
        for (int i = 0; i < n; i++) if (strcmp(out[i], url) == 0) { dup = 1; break; }
        if (!dup) xstrlcpy(out[n++], url, 1024);
      }
    }
  }
  pthread_mutex_unlock(&catalog_mu);
  return n;
}

int catalog_match_titleid(const char *titleId, cat_game *out) {
  char tid[16];
  xstrlcpy(tid, titleId, sizeof tid);
  util_upper(tid);
  int rc = -1;
  pthread_mutex_lock(&catalog_mu);
  if (cur) {
    for (int i = 0; i < cur->n_idx && rc != 0; i++)
      for (int t = 0; t < cur->idx[i].ntids; t++)
        if (strcmp(cur->idx[i].tids[t], tid) == 0) { fill_game(node(cur->doc, cur->idx[i].node), out); rc = 0; break; }
  }
  pthread_mutex_unlock(&catalog_mu);
  return rc;
}

int catalog_match_title(const char *title, const char *platform, cat_game *out) {
  char f[512];
  util_fold(title, f, sizeof f);
  util_trim(f);
  if (strlen(f) < 3) return -1;
  int best = -1, best_score = 0;
  pthread_mutex_lock(&catalog_mu);
  if (cur) {
    for (int i = 0; i < cur->n_idx; i++) {
      const cat_idx *e = &cur->idx[i];
      if (platform && *platform && !util_strieq(e->platform, platform)) continue;
      int score = 0;
      if (strcmp(e->ftitle, f) == 0) score = 100;
      else if (util_starts_with(f, e->ftitle) && strlen(e->ftitle) >= 4) score = 60 + (int)(strlen(e->ftitle) * 100 / strlen(f)) / 4;
      else if (util_starts_with(e->ftitle, f)) score = 50;
      if (score > best_score) { best_score = score; best = i; }
    }
    if (best >= 0) fill_game(node(cur->doc, cur->idx[best].node), out);
  }
  pthread_mutex_unlock(&catalog_mu);
  return best >= 0 ? 0 : -1;
}

/* ---- search ------------------------------------------------------------- */

void catalog_game_summary_json(jw *w, jv g) {
  static const char *const keys[] = {"id", "slug", "title", "platform", "titleIds", "region", "genres", "tagline",
                                     "publisher", "releaseDate", "addedAt", "cover", "coverFallback", "hero",
                                     "sizeMin", "sizeMax", "featured", "popularity", "verified"};
  jw_obj_begin(w);
  for (size_t i = 0; i < XS_ARRAY_LEN(keys); i++) {
    jv v = jv_get(g, keys[i]);
    if (jv_ok(v)) { jw_key(w, keys[i]); jw_value(w, v); }
  }
  jw_kv_int(w, "releases", (int)jv_len(jv_get(g, "releases")));
  jw_obj_end(w);
}

typedef struct hit { int idx; int score; } hit;

static int hit_cmp(const void *a, const void *b) {
  const hit *x = a, *y = b;
  return y->score - x->score;
}

int catalog_search(const char *q, const char *platform, int limit, jw *w) {
  char f[256];
  util_fold(q ? q : "", f, sizeof f);
  util_trim(f);
  if (limit <= 0) limit = 50;
  if (limit > 200) limit = 200;
  char ftid[16] = "";
  util_find_titleid(f, ftid, sizeof ftid);
  hit *hits = NULL;
  int nh = 0;
  pthread_mutex_lock(&catalog_mu);
  if (cur) {
    hits = calloc((size_t)cur->n_idx + 1, sizeof *hits);
    if (hits) {
      for (int i = 0; i < cur->n_idx; i++) {
        const cat_idx *e = &cur->idx[i];
        if (platform && *platform && !util_strieq(e->platform, platform)) continue;
        int score = 0;
        if (!f[0]) score = 1;
        else if (strcmp(e->ftitle, f) == 0) score = 100;
        else if (util_starts_with(e->ftitle, f)) score = 80;
        else if (strstr(e->ftitle, f)) score = 60;
        else if (e->fpub[0] && strstr(e->fpub, f)) score = 30;
        if (ftid[0]) for (int t = 0; t < e->ntids; t++) if (strcmp(e->tids[t], ftid) == 0) score = 100;
        if (!score && !ftid[0] && strlen(f) >= 4) {
          /* every word of the query must appear somewhere in the title */
          char words[256];
          xstrlcpy(words, f, sizeof words);
          int all = 1, any = 0;
          for (char *tok = strtok(words, " "); tok; tok = strtok(NULL, " ")) { any = 1; if (!strstr(e->ftitle, tok)) { all = 0; break; } }
          if (any && all) score = 40;
        }
        if (score) { hits[nh].idx = i; hits[nh].score = score; nh++; }
      }
      qsort(hits, (size_t)nh, sizeof *hits, hit_cmp);
    }
  }
  jw_key(w, "items");
  jw_arr_begin(w);
  for (int i = 0; i < nh && i < limit; i++) catalog_game_summary_json(w, node(cur->doc, cur->idx[hits[i].idx].node));
  jw_arr_end(w);
  jw_kv_int(w, "total", nh);
  pthread_mutex_unlock(&catalog_mu);
  free(hits);
  return 0;
}

/* ---- links check (parallel probes) -------------------------------------- */

typedef struct probe {
  char url[2048];
  int status;
  int64_t size;
  int accept_ranges;
  char final_url[1024];
  int ms;
  char error[128];
} probe;

static void *probe_thread(void *arg) {
  probe *p = arg;
  xurl u;
  if (util_url_parse(p->url, &u) != 0 || u.has_userinfo) { xstrlcpy(p->error, "invalid url", sizeof p->error); return NULL; }
  xhttp_req r;
  memset(&r, 0, sizeof r);
  r.url = p->url;
  r.range_start = 0;
  r.range_end = 0;
  r.follow_redirects = 5;
  r.connect_timeout_ms = 10000;
  r.recv_timeout_ms = 10000;
  int64_t t0 = util_now_ms();
  xhttp_conn *c = NULL;
  xhttp_resp resp;
  if (xhttp_open(&r, &c, &resp) != 0) {
    xstrlcpy(p->error, xhttp_last_error(), sizeof p->error);
    p->ms = (int)(util_now_ms() - t0);
    return NULL;
  }
  p->ms = (int)(util_now_ms() - t0);
  p->status = resp.status;
  p->size = resp.range_total >= 0 ? resp.range_total : resp.content_length;
  p->accept_ranges = resp.status == 206 || resp.accept_ranges;
  xstrlcpy(p->final_url, resp.location, sizeof p->final_url);
  xhttp_close(c);
  return NULL;
}

int catalog_links_check(jv urls, jw *w) {
  probe *ps = calloc(8, sizeof *ps);
  pthread_t th[8];
  int n = 0;
  if (!ps) return -1;
  JV_FOREACH(it, urls) {
    const char *u = jv_str(it, NULL);
    if (!u || n >= 8) continue;
    xstrlcpy(ps[n].url, u, sizeof ps[n].url);
    n++;
  }
  int started[8] = {0};
  for (int i = 0; i < n; i++) started[i] = pthread_create(&th[i], NULL, probe_thread, &ps[i]) == 0;
  for (int i = 0; i < n; i++) if (started[i]) pthread_join(th[i], NULL); else probe_thread(&ps[i]);
  jw_key(w, "results");
  jw_arr_begin(w);
  for (int i = 0; i < n; i++) {
    jw_obj_begin(w);
    jw_kv_str(w, "url", ps[i].url);
    jw_kv_int(w, "status", ps[i].status);
    jw_kv_i64(w, "size", ps[i].size);
    jw_kv_bool(w, "acceptRanges", ps[i].accept_ranges);
    jw_kv_str(w, "finalUrl", ps[i].final_url[0] ? ps[i].final_url : ps[i].url);
    jw_kv_int(w, "ms", ps[i].ms);
    if (ps[i].error[0]) jw_kv_str(w, "error", ps[i].error);
    jw_obj_end(w);
  }
  jw_arr_end(w);
  free(ps);
  return 0;
}

/* ---- links resolve ------------------------------------------------------ */

int catalog_host_allowed(const char *host) {
  for (size_t i = 0; i < XS_ARRAY_LEN(ALLOWED_HOSTS); i++) if (util_host_matches(host, ALLOWED_HOSTS[i])) return 1;
  return 0;
}

typedef struct link_set {
  jw *w;
  char (*seen)[1024];
  int n;
} link_set;

static int link_is_file(const char *url) {
  static const char *const exts[] = {".pkg", ".fpkg", ".ffpkg", ".ffpfsc", ".ffpfs", ".exfat", ".zip", ".rar", ".7z", ".elf", ".bin", ".iso"};
  char path[1536];
  xurl u;
  if (util_url_parse(url, &u) != 0) return 0;
  xstrlcpy(path, u.path, sizeof path);
  char *q = strchr(path, '?');
  if (q) *q = 0;
  for (size_t i = 0; i < XS_ARRAY_LEN(exts); i++) if (util_iends_with(path, exts[i])) return 1;
  return 0;
}

static void link_add(link_set *ls, const char *url, const char *label, int64_t size, const char *kind) {
  if (ls->n >= 200 || !util_istarts_with(url, "http")) return;
  xurl u;
  if (util_url_parse(url, &u) != 0 || u.has_userinfo) return;
  for (int i = 0; i < ls->n; i++) if (strcmp(ls->seen[i], url) == 0) return;
  xstrlcpy(ls->seen[ls->n++], url, 1024);
  char host[256], lab[80];
  util_url_host(url, host, sizeof host);
  xstrlcpy(lab, label && *label ? label : host, sizeof lab);
  util_trim(lab);
  jw_obj_begin(ls->w);
  jw_kv_str(ls->w, "url", url);
  jw_kv_str(ls->w, "label", lab[0] ? lab : host);
  jw_kv_str(ls->w, "host", host);
  if (size >= 0) jw_kv_i64(ls->w, "size", size);
  jw_kv_str(ls->w, "kind", kind);
  jw_obj_end(ls->w);
}

/* Link shorteners pack the destination as a (base64) url=/u=/link=/s= param. */
static int decode_gateway(const char *url, char *out, size_t cap) {
  xurl u;
  if (util_url_parse(url, &u) != 0) return -1;
  const char *q = strchr(u.path, '?');
  if (!q) return -1;
  q++;
  static const char *const keys[] = {"url=", "u=", "link=", "id=", "s="};
  while (*q) {
    const char *amp = strchr(q, '&');
    size_t plen = amp ? (size_t)(amp - q) : strlen(q);
    for (size_t k = 0; k < XS_ARRAY_LEN(keys); k++) {
      size_t kl = strlen(keys[k]);
      if (plen > kl && strncmp(q, keys[k], kl) == 0) {
        char raw[1024];
        util_url_decode(q + kl, plen - kl, raw, sizeof raw);
        if (util_istarts_with(raw, "http")) { xstrlcpy(out, raw, cap); return 0; }
        uint8_t dec[1024];
        size_t dl;
        if (util_b64_decode(raw, strlen(raw), dec, sizeof dec - 1, &dl) == 0 && dl > 8) {
          dec[dl] = 0;
          if (util_istarts_with((char *)dec, "http")) { xstrlcpy(out, (char *)dec, cap); return 0; }
        }
      }
    }
    if (!amp) break;
    q = amp + 1;
  }
  return -1;
}

/* Extracts <a href="...">text</a> anchors from HTML into the link set. */
static void extract_anchors(link_set *ls, const char *html, const char *page_host) {
  const char *p = html;
  while ((p = util_strcasestr(p, "href=")) != NULL) {
    p += 5;
    char quote = *p;
    if (quote != '"' && quote != '\'') continue;
    p++;
    const char *end = strchr(p, quote);
    if (!end || end - p >= 1000) continue;
    char url[1024];
    memcpy(url, p, (size_t)(end - p));
    url[end - p] = 0;
    util_html_unescape(url);
    p = end + 1;
    if (!util_istarts_with(url, "http")) continue;
    /* label = text up to </a>, tags stripped */
    const char *gt = strchr(p, '>');
    char label[80] = "";
    if (gt) {
      const char *close = util_strcasestr(gt, "</a>");
      size_t o = 0;
      int in_tag = 0;
      for (const char *t = gt + 1; close && t < close && o + 1 < sizeof label; t++) {
        if (*t == '<') in_tag = 1;
        else if (*t == '>') in_tag = 0;
        else if (!in_tag && (unsigned char)*t >= 0x20) label[o++] = *t;
      }
      label[o] = 0;
      util_html_unescape(label);
      util_trim(label);
    }
    if (util_strcasestr(url, "guide-download") || util_strcasestr(url, "tool-download") ||
        util_strcasestr(label, "guide download") || util_strcasestr(label, "tool download") ||
        util_strcasestr(label, "jdownload"))
      continue;
    char host[256];
    util_url_host(url, host, sizeof host);
    if (strcmp(host, page_host) == 0 && !strstr(url, "/go/")) continue;   /* site navigation */
    char dest[1024];
    if (decode_gateway(url, dest, sizeof dest) == 0) { link_add(ls, dest, label, -1, link_is_file(dest) ? "direct" : "page"); continue; }
    if (strcmp(host, page_host) == 0 && strstr(url, "/go/")) {
      if (strlen(label) >= 2 && strlen(label) <= 30) link_add(ls, url, label, -1, "gateway");
      continue;
    }
    link_add(ls, url, label, -1, link_is_file(url) ? "direct" : "page");
  }
}

static int resolve_dlpsgame(link_set *ls, const char *page_url, char *err, size_t errcap) {
  char slug[256];
  util_url_filename(page_url, slug, sizeof slug);
  if (!slug[0]) { xsnprintf(err, errcap, "cannot derive post slug from url"); return -1; }
  char enc[512], api[700];
  util_url_encode_path(slug, enc, sizeof enc);
  xsnprintf(api, sizeof api, "https://dlpsgame.com/wp-json/wp/v2/posts?slug=%s&_fields=content,link", enc);
  xhttp_req r;
  memset(&r, 0, sizeof r);
  r.url = api;
  r.range_start = r.range_end = -1;
  r.follow_redirects = 3;
  r.connect_timeout_ms = 15000;
  r.recv_timeout_ms = 20000;
  r.user_agent = "Mozilla/5.0 (PlayStation; PlayStation 5/13.60) AppleWebKit/605.1.15 (KHTML, like Gecko) XENO-STORE";
  xhttp_resp resp;
  size_t len;
  char *body = xhttp_fetch(&r, &resp, 8u << 20, &len);
  if (!body) { xsnprintf(err, errcap, "dlpsgame request failed: %s", xhttp_last_error()); return -1; }
  if (resp.status != 200) { xsnprintf(err, errcap, "dlpsgame returned HTTP %d", resp.status); free(body); return -1; }
  jdoc *d = json_parse(body, len, 20000, 16);
  free(body);
  if (!d) { xsnprintf(err, errcap, "dlpsgame returned invalid JSON"); return -1; }
  jv post = jv_at(json_root(d), 0);
  const char *html = jv_get_str(jv_get(post, "content"), "rendered", "");
  if (!*html) { json_free(d); xsnprintf(err, errcap, "post not found"); return -1; }
  /* 1) every base64 data-payload block hides the real mirror lists */
  const char *p = html;
  while ((p = strstr(p, "data-payload=\"")) != NULL) {
    p += 14;
    const char *end = strchr(p, '"');
    if (!end) break;
    size_t n = (size_t)(end - p);
    uint8_t *dec = malloc(n + 1);
    size_t dl;
    if (dec && util_b64_decode(p, n, dec, n, &dl) == 0) {
      dec[dl] = 0;
      extract_anchors(ls, (const char *)dec, "dlpsgame.com");
    }
    free(dec);
    p = end + 1;
  }
  /* 2) plain anchors in the post body (passwords, mirrors listed openly) */
  extract_anchors(ls, html, "dlpsgame.com");
  json_free(d);
  return 0;
}

static int resolve_archive(link_set *ls, const char *page_url, char *err, size_t errcap) {
  xurl u;
  if (util_url_parse(page_url, &u) != 0) { xsnprintf(err, errcap, "bad url"); return -1; }
  const char *seg = NULL;
  if (util_starts_with(u.path, "/details/")) seg = u.path + 9;
  else if (util_starts_with(u.path, "/download/")) seg = u.path + 10;
  else if (util_starts_with(u.path, "/metadata/")) seg = u.path + 10;
  if (!seg) { xsnprintf(err, errcap, "not an archive.org item url"); return -1; }
  char ident[200];
  size_t n = strcspn(seg, "/?#");
  if (n == 0 || n >= sizeof ident) { xsnprintf(err, errcap, "bad identifier"); return -1; }
  memcpy(ident, seg, n);
  ident[n] = 0;
  char api[400];
  xsnprintf(api, sizeof api, "https://archive.org/metadata/%s", ident);
  xhttp_resp resp;
  size_t len;
  char *body = fetch_text(api, 20000, 16u << 20, &len, &resp);
  if (!body) { xsnprintf(err, errcap, "archive.org request failed: %s", xhttp_last_error()); return -1; }
  if (resp.status != 200) { xsnprintf(err, errcap, "archive.org returned HTTP %d", resp.status); free(body); return -1; }
  jdoc *d = json_parse(body, len, 200000, 16);
  free(body);
  if (!d) { xsnprintf(err, errcap, "archive.org returned invalid JSON"); return -1; }
  JV_FOREACH(f, jv_get(json_root(d), "files")) {
    const char *name = jv_get_str(f, "name", "");
    if (!*name) continue;
    if (util_iends_with(name, "_meta.xml") || util_iends_with(name, "_files.xml") || util_iends_with(name, ".torrent") ||
        util_iends_with(name, "_meta.sqlite") || util_iends_with(name, "__ia_thumb.jpg") || util_iends_with(name, "_reviews.xml"))
      continue;
    const char *source = jv_get_str(f, "source", "original");
    if (strcmp(source, "derivative") == 0) continue;
    char enc[600], url[900];
    util_url_encode_path(name, enc, sizeof enc);
    xsnprintf(url, sizeof url, "https://archive.org/download/%s/%s", ident, enc);
    int64_t size = jv_get_i64(f, "size", -1);
    link_add(ls, url, name, size, "direct");
  }
  json_free(d);
  return 0;
}

static int resolve_generic(link_set *ls, const char *page_url, const char *host, char *err, size_t errcap) {
  xhttp_resp resp;
  size_t len;
  char *body = fetch_text(page_url, 20000, 8u << 20, &len, &resp);
  if (!body) { xsnprintf(err, errcap, "request failed: %s", xhttp_last_error()); return -1; }
  if (resp.status != 200) { xsnprintf(err, errcap, "host returned HTTP %d", resp.status); free(body); return -1; }
  /* Only keep links that look like files; these hosts are not link lockers. */
  link_set tmp = *ls;
  (void)tmp;
  const char *p = body;
  while ((p = util_strcasestr(p, "href=\"")) != NULL) {
    p += 6;
    const char *end = strchr(p, '"');
    if (!end || end - p >= 1000) break;
    char url[1024];
    memcpy(url, p, (size_t)(end - p));
    url[end - p] = 0;
    util_html_unescape(url);
    p = end + 1;
    char abs[1024];
    if (util_url_resolve(page_url, url, abs, sizeof abs) != 0) continue;
    if (link_is_file(abs) || strstr(abs, "/releases/download/")) {
      char fn[256];
      util_url_filename(abs, fn, sizeof fn);
      link_add(ls, abs, fn, -1, "direct");
    }
  }
  (void)host;
  free(body);
  return 0;
}

int catalog_links_resolve(const char *url, jw *w, char *err, size_t errcap) {
  err[0] = 0;
  xurl u;
  if (util_url_parse(url, &u) != 0 || u.has_userinfo) { xsnprintf(err, errcap, "invalid url"); return -1; }
  char host[256];
  util_url_host(url, host, sizeof host);
  link_set ls;
  ls.w = w;
  ls.n = 0;
  ls.seen = calloc(200, 1024);
  if (!ls.seen) { xsnprintf(err, errcap, "out of memory"); return -1; }
  jw_key(w, "links");
  jw_arr_begin(w);
  int rc = 0;
  if (!catalog_host_allowed(host)) {
    LOGI("links/resolve: host %s is not allowlisted, returning no links", host);
  } else if (util_host_matches(host, "dlpsgame.com")) {
    rc = resolve_dlpsgame(&ls, url, err, errcap);
  } else if (util_host_matches(host, "archive.org")) {
    rc = resolve_archive(&ls, url, err, errcap);
  } else if (util_host_matches(host, "vikingfile.com")) {
    /* Vikingfile gates its file link behind a human check — nothing to resolve
     * server-side; the UI opens the page in the PS5 browser instead. */
  } else {
    rc = resolve_generic(&ls, url, host, err, errcap);
  }
  jw_arr_end(w);
  jw_kv_str(w, "host", host);
  jw_kv_bool(w, "allowed", catalog_host_allowed(host));
  free(ls.seen);
  return rc;
}
