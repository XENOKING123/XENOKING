/*
 * launcher_icon.c — the deep-link home-screen icon (SPEC §12).
 *
 * XENO STORE runs as a payload, but a payload leaves nothing on the "Games"
 * row. This installs a tiny shortcut app, XENO00002, whose param.json carries
 * a deeplinkUri of http://127.0.0.1:9095/ — pressing the icon opens the store
 * in the PS5 browser. The shortcut is metadata only: it has no eboot.bin and
 * never touches the system volume, exactly like Payload Manager's own icon.
 *
 * The icon PNG and app metadata are written under /user/app/XENO00002, then
 * the title is registered with libSceAppInstUtil's per-title installer
 * (install_title, NID Wudg3Xe3heE), resolved at runtime via the kernel's
 * dynamic linker with a dlsym() fallback, and a whole-directory rescan
 * (sceAppInstUtilAppInstallAll) when the per-title call is unavailable.
 *
 * Every Sony symbol is resolved at runtime and guarded: a missing one only
 * skips registration (the files stay on disk, so the shell still picks the
 * icon up on its next /user/app scan) and never crashes the server. The
 * outcome is recorded in <data_dir>/launcher.json. On the host build the whole
 * function is a logged no-op.
 *
 * This needs no kstuff or ShadowMountPlus. It only needs the app-install
 * library loaded, which the PS5 link line forces with
 * `-Wl,--no-as-needed -lSceIpmi -lSceAppInstUtil`.
 */
#include "launcher_icon.h"

#include "assets.h"   /* xs_icon_png (512x512 PNG embedded by gen_assets.py) */
#include "config.h"
#include "json.h"
#include "log.h"
#include "sys.h"
#include "util.h"

#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#define LI_TITLE_ID   "XENO00002"
#define LI_APP_PARENT "/user/app/"
#define LI_APP_DIR    "/user/app/" LI_TITLE_ID
#define LI_CONTENT_ID "IV0000-" LI_TITLE_ID "_00-XENOKINGSTORE001"
#define LI_DEEPLINK   "http://127.0.0.1:9095/"
#define LI_TITLE_NAME "XENO STORE"

/* The shortcut's param.json. applicationCategoryType 65536 (0x10000) marks a
 * deep-link shortcut rather than a full application. */
static char *build_param_json(size_t *out_len) {
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_kv_int(&w, "applicationCategoryType", 65536);
  jw_kv_str(&w, "titleId", LI_TITLE_ID);
  jw_kv_str(&w, "contentId", LI_CONTENT_ID);
  jw_kv_str(&w, "contentVersion", "01.00");
  jw_kv_str(&w, "masterVersion", "01.00");
  jw_kv_str(&w, "deeplinkUri", LI_DEEPLINK);
  jw_key(&w, "localizedParameters");
  jw_obj_begin(&w);
  jw_kv_str(&w, "defaultLanguage", "en-US");
  jw_key(&w, "en-US");
  jw_obj_begin(&w);
  jw_kv_str(&w, "titleName", LI_TITLE_NAME);
  jw_obj_end(&w);
  jw_obj_end(&w);
  jw_kv_str(&w, "applicationDrmType", "free");
  jw_kv_int(&w, "attribute", 0);
  jw_kv_int(&w, "parentalLevel", 0);
  jw_obj_end(&w);
  return jw_detach(&w, out_len);   /* NULL on OOM */
}

/* Records the result so the UI and support can see what happened. Never fatal. */
static void write_state(int files_ok, int registered, const char *method,
                        unsigned appinst_result, const char *error) {
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_kv_str(&w, "titleId", LI_TITLE_ID);
  jw_kv_str(&w, "path", LI_APP_DIR);
  jw_kv_str(&w, "deeplinkUri", LI_DEEPLINK);
  jw_kv_bool(&w, "filesWritten", files_ok);
  jw_kv_bool(&w, "registered", registered);
  jw_kv_str(&w, "method", method);
  char hex[16];
  xsnprintf(hex, sizeof hex, "0x%08x", appinst_result);
  jw_kv_str(&w, "appInstResult", hex);
  jw_kv_str(&w, "platform", sys_platform());
  jw_kv_str(&w, "error", error ? error : "");
  char ts[32];
  util_iso8601(util_now(), ts, sizeof ts);
  jw_kv_str(&w, "generatedAt", ts);
  jw_obj_end(&w);
  size_t len = 0;
  char *json = jw_detach(&w, &len);
  if (!json) return;
  char path[640];
  xsnprintf(path, sizeof path, "%s/launcher.json", g_cfg.data_dir);
  util_write_file_atomic(path, json, len);
  free(json);
}

#ifndef XENO_HOST
#include <dlfcn.h>
#include <ps5/kernel.h>
#include <stdint.h>

typedef int (*install_title_fn)(const char *title_id, const char *parent, void *opt);
typedef int (*appinst_void_fn)(void);
typedef int (*appinst_ptr_fn)(void *);

/* install_title is addressed by NID — it has no linkable export name. Resolve
 * it through the kernel's view of libSceAppInstUtil.sprx first, then fall back
 * to the runtime linker's loaded symbol table. */
static install_title_fn resolve_install_title(void) {
  install_title_fn fn = NULL;
  uint32_t handle = 0;
  if (kernel_dynlib_handle(-1, "libSceAppInstUtil.sprx", &handle) == 0 && handle)
    fn = (install_title_fn)kernel_dynlib_resolve(-1, handle, "Wudg3Xe3heE");
  if (!fn)
    fn = (install_title_fn)dlsym(RTLD_DEFAULT, "Wudg3Xe3heE");
  return fn;
}

/* Writes one owned file atomically; returns 0 on success. */
static int write_app_file(const char *rel, const void *data, size_t len) {
  char path[640];
  xsnprintf(path, sizeof path, "%s/%s", LI_APP_DIR, rel);
  if (util_write_file_atomic(path, data, len) != 0) {
    LOGW("launcher icon: cannot write %s", path);
    return -1;
  }
  return 0;
}

int launcher_icon_register(void) {
  /* 1. Stage the shortcut's files under /user/app/XENO00002. */
  if (util_mkdir_p(LI_APP_DIR "/sce_sys") != 0) {
    LOGW("launcher icon: cannot create %s/sce_sys", LI_APP_DIR);
    write_state(0, 0, "none", 0, "mkdir /user/app failed");
    return -1;
  }
  size_t param_len = 0;
  char *param = build_param_json(&param_len);
  if (!param) {
    write_state(0, 0, "none", 0, "param.json build failed");
    return -1;
  }
  int files_ok = (write_app_file("sce_sys/param.json", param, param_len) == 0);
  free(param);
  if (files_ok && xs_icon_png.data && xs_icon_png.len)
    files_ok = (write_app_file("sce_sys/icon0.png", xs_icon_png.data, xs_icon_png.len) == 0);
  if (!files_ok) {
    write_state(0, 0, "none", 0, "write app files failed");
    return -1;
  }
  LOGI("launcher icon: wrote %s (deeplink %s)", LI_APP_DIR, LI_DEEPLINK);

  /* 2. Register the title with the shell. Each Sony symbol is optional. */
  appinst_void_fn init = (appinst_void_fn)dlsym(RTLD_DEFAULT, "sceAppInstUtilInitialize");
  appinst_void_fn term = (appinst_void_fn)dlsym(RTLD_DEFAULT, "sceAppInstUtilTerminate");
  appinst_ptr_fn install_all = (appinst_ptr_fn)dlsym(RTLD_DEFAULT, "sceAppInstUtilAppInstallAll");
  install_title_fn install_title = resolve_install_title();
  const char *method = install_title ? "title-directory" : (install_all ? "app-scan" : "none");

  if (!init || (!install_title && !install_all)) {
    LOGW("launcher icon: app-install symbols unavailable — files staged, shell will rescan");
    write_state(1, 0, method, 0, "app-install symbols unavailable");
    return 0;   /* files are on disk; the icon appears on the next shell scan */
  }

  int rc = init();
  if (rc != 0) {
    LOGW("launcher icon: sceAppInstUtilInitialize -> 0x%08x", (unsigned)rc);
    write_state(1, 0, method, (unsigned)rc, "AppInstUtil init failed");
    return 0;
  }
  if (install_title)
    rc = install_title(LI_TITLE_ID, LI_APP_PARENT, NULL);
  else
    rc = install_all(NULL);
  if (term) term();

  if (rc == 0) {
    LOGI("launcher icon: registered %s via %s", LI_TITLE_ID, method);
    sys_toast("XENO STORE added to your home screen");
    write_state(1, 1, method, 0, "");
  } else {
    LOGW("launcher icon: registration (%s) -> 0x%08x", method, (unsigned)rc);
    write_state(1, 0, method, (unsigned)rc, "registration call returned non-zero");
  }
  return 0;
}

#else /* XENO_HOST */

int launcher_icon_register(void) {
  /* No PS5 shell on the host: a pure logged no-op, no files touched. */
  (void)build_param_json;
  (void)write_state;
  LOGI("launcher icon: host build — deep-link registration skipped (no-op)");
  return 0;
}

#endif /* XENO_HOST */
