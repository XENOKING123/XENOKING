/*
 * http_common.c — backend-independent pieces of the transport: response
 * header parsing, the thread-local error string and xhttp_fetch().
 * Compiled into both the host and the PS5 build.
 */
#include "http_client.h"
#include "util.h"

#include <ctype.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- thread-local last error (pthread key: __thread is avoided for the
 * payload runtime, whose TLS support we do not want to depend on) --------- */
static pthread_key_t err_key;
static pthread_once_t err_once = PTHREAD_ONCE_INIT;
#define ERR_CAP 256

typedef struct err_slot_t { char msg[ERR_CAP]; int cls; } err_slot_t;

static void err_key_init(void) { pthread_key_create(&err_key, free); }

static err_slot_t *err_slot(void) {
  pthread_once(&err_once, err_key_init);
  err_slot_t *p = pthread_getspecific(err_key);
  if (!p) {
    p = calloc(1, sizeof *p);
    if (!p) return NULL;
    pthread_setspecific(err_key, p);
  }
  return p;
}

void xhttp_set_error(const char *fmt, ...) {
  err_slot_t *p = err_slot();
  if (!p) return;
  va_list ap;
  va_start(ap, fmt);
  xvsnprintf(p->msg, ERR_CAP, fmt, ap);
  va_end(ap);
  p->cls = p->msg[0] ? XHTTP_ERR_OTHER : XHTTP_ERR_NONE;
}

void xhttp_set_error_class(int cls) {
  err_slot_t *p = err_slot();
  if (p) p->cls = cls;
}

int xhttp_last_error_class(void) {
  err_slot_t *p = err_slot();
  return p ? p->cls : XHTTP_ERR_OTHER;
}

const char *xhttp_last_error(void) {
  err_slot_t *p = err_slot();
  return p ? p->msg : "out of memory";
}

/* ---- response headers --------------------------------------------------- */

void xhttp_resp_reset(xhttp_resp *r) {
  memset(r, 0, sizeof *r);
  r->content_length = -1;
  r->range_start = -1;
  r->range_total = -1;
}

static void copy_trimmed(char *dst, size_t cap, const char *v, size_t vlen) {
  while (vlen && isspace((unsigned char)*v)) { v++; vlen--; }
  while (vlen && isspace((unsigned char)v[vlen - 1])) vlen--;
  if (vlen >= cap) vlen = cap - 1;
  memcpy(dst, v, vlen);
  dst[vlen] = 0;
}

static void parse_content_disposition(xhttp_resp *r, const char *v) {
  /* filename*=UTF-8''percent%20encoded  takes precedence over filename="x" */
  const char *star = util_strcasestr(v, "filename*=");
  if (star) {
    star += 10;
    const char *q = strstr(star, "''");
    if (q) {
      q += 2;
      size_t n = strcspn(q, ";");
      util_url_decode(q, n, r->filename, sizeof r->filename);
      util_trim(r->filename);
      if (r->filename[0]) return;
    }
  }
  const char *fn = util_strcasestr(v, "filename=");
  if (!fn) return;
  fn += 9;
  while (*fn == ' ') fn++;
  if (*fn == '"') {
    fn++;
    size_t n = strcspn(fn, "\"");
    copy_trimmed(r->filename, sizeof r->filename, fn, n);
  } else {
    size_t n = strcspn(fn, ";");
    copy_trimmed(r->filename, sizeof r->filename, fn, n);
  }
}

void xhttp_resp_header(xhttp_resp *r, const char *name, size_t nlen, const char *value, size_t vlen) {
  char n[64], v[1100];
  if (nlen >= sizeof n) return;
  memcpy(n, name, nlen);
  n[nlen] = 0;
  copy_trimmed(v, sizeof v, value, vlen);
  if (util_strieq(n, "Content-Length")) {
    int64_t cl;
    if (util_parse_i64(v, &cl) == 0 && cl >= 0) r->content_length = cl;
  } else if (util_strieq(n, "Content-Range")) {
    /* "bytes START-END/TOTAL" or "bytes STAR/TOTAL" (unsatisfied range) */
    const char *p = v;
    if (util_istarts_with(p, "bytes")) p += 5;
    while (*p == ' ') p++;
    if (*p == '*') {
      const char *sl = strchr(p, '/');
      if (sl) { int64_t t; if (util_parse_i64(sl + 1, &t) == 0) r->range_total = t; }
    } else {
      long long s = -1, e = -1, t = -1;
      if (sscanf(p, "%lld-%lld/%lld", &s, &e, &t) >= 2) {
        r->range_start = s;
        if (t >= 0) r->range_total = t;
      }
    }
  } else if (util_strieq(n, "ETag")) {
    xstrlcpy(r->etag, v, sizeof r->etag);
  } else if (util_strieq(n, "Last-Modified")) {
    xstrlcpy(r->last_modified, v, sizeof r->last_modified);
  } else if (util_strieq(n, "Location")) {
    xstrlcpy(r->location, v, sizeof r->location);
  } else if (util_strieq(n, "Content-Type")) {
    xstrlcpy(r->content_type, v, sizeof r->content_type);
  } else if (util_strieq(n, "Content-Disposition")) {
    parse_content_disposition(r, v);
  } else if (util_strieq(n, "Retry-After")) {
    int ra = util_parse_int(v, -1);
    r->retry_after = ra >= 0 ? ra : 30;   /* HTTP-date form → a sane default */
  } else if (util_strieq(n, "Accept-Ranges")) {
    r->accept_ranges = util_strcasestr(v, "bytes") != NULL;
  }
}

/* ---- fetch into memory -------------------------------------------------- */

char *xhttp_fetch(const xhttp_req *req, xhttp_resp *resp, size_t max_bytes, size_t *out_len) {
  xhttp_conn *c = NULL;
  xhttp_resp local;
  if (!resp) resp = &local;
  if (xhttp_open(req, &c, resp) != 0) return NULL;
  size_t cap = 16384, len = 0;
  if (resp->content_length > 0 && (size_t)resp->content_length < max_bytes) cap = (size_t)resp->content_length + 1;
  char *buf = malloc(cap);
  if (!buf) { xhttp_close(c); xhttp_set_error("out of memory"); return NULL; }
  for (;;) {
    if (len + 1 >= cap) {
      if (cap >= max_bytes) { xhttp_set_error("response larger than %zu bytes", max_bytes); free(buf); xhttp_close(c); return NULL; }
      size_t ncap = cap * 2 > max_bytes ? max_bytes + 1 : cap * 2;
      char *nb = realloc(buf, ncap);
      if (!nb) { free(buf); xhttp_close(c); xhttp_set_error("out of memory"); return NULL; }
      buf = nb;
      cap = ncap;
    }
    int n = xhttp_read(c, buf + len, cap - len - 1);
    if (n < 0) { free(buf); xhttp_close(c); return NULL; }
    if (n == 0) break;
    len += (size_t)n;
  }
  xhttp_close(c);
  buf[len] = 0;
  if (out_len) *out_len = len;
  return buf;
}
