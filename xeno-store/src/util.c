/*
 * util.c — see util.h. No dependency on any other module.
 */
#include "util.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

/* ---- strings ------------------------------------------------------------ */

size_t xstrlcpy(char *dst, const char *src, size_t cap) {
  size_t n = src ? strlen(src) : 0;
  if (cap == 0) return n;
  if (!src) { dst[0] = 0; return 0; }
  size_t c = n < cap - 1 ? n : cap - 1;
  memcpy(dst, src, c);
  dst[c] = 0;
  return n;
}

size_t xstrlcat(char *dst, const char *src, size_t cap) {
  size_t d = strnlen(dst, cap);
  if (d >= cap) return cap + strlen(src);
  return d + xstrlcpy(dst + d, src, cap - d);
}

int xvsnprintf(char *dst, size_t cap, const char *fmt, va_list ap) {
  if (cap == 0) return 0;
  int n = vsnprintf(dst, cap, fmt, ap);
  if (n < 0) { dst[0] = 0; return 0; }
  if ((size_t)n >= cap) return (int)(cap - 1);
  return n;
}

int xsnprintf(char *dst, size_t cap, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = xvsnprintf(dst, cap, fmt, ap);
  va_end(ap);
  return n;
}

char *util_strdup(const char *s) {
  if (!s) s = "";
  size_t n = strlen(s) + 1;
  char *p = malloc(n);
  if (p) memcpy(p, s, n);
  return p;
}

int util_strieq(const char *a, const char *b) {
  if (!a || !b) return 0;
  while (*a && *b) {
    if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
    a++; b++;
  }
  return *a == 0 && *b == 0;
}

int util_starts_with(const char *s, const char *prefix) {
  return s && prefix && strncmp(s, prefix, strlen(prefix)) == 0;
}

int util_istarts_with(const char *s, const char *prefix) {
  if (!s || !prefix) return 0;
  while (*prefix) {
    if (tolower((unsigned char)*s) != tolower((unsigned char)*prefix)) return 0;
    s++; prefix++;
  }
  return 1;
}

int util_ends_with(const char *s, const char *suffix) {
  size_t a = strlen(s), b = strlen(suffix);
  return a >= b && memcmp(s + a - b, suffix, b) == 0;
}

int util_iends_with(const char *s, const char *suffix) {
  size_t a = strlen(s), b = strlen(suffix);
  return a >= b && util_strieq(s + a - b, suffix);
}

const char *util_strcasestr(const char *hay, const char *needle) {
  if (!hay || !needle) return NULL;
  size_t n = strlen(needle);
  if (n == 0) return hay;
  for (; *hay; hay++) {
    if (tolower((unsigned char)*hay) == tolower((unsigned char)*needle) &&
        strncasecmp(hay, needle, n) == 0)
      return hay;
  }
  return NULL;
}

void util_trim(char *s) {
  size_t n = strlen(s), i = 0;
  while (i < n && isspace((unsigned char)s[i])) i++;
  while (n > i && isspace((unsigned char)s[n - 1])) n--;
  if (i) memmove(s, s + i, n - i);
  s[n - i] = 0;
}

void util_lower(char *s) { for (; *s; s++) *s = (char)tolower((unsigned char)*s); }
void util_upper(char *s) { for (; *s; s++) *s = (char)toupper((unsigned char)*s); }

/* Accent folding table for U+00C0..U+017F (Latin-1 Supplement + Extended-A).
 * Each entry is the ASCII replacement; "" keeps the original bytes. */
static const char *fold_latin(unsigned cp) {
  static const char *const l1[] = { /* U+00C0 .. U+00FF */
    "a","a","a","a","a","a","ae","c","e","e","e","e","i","i","i","i",
    "d","n","o","o","o","o","o","","o","u","u","u","u","y","th","ss",
    "a","a","a","a","a","a","ae","c","e","e","e","e","i","i","i","i",
    "d","n","o","o","o","o","o","","o","u","u","u","u","y","th","y"};
  static const char *const la[] = { /* U+0100 .. U+017F */
    "a","a","a","a","a","a","c","c","c","c","c","c","c","c","d","d",
    "d","d","e","e","e","e","e","e","e","e","e","e","g","g","g","g",
    "g","g","g","g","h","h","h","h","i","i","i","i","i","i","i","i",
    "i","i","ij","ij","j","j","k","k","k","l","l","l","l","l","l","l",
    "l","l","l","n","n","n","n","n","n","n","n","n","o","o","o","o",
    "o","o","oe","oe","r","r","r","r","r","r","s","s","s","s","s","s",
    "s","s","t","t","t","t","t","t","u","u","u","u","u","u","u","u",
    "u","u","u","u","w","w","y","y","y","z","z","z","z","z","z","s"};
  if (cp >= 0xC0 && cp <= 0xFF) return l1[cp - 0xC0];
  if (cp >= 0x100 && cp <= 0x17F) return la[cp - 0x100];
  return "";
}

void util_fold(const char *in, char *out, size_t cap) {
  size_t o = 0;
  if (cap == 0) return;
  const unsigned char *p = (const unsigned char *)in;
  while (*p && o + 1 < cap) {
    unsigned c = *p;
    if (c < 0x80) {
      out[o++] = (char)tolower((int)c);
      p++;
      continue;
    }
    /* Decode a 2-byte sequence; longer sequences are copied verbatim. */
    if ((c & 0xE0) == 0xC0 && (p[1] & 0xC0) == 0x80) {
      unsigned cp = ((c & 0x1F) << 6) | (p[1] & 0x3F);
      const char *rep = fold_latin(cp);
      if (rep[0]) {
        size_t rl = strlen(rep);
        if (o + rl + 1 > cap) break;
        memcpy(out + o, rep, rl);
        o += rl;
        p += 2;
        continue;
      }
      if (o + 3 > cap) break;
      out[o++] = (char)p[0]; out[o++] = (char)p[1];
      p += 2;
      continue;
    }
    size_t len = (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
    if (o + len + 1 > cap) break;
    for (size_t i = 0; i < len && p[i]; i++) out[o++] = (char)p[i];
    p += len;
  }
  out[o] = 0;
}

int util_parse_i64(const char *s, int64_t *out) {
  if (!s || !*s) return -1;
  char *end = NULL;
  errno = 0;
  long long v = strtoll(s, &end, 10);
  if (errno || end == s) return -1;
  while (*end && isspace((unsigned char)*end)) end++;
  if (*end) return -1;
  *out = (int64_t)v;
  return 0;
}

int util_parse_int(const char *s, int dflt) {
  int64_t v;
  if (util_parse_i64(s, &v) != 0) return dflt;
  if (v > 2147483647LL || v < -2147483647LL) return dflt;
  return (int)v;
}

int util_semver_cmp(const char *a, const char *b) {
  if (*a == 'v' || *a == 'V') a++;
  if (*b == 'v' || *b == 'V') b++;
  for (int i = 0; i < 4; i++) {
    long x = strtol(a, (char **)&a, 10), y = strtol(b, (char **)&b, 10);
    if (x != y) return x < y ? -1 : 1;
    if (*a == '.') a++;
    if (*b == '.') b++;
    if (!*a && !*b) break;
  }
  return 0;
}

void util_ext(const char *filename, char *out, size_t cap) {
  const char *base = util_basename(filename);
  const char *dot = strrchr(base, '.');
  if (!dot || dot == base || !dot[1]) { if (cap) out[0] = 0; return; }
  xstrlcpy(out, dot + 1, cap);
  util_lower(out);
}

const char *util_basename(const char *path) {
  const char *s = strrchr(path, '/');
  return s ? s + 1 : path;
}

int util_find_titleid(const char *s, char *out, size_t cap) {
  for (const char *p = s; *p; p++) {
    if ((util_istarts_with(p, "PPSA") || util_istarts_with(p, "CUSA")) &&
        isdigit((unsigned char)p[4]) && isdigit((unsigned char)p[5]) &&
        isdigit((unsigned char)p[6]) && isdigit((unsigned char)p[7]) &&
        isdigit((unsigned char)p[8]) && !isdigit((unsigned char)p[9])) {
      if (cap < 10) return -1;
      memcpy(out, p, 9);
      out[9] = 0;
      util_upper(out);
      return 0;
    }
  }
  return -1;
}

void util_fmt_bytes(int64_t n, char *out, size_t cap) {
  static const char *const units[] = {"B", "KB", "MB", "GB", "TB"};
  double v = (double)(n < 0 ? 0 : n);
  int u = 0;
  while (v >= 1000.0 && u < 4) { v /= 1024.0; u++; }
  if (u == 0) xsnprintf(out, cap, "%lld B", (long long)n);
  else xsnprintf(out, cap, "%.1f %s", v, units[u]);
}

static uint32_t rand_u32(void) {
  /* xorshift seeded once from time + address entropy; good enough for ids,
   * tokens get extra bytes from /dev/urandom when available. */
  static uint32_t state = 0;
  if (state == 0) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    state = (uint32_t)tv.tv_sec ^ (uint32_t)tv.tv_usec ^ (uint32_t)(uintptr_t)&state ^ (uint32_t)getpid();
    if (state == 0) state = 0x9E3779B9u;
  }
  uint32_t x = state;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  state = x;
  return x;
}

void util_rand_hex(char *out, size_t nchars) {
  static const char hexd[] = "0123456789abcdef";
  uint8_t pool[64];
  size_t have = 0;
  int fd = open("/dev/urandom", O_RDONLY);
  if (fd >= 0) {
    ssize_t r = read(fd, pool, sizeof pool);
    if (r > 0) have = (size_t)r;
    close(fd);
  }
  for (size_t i = 0; i < nchars; i++) {
    uint32_t r = i < have ? pool[i] : rand_u32();
    out[i] = hexd[r & 15];
  }
  out[nchars] = 0;
}

void util_rand_id(const char *prefix, char *out, size_t cap) {
  char hex[7];
  util_rand_hex(hex, 6);
  xsnprintf(out, cap, "%s%s", prefix, hex);
}

void util_hex(const uint8_t *in, size_t n, char *out, size_t cap) {
  static const char hexd[] = "0123456789abcdef";
  size_t o = 0;
  for (size_t i = 0; i < n && o + 2 < cap; i++) {
    out[o++] = hexd[in[i] >> 4];
    out[o++] = hexd[in[i] & 15];
  }
  if (cap) out[o] = 0;
}

static size_t utf8_put(unsigned cp, char *o) {
  if (cp < 0x80) { o[0] = (char)cp; return 1; }
  if (cp < 0x800) { o[0] = (char)(0xC0 | (cp >> 6)); o[1] = (char)(0x80 | (cp & 0x3F)); return 2; }
  if (cp < 0x10000) {
    o[0] = (char)(0xE0 | (cp >> 12)); o[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    o[2] = (char)(0x80 | (cp & 0x3F)); return 3;
  }
  o[0] = (char)(0xF0 | (cp >> 18)); o[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
  o[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); o[3] = (char)(0x80 | (cp & 0x3F));
  return 4;
}

void util_html_unescape(char *s) {
  static const struct { const char *name; const char *rep; } named[] = {
    {"amp", "&"}, {"lt", "<"}, {"gt", ">"}, {"quot", "\""}, {"apos", "'"},
    {"nbsp", " "}, {"ndash", "\xe2\x80\x93"}, {"mdash", "\xe2\x80\x94"},
    {"hellip", "..."}, {"rsquo", "'"}, {"lsquo", "'"}, {"ldquo", "\""}, {"rdquo", "\""}};
  char *r = s, *w = s;
  while (*r) {
    if (*r != '&') { *w++ = *r++; continue; }
    char *semi = strchr(r, ';');
    if (!semi || semi - r > 10) { *w++ = *r++; continue; }
    size_t len = (size_t)(semi - r - 1);
    const char *body = r + 1;
    if (body[0] == '#') {
      unsigned cp = (unsigned)strtoul(body + ((body[1] == 'x' || body[1] == 'X') ? 2 : 1), NULL,
                                      (body[1] == 'x' || body[1] == 'X') ? 16 : 10);
      if (cp && cp < 0x110000) { w += utf8_put(cp, w); r = semi + 1; continue; }
      *w++ = *r++;
      continue;
    }
    int done = 0;
    for (size_t i = 0; i < XS_ARRAY_LEN(named); i++) {
      if (strlen(named[i].name) == len && strncmp(body, named[i].name, len) == 0) {
        size_t rl = strlen(named[i].rep);
        memcpy(w, named[i].rep, rl);
        w += rl;
        r = semi + 1;
        done = 1;
        break;
      }
    }
    if (!done) *w++ = *r++;
  }
  *w = 0;
}

/* ---- time --------------------------------------------------------------- */

int64_t util_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

time_t util_now(void) { return time(NULL); }

void util_sleep_ms(int ms) {
  struct timespec ts = { ms / 1000, (long)(ms % 1000) * 1000000L };
  while (nanosleep(&ts, &ts) != 0 && errno == EINTR) { }
}

void util_iso8601(time_t t, char *out, size_t cap) {
  struct tm tm;
  gmtime_r(&t, &tm);
  xsnprintf(out, cap, "%04d-%02d-%02dT%02d:%02d:%02dZ", tm.tm_year + 1900, tm.tm_mon + 1,
            tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
}

/* ---- filesystem --------------------------------------------------------- */

int util_mkdir_p(const char *path) {
  char tmp[1024];
  size_t n = xstrlcpy(tmp, path, sizeof tmp);
  if (n >= sizeof tmp) return -1;
  for (char *p = tmp + 1; *p; p++) {
    if (*p == '/') {
      *p = 0;
      if (mkdir(tmp, 0777) != 0 && errno != EEXIST) return -1;
      *p = '/';
    }
  }
  if (mkdir(tmp, 0777) != 0 && errno != EEXIST) return -1;
  return 0;
}

int util_file_exists(const char *path) {
  struct stat st;
  return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

int util_dir_exists(const char *path) {
  struct stat st;
  return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

int64_t util_file_size(const char *path) {
  struct stat st;
  if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) return -1;
  return (int64_t)st.st_size;
}

time_t util_file_mtime(const char *path) {
  struct stat st;
  if (stat(path, &st) != 0) return 0;
  return st.st_mtime;
}

int util_write_file_atomic(const char *path, const void *data, size_t len) {
  char tmp[1100];
  xsnprintf(tmp, sizeof tmp, "%s.tmp", path);
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return -1;
  const char *p = data;
  size_t off = 0;
  while (off < len) {
    ssize_t w = write(fd, p + off, len - off);
    if (w < 0) { if (errno == EINTR) continue; close(fd); unlink(tmp); return -1; }
    off += (size_t)w;
  }
  if (fsync(fd) != 0) { /* best effort on exotic filesystems */ }
  close(fd);
  if (rename(tmp, path) != 0) { unlink(tmp); return -1; }
  return 0;
}

char *util_read_file(const char *path, size_t *len, size_t max) {
  if (max == 0) max = 64u << 20;
  int fd = open(path, O_RDONLY);
  if (fd < 0) return NULL;
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || (size_t)st.st_size > max) { close(fd); return NULL; }
  size_t n = (size_t)st.st_size;
  char *buf = malloc(n + 1);
  if (!buf) { close(fd); return NULL; }
  size_t off = 0;
  while (off < n) {
    ssize_t r = read(fd, buf + off, n - off);
    if (r < 0) { if (errno == EINTR) continue; free(buf); close(fd); return NULL; }
    if (r == 0) break;
    off += (size_t)r;
  }
  close(fd);
  buf[off] = 0;
  if (len) *len = off;
  return buf;
}

int util_unlink_quiet(const char *path) {
  if (!path || !*path) return -1;
  return unlink(path) == 0 ? 0 : (errno == ENOENT ? 0 : -1);
}

int util_fsync_dir(const char *file_path) {
  char dir[1024];
  xstrlcpy(dir, file_path, sizeof dir);
  char *s = strrchr(dir, '/');
  if (!s) return 0;
  if (s == dir) s[1] = 0; else *s = 0;
  int fd = open(dir, O_RDONLY);
  if (fd < 0) return -1;
  int rc = fsync(fd);
  close(fd);
  return rc;
}

/* ---- base64 ------------------------------------------------------------- */

static const char b64chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

size_t util_b64_encode(const uint8_t *in, size_t n, char *out, size_t cap) {
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    if (o + 5 > cap) break;
    uint32_t v = (uint32_t)in[i] << 16;
    if (i + 1 < n) v |= (uint32_t)in[i + 1] << 8;
    if (i + 2 < n) v |= in[i + 2];
    out[o++] = b64chars[(v >> 18) & 63];
    out[o++] = b64chars[(v >> 12) & 63];
    out[o++] = i + 1 < n ? b64chars[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < n ? b64chars[v & 63] : '=';
  }
  if (cap) out[o] = 0;
  return o;
}

static int b64val(int c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+' || c == '-') return 62;
  if (c == '/' || c == '_') return 63;
  return -1;
}

int util_b64_decode(const char *in, size_t n, uint8_t *out, size_t cap, size_t *outlen) {
  uint32_t acc = 0;
  int bits = 0;
  size_t o = 0;
  for (size_t i = 0; i < n; i++) {
    int c = (unsigned char)in[i];
    if (c == '=' ) break;
    if (isspace(c)) continue;
    int v = b64val(c);
    if (v < 0) return -1;
    acc = (acc << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o >= cap) return -1;
      out[o++] = (uint8_t)((acc >> bits) & 0xFF);
    }
  }
  if (outlen) *outlen = o;
  return 0;
}

/* ---- URLs --------------------------------------------------------------- */

int util_url_parse(const char *url, xurl *out) {
  memset(out, 0, sizeof *out);
  const char *p = strstr(url, "://");
  if (!p || p - url > 6) return -1;
  size_t sl = (size_t)(p - url);
  memcpy(out->scheme, url, sl);
  out->scheme[sl] = 0;
  util_lower(out->scheme);
  if (strcmp(out->scheme, "http") != 0 && strcmp(out->scheme, "https") != 0) return -1;
  p += 3;
  const char *path = strpbrk(p, "/?#");
  size_t authlen = path ? (size_t)(path - p) : strlen(p);
  char auth[320];
  if (authlen >= sizeof auth || authlen == 0) return -1;
  memcpy(auth, p, authlen);
  auth[authlen] = 0;
  char *at = strrchr(auth, '@');
  const char *hostport = auth;
  if (at) { out->has_userinfo = 1; hostport = at + 1; }
  const char *colon = NULL;
  if (hostport[0] == '[') {               /* IPv6 literal */
    const char *rb = strchr(hostport, ']');
    if (!rb) return -1;
    size_t hl = (size_t)(rb - hostport + 1);
    if (hl >= sizeof out->host) return -1;
    memcpy(out->host, hostport, hl);
    out->host[hl] = 0;
    if (rb[1] == ':') colon = rb + 1;
  } else {
    colon = strchr(hostport, ':');
    size_t hl = colon ? (size_t)(colon - hostport) : strlen(hostport);
    if (hl == 0 || hl >= sizeof out->host) return -1;
    memcpy(out->host, hostport, hl);
    out->host[hl] = 0;
  }
  util_lower(out->host);
  out->port = strcmp(out->scheme, "https") == 0 ? 443 : 80;
  if (colon) {
    int prt = util_parse_int(colon + 1, -1);
    if (prt <= 0 || prt > 65535) return -1;
    out->port = prt;
  }
  if (!path || path[0] == '#') xstrlcpy(out->path, "/", sizeof out->path);
  else {
    const char *frag = strchr(path, '#');
    size_t pl = frag ? (size_t)(frag - path) : strlen(path);
    if (pl >= sizeof out->path) return -1;
    if (path[0] == '?') { out->path[0] = '/'; memcpy(out->path + 1, path, pl); out->path[pl + 1] = 0; }
    else { memcpy(out->path, path, pl); out->path[pl] = 0; }
  }
  return 0;
}

int util_url_resolve(const char *base, const char *loc, char *out, size_t cap) {
  if (strstr(loc, "://")) { xstrlcpy(out, loc, cap); return 0; }
  xurl b;
  if (util_url_parse(base, &b) != 0) return -1;
  char origin[400];
  int dflt = strcmp(b.scheme, "https") == 0 ? 443 : 80;
  if (b.port == dflt) xsnprintf(origin, sizeof origin, "%s://%s", b.scheme, b.host);
  else xsnprintf(origin, sizeof origin, "%s://%s:%d", b.scheme, b.host, b.port);
  if (util_starts_with(loc, "//")) { xsnprintf(out, cap, "%s:%s", b.scheme, loc); return 0; }
  if (loc[0] == '/') { xsnprintf(out, cap, "%s%s", origin, loc); return 0; }
  /* relative: replace the last path segment */
  char dir[1536];
  xstrlcpy(dir, b.path, sizeof dir);
  char *q = strchr(dir, '?');
  if (q) *q = 0;
  char *s = strrchr(dir, '/');
  if (s) s[1] = 0; else xstrlcpy(dir, "/", sizeof dir);
  xsnprintf(out, cap, "%s%s%s", origin, dir, loc);
  return 0;
}

static int hexv(int c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int util_url_decode(const char *in, size_t n, char *out, size_t cap) {
  size_t o = 0;
  for (size_t i = 0; i < n && o + 1 < cap; i++) {
    if (in[i] == '%' && i + 2 < n && hexv(in[i + 1]) >= 0 && hexv(in[i + 2]) >= 0) {
      out[o++] = (char)((hexv(in[i + 1]) << 4) | hexv(in[i + 2]));
      i += 2;
    } else if (in[i] == '+') {
      out[o++] = ' ';
    } else {
      out[o++] = in[i];
    }
  }
  if (cap) out[o] = 0;
  return (int)o;
}

void util_url_encode_path(const char *in, char *out, size_t cap) {
  static const char hexd[] = "0123456789ABCDEF";
  size_t o = 0;
  for (const unsigned char *p = (const unsigned char *)in; *p && o + 4 < cap; p++) {
    if (isalnum(*p) || strchr("-_.~/", *p)) out[o++] = (char)*p;
    else { out[o++] = '%'; out[o++] = hexd[*p >> 4]; out[o++] = hexd[*p & 15]; }
  }
  if (cap) out[o] = 0;
}

void util_url_host(const char *url, char *out, size_t cap) {
  xurl u;
  if (util_url_parse(url, &u) != 0) { if (cap) out[0] = 0; return; }
  const char *h = u.host;
  if (util_starts_with(h, "www.")) h += 4;
  xstrlcpy(out, h, cap);
}

void util_url_filename(const char *url, char *out, size_t cap) {
  xurl u;
  if (cap) out[0] = 0;
  if (util_url_parse(url, &u) != 0) return;
  char *q = strchr(u.path, '?');
  if (q) *q = 0;
  size_t n = strlen(u.path);
  while (n > 1 && u.path[n - 1] == '/') u.path[--n] = 0;
  const char *seg = strrchr(u.path, '/');
  seg = seg ? seg + 1 : u.path;
  util_url_decode(seg, strlen(seg), out, cap);
}

int util_host_matches(const char *host, const char *dom) {
  size_t hl = strlen(host), dl = strlen(dom);
  if (hl == dl) return strcasecmp(host, dom) == 0;
  if (hl > dl && host[hl - dl - 1] == '.') return strcasecmp(host + hl - dl, dom) == 0;
  return 0;
}
