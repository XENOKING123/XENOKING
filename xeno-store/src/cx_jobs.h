/*
 * cx_jobs.h — small table of background operations run by the console
 * modules (save backups, community save installs/downloads, payload
 * installs). Each job runs on its own thread, publishes progress and a JSON
 * result, and can be cancelled. Exposed as /api/saves/jobs.
 */
#ifndef XENO_CX_JOBS_H
#define XENO_CX_JOBS_H

#include "json.h"
#include <stdint.h>
#include <time.h>

#define CXJ_MAX 64
#define CXJ_TITLE 256
#define CXJ_MSG 256
#define CXJ_RESULT 4096

typedef struct cx_job cx_job;
/* Worker: returns 0 on success (result JSON may be set), -1 with error. */
typedef int (*cx_job_fn)(cx_job *j, void *arg);

struct cx_job {
  char id[16];
  char type[24];          /* backup | save-install | save-download | payload-install | export */
  char title[CXJ_TITLE];
  char state[12];         /* queued | running | done | failed | cancelled */
  char message[CXJ_MSG];
  char error[CXJ_MSG];
  char errorCode[32];
  char result[CXJ_RESULT]; /* JSON object text ("{}" when empty) */
  int64_t done, total;
  int percent;
  time_t createdAt, startedAt, finishedAt;
  volatile int cancel;
  int in_use;
  void *arg;              /* owned by the worker; freed by cx_jobs when the job ends */
  cx_job_fn fn;
};

/* Starts a job. `arg` is malloc'd by the caller and freed by cx_jobs after
 * the worker returns. Returns 0 and the id, or -1 (table full / thread). */
int cx_job_start(const char *type, const char *title, cx_job_fn fn, void *arg, char *id_out, size_t idcap);
/* Progress helpers (called from the worker). */
void cx_job_progress(cx_job *j, int64_t done, int64_t total, const char *message);
void cx_job_set_result(cx_job *j, jw *w);          /* takes the writer's buffer */
void cx_job_fail(cx_job *j, const char *code, const char *message);
int cx_job_cancelled(const cx_job *j);
/* JSON views. */
void cx_jobs_json(jw *w);                          /* writes "jobs": [...] */
int cx_job_json(jw *w, const char *id);            /* writes the job object; -1 unknown */
int cx_job_cancel(const char *id);                 /* -1 unknown / not running */
int cx_job_wait(const char *id, int timeout_ms);   /* 1 finished, 0 timeout, -1 unknown */
int cx_jobs_active(const char *type);              /* running/queued jobs of a type ("" = any) */

#endif
