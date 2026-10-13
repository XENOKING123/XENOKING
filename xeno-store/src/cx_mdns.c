/*
 * cx_mdns.c — see cx_mdns.h.
 */
#include "cx_mdns.h"
#include "config.h"
#include "log.h"
#include "settings.h"
#include "sys.h"
#include "util.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define MDNS_PORT 5353
#define MDNS_GROUP "224.0.0.251"
#define MDNS_TTL 120
#define ANNOUNCE_S 60
#define MAX_NAMES 2

static const char *const NAMES[MAX_NAMES] = {"xeno.local", "xenostore.local"};
static pthread_mutex_t mdns_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_t th;
static volatile int running, stop_flag;
static int sock_fd = -1;
static char last_error[128];
static char last_ip[48];
static time_t last_announce;

/* ---- packet building ---------------------------------------------------- */

static size_t put_name(uint8_t *out, size_t cap, const char *name) {
  size_t o = 0;
  const char *p = name;
  while (*p) {
    const char *dot = strchr(p, '.');
    size_t l = dot ? (size_t)(dot - p) : strlen(p);
    if (l == 0 || l > 63 || o + l + 2 > cap) return 0;
    out[o++] = (uint8_t)l;
    memcpy(out + o, p, l);
    o += l;
    p += l;
    if (*p == '.') p++;
  }
  if (o + 1 > cap) return 0;
  out[o++] = 0;
  return o;
}

static size_t put_answer(uint8_t *out, size_t cap, const char *name, uint32_t ip_be) {
  size_t n = put_name(out, cap, name);
  if (!n || n + 14 > cap) return 0;
  uint8_t *p = out + n;
  p[0] = 0; p[1] = 1;              /* TYPE A */
  p[2] = 0x80; p[3] = 1;           /* CLASS IN + cache-flush */
  p[4] = 0; p[5] = 0; p[6] = 0; p[7] = MDNS_TTL;
  p[8] = 0; p[9] = 4;
  memcpy(p + 10, &ip_be, 4);
  return n + 14;
}

/* Reads a (possibly compressed) name from a DNS message into out (lowercase). */
static int read_name(const uint8_t *msg, size_t len, size_t *pos, char *out, size_t cap) {
  size_t o = 0, p = *pos;
  int jumped = 0, hops = 0;
  size_t end = p;
  while (p < len) {
    uint8_t l = msg[p];
    if (l == 0) { p++; if (!jumped) end = p; break; }
    if ((l & 0xC0) == 0xC0) {
      if (p + 1 >= len || ++hops > 8) return -1;
      size_t ptr = ((size_t)(l & 0x3F) << 8) | msg[p + 1];
      if (!jumped) end = p + 2;
      jumped = 1;
      if (ptr >= len) return -1;
      p = ptr;
      continue;
    }
    if (l > 63 || p + 1 + l > len || o + l + 2 > cap) return -1;
    if (o) out[o++] = '.';
    for (size_t i = 0; i < l; i++) { char c = (char)msg[p + 1 + i]; out[o++] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c; }
    p += 1 + l;
  }
  out[o] = 0;
  *pos = end;
  return o ? 0 : -1;
}

static size_t header(uint8_t *out, uint16_t id, uint16_t ancount) {
  out[0] = (uint8_t)(id >> 8); out[1] = (uint8_t)id;
  out[2] = 0x84; out[3] = 0x00;    /* QR=1, AA=1 */
  out[4] = 0; out[5] = 0;          /* QDCOUNT */
  out[6] = (uint8_t)(ancount >> 8); out[7] = (uint8_t)ancount;
  out[8] = 0; out[9] = 0; out[10] = 0; out[11] = 0;
  return 12;
}

size_t cx_mdns_build_response(const uint8_t *q, size_t qlen, uint32_t ip_be, uint8_t *out, size_t cap, int *unicast) {
  if (unicast) *unicast = 0;
  if (qlen < 12 || cap < 12) return 0;
  if (q[2] & 0x80) return 0;                       /* a response, not a query */
  uint16_t id = (uint16_t)((q[0] << 8) | q[1]);
  uint16_t qd = (uint16_t)((q[4] << 8) | q[5]);
  size_t pos = 12;
  int want[MAX_NAMES] = {0, 0};
  int any = 0, uni = 0;
  for (uint16_t i = 0; i < qd && i < 32; i++) {
    char name[256];
    if (read_name(q, qlen, &pos, name, sizeof name) != 0 || pos + 4 > qlen) break;
    uint16_t qtype = (uint16_t)((q[pos] << 8) | q[pos + 1]);
    uint16_t qclass = (uint16_t)((q[pos + 2] << 8) | q[pos + 3]);
    pos += 4;
    if ((qclass & 0x7FFF) != 1 || (qtype != 1 && qtype != 255)) continue;
    for (int n = 0; n < MAX_NAMES; n++) if (strcmp(name, NAMES[n]) == 0) { want[n] = 1; any = 1; if (qclass & 0x8000) uni = 1; }
  }
  if (!any) return 0;
  size_t o = header(out, uni ? id : 0, 0);
  uint16_t an = 0;
  for (int n = 0; n < MAX_NAMES; n++) {
    if (!want[n]) continue;
    size_t a = put_answer(out + o, cap - o, NAMES[n], ip_be);
    if (!a) return 0;
    o += a;
    an++;
  }
  out[6] = (uint8_t)(an >> 8); out[7] = (uint8_t)an;
  if (unicast) *unicast = uni;
  return o;
}

size_t cx_mdns_build_announce(uint32_t ip_be, uint8_t *out, size_t cap) {
  if (cap < 12) return 0;
  size_t o = header(out, 0, MAX_NAMES);
  for (int n = 0; n < MAX_NAMES; n++) {
    size_t a = put_answer(out + o, cap - o, NAMES[n], ip_be);
    if (!a) return 0;
    o += a;
  }
  return o;
}

/* ---- responder thread --------------------------------------------------- */

static uint32_t current_ip_be(void) {
  char ip[48];
  sys_local_ip(ip, sizeof ip);
  pthread_mutex_lock(&mdns_mu);
  xstrlcpy(last_ip, ip, sizeof last_ip);
  pthread_mutex_unlock(&mdns_mu);
  struct in_addr a;
  if (inet_aton(ip, &a) == 0) return 0;
  return a.s_addr;
}

static void set_error(const char *fmt, int e) {
  pthread_mutex_lock(&mdns_mu);
  xsnprintf(last_error, sizeof last_error, fmt, strerror(e));
  pthread_mutex_unlock(&mdns_mu);
}

static int open_socket(void) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) { set_error("socket: %s", errno); return -1; }
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
#ifdef SO_REUSEPORT
  setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);
#endif
  struct sockaddr_in sa;
  memset(&sa, 0, sizeof sa);
  sa.sin_family = AF_INET;
  sa.sin_port = htons(MDNS_PORT);
  sa.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(fd, (struct sockaddr *)&sa, sizeof sa) != 0) { set_error("bind :5353: %s", errno); close(fd); return -1; }
  struct ip_mreq mr;
  memset(&mr, 0, sizeof mr);
  mr.imr_multiaddr.s_addr = inet_addr(MDNS_GROUP);
  mr.imr_interface.s_addr = htonl(INADDR_ANY);
  if (setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mr, sizeof mr) != 0) LOGW("mdns: multicast join failed: %s (unicast queries still answered)", strerror(errno));
  unsigned char ttl = 255, loop = 0;
  setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof ttl);
  setsockopt(fd, IPPROTO_IP, IP_MULTICAST_LOOP, &loop, sizeof loop);
  return fd;
}

static void send_to_group(int fd, const uint8_t *pkt, size_t len) {
  struct sockaddr_in to;
  memset(&to, 0, sizeof to);
  to.sin_family = AF_INET;
  to.sin_port = htons(MDNS_PORT);
  to.sin_addr.s_addr = inet_addr(MDNS_GROUP);
  sendto(fd, pkt, len, 0, (struct sockaddr *)&to, sizeof to);
}

static void *responder(void *arg) {
  (void)arg;
  uint8_t in[1500], out[512];
  while (!stop_flag) {
    struct pollfd p = { sock_fd, POLLIN, 0 };
    int rc = poll(&p, 1, 1000);
    time_t now = util_now();
    if (now - last_announce >= ANNOUNCE_S) {
      uint32_t ip = current_ip_be();
      size_t n = ip ? cx_mdns_build_announce(ip, out, sizeof out) : 0;
      if (n) send_to_group(sock_fd, out, n);
      last_announce = now;
    }
    if (rc <= 0 || !(p.revents & POLLIN)) continue;
    struct sockaddr_in from;
    socklen_t fl = sizeof from;
    ssize_t got = recvfrom(sock_fd, in, sizeof in, 0, (struct sockaddr *)&from, &fl);
    if (got <= 0) continue;
    uint32_t ip = current_ip_be();
    if (!ip) continue;
    int uni = 0;
    size_t n = cx_mdns_build_response(in, (size_t)got, ip, out, sizeof out, &uni);
    if (!n) continue;
    /* legacy unicast (source port != 5353) and QU questions get a unicast reply */
    if (uni || ntohs(from.sin_port) != MDNS_PORT) sendto(sock_fd, out, n, 0, (struct sockaddr *)&from, fl);
    else send_to_group(sock_fd, out, n);
  }
  return NULL;
}

static void start(void) {
  if (running) return;
  int fd = open_socket();
  if (fd < 0) { LOGW("mdns: not started (%s)", last_error); return; }
  sock_fd = fd;
  stop_flag = 0;
  last_announce = 0;
  if (pthread_create(&th, NULL, responder, NULL) != 0) { set_error("thread: %s", errno); close(fd); sock_fd = -1; return; }
  running = 1;
  pthread_mutex_lock(&mdns_mu);
  last_error[0] = 0;
  pthread_mutex_unlock(&mdns_mu);
  LOGI("mdns: answering xeno.local / xenostore.local on :%d", MDNS_PORT);
}

void cx_mdns_stop(void) {
  if (!running) return;
  stop_flag = 1;
  pthread_join(th, NULL);
  close(sock_fd);
  sock_fd = -1;
  running = 0;
  LOGI("mdns: stopped");
}

void cx_mdns_init(void) {
  settings_t s;
  settings_get(&s);
  if (s.mdns) start();
}

void cx_mdns_tick(void) {
  settings_t s;
  settings_get(&s);
  if (s.mdns && !running) start();
  else if (!s.mdns && running) cx_mdns_stop();
}

void cx_mdns_status_json(jw *w) {
  settings_t s;
  settings_get(&s);
  char ip[48];
  sys_local_ip(ip, sizeof ip);
  jw_obj_begin(w);
  jw_kv_bool(w, "enabled", s.mdns);
  jw_kv_bool(w, "running", running);
  jw_key(w, "names"); jw_arr_begin(w);
  for (int n = 0; n < MAX_NAMES; n++) jw_str(w, NAMES[n]);
  jw_arr_end(w);
  jw_kv_str(w, "ip", ip);
  jw_kv_int(w, "port", MDNS_PORT);
  char url[64];
  xsnprintf(url, sizeof url, "http://xeno.local:%d/", g_cfg.port);
  jw_kv_str(w, "url", url);
  pthread_mutex_lock(&mdns_mu);
  jw_kv_str(w, "error", last_error);
  pthread_mutex_unlock(&mdns_mu);
  jw_obj_end(w);
}
