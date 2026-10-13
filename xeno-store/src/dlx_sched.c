/* dlx_sched.c — see dlx_sched.h. Times are local console time. */
#include "dlx_sched.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>

/* "HH:MM" → minutes since midnight, -1 when malformed. */
static int hhmm(const char *s) {
  if (!s || strlen(s) != 5 || s[2] != ':') return -1;
  for (int i = 0; i < 5; i++) if (i != 2 && (s[i] < '0' || s[i] > '9')) return -1;
  int h = atoi(s), m = atoi(s + 3);
  if (h < 0 || h > 23 || m < 0 || m > 59) return -1;
  return h * 60 + m;
}

int dlx_sched_configured(const settings_t *s) {
  int a = hhmm(s->scheduleStart), b = hhmm(s->scheduleEnd);
  return a >= 0 && b >= 0 && a != b;
}

int dlx_sched_open(const settings_t *s, time_t now, char *next_start, size_t cap) {
  if (cap) next_start[0] = 0;
  int a = hhmm(s->scheduleStart), b = hhmm(s->scheduleEnd);
  if (a < 0 || b < 0 || a == b) return 1;
  struct tm tm;
  localtime_r(&now, &tm);
  int cur = tm.tm_hour * 60 + tm.tm_min;
  int open = a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);   /* b < a wraps midnight */
  if (!open) xstrlcpy(next_start, s->scheduleStart, cap);
  return open;
}
