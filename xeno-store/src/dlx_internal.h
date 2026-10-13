/*
 * dlx_internal.h — the small surface of dl.c that the download-engine
 * extension modules (dlx_copy.c, dlx_extract.c) need: the queue lock, the
 * per-job log and error setters. Not part of the public API (api.c and the
 * console modules use dl.h only).
 */
#ifndef XENO_DLX_INTERNAL_H
#define XENO_DLX_INTERNAL_H

#include "dl.h"
#include "util.h"

void dl_lock(void);
void dl_unlock(void);
/* Per-job log line (also mirrored to the global log). Takes the lock. */
void dl_jlog(dl_job *j, const char *fmt, ...) XS_PRINTF(2, 3);
/* Caller holds the lock. Sets errorCode/error/message. */
void dl_set_error_locked(dl_job *j, const char *code, const char *msg);
void dl_mark_dirty_locked(void);

#endif
