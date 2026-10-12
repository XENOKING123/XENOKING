/*
 * http_client.h — transport interface shared by dl.c, catalog.c, api.c
 * (SPEC §4.2). Two backends implement it:
 *   http_posix.c — host build: sockets + OpenSSL (when XENO_HAVE_OPENSSL)
 *   http_sce.c   — PS5: libSceHttp2 / libSceHttp resolved with dlsym
 *
 * A request is one connection: xhttp_open() sends the request and parses the
 * response headers, xhttp_read() streams the body, xhttp_close() releases it.
 */
#ifndef XENO_HTTP_CLIENT_H
#define XENO_HTTP_CLIENT_H

#include <stddef.h>
#include <stdint.h>

typedef struct xhttp_resp {
  int status;                         /* 0 on transport error */
  int64_t content_length;             /* -1 unknown */
  int64_t range_start, range_total;   /* from Content-Range, -1 if absent */
  char etag[128];
  char last_modified[64];
  char location[1024];                /* final URL after redirects, or raw Location */
  char content_type[96];
  char filename[256];                 /* from Content-Disposition if any */
  int retry_after;                    /* seconds, 0 if absent */
  int accept_ranges;                  /* 1 if "bytes" */
} xhttp_resp;

typedef struct xhttp_req {
  const char *method;                 /* "GET", "HEAD", "POST" */
  const char *url;
  const char *user_agent;             /* NULL → default XENO-STORE UA */
  int64_t range_start, range_end;     /* -1 = no Range header; range_end -1 = open ended */
  const char *extra_headers;          /* "Name: v\r\n..." or NULL */
  const char *body;
  size_t body_len;
  int connect_timeout_ms, recv_timeout_ms;   /* 0 → defaults (10 s / 30 s) */
  int follow_redirects;               /* max hops (0 = none) */
  int insecure_tls;                   /* only honored by backends that can */
  volatile int *cancel_flag;          /* checked between reads; non-zero = abort */
} xhttp_req;

typedef struct xhttp_conn xhttp_conn;

int xhttp_global_init(void);                 /* once; 0 or -1 (sets xhttp_last_error) */
int xhttp_open(const xhttp_req *req, xhttp_conn **out, xhttp_resp *resp);
int xhttp_read(xhttp_conn *c, void *buf, size_t cap);   /* >0 bytes, 0 EOF, <0 error */
void xhttp_close(xhttp_conn *c);
/* Thread-safe: makes a blocked xhttp_read() in another thread return <0 soon. */
void xhttp_abort(xhttp_conn *c);
const char *xhttp_last_error(void);          /* thread-local text */
int xhttp_available(void);                   /* 1 when the backend initialized */
const char *xhttp_backend_name(void);        /* "posix" | "posix+tls" | "sceHttp2" | "sceHttp" | "none" */

/* Convenience: GET/POST a small resource fully into memory (max_bytes cap).
 * Returns malloc'd NUL-terminated body (or NULL) and fills *resp. */
char *xhttp_fetch(const xhttp_req *req, xhttp_resp *resp, size_t max_bytes, size_t *out_len);

/* Shared helpers implemented once in http_common (inside http_posix.c /
 * http_sce.c both include http_headers.c-style logic via these functions). */
void xhttp_resp_reset(xhttp_resp *r);
/* Parses one "Name: value" header line into the response struct. */
void xhttp_resp_header(xhttp_resp *r, const char *name, size_t nlen, const char *value, size_t vlen);
void xhttp_set_error(const char *fmt, ...);
#define XHTTP_DEFAULT_UA "XENO-STORE/" XENO_VERSION " (PlayStation 5)"

#endif
