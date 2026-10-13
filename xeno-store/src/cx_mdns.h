/*
 * cx_mdns.h — tiny multicast DNS responder (SPEC §17.19): answers A queries
 * for xeno.local and xenostore.local with the console's IPv4 (TTL 120) on
 * 224.0.0.251:5353 and re-announces every 60 s. No library, no dependencies.
 */
#ifndef XENO_CX_MDNS_H
#define XENO_CX_MDNS_H

#include "json.h"
#include <stddef.h>
#include <stdint.h>

void cx_mdns_init(void);
void cx_mdns_tick(void);        /* follows settings.general.mdns */
void cx_mdns_stop(void);
/* Writes "enabled", "running", "names", "ip", "port", "error", "url". */
void cx_mdns_status_json(jw *w);

/* Packet builders (pure functions, unit-tested through /api/mdns/build on
 * the host). ip is in network byte order. Return the response length or 0
 * when the query asks for nothing we serve. */
size_t cx_mdns_build_response(const uint8_t *query, size_t qlen, uint32_t ip_be, uint8_t *out, size_t cap, int *unicast);
size_t cx_mdns_build_announce(uint32_t ip_be, uint8_t *out, size_t cap);

#endif
