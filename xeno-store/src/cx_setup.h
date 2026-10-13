/*
 * cx_setup.h — readiness checklist (SPEC §17.6): local helper daemons,
 * internet, default drive, free space, firmware, payload-manager tips.
 */
#ifndef XENO_CX_SETUP_H
#define XENO_CX_SETUP_H

#include "json.h"

void cx_setup_init(void);
void cx_setup_tick(void);
/* Runs every check now (blocking ≤ ~8 s) and writes "checks", "payloadsUrl", "summary". */
void cx_setup_check_json(jw *w);
/* Writes the summary of the last background check (for /api/status "setup"). */
void cx_setup_summary_json(jw *w);

#endif
