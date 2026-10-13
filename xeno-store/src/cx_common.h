/*
 * cx_common.h — helpers shared by the console feature modules (cx_*.c):
 * console-path simulation on the host build, bounded filesystem helpers,
 * small HTTP fetch wrappers, loopback port probes and id validation.
 *
 * Host build: every absolute console path (/user/home, /system_data/...,
 * /data/homebrew) is mapped below <data_dir>/sim so the saves, accounts and
 * library logic can be exercised end-to-end by tests/host/test_ext_console.py.
 */
#ifndef XENO_CX_COMMON_H
#define XENO_CX_COMMON_H

#include "http_client.h"
#include "json.h"
#include <stddef.h>
#include <stdint.h>
#include <time.h>

#define CX_PATH_MAX 1024

/* ---- console paths ------------------------------------------------------ */
/* Maps a console-absolute path to its host simulation twin (PS5: unchanged). */
void cx_console_path(const char *console_path, char *out, size_t cap);
const char *cx_home_root(void);        /* /user/home */
const char *cx_appmeta_root(void);     /* /system_data/priv/appmeta */
const char *cx_data_homebrew_dir(void);/* /data/homebrew */
const char *cx_data_dir(void);         /* /data/xeno-store (g_cfg.data_dir) */
int cx_is_host(void);

/* Host-only port overrides for local services (XENO_PORT_<NAME> env);
 * on the console the default is always used. */
int cx_local_port(const char *name, int dflt);
/* Host-only base-URL override (XENO_<NAME>_BASE env); "" when unset. */
const char *cx_base_override(const char *name);

/* ---- validation --------------------------------------------------------- */
int cx_titleid_valid(const char *s);               /* (PPSA|CUSA)[0-9]{5} */
int cx_id_valid(const char *s, size_t maxlen);     /* [A-Za-z0-9._-]+, no leading dot */
int cx_dirname_valid(const char *s);               /* save dirName: [A-Za-z0-9_-]{1,31} */
int cx_path_is_clean(const char *p);               /* absolute, no "..", no control chars */
int cx_path_under(const char *path, const char *dir);
/* Lowercase "a.b.c" host match against a list (host == dom or ends with ".dom"). */
int cx_host_in(const char *host, const char *const *list, size_t n);
/* Host-build only: loopback test servers are allowed everywhere. */
int cx_host_is_loopback(const char *host);

/* ---- filesystem --------------------------------------------------------- */
int64_t cx_dir_size(const char *dir, int max_depth);
int cx_rm_rf(const char *path, int max_depth);     /* refuses "/" and short paths */
int cx_copy_file(const char *src, const char *dst);
int cx_copy_tree(const char *src, const char *dst, int max_depth, int64_t *bytes);
int cx_count_files(const char *dir, int max_depth);
char *cx_read_small(const char *path, size_t max, size_t *len);   /* malloc'd or NULL */
jdoc *cx_json_file(const char *path, size_t max, size_t max_nodes);
int cx_write_json(const char *path, jw *w);         /* detaches + frees the writer */
time_t cx_mtime(const char *path);
/* "20261013-1530" local time stamp */
void cx_stamp(char *out, size_t cap);

/* ---- HTTP --------------------------------------------------------------- */
typedef struct cx_http {
  const char *method;       /* NULL → GET */
  const char *headers;      /* "Name: v\r\n..." or NULL */
  const char *body;
  size_t body_len;
  int timeout_ms;           /* 0 → 15 s */
  size_t max_bytes;         /* 0 → 4 MiB */
  int follow;               /* redirects, 0 → 5 */
} cx_http;
/* Fetches into memory. Returns malloc'd body (may be "") or NULL; *status is
 * 0 on transport error. */
char *cx_fetch(const char *url, const cx_http *opt, int *status, size_t *len, xhttp_resp *resp);
/* Streams a response to a file (tmp + rename); verifies sha256 when expected
 * is non-empty. Returns 0, or -1 with err. progress may be NULL. */
typedef int (*cx_progress_fn)(void *user, int64_t done, int64_t total);
int cx_download_file(const char *url, const cx_http *opt, const char *dest, const char *sha256_expected, int64_t max_bytes,
                     cx_progress_fn progress, void *user, volatile int *cancel, char *err, size_t errcap);
/* Content-Type of the last cx_download_file() on this thread ("" when unknown). */
const char *cx_download_last_type(void);
int cx_sha256_file(const char *path, char hex[65]);
/* 1 when 127.0.0.1:port accepts a TCP connection within timeout_ms. */
int cx_tcp_probe(int port, int timeout_ms);
/* Connects to 127.0.0.1:port and sends the whole buffer. 0 ok / -1. */
int cx_tcp_send_all(int port, const void *data, size_t len, int timeout_ms, char *err, size_t errcap);

/* ---- JSON helpers ------------------------------------------------------- */
void cx_jw_kv_opt(jw *w, const char *k, const char *v);   /* skips "" values */
/* Percent-encodes everything except unreserved chars (query component). */
void cx_url_encode(const char *in, char *out, size_t cap);

#endif
