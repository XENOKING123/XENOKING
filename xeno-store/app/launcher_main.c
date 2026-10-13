/*
 * launcher_main.c — the XENO STORE app-launcher ELF.
 *
 * XENO STORE is a payload so downloads keep running after the app is closed.
 * This tiny ELF is what the home-screen package (.ffpkg) runs as its eboot: it
 * makes sure the store is up, then hands the console's browser over to it,
 * full-screen, at http://127.0.0.1:9095/?tv=1.
 *
 *   1. Probe 127.0.0.1:9095. If the store already answers, skip to step 3.
 *   2. Otherwise stream the newest saved copy of the server ELF to the ELF
 *      loader the jailbreak runs on 127.0.0.1:9021 (raw bytes, 64 KiB chunks,
 *      10 s timeouts, then shutdown(SHUT_WR) and drain so nothing is cut short
 *      — the same handshake a payload sender uses).
 *   3. Poll GET /api/status every 500 ms for up to 30 s until the store is live.
 *   4. Open the PS5 web browser full-screen on the store.
 *
 * Built with prospero-clang against only SceSystemService + SceUserService.
 * It keeps no state and never writes to disk.
 */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

/* SceSystemService / SceUserService: the two libraries this ELF links. */
extern int sceUserServiceInitialize(void *params);
extern int sceSystemServiceLaunchWebBrowser(const char *uri, void *params);

#define STORE_PORT 9095
#define LOADER_PORT 9021
#define CHUNK (64 * 1024)
#define SEND_TIMEOUT_MS 10000
#define POLL_INTERVAL_MS 500
#define POLL_TOTAL_MS 30000
#define MAX_PAYLOAD (64LL << 20)

#define STORE_URL "http://127.0.0.1:9095/?tv=1"

/* Saved copies of the server, newest wins. The server's updater keeps the
 * first current; the homebrew install carries the browser build as its eboot. */
static const char *kCandidates[] = {
    "/data/xeno-store/xeno-store.elf",
    "/data/homebrew/XENO-STORE/eboot.bin",
};

static void log_line(const char *msg) {
  /* The loader captures stdout; keep it short and unconditional. */
  printf("[xeno-launcher] %s\n", msg);
  fflush(stdout);
}

static void set_timeouts(int fd, int ms) {
  struct timeval tv;
  tv.tv_sec = ms / 1000;
  tv.tv_usec = (ms % 1000) * 1000;
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
#ifdef SO_NOSIGPIPE
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
}

/* Opens a loopback TCP connection with the given per-operation timeout.
 * Returns the fd, -1 on refusal/error (errno == ECONNREFUSED when refused). */
static int dial(int port, int timeout_ms) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  set_timeouts(fd, timeout_ms);
  struct sockaddr_in peer;
  memset(&peer, 0, sizeof peer);
  peer.sin_family = AF_INET;
  peer.sin_port = htons((unsigned short)port);
  peer.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (const struct sockaddr *)&peer, sizeof peer) != 0) {
    int saved = errno;
    close(fd);
    errno = saved;
    return -1;
  }
  return fd;
}

/* A regular x86-64 ELF64 of at most 64 MiB. Fills *mtime and *bytes. */
static int readable_elf(const char *path, long long *bytes, long *mtime) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) return 0;
  struct stat st;
  unsigned char head[20];
  int ok = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_size >= 64 &&
           (long long)st.st_size <= MAX_PAYLOAD &&
           read(fd, head, sizeof head) == (ssize_t)sizeof head &&
           memcmp(head, "\177ELF\2\1", 6) == 0 && head[18] == 62 && head[19] == 0;
  close(fd);
  if (ok) {
    *bytes = (long long)st.st_size;
    *mtime = (long)st.st_mtime;
  }
  return ok;
}

/* Picks the newest readable server ELF from the candidate list. */
static const char *choose_payload(void) {
  const char *best = NULL;
  long best_mtime = 0;
  for (size_t i = 0; i < sizeof kCandidates / sizeof kCandidates[0]; i++) {
    long long bytes = 0;
    long mtime = 0;
    if (readable_elf(kCandidates[i], &bytes, &mtime) && (!best || mtime >= best_mtime)) {
      best = kCandidates[i];
      best_mtime = mtime;
    }
  }
  return best;
}

/* Streams the file to the ELF loader. Returns 0 sent, 1 no loader, -1 error. */
static int send_to_loader(const char *path) {
  int file = open(path, O_RDONLY);
  if (file < 0) return -1;
  int fd = dial(LOADER_PORT, SEND_TIMEOUT_MS);
  if (fd < 0) {
    int refused = (errno == ECONNREFUSED);
    close(file);
    return refused ? 1 : -1;
  }
  char buf[CHUNK];
  int result = 0;
  for (;;) {
    ssize_t got = read(file, buf, sizeof buf);
    if (got < 0 && errno == EINTR) continue;
    if (got < 0) { result = -1; break; }
    if (got == 0) break;
    ssize_t sent = 0;
    while (sent < got) {
#ifdef MSG_NOSIGNAL
      ssize_t n = send(fd, buf + sent, (size_t)(got - sent), MSG_NOSIGNAL);
#else
      ssize_t n = send(fd, buf + sent, (size_t)(got - sent), 0);
#endif
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) { result = -1; break; }
      sent += n;
    }
    if (result != 0) break;
  }
  close(file);
  if (result == 0) {
    /* The loader starts the payload when it reads EOF; wait for it to close. */
    shutdown(fd, SHUT_WR);
    char drain[256];
    while (recv(fd, drain, sizeof drain, 0) > 0) { }
  }
  close(fd);
  return result;
}

/* One GET /api/status; returns 1 when the store answers HTTP 200. */
static int store_ready(void) {
  int fd = dial(STORE_PORT, 2000);
  if (fd < 0) return 0;
  static const char req[] =
      "GET /api/status HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
  ssize_t off = 0, len = (ssize_t)(sizeof req - 1);
  int ok = 0;
  while (off < len) {
    ssize_t n = send(fd, req + off, (size_t)(len - off), 0);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { close(fd); return 0; }
    off += n;
  }
  char resp[64];
  ssize_t got = recv(fd, resp, sizeof resp - 1, 0);
  if (got > 0) {
    resp[got] = '\0';
    if (strstr(resp, " 200 ")) ok = 1;
  }
  close(fd);
  return ok;
}

static void sleep_ms(int ms) {
  struct timeval tv;
  tv.tv_sec = ms / 1000;
  tv.tv_usec = (ms % 1000) * 1000;
  select(0, NULL, NULL, NULL, &tv);
}

int main(void) {
  log_line("starting");

  /* 1. Is the store already up? */
  int fd = dial(STORE_PORT, 1500);
  int running = (fd >= 0);
  if (fd >= 0) close(fd);

  /* 2. Not running — start it through the ELF loader. */
  if (!running) {
    const char *payload = choose_payload();
    if (!payload) {
      log_line("no saved server ELF found — open XENO STORE from your payload manager once");
    } else {
      char msg[256];
      snprintf(msg, sizeof msg, "sending %s to the ELF loader on :%d", payload, LOADER_PORT);
      log_line(msg);
      int rc = send_to_loader(payload);
      if (rc == 0) log_line("payload sent");
      else if (rc == 1) log_line("no ELF loader is listening on :9021");
      else log_line("sending the payload failed");
    }
  } else {
    log_line("store already running");
  }

  /* 3. Wait for the store to answer. */
  int waited = 0, ready = store_ready();
  while (!ready && waited < POLL_TOTAL_MS) {
    sleep_ms(POLL_INTERVAL_MS);
    waited += POLL_INTERVAL_MS;
    ready = store_ready();
  }
  if (!ready) log_line("store did not come up within 30 s — opening the browser anyway");
  else log_line("store is live");

  /* 4. Hand the browser to the store, full-screen. */
  sceUserServiceInitialize(NULL);
  int rc = sceSystemServiceLaunchWebBrowser(STORE_URL, NULL);
  if (rc != 0) {
    char msg[96];
    snprintf(msg, sizeof msg, "LaunchWebBrowser -> 0x%08x", (unsigned)rc);
    log_line(msg);
    return 1;
  }
  log_line("browser opened on the store");
  return 0;
}
