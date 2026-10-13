/*
 * util.h — bounded string helpers, time, filesystem, base64, URL parsing.
 *
 * Every other module uses these instead of strcpy/strcat/sprintf (SPEC §5).
 * All functions are thread-safe unless noted; nothing here allocates except the
 * explicitly documented util_read_file()/util_strdup().
 */
#ifndef XENO_UTIL_H
#define XENO_UTIL_H

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#include <time.h>

#ifdef __GNUC__
#define XS_PRINTF(fmt_idx, arg_idx) __attribute__((format(printf, fmt_idx, arg_idx)))
#else
#define XS_PRINTF(fmt_idx, arg_idx)
#endif

#define XS_ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))
#define XS_MIN(a, b) ((a) < (b) ? (a) : (b))
#define XS_MAX(a, b) ((a) > (b) ? (a) : (b))

/* ---- strings ------------------------------------------------------------ */
size_t xstrlcpy(char *dst, const char *src, size_t cap);
size_t xstrlcat(char *dst, const char *src, size_t cap);
/* snprintf that always NUL-terminates and returns the number of bytes stored
 * (never more than cap-1), so callers can chain safely. */
int xsnprintf(char *dst, size_t cap, const char *fmt, ...) XS_PRINTF(3, 4);
int xvsnprintf(char *dst, size_t cap, const char *fmt, va_list ap);
char *util_strdup(const char *s);                 /* malloc'd copy, NULL on OOM */
int util_strieq(const char *a, const char *b);
int util_starts_with(const char *s, const char *prefix);
int util_istarts_with(const char *s, const char *prefix);
int util_ends_with(const char *s, const char *suffix);
int util_iends_with(const char *s, const char *suffix);
const char *util_strcasestr(const char *hay, const char *needle);
void util_trim(char *s);                           /* in place, both ends */
void util_lower(char *s);
void util_upper(char *s);
/* Lowercase + fold Latin-1/Latin Extended-A accents into ASCII (é→e, ß→ss).
 * Non-Latin UTF-8 passes through unchanged. Used for search matching. */
void util_fold(const char *in, char *out, size_t cap);
int util_parse_i64(const char *s, int64_t *out);
int util_parse_int(const char *s, int dflt);
/* Compare dotted versions ("1.2.10" > "1.2.9"); tolerant of a leading 'v'. */
int util_semver_cmp(const char *a, const char *b);
/* Lowercase file extension without the dot ("ffpfsc"); "" when none. */
void util_ext(const char *filename, char *out, size_t cap);
const char *util_basename(const char *path);
/* Finds (PPSA|CUSA)\d{5} anywhere in s (case-insensitive); writes uppercase. */
int util_find_titleid(const char *s, char *out, size_t cap);
void util_fmt_bytes(int64_t n, char *out, size_t cap);   /* "12.3 GB" */
/* "j_" + 6 random hex chars etc. */
void util_rand_id(const char *prefix, char *out, size_t cap);
void util_rand_hex(char *out, size_t nchars);        /* nchars hex digits + NUL */
void util_hex(const uint8_t *in, size_t n, char *out, size_t cap);
/* Decode HTML entities (&amp; &#8211; &#x2019; …) in place. */
void util_html_unescape(char *s);

/* ---- time --------------------------------------------------------------- */
int64_t util_now_ms(void);       /* monotonic milliseconds */
time_t util_now(void);           /* wall clock seconds */
void util_sleep_ms(int ms);
void util_iso8601(time_t t, char *out, size_t cap);

/* ---- filesystem --------------------------------------------------------- */
int util_mkdir_p(const char *path);
int util_file_exists(const char *path);   /* regular file */
int util_dir_exists(const char *path);
int64_t util_file_size(const char *path); /* -1 when missing */
time_t util_file_mtime(const char *path);
/* Writes <path>.tmp then rename()s over path; fsyncs the file first. */
int util_write_file_atomic(const char *path, const void *data, size_t len);
/* Reads at most max bytes (0 = 64 MiB); result is malloc'd and NUL-terminated. */
char *util_read_file(const char *path, size_t *len, size_t max);
int util_unlink_quiet(const char *path);
int util_fsync_dir(const char *file_path);

/* ---- base64 ------------------------------------------------------------- */
size_t util_b64_encode(const uint8_t *in, size_t n, char *out, size_t cap);
/* Tolerates whitespace, URL-safe alphabet and missing padding. Returns 0 on
 * success and stores the decoded length. */
int util_b64_decode(const char *in, size_t n, uint8_t *out, size_t cap, size_t *outlen);

/* ---- URLs --------------------------------------------------------------- */
typedef struct xurl {
  char scheme[8];      /* "http" | "https" */
  char host[256];
  int port;            /* resolved default when absent */
  char path[1536];     /* path + query, always starts with '/' */
  int has_userinfo;    /* "user:pass@" was present (rejected by policy) */
} xurl;
int util_url_parse(const char *url, xurl *out);   /* 0 ok, -1 malformed */
/* Resolves a possibly-relative Location against base. */
int util_url_resolve(const char *base, const char *loc, char *out, size_t cap);
int util_url_decode(const char *in, size_t n, char *out, size_t cap);
/* Percent-encodes everything except unreserved + '/' (for path components). */
void util_url_encode_path(const char *in, char *out, size_t cap);
/* Host (lowercase, no www.) from any URL; "" when unparsable. */
void util_url_host(const char *url, char *out, size_t cap);
/* Last path segment of a URL (percent-decoded) — used to derive filenames. */
void util_url_filename(const char *url, char *out, size_t cap);
/* Returns 1 when host == dom or host ends with ".dom". */
int util_host_matches(const char *host, const char *dom);

#endif
