/*
 * cx_setup.c — see cx_setup.h.
 */
#include "cx_setup.h"
#include "cx_common.h"
#include "cx_companions.h"
#include "http_client.h"
#include "log.h"
#include "settings.h"
#include "storage.h"
#include "sys.h"
#include "util.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PAYLOADS_URL "https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/updates/payloads.json"
#define SETUP_FIRST_DELAY_S 8
#define SETUP_PERIOD_S 600
#define MIN_FREE_BYTES (10LL << 30)

static pthread_mutex_t setup_mu = PTHREAD_MUTEX_INITIALIZER;
static struct { int checked, ok, total; char failing[256]; time_t at; } last;
static time_t boot_at, last_run;
static volatile int running;

typedef struct check { char id[24]; int ok; int warn; char detail[200]; char fix[260]; char action[24]; char actionId[48]; } check;

static int run_checks(check *c, int max) {
  int n = 0;
  settings_t s;
  settings_get(&s);
  /* ShadowMountPlus */
  {
    check *k = &c[n++];
    memset(k, 0, sizeof *k);
    xstrlcpy(k->id, "shadowmount", sizeof k->id);
    int port = cx_local_port("SHADOWMOUNT", 10101);
    k->ok = cx_tcp_probe(port, 400);
    xsnprintf(k->detail, sizeof k->detail, k->ok ? "ShadowMountPlus API is answering on :%d" : "ShadowMountPlus API is not answering on :%d", port);
    xstrlcpy(k->fix, "Load ShadowMountPlus (etaHEN or your payload loader) so downloaded exFAT/FFPFSC dumps appear on the home screen.", sizeof k->fix);
    if (!k->ok) {
      char pid[48];
      if (cx_companions_find_installed("shadowmount", pid, sizeof pid) == 0) { xstrlcpy(k->action, "launch", sizeof k->action); xstrlcpy(k->actionId, pid, sizeof k->actionId); }
    }
  }
  /* DPI */
  {
    check *k = &c[n++];
    memset(k, 0, sizeof *k);
    xstrlcpy(k->id, "dpi", sizeof k->id);
    int port = cx_local_port("DPI", 9040);
    k->ok = cx_tcp_probe(port, 400);
    k->warn = 1;
    xsnprintf(k->detail, sizeof k->detail, k->ok ? "Direct package installer is answering on :%d" : "No package installer daemon on :%d (used as a fallback for PKG installs)", port);
    xstrlcpy(k->fix, "Optional: run the XENO TOOL / ezremote DPI daemon when the built-in AppInstUtil install fails.", sizeof k->fix);
  }
  /* etaHEN DPI */
  {
    check *k = &c[n++];
    memset(k, 0, sizeof *k);
    xstrlcpy(k->id, "etahen", sizeof k->id);
    int port = cx_local_port("ETAHEN", 12800);
    k->ok = cx_tcp_probe(port, 400);
    k->warn = 1;
    xsnprintf(k->detail, sizeof k->detail, k->ok ? "etaHEN DPI is answering on :%d" : "etaHEN DPI is not answering on :%d", port);
    xstrlcpy(k->fix, "Optional: enable the DPI option in etaHEN's config so PKG installs have a second fallback.", sizeof k->fix);
  }
  /* internet */
  {
    check *k = &c[n++];
    memset(k, 0, sizeof *k);
    xstrlcpy(k->id, "internet", sizeof k->id);
    if (!xhttp_available()) { k->ok = 0; xstrlcpy(k->detail, "Network libraries did not load — downloads unavailable on this firmware", sizeof k->detail); }
    else {
      cx_http o = {0};
      o.method = "HEAD";
      o.timeout_ms = 6000;
      o.max_bytes = 4096;
      int status = 0;
      int64_t t0 = util_now_ms();
      char *body = cx_fetch(s.catalogRevisionUrl, &o, &status, NULL, NULL);
      int ms = (int)(util_now_ms() - t0);
      free(body);
      k->ok = status >= 200 && status < 400;
      if (k->ok) xsnprintf(k->detail, sizeof k->detail, "Catalog server reachable (HTTP %d, %d ms)", status, ms);
      else xsnprintf(k->detail, sizeof k->detail, "Cannot reach the catalog server (%s)", status ? "unexpected HTTP status" : xhttp_last_error());
    }
    xstrlcpy(k->fix, "Check the console's network connection (Settings → Network). Browsing the saved catalog still works offline.", sizeof k->fix);
  }
  /* default drive + free space */
  {
    storage_root roots[STORAGE_MAX_ROOTS];
    int nr = storage_get_roots(roots, STORAGE_MAX_ROOTS);
    storage_root *def = NULL;
    for (int i = 0; i < nr; i++) if (roots[i].is_default) def = &roots[i];
    if (!def && nr) def = &roots[0];
    check *k = &c[n++];
    memset(k, 0, sizeof *k);
    xstrlcpy(k->id, "drive", sizeof k->id);
    k->ok = def && def->writable;
    if (def) xsnprintf(k->detail, sizeof k->detail, "%s (%s) is %s", def->label, def->path, def->writable ? "writable" : "read-only");
    else xstrlcpy(k->detail, "No storage drive detected", sizeof k->detail);
    xstrlcpy(k->fix, "Pick a writable drive in Settings → Downloads → Default drive (internal, M.2 or a USB drive).", sizeof k->fix);
    check *f = &c[n++];
    memset(f, 0, sizeof *f);
    xstrlcpy(f->id, "space", sizeof f->id);
    char fr[32];
    util_fmt_bytes(def ? def->free : 0, fr, sizeof fr);
    f->ok = def && def->free >= MIN_FREE_BYTES;
    f->warn = 1;
    xsnprintf(f->detail, sizeof f->detail, "%s free on %s", fr, def ? def->label : "the default drive");
    xstrlcpy(f->fix, "Free up space or choose another drive — most PS5 games need 30–150 GB.", sizeof f->fix);
  }
  /* firmware */
  {
    check *k = &c[n++];
    memset(k, 0, sizeof *k);
    xstrlcpy(k->id, "firmware", sizeof k->id);
    k->ok = 1;
    xsnprintf(k->detail, sizeof k->detail, "Firmware %s. exFAT/FFPFSC dumps mount with ShadowMountPlus; FPKG installs need a firmware with fake-package support (kstuff) and will not work without it.", sys_fw_version());
    xstrlcpy(k->fix, "Prefer image formats (exFAT/FFPFSC) on firmwares without FPKG support.", sizeof k->fix);
  }
  /* payload manager tip */
  {
    check *k = &c[n++];
    memset(k, 0, sizeof *k);
    xstrlcpy(k->id, "payload-manager", sizeof k->id);
    k->ok = 1;
    xstrlcpy(k->detail, "Add XENO STORE to Payload Manager (itsPLK) to start it with one tap, or enable auto-start so it runs after every boot.", sizeof k->detail);
    xsnprintf(k->fix, sizeof k->fix, "Payload Manager → Repositories → add %s", PAYLOADS_URL);
  }
  (void)max;
  return n;
}

static void check_json(jw *w, const check *k) {
  jw_obj_begin(w);
  jw_kv_str(w, "id", k->id);
  jw_kv_bool(w, "ok", k->ok);
  jw_kv_bool(w, "optional", k->warn);
  jw_kv_str(w, "detail", k->detail);
  jw_kv_str(w, "fix", k->fix);
  if (k->action[0]) { jw_kv_str(w, "action", k->action); jw_kv_str(w, "actionId", k->actionId); }
  jw_obj_end(w);
}

static void remember(const check *c, int n) {
  pthread_mutex_lock(&setup_mu);
  last.checked = 1;
  last.ok = 0;
  last.total = n;
  last.failing[0] = 0;
  for (int i = 0; i < n; i++) {
    if (c[i].ok) last.ok++;
    else { if (last.failing[0]) xstrlcat(last.failing, ",", sizeof last.failing); xstrlcat(last.failing, c[i].id, sizeof last.failing); }
  }
  last.at = util_now();
  pthread_mutex_unlock(&setup_mu);
}

void cx_setup_check_json(jw *w) {
  check c[12];
  int n = run_checks(c, 12);
  remember(c, n);
  jw_key(w, "checks");
  jw_arr_begin(w);
  for (int i = 0; i < n; i++) check_json(w, &c[i]);
  jw_arr_end(w);
  jw_kv_str(w, "payloadsUrl", PAYLOADS_URL);
  jw_kv_str(w, "fw", sys_fw_version());
  jw_key(w, "summary");
  cx_setup_summary_json(w);
}

void cx_setup_summary_json(jw *w) {
  pthread_mutex_lock(&setup_mu);
  jw_obj_begin(w);
  jw_kv_bool(w, "checked", last.checked);
  jw_kv_int(w, "ok", last.ok);
  jw_kv_int(w, "total", last.total);
  jw_key(w, "failing"); jw_arr_begin(w);
  char tmp[256];
  xstrlcpy(tmp, last.failing, sizeof tmp);
  for (char *tok = strtok(tmp, ","); tok; tok = strtok(NULL, ",")) jw_str(w, tok);
  jw_arr_end(w);
  jw_kv_i64(w, "at", (int64_t)last.at);
  jw_obj_end(w);
  pthread_mutex_unlock(&setup_mu);
}

static void *bg(void *arg) {
  (void)arg;
  check c[12];
  int n = run_checks(c, 12);
  remember(c, n);
  running = 0;
  return NULL;
}

void cx_setup_init(void) { boot_at = util_now(); }

void cx_setup_tick(void) {
  time_t now = util_now();
  if (running) return;
  if (now - boot_at < SETUP_FIRST_DELAY_S) return;
  if (last_run && now - last_run < SETUP_PERIOD_S) return;
  last_run = now;
  running = 1;
  pthread_t th;
  pthread_attr_t at;
  pthread_attr_init(&at);
  pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
  if (pthread_create(&th, &at, bg, NULL) != 0) running = 0;
  pthread_attr_destroy(&at);
}
