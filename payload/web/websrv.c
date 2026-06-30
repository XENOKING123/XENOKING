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

/* ── HTTP client → CheatRunner on localhost:9999 ─────────────────────────
 * CheatRunner is a separate on-console HTTP daemon (port 9999). The
 * desktop app applies cheats with `GET /api/cheats/...`; on-console we
 * forward the same request to 127.0.0.1:9999 and return its body (the
 * HTTP headers stripped). Caller frees *out. */
static int web_http_get(int port, const char *path, char **out, uint32_t *out_len) {
    *out = NULL;
    *out_len = 0;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct timeval tv = { 4, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons((uint16_t)port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&a, sizeof(a)) != 0) { close(fd); return -1; }

    char req[2300];
    int n = snprintf(req, sizeof(req),
                     "GET %s HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                     "Connection: close\r\n\r\n", path);
    if (n <= 0 || write_all(fd, req, (size_t)n) != 0) { close(fd); return -1; }

    size_t cap = 64 * 1024, len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) { close(fd); return -1; }
    for (;;) {
        if (len + 4096 + 1 > cap) {
            cap *= 2;
            char *nb = (char *)realloc(buf, cap);
            if (!nb) { free(buf); close(fd); return -1; }
            buf = nb;
        }
        ssize_t r = read(fd, buf + len, 4096);
        if (r <= 0) break;
        len += (size_t)r;
        if (len > (1u << 20)) break;
    }
    close(fd);
    buf[len] = '\0';
    /* Strip HTTP headers — body starts after the first blank line. */
    char *body = strstr(buf, "\r\n\r\n");
    if (body) {
        body += 4;
        size_t blen = len - (size_t)(body - buf);
        memmove(buf, body, blen);
        buf[blen] = '\0';
        *out = buf;
        *out_len = (uint32_t)blen;
    } else {
        *out = buf;
        *out_len = (uint32_t)len;
    }
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

/* ── Query-string + JSON helpers ─────────────────────────────────────── */

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void url_decode(const char *src, char *dst, size_t dstlen) {
    size_t di = 0;
    for (size_t si = 0; src[si] && di + 1 < dstlen; si++) {
        if (src[si] == '%' && src[si + 1] && src[si + 2]) {
            int hi = hexval(src[si + 1]), lo = hexval(src[si + 2]);
            if (hi >= 0 && lo >= 0) { dst[di++] = (char)((hi << 4) | lo); si += 2; continue; }
        }
        if (src[si] == '+') { dst[di++] = ' '; continue; }
        dst[di++] = src[si];
    }
    dst[di] = '\0';
}

/* Extract one `key=value` from a `&`-joined query string, URL-decoded. */
static void query_param(const char *query, const char *key, char *out, size_t outlen) {
    out[0] = '\0';
    if (!query) return;
    size_t klen = strlen(key);
    const char *p = query;
    while (p && *p) {
        const char *amp = strchr(p, '&');
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') {
            const char *vs = p + klen + 1;
            const char *ve = amp ? amp : vs + strlen(vs);
            char raw[1024];
            size_t n = 0;
            for (const char *c = vs; c < ve && n + 1 < sizeof(raw); c++) raw[n++] = *c;
            raw[n] = '\0';
            url_decode(raw, out, outlen);
            return;
        }
        if (!amp) break;
        p = amp + 1;
    }
}

/* Minimal JSON string-escape (quotes, backslash, control chars). */
static void json_escape(const char *src, char *dst, size_t dstlen) {
    size_t di = 0;
    for (size_t si = 0; src[si] && di + 2 < dstlen; si++) {
        unsigned char c = (unsigned char)src[si];
        if (c == '"' || c == '\\') { dst[di++] = '\\'; dst[di++] = (char)c; }
        else if (c == '\n') { dst[di++] = '\\'; dst[di++] = 'n'; }
        else if (c >= 0x20) { dst[di++] = (char)c; }
    }
    dst[di] = '\0';
}

static int all_digits(const char *s, size_t len) {
    if (len == 0) return 0;
    for (size_t i = 0; i < len; i++)
        if (s[i] < '0' || s[i] > '9') return 0;
    return 1;
}

/* Convert the payload's `key=value\n` hardware text into a JSON object.
 * Numeric values (all-digit) become JSON numbers so the UI's byte/temp
 * math works; everything else is a JSON string. Matches the shape the
 * engine produces, so the React HwInfo/HwTemps/etc. types parse cleanly. */
static void kv_text_to_json(const char *text, char *out, size_t outcap) {
    size_t di = 0;
    if (di + 1 < outcap) out[di++] = '{';
    int first = 1;
    const char *p = text;
    while (p && *p) {
        const char *nl = strchr(p, '\n');
        const char *line_end = nl ? nl : p + strlen(p);
        const char *eq = NULL;
        for (const char *c = p; c < line_end; c++) { if (*c == '=') { eq = c; break; } }
        if (eq && eq > p) {
            size_t klen = (size_t)(eq - p);
            const char *vs = eq + 1;
            size_t vlen = (size_t)(line_end - vs);
            if (!first && di + 1 < outcap) out[di++] = ',';
            first = 0;
            if (di + 1 < outcap) out[di++] = '"';
            for (size_t i = 0; i < klen && di + 1 < outcap; i++) out[di++] = p[i];
            if (di + 2 < outcap) { out[di++] = '"'; out[di++] = ':'; }
            if (all_digits(vs, vlen)) {
                for (size_t i = 0; i < vlen && di + 1 < outcap; i++) out[di++] = vs[i];
            } else {
                if (di + 1 < outcap) out[di++] = '"';
                for (size_t i = 0; i < vlen && di + 2 < outcap; i++) {
                    unsigned char c = (unsigned char)vs[i];
                    if (c == '"' || c == '\\') { out[di++] = '\\'; out[di++] = (char)c; }
                    else if (c >= 0x20) out[di++] = (char)c;
                }
                if (di + 1 < outcap) out[di++] = '"';
            }
        }
        if (!nl) break;
        p = nl + 1;
    }
    if (di + 1 < outcap) out[di++] = '}';
    out[di] = '\0';
}

/* ── JSON API ────────────────────────────────────────────────────────────
 * Native endpoints (version/ping/netinfo) answer locally. Everything else
 * is a table-driven proxy: forward the mapped FTX2 frame to the in-process
 * mgmt server and return its JSON body verbatim. `qparam` (when set) is
 * pulled from the URL query, JSON-escaped, and sent as `{"<qparam>":..}`
 * in the request body (e.g. list-dir's path). */
typedef struct {
    const char *path;    /* URL path (matched exactly) */
    uint16_t    frame;   /* FTX2 frame type to forward */
    const char *qparam;  /* query key → request body field, or NULL for none */
    int         xform;   /* 0 = pass JSON through; 1 = key=value text → JSON */
} web_proxy_route_t;

static const web_proxy_route_t WEB_PROXY_ROUTES[] = {
    { "/api/ps5/proc/list",       74u,  NULL,   0 }, /* PROC_LIST */
    { "/api/ps5/profile/info",    150u, NULL,   0 }, /* PROFILE_INFO */
    { "/api/ps5/volumes",         34u,  NULL,   0 }, /* FS_LIST_VOLUMES */
    { "/api/ps5/apps/installed",  62u,  NULL,   0 }, /* APP_LIST_REGISTERED */
    { "/api/ps5/list-saves",      92u,  NULL,   0 }, /* LIST_SAVES */
    { "/api/ps5/users",           90u,  NULL,   0 }, /* USER_LIST */
    { "/api/ps5/syslog/tail",     144u, NULL,   0 }, /* SYSLOG_TAIL */
    { "/api/ps5/power/telemetry", 88u,  NULL,   0 }, /* POWER_TELEMETRY */
    { "/api/ps5/list-screenshots",94u,  NULL,   0 }, /* LIST_SCREENSHOTS */
    { "/api/ps5/list-dir",        36u,  "path", 0 }, /* FS_LIST_DIR (needs path) */
    /* Hardware: payload returns key=value text → convert to JSON. */
    { "/api/ps5/hw/info",         64u,  NULL,   1 }, /* HW_INFO */
    { "/api/ps5/hw/temps",        66u,  NULL,   1 }, /* HW_TEMPS */
    { "/api/ps5/hw/power",        68u,  NULL,   1 }, /* HW_POWER */
    { "/api/ps5/hw/storage",      80u,  NULL,   1 }, /* HW_STORAGE */
};

static int proxy_route(int fd, const web_proxy_route_t *r, const char *query) {
    char body[1200];
    const char *reqbody = NULL;
    uint32_t reqlen = 0;
    if (r->qparam) {
        char val[1024];
        query_param(query, r->qparam, val, sizeof(val));
        char esc[1024];
        json_escape(val, esc, sizeof(esc));
        snprintf(body, sizeof(body), "{\"%s\":\"%s\"}", r->qparam, esc);
        reqbody = body;
        reqlen = (uint32_t)strlen(body);
    }
    char *out = NULL;
    uint32_t outlen = 0;
    if (web_ftx2_call(r->frame, reqbody, reqlen, &out, &outlen) == 0 && out) {
        if (r->xform == 1) {
            size_t cap = (size_t)outlen * 2 + 256;
            char *json = (char *)malloc(cap);
            if (json) {
                kv_text_to_json(out, json, cap);
                send_response(fd, "200 OK", "application/json; charset=utf-8",
                              0, (const unsigned char *)json, strlen(json));
                free(json);
                free(out);
                return 1;
            }
        }
        send_response(fd, "200 OK", "application/json; charset=utf-8",
                      0, (const unsigned char *)out, outlen);
        free(out);
        return 1;
    }
    if (out) free(out);
    send_text(fd, "503 Service Unavailable", "application/json; charset=utf-8",
              "{\"ok\":false,\"error\":\"mgmt server not reachable\"}");
    return 1;
}

/* POST routes: forward the request body verbatim as the FTX2 frame body.
 * The profile-write handlers parse the same JSON the desktop sends
 * (extra fields like `addr` are ignored), so no reshaping is needed. */
typedef struct {
    const char *path;
    uint16_t    frame;
} web_post_route_t;

static const web_post_route_t WEB_POST_ROUTES[] = {
    { "/api/ps5/profile/set-username", 152u }, /* PROFILE_SET_USERNAME {slot,name} */
    { "/api/ps5/profile/rename-user",  160u }, /* PROFILE_SET_LOCAL_USERNAME {uid,name} */
    { "/api/ps5/profile/activate",     154u }, /* PROFILE_ACTIVATE {slot,id?} */
    { "/api/ps5/profile/clear-slot",   158u }, /* PROFILE_CLEAR_SLOT {slot} */
};

static int post_route(int fd, const web_post_route_t *r, const char *body, uint32_t blen) {
    char *out = NULL;
    uint32_t outlen = 0;
    if (web_ftx2_call(r->frame, body, blen, &out, &outlen) == 0 && out) {
        send_response(fd, "200 OK", "application/json; charset=utf-8",
                      0, (const unsigned char *)out, outlen);
        free(out);
        return 1;
    }
    if (out) free(out);
    send_text(fd, "503 Service Unavailable", "application/json; charset=utf-8",
              "{\"ok\":false,\"error\":\"mgmt server not reachable\"}");
    return 1;
}

static int handle_api(int fd, const char *method, const char *path,
                      const char *query, const char *body, uint32_t blen) {
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
        char nb[224];
        snprintf(nb, sizeof(nb),
                 "{\"ip\":\"%s\",\"port\":%d,\"on_console\":true,"
                 "\"version\":\"" PS5UPLOAD2_VERSION "\"}", ip, WEB_PORT);
        send_text(fd, "200 OK", "application/json; charset=utf-8", nb);
        return 1;
    }
    /* Cheats: forward to CheatRunner's own HTTP daemon on localhost:9999.
     * `path` query param is the CheatRunner path (e.g.
     * /api/cheats/toggle?titleId=..&index=..&on=1). */
    if (strcmp(path, "/api/cr/get") == 0) {
        char cr_path[1600];
        query_param(query, "path", cr_path, sizeof(cr_path));
        if (cr_path[0] == '\0') snprintf(cr_path, sizeof(cr_path), "/");
        char *out = NULL;
        uint32_t outlen = 0;
        if (web_http_get(9999, cr_path, &out, &outlen) == 0 && out) {
            send_response(fd, "200 OK", "application/json; charset=utf-8",
                          0, (const unsigned char *)out, outlen);
            free(out);
            return 1;
        }
        if (out) free(out);
        send_text(fd, "503 Service Unavailable", "application/json; charset=utf-8",
                  "{\"error\":\"CheatRunner (port 9999) not reachable — load it first\"}");
        return 1;
    }
    /* Cheat game icon — proxy the image bytes from CheatRunner's
     * /appdb/icon?id=<title>. Served as PNG (CheatRunner's icon format). */
    if (strcmp(path, "/api/cr/icon") == 0) {
        char id[256];
        query_param(query, "id", id, sizeof(id));
        char cr_path[320];
        snprintf(cr_path, sizeof(cr_path), "/appdb/icon?id=%s", id);
        char *out = NULL;
        uint32_t outlen = 0;
        if (web_http_get(9999, cr_path, &out, &outlen) == 0 && out && outlen > 0) {
            send_response(fd, "200 OK", "image/png", 0,
                          (const unsigned char *)out, outlen);
            free(out);
            return 1;
        }
        if (out) free(out);
        send_text(fd, "404 Not Found", "text/plain", "no icon");
        return 1;
    }
    if (strcmp(method, "POST") == 0) {
        for (size_t i = 0; i < sizeof(WEB_POST_ROUTES) / sizeof(WEB_POST_ROUTES[0]); i++)
            if (strcmp(path, WEB_POST_ROUTES[i].path) == 0)
                return post_route(fd, &WEB_POST_ROUTES[i], body, blen);
    }
    for (size_t i = 0; i < sizeof(WEB_PROXY_ROUTES) / sizeof(WEB_PROXY_ROUTES[0]); i++) {
        if (strcmp(path, WEB_PROXY_ROUTES[i].path) == 0)
            return proxy_route(fd, &WEB_PROXY_ROUTES[i], query);
    }
    return 0;
}

/* ── Payload send: POST raw ELF bytes → forward to the loader (:9021) ─────
 * The browser downloads a payload from GitHub (or the user picks a file)
 * and POSTs the bytes here; we stream them to the on-console payload
 * loader on 127.0.0.1:9021, which runs it — exactly like the desktop app
 * sending to the PS5's loader. Body can be MiB-sized, so we read the full
 * Content-Length (the first read already holds the headers + a head
 * chunk). */
#define PS5_LOADER_PORT 9021
#define PAYLOAD_MAX (16 * 1024 * 1024)

static long parse_content_length(const char *req) {
    const char *p = strstr(req, "Content-Length:");
    if (!p) p = strstr(req, "content-length:");
    if (!p) return -1;
    p += 15;
    while (*p == ' ') p++;
    return atol(p);
}

static void handle_payload_send(int fd, char *req, ssize_t got) {
    long clen = parse_content_length(req);
    char *hdr_end = strstr(req, "\r\n\r\n");
    if (!hdr_end || clen <= 0 || clen > PAYLOAD_MAX) {
        send_text(fd, "400 Bad Request", "application/json; charset=utf-8",
                  "{\"ok\":false,\"error\":\"missing/oversized payload body\"}");
        return;
    }
    char *body_start = hdr_end + 4;
    size_t have = (size_t)((req + got) - body_start);
    char *buf = (char *)malloc((size_t)clen);
    if (!buf) {
        send_text(fd, "500 Internal Server Error", "application/json; charset=utf-8",
                  "{\"ok\":false,\"error\":\"out of memory\"}");
        return;
    }
    if (have > (size_t)clen) have = (size_t)clen;
    memcpy(buf, body_start, have);
    size_t total = have;
    while (total < (size_t)clen) {
        ssize_t r = read(fd, buf + total, (size_t)clen - total);
        if (r <= 0) break;
        total += (size_t)r;
    }
    if (total != (size_t)clen) {
        free(buf);
        send_text(fd, "400 Bad Request", "application/json; charset=utf-8",
                  "{\"ok\":false,\"error\":\"short read on payload body\"}");
        return;
    }

    int lf = socket(AF_INET, SOCK_STREAM, 0);
    if (lf < 0) {
        free(buf);
        send_text(fd, "503 Service Unavailable", "application/json; charset=utf-8",
                  "{\"ok\":false,\"error\":\"socket failed\"}");
        return;
    }
    struct timeval tv = { 5, 0 };
    setsockopt(lf, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons(PS5_LOADER_PORT);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(lf, (struct sockaddr *)&a, sizeof(a)) != 0) {
        close(lf);
        free(buf);
        send_text(fd, "503 Service Unavailable", "application/json; charset=utf-8",
                  "{\"ok\":false,\"error\":\"loader (port 9021) not reachable\"}");
        return;
    }
    int ok = (write_all(lf, buf, total) == 0);
    /* Closing our end signals EOF; the loader reads to EOF then runs it. */
    close(lf);
    free(buf);
    if (ok)
        send_text(fd, "200 OK", "application/json; charset=utf-8", "{\"ok\":true}");
    else
        send_text(fd, "502 Bad Gateway", "application/json; charset=utf-8",
                  "{\"ok\":false,\"error\":\"loader write failed\"}");
}

/* ── Per-connection handler ──────────────────────────────────────────── */

static void handle_client(int fd) {
    char req[REQ_MAX];
    ssize_t got = read(fd, req, sizeof(req) - 1);
    if (got <= 0) return;
    req[got] = '\0';

    const char *method;
    if      (strncmp(req, "GET ",  4) == 0) method = "GET";
    else if (strncmp(req, "HEAD ", 5) == 0) method = "HEAD";
    else if (strncmp(req, "POST ", 5) == 0) method = "POST";
    else { send_text(fd, "405 Method Not Allowed", "text/plain", "method"); return; }

    /* Binary payload upload → loader. Handled before the generic parse
     * (which truncates `req` and can't deal with a MiB body). */
    if (strncmp(req, "POST /api/payload/send", 22) == 0) {
        handle_payload_send(fd, req, got);
        return;
    }

    /* Capture the request body (after the blank line) BEFORE we punch a
     * '\0' into the request line below — strstr would otherwise stop at
     * that terminator and never reach the body. Bodies are small JSON
     * (profile writes); they arrive in this single read. */
    const char *body = NULL;
    uint32_t blen = 0;
    char *hdr_end = strstr(req, "\r\n\r\n");
    if (hdr_end) {
        body = hdr_end + 4;
        blen = (uint32_t)((req + got) - (hdr_end + 4));
    }

    char *sp = strchr(req, ' ');
    if (!sp) { send_text(fd, "400 Bad Request", "text/plain", "bad"); return; }
    char *path = sp + 1;
    char *sp2 = strchr(path, ' ');
    if (!sp2) { send_text(fd, "400 Bad Request", "text/plain", "bad"); return; }
    *sp2 = '\0';
    char *q = strchr(path, '?');
    const char *query = NULL;
    if (q) { *q = '\0'; query = q + 1; }

    if (strncmp(path, "/api/", 5) == 0) {
        if (handle_api(fd, method, path, query, body, blen)) return;
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
