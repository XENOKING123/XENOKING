/*
 * sys.c — see sys.h. Only the proven-to-load libraries are direct-linked
 * (libSceSystemService, libSceUserService, libkernel_sys); the notification
 * request goes through the kernel syscall wrapper that every payload has.
 */
#include "sys.h"
#include "config.h"
#include "log.h"

#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>

#ifndef XENO_HOST
#include <ps5/kernel.h>
#include <sys/sysctl.h>
typedef struct notify_request {
  char useless1[45];
  char message[3075];
} notify_request_t;
extern int sceKernelSendNotificationRequest(int, notify_request_t *, size_t, int);
extern int sceSystemServicePowerTick(void);
#ifdef LAUNCH_BROWSER
extern int sceUserServiceInitialize(void *);
extern int sceSystemServiceLaunchWebBrowser(const char *uri, void *);
#endif
#endif

void sys_toast(const char *fmt, ...) {
  char msg[1024];
  va_list ap;
  va_start(ap, fmt);
  xvsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);
#ifdef XENO_HOST
  LOGI("toast: %s", msg);
#else
  notify_request_t req;
  memset(&req, 0, sizeof req);
  xstrlcpy(req.message, msg, sizeof req.message);
  sceKernelSendNotificationRequest(0, &req, sizeof req, 0);
  LOGD("toast: %s", msg);
#endif
}

void sys_keep_awake_tick(void) {
#ifdef XENO_HOST
  LOGD("keep-awake tick");
#else
  int rc = sceSystemServicePowerTick();
  if (rc != 0) LOGD("sceSystemServicePowerTick -> 0x%08x", (unsigned)rc);
#endif
}

const char *sys_fw_version(void) {
#ifdef XENO_HOST
  return "host";
#else
  static char ver[16];
  if (!ver[0]) {
    /* kern.sdk_version packs the firmware as BCD-style bytes: 13.60 →
     * 0x13600000. The sysctl is a plain syscall; kernel_get_fw_version() from
     * <ps5/kernel.h> reads kernel memory, which this repo observed faulting on
     * some SKUs (payload/src/hw_info.c), so the sysctl is preferred. */
    uint32_t v = 0;
    size_t sz = sizeof v;
    if (sysctlbyname("kern.sdk_version", &v, &sz, NULL, 0) != 0 || v == 0) {
      xstrlcpy(ver, "unknown", sizeof ver);
    } else {
      xsnprintf(ver, sizeof ver, "%x.%02x", (v >> 24) & 0xff, (v >> 16) & 0xff);
    }
  }
  return ver;
#endif
}

const char *sys_platform(void) {
#ifdef XENO_HOST
  return "host";
#else
  return "ps5";
#endif
}

int sys_launch_browser(const char *url) {
#if defined(LAUNCH_BROWSER) && !defined(XENO_HOST)
  sceUserServiceInitialize(NULL);
  int rc = sceSystemServiceLaunchWebBrowser(url, NULL);
  if (rc != 0) LOGW("sceSystemServiceLaunchWebBrowser(%s) -> 0x%08x", url, (unsigned)rc);
  return rc == 0 ? 0 : -1;
#else
  LOGI("browser launch not built in (url %s)", url);
  return -1;
#endif
}

int sys_local_ip(char *out, size_t cap) {
  struct ifaddrs *ifa = NULL, *p;
  xstrlcpy(out, "127.0.0.1", cap);
  if (getifaddrs(&ifa) != 0) return -1;
  int found = 0;
  for (p = ifa; p; p = p->ifa_next) {
    if (!p->ifa_addr || p->ifa_addr->sa_family != AF_INET) continue;
    if (p->ifa_flags & IFF_LOOPBACK) continue;
    if (!(p->ifa_flags & IFF_UP)) continue;
    const struct sockaddr_in *sin = (const struct sockaddr_in *)p->ifa_addr;
    const char *s = inet_ntoa(sin->sin_addr);
    if (!s || util_starts_with(s, "127.") || util_starts_with(s, "169.254.")) continue;
    xstrlcpy(out, s, cap);
    found = 1;
    break;
  }
  freeifaddrs(ifa);
  return found ? 0 : -1;
}
