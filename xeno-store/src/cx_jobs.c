/*
 * cx_jobs.c — see cx_jobs.h. One mutex guards the table; workers copy what
 * they need and only take the lock to publish progress.
 */
#include "cx_jobs.h"
#include "log.h"
#include "util.h"

#include <pthread.h>
#include <stdlib.h>
#include <string.h>

static pthread_mutex_t jobs_mu = PTHREAD_MUTEX_INITIALIZER;
static cx_job jobs[CXJ_MAX];

static cx_job *find_locked(const char *id) {
  for (int i = 0; i < CXJ_MAX; i++) if (jobs[i].in_use && strcmp(jobs[i].id, id) == 0) return &jobs[i];
  return NULL;
}

static int finished(const cx_job *j) {
  return strcmp(j->state, "done") == 0 || strcmp(j->state, "failed") == 0 || strcmp(j->state, "cancelled") == 0;
}

/* Frees the oldest finished entry when the table is full. */
static cx_job *alloc_locked(void) {
  for (int i = 0; i < CXJ_MAX; i++) if (!jobs[i].in_use) return &jobs[i];
  cx_job *oldest = NULL;
  for (int i = 0; i < CXJ_MAX; i++)
    if (finished(&jobs[i]) && (!oldest || jobs[i].finishedAt < oldest->finishedAt)) oldest = &jobs[i];
  return oldest;
}

static void *worker(void *p) {
  cx_job *j = p;
  pthread_mutex_lock(&jobs_mu);
  xstrlcpy(j->state, "running", sizeof j->state);
  j->startedAt = util_now();
  cx_job_fn fn = j->fn;
  void *arg = j->arg;
  pthread_mutex_unlock(&jobs_mu);
  int rc = fn(j, arg);
  pthread_mutex_lock(&jobs_mu);
  if (j->cancel && rc != 0) xstrlcpy(j->state, "cancelled", sizeof j->state);
  else if (rc != 0) { xstrlcpy(j->state, "failed", sizeof j->state); if (!j->error[0]) xstrlcpy(j->error, "operation failed", sizeof j->error); }
  else { xstrlcpy(j->state, "done", sizeof j->state); j->percent = 100; if (j->total > 0) j->done = j->total; }
  j->finishedAt = util_now();
  j->arg = NULL;
  pthread_mutex_unlock(&jobs_mu);
  free(arg);
  LOGI("job %s (%s) %s%s%s", j->id, j->type, j->state, j->error[0] ? ": " : "", j->error);
  return NULL;
}

int cx_job_start(const char *type, const char *title, cx_job_fn fn, void *arg, char *id_out, size_t idcap) {
  pthread_mutex_lock(&jobs_mu);
  cx_job *j = alloc_locked();
  if (!j) { pthread_mutex_unlock(&jobs_mu); return -1; }
  memset(j, 0, sizeof *j);
  j->in_use = 1;
  util_rand_id("s_", j->id, sizeof j->id);
  xstrlcpy(j->type, type, sizeof j->type);
  xstrlcpy(j->title, title, sizeof j->title);
  xstrlcpy(j->state, "queued", sizeof j->state);
  xstrlcpy(j->result, "{}", sizeof j->result);
  j->createdAt = util_now();
  j->fn = fn;
  j->arg = arg;
  xstrlcpy(id_out, j->id, idcap);
  pthread_t th;
  pthread_attr_t at;
  pthread_attr_init(&at);
  pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
  pthread_attr_setstacksize(&at, 1 << 20);
  int rc = pthread_create(&th, &at, worker, j);
  pthread_attr_destroy(&at);
  if (rc != 0) { j->in_use = 0; pthread_mutex_unlock(&jobs_mu); return -1; }
  pthread_mutex_unlock(&jobs_mu);
  return 0;
}

void cx_job_progress(cx_job *j, int64_t done, int64_t total, const char *message) {
  pthread_mutex_lock(&jobs_mu);
  j->done = done;
  j->total = total;
  j->percent = total > 0 ? (int)(done * 100 / total) : 0;
  if (j->percent > 100) j->percent = 100;
  if (message) xstrlcpy(j->message, message, sizeof j->message);
  pthread_mutex_unlock(&jobs_mu);
}

void cx_job_set_result(cx_job *j, jw *w) {
  size_t len;
  char *txt = jw_detach(w, &len);
  pthread_mutex_lock(&jobs_mu);
  if (txt && len < sizeof j->result) memcpy(j->result, txt, len + 1);
  else xstrlcpy(j->result, "{}", sizeof j->result);
  pthread_mutex_unlock(&jobs_mu);
  free(txt);
}

void cx_job_fail(cx_job *j, const char *code, const char *message) {
  pthread_mutex_lock(&jobs_mu);
  xstrlcpy(j->errorCode, code ? code : "failed", sizeof j->errorCode);
  xstrlcpy(j->error, message ? message : "operation failed", sizeof j->error);
  pthread_mutex_unlock(&jobs_mu);
}

int cx_job_cancelled(const cx_job *j) { return j->cancel; }

static void job_json_locked(jw *w, const cx_job *j) {
  jw_obj_begin(w);
  jw_kv_str(w, "id", j->id);
  jw_kv_str(w, "type", j->type);
  jw_kv_str(w, "title", j->title);
  jw_kv_str(w, "state", j->state);
  jw_kv_str(w, "message", j->message);
  jw_kv_str(w, "error", j->error);
  jw_kv_str(w, "errorCode", j->errorCode);
  jw_kv_i64(w, "done", j->done);
  jw_kv_i64(w, "total", j->total);
  jw_kv_int(w, "percent", j->percent);
  jw_kv_i64(w, "createdAt", (int64_t)j->createdAt);
  jw_kv_i64(w, "startedAt", (int64_t)j->startedAt);
  jw_kv_i64(w, "finishedAt", (int64_t)j->finishedAt);
  jw_kv_raw(w, "result", j->result, strlen(j->result));
  jw_obj_end(w);
}

void cx_jobs_json(jw *w) {
  pthread_mutex_lock(&jobs_mu);
  jw_key(w, "jobs");
  jw_arr_begin(w);
  for (int i = 0; i < CXJ_MAX; i++) if (jobs[i].in_use) job_json_locked(w, &jobs[i]);
  jw_arr_end(w);
  pthread_mutex_unlock(&jobs_mu);
}

int cx_job_json(jw *w, const char *id) {
  pthread_mutex_lock(&jobs_mu);
  cx_job *j = find_locked(id);
  if (j) job_json_locked(w, j);
  pthread_mutex_unlock(&jobs_mu);
  return j ? 0 : -1;
}

int cx_job_cancel(const char *id) {
  pthread_mutex_lock(&jobs_mu);
  cx_job *j = find_locked(id);
  int rc = -1;
  if (j && !finished(j)) { j->cancel = 1; rc = 0; }
  pthread_mutex_unlock(&jobs_mu);
  return rc;
}

int cx_job_wait(const char *id, int timeout_ms) {
  int64_t until = util_now_ms() + timeout_ms;
  for (;;) {
    pthread_mutex_lock(&jobs_mu);
    cx_job *j = find_locked(id);
    int st = j ? (finished(j) ? 1 : 0) : -1;
    pthread_mutex_unlock(&jobs_mu);
    if (st != 0) return st;
    if (util_now_ms() >= until) return 0;
    util_sleep_ms(50);
  }
}

int cx_jobs_active(const char *type) {
  int n = 0;
  pthread_mutex_lock(&jobs_mu);
  for (int i = 0; i < CXJ_MAX; i++)
    if (jobs[i].in_use && !finished(&jobs[i]) && (!type || !*type || strcmp(jobs[i].type, type) == 0)) n++;
  pthread_mutex_unlock(&jobs_mu);
  return n;
}
