/*
 * sys.h — PS5 glue (toasts, keep-awake, firmware version, browser launch,
 * local IP). The host build logs toasts instead of showing them.
 */
#ifndef XENO_SYS_H
#define XENO_SYS_H

#include "util.h"

void sys_toast(const char *fmt, ...) XS_PRINTF(1, 2);
void sys_keep_awake_tick(void);
const char *sys_fw_version(void);      /* "13.60" on PS5, "host" otherwise */
const char *sys_platform(void);        /* "ps5" | "host" */
int sys_launch_browser(const char *url);  /* only effective in LAUNCH_BROWSER builds */
int sys_local_ip(char *out, size_t cap);  /* first non-loopback IPv4; "127.0.0.1" fallback */

#endif
