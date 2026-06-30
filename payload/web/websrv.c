/* XENO-AIO — on-console web server (linked into the full payload).
 *
 * XENO-AIO.elf bundles the entire PS5 payload runtime AND this web
 * server in one process. Inject the single ELF on a jailbroken PS5: it
 * runs the normal FTX2 servers (so the desktop app can still connect)
 * AND pops a toast with a URL (http://<console-ip>:6969) serving the
 * FULL XENO TOOL React UI — embedded in the binary (web_assets.c,
 * generated from client/dist). Open it from any browser — phone,
 * tablet, PC — no install, and it AUTO-CONNECTS to this console.
 *
 * The JSON API forwards to the runtime's own management server on
 * localhost (127.0.0.1:9114) using the same FTX2 frames the desktop
 * engine uses, so each screen gets REAL console data without
 * reimplementing a single operation. `/api/version` etc. are answered
 * natively; data routes proxy a frame and return the response body.
 *
 * Design notes:
 *  - Pure BSD sockets (libc), NOT Sony's libSceNet (compile-time
 *    libSceNet linkage bricked some firmwares; the runtime already
 *    proves raw socket(2)/bind/listen/accept work).
 *  - HTTP/1.1, Connection: close, one request per connection. Tiny,
 *    dependency-free parser — serves static assets + a JSON API.
 *  - Assets are gzip-compressed, served with `Content-Encoding: gzip`.
 *  - All helpers are `static` (file-local) so nothing collides with the
 *    runtime's symbols when linked together. The only exported symbol is
 *    websrv_start().
 */
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <pthread.h>
#include <unistd.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <errno.h>

#include "config.h"      /* PS5UPLOAD2_MGMT_PORT, PS5UPLOAD2_VERSION */
#include "runtime.h"     /* pop_notification() */
#include "websrv.h"
#include "web_assets.h"

#define WEB_PORT 6969
#define REQ_MAX  8192

/* FTX2 wire constants — mirror payload/src/runtime.c. Kept local so this
 * file needs no extra header; these are stable protocol values. */
#define WEB_FTX2_MAGIC          0x32585446u
#define WEB_FTX2_VERSION        1u
#define WEB_FTX2_HDR_LEN        28u
#define WEB_FRAME_PROC_LIST     74u

/* ── Little-endian read/write ────────────────────────────────────────── */

static void w_le16(unsigned char *p, uint16_t v) { p[0] = (unsigned char)v; p[1] = (unsigned char)(v >> 8); }
static void w_le32(unsigned char *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (unsigned char)(v >> (8 * i)); }
static void w_le64(unsigned char *p, uint64_t v) { for (int i = 0; i < 8; i++) p[i] = (unsigned char)(v >> (8 * i)); }
static uint32_t r_le32(const unsigned char *p) { uint32_t v = 0; for (int i = 0; i < 4; i++) v |= (uint32_t)p[i] << (8 * i); return v; }
static uint64_t r_le64(const unsigned char *p) { uint64_t v = 0; for (int i = 0; i < 8; i++) v |= (uint64_t)p[i] << (8 * i); return v; }

/* ── Socket I/O helpers ──────────────────────────────────────────────── */

static int write_all(int fd, const void *buf, size_t len) {
    const char *p = (const char *)buf;
    size_t left = len;
    while (left > 0) {
        ssize_t n = write(fd, p, left);
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        if (n == 0) return -1;
        p += n;
        left -= (size_t)n;
    }
    return 0;
}

static int read_full(int fd, void *buf, size_t len) {
    char *p = (char *)buf;
    size_t left = len;
    while (left > 0) {
        ssize_t n = read(fd, p, left);
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        if (n == 0) return -1;
        p += n;
        left -= (size_t)n;
    }
    return 0;
}

/* ── FTX2 proxy to the in-process management server ──────────────────────
 * Connect to 127.0.0.1:9114 (the runtime's mgmt listener, running in the
 * same process), send one frame, read the response frame, and hand back
 * its body. Caller frees *out. Returns 0 on success. A 1.5s recv timeout
 * keeps a wedged op from hanging the web worker. */
static int web_ftx2_call(uint16_t frame_type, const void *body,
                         uint32_t body_len, char **out, uint32_t *out_len) {
    *out = NULL;
    *out_len = 0;

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct timeval tv = { 2, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons(PS5UPLOAD2_MGMT_PORT);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&a, sizeof(a)) != 0) { close(fd); return -1; }

    unsigned char hdr[WEB_FTX2_HDR_LEN];
    memset(hdr, 0, sizeof(hdr));
    w_le32(hdr + 0, WEB_FTX2_MAGIC);
    w_le16(hdr + 4, WEB_FTX2_VERSION);
    w_le16(hdr + 6, frame_type);
    w_le32(hdr + 8, 0);
    w_le64(hdr + 12, body_len);
    w_le64(hdr + 20, 1);
    if (write_all(fd, hdr, sizeof(hdr)) != 0) { close(fd); return -1; }
    if (body_len > 0 && body && write_all(fd, body, body_len) != 0) { close(fd); return -1; }

    unsigned char rh[WEB_FTX2_HDR_LEN];
    if (read_full(fd, rh, sizeof(rh)) != 0) { close(fd); return -1; }
    if (r_le32(rh + 0) != WEB_FTX2_MAGIC) { close(fd); return -1; }
    uint64_t rlen = r_le64(rh + 12);
    if (rlen > (1u << 20)) rlen = 1u << 20; /* cap 1 MiB */
    char *buf = (char *)malloc((size_t)rlen + 1);
    if (!buf) { close(fd); return -1; }
    if (rlen > 0 && read_full(fd, buf, (size_t)rlen) != 0) { free(buf); close(fd); return -1; }
    buf[rlen] = '\0';
    close(fd);

    *out = buf;
    *out_len = (uint32_t)rlen;
    return 0;
}

/* ── Local LAN IPv4 discovery (for the toast + /api/netinfo) ──────────── */

static void local_ipv4(char *out, size_t out_len) {
    snprintf(out, out_len, "0.0.0.0");
    struct ifaddrs *ifa = NULL;
    if (getifaddrs(&ifa) != 0 || !ifa) return;
    for (struct ifaddrs *p = ifa; p; p = p->ifa_next) {
        if (!p->ifa_addr || p->ifa_addr->sa_family != AF_INET) continue;
        if (p->ifa_flags & IFF_LOOPBACK) continue;
        struct sockaddr_in *sin = (struct sockaddr_in *)(void *)p->ifa_addr;
        char buf[INET_ADDRSTRLEN];
        if (inet_ntop(AF_INET, &sin->sin_addr, buf, sizeof(buf)) &&
            strcmp(buf, "0.0.0.0") != 0) {
            snprintf(out, out_len, "%s", buf);
            break;
        }
    }
    freeifaddrs(ifa);
}

/* ── HTTP response helpers ───────────────────────────────────────────── */

static void send_response(int fd, const char *status, const char *ctype,
                          int gzipped, const unsigned char *body,
                          size_t body_len) {
    char hdr[512];
    int n = snprintf(hdr, sizeof(hdr),
                     "HTTP/1.1 %s\r\n"
                     "Content-Type: %s\r\n"
                     "Content-Length: %zu\r\n"
                     "%s"
                     "Access-Control-Allow-Origin: *\r\n"
                     "Connection: close\r\n"
                     "\r\n",
                     status, ctype, body_len,
                     gzipped ? "Content-Encoding: gzip\r\n" : "");
    if (n <= 0) return;
    if (write_all(fd, hdr, (size_t)n) != 0) return;
    if (body && body_len) (void)write_all(fd, body, body_len);
}

static void send_text(int fd, const char *status, const char *ctype,
                      const char *body) {
    send_response(fd, status, ctype, 0, (const unsigned char *)body, strlen(body));
}

/* ── Static asset lookup (SPA) ───────────────────────────────────────── */

static const web_asset_t *find_asset(const char *path) {
    const char *want = (strcmp(path, "/") == 0) ? "/index.html" : path;
    for (int i = 0; i < WEB_ASSETS_COUNT; i++)
        if (strcmp(WEB_ASSETS[i].path, want) == 0) return &WEB_ASSETS[i];
    return NULL;
}

static const web_asset_t *index_asset(void) {
    for (int i = 0; i < WEB_ASSETS_COUNT; i++)
        if (strcmp(WEB_ASSETS[i].path, "/index.html") == 0) return &WEB_ASSETS[i];
    return NULL;
}

/* ── JSON API ────────────────────────────────────────────────────────── */

static int handle_api(int fd, const char *path) {
    if (strcmp(path, "/api/version") == 0) {
        send_text(fd, "200 OK", "application/json; charset=utf-8",
                  "{\"app\":\"XENO-AIO\",\"version\":\"" PS5UPLOAD2_VERSION
                  "\",\"host\":\"ps5\",\"caps\":{}}");
        return 1;
    }
    if (strcmp(path, "/api/ping") == 0) {
        send_text(fd, "200 OK", "application/json; charset=utf-8", "{\"ok\":true}");
        return 1;
    }
    if (strcmp(path, "/api/netinfo") == 0) {
        /* on_console:true → the React app auto-connects to this console. */
        char ip[64];
        local_ipv4(ip, sizeof(ip));
        char body[224];
        snprintf(body, sizeof(body),
                 "{\"ip\":\"%s\",\"port\":%d,\"on_console\":true,"
                 "\"version\":\"" PS5UPLOAD2_VERSION "\"}", ip, WEB_PORT);
        send_text(fd, "200 OK", "application/json; charset=utf-8", body);
        return 1;
    }
    /* Real console data: proxy the matching FTX2 frame to the in-process
     * mgmt server and return its JSON body verbatim (proc_list already
     * emits the {ok,procs[{pid,name}]} shape the UI expects). */
    if (strcmp(path, "/api/ps5/proc/list") == 0) {
        char *body = NULL;
        uint32_t blen = 0;
        if (web_ftx2_call(WEB_FRAME_PROC_LIST, NULL, 0, &body, &blen) == 0 && body) {
            send_response(fd, "200 OK", "application/json; charset=utf-8",
                          0, (const unsigned char *)body, blen);
            free(body);
            return 1;
        }
        if (body) free(body);
        send_text(fd, "503 Service Unavailable",
                  "application/json; charset=utf-8",
                  "{\"ok\":false,\"error\":\"mgmt server not reachable\"}");
        return 1;
    }
    return 0;
}

/* ── Per-connection handler ──────────────────────────────────────────── */

static void handle_client(int fd) {
    char req[REQ_MAX];
    ssize_t got = read(fd, req, sizeof(req) - 1);
    if (got <= 0) return;
    req[got] = '\0';

    if (strncmp(req, "GET ", 4) != 0 && strncmp(req, "HEAD ", 5) != 0) {
        send_text(fd, "405 Method Not Allowed", "text/plain", "method");
        return;
    }
    char *sp = strchr(req, ' ');
    if (!sp) { send_text(fd, "400 Bad Request", "text/plain", "bad"); return; }
    char *path = sp + 1;
    char *sp2 = strchr(path, ' ');
    if (!sp2) { send_text(fd, "400 Bad Request", "text/plain", "bad"); return; }
    *sp2 = '\0';
    char *q = strchr(path, '?');
    if (q) *q = '\0';

    if (strncmp(path, "/api/", 5) == 0) {
        if (handle_api(fd, path)) return;
        send_text(fd, "404 Not Found", "application/json; charset=utf-8",
                  "{\"error\":\"not wired in web yet\"}");
        return;
    }

    const web_asset_t *a = find_asset(path);
    if (!a) a = index_asset();
    if (!a) { send_text(fd, "404 Not Found", "text/plain", "no ui"); return; }
    send_response(fd, "200 OK", a->ctype, 1, a->gz, a->gz_len);
}

static void *client_thread(void *arg) {
    int fd = (int)(intptr_t)arg;
    handle_client(fd);
    close(fd);
    return NULL;
}

/* ── Accept loop ─────────────────────────────────────────────────────── */

static void *accept_loop(void *unused) {
    (void)unused;
    int srv = socket(AF_INET, SOCK_STREAM, 0);
    if (srv < 0) return NULL;
    int one = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(WEB_PORT);
    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) != 0) { close(srv); return NULL; }
    if (listen(srv, 64) != 0) { close(srv); return NULL; }

    for (;;) {
        int c = accept(srv, NULL, NULL);
        if (c < 0) { if (errno == EINTR) continue; break; }
        int one2 = 1;
        setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one2, sizeof(one2));
        pthread_t t;
        if (pthread_create(&t, NULL, client_thread, (void *)(intptr_t)c) == 0)
            pthread_detach(t);
        else { handle_client(c); close(c); }
    }
    close(srv);
    return NULL;
}

/* ── Public entry point ──────────────────────────────────────────────────
 * Called from the payload's main() after the mgmt server is up. Pops the
 * URL toast and spawns the web server on its own detached thread so the
 * runtime's transfer loop keeps running. */
void websrv_start(void) {
    char ip[64];
    local_ipv4(ip, sizeof(ip));
    char toast[256];
    snprintf(toast, sizeof(toast),
             "XENO-AIO Web is live.\nOpen http://%s:%d in any browser.",
             ip, WEB_PORT);
    pop_notification(toast);

    pthread_t t;
    if (pthread_create(&t, NULL, accept_loop, NULL) == 0)
        pthread_detach(t);
}
