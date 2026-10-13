/*
 * dlx_stats.h — lifetime download statistics (SPEC §17.5): totalBytes,
 * totalJobs, bestSpeed, avgSpeed and a per-provider breakdown, persisted in
 * <data>/stats.json and served by GET /api/stats.
 */
#ifndef XENO_DLX_STATS_H
#define XENO_DLX_STATS_H

#include "json.h"
#include <stdint.h>

void dlx_stats_init(const char *data_dir);
/* Records one finished transfer. `seconds` is the active transfer time
 * (for avgSpeed), `peak` the best 1 s sample (for bestSpeed). */
void dlx_stats_record(const char *provider, int64_t bytes, double seconds, double peak);
/* Writes totalBytes, totalJobs, bestSpeed, avgSpeed, byProvider, since, updatedAt. */
void dlx_stats_json(jw *w);
/* Flushes to disk when dirty (called from the housekeeping tick). */
void dlx_stats_flush(int force);
int dlx_stats_reset(void);

#endif
