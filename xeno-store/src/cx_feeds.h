/*
 * cx_feeds.h — owner-curated JSON feeds published next to the catalog
 * (updates/featured.json, messages.json, companions.json, saves-backend.json)
 * plus a generic "cached fetch" used by the homebrew listing and the save
 * index. Feeds are refreshed with the catalog (catalog_on_refresh) and
 * cached under <data>/feeds/ so they survive offline starts.
 */
#ifndef XENO_CX_FEEDS_H
#define XENO_CX_FEEDS_H

#include "json.h"
#include <stddef.h>
#include <time.h>

enum { CX_FEED_FEATURED = 0, CX_FEED_MESSAGES, CX_FEED_COMPANIONS, CX_FEED_SAVES_BACKEND, CX_FEED_COUNT };

void cx_feeds_init(void);
/* Fetches every feed (blocking, ≤ ~15 s each); force ignores the max age. */
void cx_feeds_refresh(int force);
void cx_feeds_tick(void);
/* Writes the parsed feed value as JSON (null when absent). */
void cx_feed_json(int feed, jw *w);
/* Parsed copy of a feed (caller frees with json_free); NULL when absent. */
jdoc *cx_feed_doc(int feed);
time_t cx_feed_fetched_at(int feed);

/* Generic cache: GET url into <data>/feeds/<name>.json when the cached copy
 * is older than max_age_s (or force). Returns the text (malloc'd) or NULL;
 * *from_cache tells where it came from. */
char *cx_cached_fetch(const char *name, const char *url, int max_age_s, int force, size_t max_bytes,
                      size_t *len, int *from_cache, time_t *fetched_at);
/* Hostname allowlist for feed URLs (github raw/releases + loopback on host). */
int cx_feed_host_allowed(const char *url);

#endif
