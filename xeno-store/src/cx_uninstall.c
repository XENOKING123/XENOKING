/*
 * cx_uninstall.c — see cx_uninstall.h. Nothing here takes a path from the
 * client: the uninstall set is fixed, and the ghost cleaner only deletes a
 * folder name that was listed by the previous call and confirmed twice.
 */
#include "cx_uninstall.h"
#include "config.h"
#include "cx_common.h"
#include "log.h"
#include "storage.h"
#include "util.h"

#include <dirent.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define HB_MAX 256
static pthread_mutex_t hb_mu = PTHREAD_MUTEX_INITIALIZER;
static char hb_names[HB_MAX][256];
static int n_hb;

static void arr_path(jw *w, const char *p) { jw_str(w, p); }

/* Download files recorded by finished jobs (queue.json is the engine's own
 * persisted state; only paths it owns are deleted). */
static void delete_recorded_downloads(jw *removed, jw *failed, int *nr, int *nf) {
  char qp[700];
  xsnprintf(qp, sizeof qp, "%s/queue.json", g_cfg.data_dir);
  jdoc *d = cx_json_file(qp, 16u << 20, 200000);
  if (!d) return;
  storage_root roots[STORAGE_MAX_ROOTS];
  int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
  JV_FOREACH(j, jv_get(json_root(d), "jobs")) {
    const char *path = jv_get_str(j, "path", "");
    if (!cx_path_is_clean(path)) continue;
    int under = 0;
    for (int i = 0; i < n; i++) {
      char hb[600], xs[600];
      xsnprintf(hb, sizeof hb, "%s/homebrew/", roots[i].path);
      xsnprintf(xs, sizeof xs, "%s/xeno-store/", roots[i].path);
      if (cx_path_under(path, hb) || cx_path_under(path, xs)) under = 1;
    }
    if (!under) continue;
    const char *cands[3] = {path, NULL, NULL};
    char xpart[1100], side[1100];
    xsnprintf(xpart, sizeof xpart, "%s.xpart", path);
    xsnprintf(side, sizeof side, "%s.xpart.json", path);
    cands[1] = xpart;
    cands[2] = side;
    for (int i = 0; i < 3; i++) {
      if (!util_file_exists(cands[i])) continue;
      if (util_unlink_quiet(cands[i]) == 0) { arr_path(removed, cands[i]); (*nr)++; }
      else { arr_path(failed, cands[i]); (*nf)++; }
    }
  }
  json_free(d);
}

int cx_uninstall(int data, int homebrew, int payload_manager, int downloads, jw *w) {
  jw removed, kept, failed;
  jw_init(&removed); jw_arr_begin(&removed);
  jw_init(&kept); jw_arr_begin(&kept);
  jw_init(&failed); jw_arr_begin(&failed);
  int nr = 0, nf = 0;
  char hb_app[700];
  xsnprintf(hb_app, sizeof hb_app, "%s/XENO-STORE", cx_data_homebrew_dir());
  if (homebrew) {
    if (util_dir_exists(hb_app)) { if (cx_rm_rf(hb_app, 6) == 0) { arr_path(&removed, hb_app); nr++; } else { arr_path(&failed, hb_app); nf++; } }
  } else arr_path(&kept, hb_app);
  /* Payload Manager copy: only one we recorded ourselves */
  char pm_marker[700];
  xsnprintf(pm_marker, sizeof pm_marker, "%s/payload-manager.json", g_cfg.data_dir);
  if (payload_manager) {
    jdoc *d = cx_json_file(pm_marker, 1 << 16, 100);
    if (d) {
      const char *p = jv_get_str(json_root(d), "path", "");
      if (cx_path_is_clean(p) && util_file_exists(p) && util_iends_with(p, ".elf")) {
        if (util_unlink_quiet(p) == 0) { arr_path(&removed, p); nr++; } else { arr_path(&failed, p); nf++; }
      }
      json_free(d);
      util_unlink_quiet(pm_marker);
    }
  }
  if (downloads) {
    delete_recorded_downloads(&removed, &failed, &nr, &nf);
    storage_root roots[STORAGE_MAX_ROOTS];
    int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
    for (int i = 0; i < n; i++) {
      const char *subs[2] = {"xeno-store/pkg", "xeno-store/files"};
      for (int k = 0; k < 2; k++) {
        char p[700];
        xsnprintf(p, sizeof p, "%s/%s", roots[i].path, subs[k]);
        if (!util_dir_exists(p)) continue;
        if (cx_rm_rf(p, 4) == 0) { arr_path(&removed, p); nr++; } else { arr_path(&failed, p); nf++; }
      }
      char sv[700];
      xsnprintf(sv, sizeof sv, "%s/xeno-store/saves", roots[i].path);
      if (util_dir_exists(sv)) arr_path(&kept, sv);   /* save backups are never deleted */
    }
  } else {
    storage_root roots[STORAGE_MAX_ROOTS];
    int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
    for (int i = 0; i < n; i++) { char p[700]; xsnprintf(p, sizeof p, "%s/xeno-store", roots[i].path); if (util_dir_exists(p)) arr_path(&kept, p); }
  }
  if (data) {
    /* the data dir itself (settings, queue, caches, logs); done last */
#ifdef XENO_HOST
    /* Host layout keeps the default download root and the console
     * simulation below the data dir; on the PS5 those live elsewhere. */
    int rc = 0;
    DIR *d = opendir(g_cfg.data_dir);
    if (!d) rc = -1;
    else {
      struct dirent *e;
      while ((e = readdir(d)) != NULL) {
        if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0 || strcmp(e->d_name, "downloads") == 0 || strcmp(e->d_name, "sim") == 0 || strcmp(e->d_name, "user") == 0) continue;
        char p[1024];
        if (xsnprintf(p, sizeof p, "%s/%s", g_cfg.data_dir, e->d_name) >= (int)sizeof p - 1) { rc = -1; continue; }
        if (cx_rm_rf(p, 8) != 0) rc = -1;
      }
      closedir(d);
    }
    if (rc == 0) { arr_path(&removed, g_cfg.data_dir); nr++; } else { arr_path(&failed, g_cfg.data_dir); nf++; }
#else
    if (cx_rm_rf(g_cfg.data_dir, 8) == 0) { arr_path(&removed, g_cfg.data_dir); nr++; }
    else { arr_path(&failed, g_cfg.data_dir); nf++; }
#endif
  } else arr_path(&kept, g_cfg.data_dir);
  jw_arr_end(&removed); jw_arr_end(&kept); jw_arr_end(&failed);
  size_t l1, l2, l3;
  char *t1 = jw_detach(&removed, &l1), *t2 = jw_detach(&kept, &l2), *t3 = jw_detach(&failed, &l3);
  jw_key(w, "removed"); if (t1) jw_raw(w, t1, l1); else { jw_arr_begin(w); jw_arr_end(w); }
  jw_key(w, "kept"); if (t2) jw_raw(w, t2, l2); else { jw_arr_begin(w); jw_arr_end(w); }
  jw_key(w, "failed"); if (t3) jw_raw(w, t3, l3); else { jw_arr_begin(w); jw_arr_end(w); }
  free(t1); free(t2); free(t3);
  jw_kv_int(w, "removedCount", nr);
  jw_kv_int(w, "failedCount", nf);
  jw_kv_bool(w, "stopping", 1);
  LOGI("uninstall: removed %d path(s), %d failed (data=%d homebrew=%d pm=%d downloads=%d)", nr, nf, data, homebrew, payload_manager, downloads);
  return 0;
}

/* ---- ghost icon cleaner ------------------------------------------------- */

void cx_homebrew_dirs_json(jw *w) {
  const char *base = cx_data_homebrew_dir();
  pthread_mutex_lock(&hb_mu);
  n_hb = 0;
  jw_key(w, "dirs");
  jw_arr_begin(w);
  DIR *d = opendir(base);
  if (d) {
    struct dirent *e;
    while ((e = readdir(d)) != NULL && n_hb < HB_MAX) {
      if (e->d_name[0] == '.') continue;
      char p[1024];
      if (xsnprintf(p, sizeof p, "%s/%s", base, e->d_name) >= (int)sizeof p - 1) continue;
      struct stat st;
      if (stat(p, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
      char eboot[1100], icon[1100], param[1100];
      xsnprintf(eboot, sizeof eboot, "%s/eboot.bin", p);
      xsnprintf(icon, sizeof icon, "%s/sce_sys/icon0.png", p);
      xsnprintf(param, sizeof param, "%s/sce_sys/param.json", p);
      char title[128] = "";
      jdoc *pj = cx_json_file(param, 1 << 16, 2000);
      if (pj) {
        jv lt = jv_get(json_root(pj), "localizedParameters");
        const char *t = jv_get_str(jv_get(lt, "en-US"), "titleName", "");
        if (!*t) t = jv_get_str(json_root(pj), "titleName", "");
        xstrlcpy(title, t, sizeof title);
        json_free(pj);
      }
      jw_obj_begin(w);
      jw_kv_str(w, "name", e->d_name);
      jw_kv_str(w, "path", p);
      jw_kv_str(w, "title", title);
      jw_kv_i64(w, "size", cx_dir_size(p, 6));
      jw_kv_bool(w, "hasEboot", util_file_exists(eboot));
      jw_kv_bool(w, "hasIcon", util_file_exists(icon));
      jw_kv_bool(w, "isXenoStore", strcmp(e->d_name, "XENO-STORE") == 0);
      jw_kv_i64(w, "mtime", (int64_t)st.st_mtime);
      jw_obj_end(w);
      xstrlcpy(hb_names[n_hb++], e->d_name, sizeof hb_names[0]);
    }
    closedir(d);
  }
  jw_arr_end(w);
  jw_kv_str(w, "root", base);
  jw_kv_str(w, "note", "ShadowMountPlus registers every folder here as a home-screen icon; deleting a folder removes its icon on the next scan.");
  pthread_mutex_unlock(&hb_mu);
}

int cx_homebrew_dir_delete(const char *name, const char *confirm, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  if (!name || !*name || strchr(name, '/') || strchr(name, '\\') || name[0] == '.' || strlen(name) >= 256) { xsnprintf(err, errcap, "invalid folder name"); return -1; }
  if (!confirm || strcmp(confirm, name) != 0) { xstrlcpy(code, "confirm_required", ccap); xsnprintf(err, errcap, "repeat the folder name in \"confirm\" to delete it"); return -1; }
  pthread_mutex_lock(&hb_mu);
  int listed = 0;
  for (int i = 0; i < n_hb; i++) if (strcmp(hb_names[i], name) == 0) listed = 1;
  pthread_mutex_unlock(&hb_mu);
  if (!listed) { xstrlcpy(code, "forbidden", ccap); xsnprintf(err, errcap, "folder is not in the last listing — list first"); return -1; }
  char p[1024];
  xsnprintf(p, sizeof p, "%s/%s", cx_data_homebrew_dir(), name);
  if (!util_dir_exists(p)) { xstrlcpy(code, "not_found", ccap); xsnprintf(err, errcap, "folder no longer exists"); return -1; }
  if (cx_rm_rf(p, 8) != 0) { xstrlcpy(code, "io", ccap); xsnprintf(err, errcap, "could not delete every file in %s", p); return -1; }
  LOGI("homebrew-dirs: deleted %s", p);
  return 0;
}
