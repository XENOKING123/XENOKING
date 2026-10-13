/*
 * dlx_turbo.c — see dlx_turbo.h.
 *
 * Every mirror gets its own probe thread that fetches Range: bytes=0-1048575
 * with short timeouts. Once the first probe finishes, the others get at most
 * 1.5 s more before the race is stopped (their cancel flag is raised, which
 * the transports honor between reads), so a dead mirror never delays the
 * start by more than a connect timeout.
 */
#include "dlx_turbo.h"
#include "http_client.h"
#include "log.h"
#include "util.h"

#include <pthread.h>
#include <stdlib.h>
#include <string.h>

#define PROBE_CONNECT_MS 8000
#define PROBE_RECV_MS 10000
#define GRACE_AFTER_FIRST_MS 1500
#define RACE_MAX_MS 20000

typedef struct probe_ctx {
  const char *url;
  int insecure;
  volatile int *stop;
  dl_turbo_probe *out;
  volatile int finished;
} probe_ctx;

static int looks_like_html_probe(const char *p, size_t n) {
  char head[32];
  size_t k = n < 24 ? n : 24;
  for (size_t i = 0; i < k; i++) head[i] = (char)((unsigned char)p[i] < 0x20 || (unsigned char)p[i] > 0x7e ? ' ' : p[i]);
  head[k] = 0;
  util_trim(head);
  return util_istarts_with(head, "<!DOCTYPE") || util_istarts_with(head, "<html");
}

static void *probe_thread(void *arg) {
  probe_ctx *px = arg;
  dl_turbo_probe *o = px->out;
  int64_t t0 = util_now_ms();
  xhttp_req req;
  memset(&req, 0, sizeof req);
  req.url = px->url;
  req.range_start = 0;
  req.range_end = DLX_TURBO_PROBE_BYTES - 1;
  req.follow_redirects = 8;
  req.connect_timeout_ms = PROBE_CONNECT_MS;
  req.recv_timeout_ms = PROBE_RECV_MS;
  req.insecure_tls = px->insecure;
  req.cancel_flag = px->stop;
  xhttp_conn *c = NULL;
  xhttp_resp resp;
  char *buf = malloc(256u << 10);
  if (buf && xhttp_open(&req, &c, &resp) == 0) {
    o->status = resp.status;
    int ok = (resp.status == 206 || resp.status == 200) && !util_istarts_with(resp.content_type, "text/html");
    int first = 1;
    while (ok && o->bytes < DLX_TURBO_PROBE_BYTES && !*px->stop) {
      size_t want = 256u << 10;
      if ((int64_t)want > DLX_TURBO_PROBE_BYTES - o->bytes) want = (size_t)(DLX_TURBO_PROBE_BYTES - o->bytes);
      int n = xhttp_read(c, buf, want);
      if (n <= 0) break;
      if (first) { first = 0; if (looks_like_html_probe(buf, (size_t)n)) { o->bytes = 0; o->status = -1; break; } }
      o->bytes += n;
    }
    if (!ok) o->bytes = 0;
    xhttp_close(c);
  } else {
    o->status = 0;
  }
  free(buf);
  int64_t ms = util_now_ms() - t0;
  o->ms = (int)(ms < 1 ? 1 : ms > 1000000 ? 1000000 : ms);
  o->mbps = o->bytes > 0 ? ((double)o->bytes * 8.0 / ((double)o->ms / 1000.0)) / 1e6 : 0;
  px->finished = 1;
  return NULL;
}

int dlx_turbo_race(const char *const *urls, int n, int insecure_tls, volatile int *cancel, dl_turbo *out) {
  memset(out, 0, sizeof *out);
  out->done = 1;
  if (n > DL_TURBO_MAX) n = DL_TURBO_MAX;
  if (n < 2) return -1;
  volatile int stop = 0;
  probe_ctx px[DL_TURBO_MAX];
  pthread_t th[DL_TURBO_MAX];
  int started[DL_TURBO_MAX] = {0, 0, 0};
  out->ntested = n;
  for (int i = 0; i < n; i++) {
    memset(&px[i], 0, sizeof px[i]);
    px[i].url = urls[i];
    px[i].insecure = insecure_tls;
    px[i].stop = &stop;
    px[i].out = &out->tested[i];
    xstrlcpy(out->tested[i].url, urls[i], sizeof out->tested[i].url);
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 256 << 10);
    started[i] = pthread_create(&th[i], &attr, probe_thread, &px[i]) == 0;
    pthread_attr_destroy(&attr);
    if (!started[i]) { out->tested[i].status = 0; px[i].finished = 1; }
  }
  int64_t t0 = util_now_ms(), first_done_ms = 0;
  for (;;) {
    int done = 0;
    for (int i = 0; i < n; i++) if (px[i].finished) done++;
    int64_t now = util_now_ms();
    if (done == n) break;
    if (cancel && *cancel) { stop = 1; }
    if (done > 0 && !first_done_ms) first_done_ms = now;
    if (first_done_ms && now - first_done_ms >= GRACE_AFTER_FIRST_MS) stop = 1;
    if (now - t0 >= RACE_MAX_MS) stop = 1;
    util_sleep_ms(25);
  }
  for (int i = 0; i < n; i++) if (started[i]) pthread_join(th[i], NULL);
  int best = -1;
  double best_rate = 0;
  for (int i = 0; i < n; i++) {
    const dl_turbo_probe *p = &out->tested[i];
    if (p->bytes < (64 << 10)) continue;   /* too little data to judge */
    double rate = (double)p->bytes / (double)p->ms;
    if (best < 0 || rate > best_rate || (rate == best_rate && p->bytes > out->tested[best].bytes)) { best = i; best_rate = rate; }
  }
  if (best >= 0) xstrlcpy(out->picked, out->tested[best].url, sizeof out->picked);
  return best;
}
