/*
 * catalog.h — the game catalog: embedded blob (assets.h), cached refreshed
 * copy in the data dir, GitHub refresh, server-side search, lookups used by
 * the queue, and the link check/resolve helpers (SPEC §4.5, §6.2).
 */
#ifndef XENO_CATALOG_H
#define XENO_CATALOG_H

#include "json.h"
#include <stddef.h>
#include <stdint.h>

#define CAT_MAX_MIRRORS 8
#define CAT_MAX_TITLEIDS 4

typedef struct cat_game {
  char id[128], slug[128], title[256], platform[8], region[16], publisher[128];
  char cover[512], hero[512];
  char titleIds[CAT_MAX_TITLEIDS][16];
  int ntitleIds;
  int64_t sizeMin, sizeMax;
  int verified, featured;
  double popularity;
  char releaseDate[16];
} cat_game;

typedef struct cat_release {
  char id[128], titleId[16], region[16], version[32], format[16], kind[16];
  char provider[64], sourceId[32];
  char filename[256], url[2048], browserUrl[1024], sha256[65], md5[33], password[64];
  int64_t sizeBytes;
  int consoleVerified, verified;
  char mirrors[CAT_MAX_MIRRORS][1024];
  int nmirrors;
} cat_release;

/* A served snapshot of the catalog text (refcounted so a refresh can swap the
 * current blob while a slow client is still being sent the old one). */
typedef struct catalog_blob {
  unsigned char *data;        /* owned unless embedded */
  size_t len;
  const unsigned char *gz;    /* NULL when no gzip variant (cached copies) */
  size_t gz_len;
  char etag[64];
  int64_t revision;
  int embedded;
  int refs;
} catalog_blob;

int catalog_init(const char *data_dir);
int64_t catalog_revision(void);
int catalog_game_count(void);
int catalog_release_count(void);
/* Writes "revision","generatedAt","games","releases","source","updatedAt". */
void catalog_status_json(jw *w);
/* Writes the full /api/catalog/info body (without the ok flag). */
void catalog_info_json(jw *w);
/* Blocking refresh (≤ 60 s). updated=1 when a newer catalog was installed. */
int catalog_refresh(int force, int *updated, char *err, size_t errcap);
catalog_blob *catalog_blob_acquire(void);
void catalog_blob_release(catalog_blob *b);

/* Server-side search. platform "" | "PS5" | "PS4". Writes an "items" array. */
int catalog_search(const char *q, const char *platform, int limit, jw *w);
int catalog_find_game(const char *gameId, cat_game *out);
int catalog_find_release(const char *gameId, const char *releaseId, cat_game *g, cat_release *r);
/* Fills mirrors[] (max entries) for a release: explicit mirrors, then other
 * releases of the same game with the same format and size, ranked
 * verified-direct > same provider > others. Returns the count. */
int catalog_collect_mirrors(const char *gameId, const cat_release *r, char (*out)[1024], int max);
int catalog_match_titleid(const char *titleId, cat_game *out);
/* Fuzzy match by (already cleaned) title; platform may be "". */
int catalog_match_title(const char *title, const char *platform, cat_game *out);
/* Writes a gameSummary object for a game node (used by search + library). */
void catalog_game_summary_json(jw *w, jv game);
/* Runs fn(game, user) under the catalog lock for one game (-1 when unknown)
 * or for every game (returns the count). The jv is only valid inside fn. */
typedef void (*catalog_visit_fn)(jv game, void *user);
int catalog_visit_game(const char *gameId, catalog_visit_fn fn, void *user);
int catalog_visit_games(catalog_visit_fn fn, void *user);
/* Called after every refresh attempt (updated or not) so feed caches can
 * follow the catalog cadence. Implemented by cx_feeds.c (weak: optional). */
void catalog_on_refresh(int updated) __attribute__((weak));

/* POST /api/links/check: urls is a JSON array; writes a "results" array. */
int catalog_links_check(jv urls, jw *w);
/* POST /api/links/resolve: writes a "links" array; unknown hosts → empty. */
int catalog_links_resolve(const char *url, jw *w, char *err, size_t errcap);
/* Outbound host allowlist used by resolve (SPEC §15). */
int catalog_host_allowed(const char *host);

#endif
