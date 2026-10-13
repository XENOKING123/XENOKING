/*
 * dlx_rest.h — rest-mode / background resilience (SPEC §17.15): detects a
 * sleep/wake cycle (monotonic clock jump > 10 s, wall-clock jump or a burst
 * of ENETDOWN-class errors) and offers the network checks the engine uses to
 * resume every segment from its checkpoint without consuming retry budget.
 */
#ifndef XENO_DLX_REST_H
#define XENO_DLX_REST_H

#include "settings.h"
#include <stdint.h>

/* Called every housekeeping tick; returns 1 on the tick that detects a wake-up. */
int dlx_rest_tick(void);
/* A segment/probe failed with this transport error class (XHTTP_ERR_*). */
void dlx_rest_note_error(int err_class);
/* 1 while a wake-up event is "recent" (within the last 3 minutes). */
int dlx_rest_recent(void);
int64_t dlx_rest_last_event_ms(void);
/* Forces an event (host test hook / diagnostics). */
void dlx_rest_force_event(const char *why);
/* 1 when getifaddrs() reports a non-loopback IPv4 address. */
int dlx_net_has_address(void);
/* Blocking check: HEAD to the catalog revision URL (≤ timeout_ms). */
int dlx_net_catalog_reachable(int timeout_ms);
/* 1 when GET url with Range 0-0 answers at all (any HTTP status). */
int dlx_net_origin_reachable(const char *url, int insecure_tls, volatile int *cancel, int timeout_ms);
/* Pill text for the Downloads screen. */
const char *dlx_rest_pill(const settings_t *s, int downloading);

#endif
