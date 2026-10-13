/*
 * cx_common.c — see cx_common.h.
 */
#include "cx_common.h"
#include "config.h"
#include "log.h"
#include "sha256.h"
#include "util.h"

#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

/* ---- console paths ------------------------------------------------------ */

int cx_is_host(void) {
#ifdef XENO_HOST
  return 1;
#else
  return 0;
#endif
}

void cx_console_path(const char *console_path, char *out, size_t cap) {
#ifdef XENO_HOST
  xsnprintf(out, cap, "%s/sim%s", g_cfg.data_dir, console_path);
#else
  xstrlcpy(out, console_path, cap);
#endif
}

static const char *static_console_path(char *buf, size_t cap, const char *p) {
  if (!buf[0]) cx_console_path(p, buf, cap);
  return buf;
}

const char *cx_home_root(void) { static char b[600]; return static_console_path(b, sizeof b, "/user/home"); }
const char *cx_appmeta_root(void) { static char b[600]; return static_console_path(b, sizeof b, "/system_data/priv/appmeta"); }
const char *cx_data_homebrew_dir(void) { static char b[600]; return static_console_path(b, sizeof b, "/data/homebrew"); }
const char *cx_data_dir(void) { return g_cfg.data_dir; }

int cx_local_port(const char *name, int dflt) {
#ifdef XENO_HOST
  char key[64];
  xsnprintf(key, sizeof key, "XENO_PORT_%s", name);
  const char *v = getenv(key);
  if (v && *v) { int p = util_parse_int(v, dflt); if (p > 0 && p < 65536) return p; }
#else
  (void)name;
#endif
  return dflt;
}

const char *cx_base_override(const char *name) {
#ifdef XENO_HOST
  char key[64];
  xsnprintf(key, sizeof key, "XENO_%s_BASE", name);
  const char *v = getenv(key);
  if (v && util_istarts_with(v, "http")) return v;
#else
  (void)name;
#endif
  return "";
}

/* ---- validation --------------------------------------------------------- */

int cx_titleid_valid(const char *s) {
  if (!s || strlen(s) != 9) return 0;
  if (strncmp(s, "PPSA", 4) != 0 && strncmp(s, "CUSA", 4) != 0) return 0;
  for (int i = 4; i < 9; i++) if (s[i] < '0' || s[i] > '9') return 0;
  return 1;
}

int cx_id_valid(const char *s, size_t maxlen) {
  size_t n = s ? strlen(s) : 0;
  if (n == 0 || n > maxlen || s[0] == '.') return 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return 0;
  }
  return strcmp(s, "..") != 0;
}

int cx_dirname_valid(const char *s) {
  size_t n = s ? strlen(s) : 0;
  if (n == 0 || n > 31) return 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return 0;
  }
  return 1;
}

int cx_path_is_clean(const char *p) {
  if (!p || p[0] != '/' || strlen(p) >= CX_PATH_MAX) return 0;
  for (const unsigned char *c = (const unsigned char *)p; *c; c++) if (*c < 0x20 || *c == 0x7f) return 0;
  if (strstr(p, "/../") || util_ends_with(p, "/..") || strstr(p, "/./")) return 0;
  return 1;
}

int cx_path_under(const char *path, const char *dir) {
  size_t n = strlen(dir);
  if (n == 0) return 0;
  if (strncmp(path, dir, n) != 0) return 0;
  return path[n] == '/' || path[n] == 0 || dir[n - 1] == '/';
}

int cx_host_in(const char *host, const char *const *list, size_t n) {
  for (size_t i = 0; i < n; i++) if (util_host_matches(host, list[i])) return 1;
  return 0;
}

int cx_host_is_loopback(const char *host) {
#ifdef XENO_HOST
  return strcmp(host, "127.0.0.1") == 0 || strcmp(host, "localhost") == 0;
#else
  (void)host;
  return 0;
#endif
}

/* ---- filesystem --------------------------------------------------------- */

int64_t cx_dir_size(const char *dir, int max_depth) {
  if (max_depth < 0) return 0;
  DIR *d = opendir(dir);
  if (!d) return 0;
  int64_t total = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    char p[CX_PATH_MAX];
    if (xsnprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= (int)sizeof p - 1) continue;
    struct stat st;
    if (lstat(p, &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) total += cx_dir_size(p, max_depth - 1);
    else if (S_ISREG(st.st_mode)) total += (int64_t)st.st_size;
  }
  closedir(d);
  return total;
}

int cx_count_files(const char *dir, int max_depth) {
  if (max_depth < 0) return 0;
  DIR *d = opendir(dir);
  if (!d) return 0;
  int n = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    char p[CX_PATH_MAX];
    if (xsnprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= (int)sizeof p - 1) continue;
    struct stat st;
    if (lstat(p, &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) n += cx_count_files(p, max_depth - 1);
    else if (S_ISREG(st.st_mode)) n++;
  }
  closedir(d);
  return n;
}

int cx_rm_rf(const char *path, int max_depth) {
  if (!path || strlen(path) < 6 || strcmp(path, "/") == 0 || !cx_path_is_clean(path)) return -1;
  if (max_depth < 0) return -1;
  struct stat st;
  if (lstat(path, &st) != 0) return errno == ENOENT ? 0 : -1;
  if (!S_ISDIR(st.st_mode)) return unlink(path) == 0 ? 0 : -1;
  DIR *d = opendir(path);
  if (!d) return -1;
  int rc = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    char p[CX_PATH_MAX];
    if (xsnprintf(p, sizeof p, "%s/%s", path, e->d_name) >= (int)sizeof p - 1) { rc = -1; continue; }
    struct stat cs;
    if (lstat(p, &cs) != 0) continue;
    if (S_ISDIR(cs.st_mode)) { if (cx_rm_rf(p, max_depth - 1) != 0) rc = -1; }
    else if (unlink(p) != 0) rc = -1;
  }
  closedir(d);
  if (rmdir(path) != 0) rc = -1;
  return rc;
}

int cx_copy_file(const char *src, const char *dst) {
  int in = open(src, O_RDONLY);
  if (in < 0) return -1;
  int out = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (out < 0) { close(in); return -1; }
  char *buf = malloc(1 << 20);
  if (!buf) { close(in); close(out); return -1; }
  int rc = 0;
  for (;;) {
    ssize_t n = read(in, buf, 1 << 20);
    if (n < 0) { rc = -1; break; }
    if (n == 0) break;
    ssize_t off = 0;
    while (off < n) {
      ssize_t w = write(out, buf + off, (size_t)(n - off));
      if (w <= 0) { rc = -1; break; }
      off += w;
    }
    if (rc) break;
  }
  free(buf);
  close(in);
  if (close(out) != 0) rc = -1;
  return rc;
}

int cx_copy_tree(const char *src, const char *dst, int max_depth, int64_t *bytes) {
  if (max_depth < 0) return -1;
  DIR *d = opendir(src);
  if (!d) return -1;
  if (util_mkdir_p(dst) != 0) { closedir(d); return -1; }
  int rc = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    char s[CX_PATH_MAX], t[CX_PATH_MAX];
    if (xsnprintf(s, sizeof s, "%s/%s", src, e->d_name) >= (int)sizeof s - 1) { rc = -1; continue; }
    if (xsnprintf(t, sizeof t, "%s/%s", dst, e->d_name) >= (int)sizeof t - 1) { rc = -1; continue; }
    struct stat st;
    if (lstat(s, &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) { if (cx_copy_tree(s, t, max_depth - 1, bytes) != 0) rc = -1; }
    else if (S_ISREG(st.st_mode)) {
      if (cx_copy_file(s, t) != 0) rc = -1;
      else if (bytes) *bytes += (int64_t)st.st_size;
    }
  }
  closedir(d);
  return rc;
}

char *cx_read_small(const char *path, size_t max, size_t *len) { return util_read_file(path, len, max); }

jdoc *cx_json_file(const char *path, size_t max, size_t max_nodes) {
  size_t len;
  char *txt = util_read_file(path, &len, max);
  if (!txt) return NULL;
  jdoc *d = json_parse(txt, len, max_nodes, 32);
  free(txt);
  return d;
}

int cx_write_json(const char *path, jw *w) {
  size_t len;
  char *txt = jw_detach(w, &len);
  if (!txt) return -1;
  int rc = util_write_file_atomic(path, txt, len);
  free(txt);
  return rc;
}

time_t cx_mtime(const char *path) { return util_file_mtime(path); }

void cx_stamp(char *out, size_t cap) {
  time_t t = util_now();
  struct tm tmv;
  localtime_r(&t, &tmv);
  xsnprintf(out, cap, "%04d%02d%02d-%02d%02d", tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday, tmv.tm_hour, tmv.tm_min);
}

/* ---- HTTP --------------------------------------------------------------- */

char *cx_fetch(const char *url, const cx_http *opt, int *status, size_t *len, xhttp_resp *resp) {
  cx_http dflt = {0};
  if (!opt) opt = &dflt;
  xhttp_req r;
  memset(&r, 0, sizeof r);
  r.method = opt->method ? opt->method : "GET";
  r.url = url;
  r.range_start = r.range_end = -1;
  r.extra_headers = opt->headers;
  r.body = opt->body;
  r.body_len = opt->body_len;
  r.connect_timeout_ms = opt->timeout_ms ? opt->timeout_ms : 15000;
  r.recv_timeout_ms = opt->timeout_ms ? opt->timeout_ms : 15000;
  r.follow_redirects = opt->follow ? opt->follow : 5;
  xhttp_resp local;
  if (!resp) resp = &local;
  xhttp_resp_reset(resp);
  size_t l = 0;
  char *body = xhttp_fetch(&r, resp, opt->max_bytes ? opt->max_bytes : (4u << 20), &l);
  if (status) *status = body ? resp->status : 0;
  if (len) *len = l;
  return body;
}

int cx_sha256_file(const char *path, char hex[65]) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) return -1;
  char *buf = malloc(1 << 20);
  if (!buf) { close(fd); return -1; }
  sha256_ctx c;
  sha256_init(&c);
  for (;;) {
    ssize_t n = read(fd, buf, 1 << 20);
    if (n < 0) { free(buf); close(fd); return -1; }
    if (n == 0) break;
    sha256_update(&c, buf, (size_t)n);
  }
  free(buf);
  close(fd);
  uint8_t dg[32];
  sha256_final(&c, dg);
  sha256_digest_hex(dg, hex);
  return 0;
}

static pthread_key_t dl_type_key;
static pthread_once_t dl_type_once = PTHREAD_ONCE_INIT;
static void dl_type_init(void) { pthread_key_create(&dl_type_key, free); }
static char *dl_type_slot(void) {
  pthread_once(&dl_type_once, dl_type_init);
  char *p = pthread_getspecific(dl_type_key);
  if (!p) { p = calloc(1, 96); if (p) pthread_setspecific(dl_type_key, p); }
  return p;
}
const char *cx_download_last_type(void) { char *p = dl_type_slot(); return p ? p : ""; }

int cx_download_file(const char *url, const cx_http *opt, const char *dest, const char *sha256_expected, int64_t max_bytes,
                     cx_progress_fn progress, void *user, volatile int *cancel, char *err, size_t errcap) {
  xurl u;
  if (util_url_parse(url, &u) != 0 || u.has_userinfo) { xsnprintf(err, errcap, "invalid url"); return -1; }
  xhttp_req r;
  memset(&r, 0, sizeof r);
  r.method = opt && opt->method ? opt->method : "GET";
  r.url = url;
  r.range_start = r.range_end = -1;
  r.extra_headers = opt ? opt->headers : NULL;
  r.body = opt ? opt->body : NULL;
  r.body_len = opt ? opt->body_len : 0;
  r.connect_timeout_ms = opt && opt->timeout_ms ? opt->timeout_ms : 15000;
  r.recv_timeout_ms = opt && opt->timeout_ms ? opt->timeout_ms : 30000;
  r.follow_redirects = opt && opt->follow ? opt->follow : 5;
  r.cancel_flag = cancel;
  xhttp_conn *c = NULL;
  xhttp_resp resp;
  char *ts = dl_type_slot();
  if (ts) ts[0] = 0;
  if (xhttp_open(&r, &c, &resp) != 0) { xsnprintf(err, errcap, "%s", xhttp_last_error()); return -1; }
  if (ts) xstrlcpy(ts, resp.content_type, 96);
  if (resp.status != 200) { xsnprintf(err, errcap, "HTTP %d", resp.status); xhttp_close(c); return -1; }
  if (util_istarts_with(resp.content_type, "text/html")) { xsnprintf(err, errcap, "the host returned a web page instead of the file"); xhttp_close(c); return -1; }
  if (max_bytes > 0 && resp.content_length > max_bytes) { xsnprintf(err, errcap, "file is larger than the limit"); xhttp_close(c); return -1; }
  char tmp[CX_PATH_MAX];
  xsnprintf(tmp, sizeof tmp, "%s.part", dest);
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) { xsnprintf(err, errcap, "cannot write %s", dest); xhttp_close(c); return -1; }
  char *buf = malloc(512 << 10);
  if (!buf) { close(fd); unlink(tmp); xhttp_close(c); xsnprintf(err, errcap, "out of memory"); return -1; }
  sha256_ctx h;
  sha256_init(&h);
  int64_t done = 0;
  int rc = 0;
  for (;;) {
    if (cancel && *cancel) { xsnprintf(err, errcap, "cancelled"); rc = -1; break; }
    int n = xhttp_read(c, buf, 512 << 10);
    if (n < 0) { xsnprintf(err, errcap, "%s", xhttp_last_error()); rc = -1; break; }
    if (n == 0) break;
    if (max_bytes > 0 && done + n > max_bytes) { xsnprintf(err, errcap, "file is larger than the limit"); rc = -1; break; }
    ssize_t off = 0;
    while (off < n) {
      ssize_t w = write(fd, buf + off, (size_t)(n - off));
      if (w <= 0) { xsnprintf(err, errcap, "write failed: %s", strerror(errno)); rc = -1; break; }
      off += w;
    }
    if (rc) break;
    sha256_update(&h, buf, (size_t)n);
    done += n;
    if (progress && progress(user, done, resp.content_length)) { xsnprintf(err, errcap, "cancelled"); rc = -1; break; }
  }
  free(buf);
  xhttp_close(c);
  if (rc == 0 && fsync(fd) != 0) { xsnprintf(err, errcap, "fsync failed"); rc = -1; }
  close(fd);
  if (rc == 0 && resp.content_length > 0 && done != resp.content_length) { xsnprintf(err, errcap, "short download (%lld of %lld bytes)", (long long)done, (long long)resp.content_length); rc = -1; }
  if (rc == 0 && sha256_expected && sha256_expected[0]) {
    uint8_t dg[32];
    char hex[65];
    sha256_final(&h, dg);
    sha256_digest_hex(dg, hex);
    char want[65];
    xstrlcpy(want, sha256_expected, sizeof want);
    util_lower(want);
    if (strcmp(hex, want) != 0) { xsnprintf(err, errcap, "sha256 mismatch (file is not the published one)"); rc = -1; }
  }
  if (rc != 0) { unlink(tmp); return -1; }
  if (rename(tmp, dest) != 0) { xsnprintf(err, errcap, "cannot rename to %s", dest); unlink(tmp); return -1; }
  return 0;
}

static int connect_local(int port, int timeout_ms) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int fl = fcntl(fd, F_GETFL, 0);
  fcntl(fd, F_SETFL, fl | O_NONBLOCK);
  struct sockaddr_in sa;
  memset(&sa, 0, sizeof sa);
  sa.sin_family = AF_INET;
  sa.sin_port = htons((uint16_t)port);
  sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int rc = connect(fd, (struct sockaddr *)&sa, sizeof sa);
  if (rc != 0 && errno != EINPROGRESS) { close(fd); return -1; }
  if (rc != 0) {
    struct pollfd p = { fd, POLLOUT, 0 };
    if (poll(&p, 1, timeout_ms) <= 0) { close(fd); return -1; }
    int soerr = 0;
    socklen_t sl = sizeof soerr;
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &sl) != 0 || soerr != 0) { close(fd); return -1; }
  }
  fcntl(fd, F_SETFL, fl);
  return fd;
}

int cx_tcp_probe(int port, int timeout_ms) {
  int fd = connect_local(port, timeout_ms);
  if (fd < 0) return 0;
  close(fd);
  return 1;
}

int cx_tcp_send_all(int port, const void *data, size_t len, int timeout_ms, char *err, size_t errcap) {
  int fd = connect_local(port, timeout_ms);
  if (fd < 0) { xsnprintf(err, errcap, "nothing is listening on 127.0.0.1:%d", port); return -1; }
  struct timeval tv = { timeout_ms / 1000, (timeout_ms % 1000) * 1000 };
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
  const char *p = data;
  size_t off = 0;
  while (off < len) {
    ssize_t n = send(fd, p + off, len - off, 0);
    if (n <= 0) { xsnprintf(err, errcap, "send failed after %zu bytes: %s", off, strerror(errno)); close(fd); return -1; }
    off += (size_t)n;
  }
  shutdown(fd, SHUT_WR);
  close(fd);
  return 0;
}

/* ---- JSON helpers ------------------------------------------------------- */

void cx_jw_kv_opt(jw *w, const char *k, const char *v) { if (v && *v) jw_kv_str(w, k, v); }

void cx_url_encode(const char *in, char *out, size_t cap) {
  static const char hexd[] = "0123456789ABCDEF";
  size_t o = 0;
  for (const unsigned char *p = (const unsigned char *)in; *p && o + 4 < cap; p++) {
    unsigned char c = *p;
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') out[o++] = (char)c;
    else { out[o++] = '%'; out[o++] = hexd[c >> 4]; out[o++] = hexd[c & 15]; }
  }
  out[o] = 0;
}
