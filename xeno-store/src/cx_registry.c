/*
 * cx_registry.c — see cx_registry.h.
 *
 * PS5 sceRegMgr wrappers ported from payload/src/sys_registry.c (ps5upload,
 * GPL-3.0). Function pointer types match Sony's libSceRegMgr exports; the
 * `size` argument on the Set variants is part of Sony's signature.
 */
#include "cx_registry.h"
#include "cx_common.h"
#include "json.h"
#include "log.h"
#include "util.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef XENO_HOST
#include <dlfcn.h>

typedef int (*regmgr_get_int_fn)(uint32_t key, int *out_val);
typedef int (*regmgr_set_int_fn)(uint32_t key, int val);
typedef int (*regmgr_get_str_fn)(uint32_t key, char *buf, int buf_size);
typedef int (*regmgr_set_str_fn)(uint32_t key, const char *buf, size_t len);
typedef int (*regmgr_get_bin_fn)(uint32_t key, void *buf, size_t buf_size);
typedef int (*regmgr_set_bin_fn)(uint32_t key, const void *buf, size_t len);

static regmgr_get_int_fn g_get_int;
static regmgr_set_int_fn g_set_int;
static regmgr_get_str_fn g_get_str;
static regmgr_set_str_fn g_set_str;
static regmgr_get_bin_fn g_get_bin;
static regmgr_set_bin_fn g_set_bin;
static pthread_once_t g_once = PTHREAD_ONCE_INIT;

static void resolve_impl(void) {
  /* RTLD_DEFAULT walks every loaded SPRX: on some firmwares libSceRegMgr is
   * reached through SceShellCore, not as a direct dependency, so a targeted
   * dlopen would fail while the default scope still finds the symbols. */
  g_get_int = (regmgr_get_int_fn)dlsym(RTLD_DEFAULT, "sceRegMgrGetInt");
  g_set_int = (regmgr_set_int_fn)dlsym(RTLD_DEFAULT, "sceRegMgrSetInt");
  g_get_str = (regmgr_get_str_fn)dlsym(RTLD_DEFAULT, "sceRegMgrGetStr");
  g_set_str = (regmgr_set_str_fn)dlsym(RTLD_DEFAULT, "sceRegMgrSetStr");
  g_get_bin = (regmgr_get_bin_fn)dlsym(RTLD_DEFAULT, "sceRegMgrGetBin");
  g_set_bin = (regmgr_set_bin_fn)dlsym(RTLD_DEFAULT, "sceRegMgrSetBin");
  if (!g_get_str || !g_set_bin) LOGW("registry: sceRegMgr symbols missing on this firmware (accounts unavailable)");
}

static void resolve_once(void) { pthread_once(&g_once, resolve_impl); }

int cx_reg_available(void) {
  resolve_once();
  return g_get_int && g_set_int && g_get_str && g_set_str && g_get_bin && g_set_bin;
}

int cx_reg_get_int(uint32_t key, int *out, uint32_t *err) {
  if (!out) { if (err) *err = CX_REG_ERR_NULL_ARG; return -1; }
  resolve_once();
  if (!g_get_int) { if (err) *err = CX_REG_ERR_NO_SYMBOL; return -1; }
  *out = 0;
  int rc = g_get_int(key, out);
  if (err) *err = (uint32_t)rc;
  return rc == 0 ? 0 : -1;
}

int cx_reg_set_int(uint32_t key, int val, uint32_t *err) {
  resolve_once();
  if (!g_set_int) { if (err) *err = CX_REG_ERR_NO_SYMBOL; return -1; }
  int rc = g_set_int(key, val);
  if (err) *err = (uint32_t)rc;
  return rc == 0 ? 0 : -1;
}

int cx_reg_get_str(uint32_t key, char *buf, size_t cap, uint32_t *err) {
  if (!buf || cap == 0) { if (err) *err = CX_REG_ERR_NULL_ARG; return -1; }
  if (cap > 0x7FFFFFFFU) { if (err) *err = CX_REG_ERR_BUFFER_TOO_SMALL; return -1; }
  resolve_once();
  if (!g_get_str) { if (err) *err = CX_REG_ERR_NO_SYMBOL; return -1; }
  buf[0] = 0;
  int rc = g_get_str(key, buf, (int)cap);
  buf[cap - 1] = 0;   /* defence in depth: Sony's wrapper should NUL-pad */
  if (err) *err = (uint32_t)rc;
  return rc == 0 ? 0 : -1;
}

int cx_reg_set_str(uint32_t key, const char *buf, size_t len, uint32_t *err) {
  if (!buf) { if (err) *err = CX_REG_ERR_NULL_ARG; return -1; }
  resolve_once();
  if (!g_set_str) { if (err) *err = CX_REG_ERR_NO_SYMBOL; return -1; }
  int rc = g_set_str(key, buf, len);
  if (err) *err = (uint32_t)rc;
  return rc == 0 ? 0 : -1;
}

int cx_reg_get_bin(uint32_t key, void *buf, size_t cap, uint32_t *err) {
  if (!buf || cap == 0) { if (err) *err = CX_REG_ERR_NULL_ARG; return -1; }
  resolve_once();
  if (!g_get_bin) { if (err) *err = CX_REG_ERR_NO_SYMBOL; return -1; }
  int rc = g_get_bin(key, buf, cap);
  if (err) *err = (uint32_t)rc;
  return rc == 0 ? 0 : -1;
}

int cx_reg_set_bin(uint32_t key, const void *buf, size_t len, uint32_t *err) {
  if (!buf || len == 0) { if (err) *err = CX_REG_ERR_NULL_ARG; return -1; }
  resolve_once();
  if (!g_set_bin) { if (err) *err = CX_REG_ERR_NO_SYMBOL; return -1; }
  int rc = g_set_bin(key, buf, len);
  if (err) *err = (uint32_t)rc;
  return rc == 0 ? 0 : -1;
}

#else /* ---- host simulation: <data>/sim/registry.json ------------------------ */

#define SIM_MAX_KEYS 256
typedef struct sim_entry { uint32_t key; char type[4]; char str[64]; int ival; uint8_t bin[32]; size_t blen; } sim_entry;
static pthread_mutex_t sim_mu = PTHREAD_MUTEX_INITIALIZER;
static sim_entry sim[SIM_MAX_KEYS];
static int n_sim, sim_loaded;

static void sim_path(char *out, size_t cap) { cx_console_path("/registry.json", out, cap); }

static void sim_load_locked(void) {
  if (sim_loaded) return;
  sim_loaded = 1;
  char path[700];
  sim_path(path, sizeof path);
  jdoc *d = cx_json_file(path, 1 << 20, 20000);
  if (!d) return;
  JV_FOREACH(it, jv_get(json_root(d), "keys")) {
    if (n_sim >= SIM_MAX_KEYS) break;
    const char *k = jv_key(it);
    int64_t key = 0;
    if (!k || util_parse_i64(k, &key) != 0) continue;
    sim_entry *e = &sim[n_sim];
    memset(e, 0, sizeof *e);
    e->key = (uint32_t)key;
    xstrlcpy(e->type, jv_get_str(it, "t", "str"), sizeof e->type);
    xstrlcpy(e->str, jv_get_str(it, "s", ""), sizeof e->str);
    e->ival = (int)jv_get_i64(it, "i", 0);
    const char *hex = jv_get_str(it, "b", "");
    size_t hl = strlen(hex);
    for (size_t i = 0; i + 1 < hl && e->blen < sizeof e->bin; i += 2) {
      unsigned v;
      if (sscanf(hex + i, "%2x", &v) != 1) break;
      e->bin[e->blen++] = (uint8_t)v;
    }
    n_sim++;
  }
  json_free(d);
}

static void sim_save_locked(void) {
  char path[700];
  sim_path(path, sizeof path);
  char dir[700];
  cx_console_path("", dir, sizeof dir);
  util_mkdir_p(dir);
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_key(&w, "keys"); jw_obj_begin(&w);
  for (int i = 0; i < n_sim; i++) {
    char k[16];
    xsnprintf(k, sizeof k, "%u", sim[i].key);
    jw_key(&w, k); jw_obj_begin(&w);
    jw_kv_str(&w, "t", sim[i].type);
    jw_kv_str(&w, "s", sim[i].str);
    jw_kv_int(&w, "i", sim[i].ival);
    char hex[80];
    util_hex(sim[i].bin, sim[i].blen, hex, sizeof hex);
    jw_kv_str(&w, "b", hex);
    jw_obj_end(&w);
  }
  jw_obj_end(&w);
  jw_obj_end(&w);
  cx_write_json(path, &w);
}

static sim_entry *sim_find_locked(uint32_t key, int create) {
  for (int i = 0; i < n_sim; i++) if (sim[i].key == key) return &sim[i];
  if (!create || n_sim >= SIM_MAX_KEYS) return NULL;
  sim_entry *e = &sim[n_sim++];
  memset(e, 0, sizeof *e);
  e->key = key;
  return e;
}

int cx_reg_available(void) { return 1; }

int cx_reg_get_int(uint32_t key, int *out, uint32_t *err) {
  if (!out) { if (err) *err = CX_REG_ERR_NULL_ARG; return -1; }
  pthread_mutex_lock(&sim_mu);
  sim_load_locked();
  sim_entry *e = sim_find_locked(key, 0);
  *out = e ? e->ival : 0;
  pthread_mutex_unlock(&sim_mu);
  if (err) *err = 0;
  return 0;
}

int cx_reg_set_int(uint32_t key, int val, uint32_t *err) {
  pthread_mutex_lock(&sim_mu);
  sim_load_locked();
  sim_entry *e = sim_find_locked(key, 1);
  if (e) { xstrlcpy(e->type, "int", sizeof e->type); e->ival = val; sim_save_locked(); }
  pthread_mutex_unlock(&sim_mu);
  if (err) *err = e ? 0 : 1;
  return e ? 0 : -1;
}

int cx_reg_get_str(uint32_t key, char *buf, size_t cap, uint32_t *err) {
  if (!buf || cap == 0) { if (err) *err = CX_REG_ERR_NULL_ARG; return -1; }
  pthread_mutex_lock(&sim_mu);
  sim_load_locked();
  sim_entry *e = sim_find_locked(key, 0);
  xstrlcpy(buf, e ? e->str : "", cap);
  pthread_mutex_unlock(&sim_mu);
  if (err) *err = 0;
  return 0;
}

int cx_reg_set_str(uint32_t key, const char *buf, size_t len, uint32_t *err) {
  if (!buf) { if (err) *err = CX_REG_ERR_NULL_ARG; return -1; }
  pthread_mutex_lock(&sim_mu);
  sim_load_locked();
  sim_entry *e = sim_find_locked(key, 1);
  if (e) {
    xstrlcpy(e->type, "str", sizeof e->type);
    size_t n = strnlen(buf, len);
    if (n >= sizeof e->str) n = sizeof e->str - 1;
    memcpy(e->str, buf, n);
    e->str[n] = 0;
    sim_save_locked();
  }
  pthread_mutex_unlock(&sim_mu);
  if (err) *err = e ? 0 : 1;
  return e ? 0 : -1;
}

int cx_reg_get_bin(uint32_t key, void *buf, size_t cap, uint32_t *err) {
  if (!buf || cap == 0) { if (err) *err = CX_REG_ERR_NULL_ARG; return -1; }
  pthread_mutex_lock(&sim_mu);
  sim_load_locked();
  sim_entry *e = sim_find_locked(key, 0);
  memset(buf, 0, cap);
  if (e) memcpy(buf, e->bin, e->blen < cap ? e->blen : cap);
  pthread_mutex_unlock(&sim_mu);
  if (err) *err = 0;
  return 0;
}

int cx_reg_set_bin(uint32_t key, const void *buf, size_t len, uint32_t *err) {
  if (!buf || len == 0) { if (err) *err = CX_REG_ERR_NULL_ARG; return -1; }
  pthread_mutex_lock(&sim_mu);
  sim_load_locked();
  sim_entry *e = sim_find_locked(key, 1);
  if (e) {
    xstrlcpy(e->type, "bin", sizeof e->type);
    e->blen = len < sizeof e->bin ? len : sizeof e->bin;
    memcpy(e->bin, buf, e->blen);
    sim_save_locked();
  }
  pthread_mutex_unlock(&sim_mu);
  if (err) *err = e ? 0 : 1;
  return e ? 0 : -1;
}
#endif
