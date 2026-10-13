/*
 * dl.c — see dl.h. Behaviour is specified in SPEC §7.
 *
 * Threads:
 *   housekeeping (main.c) → dl_housekeeping_tick(): scheduler, retry timers,
 *     install polling, periodic queue.json saves, keep-awake ticks.
 *   job worker (one per running job): probe, resume plan, coordinates the
 *     segment threads, samples speed, persists the sidecar, finishes.
 *   segment threads (≤ connections per job): take chunks from the shared
 *     plan (work-stealing: an idle thread splits the biggest active chunk),
 *     stream with Range requests and pwrite() straight into the .xpart file.
 *
 * Locking: queue_mu guards every job field. Worker/segment threads hold it
 * only for short bookkeeping, never across network or disk I/O. The only
 * lock ever taken under queue_mu is log_mu (SPEC §5); settings snapshots are
 * taken before locking and pkgsrv tokens are released after unlocking.
 */
#include "dl.h"
#include "catalog.h"
#include "config.h"
#include "http_client.h"
#include "install.h"
#include "log.h"
#include "settings.h"
#include "sha256.h"
#include "storage.h"
#include "sys.h"
#include "util.h"

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define SEG_BUF (512u << 10)
#define MIN_CHUNK (16LL << 20)
#define SPLIT_MIN (8LL << 20)        /* steal only when ≥ 2× this remains */
#define FSYNC_EVERY (256LL << 20)
#define SPACE_CHECK_EVERY (1LL << 30)
#define WINDOW_GROW_BYTES (64LL << 20)
#define TAIL_CHECK_BYTES (64 << 10)
#define MAX_CHUNKS 512
#define SIDECAR_EVERY_MS 5000
#define QUEUE_SAVE_EVERY_MS 5000
#define SEG_RESPAWN_DELAY_MS 2000

/* Outcomes of the probe/transfer phases. */
enum { OUT_DONE = 0, OUT_RETRY, OUT_FAILOVER, OUT_FATAL, OUT_STOPPED };

static pthread_mutex_t queue_mu = PTHREAD_MUTEX_INITIALIZER;
static dl_job *jobs[DL_MAX_JOBS];
static int n_jobs;
static char data_dir[512];
static int g_port;
static int queue_dirty;
static int64_t last_save_ms;
static time_t last_keepawake;
static int64_t last_install_poll_ms;

static pthread_mutex_t bucket_mu = PTHREAD_MUTEX_INITIALIZER;
static int64_t bucket_tokens, bucket_last_ms, bucket_rate;

static const int BACKOFF_S[] = {5, 15, 45, 120, 300};

/* ---- small helpers ------------------------------------------------------ */

const char *dl_state_name(dl_state s) {
  switch (s) {
    case DL_QUEUED: return "queued";
    case DL_CONNECTING: return "connecting";
    case DL_DOWNLOADING: return "downloading";
    case DL_VERIFYING: return "verifying";
    case DL_DONE: return "done";
    case DL_PAUSED: return "paused";
    case DL_FAILED: return "failed";
    case DL_CANCELLED: return "cancelled";
    case DL_INSTALLING: return "installing";
    case DL_INSTALLED: return "installed";
  }
  return "queued";
}

static int state_from_name(const char *s) {
  for (int i = DL_QUEUED; i <= DL_INSTALLED; i++) if (strcmp(dl_state_name((dl_state)i), s) == 0) return i;
  return DL_QUEUED;
}

static int is_pkg_format(const char *f) { return util_strieq(f, "pkg") || util_strieq(f, "fpkg"); }
static int is_image_format(const char *f) {
  return util_strieq(f, "exfat") || util_strieq(f, "ffpfsc") || util_strieq(f, "ffpkg") || util_strieq(f, "ffpfs");
}
static int state_is_active(dl_state s) { return s == DL_CONNECTING || s == DL_DOWNLOADING || s == DL_VERIFYING; }
static int state_is_unfinished(dl_state s) { return s == DL_QUEUED || s == DL_PAUSED || state_is_active(s); }

static void jlog_locked(dl_job *j, const char *fmt, ...) XS_PRINTF(2, 3);
static void jlog_locked(dl_job *j, const char *fmt, ...) {
  char msg[DL_JOB_LOG_LEN];
  va_list ap;
  va_start(ap, fmt);
  xvsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);
  time_t t = util_now();
  struct tm tm;
  localtime_r(&t, &tm);
  char *slot = j->log[(j->log_head + j->log_n) % DL_JOB_LOG_LINES];
  if (j->log_n == DL_JOB_LOG_LINES) { slot = j->log[j->log_head]; j->log_head = (j->log_head + 1) % DL_JOB_LOG_LINES; }
  else j->log_n++;
  xsnprintf(slot, DL_JOB_LOG_LEN, "%02d:%02d:%02d %s", tm.tm_hour, tm.tm_min, tm.tm_sec, msg);
  LOGI("[%s] %s", j->id, msg);
}

static void jlog(dl_job *j, const char *fmt, ...) XS_PRINTF(2, 3);
static void jlog(dl_job *j, const char *fmt, ...) {
  char msg[DL_JOB_LOG_LEN];
  va_list ap;
  va_start(ap, fmt);
  xvsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);
  pthread_mutex_lock(&queue_mu);
  jlog_locked(j, "%s", msg);
  pthread_mutex_unlock(&queue_mu);
}

static dl_job *find_locked(const char *id) {
  for (int i = 0; i < n_jobs; i++) if (strcmp(jobs[i]->id, id) == 0) return jobs[i];
  return NULL;
}

static void set_error_locked(dl_job *j, const char *code, const char *msg) {
  xstrlcpy(j->errorCode, code, sizeof j->errorCode);
  xstrlcpy(j->error, msg, sizeof j->error);
  xstrlcpy(j->message, msg, sizeof j->message);
}

static void clear_error_locked(dl_job *j) {
  j->errorCode[0] = j->error[0] = j->message[0] = j->phase[0] = 0;
}

static void remove_partial_files(dl_job *j) {
  util_unlink_quiet(j->xpart);
  util_unlink_quiet(j->sidecar);
}

static void job_free(dl_job *j) {
  if (!j) return;
  if (j->fd >= 0) close(j->fd);
  free(j->chunks);
  free(j);
}

/* ---- bandwidth token bucket --------------------------------------------- */

static void bucket_wait(size_t n) {
  for (;;) {
    pthread_mutex_lock(&bucket_mu);
    int64_t rate = bucket_rate;
    if (rate <= 0) { pthread_mutex_unlock(&bucket_mu); return; }
    int64_t now = util_now_ms();
    if (bucket_last_ms == 0) bucket_last_ms = now;
    int64_t elapsed = now - bucket_last_ms;
    if (elapsed > 0) { bucket_tokens += rate * elapsed / 1000; bucket_last_ms = now; }
    if (bucket_tokens > rate) bucket_tokens = rate;   /* burst ≤ 1 s of credit */
    if (bucket_tokens >= (int64_t)n) { bucket_tokens -= (int64_t)n; pthread_mutex_unlock(&bucket_mu); return; }
    int64_t need = (int64_t)n - bucket_tokens;
    int wait = (int)(need * 1000 / rate);
    pthread_mutex_unlock(&bucket_mu);
    util_sleep_ms(wait < 5 ? 5 : wait > 250 ? 250 : wait);
  }
}

/* ---- JSON (API + queue.json share one writer) --------------------------- */

static void job_write_json(jw *w, const dl_job *j, int history) {
  jw_obj_begin(w);
  jw_kv_str(w, "id", j->id);
  jw_kv_str(w, "gameId", j->gameId);
  jw_kv_str(w, "title", j->title);
  jw_kv_str(w, "titleId", j->titleId);
  jw_kv_str(w, "platform", j->platform);
  jw_kv_str(w, "cover", j->cover);
  jw_kv_str(w, "releaseId", j->releaseId);
  jw_kv_str(w, "format", j->format);
  jw_kv_str(w, "provider", j->provider);
  jw_kv_str(w, "sourceId", j->sourceId);
  jw_kv_str(w, "url", j->url);
  jw_kv_str(w, "activeUrl", j->activeUrl);
  jw_key(w, "mirrors"); jw_arr_begin(w);
  for (int i = 0; i < j->nmirrors; i++) jw_str(w, j->mirrors[i]);
  jw_arr_end(w);
  jw_kv_int(w, "mirrorIndex", j->mirror_idx);
  jw_kv_str(w, "filename", j->filename);
  jw_kv_str(w, "root", j->root);
  jw_kv_str(w, "rootLabel", j->rootLabel);
  jw_kv_str(w, "path", j->path);
  jw_kv_str(w, "state", dl_state_name(j->state));
  jw_kv_str(w, "phase", j->phase);
  jw_kv_str(w, "message", j->message);
  jw_kv_str(w, "error", j->error);
  jw_kv_str(w, "errorCode", j->errorCode);
  jw_kv_i64(w, "total", j->total);
  jw_kv_i64(w, "written", j->written);
  jw_kv_i64(w, "speed", (int64_t)j->speed);
  jw_kv_i64(w, "eta", j->eta);
  jw_kv_int(w, "connections", j->connections);
  jw_key(w, "segments"); jw_arr_begin(w);
  for (int i = 0; i < j->nchunks; i++) {
    jw_arr_begin(w);
    jw_i64(w, j->chunks[i].start); jw_i64(w, j->chunks[i].end); jw_i64(w, j->chunks[i].cur);
    jw_arr_end(w);
  }
  jw_arr_end(w);
  jw_kv_bool(w, "segmented", j->segmented);
  jw_kv_int(w, "activeSegments", j->active_segments);
  jw_kv_int(w, "window", j->window);
  jw_kv_str(w, "sha256", j->sha256);
  jw_kv_str(w, "sha256Expected", j->sha256Expected);
  jw_kv_bool(w, "verified", j->verified);
  jw_kv_str(w, "verify", j->verify);
  jw_kv_i64(w, "addedAt", (int64_t)j->addedAt);
  jw_kv_i64(w, "startedAt", (int64_t)j->startedAt);
  jw_kv_i64(w, "finishedAt", (int64_t)j->finishedAt);
  jw_kv_int(w, "attempts", j->attempts);
  jw_kv_i64(w, "nextRetryAt", (int64_t)j->nextRetryAt);
  jw_kv_int(w, "priority", j->priority);
  jw_kv_bool(w, "autoInstall", j->autoInstall);
  jw_key(w, "install"); jw_obj_begin(w);
  jw_kv_str(w, "state", j->install.state[0] ? j->install.state : "idle");
  jw_kv_str(w, "message", j->install.message);
  jw_kv_str(w, "contentId", j->install.contentId);
  jw_kv_str(w, "titleId", j->install.titleId);
  jw_kv_str(w, "via", j->install.via);
  jw_kv_i64(w, "startedAt", (int64_t)j->install.startedAt);
  jw_obj_end(w);
  jw_kv_bool(w, "resumable", j->resumable);
  jw_kv_str(w, "etag", j->etag);
  jw_kv_str(w, "lastModified", j->lastModified);
  jw_kv_bool(w, "synthetic", j->synthetic);
  if (history) {
    jw_key(w, "speedHistory"); jw_arr_begin(w);
    for (int i = 0; i < j->hist_n; i++) jw_i64(w, j->hist[(j->hist_head + i) % DL_HISTORY]);
    jw_arr_end(w);
  }
  jw_obj_end(w);
}

static void derive_paths_locked(dl_job *j) {
  xsnprintf(j->xpart, sizeof j->xpart, "%s.xpart", j->path);
  xsnprintf(j->sidecar, sizeof j->sidecar, "%s.xpart.json", j->path);
  if (!j->activeUrl[0]) xstrlcpy(j->activeUrl, j->url, sizeof j->activeUrl);
}

/* Restores a job from a queue.json entry (persisted subset of the fields). */
static dl_job *job_from_json(jv o) {
  dl_job *j = calloc(1, sizeof *j);
  if (!j) return NULL;
  j->fd = -1;
  j->mirror_idx = -1;
#define S(field, key) xstrlcpy(j->field, jv_get_str(o, key, ""), sizeof j->field)
  S(id, "id"); S(gameId, "gameId"); S(title, "title"); S(titleId, "titleId"); S(platform, "platform");
  S(cover, "cover"); S(releaseId, "releaseId"); S(format, "format"); S(provider, "provider");
  S(sourceId, "sourceId"); S(url, "url"); S(activeUrl, "activeUrl"); S(filename, "filename"); S(root, "root");
  S(rootLabel, "rootLabel"); S(path, "path"); S(phase, "phase"); S(message, "message"); S(error, "error");
  S(errorCode, "errorCode"); S(sha256, "sha256"); S(sha256Expected, "sha256Expected"); S(verify, "verify");
  S(etag, "etag"); S(lastModified, "lastModified");
#undef S
  JV_FOREACH(m, jv_get(o, "mirrors")) {
    const char *u = jv_str(m, NULL);
    if (u && j->nmirrors < DL_MAX_MIRRORS) xstrlcpy(j->mirrors[j->nmirrors++], u, sizeof j->mirrors[0]);
  }
  j->mirror_idx = (int)jv_get_i64(o, "mirrorIndex", -1);
  if (j->mirror_idx >= j->nmirrors) j->mirror_idx = -1;
  j->state = (dl_state)state_from_name(jv_get_str(o, "state", "queued"));
  j->total = jv_get_i64(o, "total", 0);
  j->written = jv_get_i64(o, "written", 0);
  j->connections = (int)jv_get_i64(o, "connections", 8);
  if (j->connections < 1) j->connections = 1;
  if (j->connections > DL_MAX_SEGMENTS) j->connections = DL_MAX_SEGMENTS;
  j->verified = jv_get_bool(o, "verified", 0);
  j->addedAt = (time_t)jv_get_i64(o, "addedAt", 0);
  j->startedAt = (time_t)jv_get_i64(o, "startedAt", 0);
  j->finishedAt = (time_t)jv_get_i64(o, "finishedAt", 0);
  j->attempts = (int)jv_get_i64(o, "attempts", 0);
  j->nextRetryAt = (time_t)jv_get_i64(o, "nextRetryAt", 0);
  j->priority = (int)jv_get_i64(o, "priority", 0);
  j->autoInstall = jv_get_bool(o, "autoInstall", 0);
  j->resumable = jv_get_bool(o, "resumable", 1);
  j->synthetic = jv_get_bool(o, "synthetic", 0);
  jv in = jv_get(o, "install");
  xstrlcpy(j->install.state, jv_get_str(in, "state", "idle"), sizeof j->install.state);
  xstrlcpy(j->install.message, jv_get_str(in, "message", ""), sizeof j->install.message);
  xstrlcpy(j->install.contentId, jv_get_str(in, "contentId", ""), sizeof j->install.contentId);
  xstrlcpy(j->install.titleId, jv_get_str(in, "titleId", ""), sizeof j->install.titleId);
  xstrlcpy(j->install.via, jv_get_str(in, "via", ""), sizeof j->install.via);
  j->install.startedAt = (time_t)jv_get_i64(in, "startedAt", 0);
  if (!j->id[0] || !j->path[0]) { free(j); return NULL; }
  derive_paths_locked(j);
  return j;
}

/* ---- queue.json --------------------------------------------------------- */

static char *queue_text_locked(size_t *len) {
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_kv_int(&w, "v", 1);
  jw_kv_i64(&w, "savedAt", (int64_t)util_now());
  jw_key(&w, "jobs"); jw_arr_begin(&w);
  for (int i = 0; i < n_jobs; i++) job_write_json(&w, jobs[i], 0);
  jw_arr_end(&w);
  jw_obj_end(&w);
  return jw_detach(&w, len);
}

void dl_save_queue(void) {
  size_t len;
  pthread_mutex_lock(&queue_mu);
  char *txt = queue_text_locked(&len);
  queue_dirty = 0;
  last_save_ms = util_now_ms();
  pthread_mutex_unlock(&queue_mu);
  if (!txt) return;
  char path[600];
  xsnprintf(path, sizeof path, "%s/queue.json", data_dir);
  if (util_write_file_atomic(path, txt, len) != 0) LOGW("queue: cannot write %s", path);
  free(txt);
}

/* ---- sidecar (<final>.xpart.json) --------------------------------------- */

typedef struct sidecar {
  int64_t total, chunk, written;
  char url[2048], etag[128], lastModified[64], sha256Expected[65];
  int64_t done[MAX_CHUNKS][2];
  int ndone;
  time_t createdAt;
} sidecar;

static int range_cmp(const void *a, const void *b) {
  const int64_t *x = a, *y = b;
  return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0;
}

/* Merges [start,cur) of every chunk into sorted, non-overlapping ranges. */
static int done_ranges_locked(const dl_job *j, int64_t (*out)[2], int max) {
  int n = 0;
  for (int i = 0; i < j->nchunks && n < max; i++) {
    if (j->chunks[i].cur > j->chunks[i].start) { out[n][0] = j->chunks[i].start; out[n][1] = j->chunks[i].cur; n++; }
  }
  if (n == 0) return 0;
  qsort(out, (size_t)n, sizeof out[0], range_cmp);
  int m = 0;
  for (int i = 1; i < n; i++) {
    if (out[i][0] <= out[m][1]) { if (out[i][1] > out[m][1]) out[m][1] = out[i][1]; }
    else out[++m][0] = out[i][0], out[m][1] = out[i][1];
  }
  return m + 1;
}

static char *sidecar_text_locked(dl_job *j, size_t *len, time_t createdAt) {
  int64_t (*done)[2] = calloc(MAX_CHUNKS, sizeof *done);
  if (!done) return NULL;
  int n = done_ranges_locked(j, done, MAX_CHUNKS);
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_kv_int(&w, "v", 1);
  jw_kv_str(&w, "url", j->activeUrl);
  jw_kv_i64(&w, "total", j->total);
  jw_kv_str(&w, "etag", j->etag);
  jw_kv_str(&w, "lastModified", j->lastModified);
  jw_kv_i64(&w, "chunk", j->chunk_size);
  jw_key(&w, "done"); jw_arr_begin(&w);
  for (int i = 0; i < n; i++) { jw_arr_begin(&w); jw_i64(&w, done[i][0]); jw_i64(&w, done[i][1]); jw_arr_end(&w); }
  jw_arr_end(&w);
  jw_kv_i64(&w, "written", j->written);
  jw_kv_i64(&w, "createdAt", (int64_t)createdAt);
  jw_kv_i64(&w, "updatedAt", (int64_t)util_now());
  jw_kv_str(&w, "sha256Expected", j->sha256Expected);
  jw_kv_str(&w, "root", j->root);
  struct stat st;
  char rootId[64] = "";
  if (stat(j->root, &st) == 0) xsnprintf(rootId, sizeof rootId, "%llu:%llu", (unsigned long long)st.st_dev, (unsigned long long)st.st_ino);
  jw_kv_str(&w, "rootId", rootId);
  jw_obj_end(&w);
  free(done);
  return jw_detach(&w, len);
}

static int sidecar_load(const dl_job *j, sidecar *sc) {
  memset(sc, 0, sizeof *sc);
  size_t len;
  char *txt = util_read_file(j->sidecar, &len, 4u << 20);
  if (!txt) return -1;
  jdoc *d = json_parse(txt, len, 20000, 8);
  free(txt);
  if (!d) return -1;
  jv o = json_root(d);
  sc->total = jv_get_i64(o, "total", 0);
  sc->chunk = jv_get_i64(o, "chunk", 0);
  sc->written = jv_get_i64(o, "written", 0);
  sc->createdAt = (time_t)jv_get_i64(o, "createdAt", 0);
  xstrlcpy(sc->url, jv_get_str(o, "url", ""), sizeof sc->url);
  xstrlcpy(sc->etag, jv_get_str(o, "etag", ""), sizeof sc->etag);
  xstrlcpy(sc->lastModified, jv_get_str(o, "lastModified", ""), sizeof sc->lastModified);
  xstrlcpy(sc->sha256Expected, jv_get_str(o, "sha256Expected", ""), sizeof sc->sha256Expected);
  JV_FOREACH(r, jv_get(o, "done")) {
    int64_t s = jv_i64(jv_at(r, 0), -1), e = jv_i64(jv_at(r, 1), -1);
    if (s >= 0 && e > s && sc->ndone < MAX_CHUNKS) { sc->done[sc->ndone][0] = s; sc->done[sc->ndone][1] = e; sc->ndone++; }
  }
  json_free(d);
  qsort(sc->done, (size_t)sc->ndone, sizeof sc->done[0], range_cmp);
  return 0;
}

/* Writes the sidecar (lock taken inside for the snapshot only). */
static void sidecar_persist(dl_job *j) {
  pthread_mutex_lock(&queue_mu);
  if (!j->chunks || !j->xpart[0]) { pthread_mutex_unlock(&queue_mu); return; }
  size_t len;
  time_t created = j->startedAt ? j->startedAt : util_now();
  char *txt = sidecar_text_locked(j, &len, created);
  j->last_sidecar_ms = util_now_ms();
  pthread_mutex_unlock(&queue_mu);
  if (txt) { util_write_file_atomic(j->sidecar, txt, len); free(txt); }
}

/* ---- chunk plan --------------------------------------------------------- */

static int plan_alloc_locked(dl_job *j) {
  free(j->chunks);
  j->chunks = calloc(MAX_CHUNKS, sizeof *j->chunks);
  j->nchunks = 0;
  return j->chunks ? 0 : -1;
}

static void plan_add_locked(dl_job *j, int64_t start, int64_t end, int64_t cur) {
  if (j->nchunks >= MAX_CHUNKS) return;
  dl_chunk *c = &j->chunks[j->nchunks++];
  c->start = start; c->end = end; c->cur = cur; c->active = 0;
}

/* Fresh plan: equal chunks of max(16 MiB, total/connections). */
static int plan_fresh_locked(dl_job *j) {
  if (plan_alloc_locked(j) != 0) return -1;
  if (!j->segmented || j->total <= 0) {
    j->chunk_size = j->total > 0 ? j->total : 0;
    plan_add_locked(j, 0, j->total > 0 ? j->total : -1, 0);
    return 0;
  }
  int64_t cs = (j->total + j->connections - 1) / j->connections;
  if (cs < MIN_CHUNK) cs = MIN_CHUNK;
  j->chunk_size = cs;
  for (int64_t off = 0; off < j->total && j->nchunks < MAX_CHUNKS - 64; off += cs)
    plan_add_locked(j, off, XS_MIN(off + cs, j->total), off);
  if (j->nchunks && j->chunks[j->nchunks - 1].end < j->total) j->chunks[j->nchunks - 1].end = j->total;
  return 0;
}

/* Resume plan: done ranges become finished chunks, gaps become work. */
static int plan_resume_locked(dl_job *j, const sidecar *sc) {
  if (plan_alloc_locked(j) != 0) return -1;
  int64_t cs = sc->chunk > 0 ? sc->chunk : MIN_CHUNK;
  j->chunk_size = cs;
  int64_t pos = 0;
  int64_t written = 0;
  for (int i = 0; i < sc->ndone; i++) {
    int64_t s = sc->done[i][0], e = sc->done[i][1];
    if (j->total > 0 && e > j->total) e = j->total;
    if (s > pos) {
      for (int64_t off = pos; off < s; off += cs) plan_add_locked(j, off, XS_MIN(off + cs, s), off);
    }
    if (e > s) { plan_add_locked(j, s, e, e); written += e - s; }
    if (e > pos) pos = e;
  }
  if (j->total > 0 && pos < j->total) {
    if (!j->segmented) plan_add_locked(j, pos, j->total, pos);
    else for (int64_t off = pos; off < j->total; off += cs) plan_add_locked(j, off, XS_MIN(off + cs, j->total), off);
  } else if (j->total <= 0) {
    plan_add_locked(j, pos, -1, pos);   /* unknown size: continue sequentially */
  }
  j->written = written;
  return 0;
}

static int plan_remaining_locked(const dl_job *j) {
  for (int i = 0; i < j->nchunks; i++) if (j->chunks[i].end < 0 || j->chunks[i].cur < j->chunks[i].end) return 1;
  return 0;
}

/* Picks the next piece of work for a segment thread: an idle chunk first,
 * otherwise splits the largest active chunk (work-stealing). */
static dl_chunk *take_chunk(dl_job *j) {
  pthread_mutex_lock(&queue_mu);
  dl_chunk *pick = NULL;
  for (int i = 0; i < j->nchunks; i++) {
    dl_chunk *c = &j->chunks[i];
    if (!c->active && (c->end < 0 || c->cur < c->end)) { pick = c; break; }
  }
  if (!pick && j->segmented && j->nchunks < MAX_CHUNKS) {
    dl_chunk *big = NULL;
    for (int i = 0; i < j->nchunks; i++) {
      dl_chunk *c = &j->chunks[i];
      if (c->active && c->end >= 0 && (!big || c->end - c->cur > big->end - big->cur)) big = c;
    }
    if (big && big->end - big->cur >= 2 * SPLIT_MIN) {
      int64_t mid = big->cur + (big->end - big->cur) / 2;
      plan_add_locked(j, mid, big->end, mid);
      big->end = mid;
      pick = &j->chunks[j->nchunks - 1];
    }
  }
  if (pick) pick->active = 1;
  pthread_mutex_unlock(&queue_mu);
  return pick;
}

/* ---- segment errors ----------------------------------------------------- */

static void seg_fail(dl_job *j, int transient, int status, const char *code, const char *msg) {
  pthread_mutex_lock(&queue_mu);
  if (!j->stop_io) {   /* first error wins; later ones are consequences */
    xstrlcpy(j->seg_code, code, sizeof j->seg_code);
    xstrlcpy(j->seg_error, msg, sizeof j->seg_error);
    j->seg_status = status;
  }
  if (transient) {
    if (j->window > 1) j->window /= 2;
    j->last_seg_error_ms = util_now_ms();
    j->seg_err_streak++;
    if (status == 429 || status == 503) { j->seg_retry_now = 1; j->stop_io = 1; }
  } else {
    j->seg_fatal = 1;
    j->stop_io = 1;
  }
  jlog_locked(j, "%s%s: %s", transient ? "transient " : "", code, msg);
  pthread_mutex_unlock(&queue_mu);
}

static void http_code_name(int status, char *out, size_t cap) { xsnprintf(out, cap, "http_%d", status); }

static int status_is_failover(int s) { return s == 401 || s == 403 || s == 404 || s == 410; }
static int status_is_transient(int s) { return s == 408 || s == 429 || s >= 500; }

static int looks_like_html(const char *p, size_t n) {
  char head[32];
  size_t k = n < 24 ? n : 24;
  for (size_t i = 0; i < k; i++) head[i] = (char)((unsigned char)p[i] < 0x20 || (unsigned char)p[i] > 0x7e ? ' ' : p[i]);
  head[k] = 0;
  util_trim(head);
  return util_istarts_with(head, "<!DOCTYPE") || util_istarts_with(head, "<html");
}

/* ---- segment transfer --------------------------------------------------- */

static int write_fully(int fd, const char *buf, size_t n, int64_t off) {
  size_t done = 0;
  while (done < n) {
    ssize_t w = pwrite(fd, buf + done, n - done, off + (int64_t)done);
    if (w < 0) { if (errno == EINTR) continue; return -1; }
    done += (size_t)w;
  }
  return 0;
}

/* Validates the response of a chunk request. Returns 0 ok, -1 handled. */
static int check_chunk_response(dl_job *j, const xhttp_resp *resp, int64_t start) {
  int st = resp->status;
  char code[32];
  if (st == 206) {
    if (resp->range_start >= 0 && resp->range_start != start) { seg_fail(j, 1, st, "bad_range", "Server answered the wrong byte range"); return -1; }
    if (resp->range_total > 0 && j->total > 0 && resp->range_total != j->total) {
      seg_fail(j, 0, st, "source_changed", "The file on the server changed. Restart from zero or pick another source.");
      return -1;
    }
    return 0;
  }
  if (st == 200) {
    if (start > 0) { seg_fail(j, 0, st, "range_unsupported", "The server stopped accepting resume requests. Restart from zero."); return -1; }
    return 0;
  }
  http_code_name(st, code, sizeof code);
  if (status_is_failover(st)) { char m[96]; xsnprintf(m, sizeof m, "The host refused the file (HTTP %d)", st); seg_fail(j, 0, st, code, m); return -1; }
  if (status_is_transient(st)) {
    char m[96];
    xsnprintf(m, sizeof m, "Server error HTTP %d", st);
    pthread_mutex_lock(&queue_mu);
    if (resp->retry_after > 0) j->retry_after = resp->retry_after;
    pthread_mutex_unlock(&queue_mu);
    seg_fail(j, 1, st, code, m);
    return -1;
  }
  char m[96];
  xsnprintf(m, sizeof m, "Unexpected HTTP %d", st);
  seg_fail(j, 0, st, code, m);
  return -1;
}

/* Publishes n new bytes; returns 1 when the chunk is complete. */
static int publish_progress_locked(dl_job *j, dl_chunk *ck, int n, int64_t *cur, int64_t *end) {
  ck->cur += n;
  j->written += n;
  j->clean_bytes += n;
  j->seg_err_streak = 0;
  if (j->segmented && j->clean_bytes >= WINDOW_GROW_BYTES) {
    j->clean_bytes = 0;
    if (j->window < j->connections) j->window++;
  }
  *cur = ck->cur;
  *end = ck->end;
  return ck->end >= 0 && ck->cur >= ck->end;
}

/* Streams one chunk. Returns 0 when the chunk is finished or stopped
 * cooperatively, -1 after an error has been recorded via seg_fail(). */
static int transfer_chunk(dl_job *j, dl_chunk *ck, char *buf, int slot) {
  pthread_mutex_lock(&queue_mu);
  int64_t cur = ck->cur, end = ck->end;
  char url[2048];
  xstrlcpy(url, j->activeUrl, sizeof url);
  int insecure = j->insecure_tls;
  int fd = j->fd;
  pthread_mutex_unlock(&queue_mu);

  xhttp_req req;
  memset(&req, 0, sizeof req);
  req.url = url;
  req.range_start = (end >= 0 || cur > 0) ? cur : -1;
  req.range_end = (end >= 0 && req.range_start >= 0) ? end - 1 : -1;
  req.follow_redirects = 8;
  req.connect_timeout_ms = 15000;
  req.recv_timeout_ms = 30000;
  req.insecure_tls = insecure;
  req.cancel_flag = &j->stop_io;
  xhttp_conn *c = NULL;
  xhttp_resp resp;
  if (xhttp_open(&req, &c, &resp) != 0) {
    if (j->stop_io) return 0;
    char m[160];
    xsnprintf(m, sizeof m, "Connection failed: %s", xhttp_last_error());
    seg_fail(j, 1, 0, "network", m);
    return -1;
  }
  pthread_mutex_lock(&queue_mu);
  j->seg_conns[slot] = c;
  pthread_mutex_unlock(&queue_mu);
  int rc = 0;
  if (check_chunk_response(j, &resp, cur) != 0) rc = -1;
  else if (cur == 0 && util_istarts_with(resp.content_type, "text/html")) {
    seg_fail(j, 0, resp.status, "provider_page",
             "The host returned a web page instead of the file. Open it in the browser or enter the direct file link.");
    rc = -1;
  }
  int first = (cur == 0);
  while (rc == 0) {
    size_t want = SEG_BUF;
    if (end >= 0 && (int64_t)want > end - cur) want = (size_t)(end - cur);
    if (want == 0) break;
    int n = xhttp_read(c, buf, want);
    if (n < 0) {
      if (j->stop_io) break;
      char m[160];
      xsnprintf(m, sizeof m, "Connection dropped: %s", xhttp_last_error());
      seg_fail(j, 1, 0, "network", m);
      rc = -1;
      break;
    }
    if (n == 0) {
      if (end >= 0 && cur < end) { seg_fail(j, 1, 0, "network", "Connection closed before the end of the segment"); rc = -1; break; }
      pthread_mutex_lock(&queue_mu);
      if (end < 0) { ck->end = ck->cur; if (j->total <= 0) j->total = j->written; }
      pthread_mutex_unlock(&queue_mu);
      break;
    }
    if (first) {
      first = 0;
      if (looks_like_html(buf, (size_t)n)) {
        seg_fail(j, 0, resp.status, "provider_page",
                 "The host returned a web page instead of the file. Open it in the browser or enter the direct file link.");
        rc = -1;
        break;
      }
    }
    bucket_wait((size_t)n);
    if (write_fully(fd, buf, (size_t)n, cur) != 0) {
      int e = errno;
      seg_fail(j, 0, 0, e == ENOSPC ? "no_space" : "io_error",
               e == ENOSPC ? "The drive is full. Free some space and retry." : "Cannot write to the drive");
      rc = -1;
      break;
    }
    pthread_mutex_lock(&queue_mu);
    int done = publish_progress_locked(j, ck, n, &cur, &end);
    pthread_mutex_unlock(&queue_mu);
    if (done) break;
    if (j->stop_io) break;
  }
  pthread_mutex_lock(&queue_mu);
  j->seg_conns[slot] = NULL;
  pthread_mutex_unlock(&queue_mu);
  xhttp_close(c);
  return rc;
}

typedef struct seg_ctx { dl_job *job; int slot; } seg_ctx;

static void *segment_thread(void *arg) {
  seg_ctx *sc = arg;
  dl_job *j = sc->job;
  int slot = sc->slot;
  free(sc);
  char *buf = malloc(SEG_BUF);
  if (buf) {
    while (!j->stop_io) {
      dl_chunk *ck = take_chunk(j);
      if (!ck) break;
      int rc = transfer_chunk(j, ck, buf, slot);
      pthread_mutex_lock(&queue_mu);
      ck->active = 0;
      pthread_mutex_unlock(&queue_mu);
      if (rc != 0) break;   /* the coordinator decides: respawn, retry or fail */
    }
  }
  free(buf);
  pthread_mutex_lock(&queue_mu);
  j->active_segments--;
  j->slot_mask &= ~(1u << slot);
  pthread_mutex_unlock(&queue_mu);
  return NULL;
}

static void spawn_segments_locked(dl_job *j) {
  int64_t now = util_now_ms();
  if (j->stop_io || j->seg_fatal) return;
  if (j->last_seg_error_ms && now - j->last_seg_error_ms < SEG_RESPAWN_DELAY_MS) return;
  while (j->active_segments < j->window && j->active_segments < DL_MAX_SEGMENTS) {
    int idle = 0;
    for (int i = 0; i < j->nchunks; i++) if (!j->chunks[i].active && (j->chunks[i].end < 0 || j->chunks[i].cur < j->chunks[i].end)) { idle = 1; break; }
    int splittable = 0;
    if (!idle && j->segmented)
      for (int i = 0; i < j->nchunks; i++) if (j->chunks[i].active && j->chunks[i].end >= 0 && j->chunks[i].end - j->chunks[i].cur >= 2 * SPLIT_MIN) { splittable = 1; break; }
    if (!idle && !splittable) break;
    int slot = -1;
    for (int s = 0; s < DL_MAX_SEGMENTS; s++) if (!(j->slot_mask & (1u << s))) { slot = s; break; }
    if (slot < 0) break;
    seg_ctx *sc = malloc(sizeof *sc);
    if (!sc) break;
    sc->job = j;
    sc->slot = slot;
    pthread_t th;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    pthread_attr_setstacksize(&attr, 256 << 10);
    j->active_segments++;
    j->slot_mask |= 1u << slot;
    if (pthread_create(&th, &attr, segment_thread, sc) != 0) {
      j->active_segments--;
      j->slot_mask &= ~(1u << slot);
      free(sc);
      pthread_attr_destroy(&attr);
      break;
    }
    pthread_attr_destroy(&attr);
  }
}

/* ---- probe & resume ----------------------------------------------------- */

static void failover_or_fatal_code(dl_job *j, int *out) {
  *out = (status_is_failover(j->seg_status) || strcmp(j->seg_code, "provider_page") == 0) ? OUT_FAILOVER : OUT_FATAL;
}

/* Compares the tail of the partial with the same bytes from the server
 * (Overdrive's tail check for validator-less resumes). 1 match, 0 mismatch,
 * -1 transient error. */
static int tail_check(dl_job *j, const char *url, int64_t off, size_t len) {
  if (len == 0) return 1;
  char *local = malloc(len), *remote = malloc(len);
  int rc = -1;
  if (!local || !remote) { free(local); free(remote); return -1; }
  int fd = open(j->xpart, O_RDONLY);
  if (fd >= 0 && pread(fd, local, len, off) == (ssize_t)len) {
    xhttp_req req;
    memset(&req, 0, sizeof req);
    req.url = url;
    req.range_start = off;
    req.range_end = off + (int64_t)len - 1;
    req.follow_redirects = 8;
    req.connect_timeout_ms = 15000;
    req.recv_timeout_ms = 30000;
    req.cancel_flag = &j->stop_io;
    xhttp_conn *c = NULL;
    xhttp_resp resp;
    if (xhttp_open(&req, &c, &resp) == 0) {
      size_t got = 0;
      if (resp.status == 206) {
        while (got < len) {
          int n = xhttp_read(c, remote + got, len - got);
          if (n <= 0) break;
          got += (size_t)n;
        }
        rc = (got == len && memcmp(local, remote, len) == 0) ? 1 : 0;
      } else if (resp.status == 200) {
        rc = 0;   /* no Range support any more: cannot trust the partial */
      }
      xhttp_close(c);
    }
  }
  if (fd >= 0) close(fd);
  free(local);
  free(remote);
  return rc;
}

/* Decides how to continue from an existing partial; returns an OUT_ code
 * (OUT_DONE = continue with the plan built in j->chunks). */
static int resume_decide(dl_job *j, const xhttp_resp *probe, char *url) {
  int64_t total = j->total;
  if (!util_file_exists(j->xpart)) { pthread_mutex_lock(&queue_mu); int rc = plan_fresh_locked(j); j->written = 0; pthread_mutex_unlock(&queue_mu); return rc ? OUT_FATAL : OUT_DONE; }
  sidecar sc;
  if (sidecar_load(j, &sc) != 0 || sc.ndone == 0) {
    jlog(j, "partial without a usable sidecar — starting from zero");
    util_unlink_quiet(j->xpart);
    pthread_mutex_lock(&queue_mu);
    int rc = plan_fresh_locked(j);
    j->written = 0;
    pthread_mutex_unlock(&queue_mu);
    return rc ? OUT_FATAL : OUT_DONE;
  }
  int replaced = j->url_replaced || strcmp(sc.url, url) != 0;
  const char *changed = "The file on the server changed. Restart from zero or pick another source.";
  if (total > 0 && sc.total > 0 && sc.total != total) {
    if (!replaced) { seg_fail(j, 0, probe->status, "source_changed", changed); return OUT_FATAL; }
    jlog(j, "new link has a different size — starting from zero");
    util_unlink_quiet(j->xpart);
    pthread_mutex_lock(&queue_mu);
    int rc = plan_fresh_locked(j);
    j->written = 0;
    pthread_mutex_unlock(&queue_mu);
    return rc ? OUT_FATAL : OUT_DONE;
  }
  int have_validator = (sc.etag[0] && probe->etag[0]) || (sc.lastModified[0] && probe->last_modified[0]);
  if (!replaced && have_validator) {
    if ((sc.etag[0] && probe->etag[0] && strcmp(sc.etag, probe->etag) != 0) ||
        (sc.lastModified[0] && probe->last_modified[0] && strcmp(sc.lastModified, probe->last_modified) != 0)) {
      seg_fail(j, 0, probe->status, "source_changed", changed);
      return OUT_FATAL;
    }
  }
  if (!j->resumable) {
    jlog(j, "server does not support resume — starting from zero");
    util_unlink_quiet(j->xpart);
    pthread_mutex_lock(&queue_mu);
    int rc = plan_fresh_locked(j);
    j->written = 0;
    pthread_mutex_unlock(&queue_mu);
    return rc ? OUT_FATAL : OUT_DONE;
  }
  if (!have_validator || replaced) {
    /* Validator-less (or new link): compare the last 64 KiB of the first done range. */
    int64_t s = sc.done[0][0], e = sc.done[0][1];
    size_t len = (size_t)XS_MIN((int64_t)TAIL_CHECK_BYTES, e - s);
    int tc = tail_check(j, url, e - (int64_t)len, len);
    if (tc < 0) { seg_fail(j, 1, 0, "network", "Could not verify the partial file against the server"); return OUT_RETRY; }
    if (tc == 0) {
      if (!replaced) { seg_fail(j, 0, probe->status, "source_changed", changed); return OUT_FATAL; }
      jlog(j, "new link content differs — starting from zero");
      util_unlink_quiet(j->xpart);
      pthread_mutex_lock(&queue_mu);
      int rc = plan_fresh_locked(j);
      j->written = 0;
      pthread_mutex_unlock(&queue_mu);
      return rc ? OUT_FATAL : OUT_DONE;
    }
    jlog(j, "tail check passed (%zu bytes)", len);
  }
  pthread_mutex_lock(&queue_mu);
  int rc = plan_resume_locked(j, &sc);
  int64_t w = j->written;
  pthread_mutex_unlock(&queue_mu);
  char fb[32];
  util_fmt_bytes(w, fb, sizeof fb);
  jlog(j, "resuming with %s already on disk", fb);
  return rc ? OUT_FATAL : OUT_DONE;
}

/* Probe GET Range: bytes=0-0 → classify, learn total/validators, plan. */
static int probe_and_plan(dl_job *j) {
  char url[2048];
  pthread_mutex_lock(&queue_mu);
  xstrlcpy(url, j->activeUrl, sizeof url);
  int insecure = j->insecure_tls;
  j->retry_after = 0;
  pthread_mutex_unlock(&queue_mu);

  xhttp_req req;
  memset(&req, 0, sizeof req);
  req.url = url;
  req.range_start = 0;
  req.range_end = 0;
  req.follow_redirects = 8;
  req.connect_timeout_ms = 15000;
  req.recv_timeout_ms = 30000;
  req.insecure_tls = insecure;
  req.cancel_flag = &j->stop_io;
  xhttp_conn *c = NULL;
  xhttp_resp resp;
  if (xhttp_open(&req, &c, &resp) != 0) {
    if (j->stop_io) return OUT_STOPPED;
    char m[160];
    xsnprintf(m, sizeof m, "Connection failed: %s", xhttp_last_error());
    seg_fail(j, 1, 0, "network", m);
    return OUT_RETRY;
  }
  xhttp_close(c);
  int st = resp.status;
  char code[32];
  http_code_name(st, code, sizeof code);
  if (st != 200 && st != 206) {
    char m[96];
    if (status_is_failover(st)) { xsnprintf(m, sizeof m, "The host refused the file (HTTP %d)", st); seg_fail(j, 0, st, code, m); return OUT_FAILOVER; }
    if (status_is_transient(st)) {
      xsnprintf(m, sizeof m, "Server error HTTP %d", st);
      pthread_mutex_lock(&queue_mu);
      j->retry_after = resp.retry_after;
      pthread_mutex_unlock(&queue_mu);
      seg_fail(j, 1, st, code, m);
      return OUT_RETRY;
    }
    if (st >= 300 && st < 400) { seg_fail(j, 0, st, "redirect_loop", "Too many redirects"); return OUT_FAILOVER; }
    xsnprintf(m, sizeof m, "Unexpected HTTP %d", st);
    seg_fail(j, 0, st, code, m);
    return OUT_FATAL;
  }
  if (util_istarts_with(resp.content_type, "text/html")) {
    seg_fail(j, 0, st, "provider_page", "The host returned a web page instead of the file. Open it in the browser or enter the direct file link.");
    return OUT_FAILOVER;
  }
  int64_t total = -1;
  if (st == 206) total = resp.range_total;
  else if (resp.content_length >= 0) total = resp.content_length;
  int strong_etag = resp.etag[0] && !util_istarts_with(resp.etag, "W/");
  pthread_mutex_lock(&queue_mu);
  j->probe_status = st;
  j->resumable = (st == 206) || resp.accept_ranges;
  j->segmented = st == 206 && total > 0 && (strong_etag || resp.last_modified[0]) && j->connections > 1;
  if (total > 0 && j->total > 0 && j->total != total && !j->chunks && !util_file_exists(j->xpart)) {
    jlog_locked(j, "catalog size %lld differs from server size %lld", (long long)j->total, (long long)total);
  }
  j->total = total > 0 ? total : 0;
  if (j->total > 0 && strcmp(j->verify, "none") == 0) xstrlcpy(j->verify, "size", sizeof j->verify);
  xstrlcpy(j->etag, resp.etag, sizeof j->etag);
  xstrlcpy(j->lastModified, resp.last_modified, sizeof j->lastModified);
  j->window = j->segmented ? j->connections : 1;
  j->clean_bytes = 0;
  pthread_mutex_unlock(&queue_mu);
  char fb[32];
  util_fmt_bytes(total, fb, sizeof fb);
  jlog(j, "probe: HTTP %d, %s, %s%s", st, total > 0 ? fb : "unknown size", j->segmented ? "segmented" : "sequential",
       j->resumable ? ", resumable" : "");
  int out = resume_decide(j, &resp, url);
  if (out != OUT_DONE) return out;
  pthread_mutex_lock(&queue_mu);
  j->url_replaced = 0;
  pthread_mutex_unlock(&queue_mu);
  return OUT_DONE;
}

/* Opens the partial file and preallocates it (sparse on the console). */
static int open_partial(dl_job *j) {
  int fd = open(j->xpart, O_RDWR | O_CREAT, 0644);
  if (fd < 0) { seg_fail(j, 0, 0, "io_error", "Cannot create the download file"); return -1; }
  struct stat st;
  if (j->total > 0 && fstat(fd, &st) == 0 && st.st_size != j->total) {
    if (ftruncate(fd, j->total) != 0) {
      int e = errno;
      close(fd);
      seg_fail(j, 0, 0, e == ENOSPC ? "no_space" : "io_error", e == ENOSPC ? "The drive is full." : "Cannot preallocate the file");
      return -1;
    }
  }
  pthread_mutex_lock(&queue_mu);
  j->fd = fd;
  pthread_mutex_unlock(&queue_mu);
  return 0;
}

/* ---- coordinator -------------------------------------------------------- */

static void sample_speed_locked(dl_job *j) {
  int64_t now = util_now_ms();
  if (j->last_sample_ms == 0) { j->last_sample_ms = now; j->last_sample_written = j->written; return; }
  int64_t dt = now - j->last_sample_ms;
  if (dt < 1000) return;
  double inst = (double)(j->written - j->last_sample_written) * 1000.0 / (double)dt;
  j->speed = j->speed > 0 ? 0.3 * inst + 0.7 * j->speed : inst;
  if (j->speed < 1) j->speed = 0;
  j->last_sample_ms = now;
  j->last_sample_written = j->written;
  int idx = (j->hist_head + j->hist_n) % DL_HISTORY;
  if (j->hist_n == DL_HISTORY) { idx = j->hist_head; j->hist_head = (j->hist_head + 1) % DL_HISTORY; }
  else j->hist_n++;
  j->hist[idx] = (int64_t)inst;
  int64_t remaining = j->total > 0 ? j->total - j->written : 0;
  j->eta = (j->speed > 0 && remaining > 0) ? (int64_t)((double)remaining / j->speed) : 0;
}

/* Returns 1 when a space check found the drive too full (job already failed). */
static int space_check(dl_job *j) {
  int64_t fr;
  if (storage_free_space(j->root, &fr, NULL) != 0) {
    pthread_mutex_lock(&queue_mu);
    j->drive_missing = 1;
    j->stop_io = 1;
    pthread_mutex_unlock(&queue_mu);
    return 1;
  }
  /* Known size: the rest of the file plus the 256 MiB reserve must fit.
   * Unknown size: only the reserve can be checked. */
  int64_t need = (j->total > 0 ? j->total - j->written : 0);
  if (fr < need + DL_RESERVE_BYTES) {
    char a[32], b[32];
    util_fmt_bytes(need, a, sizeof a);
    util_fmt_bytes(fr, b, sizeof b);
    char m[160];
    xsnprintf(m, sizeof m, "Not enough free space on %s: need %s, have %s", j->rootLabel, a, b);
    seg_fail(j, 0, 0, "no_space", m);
    return 1;
  }
  return 0;
}

static void wait_segments(dl_job *j) {
  for (int i = 0; i < 600; i++) {   /* ≤ 60 s; reads time out at 30 s */
    pthread_mutex_lock(&queue_mu);
    int n = j->active_segments;
    if (n > 0) for (int s = 0; s < DL_MAX_SEGMENTS; s++) if (j->seg_conns[s]) xhttp_abort(j->seg_conns[s]);
    pthread_mutex_unlock(&queue_mu);
    if (n == 0) return;
    util_sleep_ms(100);
  }
}

/* Runs the segment threads until the plan is complete or an error stops it. */
static int transfer(dl_job *j) {
  pthread_mutex_lock(&queue_mu);
  j->state = DL_DOWNLOADING;
  j->phase[0] = 0;
  j->seg_fatal = 0;
  j->seg_retry_now = 0;
  j->seg_err_streak = 0;
  j->seg_code[0] = j->seg_error[0] = 0;
  j->last_seg_error_ms = 0;
  j->last_sample_ms = 0;
  j->last_fsync = j->written;
  j->last_space_check = j->written;
  pthread_mutex_unlock(&queue_mu);
  int out = OUT_DONE;
  for (;;) {
    pthread_mutex_lock(&queue_mu);
    if (j->cancel) { pthread_mutex_unlock(&queue_mu); out = OUT_STOPPED; break; }
    int remaining = plan_remaining_locked(j);
    if (!remaining && j->active_segments == 0) { pthread_mutex_unlock(&queue_mu); out = OUT_DONE; break; }
    if (j->active_segments == 0) {
      if (j->seg_fatal) { failover_or_fatal_code(j, &out); pthread_mutex_unlock(&queue_mu); break; }
      if (j->seg_retry_now || j->seg_err_streak >= 3) { pthread_mutex_unlock(&queue_mu); out = OUT_RETRY; break; }
      if (j->drive_missing) { pthread_mutex_unlock(&queue_mu); out = OUT_FATAL; break; }
    }
    spawn_segments_locked(j);
    sample_speed_locked(j);
    int need_fsync = j->written - j->last_fsync >= FSYNC_EVERY;
    if (need_fsync) j->last_fsync = j->written;
    int need_space = j->written - j->last_space_check >= SPACE_CHECK_EVERY;
    if (need_space) j->last_space_check = j->written;
    int need_sidecar = util_now_ms() - j->last_sidecar_ms >= SIDECAR_EVERY_MS;
    int fd = j->fd;
    pthread_mutex_unlock(&queue_mu);
    if (need_fsync) fsync(fd);
    if (need_space) space_check(j);
    if (need_sidecar) sidecar_persist(j);
    util_sleep_ms(200);
  }
  if (out != OUT_DONE) { pthread_mutex_lock(&queue_mu); j->stop_io = 1; pthread_mutex_unlock(&queue_mu); }
  wait_segments(j);
  pthread_mutex_lock(&queue_mu);
  int fd = j->fd;
  j->speed = 0;
  j->eta = 0;
  pthread_mutex_unlock(&queue_mu);
  if (fd >= 0) fsync(fd);
  sidecar_persist(j);
  return out;
}

/* Streams the partial through SHA-256; 1 ok, 0 mismatch, -1 stopped/error. */
static int verify_file(dl_job *j, const char *path, char hex[65]) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) return -1;
  char *buf = malloc(1u << 20);
  if (!buf) { close(fd); return -1; }
  sha256_ctx h;
  sha256_init(&h);
  int64_t done = 0;
  int rc = 1;
  for (;;) {
    if (j->stop_io) { rc = -1; break; }
    ssize_t n = read(fd, buf, 1u << 20);
    if (n < 0) { rc = -1; break; }
    if (n == 0) break;
    sha256_update(&h, buf, (size_t)n);
    done += n;
    if ((done & ((8 << 20) - 1)) == 0) { pthread_mutex_lock(&queue_mu); j->written = done; pthread_mutex_unlock(&queue_mu); }
  }
  free(buf);
  close(fd);
  if (rc < 0) return -1;
  uint8_t d[32];
  sha256_final(&h, d);
  sha256_digest_hex(d, hex);
  pthread_mutex_lock(&queue_mu);
  j->written = done;
  pthread_mutex_unlock(&queue_mu);
  return (!j->sha256Expected[0] || strcmp(hex, j->sha256Expected) == 0) ? 1 : 0;
}

static void begin_install(dl_job *j);
static void install_run(dl_job *j);
static void mark_installing_locked(dl_job *j);

/* Completion steps (SPEC §7.4). */
static int finish_job(dl_job *j) {
  settings_t s;
  settings_get(&s);
  pthread_mutex_lock(&queue_mu);
  int fd = j->fd;
  j->fd = -1;
  int do_verify = strcmp(j->verify, "sha256") == 0 && j->sha256Expected[0];
  if (do_verify) { j->state = DL_VERIFYING; xstrlcpy(j->phase, "sha256", sizeof j->phase); j->written = 0; }
  pthread_mutex_unlock(&queue_mu);
  if (fd >= 0) { fsync(fd); close(fd); }
  if (do_verify) {
    char hex[65] = "";
    int v = verify_file(j, j->xpart, hex);
    if (v < 0) return OUT_STOPPED;
    pthread_mutex_lock(&queue_mu);
    xstrlcpy(j->sha256, hex, sizeof j->sha256);
    j->verified = v == 1;
    j->written = j->total;
    pthread_mutex_unlock(&queue_mu);
    if (v == 0) {
      seg_fail(j, 0, 0, "hash_mismatch", "The downloaded file does not match the expected SHA-256. The partial was kept for inspection.");
      return OUT_FATAL;
    }
    jlog(j, "sha256 verified");
  }
  if (rename(j->xpart, j->path) != 0) { seg_fail(j, 0, 0, "io_error", "Cannot rename the finished file"); return OUT_FATAL; }
  util_unlink_quiet(j->sidecar);
  util_fsync_dir(j->path);
  char fb[32];
  pthread_mutex_lock(&queue_mu);
  j->state = DL_DONE;
  j->finishedAt = util_now();
  j->phase[0] = 0;
  clear_error_locked(j);
  if (j->total > 0) j->written = j->total;
  else j->total = j->written;
  util_fmt_bytes(j->total, fb, sizeof fb);
  free(j->chunks);
  j->chunks = NULL;
  j->nchunks = 0;
  xsnprintf(j->message, sizeof j->message, "Downloaded (%s)", fb);
  jlog_locked(j, "done: %s", fb);
  int want_install = is_pkg_format(j->format) && (j->autoInstall || s.autoInstallPkg);
  int want_scan = is_image_format(j->format) && s.shadowMountScan;
  pthread_mutex_unlock(&queue_mu);
  if (s.toasts && s.onComplete) sys_toast("✓ %s downloaded (%s)", j->title, fb);
  if (want_install) {
    pthread_mutex_lock(&queue_mu);
    mark_installing_locked(j);
    pthread_mutex_unlock(&queue_mu);
    install_run(j);   /* on the worker thread; DPI probes may take a while */
  }
  if (want_scan) {
    char st[160];
    install_shadowmount_scan(st, sizeof st);
    jlog(j, "ShadowMount scan: %s", st);
  }
  return OUT_DONE;
}

static int next_backoff(int attempts, int retry_after) {
  int d = BACKOFF_S[XS_MIN(attempts, (int)XS_ARRAY_LEN(BACKOFF_S) - 1)];
  return retry_after > d ? retry_after : d;
}

static int switch_mirror_locked(dl_job *j) {
  int next = j->mirror_idx + 1;
  if (next >= j->nmirrors) return -1;
  j->mirror_idx = next;
  xstrlcpy(j->activeUrl, j->mirrors[next], sizeof j->activeUrl);
  char host[256];
  util_url_host(j->activeUrl, host, sizeof host);
  xsnprintf(j->message, sizeof j->message, "Switched to mirror %s", host);
  jlog_locked(j, "failover %s → mirror %d (%s)", j->seg_code, next + 1, host);
  j->seg_fatal = 0;
  j->stop_io = 0;
  j->seg_code[0] = j->seg_error[0] = 0;
  return 0;
}

static void worker_fail_locked(dl_job *j) {
  j->state = DL_FAILED;
  j->finishedAt = util_now();
  set_error_locked(j, j->seg_code[0] ? j->seg_code : "error", j->seg_error[0] ? j->seg_error : "Download failed");
  j->speed = 0;
  j->eta = 0;
  j->nextRetryAt = 0;
}

static void run_job(dl_job *j) {
  settings_t s;
  settings_get(&s);
  pthread_mutex_lock(&queue_mu);
  j->state = DL_CONNECTING;
  if (!j->startedAt) j->startedAt = util_now();
  j->cancel = 0;
  j->stop_io = 0;
  j->seg_fatal = 0;
  j->drive_missing = 0;
  j->insecure_tls = s.allowInsecureTls;
  j->nextRetryAt = 0;
  j->phase[0] = 0;
  j->message[0] = 0;
  j->attempts++;
  jlog_locked(j, "attempt %d via %s", j->attempts, j->mirror_idx < 0 ? "primary" : "mirror");
  pthread_mutex_unlock(&queue_mu);

  if (!storage_root_present(j->root)) {
    pthread_mutex_lock(&queue_mu);
    j->state = DL_PAUSED;
    set_error_locked(j, "drive_missing", "The destination drive is not connected");
    pthread_mutex_unlock(&queue_mu);
    return;
  }
  storage_ensure_parent_dir(j->path);
  if (space_check(j)) { pthread_mutex_lock(&queue_mu); if (j->drive_missing) { j->state = DL_PAUSED; set_error_locked(j, "drive_missing", "The destination drive is not connected"); } else worker_fail_locked(j); pthread_mutex_unlock(&queue_mu); return; }

  int out;
  for (;;) {
    out = probe_and_plan(j);
    if (out == OUT_DONE && open_partial(j) != 0) out = OUT_FATAL;
    if (out == OUT_DONE) out = transfer(j);
    if (out == OUT_DONE) out = finish_job(j);
    if (out == OUT_FAILOVER) {
      pthread_mutex_lock(&queue_mu);
      int sw = j->cancel ? -1 : switch_mirror_locked(j);
      if (j->fd >= 0) { close(j->fd); j->fd = -1; }
      pthread_mutex_unlock(&queue_mu);
      if (sw == 0) continue;
      out = OUT_FATAL;
    }
    break;
  }
  pthread_mutex_lock(&queue_mu);
  if (j->fd >= 0) { close(j->fd); j->fd = -1; }
  if (out == OUT_STOPPED || j->cancel) {
    /* the action that stopped us already set the state */
    j->speed = 0;
    j->eta = 0;
  } else if (out == OUT_RETRY) {
    int max_attempts = s.retryMax > 0 ? s.retryMax : 8;
    if (j->attempts >= max_attempts) {
      worker_fail_locked(j);
      xsnprintf(j->message, sizeof j->message, "Gave up after %d attempts: %s", j->attempts, j->seg_error);
    } else {
      int delay = next_backoff(j->attempts - 1, j->retry_after);
      j->state = DL_QUEUED;
      j->nextRetryAt = util_now() + delay;
      xstrlcpy(j->errorCode, j->seg_code, sizeof j->errorCode);
      xstrlcpy(j->error, j->seg_error, sizeof j->error);
      xsnprintf(j->message, sizeof j->message, "Retrying in %d s (%s)", delay, j->seg_error);
      jlog_locked(j, "retry %d/%d in %d s", j->attempts, max_attempts, delay);
    }
  } else if (out == OUT_FATAL) {
    if (j->drive_missing) { j->state = DL_PAUSED; set_error_locked(j, "drive_missing", "The destination drive disappeared"); }
    else worker_fail_locked(j);
  }
  queue_dirty = 1;
  int failed = j->state == DL_FAILED;
  char title[256], msg[256];
  xstrlcpy(title, j->title, sizeof title);
  xstrlcpy(msg, j->message, sizeof msg);
  pthread_mutex_unlock(&queue_mu);
  if (failed && s.toasts && s.onFail) sys_toast("✗ %s failed: %s", title, msg);
}

static void *job_worker(void *arg) {
  dl_job *j = arg;
  run_job(j);
  pthread_mutex_lock(&queue_mu);
  if (j->discard_partial) {
    remove_partial_files(j);
    j->written = 0;
    free(j->chunks);
    j->chunks = NULL;
    j->nchunks = 0;
    j->discard_partial = 0;
  }
  if (j->delete_files_pending && !j->remove_pending) { remove_partial_files(j); j->delete_files_pending = 0; }
  j->running = 0;
  j->active_segments = 0;
  queue_dirty = 1;
  pthread_mutex_unlock(&queue_mu);
  return NULL;
}

/* ---- install -------------------------------------------------------------- */

/* Starts the install and applies the result; runs on the job worker (which
 * already owns `running`) or on a short-lived thread for API requests. */
static void install_run(dl_job *j) {
  install_result res;
  install_start(j->path, g_port, &res);
  pthread_mutex_lock(&queue_mu);
  j->install.rc = res.rc;
  xstrlcpy(j->install.contentId, res.contentId, sizeof j->install.contentId);
  xstrlcpy(j->install.titleId, res.titleId, sizeof j->install.titleId);
  xstrlcpy(j->install.token, res.token, sizeof j->install.token);
  xstrlcpy(j->install.via, res.via, sizeof j->install.via);
  xstrlcpy(j->install.message, res.message, sizeof j->install.message);
  if (!j->titleId[0] && res.titleId[0]) xstrlcpy(j->titleId, res.titleId, sizeof j->titleId);
  if (res.ok) {
    xstrlcpy(j->install.state, "installing", sizeof j->install.state);
    j->install.startedAt = util_now();
    j->state = DL_INSTALLING;
  } else {
    xstrlcpy(j->install.state, "failed", sizeof j->install.state);
    j->state = j->synthetic ? DL_FAILED : DL_DONE;
    set_error_locked(j, "install_failed", res.message);
  }
  jlog_locked(j, "install: %s (%s)", res.message, res.via[0] ? res.via : "n/a");
  queue_dirty = 1;
  pthread_mutex_unlock(&queue_mu);
}

static void *install_thread(void *arg) {
  dl_job *j = arg;
  install_run(j);
  pthread_mutex_lock(&queue_mu);
  j->running = 0;
  pthread_mutex_unlock(&queue_mu);
  return NULL;
}

static void mark_installing_locked(dl_job *j) {
  j->state = DL_INSTALLING;
  xstrlcpy(j->install.state, "installing", sizeof j->install.state);
  xstrlcpy(j->install.message, "Starting install", sizeof j->install.message);
  j->install.startedAt = util_now();
}

/* Starts the PKG install in a short-lived thread (DPI probes may block). */
static void begin_install(dl_job *j) {
  pthread_mutex_lock(&queue_mu);
  if (j->running) { pthread_mutex_unlock(&queue_mu); return; }
  j->running = 1;
  mark_installing_locked(j);
  pthread_mutex_unlock(&queue_mu);
  pthread_t th;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  if (pthread_create(&th, &attr, install_thread, j) != 0) {
    pthread_mutex_lock(&queue_mu);
    j->running = 0;
    j->state = j->synthetic ? DL_FAILED : DL_DONE;
    xstrlcpy(j->install.state, "failed", sizeof j->install.state);
    set_error_locked(j, "install_failed", "Cannot start the install thread");
    pthread_mutex_unlock(&queue_mu);
  }
  pthread_attr_destroy(&attr);
}

/* Caller holds queue_mu and passes its settings snapshot (SPEC §5: no second
 * lock under queue_mu). Tokens to release are returned to the caller. */
static int poll_installs(const settings_t *sp, char (*toks)[24], int tokcap) {
  const settings_t s = *sp;
  int ntok = 0;
  for (int i = 0; i < n_jobs; i++) {
    dl_job *j = jobs[i];
    if (j->state != DL_INSTALLING || j->running || strcmp(j->install.state, "installing") != 0) continue;
    char msg[256];
    int r = install_poll(j->install.titleId[0] ? j->install.titleId : j->titleId, j->install.contentId, j->install.startedAt, msg, sizeof msg);
    if (r == 0) continue;
    if (r > 0) {
      j->state = DL_INSTALLED;
      xstrlcpy(j->install.state, "installed", sizeof j->install.state);
      xstrlcpy(j->install.message, msg, sizeof j->install.message);
      xstrlcpy(j->message, "Installed", sizeof j->message);
      j->finishedAt = util_now();
      jlog_locked(j, "installed");
      if (s.toasts && s.onInstall) sys_toast("✓ %s installed", j->title);
    } else {
      xstrlcpy(j->install.state, "failed", sizeof j->install.state);
      xstrlcpy(j->install.message, msg, sizeof j->install.message);
      j->state = j->synthetic ? DL_FAILED : DL_DONE;
      set_error_locked(j, "install_failed", msg);
      jlog_locked(j, "install failed: %s", msg);
      if (s.toasts && s.onFail) sys_toast("✗ %s install failed", j->title);
    }
    if (ntok < tokcap && j->install.token[0]) xstrlcpy(toks[ntok++], j->install.token, 24);
    queue_dirty = 1;
  }
  return ntok;
}

static void release_tokens(char (*toks)[24], int n) {
  for (int i = 0; i < n; i++) install_release_token(toks[i]);
}

/* ---- verify action -------------------------------------------------------- */

static void *verify_thread(void *arg) {
  dl_job *j = arg;
  char hex[65] = "";
  int v = verify_file(j, j->path, hex);
  pthread_mutex_lock(&queue_mu);
  j->state = j->verify_prev_state;
  j->phase[0] = 0;
  if (v < 0) { xstrlcpy(j->message, "Verification interrupted", sizeof j->message); }
  else {
    xstrlcpy(j->sha256, hex, sizeof j->sha256);
    j->verified = v == 1 && j->sha256Expected[0];
    if (!j->sha256Expected[0]) xstrlcpy(j->message, "SHA-256 computed (no expected hash to compare)", sizeof j->message);
    else if (v == 1) xstrlcpy(j->message, "SHA-256 verified", sizeof j->message);
    else { xstrlcpy(j->message, "SHA-256 does not match the catalog", sizeof j->message); xstrlcpy(j->errorCode, "hash_mismatch", sizeof j->errorCode); }
  }
  if (j->total > 0) j->written = j->total;
  jlog_locked(j, "verify: %s", j->message);
  j->running = 0;
  queue_dirty = 1;
  pthread_mutex_unlock(&queue_mu);
  return NULL;
}

/* ---- scheduler ------------------------------------------------------------ */

static int start_worker_locked(dl_job *j) {
  j->running = 1;
  j->cancel = 0;
  j->stop_io = 0;
  pthread_t th;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  int rc = pthread_create(&th, &attr, job_worker, j);
  pthread_attr_destroy(&attr);
  if (rc != 0) { j->running = 0; LOGE("dl: cannot create worker for %s", j->id); return -1; }
  return 0;
}

static int reap_removed_locked(char (*toks)[24], int tokcap) {
  int ntok = 0;
  for (int i = 0; i < n_jobs;) {
    dl_job *j = jobs[i];
    if (j->remove_pending && !j->running) {
      if (j->delete_files_pending) { remove_partial_files(j); if (j->state == DL_DONE || j->state == DL_INSTALLED) util_unlink_quiet(j->path); }
      if (ntok < tokcap && j->install.token[0]) xstrlcpy(toks[ntok++], j->install.token, 24);
      memmove(&jobs[i], &jobs[i + 1], (size_t)(n_jobs - i - 1) * sizeof jobs[0]);
      n_jobs--;
      job_free(j);
      queue_dirty = 1;
      continue;
    }
    i++;
  }
  return ntok;
}

void dl_housekeeping_tick(void) {
  settings_t s;
  settings_get(&s);
  pthread_mutex_lock(&bucket_mu);
  bucket_rate = s.maxBytesPerSec;
  pthread_mutex_unlock(&bucket_mu);
  time_t now = util_now();
  int64_t now_ms = util_now_ms();
  char toks[16][24];
  int ntok = 0;
  pthread_mutex_lock(&queue_mu);
  ntok = reap_removed_locked(toks, 16);
  int running = 0, downloading = 0;
  for (int i = 0; i < n_jobs; i++) {
    if (jobs[i]->running && state_is_active(jobs[i]->state)) running++;
    if (jobs[i]->state == DL_DOWNLOADING) downloading++;
  }
  int max_jobs = s.concurrentJobs < 1 ? 1 : s.concurrentJobs > 4 ? 4 : s.concurrentJobs;
  /* Higher priority first, then queue order. */
  for (int prio_pass = 0; prio_pass < 2 && running < max_jobs; prio_pass++) {
    int best = -1;
    for (int i = 0; i < n_jobs && running < max_jobs; i++) {
      dl_job *j = jobs[i];
      if (j->state != DL_QUEUED || j->running || j->synthetic || j->nextRetryAt > now) continue;
      if (best < 0 || j->priority > jobs[best]->priority) best = i;
    }
    if (best < 0) break;
    if (start_worker_locked(jobs[best]) == 0) running++;
    else break;
  }
  if (now_ms - last_install_poll_ms >= 2000) { last_install_poll_ms = now_ms; ntok += poll_installs(&s, toks + ntok, 16 - ntok); }
  int dirty = queue_dirty;
  int any_running = running > 0;
  pthread_mutex_unlock(&queue_mu);
  release_tokens(toks, ntok);
  if (downloading && s.keepAwake && now - last_keepawake >= 30) { last_keepawake = now; sys_keep_awake_tick(); }
  if ((dirty || any_running) && now_ms - last_save_ms >= QUEUE_SAVE_EVERY_MS) dl_save_queue();
}

int dl_any_downloading(void) {
  int r = 0;
  pthread_mutex_lock(&queue_mu);
  for (int i = 0; i < n_jobs; i++) if (jobs[i]->state == DL_DOWNLOADING) { r = 1; break; }
  pthread_mutex_unlock(&queue_mu);
  return r;
}

/* ---- init / shutdown ---------------------------------------------------- */

static void load_queue(void) {
  char path[600];
  xsnprintf(path, sizeof path, "%s/queue.json", data_dir);
  size_t len;
  char *txt = util_read_file(path, &len, 16u << 20);
  if (!txt) return;
  jdoc *d = json_parse(txt, len, 400000, 16);
  free(txt);
  if (!d) { LOGW("queue.json is not valid JSON — starting with an empty queue"); return; }
  int recovered = 0;
  JV_FOREACH(o, jv_get(json_root(d), "jobs")) {
    if (n_jobs >= DL_MAX_JOBS) break;
    dl_job *j = job_from_json(o);
    if (!j) continue;
    if (state_is_active(j->state)) {
      j->state = DL_PAUSED;
      xstrlcpy(j->message, "Stopped when XENO STORE closed", sizeof j->message);
      recovered++;
    }
    if (j->state == DL_PAUSED || j->state == DL_QUEUED) {
      sidecar sc;
      if (util_file_exists(j->xpart) && sidecar_load(j, &sc) == 0) {
        if (!j->total && sc.total) j->total = sc.total;
        if (!j->segmented) j->segmented = j->connections > 1;
        plan_resume_locked(j, &sc);   /* for the segments visual; rebuilt on resume */
      } else if (!util_file_exists(j->xpart)) {
        j->written = 0;
      }
    }
    if (j->state == DL_INSTALLING && strcmp(j->install.state, "installing") != 0) j->state = DL_DONE;
    jobs[n_jobs++] = j;
  }
  json_free(d);
  LOGI("queue: %d job(s) loaded, %d marked paused", n_jobs, recovered);
}

int dl_init(const char *dir, int port) {
  xstrlcpy(data_dir, dir, sizeof data_dir);
  g_port = port;
  pthread_mutex_lock(&queue_mu);
  load_queue();
  pthread_mutex_unlock(&queue_mu);
  storage_set_job_lookup(dl_find_job_by_path);
  return 0;
}

void dl_shutdown(void) {
  pthread_mutex_lock(&queue_mu);
  int n = 0;
  for (int i = 0; i < n_jobs; i++) {
    dl_job *j = jobs[i];
    if (j->running && state_is_active(j->state)) { j->cancel = DL_STOP_SHUTDOWN; j->stop_io = 1; n++; }
  }
  pthread_mutex_unlock(&queue_mu);
  if (n) LOGI("dl: stopping %d running job(s)", n);
  for (int i = 0; i < 100; i++) {   /* ≤ 5 s */
    pthread_mutex_lock(&queue_mu);
    int busy = 0;
    for (int k = 0; k < n_jobs; k++) if (jobs[k]->running && state_is_active(jobs[k]->state)) busy++;
    pthread_mutex_unlock(&queue_mu);
    if (!busy) break;
    util_sleep_ms(50);
  }
  dl_save_queue();
}

/* ---- queries ------------------------------------------------------------ */

void dl_summary_get(dl_summary *out) {
  settings_t s;
  settings_get(&s);
  memset(out, 0, sizeof *out);
  double speed = 0;
  pthread_mutex_lock(&queue_mu);
  for (int i = 0; i < n_jobs; i++) {
    dl_job *j = jobs[i];
    switch (j->state) {
      case DL_QUEUED: out->queued++; break;
      case DL_PAUSED: out->paused++; break;
      case DL_FAILED: out->failed++; break;
      case DL_DONE: case DL_INSTALLED: out->done++; break;
      case DL_CANCELLED: break;
      default: out->active++;
    }
    if (state_is_unfinished(j->state) && j->total > j->written) out->remaining += j->total - j->written;
    if (j->state == DL_DOWNLOADING) speed += j->speed;
    if (j->state == DL_DOWNLOADING && s.keepAwake) out->keepAwake = 1;
  }
  pthread_mutex_unlock(&queue_mu);
  out->speed = (int64_t)speed;
  out->eta = speed > 0 ? (int64_t)((double)out->remaining / speed) : 0;
}

void dl_queue_json(jw *w, int history) {
  dl_summary s;
  dl_summary_get(&s);
  pthread_mutex_lock(&queue_mu);
  jw_key(w, "jobs"); jw_arr_begin(w);
  for (int i = 0; i < n_jobs; i++) job_write_json(w, jobs[i], history);
  jw_arr_end(w);
  pthread_mutex_unlock(&queue_mu);
  jw_key(w, "summary"); jw_obj_begin(w);
  jw_kv_int(w, "active", s.active); jw_kv_int(w, "queued", s.queued); jw_kv_int(w, "paused", s.paused);
  jw_kv_int(w, "failed", s.failed); jw_kv_int(w, "done", s.done); jw_kv_i64(w, "speed", s.speed);
  jw_kv_i64(w, "remaining", s.remaining); jw_kv_i64(w, "eta", s.eta); jw_kv_bool(w, "keepAwake", s.keepAwake);
  jw_obj_end(w);
}

int dl_job_json(jw *w, const char *id, int history) {
  pthread_mutex_lock(&queue_mu);
  dl_job *j = find_locked(id);
  if (j) job_write_json(w, j, history);
  pthread_mutex_unlock(&queue_mu);
  if (!j) jw_null(w);
  return j ? 0 : -1;
}

int dl_job_log_json(jw *w, const char *id) {
  pthread_mutex_lock(&queue_mu);
  dl_job *j = find_locked(id);
  if (j) {
    jw_key(w, "lines"); jw_arr_begin(w);
    for (int i = 0; i < j->log_n; i++) jw_str(w, j->log[(j->log_head + i) % DL_JOB_LOG_LINES]);
    jw_arr_end(w);
  }
  pthread_mutex_unlock(&queue_mu);
  return j ? 0 : -1;
}

int64_t dl_remaining_on_root(const char *root) {
  int64_t sum = 0;
  pthread_mutex_lock(&queue_mu);
  for (int i = 0; i < n_jobs; i++) {
    dl_job *j = jobs[i];
    if (strcmp(j->root, root) == 0 && state_is_unfinished(j->state) && j->total > j->written) sum += j->total - j->written;
  }
  pthread_mutex_unlock(&queue_mu);
  return sum;
}

int dl_find_job_by_path(const char *path, char *id, size_t cap) {
  int rc = -1;
  pthread_mutex_lock(&queue_mu);
  for (int i = 0; i < n_jobs; i++) {
    if (strcmp(jobs[i]->path, path) == 0 || strcmp(jobs[i]->xpart, path) == 0) { xstrlcpy(id, jobs[i]->id, cap); rc = 0; break; }
  }
  pthread_mutex_unlock(&queue_mu);
  return rc;
}

/* ---- add ---------------------------------------------------------------- */

static int fill_from_catalog(dl_job *j, const dl_add_req *r, char *code, size_t ccap, char *msg, size_t mcap) {
  cat_game g;
  cat_release rel;
  if (catalog_find_release(r->gameId, r->releaseId, &g, &rel) != 0) {
    xstrlcpy(code, "bad_release", ccap);
    xsnprintf(msg, mcap, "Unknown game or release (%s / %s)", r->gameId, r->releaseId);
    return -1;
  }
  if (util_strieq(rel.format, "PAGE") || !util_istarts_with(rel.url, "http")) {
    xstrlcpy(code, "bad_release", ccap);
    xsnprintf(msg, mcap, "This release is a web page, not a file. Use Get links or enter the direct file link.");
    return -1;
  }
  xstrlcpy(j->gameId, g.id, sizeof j->gameId);
  xstrlcpy(j->title, g.title, sizeof j->title);
  xstrlcpy(j->titleId, rel.titleId[0] ? rel.titleId : (g.ntitleIds ? g.titleIds[0] : ""), sizeof j->titleId);
  xstrlcpy(j->platform, g.platform, sizeof j->platform);
  xstrlcpy(j->cover, g.cover, sizeof j->cover);
  xstrlcpy(j->releaseId, rel.id, sizeof j->releaseId);
  xstrlcpy(j->format, rel.format, sizeof j->format);
  xstrlcpy(j->provider, rel.provider, sizeof j->provider);
  xstrlcpy(j->sourceId, rel.sourceId, sizeof j->sourceId);
  xstrlcpy(j->url, rel.url, sizeof j->url);
  xstrlcpy(j->sha256Expected, rel.sha256, sizeof j->sha256Expected);
  j->total = rel.sizeBytes;
  char fn[256];
  if (rel.filename[0]) xstrlcpy(fn, rel.filename, sizeof fn);
  else util_url_filename(rel.url, fn, sizeof fn);
  if (storage_sanitize_filename(fn, j->filename, sizeof j->filename) != 0) {
    xstrlcpy(code, "bad_release", ccap);
    xsnprintf(msg, mcap, "The release has no usable filename");
    return -1;
  }
  char (*m)[1024] = calloc(DL_MAX_MIRRORS, 1024);
  if (m) {
    j->nmirrors = catalog_collect_mirrors(g.id, &rel, m, DL_MAX_MIRRORS);
    for (int i = 0; i < j->nmirrors; i++) xstrlcpy(j->mirrors[i], m[i], sizeof j->mirrors[0]);
    free(m);
  }
  return 0;
}

static int fill_from_url(dl_job *j, const dl_add_req *r, char *code, size_t ccap, char *msg, size_t mcap) {
  xurl u;
  if (util_url_parse(r->url, &u) != 0 || u.has_userinfo) {
    xstrlcpy(code, "bad_request", ccap);
    xsnprintf(msg, mcap, "url must be http(s) without credentials");
    return -1;
  }
  xstrlcpy(j->url, r->url, sizeof j->url);
  char fn[256];
  if (r->filename && r->filename[0]) xstrlcpy(fn, r->filename, sizeof fn);
  else util_url_filename(r->url, fn, sizeof fn);
  if (storage_sanitize_filename(fn, j->filename, sizeof j->filename) != 0) {
    xstrlcpy(code, "bad_request", ccap);
    xsnprintf(msg, mcap, "filename is required for this link");
    return -1;
  }
  if (r->format && r->format[0]) xstrlcpy(j->format, r->format, sizeof j->format);
  else { util_ext(j->filename, j->format, sizeof j->format); util_upper(j->format); }
  xstrlcpy(j->title, r->title && r->title[0] ? r->title : j->filename, sizeof j->title);
  util_find_titleid(j->filename, j->titleId, sizeof j->titleId);
  cat_game g;
  if (j->titleId[0] && catalog_match_titleid(j->titleId, &g) == 0) {
    xstrlcpy(j->gameId, g.id, sizeof j->gameId);
    xstrlcpy(j->cover, g.cover, sizeof j->cover);
    xstrlcpy(j->platform, g.platform, sizeof j->platform);
    if (!(r->title && r->title[0])) xstrlcpy(j->title, g.title, sizeof j->title);
  }
  if (!j->platform[0]) xstrlcpy(j->platform, util_starts_with(j->titleId, "CUSA") ? "PS4" : "PS5", sizeof j->platform);
  util_url_host(r->url, j->provider, sizeof j->provider);
  xstrlcpy(j->sourceId, "other", sizeof j->sourceId);
  if (r->sha256 && strlen(r->sha256) == 64) { xstrlcpy(j->sha256Expected, r->sha256, sizeof j->sha256Expected); util_lower(j->sha256Expected); }
  j->total = r->size > 0 ? r->size : 0;
  JV_FOREACH(m, r->mirrors) {
    const char *mu = jv_str(m, NULL);
    if (mu && util_istarts_with(mu, "http") && j->nmirrors < DL_MAX_MIRRORS) xstrlcpy(j->mirrors[j->nmirrors++], mu, sizeof j->mirrors[0]);
  }
  return 0;
}

static int pick_root(const char *want, storage_root *out) {
  if (want && *want) return storage_find_root(want, out);
  storage_root roots[STORAGE_MAX_ROOTS];
  int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
  for (int i = 0; i < n; i++) if (roots[i].is_default) { *out = roots[i]; return 0; }
  if (n) { *out = roots[0]; return 0; }
  return -1;
}

int dl_add(const dl_add_req *r, char *job_id, size_t idcap, char *code, size_t ccap, char *msg, size_t mcap) {
  settings_t s;
  settings_get(&s);
  if (!xhttp_available()) { xstrlcpy(code, "downloads_unavailable", ccap); xsnprintf(msg, mcap, "Downloads are unavailable on this firmware"); return -1; }
  dl_job *j = calloc(1, sizeof *j);
  if (!j) { xstrlcpy(code, "oom", ccap); xsnprintf(msg, mcap, "Out of memory"); return -1; }
  j->fd = -1;
  j->mirror_idx = -1;
  int rc;
  if (r->gameId && r->gameId[0] && r->releaseId && r->releaseId[0]) rc = fill_from_catalog(j, r, code, ccap, msg, mcap);
  else if (r->url && r->url[0]) rc = fill_from_url(j, r, code, ccap, msg, mcap);
  else { xstrlcpy(code, "bad_release", ccap); xsnprintf(msg, mcap, "gameId + releaseId or a direct url are required"); rc = -1; }
  if (rc != 0) { free(j); return -1; }

  storage_root root;
  if (pick_root(r->root, &root) != 0 || !storage_root_present(root.path)) {
    xstrlcpy(code, "root_unavailable", ccap); xsnprintf(msg, mcap, "The chosen drive is not available"); free(j); return -1;
  }
  if (!root.writable) { xstrlcpy(code, "root_unavailable", ccap); xsnprintf(msg, mcap, "%s is not writable", root.label); free(j); return -1; }
  xstrlcpy(j->root, root.path, sizeof j->root);
  xstrlcpy(j->rootLabel, root.label, sizeof j->rootLabel);
  if (storage_join(root.path, storage_category_for_format(j->format), j->filename, j->path, sizeof j->path) != 0) {
    xstrlcpy(code, "bad_request", ccap); xsnprintf(msg, mcap, "Cannot build a safe destination path"); free(j); return -1;
  }
  derive_paths_locked(j);
  j->connections = r->connections > 0 ? r->connections : s.connections;
  if (j->connections < 1) j->connections = 1;
  if (j->connections > DL_MAX_SEGMENTS) j->connections = DL_MAX_SEGMENTS;
  int verify_hash = r->verify == 1 || (r->verify == -1 && s.verifyHashes);
  xstrlcpy(j->verify, (j->sha256Expected[0] && verify_hash) ? "sha256" : j->total > 0 ? "size" : "none", sizeof j->verify);
  j->autoInstall = r->autoInstall == 1 || (r->autoInstall == -1 && s.autoInstallPkg);
  j->resumable = 1;
  j->addedAt = util_now();
  xstrlcpy(j->install.state, "idle", sizeof j->install.state);

  pthread_mutex_lock(&queue_mu);
  for (int i = 0; i < n_jobs; i++) {
    dl_job *o = jobs[i];
    if (strcmp(o->path, j->path) != 0) continue;
    if (o->state == DL_FAILED || o->state == DL_CANCELLED) continue;
    if (r->overwrite && (o->state == DL_DONE || o->state == DL_INSTALLED) && !o->running) {
      memmove(&jobs[i], &jobs[i + 1], (size_t)(n_jobs - i - 1) * sizeof jobs[0]);
      n_jobs--;
      job_free(o);
      i--;
      continue;
    }
    pthread_mutex_unlock(&queue_mu);
    xstrlcpy(code, "exists", ccap);
    xsnprintf(msg, mcap, "%s is already in the queue (%s)", j->filename, dl_state_name(o->state));
    free(j);
    return -1;
  }
  if (util_file_exists(j->path)) {
    if (!r->overwrite) {
      pthread_mutex_unlock(&queue_mu);
      xstrlcpy(code, "exists", ccap);
      xsnprintf(msg, mcap, "%s already exists on %s", j->filename, root.label);
      free(j);
      return -1;
    }
    util_unlink_quiet(j->path);
  }
  if (n_jobs >= DL_MAX_JOBS) { pthread_mutex_unlock(&queue_mu); xstrlcpy(code, "queue_full", ccap); xsnprintf(msg, mcap, "The queue is full (%d jobs)", DL_MAX_JOBS); free(j); return -1; }
  int64_t queued_on_root = 0;
  for (int i = 0; i < n_jobs; i++)
    if (strcmp(jobs[i]->root, j->root) == 0 && state_is_unfinished(jobs[i]->state) && jobs[i]->total > jobs[i]->written) queued_on_root += jobs[i]->total - jobs[i]->written;
  if (j->total > 0 && root.free - queued_on_root < j->total + DL_RESERVE_BYTES) {
    pthread_mutex_unlock(&queue_mu);
    char a[32], b[32];
    util_fmt_bytes(j->total, a, sizeof a);
    util_fmt_bytes(root.free - queued_on_root, b, sizeof b);
    xstrlcpy(code, "no_space", ccap);
    xsnprintf(msg, mcap, "Not enough free space on %s: need %s + 256 MB reserve, have %s after the queue", root.label, a, b);
    free(j);
    return -1;
  }
  do { util_rand_id("j_", j->id, sizeof j->id); } while (find_locked(j->id));
  j->state = DL_QUEUED;
  jobs[n_jobs++] = j;
  jlog_locked(j, "queued %s → %s (%d connections)", j->url, j->path, j->connections);
  queue_dirty = 1;
  xstrlcpy(job_id, j->id, idcap);
  pthread_mutex_unlock(&queue_mu);
  dl_save_queue();
  return 0;
}

int dl_add_install_job(const char *path, char *job_id, size_t idcap, char *msg, size_t mcap) {
  char cid[40], tid[16];
  if (install_read_pkg_header(path, cid, sizeof cid, tid, sizeof tid) != 0) { xsnprintf(msg, mcap, "Not a PS4/PS5 package"); return -1; }
  dl_job *j = calloc(1, sizeof *j);
  if (!j) { xsnprintf(msg, mcap, "Out of memory"); return -1; }
  j->fd = -1;
  j->mirror_idx = -1;
  j->synthetic = 1;
  xstrlcpy(j->path, path, sizeof j->path);
  xstrlcpy(j->filename, util_basename(path), sizeof j->filename);
  xstrlcpy(j->format, "PKG", sizeof j->format);
  xstrlcpy(j->titleId, tid, sizeof j->titleId);
  xstrlcpy(j->install.contentId, cid, sizeof j->install.contentId);
  cat_game g;
  if (tid[0] && catalog_match_titleid(tid, &g) == 0) {
    xstrlcpy(j->gameId, g.id, sizeof j->gameId); xstrlcpy(j->title, g.title, sizeof j->title);
    xstrlcpy(j->cover, g.cover, sizeof j->cover); xstrlcpy(j->platform, g.platform, sizeof j->platform);
  } else {
    xstrlcpy(j->title, j->filename, sizeof j->title);
    xstrlcpy(j->platform, util_starts_with(tid, "CUSA") ? "PS4" : "PS5", sizeof j->platform);
  }
  storage_root roots[STORAGE_MAX_ROOTS];
  int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
  for (int i = 0; i < n; i++) if (util_starts_with(path, roots[i].path)) { xstrlcpy(j->root, roots[i].path, sizeof j->root); xstrlcpy(j->rootLabel, roots[i].label, sizeof j->rootLabel); break; }
  j->total = j->written = util_file_size(path);
  if (j->total < 0) j->total = j->written = 0;
  j->addedAt = j->startedAt = util_now();
  xstrlcpy(j->verify, "none", sizeof j->verify);
  derive_paths_locked(j);
  pthread_mutex_lock(&queue_mu);
  if (n_jobs >= DL_MAX_JOBS) { pthread_mutex_unlock(&queue_mu); free(j); xsnprintf(msg, mcap, "The queue is full"); return -1; }
  do { util_rand_id("j_", j->id, sizeof j->id); } while (find_locked(j->id));
  j->state = DL_INSTALLING;
  jobs[n_jobs++] = j;
  jlog_locked(j, "library install of %s", path);
  queue_dirty = 1;
  xstrlcpy(job_id, j->id, idcap);
  pthread_mutex_unlock(&queue_mu);
  begin_install(j);
  return 0;
}

/* ---- actions ------------------------------------------------------------ */

static int act_move_locked(dl_job *j, const char *dir) {
  int idx = -1;
  for (int i = 0; i < n_jobs; i++) if (jobs[i] == j) idx = i;
  if (idx < 0) return -1;
  int target = idx;
  if (strcmp(dir, "up") == 0) { for (int i = idx - 1; i >= 0; i--) if (jobs[i]->state == DL_QUEUED) { target = i; break; } }
  else if (strcmp(dir, "down") == 0) { for (int i = idx + 1; i < n_jobs; i++) if (jobs[i]->state == DL_QUEUED) { target = i; break; } }
  else if (strcmp(dir, "top") == 0) target = 0;
  else if (strcmp(dir, "bottom") == 0) target = n_jobs - 1;
  else return -1;
  if (target == idx) return 0;
  if (target < idx) { memmove(&jobs[target + 1], &jobs[target], (size_t)(idx - target) * sizeof jobs[0]); }
  else { memmove(&jobs[idx], &jobs[idx + 1], (size_t)(target - idx) * sizeof jobs[0]); }
  jobs[target] = j;
  return 0;
}

static void act_stop_locked(dl_job *j, int reason, dl_state new_state, const char *msg) {
  if (j->running && state_is_active(j->state)) { j->cancel = reason; j->stop_io = 1; }
  j->state = new_state;
  j->nextRetryAt = 0;
  j->speed = 0;
  j->eta = 0;
  xstrlcpy(j->message, msg, sizeof j->message);
  if (new_state == DL_PAUSED) { j->errorCode[0] = 0; j->error[0] = 0; }
}

static int act_url_locked(dl_job *j, jv body, char *code, size_t ccap, char *msg, size_t mcap) {
  const char *u = jv_get_str(body, "url", "");
  xurl pu;
  if (util_url_parse(u, &pu) != 0 || pu.has_userinfo) { xstrlcpy(code, "bad_request", ccap); xsnprintf(msg, mcap, "url must be http(s) without credentials"); return -1; }
  if (j->running && state_is_active(j->state)) { j->cancel = DL_STOP_PAUSE; j->stop_io = 1; }
  xstrlcpy(j->url, u, sizeof j->url);
  xstrlcpy(j->activeUrl, u, sizeof j->activeUrl);
  j->mirror_idx = -1;
  j->url_replaced = 1;
  j->attempts = 0;
  j->state = DL_QUEUED;
  j->nextRetryAt = 0;
  clear_error_locked(j);
  xstrlcpy(j->message, "Link updated", sizeof j->message);
  jlog_locked(j, "url replaced: %s", u);
  return 0;
}

int dl_action(const char *id, const char *action, jv body, char *code, size_t ccap, char *msg, size_t mcap) {
  int delete_files = jv_get_bool(body, "deleteFiles", 0);
  int rc = 0;
  char toks[4][24];
  int ntok = 0;
  pthread_mutex_lock(&queue_mu);
  dl_job *j = find_locked(id);
  if (!j) { pthread_mutex_unlock(&queue_mu); xstrlcpy(code, "not_found", ccap); xsnprintf(msg, mcap, "No such job"); return -1; }
  dl_state st = j->state;
  int busy = j->running && !state_is_active(st);   /* install/verify thread owns it */
  if (strcmp(action, "pause") == 0) {
    if (st == DL_QUEUED || state_is_active(st)) act_stop_locked(j, DL_STOP_PAUSE, DL_PAUSED, "Paused");
    else rc = -1;
  } else if (strcmp(action, "resume") == 0 || strcmp(action, "retry") == 0) {
    if ((st == DL_PAUSED || st == DL_FAILED || st == DL_CANCELLED || (st == DL_QUEUED && j->nextRetryAt > 0)) && !busy) {
      if (strcmp(action, "retry") == 0 || st == DL_FAILED) { j->attempts = 0; j->mirror_idx = -1; xstrlcpy(j->activeUrl, j->url, sizeof j->activeUrl); }
      j->state = DL_QUEUED;
      j->nextRetryAt = 0;
      j->cancel = 0;
      clear_error_locked(j);
      xstrlcpy(j->message, "Queued", sizeof j->message);
    } else rc = -1;
  } else if (strcmp(action, "cancel") == 0) {
    if (state_is_unfinished(st) && !busy) {
      act_stop_locked(j, DL_STOP_CANCEL, DL_CANCELLED, "Cancelled");
      if (delete_files) { if (j->running) j->delete_files_pending = 1; else { remove_partial_files(j); j->written = 0; free(j->chunks); j->chunks = NULL; j->nchunks = 0; } }
    } else rc = -1;
  } else if (strcmp(action, "remove") == 0) {
    j->remove_pending = 1;
    j->delete_files_pending = delete_files;
    if (j->running && state_is_active(st)) { j->cancel = DL_STOP_REMOVE; j->stop_io = 1; j->state = DL_CANCELLED; }
    ntok = reap_removed_locked(toks, 4);
  } else if (strcmp(action, "restart") == 0) {
    if (busy) rc = -1;
    else {
      if (j->running && state_is_active(st)) { j->cancel = DL_STOP_CANCEL; j->stop_io = 1; j->discard_partial = 1; }
      else { remove_partial_files(j); j->written = 0; free(j->chunks); j->chunks = NULL; j->nchunks = 0; }
      j->state = DL_QUEUED;
      j->attempts = 0;
      j->nextRetryAt = 0;
      j->mirror_idx = -1;
      xstrlcpy(j->activeUrl, j->url, sizeof j->activeUrl);
      j->verified = 0;
      j->sha256[0] = 0;
      clear_error_locked(j);
      xstrlcpy(j->message, "Restarting from zero", sizeof j->message);
      jlog_locked(j, "restart requested");
    }
  } else if (strcmp(action, "install") == 0) {
    if ((st == DL_DONE || st == DL_INSTALLED || (st == DL_INSTALLING && strcmp(j->install.state, "failed") == 0)) && !j->running && is_pkg_format(j->format) && util_file_exists(j->path)) {
      pthread_mutex_unlock(&queue_mu);
      begin_install(j);
      return 0;
    }
    rc = -1;
    xsnprintf(msg, mcap, "Only a finished PKG/FPKG download can be installed");
  } else if (strcmp(action, "verify") == 0) {
    if ((st == DL_DONE || st == DL_INSTALLED) && !j->running && util_file_exists(j->path)) {
      j->verify_prev_state = st;
      j->state = DL_VERIFYING;
      j->running = 1;
      j->stop_io = 0;
      j->written = 0;
      xstrlcpy(j->phase, "sha256", sizeof j->phase);
      pthread_t th;
      pthread_attr_t attr;
      pthread_attr_init(&attr);
      pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
      if (pthread_create(&th, &attr, verify_thread, j) != 0) { j->running = 0; j->state = st; rc = -1; }
      pthread_attr_destroy(&attr);
    } else rc = -1;
  } else if (strcmp(action, "move") == 0) {
    rc = act_move_locked(j, jv_get_str(body, "direction", "up"));
    if (rc != 0) xsnprintf(msg, mcap, "direction must be up|down|top|bottom");
  } else if (strcmp(action, "url") == 0) {
    rc = act_url_locked(j, body, code, ccap, msg, mcap);
    if (rc != 0) { pthread_mutex_unlock(&queue_mu); return -1; }
  } else {
    pthread_mutex_unlock(&queue_mu);
    xstrlcpy(code, "bad_request", ccap);
    xsnprintf(msg, mcap, "Unknown action '%s'", action);
    return -1;
  }
  if (rc != 0) {
    pthread_mutex_unlock(&queue_mu);
    xstrlcpy(code, "bad_state", ccap);
    if (!msg[0] || strcmp(action, "install") != 0) xsnprintf(msg, mcap, "Cannot %s a job that is %s", action, dl_state_name(st));
    return -1;
  }
  queue_dirty = 1;
  pthread_mutex_unlock(&queue_mu);
  release_tokens(toks, ntok);
  dl_save_queue();
  return 0;
}

int dl_clear(jv states) {
  int want[DL_INSTALLED + 1] = {0};
  int any = 0;
  JV_FOREACH(s, states) {
    const char *n = jv_str(s, NULL);
    if (!n) continue;
    int st = state_from_name(n);
    want[st] = 1;
    if (st == DL_DONE) want[DL_INSTALLED] = 1;
    any = 1;
  }
  if (!any) want[DL_DONE] = want[DL_INSTALLED] = want[DL_CANCELLED] = want[DL_FAILED] = 1;
  int removed = 0;
  char toks[16][24];
  int ntok = 0;
  pthread_mutex_lock(&queue_mu);
  for (int i = 0; i < n_jobs;) {
    dl_job *j = jobs[i];
    if (want[j->state] && !j->running) {
      if (ntok < 16 && j->install.token[0]) xstrlcpy(toks[ntok++], j->install.token, 24);
      memmove(&jobs[i], &jobs[i + 1], (size_t)(n_jobs - i - 1) * sizeof jobs[0]);
      n_jobs--;
      job_free(j);
      removed++;
      continue;
    }
    i++;
  }
  queue_dirty = 1;
  pthread_mutex_unlock(&queue_mu);
  release_tokens(toks, ntok);
  dl_save_queue();
  return removed;
}
