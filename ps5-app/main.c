/*
 * XENOKING Game Store - native PS5 payload.
 *
 * A tiny static HTTP server that serves the XENO Game Store UI directly from the
 * console. Built against the ps5-payload-dev SDK (prospero-clang). Sent to the
 * PS5 the same way any payload is (ELF loader on :9021, or XENO TOOL's Payloads
 * tab). Once running it listens on :9095; open the PS5 browser at
 * http://127.0.0.1:9095 (or the console IP from another device on the LAN).
 *
 * Two builds come out of this one file (see the Makefile):
 *   xeno-store.elf           - server only (the payload you "Send" from the tool)
 *   xeno-store-browser.elf   - built with -DLAUNCH_BROWSER: starts the server AND
 *                              opens the PS5 web browser at it. This is the
 *                              eboot.bin used by the home-screen homebrew package,
 *                              so tapping the XENO icon = one-tap store.
 *
 * The UI HTML and the games catalog are embedded at build time (assets.h, via
 * tools/gen_assets.py): index_html[], catalog_json[], logo_jpg[].
 *
 * Pure POSIX sockets + libc, nothing SDK-specific in the hot path, so it builds
 * cleanly against the ps5-payload-dev toolchain.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include "assets.h"   /* generated: index_html[], index_html_len, catalog_json[], catalog_json_len, logo_jpg[], logo_jpg_len */

#define PORT 9095

#ifdef LAUNCH_BROWSER
/* libSceSystemService / libSceUserService - linked only for the browser build.
 * Same calls the ps5-payload-dev `browser` sample uses to open the built-in
 * WebKit browser at a URL. */
int sceUserServiceInitialize(void *);
int sceUserServiceTerminate(void);
int sceSystemServiceLaunchWebBrowser(const char *uri, void *);
#endif

static void send_all(int fd, const char *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, buf + off, len - off);
        if (n <= 0) {
            if (errno == EINTR) continue;
            break;
        }
        off += (size_t)n;
    }
}

static void send_response(int fd, const char *status, const char *ctype,
                          const unsigned char *body, size_t blen) {
    char head[256];
    int hl = snprintf(head, sizeof(head),
        "HTTP/1.1 %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Connection: close\r\n\r\n",
        status, ctype, blen);
    send_all(fd, head, (size_t)hl);
    if (body && blen) send_all(fd, (const char *)body, blen);
}

static void handle(int fd) {
    char req[2048];
    ssize_t n = read(fd, req, sizeof(req) - 1);
    if (n <= 0) return;
    req[n] = 0;

    /* parse "GET <path> HTTP/1.1" */
    char path[512] = "/";
    if (sscanf(req, "GET %511s", path) != 1) {
        send_response(fd, "400 Bad Request", "text/plain", (const unsigned char *)"bad", 3);
        return;
    }
    /* strip query string */
    char *q = strchr(path, '?');
    if (q) *q = 0;

    if (strcmp(path, "/") == 0 || strcmp(path, "/index.html") == 0) {
        send_response(fd, "200 OK", "text/html; charset=utf-8",
                      index_html, index_html_len);
    } else if (strcmp(path, "/catalog.json") == 0) {
        send_response(fd, "200 OK", "application/json",
                      catalog_json, catalog_json_len);
    } else if (strcmp(path, "/logo.jpg") == 0) {
        send_response(fd, "200 OK", "image/jpeg",
                      logo_jpg, logo_jpg_len);
    } else {
        send_response(fd, "404 Not Found", "text/plain",
                      (const unsigned char *)"not found", 9);
    }
}

int main(void) {
    int srv = socket(AF_INET, SOCK_STREAM, 0);
    if (srv < 0) return 1;

    int yes = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(PORT);

    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) < 0) return 2;
    if (listen(srv, 16) < 0) return 3;

    /* notify (shows in klog / etaHEN toolbox console) */
    printf("[XENOKING Game Store] serving on http://0.0.0.0:%d\n", PORT);
    fflush(stdout);

#ifdef LAUNCH_BROWSER
    /* One-tap home-screen experience: we are already listening, so opening the
     * browser now is safe (it connects back to us). The browser runs as its own
     * system process; this process stays alive below to keep serving. */
    sceUserServiceInitialize(0);
    if (sceSystemServiceLaunchWebBrowser("http://127.0.0.1:9095", 0)) {
        perror("sceSystemServiceLaunchWebBrowser");
    }
#endif

    for (;;) {
        struct sockaddr_in cli;
        socklen_t cl = sizeof(cli);
        int fd = accept(srv, (struct sockaddr *)&cli, &cl);
        if (fd < 0) {
            if (errno == EINTR) continue;
            break;
        }
        handle(fd);
        close(fd);
    }
    close(srv);
#ifdef LAUNCH_BROWSER
    sceUserServiceTerminate();
#endif
    return 0;
}
