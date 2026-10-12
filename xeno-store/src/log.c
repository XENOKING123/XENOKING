/*
 * log.c — see log.h. The file log rotates at 2 MiB to log.1.txt.
 */
#include "log.h"

#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define LOG_RING 400
#define LOG_ROTATE_BYTES (2u << 20)

static pthread_mutex_t log_mu = PTHREAD_MUTEX_INITIALIZER;
static char ring[LOG_RING][LOG_LINE_MAX];
static int ring_head = 0, ring_count = 0;
static int cur_level = LOG_INFO;
static char log_path[1024], log_path_old[1024];
static FILE *log_fp = NULL;
static size_t log_bytes = 0;

static const char *level_name(int l) {
  switch (l) {
    case LOG_DEBUG: return "DEBUG";
    case LOG_INFO: return "INFO";
    case LOG_WARN: return "WARN";
    default: return "ERROR";
  }
}

int log_level_from_name(const char *name) {
  if (util_strieq(name, "debug")) return LOG_DEBUG;
  if (util_strieq(name, "warn") || util_strieq(name, "warning")) return LOG_WARN;
  if (util_strieq(name, "error")) return LOG_ERROR;
  return LOG_INFO;
}

static void open_file_locked(void) {
  if (!log_path[0]) return;
  log_fp = fopen(log_path, "a");
  if (!log_fp) return;
  struct stat st;
  log_bytes = (fstat(fileno(log_fp), &st) == 0) ? (size_t)st.st_size : 0;
}

int log_init(const char *data_dir, int level) {
  pthread_mutex_lock(&log_mu);
  cur_level = level;
  if (data_dir && *data_dir) {
    xsnprintf(log_path, sizeof log_path, "%s/log.txt", data_dir);
    xsnprintf(log_path_old, sizeof log_path_old, "%s/log.1.txt", data_dir);
    if (log_fp) { fclose(log_fp); log_fp = NULL; }
    open_file_locked();
  }
  pthread_mutex_unlock(&log_mu);
  return 0;
}

void log_set_level(int level) {
  pthread_mutex_lock(&log_mu);
  cur_level = level;
  pthread_mutex_unlock(&log_mu);
}

void log_write(int level, const char *fmt, ...) {
  if (level < cur_level) return;
  char msg[LOG_LINE_MAX];
  va_list ap;
  va_start(ap, fmt);
  xvsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);

  time_t t = util_now();
  struct tm tm;
  localtime_r(&t, &tm);
  char line[LOG_LINE_MAX];
  xsnprintf(line, sizeof line, "%02d:%02d:%02d %-5s %s", tm.tm_hour, tm.tm_min, tm.tm_sec,
            level_name(level), msg);

  pthread_mutex_lock(&log_mu);
  xstrlcpy(ring[ring_head], line, LOG_LINE_MAX);
  ring_head = (ring_head + 1) % LOG_RING;
  if (ring_count < LOG_RING) ring_count++;
  if (log_fp) {
    int n = fprintf(log_fp, "%04d-%02d-%02d %s\n", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, line);
    fflush(log_fp);
    if (n > 0) log_bytes += (size_t)n;
    if (log_bytes >= LOG_ROTATE_BYTES) {
      fclose(log_fp);
      log_fp = NULL;
      rename(log_path, log_path_old);
      open_file_locked();
    }
  }
  pthread_mutex_unlock(&log_mu);
#ifdef XENO_HOST
  fprintf(stderr, "%s\n", line);
#else
  printf("%s\n", line);
  fflush(stdout);
#endif
}

int log_recent(char (*out)[LOG_LINE_MAX], int max) {
  pthread_mutex_lock(&log_mu);
  int n = ring_count < max ? ring_count : max;
  int start = (ring_head - n + LOG_RING) % LOG_RING;
  for (int i = 0; i < n; i++) xstrlcpy(out[i], ring[(start + i) % LOG_RING], LOG_LINE_MAX);
  pthread_mutex_unlock(&log_mu);
  return n;
}

void log_shutdown(void) {
  pthread_mutex_lock(&log_mu);
  if (log_fp) { fclose(log_fp); log_fp = NULL; }
  pthread_mutex_unlock(&log_mu);
}
