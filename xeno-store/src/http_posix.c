/*
 * http_posix.c — host transport: getaddrinfo + non-blocking connect with
 * timeout, hand-written HTTP/1.1 (identity + chunked bodies, Range, manual
 * redirects), TLS through OpenSSL when XENO_HAVE_OPENSSL (SNI + hostname
 * verification; `insecure_tls` turns verification off).
 *
 * Every blocking step is a poll() loop in 200 ms slices so the request's
 * cancel flag and xhttp_abort() are honored promptly. On the host build the
 * HTTPS_PROXY / HTTP_PROXY / NO_PROXY environment is honored (CONNECT
 * tunnelling) so CI and developer machines behind a proxy can sync.
 */
#include "http_client.h"
#include "log.h"
#include "util.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#ifdef XENO_HAVE_OPENSSL
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>
#endif

#define HDR_MAX 32768
#define POLL_SLICE_MS 200

struct xhttp_conn {
  int fd;
#ifdef XENO_HAVE_OPENSSL
  SSL *ssl;
#endif
  volatile int *cancel;
  volatile int aborted;
  int recv_timeout_ms;
  int head_only;
  int chunked;
  int64_t remaining;        /* identity body bytes left (-1 = until EOF) */
  int64_t chunk_left;       /* bytes left in current chunk */
  int chunk_done;
  char *buf;                /* leftover bytes read past the headers */
  size_t buf_len, buf_off;
  int eof;
};

static int g_inited = 0;
#ifdef XENO_HAVE_OPENSSL
static SSL_CTX *g_ctx = NULL;
static SSL_CTX *g_ctx_insecure = NULL;
#endif
static char g_proxy_host[256];
static int g_proxy_port = 0;
static char g_no_proxy[1024];

/* ---- init --------------------------------------------------------------- */

static void parse_proxy_env(void) {
  const char *p = getenv("HTTPS_PROXY");
  if (!p || !*p) p = getenv("https_proxy");
  if (!p || !*p) p = getenv("HTTP_PROXY");
  if (!p || !*p) return;
  xurl u;
  if (util_url_parse(p, &u) != 0) return;
  xstrlcpy(g_proxy_host, u.host, sizeof g_proxy_host);
  g_proxy_port = u.port;
  const char *np = getenv("NO_PROXY");
  if (!np) np = getenv("no_proxy");
  if (np) xstrlcpy(g_no_proxy, np, sizeof g_no_proxy);
}

int xhttp_global_init(void) {
  if (g_inited) return 0;
#ifdef XENO_HAVE_OPENSSL
  SSL_library_init();
  SSL_load_error_strings();
  g_ctx = SSL_CTX_new(TLS_client_method());
  g_ctx_insecure = SSL_CTX_new(TLS_client_method());
  if (!g_ctx || !g_ctx_insecure) { xhttp_set_error("SSL_CTX_new failed"); return -1; }
  SSL_CTX_set_default_verify_paths(g_ctx);   /* honors SSL_CERT_FILE / SSL_CERT_DIR */
  SSL_CTX_set_verify(g_ctx, SSL_VERIFY_PEER, NULL);
  SSL_CTX_set_verify(g_ctx_insecure, SSL_VERIFY_NONE, NULL);
  SSL_CTX_set_min_proto_version(g_ctx, TLS1_2_VERSION);
  SSL_CTX_set_min_proto_version(g_ctx_insecure, TLS1_2_VERSION);
  SSL_CTX_set_mode(g_ctx, SSL_MODE_AUTO_RETRY);
  SSL_CTX_set_mode(g_ctx_insecure, SSL_MODE_AUTO_RETRY);
#endif
  parse_proxy_env();
  if (g_proxy_port) LOGI("http: using proxy %s:%d", g_proxy_host, g_proxy_port);
  g_inited = 1;
  return 0;
}

int xhttp_available(void) { return g_inited; }

const char *xhttp_backend_name(void) {
#ifdef XENO_HAVE_OPENSSL
  return "posix+tls";
#else
  return "posix";
#endif
}

/* ---- low level I/O ------------------------------------------------------ */

static int conn_cancelled(xhttp_conn *c) {
  return c->aborted || (c->cancel && *c->cancel);
}

/* Waits for fd readiness; returns 1 ready, 0 timeout, -1 cancelled. */
static int wait_fd(xhttp_conn *c, int fd, short events, int timeout_ms) {
  int64_t deadline = util_now_ms() + timeout_ms;
  for (;;) {
    if (conn_cancelled(c)) return -1;
    int64_t left = deadline - util_now_ms();
    if (left <= 0) return 0;
    struct pollfd p = { fd, events, 0 };
    int r = poll(&p, 1, (int)(left < POLL_SLICE_MS ? left : POLL_SLICE_MS));
    if (r > 0) return 1;
    if (r < 0 && errno != EINTR) return 0;
  }
}

static int raw_recv(xhttp_conn *c, void *buf, size_t cap) {
  for (;;) {
#ifdef XENO_HAVE_OPENSSL
    if (c->ssl) {
      int n = SSL_read(c->ssl, buf, (int)cap);
      if (n > 0) return n;
      int e = SSL_get_error(c->ssl, n);
      if (e == SSL_ERROR_ZERO_RETURN) return 0;
      if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) {
        int w = wait_fd(c, c->fd, e == SSL_ERROR_WANT_READ ? POLLIN : POLLOUT, c->recv_timeout_ms);
        if (w == 1) continue;
        xhttp_set_error(w == 0 ? "receive timeout" : "cancelled");
        return -1;
      }
      if (e == SSL_ERROR_SYSCALL && n == 0) return 0;   /* peer closed without close_notify */
      xhttp_set_error("TLS read error");
      return -1;
    }
#endif
    ssize_t n = recv(c->fd, buf, cap, 0);
    if (n >= 0) return (int)n;
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      int w = wait_fd(c, c->fd, POLLIN, c->recv_timeout_ms);
      if (w == 1) continue;
      xhttp_set_error(w == 0 ? "receive timeout" : "cancelled");
      return -1;
    }
    xhttp_set_error("recv: %s", strerror(errno));
    return -1;
  }
}

static int raw_send_all(xhttp_conn *c, const char *p, size_t n) {
  size_t off = 0;
  while (off < n) {
#ifdef XENO_HAVE_OPENSSL
    if (c->ssl) {
      int w = SSL_write(c->ssl, p + off, (int)(n - off));
      if (w > 0) { off += (size_t)w; continue; }
      int e = SSL_get_error(c->ssl, w);
      if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) {
        if (wait_fd(c, c->fd, e == SSL_ERROR_WANT_READ ? POLLIN : POLLOUT, c->recv_timeout_ms) != 1) {
          xhttp_set_error("send timeout");
          return -1;
        }
        continue;
      }
      xhttp_set_error("TLS write error");
      return -1;
    }
#endif
    ssize_t w = send(c->fd, p + off, n - off, 0);
    if (w >= 0) { off += (size_t)w; continue; }
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      if (wait_fd(c, c->fd, POLLOUT, c->recv_timeout_ms) != 1) { xhttp_set_error("send timeout"); return -1; }
      continue;
    }
    xhttp_set_error("send: %s", strerror(errno));
    return -1;
  }
  return 0;
}

static int set_nonblock(int fd) {
  int fl = fcntl(fd, F_GETFL, 0);
  return fl < 0 ? -1 : fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

/* Connects to host:port with a timeout; returns fd or -1. */
static int tcp_connect(xhttp_conn *c, const char *host, int port, int timeout_ms) {
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  char portstr[16];
  xsnprintf(portstr, sizeof portstr, "%d", port);
  char hostbuf[256];
  xstrlcpy(hostbuf, host, sizeof hostbuf);
  if (hostbuf[0] == '[') { size_t l = strlen(hostbuf); if (l > 2) { hostbuf[l - 1] = 0; memmove(hostbuf, hostbuf + 1, l - 1); } }
  int rc = getaddrinfo(hostbuf, portstr, &hints, &res);
  if (rc != 0 || !res) { xhttp_set_error("DNS lookup failed for %s", host); return -1; }
  int fd = -1;
  for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
    fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) continue;
    set_nonblock(fd);
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    int r = connect(fd, ai->ai_addr, ai->ai_addrlen);
    if (r == 0) break;
    if (errno == EINPROGRESS) {
      int w = wait_fd(c, fd, POLLOUT, timeout_ms);
      int err = 0;
      socklen_t el = sizeof err;
      if (w == 1 && getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &el) == 0 && err == 0) break;
      xhttp_set_error(w == 0 ? "connect timeout" : w < 0 ? "cancelled" : "connect: %s", strerror(err));
    } else {
      xhttp_set_error("connect: %s", strerror(errno));
    }
    close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  if (fd < 0 && !xhttp_last_error()[0]) xhttp_set_error("connect failed");
  return fd;
}

/* Reads until "\r\n\r\n" (or "\n\n"); returns header block length (incl.
 * terminator) and leaves extra bytes in c->buf. */
static int read_header_block(xhttp_conn *c, char *hdr, size_t cap, size_t *hlen) {
  size_t len = 0;
  for (;;) {
    char *term = NULL;
    if (len >= 4) {
      hdr[len] = 0;
      term = strstr(hdr, "\r\n\r\n");
      if (term) term += 4;
      else { term = strstr(hdr, "\n\n"); if (term) term += 2; }
    }
    if (term) {
      size_t hl = (size_t)(term - hdr);
      size_t extra = len - hl;
      if (extra) {
        c->buf = malloc(extra);
        if (!c->buf) { xhttp_set_error("out of memory"); return -1; }
        memcpy(c->buf, hdr + hl, extra);
        c->buf_len = extra;
      }
      *hlen = hl;
      hdr[hl] = 0;
      return 0;
    }
    if (len + 1 >= cap) { xhttp_set_error("response headers too large"); return -1; }
    int n = raw_recv(c, hdr + len, cap - len - 1);
    if (n < 0) return -1;
    if (n == 0) { xhttp_set_error("connection closed before headers"); return -1; }
    len += (size_t)n;
  }
}

static int parse_status_line(const char *line, int *status) {
  /* HTTP/1.1 206 Partial Content */
  if (!util_istarts_with(line, "HTTP/")) return -1;
  const char *sp = strchr(line, ' ');
  if (!sp) return -1;
  int s = atoi(sp + 1);
  if (s < 100 || s > 999) return -1;
  *status = s;
  return 0;
}

static int parse_headers(xhttp_conn *c, char *hdr, xhttp_resp *resp) {
  char *line = hdr;
  char *nl = strchr(line, '\n');
  if (!nl) return -1;
  *nl = 0;
  if (nl > line && nl[-1] == '\r') nl[-1] = 0;
  if (parse_status_line(line, &resp->status) != 0) { xhttp_set_error("bad status line"); return -1; }
  line = nl + 1;
  while (*line) {
    nl = strchr(line, '\n');
    if (!nl) break;
    *nl = 0;
    if (nl > line && nl[-1] == '\r') nl[-1] = 0;
    char *colon = strchr(line, ':');
    if (colon) {
      xhttp_resp_header(resp, line, (size_t)(colon - line), colon + 1, strlen(colon + 1));
      if (strncasecmp(line, "Transfer-Encoding", 17) == 0 && util_strcasestr(colon + 1, "chunked")) c->chunked = 1;
    }
    line = nl + 1;
  }
  return 0;
}

static int should_bypass_proxy(const char *host) {
  if (!g_proxy_port) return 1;
  if (strcmp(host, "localhost") == 0 || util_starts_with(host, "127.") || util_starts_with(host, "10.") ||
      util_starts_with(host, "192.168.") || strcmp(host, "::1") == 0 || strcmp(host, "[::1]") == 0)
    return 1;
  if (util_starts_with(host, "172.")) {
    int second = atoi(host + 4);
    if (second >= 16 && second <= 31) return 1;
  }
  /* NO_PROXY: comma-separated hosts/suffixes (CIDR entries are ignored). */
  const char *p = g_no_proxy;
  while (*p) {
    while (*p == ',' || *p == ' ') p++;
    const char *e = strchr(p, ',');
    size_t n = e ? (size_t)(e - p) : strlen(p);
    if (n && n < 200) {
      char ent[200];
      memcpy(ent, p, n);
      ent[n] = 0;
      util_trim(ent);
      const char *dom = ent[0] == '.' ? ent + 1 : ent[0] == '*' && ent[1] == '.' ? ent + 2 : ent;
      if (*dom && !strchr(dom, '/') && util_host_matches(host, dom)) return 1;
    }
    if (!e) break;
    p = e + 1;
  }
  return 0;
}

static int proxy_connect(xhttp_conn *c, const char *host, int port) {
  char req[512];
  int n = xsnprintf(req, sizeof req, "CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n\r\n", host, port, host, port);
  if (raw_send_all(c, req, (size_t)n) != 0) return -1;
  char hdr[4096];
  size_t hl;
  if (read_header_block(c, hdr, sizeof hdr, &hl) != 0) return -1;
  int status = 0;
  char *nl = strchr(hdr, '\n');
  if (nl) *nl = 0;
  if (parse_status_line(hdr, &status) != 0 || status != 200) { xhttp_set_error("proxy CONNECT refused (%d)", status); return -1; }
  free(c->buf);
  c->buf = NULL;
  c->buf_len = 0;
  return 0;
}

static int tls_handshake(xhttp_conn *c, const char *host, int insecure) {
#ifdef XENO_HAVE_OPENSSL
  c->ssl = SSL_new(insecure ? g_ctx_insecure : g_ctx);
  if (!c->ssl) { xhttp_set_error("SSL_new failed"); return -1; }
  SSL_set_fd(c->ssl, c->fd);
  SSL_set_tlsext_host_name(c->ssl, host);
  if (!insecure) {
    SSL_set_hostflags(c->ssl, X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS);
    SSL_set1_host(c->ssl, host);
  }
  for (;;) {
    int r = SSL_connect(c->ssl);
    if (r == 1) return 0;
    int e = SSL_get_error(c->ssl, r);
    if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) {
      if (wait_fd(c, c->fd, e == SSL_ERROR_WANT_READ ? POLLIN : POLLOUT, c->recv_timeout_ms) != 1) {
        xhttp_set_error("TLS handshake timeout");
        return -1;
      }
      continue;
    }
    unsigned long el = ERR_get_error();
    char eb[160] = "";
    if (el) ERR_error_string_n(el, eb, sizeof eb);
    long vr = SSL_get_verify_result(c->ssl);
    if (vr != X509_V_OK) xhttp_set_error("TLS certificate verification failed: %s", X509_verify_cert_error_string(vr));
    else xhttp_set_error("TLS handshake failed: %s", eb[0] ? eb : "unknown");
    return -1;
  }
#else
  (void)c; (void)host; (void)insecure;
  xhttp_set_error("HTTPS not supported in this build (no OpenSSL)");
  return -1;
#endif
}

static void conn_free(xhttp_conn *c) {
  if (!c) return;
#ifdef XENO_HAVE_OPENSSL
  if (c->ssl) { SSL_free(c->ssl); c->ssl = NULL; }
#endif
  if (c->fd >= 0) close(c->fd);
  free(c->buf);
  free(c);
}

/* Builds and sends the request; parses response headers into resp. */
static int do_request(xhttp_conn *c, const xhttp_req *req, const xurl *u, const char *url, int via_proxy, xhttp_resp *resp) {
  char hdr[4096];
  int n = 0;
  const char *method = req->method ? req->method : "GET";
  int dflt_port = strcmp(u->scheme, "https") == 0 ? 443 : 80;
  if (via_proxy) n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "%s %s HTTP/1.1\r\n", method, url);
  else n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "%s %s HTTP/1.1\r\n", method, u->path);
  if (u->port == dflt_port) n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "Host: %s\r\n", u->host);
  else n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "Host: %s:%d\r\n", u->host, u->port);
  n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "User-Agent: %s\r\nAccept: */*\r\nConnection: close\r\n",
                 req->user_agent ? req->user_agent : XHTTP_DEFAULT_UA);
  if (req->range_start >= 0) {
    if (req->range_end >= 0)
      n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "Range: bytes=%lld-%lld\r\n", (long long)req->range_start, (long long)req->range_end);
    else
      n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "Range: bytes=%lld-\r\n", (long long)req->range_start);
  }
  if (req->body && req->body_len) n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "Content-Length: %zu\r\n", req->body_len);
  if (req->extra_headers) n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "%s", req->extra_headers);
  if ((size_t)n + 3 >= sizeof hdr) { xhttp_set_error("request headers too large"); return -1; }
  n += xsnprintf(hdr + n, sizeof hdr - (size_t)n, "\r\n");
  if (raw_send_all(c, hdr, (size_t)n) != 0) return -1;
  if (req->body && req->body_len && raw_send_all(c, req->body, req->body_len) != 0) return -1;

  char *rh = malloc(HDR_MAX);
  if (!rh) { xhttp_set_error("out of memory"); return -1; }
  size_t hl;
  if (read_header_block(c, rh, HDR_MAX, &hl) != 0) { free(rh); return -1; }
  int rc = parse_headers(c, rh, resp);
  free(rh);
  return rc;
}

static int is_redirect(int s) { return s == 301 || s == 302 || s == 303 || s == 307 || s == 308; }

int xhttp_open(const xhttp_req *req, xhttp_conn **out, xhttp_resp *resp) {
  *out = NULL;
  xhttp_resp_reset(resp);
  xhttp_set_error("");
  if (!g_inited && xhttp_global_init() != 0) return -1;
  char url[2048];
  xstrlcpy(url, req->url, sizeof url);
  int hops = 0;
  int connect_ms = req->connect_timeout_ms > 0 ? req->connect_timeout_ms : 10000;
  int recv_ms = req->recv_timeout_ms > 0 ? req->recv_timeout_ms : 30000;
  const char *method = req->method ? req->method : "GET";
  xhttp_req cur = *req;

  for (;;) {
    xurl u;
    if (util_url_parse(url, &u) != 0) { xhttp_set_error("malformed URL"); return -1; }
    if (u.has_userinfo) { xhttp_set_error("URLs with credentials are not allowed"); return -1; }
    xhttp_conn *c = calloc(1, sizeof *c);
    if (!c) { xhttp_set_error("out of memory"); return -1; }
    c->fd = -1;
    c->cancel = req->cancel_flag;
    c->recv_timeout_ms = recv_ms;
    c->remaining = -1;
    c->head_only = strcmp(method, "HEAD") == 0;
    int https = strcmp(u.scheme, "https") == 0;
    int via_proxy = !should_bypass_proxy(u.host);
    c->fd = tcp_connect(c, via_proxy ? g_proxy_host : u.host, via_proxy ? g_proxy_port : u.port, connect_ms);
    if (c->fd < 0) { conn_free(c); return -1; }
    if (via_proxy && https && proxy_connect(c, u.host, u.port) != 0) { conn_free(c); return -1; }
    if (https && tls_handshake(c, u.host, cur.insecure_tls) != 0) { conn_free(c); return -1; }
    cur.method = method;
    xhttp_resp_reset(resp);
    if (do_request(c, &cur, &u, url, via_proxy && !https, resp) != 0) { conn_free(c); return -1; }

    if (is_redirect(resp->status) && resp->location[0] && hops < req->follow_redirects) {
      char next[2048];
      if (util_url_resolve(url, resp->location, next, sizeof next) != 0) { xhttp_set_error("bad redirect"); conn_free(c); return -1; }
      conn_free(c);
      hops++;
      xstrlcpy(url, next, sizeof url);
      if (resp->status == 303 && strcmp(method, "HEAD") != 0) { method = "GET"; cur.body = NULL; cur.body_len = 0; }
      LOGD("http: redirect %d -> %s", resp->status, url);
      continue;
    }
    /* Final URL for the caller (redirected or not). */
    xstrlcpy(resp->location, url, sizeof resp->location);
    if (c->head_only || resp->status == 204 || resp->status == 304) { c->remaining = 0; c->chunked = 0; }
    else if (!c->chunked) c->remaining = resp->content_length;
    *out = c;
    return 0;
  }
}

/* Returns buffered bytes first, then reads from the socket. */
static int fill(xhttp_conn *c, void *buf, size_t cap) {
  if (c->buf && c->buf_off < c->buf_len) {
    size_t n = c->buf_len - c->buf_off;
    if (n > cap) n = cap;
    memcpy(buf, c->buf + c->buf_off, n);
    c->buf_off += n;
    if (c->buf_off == c->buf_len) { free(c->buf); c->buf = NULL; c->buf_len = c->buf_off = 0; }
    return (int)n;
  }
  return raw_recv(c, buf, cap);
}

static int read_chunk_line(xhttp_conn *c, char *line, size_t cap) {
  size_t n = 0;
  for (;;) {
    char ch;
    int r = fill(c, &ch, 1);
    if (r < 0) return -1;
    if (r == 0) { xhttp_set_error("truncated chunked body"); return -1; }
    if (ch == '\n') break;
    if (ch != '\r' && n + 1 < cap) line[n++] = ch;
  }
  line[n] = 0;
  return 0;
}

static int read_chunked(xhttp_conn *c, void *buf, size_t cap) {
  if (c->chunk_done) return 0;
  if (c->chunk_left == 0) {
    char line[64];
    if (read_chunk_line(c, line, sizeof line) != 0) return -1;
    if (!line[0] && read_chunk_line(c, line, sizeof line) != 0) return -1;  /* CRLF after previous chunk */
    c->chunk_left = (int64_t)strtoll(line, NULL, 16);
    if (c->chunk_left <= 0) {
      c->chunk_done = 1;
      return 0;   /* trailers ignored; connection is closed afterwards */
    }
  }
  size_t want = cap < (size_t)c->chunk_left ? cap : (size_t)c->chunk_left;
  int n = fill(c, buf, want);
  if (n < 0) return -1;
  if (n == 0) { xhttp_set_error("truncated chunked body"); return -1; }
  c->chunk_left -= n;
  return n;
}

int xhttp_read(xhttp_conn *c, void *buf, size_t cap) {
  if (!c || cap == 0) return -1;
  if (c->eof) return 0;
  if (conn_cancelled(c)) { xhttp_set_error("cancelled"); return -1; }
  if (c->chunked) {
    int n = read_chunked(c, buf, cap);
    if (n == 0) c->eof = 1;
    return n;
  }
  if (c->remaining == 0) { c->eof = 1; return 0; }
  size_t want = cap;
  if (c->remaining > 0 && (int64_t)want > c->remaining) want = (size_t)c->remaining;
  int n = fill(c, buf, want);
  if (n < 0) return -1;
  if (n == 0) {
    c->eof = 1;
    if (c->remaining > 0) { xhttp_set_error("connection closed with %lld bytes missing", (long long)c->remaining); return -1; }
    return 0;
  }
  if (c->remaining > 0) c->remaining -= n;
  return n;
}

void xhttp_abort(xhttp_conn *c) {
  if (!c) return;
  c->aborted = 1;
  if (c->fd >= 0) shutdown(c->fd, SHUT_RDWR);
}

void xhttp_close(xhttp_conn *c) { conn_free(c); }
