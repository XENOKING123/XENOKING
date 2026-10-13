/*
 * config.h — process-wide runtime configuration (argv + constants).
 * Defined in main.c; read-only after startup for every other module.
 */
#ifndef XENO_CONFIG_H
#define XENO_CONFIG_H

#include <stddef.h>
#include <time.h>

#ifndef XENO_VERSION
#define XENO_VERSION "0.0.0"
#endif

#define XENO_APP_NAME "XENO STORE"
#define XENO_DEFAULT_PORT 9095
#define XENO_MAX_EXTRA_ROOTS 8

typedef struct xeno_config {
  char data_dir[512];
  int port;
  int no_browser;
  int log_level;
  char extra_roots[XENO_MAX_EXTRA_ROOTS][512];
  int n_extra_roots;
  time_t started_at;
  volatile int stop_requested;   /* set by signals / POST /api/system/stop */
} xeno_config;

extern xeno_config g_cfg;

#endif
