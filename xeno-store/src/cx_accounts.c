/*
 * cx_accounts.c — see cx_accounts.h.
 *
 * Offline-account registry key layout vendored from ps5-payload-dev/offact
 * (GPL-3.0) via this repository's payload/src/profile.c: each kind has a
 * base key for slot 1 and a fixed stride between slots; `fallback` is used
 * when the slot index is out of range. The numeric bases are Sony's
 * registry IDs.
 */
#include "cx_accounts.h"
#include "cx_common.h"
#include "cx_registry.h"
#include "log.h"
#include "util.h"

#include <dirent.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t slot_key(int slot, uint32_t base, uint32_t stride, uint32_t fallback) {
  if (slot < 1 || slot > CX_SLOT_COUNT) return fallback;
  return (uint32_t)(slot - 1) * stride + base;
}

#define KEY_NAME(s) slot_key((s), 125829632u, 65536u, 127140352u)
#define KEY_ID(s) slot_key((s), 125830400u, 65536u, 127141120u)
#define KEY_TYPE(s) slot_key((s), 125874183u, 65536u, 127184903u)
#define KEY_FLAGS(s) slot_key((s), 125831168u, 65536u, 127141888u)

int cx_slot_get_name(int slot, char out[CX_PROFILE_NAME_MAX], uint32_t *err) { return cx_reg_get_str(KEY_NAME(slot), out, CX_PROFILE_NAME_MAX, err); }
int cx_slot_get_id(int slot, uint64_t *out, uint32_t *err) { *out = 0; return cx_reg_get_bin(KEY_ID(slot), out, sizeof(uint64_t), err); }
int cx_slot_get_type(int slot, char out[CX_PROFILE_TYPE_MAX], uint32_t *err) { return cx_reg_get_str(KEY_TYPE(slot), out, CX_PROFILE_TYPE_MAX, err); }
int cx_slot_get_flags(int slot, int *out, uint32_t *err) { return cx_reg_get_int(KEY_FLAGS(slot), out, err); }

uint64_t cx_profile_gen_id(const char *name) {
  /* Verbatim from offact: the `0x5EAF00D / 0xCA7F00D` seed integer-divides
   * to 0 — an upstream quirk kept so derived ids match the reference
   * byte-for-byte. From there it is FNV-1a over the name. */
  uint64_t h = 0x5EAF00D / 0xCA7F00D;
  if (name && *name) {
    while (*name) {
      h = 0x100000001B3ULL * (h ^ (uint8_t)*name);
      name++;
    }
  }
  return h;
}

int cx_slot_activate(int slot, uint64_t id, uint32_t *err) {
  char name[CX_PROFILE_NAME_MAX];
  if (cx_slot_get_name(slot, name, err) != 0 || !name[0]) return -1;
  if (!id) id = cx_profile_gen_id(name);
  if (cx_reg_set_bin(KEY_ID(slot), &id, sizeof id, err) != 0) return -1;
  if (cx_reg_set_str(KEY_TYPE(slot), "np", CX_PROFILE_TYPE_MAX, err) != 0) return -1;
  if (cx_reg_set_int(KEY_FLAGS(slot), CX_PROFILE_DEFAULT_FLAGS, err) != 0) return -1;
  return 0;
}

int cx_slot_clear(int slot, uint32_t *err) {
  uint64_t zero = 0;
  if (cx_reg_set_bin(KEY_ID(slot), &zero, sizeof zero, err) != 0) return -1;
  if (cx_reg_set_int(KEY_FLAGS(slot), 0, err) != 0) return -1;
  return 0;
}

/* ---- users -------------------------------------------------------------- */

#ifndef XENO_HOST
#include <dlfcn.h>
typedef int (*uss_init_fn)(void *params);
typedef int (*uss_get_fg_fn)(int *user_id);
typedef int (*uss_get_name_fn)(int32_t user_id, char *name, size_t size);
typedef int (*uss_get_list_fn)(int *ids);   /* SceUserServiceLoginUserIdList: int userId[4] */
static uss_init_fn g_uss_init;
static uss_get_fg_fn g_uss_fg;
static uss_get_name_fn g_uss_name;
static uss_get_list_fn g_uss_list;
static pthread_once_t g_uss_once = PTHREAD_ONCE_INIT;

static void uss_resolve(void) {
  g_uss_init = (uss_init_fn)dlsym(RTLD_DEFAULT, "sceUserServiceInitialize");
  g_uss_fg = (uss_get_fg_fn)dlsym(RTLD_DEFAULT, "sceUserServiceGetForegroundUser");
  g_uss_name = (uss_get_name_fn)dlsym(RTLD_DEFAULT, "sceUserServiceGetUserName");
  g_uss_list = (uss_get_list_fn)dlsym(RTLD_DEFAULT, "sceUserServiceGetLoginUserIdList");
  if (g_uss_init) g_uss_init(NULL);   /* idempotent */
  if (!g_uss_list) LOGW("accounts: sceUserServiceGetLoginUserIdList missing");
}

int cx_users_list(cx_user *out, int max) {
  pthread_once(&g_uss_once, uss_resolve);
  if (!g_uss_list || max <= 0) return 0;
  int ids[4] = {-1, -1, -1, -1};
  if (g_uss_list(ids) != 0) return 0;
  int fg = -1;
  if (g_uss_fg) g_uss_fg(&fg);
  int n = 0;
  for (int i = 0; i < 4 && n < max; i++) {
    if (ids[i] <= 0) continue;
    memset(&out[n], 0, sizeof out[n]);
    out[n].id = (uint32_t)ids[i];
    char tmp[CX_PROFILE_NAME_MAX + 1] = "";
    if (g_uss_name && g_uss_name(ids[i], tmp, sizeof tmp) == 0) xstrlcpy(out[n].name, tmp, sizeof out[n].name);
    if (!out[n].name[0]) xsnprintf(out[n].name, sizeof out[n].name, "User %x", (unsigned)ids[i]);
    out[n].foreground = ids[i] == fg;
    n++;
  }
  return n;
}

uint32_t cx_user_foreground(void) {
  pthread_once(&g_uss_once, uss_resolve);
  int fg = 0;
  if (!g_uss_fg || g_uss_fg(&fg) != 0 || fg <= 0) return 0;
  return (uint32_t)fg;
}

extern int sceSystemServiceRequestReboot(void);
int cx_reboot(void) {
  LOGI("accounts: reboot requested");
  int rc = sceSystemServiceRequestReboot();
  if (rc != 0) LOGW("sceSystemServiceRequestReboot -> 0x%08x", (unsigned)rc);
  return rc == 0 ? 0 : -1;
}

#else /* ---- host simulation ---------------------------------------------------- */

static pthread_mutex_t users_mu = PTHREAD_MUTEX_INITIALIZER;
static cx_user sim_users[CX_MAX_USERS];
static int n_sim_users, sim_users_loaded;

static void users_path(char *out, size_t cap) { cx_console_path("/users.json", out, cap); }

static void sim_users_load_locked(void) {
  if (sim_users_loaded) return;
  sim_users_loaded = 1;
  char path[700];
  users_path(path, sizeof path);
  jdoc *d = cx_json_file(path, 1 << 20, 5000);
  n_sim_users = 0;
  if (d) {
    JV_FOREACH(it, jv_get(json_root(d), "users")) {
      if (n_sim_users >= CX_MAX_USERS) break;
      int64_t id = jv_get_i64(it, "id", 0);
      if (id <= 0) continue;
      cx_user *u = &sim_users[n_sim_users++];
      memset(u, 0, sizeof *u);
      u->id = (uint32_t)id;
      xstrlcpy(u->name, jv_get_str(it, "name", ""), sizeof u->name);
      u->foreground = jv_get_bool(it, "foreground", 0);
    }
    json_free(d);
  }
  if (n_sim_users == 0) {
    cx_user *u = &sim_users[n_sim_users++];
    memset(u, 0, sizeof *u);
    u->id = 0x179a0cd8u;
    xstrlcpy(u->name, "Player", sizeof u->name);
    u->foreground = 1;
    char dir[700];
    cx_console_path("", dir, sizeof dir);
    util_mkdir_p(dir);
    jw w;
    jw_init(&w);
    jw_obj_begin(&w);
    jw_key(&w, "users"); jw_arr_begin(&w);
    jw_obj_begin(&w); jw_kv_i64(&w, "id", u->id); jw_kv_str(&w, "name", u->name); jw_kv_bool(&w, "foreground", 1); jw_obj_end(&w);
    jw_arr_end(&w);
    jw_obj_end(&w);
    cx_write_json(path, &w);
  }
  int any_fg = 0;
  for (int i = 0; i < n_sim_users; i++) any_fg |= sim_users[i].foreground;
  if (!any_fg) sim_users[0].foreground = 1;
  /* make sure each simulated user has a home directory */
  for (int i = 0; i < n_sim_users; i++) {
    char home[700], dn[16];
    cx_user_dirname(sim_users[i].id, dn, sizeof dn);
    xsnprintf(home, sizeof home, "%s/%s", cx_home_root(), dn);
    util_mkdir_p(home);
  }
}

int cx_users_list(cx_user *out, int max) {
  pthread_mutex_lock(&users_mu);
  sim_users_load_locked();
  int n = n_sim_users < max ? n_sim_users : max;
  for (int i = 0; i < n; i++) out[i] = sim_users[i];
  pthread_mutex_unlock(&users_mu);
  return n;
}

uint32_t cx_user_foreground(void) {
  cx_user u[CX_MAX_USERS];
  int n = cx_users_list(u, CX_MAX_USERS);
  for (int i = 0; i < n; i++) if (u[i].foreground) return u[i].id;
  return n ? u[0].id : 0;
}

int cx_reboot(void) {
  LOGI("accounts: reboot requested (host build: simulated, nothing happens)");
  return 0;
}
#endif

int cx_user_find(uint32_t id, cx_user *out) {
  cx_user u[CX_MAX_USERS];
  int n = cx_users_list(u, CX_MAX_USERS);
  for (int i = 0; i < n; i++) if (u[i].id == id) { if (out) *out = u[i]; return 0; }
  return -1;
}

void cx_user_dirname(uint32_t id, char *out, size_t cap) { xsnprintf(out, cap, "%x", (unsigned)id); }

int cx_user_home(uint32_t id, char *out, size_t cap) {
  /* PS5 user dirs are hex ids (e.g. "179a0cd8"); match by value so a
   * zero-padded or upper-case spelling still resolves. */
  DIR *d = opendir(cx_home_root());
  if (d) {
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
      if (e->d_name[0] == '.') continue;
      char *endp = NULL;
      unsigned long v = strtoul(e->d_name, &endp, 16);
      if (!endp || *endp || v != id) continue;
      xsnprintf(out, cap, "%s/%s", cx_home_root(), e->d_name);
      closedir(d);
      return util_dir_exists(out) ? 0 : -1;
    }
    closedir(d);
  }
  char dn[16];
  cx_user_dirname(id, dn, sizeof dn);
  xsnprintf(out, cap, "%s/%s", cx_home_root(), dn);
  return util_dir_exists(out) ? 0 : -1;
}

void cx_accounts_init(void) {
#ifdef XENO_HOST
  /* Seed the simulated registry slots from the simulated users so the
   * accounts screen has something to activate. */
  cx_user u[CX_MAX_USERS];
  int n = cx_users_list(u, CX_MAX_USERS);
  for (int i = 0; i < n && i < CX_SLOT_COUNT; i++) {
    char name[CX_PROFILE_NAME_MAX] = "";
    cx_slot_get_name(i + 1, name, NULL);
    if (!name[0]) {
      cx_reg_set_str(KEY_NAME(i + 1), u[i].name, CX_PROFILE_NAME_MAX, NULL);
      cx_reg_set_str(KEY_TYPE(i + 1), "local", CX_PROFILE_TYPE_MAX, NULL);
    }
  }
#endif
  LOGI("accounts: registry %s", cx_reg_available() ? "available" : "unavailable on this firmware");
}

void cx_accounts_json(jw *w) {
  cx_user users[CX_MAX_USERS];
  int nu = cx_users_list(users, CX_MAX_USERS);
  uint32_t fg = cx_user_foreground();
  char fgname[CX_PROFILE_NAME_MAX + 1] = "";
  for (int i = 0; i < nu; i++) if (users[i].id == fg) xstrlcpy(fgname, users[i].name, sizeof fgname);
  int supported = cx_reg_available();
  jw_key(w, "slots");
  jw_arr_begin(w);
  for (int slot = 1; supported && slot <= CX_SLOT_COUNT; slot++) {
    char name[CX_PROFILE_NAME_MAX] = "", type[CX_PROFILE_TYPE_MAX] = "";
    uint64_t id = 0;
    int flags = 0;
    uint32_t e1 = 0, e2 = 0, e3 = 0, e4 = 0;
    cx_slot_get_name(slot, name, &e1);
    cx_slot_get_id(slot, &id, &e2);
    cx_slot_get_type(slot, type, &e3);
    cx_slot_get_flags(slot, &flags, &e4);
    char hex[24];
    xsnprintf(hex, sizeof hex, "0x%016llx", (unsigned long long)id);
    jw_obj_begin(w);
    jw_kv_int(w, "slot", slot);
    jw_kv_str(w, "name", name);
    jw_kv_str(w, "id", hex);
    jw_kv_str(w, "type", type);
    jw_kv_int(w, "flags", flags);
    jw_kv_bool(w, "empty", name[0] == 0);
    jw_kv_bool(w, "activated", name[0] && id != 0 && (flags & CX_PROFILE_DEFAULT_FLAGS) != 0);
    jw_kv_bool(w, "foreground", fgname[0] && name[0] && strcmp(fgname, name) == 0);
    char derived[24];
    xsnprintf(derived, sizeof derived, "0x%016llx", (unsigned long long)cx_profile_gen_id(name));
    jw_kv_str(w, "derivedId", derived);
    jw_obj_end(w);
  }
  jw_arr_end(w);
  jw_key(w, "users");
  jw_arr_begin(w);
  for (int i = 0; i < nu; i++) {
    jw_obj_begin(w);
    jw_kv_i64(w, "id", users[i].id);
    jw_kv_str(w, "name", users[i].name);
    jw_kv_bool(w, "foreground", users[i].foreground);
    jw_obj_end(w);
  }
  jw_arr_end(w);
  jw_key(w, "foregroundUser");
  if (fg) { jw_obj_begin(w); jw_kv_i64(w, "id", fg); jw_kv_str(w, "name", fgname); jw_obj_end(w); }
  else jw_null(w);
  jw_kv_bool(w, "supported", supported);
  jw_kv_bool(w, "simulated", cx_is_host());
}

void cx_user_account_id(uint32_t uid, char *out, size_t cap) {
  out[0] = 0;
  cx_user u;
  if (cx_user_find(uid, &u) != 0 || !cx_reg_available()) return;
  for (int slot = 1; slot <= CX_SLOT_COUNT; slot++) {
    char name[CX_PROFILE_NAME_MAX] = "";
    if (cx_slot_get_name(slot, name, NULL) != 0 || strcmp(name, u.name) != 0) continue;
    uint64_t id = 0;
    cx_slot_get_id(slot, &id, NULL);
    if (id) xsnprintf(out, cap, "%016llx", (unsigned long long)id);
    return;
  }
}
