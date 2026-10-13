/*
 * api.h — every /api handler (SPEC §6) behind one dispatcher.
 *
 * Routes live in a table (method + pattern with {captures}) so the Phase 2
 * endpoints can be added without touching the dispatcher.
 */
#ifndef XENO_API_H
#define XENO_API_H

#include "server.h"
#include "json.h"
#include <stddef.h>

/* ---- Extension API (Phase 2 modules add routes without editing api.c) ----
 * A module defines handlers with this signature, builds a static api_route
 * table and registers it from its *_init() (called via api_ext_init()).
 * Captured path segments ({id}, {action}) land in ctx->params in order. */
typedef struct api_ctx {
  http_req *req;
  jdoc *doc;          /* parsed body (NULL when absent/invalid) */
  jv body;
  char params[3][96]; /* {captures} in route order */
  int nparams;
} api_ctx;

typedef void (*api_handler)(api_ctx *c);

typedef struct api_route {
  const char *method;
  const char *pattern;   /* "/api/queue/{id}/{action}" */
  api_handler fn;
} api_route;

/* Registers an extra route table (up to 8 tables). Returns 0, or -1 when full. */
int api_register_routes(const api_route *table, size_t n);

/* Envelope helpers shared with extension modules. */
void api_begin(jw *w);                     /* {"ok":true, ... */
void api_send(api_ctx *c, jw *w);          /* closes the object and sends 200 */
void api_error(api_ctx *c, int status, const char *code, const char *msg);
const char *api_body_str(api_ctx *c, const char *key, const char *dflt);

/* Optional hooks implemented by extension modules (weak: absent = no-op).
 * api_status_extra: writes extra keys into GET /api/status (e.g. "featured", "setup").
 * ext_*_init: called once after api_init(); ext_*_tick: called every ~500 ms from housekeeping. */
void api_status_extra(jw *w) __attribute__((weak));
void ext_downloads_init(void) __attribute__((weak));
void ext_console_init(void) __attribute__((weak));
void ext_downloads_tick(void) __attribute__((weak));
void ext_console_tick(void) __attribute__((weak));
void api_ext_init(void);

void api_init(void);
/* Always answers the request (JSON). */
void api_handle(http_req *req);

#endif
