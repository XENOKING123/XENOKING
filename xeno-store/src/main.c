/*
 * main.c — argv parsing (SPEC §3.1), startup order (§3.2), the housekeeping
 * thread (persist, catalog refresh, keep-awake, retry timers, update checks)
 * and graceful shutdown.
 *
 *   xeno-store [--port N] [--data DIR] [--root PATH]... [--no-browser] [--log-level debug|info|warn]
 *
 * On the console the loader passes no arguments and the defaults apply
 * (data dir /data/xeno-store, port 9095). The LAUNCH_BROWSER variant opens
 * the PS5 web browser on the store once the server is up.
 */
#include "api.h"
#include "catalog.h"
#include "config.h"
#include "dl.h"
#include "http_client.h"
#include "launcher_icon.h"   /* [launcher builder] deep-link home-screen icon */
#include "log.h"
#include "pairing.h"
#include "server.h"
#include "settings.h"
#include "storage.h"
#include "sys.h"
#include "update.h"
#include "util.h"

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

xeno_config g_cfg;

#define CATALOG_REFRESH_S (6 * 3600)
#define UPDATE_CHECK_S (24 * 3600)
#define FIRST_SYNC_DELAY_S 20

static void usage(void) {
  fprintf(stderr, "usage: xeno-store [--port N] [--data DIR] [--root PATH]... [--no-browser] [--log-level debug|info|warn]\n");
}

static int parse_args(int argc, char **argv) {
  memset(&g_cfg, 0, sizeof g_cfg);
  g_cfg.port = XENO_DEFAULT_PORT;
  g_cfg.log_level = LOG_INFO;
#ifdef XENO_HOST
  xstrlcpy(g_cfg.data_dir, "./xeno-data", sizeof g_cfg.data_dir);
#else
  xstrlcpy(g_cfg.data_dir, "/data/xeno-store", sizeof g_cfg.data_dir);
#endif
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    const char *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (strcmp(a, "--port") == 0 && v) { g_cfg.port = util_parse_int(v, -1); i++; if (g_cfg.port <= 0 || g_cfg.port > 65535) { usage(); return -1; } }
    else if (strcmp(a, "--data") == 0 && v) { xstrlcpy(g_cfg.data_dir, v, sizeof g_cfg.data_dir); i++; }
    else if (strcmp(a, "--root") == 0 && v) {
      if (g_cfg.n_extra_roots < XENO_MAX_EXTRA_ROOTS) xstrlcpy(g_cfg.extra_roots[g_cfg.n_extra_roots++], v, sizeof g_cfg.extra_roots[0]);
      i++;
    }
    else if (strcmp(a, "--no-browser") == 0) g_cfg.no_browser = 1;
    else if (strcmp(a, "--log-level") == 0 && v) { g_cfg.log_level = log_level_from_name(v); i++; }
    else if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) { usage(); return -1; }
    else { fprintf(stderr, "unknown argument: %s\n", a); usage(); return -1; }
  }
  /* strip a trailing slash so joined paths stay tidy */
  size_t n = strlen(g_cfg.data_dir);
  while (n > 1 && g_cfg.data_dir[n - 1] == '/') g_cfg.data_dir[--n] = 0;
  return 0;
}

static void on_signal(int sig) {
  (void)sig;
  g_cfg.stop_requested = 1;
}

/* Periodic duties that must not block the HTTP workers. */
static void *housekeeping(void *arg) {
  (void)arg;
  time_t last_catalog = 0, last_update = 0;
  time_t boot = util_now();
  while (!g_cfg.stop_requested) {
    dl_housekeeping_tick();
    if (ext_downloads_tick) ext_downloads_tick();
    if (ext_console_tick) ext_console_tick();
    time_t now = util_now();
    settings_t s;
    settings_get(&s);
    if (xhttp_available() && now - boot >= FIRST_SYNC_DELAY_S) {
      if (s.catalogAutoRefresh && now - last_catalog >= CATALOG_REFRESH_S && (now - s.catalogLastCheck >= CATALOG_REFRESH_S || last_catalog == 0)) {
        last_catalog = now;
        if (now - s.catalogLastCheck >= CATALOG_REFRESH_S) {
          char err[256];
          int updated = 0;
          if (catalog_refresh(0, &updated, err, sizeof err) != 0) LOGW("catalog auto-refresh: %s", err);
          else if (updated) sys_toast("Catalog updated to revision %lld", (long long)catalog_revision());
        }
      }
      if (s.updatesAutoCheck && now - last_update >= UPDATE_CHECK_S) {
        last_update = now;
        if (now - s.updatesLastCheck >= UPDATE_CHECK_S) {
          char err[256];
          update_check(err, sizeof err);
        }
      }
    }
    util_sleep_ms(500);
  }
  return NULL;
}

int main(int argc, char **argv) {
  if (parse_args(argc, argv) != 0) return 2;
  signal(SIGPIPE, SIG_IGN);
#ifdef XENO_HOST
  signal(SIGINT, on_signal);
  signal(SIGTERM, on_signal);
#else
  signal(SIGTERM, on_signal);
#endif
  g_cfg.started_at = util_now();
  if (util_mkdir_p(g_cfg.data_dir) != 0) {
    fprintf(stderr, "cannot create data dir %s: %s\n", g_cfg.data_dir, strerror(errno));
    sys_toast("XENO STORE: cannot create %s", g_cfg.data_dir);
    return 1;
  }
  log_init(g_cfg.data_dir, g_cfg.log_level);
  LOGI("%s %s starting (%s, data %s, port %d)", XENO_APP_NAME, XENO_VERSION, sys_platform(), g_cfg.data_dir, g_cfg.port);

  settings_init(g_cfg.data_dir);
  pairing_init(g_cfg.data_dir);
  if (xhttp_global_init() != 0) LOGW("transport init failed: %s — downloads unavailable", xhttp_last_error());
  else LOGI("transport: %s", xhttp_backend_name());
  catalog_init(g_cfg.data_dir);
  storage_init();
  dl_init(g_cfg.data_dir, g_cfg.port);
  update_init(g_cfg.data_dir);
  api_init();
  api_ext_init();

  if (server_start(g_cfg.port) != 0) {
    LOGE("cannot bind :%d (%s)", g_cfg.port, strerror(errno));
    sys_toast("XENO STORE already running on :%d", g_cfg.port);
    log_shutdown();
    return 0;
  }
  pthread_t hk;
  if (pthread_create(&hk, NULL, housekeeping, NULL) != 0) { LOGE("cannot start housekeeping thread"); return 1; }

  /* [launcher builder] Server is bound — publish the deep-link home-screen icon
   * (/user/app/XENO00002). Idempotent, never fatal; a logged no-op on host. */
  launcher_icon_register();

  char ip[48];
  sys_local_ip(ip, sizeof ip);
  char url[96];
  xsnprintf(url, sizeof url, "http://%s:%d/", ip, g_cfg.port);
#ifdef LAUNCH_BROWSER
  if (!g_cfg.no_browser) {
    char local[64];
    xsnprintf(local, sizeof local, "http://127.0.0.1:%d/", g_cfg.port);
    sys_launch_browser(local);
  }
#endif
  sys_toast("XENO STORE ready · %s", url);
  LOGI("ready: %s (fw %s)", url, sys_fw_version());

  while (!g_cfg.stop_requested) util_sleep_ms(250);

  LOGI("shutting down");
  pthread_join(hk, NULL);
  server_stop();
  dl_shutdown();
  LOGI("bye");
  log_shutdown();
  return 0;
}
