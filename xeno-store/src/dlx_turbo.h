/*
 * dlx_turbo.h — turbo start (SPEC §17.5): race the first MiB of up to three
 * mirrors in parallel and keep the fastest one as the primary source.
 */
#ifndef XENO_DLX_TURBO_H
#define XENO_DLX_TURBO_H

#include "dl.h"

#define DLX_TURBO_PROBE_BYTES (1 << 20)

/* Probes urls[0..n) (n ≤ DL_TURBO_MAX used) and fills `out`. Returns the
 * index of the winner, or -1 when no mirror delivered data (out->tested still
 * describes every attempt). `cancel` aborts the race early. */
int dlx_turbo_race(const char *const *urls, int n, int insecure_tls, volatile int *cancel, dl_turbo *out);

#endif
