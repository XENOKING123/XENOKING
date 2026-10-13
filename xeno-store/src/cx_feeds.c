/*
 * cx_feeds.c — see cx_feeds.h.
 */
#include "cx_feeds.h"
#include "cx_common.h"
#include "http_client.h"
#include "log.h"
#include "settings.h"
#include "util.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FEED_MAX_AGE_S (6 * 3600)
#define FEED_MAX_BYTES (2u << 20)
#define FEED_FIRST_DELAY_S 20

static pthread_mutex_t feeds_mu = PTHREAD_MUTEX_INITIALIZER;
static struct {
  const char *name;
  char *text;
  size_t len;
  time_t fetchedAt;
} feeds[CX_FEED_COUNT] = { {"featured", NULL, 0, 0}, {"messages", NULL, 0, 0}, {"companions", NULL, 0, 0}, {"saves-backend", NULL, 0, 0} };
static time_t boot_at, last_auto;
static volatile int refreshing;

static const char *const FEED_HOSTS[] = {"raw.githubusercontent.com", "github.com", "githubusercontent.com", "api.github.com"};

int cx_feed_host_allowed(const char *url) {
  char host[256];
  util_url_host(url, host, sizeof host);
  return cx_host_in(host, FEED_HOSTS, XS_ARRAY_LEN(FEED_HOSTS)) || cx_host_is_loopback(host);
}

static void cache_path(const char *name, char *out, size_t cap) { xsnprintf(out, cap, "%s/feeds/%s.json", cx_data_dir(), name); }

char *cx_cached_fetch(const char *name, const char *url, int max_age_s, int force, size_t max_bytes,
                      size_t *len, int *from_cache, time_t *fetched_at) {
  char path[700];
  cache_path(name, path, sizeof path);
  time_t mt = util_file_mtime(path);
  time_t now = util_now();
  if (from_cache) *from_cache = 0;
  if (fetched_at) *fetched_at = mt;
  if (!force && mt > 0 && now - mt < max_age_s) {
    char *txt = util_read_file(path, len, max_bytes);
    if (txt) { if (from_cache) *from_cache = 1; return txt; }
  }
  char *fresh = NULL;
  if (url && *url && xhttp_available()) {
    if (!cx_feed_host_allowed(url)) LOGW("feeds: %s host not allowed (%s)", name, url);
    else {
      int status = 0;
      size_t l = 0;
      cx_http o = {0};
      o.max_bytes = max_bytes;
      o.headers = "Cache-Control: no-cache\r\n";
      fresh = cx_fetch(url, &o, &status, &l, NULL);
      if (fresh && status == 200 && l > 0) {
        jdoc *d = json_parse(fresh, l, 200000, 32);
        if (d) {
          json_free(d);
          char dir[700];
          xsnprintf(dir, sizeof dir, "%s/feeds", cx_data_dir());
          util_mkdir_p(dir);
          if (util_write_file_atomic(path, fresh, l) != 0) LOGW("feeds: cannot cache %s", name);
          if (len) *len = l;
          if (fetched_at) *fetched_at = now;
          return fresh;
        }
        LOGW("feeds: %s is not valid JSON", name);
      } else if (fresh) LOGW("feeds: %s returned HTTP %d", name, status);
      else LOGW("feeds: %s fetch failed: %s", name, xhttp_last_error());
      free(fresh);
      fresh = NULL;
    }
  }
  /* fall back to whatever is cached, however old */
  char *txt = util_read_file(path, len, max_bytes);
  if (txt && from_cache) *from_cache = 1;
  return txt;
}

static const char *feed_url(const settings_t *s, int feed) {
  switch (feed) {
    case CX_FEED_FEATURED: return s->featuredUrl;
    case CX_FEED_MESSAGES: return s->messagesUrl;
    case CX_FEED_COMPANIONS: return s->companionsUrl;
    default: return s->savesBackendUrl;
  }
}

static void load_one(int feed, int force) {
  settings_t s;
  settings_get(&s);
  size_t len = 0;
  int from_cache = 0;
  time_t at = 0;
  char *txt = cx_cached_fetch(feeds[feed].name, feed_url(&s, feed), FEED_MAX_AGE_S, force, FEED_MAX_BYTES, &len, &from_cache, &at);
  pthread_mutex_lock(&feeds_mu);
  free(feeds[feed].text);
  feeds[feed].text = txt;
  feeds[feed].len = txt ? len : 0;
  feeds[feed].fetchedAt = txt ? at : 0;
  pthread_mutex_unlock(&feeds_mu);
}

void cx_feeds_init(void) {
  boot_at = util_now();
  /* Offline start: load the cached copies without touching the network. */
  for (int i = 0; i < CX_FEED_COUNT; i++) {
    char path[700];
    cache_path(feeds[i].name, path, sizeof path);
    size_t len = 0;
    char *txt = util_read_file(path, &len, FEED_MAX_BYTES);
    pthread_mutex_lock(&feeds_mu);
    feeds[i].text = txt;
    feeds[i].len = txt ? len : 0;
    feeds[i].fetchedAt = txt ? util_file_mtime(path) : 0;
    pthread_mutex_unlock(&feeds_mu);
  }
}

void cx_feeds_refresh(int force) {
  if (refreshing) return;
  refreshing = 1;
  for (int i = 0; i < CX_FEED_COUNT; i++) load_one(i, force);
  refreshing = 0;
}

void catalog_on_refresh(int updated) {
  (void)updated;
  cx_feeds_refresh(0);
}

static void *refresh_thread(void *arg) {
  (void)arg;
  cx_feeds_refresh(0);
  return NULL;
}

void cx_feeds_tick(void) {
  time_t now = util_now();
  if (!xhttp_available() || now - boot_at < FEED_FIRST_DELAY_S) return;
  if (last_auto && now - last_auto < FEED_MAX_AGE_S) return;
  settings_t s;
  settings_get(&s);
  if (!s.catalogAutoRefresh) { last_auto = now; return; }
  last_auto = now;
  pthread_t th;
  pthread_attr_t at;
  pthread_attr_init(&at);
  pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
  if (pthread_create(&th, &at, refresh_thread, NULL) != 0) LOGW("feeds: cannot start refresh thread");
  pthread_attr_destroy(&at);
}

void cx_feed_json(int feed, jw *w) {
  jdoc *d = cx_feed_doc(feed);
  if (!d) { jw_null(w); return; }
  jw_value(w, json_root(d));
  json_free(d);
}

jdoc *cx_feed_doc(int feed) {
  if (feed < 0 || feed >= CX_FEED_COUNT) return NULL;
  pthread_mutex_lock(&feeds_mu);
  jdoc *d = feeds[feed].text ? json_parse(feeds[feed].text, feeds[feed].len, 200000, 32) : NULL;
  pthread_mutex_unlock(&feeds_mu);
  return d;
}

time_t cx_feed_fetched_at(int feed) {
  if (feed < 0 || feed >= CX_FEED_COUNT) return 0;
  pthread_mutex_lock(&feeds_mu);
  time_t t = feeds[feed].fetchedAt;
  pthread_mutex_unlock(&feeds_mu);
  return t;
}
