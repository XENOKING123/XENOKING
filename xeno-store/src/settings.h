/*
 * settings.h — settings/favorites/collections/recent persistence (SPEC §9).
 *
 * The settings live in a plain C struct guarded by settings_mu; callers take
 * a snapshot with settings_get() (cheap memcpy) instead of holding the lock.
 */
#ifndef XENO_SETTINGS_H
#define XENO_SETTINGS_H

#include "json.h"
#include <stdint.h>
#include <time.h>

#define SET_MAX_SOURCES 24
#define SET_MAX_FAVORITES 4000
#define SET_MAX_COLLECTIONS 32
#define SET_MAX_COLLECTION_IDS 1000
#define SET_RECENT_KEEP 30
#define SET_ID_LEN 96

typedef struct settings {
  /* general */
  char language[12];
  char theme[24];
  char cardSize[4];
  int reduceMotion, sounds, hints, showPs4, adultFilter;
  /* downloads */
  char defaultRoot[256];
  int connections, concurrentJobs;
  int64_t maxBytesPerSec;
  int verifyHashes, autoInstallPkg, shadowMountScan, keepAwake, retryMax, allowInsecureTls;
  char scheduleStart[8], scheduleEnd[8];
  /* sources */
  struct { char id[32]; int enabled; } sources[SET_MAX_SOURCES];
  int n_sources;
  int sourcesAcknowledged;
  /* catalog */
  int catalogAutoRefresh;
  char catalogUrl[512], catalogRevisionUrl[512];
  time_t catalogLastCheck;
  /* notifications */
  int toasts, onComplete, onFail, onInstall;
  /* updates */
  int updatesAutoCheck;
  char updatesFeed[512];
  time_t updatesLastCheck;
  /* pairing */
  char pin[8];
} settings_t;

void settings_init(const char *data_dir);
void settings_get(settings_t *out);
/* Partial merge of a JSON object (unknown keys ignored, ranges clamped), then
 * atomic save. Returns 0 or -1 with err filled. */
int settings_merge(jv obj, char *err, size_t errcap);
void settings_write_json(jw *w);
int settings_source_enabled(const char *source_id);
void settings_touch_catalog_check(void);
void settings_touch_updates_check(void);

/* favorites */
void settings_favorites_json(jw *w);          /* {"ok":true,"ids":[...]} body part: writes "ids" key */
int settings_favorites_set(jv ids);
int settings_favorite_toggle(const char *id);  /* returns new state 0/1 */
int settings_is_favorite(const char *id);
int settings_favorites_list(char (*out)[SET_ID_LEN], int max);

/* collections */
void settings_collections_json(jw *w);        /* writes "collections" key */
int settings_collections_set(jv list, char *err, size_t errcap);

/* recent */
void settings_recent_json(jw *w);             /* writes "ids" key */
void settings_recent_add(const char *id);

/* export / import */
void settings_export_json(jw *w);             /* whole object incl. settings/favorites/collections/recent */
int settings_import_json(jv obj, char *err, size_t errcap);

#endif
