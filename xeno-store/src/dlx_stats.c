/* dlx_stats.c — see dlx_stats.h. */
#include "dlx_stats.h"
#include "log.h"
#include "util.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_PROVIDERS 48

typedef struct provider_stat { char name[64]; int64_t bytes; int64_t jobs; double best; } provider_stat;

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static char g_path[600];
static struct {
  int64_t totalBytes, totalJobs;
  double bestSpeed, avgSpeed, totalSeconds;
  provider_stat providers[MAX_PROVIDERS];
  int n_providers;
  time_t since, updatedAt;
  int dirty;
} S;

static void load_locked(void) {
  size_t len;
  char *txt = util_read_file(g_path, &len, 1u << 20);
  if (!txt) return;
  jdoc *d = json_parse(txt, len, 5000, 8);
  free(txt);
  if (!d) { LOGW("stats: %s is not valid JSON — starting fresh", g_path); return; }
  jv o = json_root(d);
  S.totalBytes = jv_get_i64(o, "totalBytes", 0);
  S.totalJobs = jv_get_i64(o, "totalJobs", 0);
  S.bestSpeed = jv_get_dbl(o, "bestSpeed", 0);
  S.avgSpeed = jv_get_dbl(o, "avgSpeed", 0);
  S.totalSeconds = jv_get_dbl(o, "totalSeconds", 0);
  S.since = (time_t)jv_get_i64(o, "since", 0);
  S.updatedAt = (time_t)jv_get_i64(o, "updatedAt", 0);
  S.n_providers = 0;
  JV_FOREACH(p, jv_get(o, "byProvider")) {
    const char *name = jv_key(p);
    if (!name || !*name || S.n_providers >= MAX_PROVIDERS) continue;
    provider_stat *ps = &S.providers[S.n_providers++];
    xstrlcpy(ps->name, name, sizeof ps->name);
    ps->bytes = jv_get_i64(p, "bytes", 0);
    ps->jobs = jv_get_i64(p, "jobs", 0);
    ps->best = jv_get_dbl(p, "bestSpeed", 0);
  }
  json_free(d);
  if (S.totalBytes < 0) S.totalBytes = 0;
  if (S.totalJobs < 0) S.totalJobs = 0;
}

void dlx_stats_init(const char *data_dir) {
  pthread_mutex_lock(&mu);
  xsnprintf(g_path, sizeof g_path, "%s/stats.json", data_dir);
  memset(&S, 0, sizeof S);
  load_locked();
  if (!S.since) S.since = util_now();
  pthread_mutex_unlock(&mu);
}

static void write_locked(jw *w) {
  jw_obj_begin(w);
  jw_kv_int(w, "v", 1);
  jw_kv_i64(w, "totalBytes", S.totalBytes);
  jw_kv_i64(w, "totalJobs", S.totalJobs);
  jw_kv_i64(w, "bestSpeed", (int64_t)S.bestSpeed);
  jw_kv_i64(w, "avgSpeed", (int64_t)S.avgSpeed);
  jw_kv_double(w, "totalSeconds", S.totalSeconds);
  jw_key(w, "byProvider"); jw_obj_begin(w);
  for (int i = 0; i < S.n_providers; i++) {
    jw_key(w, S.providers[i].name); jw_obj_begin(w);
    jw_kv_i64(w, "bytes", S.providers[i].bytes);
    jw_kv_i64(w, "jobs", S.providers[i].jobs);
    jw_kv_i64(w, "bestSpeed", (int64_t)S.providers[i].best);
    jw_obj_end(w);
  }
  jw_obj_end(w);
  jw_kv_i64(w, "since", (int64_t)S.since);
  jw_kv_i64(w, "updatedAt", (int64_t)S.updatedAt);
  jw_obj_end(w);
}

static void flush_locked(void) {
  jw w;
  jw_init(&w);
  write_locked(&w);
  size_t len;
  char *txt = jw_detach(&w, &len);
  if (txt) {
    if (util_write_file_atomic(g_path, txt, len) != 0) LOGW("stats: cannot write %s", g_path);
    else S.dirty = 0;
    free(txt);
  }
}

void dlx_stats_record(const char *provider, int64_t bytes, double seconds, double peak) {
  if (bytes <= 0) return;
  pthread_mutex_lock(&mu);
  S.totalBytes += bytes;
  S.totalJobs++;
  if (seconds > 0) S.totalSeconds += seconds;
  if (peak > S.bestSpeed) S.bestSpeed = peak;
  S.avgSpeed = S.totalSeconds > 0 ? (double)S.totalBytes / S.totalSeconds : 0;
  const char *name = provider && *provider ? provider : "other";
  provider_stat *ps = NULL;
  for (int i = 0; i < S.n_providers; i++) if (strcmp(S.providers[i].name, name) == 0) { ps = &S.providers[i]; break; }
  if (!ps && S.n_providers < MAX_PROVIDERS) { ps = &S.providers[S.n_providers++]; memset(ps, 0, sizeof *ps); xstrlcpy(ps->name, name, sizeof ps->name); }
  if (ps) { ps->bytes += bytes; ps->jobs++; if (peak > ps->best) ps->best = peak; }
  S.updatedAt = util_now();
  S.dirty = 1;
  flush_locked();
  pthread_mutex_unlock(&mu);
}

void dlx_stats_json(jw *w) {
  pthread_mutex_lock(&mu);
  jw_kv_i64(w, "totalBytes", S.totalBytes);
  jw_kv_i64(w, "totalJobs", S.totalJobs);
  jw_kv_i64(w, "bestSpeed", (int64_t)S.bestSpeed);
  jw_kv_i64(w, "avgSpeed", (int64_t)S.avgSpeed);
  jw_kv_double(w, "totalSeconds", S.totalSeconds);
  jw_key(w, "byProvider"); jw_obj_begin(w);
  for (int i = 0; i < S.n_providers; i++) {
    jw_key(w, S.providers[i].name); jw_obj_begin(w);
    jw_kv_i64(w, "bytes", S.providers[i].bytes);
    jw_kv_i64(w, "jobs", S.providers[i].jobs);
    jw_kv_i64(w, "bestSpeed", (int64_t)S.providers[i].best);
    jw_obj_end(w);
  }
  jw_obj_end(w);
  jw_kv_i64(w, "since", (int64_t)S.since);
  jw_kv_i64(w, "updatedAt", (int64_t)S.updatedAt);
  pthread_mutex_unlock(&mu);
}

void dlx_stats_flush(int force) {
  pthread_mutex_lock(&mu);
  if (S.dirty || force) flush_locked();
  pthread_mutex_unlock(&mu);
}

int dlx_stats_reset(void) {
  pthread_mutex_lock(&mu);
  memset(&S, 0, sizeof S);
  S.since = util_now();
  S.updatedAt = S.since;
  S.dirty = 1;
  flush_locked();
  pthread_mutex_unlock(&mu);
  return 0;
}
