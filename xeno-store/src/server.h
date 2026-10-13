/*
 * server.h — HTTP/1.1 server (SPEC §4.1): acceptor + worker pool, request
 * parsing with hard limits, static/embedded routes, /api dispatch (api.c),
 * /pkgsrv range serving for the DPI install fallback.
 *
 * One request = one connection (Connection: close). Handlers receive an
 * http_req and answer exactly once through http_send*(); every response
 * carries Content-Length and the CORS headers.
 */
#ifndef XENO_SERVER_H
#define XENO_SERVER_H

#include "json.h"
#include <stddef.h>

#define HTTP_MAX_REQLINE (4u << 10)
#define HTTP_MAX_HEADERS (16u << 10)
#define HTTP_MAX_BODY (1u << 20)
#define HTTP_READ_TIMEOUT_S 15
#define HTTP_WORKERS 8

typedef struct http_req {
  int fd;
  char client_ip[48];
  int client_is_loopback;
  char method[8];
  char path[1024];             /* percent-decoded, validated (no .., NUL, control chars) */
  char query[2048];            /* raw query string without '?' */
  char *body;                  /* NUL-terminated copy (may be NULL) */
  size_t body_len;
  int accepts_gzip;
  char if_none_match[160];
  char range[64];              /* raw "bytes=a-b" value or "" */
  char pin[16];                /* X-XENO-PIN */
  char content_type[64];
  char host[260];              /* Host header value (DNS-rebind gate, SPEC §15) */
  char origin[300];            /* Origin header, "" when absent */
  char sec_fetch_site[24];     /* Sec-Fetch-Site, "" when absent */
  char authorization[160];     /* Authorization header ("Bearer <token>") */
  int host_count, origin_count, site_count;  /* duplicate-header smuggling guard */
  int responded;
} http_req;

int server_start(int port);          /* 0 ok, -1 bind/listen failed (errno kept) */
void server_stop(void);              /* stops accepting, joins workers */

/* ---- response helpers (used by server.c and api.c) ---------------------- */
void http_send(http_req *r, int status, const char *content_type, const void *body, size_t len,
               const char *extra_headers);
void http_send_json(http_req *r, int status, jw *w);           /* detaches + frees the writer */
void http_send_error(http_req *r, int status, const char *code, const char *message);
const char *http_status_text(int status);

/* Query helpers: URL-decoded value of key; returns 1 when present. */
int http_query_get(const http_req *r, const char *key, char *out, size_t cap);
int http_query_int(const http_req *r, const char *key, int dflt);

#endif
