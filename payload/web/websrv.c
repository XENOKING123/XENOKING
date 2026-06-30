/* XENO TOOL Web — on-console web server ELF (xeno-web.elf).
 *
 * Inject this single ELF on a jailbroken PS5. On launch it pops a toast
 * with its URL (http://<console-ip>:6969) and serves the FULL XENO TOOL
 * React UI — embedded in this binary (see web_assets.c, generated from
 * client/dist by gen_web_assets.py). Open that URL from any browser on
 * your network — phone, tablet, PC — no install.
 *
 * Design notes:
 *  - Pure BSD sockets (libc), NOT Sony's libSceNet. The main payload
 *    deliberately avoids compile-time libSceNet linkage (it bricked some
 *    firmwares); BSD socket(2)/bind/listen/accept work directly.
 *  - HTTP/1.1, Connection: close, one request per connection. Tiny,
 *    dependency-free request parser — enough to serve static assets and
 *    a small JSON API. Not a general-purpose server.
 *  - Assets are stored gzip-compressed and served with
 *    `Content-Encoding: gzip`, so the browser inflates them and the ELF
 *    stays ~3 MB instead of ~10 MB.
 *  - The JSON API (the /api routes) starts minimal (version/ping/
 *    netinfo) and grows; the React bridge
 *    (client/src/lib/webBridge.ts) calls these same paths.
 */
#include <sys/types.h>
#include <sys/socket.h>
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
#include <dlfcn.h>
#include <errno.h>

#include "web_assets.h"

#define WEB_PORT 6969
#define REQ_MAX  8192

/* ── PS5 toast notification ──────────────────────────────────────────────
 * Same dlsym pattern the main payload uses: resolve
 * sceKernelSendNotificationRequest at runtime so a firmware that doesn't
 * export it degrades to a no-op instead of refusing to load the ELF. */
typedef struct ps5_notify_req {
    char _reserved[45];
    char message[3075];
} ps5_notify_req_t;
typedef int (*sce_send_notification_fn)(int, ps5_notify_req_t *, size_t, int);

static void pop_notification(const char *message) {
    if (!message || !*message) return;
    static sce_send_notification_fn p_send = NULL;
    static int resolved = 0;
    if (!resolved) {
        resolved = 1;
        p_send = (sce_send_notification_fn)
            dlsym(RTLD_DEFAULT, "sceKernelSendNotificationRequest");
    }
    if (!p_send) return;
    ps5_notify_req_t req;
    memset(&req, 0, sizeof(req));
    strncpy(req.message, message, sizeof(req.message) - 1);
    (void)p_send(0, &req, sizeof(req), 0);
}

/* ── Local LAN IPv4 discovery ────────────────────────────────────────────
 * Walk interfaces and return the first non-loopback IPv4 (e.g. the PS5's
 * WiFi/ethernet address) into `out`. Falls back to "0.0.0.0" so the toast
 * still shows the port even if discovery fails. */
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

/* ── Small write helpers ─────────────────────────────────────────────── */

static int write_all(int fd, const void *buf, size_t len) {
    const char *p = (const char *)buf;
    size_t left = len;
    while (left > 0) {
        ssize_t n = write(fd, p, left);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;
        p += n;
        left -= (size_t)n;
    }
    return 0;
}

/* Send a complete response: status line, headers, optional gzip flag,
 * then the body. */
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
    send_response(fd, status, ctype, 0,
                  (const unsigned char *)body, strlen(body));
}

/* ── Static asset lookup (SPA) ───────────────────────────────────────── */

static const web_asset_t *find_asset(const char *path) {
    /* Normalize "/" → "/index.html". */
    const char *want = (strcmp(path, "/") == 0) ? "/index.html" : path;
    for (int i = 0; i < WEB_ASSETS_COUNT; i++) {
        if (strcmp(WEB_ASSETS[i].path, want) == 0) return &WEB_ASSETS[i];
    }
    return NULL;
}

static const web_asset_t *index_asset(void) {
    for (int i = 0; i < WEB_ASSETS_COUNT; i++) {
        if (strcmp(WEB_ASSETS[i].path, "/index.html") == 0)
            return &WEB_ASSETS[i];
    }
    return NULL;
}

/* ── JSON API ────────────────────────────────────────────────────────────
 * Phase 1: enough to prove the round-trip from the browser to the
 * console. More PS5 operations (hardware, processes, file browser) get
 * wired here next. */
static int handle_api(int fd, const char *path) {
    if (strcmp(path, "/api/version") == 0) {
        send_text(fd, "200 OK", "application/json; charset=utf-8",
                  "{\"app\":\"XENO TOOL Web\",\"version\":\"" XENO_WEB_VERSION
                  "\",\"host\":\"ps5\",\"caps\":{}}");
        return 1;
    }
    if (strcmp(path, "/api/ping") == 0) {
        send_text(fd, "200 OK", "application/json; charset=utf-8",
                  "{\"ok\":true}");
        return 1;
    }
    if (strcmp(path, "/api/netinfo") == 0) {
        char ip[64];
        local_ipv4(ip, sizeof(ip));
        char body[160];
        snprintf(body, sizeof(body),
                 "{\"ip\":\"%s\",\"port\":%d}", ip, WEB_PORT);
        send_text(fd, "200 OK", "application/json; charset=utf-8", body);
        return 1;
    }
    return 0; /* not an implemented API route */
}

/* ── Per-connection handler ──────────────────────────────────────────── */

static void handle_client(int fd) {
    char req[REQ_MAX];
    ssize_t got = read(fd, req, sizeof(req) - 1);
    if (got <= 0) return;
    req[got] = '\0';

    /* Parse: "GET /path HTTP/1.1". We only need method + path. */
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
    /* Strip query string. */
    char *q = strchr(path, '?');
    if (q) *q = '\0';

    if (strncmp(path, "/api/", 5) == 0) {
        if (handle_api(fd, path)) return;
        send_text(fd, "404 Not Found", "application/json; charset=utf-8",
                  "{\"error\":\"not implemented in web ELF yet\"}");
        return;
    }

    /* Static asset, with SPA fallback to index.html for client routes. */
    const web_asset_t *a = find_asset(path);
    if (!a) a = index_asset();
    if (!a) { send_text(fd, "404 Not Found", "text/plain", "no ui"); return; }
    send_response(fd, "200 OK", a->ctype, 1, a->gz, a->gz_len);
}

/* Thread trampoline — one detached thread per connection. */
static void *client_thread(void *arg) {
    int fd = (int)(intptr_t)arg;
    handle_client(fd);
    close(fd);
    return NULL;
}

/* ── Server bootstrap ────────────────────────────────────────────────── */

static int serve(void) {
    int srv = socket(AF_INET, SOCK_STREAM, 0);
    if (srv < 0) return -1;
    int one = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(WEB_PORT);
    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(srv);
        return -1;
    }
    if (listen(srv, 64) != 0) {
        close(srv);
        return -1;
    }

    for (;;) {
        int c = accept(srv, NULL, NULL);
        if (c < 0) {
            if (errno == EINTR) continue;
            break;
        }
        int one2 = 1;
        setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one2, sizeof(one2));
        pthread_t t;
        if (pthread_create(&t, NULL, client_thread, (void *)(intptr_t)c) == 0) {
            pthread_detach(t);
        } else {
            handle_client(c);
            close(c);
        }
    }
    close(srv);
    return 0;
}

int main(void) {
    char ip[64];
    local_ipv4(ip, sizeof(ip));

    char toast[256];
    snprintf(toast, sizeof(toast),
             "XENO TOOL Web is running.\nOpen http://%s:%d in any browser.",
             ip, WEB_PORT);
    pop_notification(toast);

    /* Blocks forever serving requests. If bind fails (port taken by a
     * prior instance), tell the user via a toast and exit cleanly. */
    if (serve() != 0) {
        pop_notification("XENO TOOL Web: port 6969 busy "
                         "(another instance running?). Reboot to clear.");
        return 1;
    }
    return 0;
}
