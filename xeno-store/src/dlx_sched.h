/*
 * dlx_sched.h — the download schedule window (SPEC §17.5):
 * settings.downloads.scheduleStart/End ("22:00"–"07:00"). Outside the window
 * queued jobs wait with the message "Scheduled for 22:00" unless the user
 * presses "Start now anyway".
 */
#ifndef XENO_DLX_SCHED_H
#define XENO_DLX_SCHED_H

#include "settings.h"
#include <time.h>

/* 1 when downloads may start now (no window configured or inside it).
 * When closed, `next_start` receives the window's start time ("22:00"). */
int dlx_sched_open(const settings_t *s, time_t now, char *next_start, size_t cap);
/* 1 when a window is configured at all. */
int dlx_sched_configured(const settings_t *s);

#endif
