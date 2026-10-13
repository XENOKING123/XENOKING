/* dlx_rest.c — see dlx_rest.h. */
#include "dlx_rest.h"
#include "http_client.h"
#include "log.h"
#include "util.h"

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <pthread.h>
#include <string.h>
#include <sys/socket.h>

#define CLOCK_JUMP_MS 10000
#define BURST_WINDOW_MS 20000
#define BURST_COUNT 3
#define EVENT_RECENT_MS (3 * 60 * 1000)
#define EVENT_MIN_GAP_MS 30000

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static int64_t last_mono_ms, last_wall_ms, event_ms;
static int64_t burst[8];
static int burst_n;

static void raise_event_locked(const char *why) {
  int64_t now = util_now_ms();
  if (event_ms && now - event_ms < EVENT_MIN_GAP_MS) return;
  event_ms = now;
  burst_n = 0;
  LOGW("rest-mode: wake-up detected (%s) — running jobs reconnect without consuming retries", why);
}

int dlx_rest_tick(void) {
  int64_t mono = util_now_ms();
  int64_t wall = (int64_t)util_now() * 1000;
  int fired = 0;
  pthread_mutex_lock(&mu);
  if (last_mono_ms) {
    int64_t dm = mono - last_mono_ms, dw = wall - last_wall_ms;
    if (dm > CLOCK_JUMP_MS) { raise_event_locked("monotonic clock jumped"); fired = event_ms == mono; }
    else if (dw - dm > CLOCK_JUMP_MS) { raise_event_locked("wall clock jumped while the monotonic clock stood still"); fired = event_ms == mono; }
  }
  last_mono_ms = mono;
  last_wall_ms = wall;
  pthread_mutex_unlock(&mu);
  return fired;
}

void dlx_rest_note_error(int err_class) {
  if (err_class != XHTTP_ERR_NETDOWN && err_class != XHTTP_ERR_TIMEOUT) return;
  int64_t now = util_now_ms();
  pthread_mutex_lock(&mu);
  /* keep only errors inside the window */
  int k = 0;
  for (int i = 0; i < burst_n; i++) if (now - burst[i] <= BURST_WINDOW_MS) burst[k++] = burst[i];
  burst_n = k;
  if (burst_n < (int)(sizeof burst / sizeof burst[0])) burst[burst_n++] = now;
  if (burst_n >= BURST_COUNT) raise_event_locked("burst of network-down errors");
  pthread_mutex_unlock(&mu);
}

int dlx_rest_recent(void) {
  pthread_mutex_lock(&mu);
  int r = event_ms && util_now_ms() - event_ms <= EVENT_RECENT_MS;
  pthread_mutex_unlock(&mu);
  return r;
}

int64_t dlx_rest_last_event_ms(void) {
  pthread_mutex_lock(&mu);
  int64_t e = event_ms;
  pthread_mutex_unlock(&mu);
  return e;
}

void dlx_rest_force_event(const char *why) {
  pthread_mutex_lock(&mu);
  event_ms = 0;   /* bypass the minimum gap: an explicit event always counts */
  raise_event_locked(why ? why : "requested");
  pthread_mutex_unlock(&mu);
}

int dlx_net_has_address(void) {
  struct ifaddrs *ifa = NULL;
  if (getifaddrs(&ifa) != 0) return 0;
  int found = 0;
  for (struct ifaddrs *p = ifa; p && !found; p = p->ifa_next) {
    if (!p->ifa_addr || p->ifa_addr->sa_family != AF_INET) continue;
    if (p->ifa_flags & IFF_LOOPBACK) continue;
    if (!(p->ifa_flags & IFF_UP)) continue;
    struct sockaddr_in *sin = (struct sockaddr_in *)p->ifa_addr;
    uint32_t a = ntohl(sin->sin_addr.s_addr);
    if ((a >> 24) == 127 || a == 0) continue;
    found = 1;
  }
  freeifaddrs(ifa);
  return found;
}

int dlx_net_catalog_reachable(int timeout_ms) {
  settings_t s;
  settings_get(&s);
  const char *url = s.catalogRevisionUrl[0] ? s.catalogRevisionUrl : s.catalogUrl;
  if (!url[0] || !xhttp_available()) return 0;
  xhttp_req r;
  memset(&r, 0, sizeof r);
  r.method = "HEAD";
  r.url = url;
  r.range_start = r.range_end = -1;
  r.follow_redirects = 3;
  r.connect_timeout_ms = timeout_ms > 0 ? timeout_ms : 5000;
  r.recv_timeout_ms = timeout_ms > 0 ? timeout_ms : 5000;
  xhttp_conn *c = NULL;
  xhttp_resp resp;
  if (xhttp_open(&r, &c, &resp) != 0) return 0;
  xhttp_close(c);
  return resp.status > 0;
}

int dlx_net_origin_reachable(const char *url, int insecure_tls, volatile int *cancel, int timeout_ms) {
  if (!url || !*url || !xhttp_available()) return 0;
  xhttp_req r;
  memset(&r, 0, sizeof r);
  r.url = url;
  r.range_start = 0;
  r.range_end = 0;
  r.follow_redirects = 5;
  r.connect_timeout_ms = timeout_ms > 0 ? timeout_ms : 5000;
  r.recv_timeout_ms = timeout_ms > 0 ? timeout_ms : 5000;
  r.insecure_tls = insecure_tls;
  r.cancel_flag = cancel;
  xhttp_conn *c = NULL;
  xhttp_resp resp;
  if (xhttp_open(&r, &c, &resp) != 0) return 0;
  xhttp_close(c);
  return resp.status > 0;
}

const char *dlx_rest_pill(const settings_t *s, int downloading) {
  if (downloading && s->keepAwake) return "Console stays awake while downloading";
  if (s->restModeAutoResume) return "Rest mode allowed — downloads resume on wake";
  return "Rest mode allowed — downloads wait for Resume after a wake-up";
}
