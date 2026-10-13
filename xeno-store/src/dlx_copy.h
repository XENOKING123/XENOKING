/*
 * dlx_copy.h — copy/move jobs between drives (SPEC §17.16): 8 MiB chunks,
 * fdatasync, size verification, unlink of the source on move. Runs on the
 * job worker thread; progress/pause/cancel go through the dl_job flags.
 */
#ifndef XENO_DLX_COPY_H
#define XENO_DLX_COPY_H

#include "dl.h"

/* Returns 0 done, 1 stopped by the user (state already set by the action),
 * -1 failed (errorCode/error set, state failed). */
int dlx_copy_run(dl_job *j);
/* 1 when both paths live on the same filesystem (st_dev equal). */
int dlx_copy_same_drive(const char *a, const char *b);

#endif
