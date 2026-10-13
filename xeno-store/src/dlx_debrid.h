/*
 * dlx_debrid.h — premium link services (SPEC §17.14): Real-Debrid,
 * AllDebrid, TorBox and Premiumize. Keys live in settings.json only; the
 * supported-host lists are cached in <data>/debrid-hosts.json and refreshed
 * once a day. Errors are returned as plain words for the UI.
 */
#ifndef XENO_DLX_DEBRID_H
#define XENO_DLX_DEBRID_H

#include "json.h"
#include <stddef.h>

#define DLX_DEBRID_N 4

typedef struct dlx_debrid_result {
  char url[2048];          /* unrestricted direct link */
  char filename[256];
  long long size;          /* -1 unknown */
  char service[16];        /* which service answered */
  char label[32];          /* "Real-Debrid" */
  char error[256];         /* plain-word error when the call failed */
  char errorCode[32];      /* unsupported_host | bad_key | limit | service_error | network | not_connected */
} dlx_debrid_result;

void dlx_debrid_init(const char *data_dir);
/* Service id ("realdebrid" …) → display name, NULL when unknown. */
const char *dlx_debrid_name(const char *id);
int dlx_debrid_known(const char *id);
/* 1 when a key is stored for the service. */
int dlx_debrid_connected(const char *id);
/* Writes the "services" array of GET /api/debrid. */
void dlx_debrid_services_json(jw *w);
/* Validates a key with the service's user endpoint and stores it in the
 * settings on success. Returns 0, or -1 with err (plain words). */
int dlx_debrid_connect(const char *id, const char *apiKey, char *code, size_t ccap, char *err, size_t errcap);
int dlx_debrid_disconnect(const char *id, char *err, size_t errcap);
/* Picks the service for a link: `via` = auto | direct | <id>. Returns 0 and
 * the service id in out (empty = direct), -1 with err when `via` names a
 * service that is not connected. */
int dlx_debrid_pick(const char *via, const char *url, char *out, size_t cap, char *err, size_t errcap);
/* Unrestricts `url` through `service`; blocking (≤ ~100 s for TorBox). */
int dlx_debrid_resolve(const char *service, const char *url, volatile int *cancel, dlx_debrid_result *out);
/* Supported-host lists: refresh when older than a day (non-blocking; runs
 * in a short-lived thread). Called from the housekeeping tick. */
void dlx_debrid_tick(void);
int dlx_debrid_host_supported(const char *service, const char *host);   /* 1 yes, 0 no, -1 unknown list */

#endif
