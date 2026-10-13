/*
 * dl.h — download engine: queue, worker threads, segmented transfer, resume
 * sidecars, retries/failover, verification, completion steps (SPEC §7).
 *
 * All job state lives behind queue_mu. Worker threads never hold the lock
 * across I/O; they take it briefly to publish progress and to pick chunks.
 */
#ifndef XENO_DL_H
#define XENO_DL_H

#include "json.h"
#include <pthread.h>
#include <stdint.h>
#include <time.h>

#define DL_MAX_JOBS 256
#define DL_MAX_MIRRORS 8
#define DL_MAX_SEGMENTS 16
#define DL_HISTORY 60
#define DL_JOB_LOG_LINES 40
#define DL_JOB_LOG_LEN 160
#define DL_RESERVE_BYTES (256LL << 20)

typedef enum dl_state {
  DL_QUEUED = 0, DL_CONNECTING, DL_DOWNLOADING, DL_VERIFYING, DL_DONE,
  DL_PAUSED, DL_FAILED, DL_CANCELLED, DL_INSTALLING, DL_INSTALLED
} dl_state;

/* Why a running worker was asked to stop. */
enum { DL_STOP_NONE = 0, DL_STOP_PAUSE = 1, DL_STOP_CANCEL = 2, DL_STOP_REMOVE = 3, DL_STOP_SHUTDOWN = 4 };

typedef struct dl_chunk {
  int64_t start, end;   /* [start, end) ; end == -1 → until EOF (unknown size) */
  int64_t cur;          /* next byte to write */
  int active;           /* a segment thread owns it */
} dl_chunk;

typedef struct dl_install {
  char state[12];       /* idle | installing | installed | failed */
  char message[256];
  char contentId[40];
  char titleId[16];
  char token[24];       /* /pkgsrv/<token> for the etaHEN DPI fallback */
  char via[24];
  time_t startedAt;
  int rc;
} dl_install;

typedef struct dl_job {
  /* identity + catalog data */
  char id[16], gameId[128], title[256], titleId[16], platform[8], cover[512];
  char releaseId[128], format[16], provider[64], sourceId[32];
  char url[2048];                      /* source URL (primary) */
  char activeUrl[2048];                /* what is being fetched now (url or a mirror) */
  char mirrors[DL_MAX_MIRRORS][1024];
  int nmirrors, mirror_idx;            /* mirror_idx -1 = primary url */
  char filename[256], root[256], rootLabel[32], path[1024], xpart[1040], sidecar[1056];
  /* state */
  dl_state state;
  char phase[64], message[256], error[256], errorCode[32];
  int64_t total, written;
  double speed;
  int64_t eta;
  int connections;
  char sha256[65], sha256Expected[65], verify[8];
  int verified;
  time_t addedAt, startedAt, finishedAt, nextRetryAt;
  int attempts, priority, autoInstall, resumable;
  dl_install install;
  char etag[128], lastModified[64];
  int synthetic;                       /* library install job: no transfer */
  /* runtime (never persisted) */
  volatile int cancel;                 /* DL_STOP_* (user intent) */
  volatile int stop_io;                /* segments must abort now (cancel or fatal error) */
  volatile int running;                /* a worker thread owns the job */
  volatile int remove_pending, delete_files_pending, discard_partial;
  int fd;
  unsigned slot_mask;                  /* segment slots in use */
  int seg_retry_now, seg_err_streak, drive_missing, insecure_tls;
  dl_state verify_prev_state;
  dl_chunk *chunks;
  int nchunks;
  int64_t chunk_size;
  int segmented, window, active_segments;
  int64_t clean_bytes, last_fsync, last_space_check;
  int seg_fatal, seg_status;           /* set by a segment thread on a non-retryable error */
  char seg_error[160];
  char seg_code[32];
  int retry_after;
  int64_t last_seg_error_ms;
  int64_t last_sample_written, last_sample_ms;
  int64_t hist[DL_HISTORY];
  int hist_n, hist_head;
  char log[DL_JOB_LOG_LINES][DL_JOB_LOG_LEN];
  int log_n, log_head;
  int64_t last_sidecar_ms;
  int probe_status;
  int url_replaced;
  void *seg_conns[DL_MAX_SEGMENTS];    /* xhttp_conn* per slot for prompt abort */
} dl_job;

typedef struct dl_add_req {
  const char *gameId, *releaseId, *root, *url, *filename, *format, *title, *sha256;
  jv mirrors;               /* optional JSON array of extra mirror URLs */
  int64_t size;             /* expected size for raw urls (0 = unknown) */
  int connections;          /* 0 = settings default */
  int verify;               /* -1 default, 0/1 */
  int autoInstall;          /* -1 default, 0/1 */
  int overwrite;
} dl_add_req;

typedef struct dl_summary {
  int active, queued, paused, failed, done;
  int64_t speed, remaining, eta;
  int keepAwake;
} dl_summary;

int dl_init(const char *data_dir, int port);
void dl_shutdown(void);
/* Called by the housekeeping thread every ~500 ms. */
void dl_housekeeping_tick(void);
void dl_save_queue(void);

/* Returns 0 and the new job id, or -1 with errcode/errmsg (SPEC §6.3 codes). */
int dl_add(const dl_add_req *req, char *job_id, size_t idcap, char *errcode, size_t ccap, char *errmsg, size_t mcap);
/* action ∈ pause resume cancel retry remove restart install verify move url */
int dl_action(const char *id, const char *action, jv body, char *errcode, size_t ccap, char *errmsg, size_t mcap);
int dl_clear(jv states);
/* Library install: synthetic job in state installing for a scanned .pkg. */
int dl_add_install_job(const char *path, char *job_id, size_t idcap, char *errmsg, size_t mcap);

void dl_queue_json(jw *w, int history);             /* writes "jobs" + "summary" */
int dl_job_json(jw *w, const char *id, int history);/* writes the job object (key set by caller) */
int dl_job_log_json(jw *w, const char *id);          /* writes "lines" */
void dl_summary_get(dl_summary *out);
int64_t dl_remaining_on_root(const char *root);
int dl_any_downloading(void);
int dl_find_job_by_path(const char *path, char *id, size_t cap);
const char *dl_state_name(dl_state s);

#endif
