/*
 * cx_library.c — see cx_library.h.
 */
#include "cx_library.h"
#include "catalog.h"
#include "cx_common.h"
#include "dl.h"
#include "log.h"
#include "storage.h"
#include "util.h"

#include <dirent.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define TOKEN_TTL_S 60
#define TOKENS_MAX 8

static pthread_mutex_t tok_mu = PTHREAD_MUTEX_INITIALIZER;
static struct { char token[24]; char titleId[12]; time_t expires; } tokens[TOKENS_MAX];

/* ---- launch ------------------------------------------------------------- */

#ifndef XENO_HOST
#include <dlfcn.h>
typedef int (*lnc_init_fn)(void);
typedef int (*lnc_launch_fn)(const char *titleId, char *argv, void *param);
typedef int (*uss_init_fn)(void *);
typedef int (*aiu_init_fn)(void);
typedef int (*aiu_uninstall_fn)(const char *titleId, int *, int *);

static int native_launch(const char *titleId, char *err, size_t errcap) {
  uss_init_fn uss = (uss_init_fn)dlsym(RTLD_DEFAULT, "sceUserServiceInitialize");
  lnc_init_fn init = (lnc_init_fn)dlsym(RTLD_DEFAULT, "sceLncUtilInitialize");
  lnc_launch_fn launch = (lnc_launch_fn)dlsym(RTLD_DEFAULT, "sceLncUtilLaunchApp");
  if (!launch) { xsnprintf(err, errcap, "sceLncUtilLaunchApp is not available on this firmware — start the game from the home screen"); return -1; }
  if (uss) uss(NULL);
  if (init) init();
  int rc = launch(titleId, NULL, NULL);
  LOGI("library: sceLncUtilLaunchApp(%s) -> 0x%08x", titleId, (unsigned)rc);
  if (rc != 0) { xsnprintf(err, errcap, "the launcher refused (0x%08x) — start the game from the home screen", (unsigned)rc); return -1; }
  return 0;
}

static int native_uninstall(const char *titleId, char *err, size_t errcap) {
  aiu_init_fn init = (aiu_init_fn)dlsym(RTLD_DEFAULT, "sceAppInstUtilInitialize");
  aiu_uninstall_fn un = (aiu_uninstall_fn)dlsym(RTLD_DEFAULT, "sceAppInstUtilAppUnInstall");
  if (!un) { xsnprintf(err, errcap, "sceAppInstUtilAppUnInstall is not available on this firmware — delete the game from Settings → Storage"); return -1; }
  if (init) init();
  int rc = un(titleId, NULL, NULL);
  LOGI("library: sceAppInstUtilAppUnInstall(%s) -> 0x%08x", titleId, (unsigned)rc);
  if (rc != 0) { xsnprintf(err, errcap, "uninstall refused (0x%08x) — delete the game from Settings → Storage", (unsigned)rc); return -1; }
  return 0;
}
#else
static int native_launch(const char *titleId, char *err, size_t errcap) {
  (void)err; (void)errcap;
  char p[700];
  cx_console_path("/launched.json", p, sizeof p);
  jw w;
  jw_init(&w);
  jw_obj_begin(&w);
  jw_kv_str(&w, "titleId", titleId);
  jw_kv_i64(&w, "at", (int64_t)util_now());
  jw_obj_end(&w);
  cx_write_json(p, &w);
  LOGI("library: launch %s (host build: simulated)", titleId);
  return 0;
}

static int native_uninstall(const char *titleId, char *err, size_t errcap) {
  char p[700];
  xsnprintf(p, sizeof p, "%s/%s", storage_user_app_dir(), titleId);
  if (cx_rm_rf(p, 8) != 0) { xsnprintf(err, errcap, "cannot remove %s", p); return -1; }
  xsnprintf(p, sizeof p, "%s/%s", cx_appmeta_root(), titleId);
  cx_rm_rf(p, 8);
  LOGI("library: uninstalled %s (host build: simulated)", titleId);
  return 0;
}
#endif

int cx_library_launch(const char *titleId, jw *w, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  if (!cx_titleid_valid(titleId)) { xsnprintf(err, errcap, "titleId must look like PPSA12345 / CUSA12345"); return -1; }
  if (!storage_title_installed(titleId)) { xstrlcpy(code, "not_installed", ccap); xsnprintf(err, errcap, "%s is not installed", titleId); return -1; }
  if (native_launch(titleId, err, errcap) != 0) { xstrlcpy(code, "launch_failed", ccap); return -1; }
  jw_kv_str(w, "titleId", titleId);
  jw_kv_bool(w, "launched", 1);
  jw_kv_bool(w, "simulated", cx_is_host());
  cat_game g;
  if (catalog_match_titleid(titleId, &g) == 0) jw_kv_str(w, "title", g.title);
  return 0;
}

int cx_library_uninstall(const char *titleId, const char *token, jw *w, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  if (!cx_titleid_valid(titleId)) { xsnprintf(err, errcap, "titleId must look like PPSA12345 / CUSA12345"); return -1; }
  if (!storage_title_installed(titleId)) { xstrlcpy(code, "not_installed", ccap); xsnprintf(err, errcap, "%s is not installed", titleId); return -1; }
  time_t now = util_now();
  pthread_mutex_lock(&tok_mu);
  int ok = 0;
  if (token && *token) {
    for (int i = 0; i < TOKENS_MAX; i++)
      if (tokens[i].token[0] && strcmp(tokens[i].token, token) == 0 && strcmp(tokens[i].titleId, titleId) == 0 && tokens[i].expires >= now) { ok = 1; tokens[i].token[0] = 0; }
  }
  if (!ok) {
    int slot = 0;
    for (int i = 0; i < TOKENS_MAX; i++) if (!tokens[i].token[0] || tokens[i].expires < now) { slot = i; break; }
    util_rand_hex(tokens[slot].token, 16);
    xstrlcpy(tokens[slot].titleId, titleId, sizeof tokens[slot].titleId);
    tokens[slot].expires = now + TOKEN_TTL_S;
    jw_kv_bool(w, "confirmRequired", 1);
    jw_kv_str(w, "token", tokens[slot].token);
    jw_kv_int(w, "expiresIn", TOKEN_TTL_S);
    jw_kv_str(w, "titleId", titleId);
    cat_game g;
    if (catalog_match_titleid(titleId, &g) == 0) jw_kv_str(w, "title", g.title);
    char msg[200];
    xsnprintf(msg, sizeof msg, "Uninstall %s and its saves stay on the console? Send the token back within %d s to confirm.", titleId, TOKEN_TTL_S);
    jw_kv_str(w, "message", msg);
    pthread_mutex_unlock(&tok_mu);
    return 1;
  }
  pthread_mutex_unlock(&tok_mu);
  if (native_uninstall(titleId, err, errcap) != 0) { xstrlcpy(code, "uninstall_failed", ccap); return -1; }
  jw_kv_str(w, "titleId", titleId);
  jw_kv_bool(w, "uninstalled", 1);
  jw_kv_bool(w, "simulated", cx_is_host());
  return 0;
}

/* ---- disk analyzer ------------------------------------------------------ */

typedef struct usage { int64_t dumps, packages, files, saves, partials, games; int npartials; jw *partial_list; } usage;

static void walk(const char *dir, int depth, usage *u, int64_t *bucket) {
  if (depth > 3) return;
  DIR *d = opendir(dir);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    char p[CX_PATH_MAX];
    if (xsnprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= (int)sizeof p - 1) continue;
    struct stat st;
    if (lstat(p, &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) { walk(p, depth + 1, u, bucket); continue; }
    if (!S_ISREG(st.st_mode)) continue;
    if (util_iends_with(e->d_name, ".xpart") || util_iends_with(e->d_name, ".xpart.json")) {
      u->partials += (int64_t)st.st_size;
      if (util_iends_with(e->d_name, ".xpart") && u->partial_list && u->npartials < 200) {
        char jid[32] = "";
        int owned = dl_find_job_by_path(p, jid, sizeof jid) == 0 ? 1 : 0;
        jw_obj_begin(u->partial_list);
        jw_kv_str(u->partial_list, "path", p);
        jw_kv_i64(u->partial_list, "size", (int64_t)st.st_size);
        jw_kv_i64(u->partial_list, "mtime", (int64_t)st.st_mtime);
        if (owned) jw_kv_str(u->partial_list, "jobId", jid);
        jw_obj_end(u->partial_list);
        u->npartials++;
      }
      continue;
    }
    *bucket += (int64_t)st.st_size;
  }
  closedir(d);
}

void cx_library_usage_json(jw *w) {
  storage_root roots[STORAGE_MAX_ROOTS];
  int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
  jw_key(w, "roots");
  jw_arr_begin(w);
  for (int i = 0; i < n; i++) {
    usage u;
    memset(&u, 0, sizeof u);
    jw pl;
    jw_init(&pl);
    jw_arr_begin(&pl);
    u.partial_list = &pl;
    char p[700];
    xsnprintf(p, sizeof p, "%s/homebrew", roots[i].path); walk(p, 0, &u, &u.dumps);
    xsnprintf(p, sizeof p, "%s/xeno-store/pkg", roots[i].path); walk(p, 0, &u, &u.packages);
    xsnprintf(p, sizeof p, "%s/xeno-store/files", roots[i].path); walk(p, 0, &u, &u.files);
    xsnprintf(p, sizeof p, "%s/xeno-store/saves", roots[i].path); u.saves = cx_dir_size(p, 6);
    if (strcmp(roots[i].kind, "internal") == 0) u.games = cx_dir_size(storage_user_app_dir(), 4);
    jw_arr_end(&pl);
    size_t pll;
    char *plt = jw_detach(&pl, &pll);
    jw_obj_begin(w);
    jw_kv_str(w, "path", roots[i].path);
    jw_kv_str(w, "label", roots[i].label);
    jw_kv_str(w, "kind", roots[i].kind);
    jw_kv_i64(w, "free", roots[i].free);
    jw_kv_i64(w, "total", roots[i].total);
    jw_kv_i64(w, "used", roots[i].total > roots[i].free ? roots[i].total - roots[i].free : 0);
    jw_kv_bool(w, "default", roots[i].is_default);
    jw_key(w, "categories"); jw_obj_begin(w);
    jw_kv_i64(w, "games", u.games);
    jw_kv_i64(w, "dumps", u.dumps);
    jw_kv_i64(w, "packages", u.packages);
    jw_kv_i64(w, "files", u.files);
    jw_kv_i64(w, "saves", u.saves);
    jw_kv_i64(w, "partials", u.partials);
    jw_obj_end(w);
    jw_kv_i64(w, "xenoTotal", u.dumps + u.packages + u.files + u.saves + u.partials);
    jw_key(w, "partials");
    if (plt) jw_raw(w, plt, pll); else { jw_arr_begin(w); jw_arr_end(w); }
    free(plt);
    jw_obj_end(w);
  }
  jw_arr_end(w);
  jw_kv_i64(w, "scannedAt", (int64_t)util_now());
}

static void clean_dir(const char *dir, int depth, jw *removed, jw *skipped, int64_t *freed, int *nr) {
  if (depth > 3) return;
  DIR *d = opendir(dir);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    char p[CX_PATH_MAX];
    if (xsnprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= (int)sizeof p - 1) continue;
    struct stat st;
    if (lstat(p, &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) { clean_dir(p, depth + 1, removed, skipped, freed, nr); continue; }
    if (!S_ISREG(st.st_mode) || !util_iends_with(e->d_name, ".xpart")) continue;
    char jid[32];
    if (dl_find_job_by_path(p, jid, sizeof jid) == 0) { jw_str(skipped, p); continue; }
    char side[CX_PATH_MAX + 8];
    xsnprintf(side, sizeof side, "%s.json", p);
    int64_t sz = (int64_t)st.st_size + (util_file_size(side) > 0 ? util_file_size(side) : 0);
    if (util_unlink_quiet(p) == 0) { util_unlink_quiet(side); jw_str(removed, p); *freed += sz; (*nr)++; }
  }
  closedir(d);
}

int cx_library_clean_partials(const char *root, jw *w, char *err, size_t errcap) {
  storage_root roots[STORAGE_MAX_ROOTS];
  int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
  if (root && *root && storage_find_root(root, NULL) != 0) { xsnprintf(err, errcap, "unknown storage root"); return -1; }
  jw removed, skipped;
  jw_init(&removed); jw_arr_begin(&removed);
  jw_init(&skipped); jw_arr_begin(&skipped);
  int64_t freed = 0;
  int nr = 0;
  for (int i = 0; i < n; i++) {
    if (root && *root && strcmp(roots[i].path, root) != 0) continue;
    const char *subs[3] = {"homebrew", "xeno-store/pkg", "xeno-store/files"};
    for (int k = 0; k < 3; k++) { char p[700]; xsnprintf(p, sizeof p, "%s/%s", roots[i].path, subs[k]); clean_dir(p, 0, &removed, &skipped, &freed, &nr); }
  }
  jw_arr_end(&removed); jw_arr_end(&skipped);
  size_t l1, l2;
  char *t1 = jw_detach(&removed, &l1), *t2 = jw_detach(&skipped, &l2);
  jw_key(w, "removed"); if (t1) jw_raw(w, t1, l1); else { jw_arr_begin(w); jw_arr_end(w); }
  jw_key(w, "skipped"); if (t2) jw_raw(w, t2, l2); else { jw_arr_begin(w); jw_arr_end(w); }
  free(t1); free(t2);
  jw_kv_int(w, "removedCount", nr);
  jw_kv_i64(w, "freed", freed);
  LOGI("library: cleaned %d partial(s), freed %lld bytes", nr, (long long)freed);
  return 0;
}
