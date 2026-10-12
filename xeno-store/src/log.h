/*
 * log.h — ring buffer of the last 400 lines + rotating log.txt (SPEC §4.10).
 *
 * log_mu is the innermost lock in the system: any thread may log while holding
 * queue_mu, never the other way round.
 */
#ifndef XENO_LOG_H
#define XENO_LOG_H

#include "util.h"

enum { LOG_DEBUG = 0, LOG_INFO = 1, LOG_WARN = 2, LOG_ERROR = 3 };

int log_init(const char *data_dir, int level);
void log_set_level(int level);
int log_level_from_name(const char *name);   /* "debug"|"info"|"warn" -> enum */
void log_write(int level, const char *fmt, ...) XS_PRINTF(2, 3);
/* Copies up to max of the most recent lines (oldest first) into out[]; each
 * entry is NUL-terminated and at most LOG_LINE_MAX bytes. Returns the count. */
#define LOG_LINE_MAX 320
int log_recent(char (*out)[LOG_LINE_MAX], int max);
void log_shutdown(void);

#define LOGD(...) log_write(LOG_DEBUG, __VA_ARGS__)
#define LOGI(...) log_write(LOG_INFO, __VA_ARGS__)
#define LOGW(...) log_write(LOG_WARN, __VA_ARGS__)
#define LOGE(...) log_write(LOG_ERROR, __VA_ARGS__)

#endif
