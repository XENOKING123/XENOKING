/*
 * api.h — every /api handler (SPEC §6) behind one dispatcher.
 *
 * Routes live in a table (method + pattern with {captures}) so the Phase 2
 * endpoints can be added without touching the dispatcher.
 */
#ifndef XENO_API_H
#define XENO_API_H

#include "server.h"

void api_init(void);
/* Always answers the request (JSON). */
void api_handle(http_req *req);

#endif
