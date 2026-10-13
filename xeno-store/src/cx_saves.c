/*
 * cx_saves.c — see cx_saves.h.
 */
#include "cx_saves.h"
#include "catalog.h"
#include "cx_accounts.h"
#include "cx_common.h"
#include "cx_jobs.h"
#include "cx_savemount.h"
#include "log.h"
#include "settings.h"
#include "storage.h"
#include "util.h"
#include "zip.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define SAVES_MAX_BYTES (8LL << 30)

void cx_saves_init(void) {}

void cx_saves_users_json(jw *w) {
  cx_user u[CX_MAX_USERS];
  int n = cx_users_list(u, CX_MAX_USERS);
  jw_key(w, "users");
  jw_arr_begin(w);
  for (int i = 0; i < n; i++) {
    jw_obj_begin(w);
    jw_kv_i64(w, "id", u[i].id);
    jw_kv_str(w, "name", u[i].name);
    jw_kv_bool(w, "foreground", u[i].foreground);
    jw_obj_end(w);
  }
  jw_arr_end(w);
}

int cx_saves_dirnames(const char *title_dir, char (*out)[32], int max) {
  int n = 0;
  DIR *d = opendir(title_dir);
  if (!d) return 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL && n < max) {
    if (util_starts_with(e->d_name, "sdimg_") && cx_dirname_valid(e->d_name + 6)) {
      int dup = 0;
      for (int i = 0; i < n; i++) if (strcmp(out[i], e->d_name + 6) == 0) dup = 1;
      if (!dup) xstrlcpy(out[n++], e->d_name + 6, 32);
    }
  }
  closedir(d);
  char sys[1100];
  xsnprintf(sys, sizeof sys, "%s/sce_sys", title_dir);
  d = opendir(sys);
  if (d) {
    while ((e = readdir(d)) != NULL && n < max) {
      if (e->d_name[0] == '.' || !cx_dirname_valid(e->d_name)) continue;
      char p[1200];
      xsnprintf(p, sizeof p, "%s/%s", sys, e->d_name);
      if (!util_dir_exists(p)) continue;
      int dup = 0;
      for (int i = 0; i < n; i++) if (strcmp(out[i], e->d_name) == 0) dup = 1;
      if (!dup) xstrlcpy(out[n++], e->d_name, 32);
    }
    closedir(d);
  }
  return n;
}

static void list_kind(jw *w, const char *home, const char *sub, const char *kind, int *count) {
  char dir[800];
  xsnprintf(dir, sizeof dir, "%s/%s", home, sub);
  DIR *d = opendir(dir);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d)) != NULL && *count < 2000) {
    if (!cx_titleid_valid(e->d_name)) continue;
    char path[1024];
    xsnprintf(path, sizeof path, "%s/%s", dir, e->d_name);
    struct stat st;
    if (stat(path, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
    jw_obj_begin(w);
    jw_kv_str(w, "titleId", e->d_name);
    cat_game g;
    if (catalog_match_titleid(e->d_name, &g) == 0) { jw_kv_str(w, "title", g.title); jw_kv_str(w, "cover", g.cover); jw_kv_str(w, "gameId", g.id); }
    jw_kv_str(w, "path", path);
    jw_kv_i64(w, "size", cx_dir_size(path, 6));
    jw_kv_i64(w, "mtime", (int64_t)st.st_mtime);
    jw_kv_str(w, "kind", kind);
    char dn[64][32];
    int n = cx_saves_dirnames(path, dn, 64);
    jw_key(w, "dirs"); jw_arr_begin(w);
    for (int i = 0; i < n; i++) jw_str(w, dn[i]);
    jw_arr_end(w);
    jw_kv_bool(w, "installed", storage_title_installed(e->d_name));
    jw_obj_end(w);
    (*count)++;
  }
  closedir(d);
}

int cx_saves_list_json(uint32_t uid, jw *w, char *err, size_t errcap) {
  if (!uid) uid = cx_user_foreground();
  cx_user u;
  if (cx_user_find(uid, &u) != 0) { xsnprintf(err, errcap, "unknown user"); return -1; }
  char home[700];
  jw_key(w, "user"); jw_obj_begin(w); jw_kv_i64(w, "id", u.id); jw_kv_str(w, "name", u.name); jw_obj_end(w);
  jw_key(w, "saves");
  jw_arr_begin(w);
  int count = 0;
  if (cx_user_home(uid, home, sizeof home) == 0) {
    list_kind(w, home, "savedata_prospero", "ps5", &count);
    list_kind(w, home, "savedata", "ps4", &count);
  }
  jw_arr_end(w);
  jw_kv_int(w, "count", count);
  return 0;
}

void cx_saves_backup_dir(char *out, size_t cap) {
  settings_t s;
  settings_get(&s);
  char root[256];
  settings_saves_root(&s, root, sizeof root);
  if (storage_find_root(root, NULL) != 0) {
    storage_root roots[STORAGE_MAX_ROOTS];
    int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
    xstrlcpy(root, n ? roots[0].path : s.defaultRoot, sizeof root);
    for (int i = 0; i < n; i++) if (roots[i].is_default) xstrlcpy(root, roots[i].path, sizeof root);
  }
  xsnprintf(out, cap, "%s/xeno-store/saves", root);
}

/* ---- backup job --------------------------------------------------------- */

typedef struct backup_arg {
  uint32_t uid;
  char titleId[12], kind[8], title_dir[1024], dest[1100], uname[64];
  char display[256];
} backup_arg;

static int zip_cb(void *user, uint64_t done, uint64_t total, const char *entry) {
  cx_job *j = user;
  (void)total;
  char msg[200];
  xsnprintf(msg, sizeof msg, "Packing %s", entry ? util_basename(entry) : "");
  cx_job_progress(j, (int64_t)done, j->total, msg);
  return cx_job_cancelled(j);
}

static int backup_worker(cx_job *j, void *p) {
  backup_arg *a = p;
  int64_t total = cx_dir_size(a->title_dir, 8);
  cx_job_progress(j, 0, total, "Preparing");
  if (util_mkdir_p(a->dest) != 0) { cx_job_fail(j, "io", "Cannot create the backup folder"); return -1; }
  char stamp[24], zip[1300];
  cx_stamp(stamp, sizeof stamp);
  xsnprintf(zip, sizeof zip, "%s/%s_%s_%s.zip", a->dest, a->titleId, a->kind, stamp);
  if (util_file_exists(zip)) { char rnd[8]; util_rand_hex(rnd, 4); xsnprintf(zip, sizeof zip, "%s/%s_%s_%s-%s.zip", a->dest, a->titleId, a->kind, stamp, rnd); }
  zip_stats st;
  int rc = zip_create_from_dir(zip, a->title_dir, zip_cb, j, &st);
  if (rc == 1) { cx_job_fail(j, "cancelled", "Backup cancelled"); return -1; }
  if (rc != 0) { cx_job_fail(j, "zip_failed", st.error[0] ? st.error : "Backup failed"); return -1; }
  jw mw;
  jw_init(&mw);
  jw_obj_begin(&mw);
  jw_kv_int(&mw, "v", 1);
  jw_kv_str(&mw, "titleId", a->titleId);
  jw_kv_str(&mw, "kind", a->kind);
  jw_key(&mw, "user"); jw_obj_begin(&mw); jw_kv_i64(&mw, "id", a->uid); jw_kv_str(&mw, "name", a->uname); jw_obj_end(&mw);
  jw_kv_i64(&mw, "createdAt", (int64_t)util_now());
  jw_kv_str(&mw, "createdBy", "XENO STORE " XENO_VERSION);
  jw_kv_int(&mw, "files", st.extracted);
  jw_kv_i64(&mw, "bytes", (int64_t)st.bytes);
  jw_obj_end(&mw);
  size_t ml;
  char *mtxt = jw_detach(&mw, &ml);
  if (mtxt) { zip_add_memory(zip, "xeno-backup.json", mtxt, ml); free(mtxt); }
  jw rw;
  jw_init(&rw);
  jw_obj_begin(&rw);
  jw_kv_str(&rw, "zipPath", zip);
  jw_kv_str(&rw, "titleId", a->titleId);
  jw_kv_str(&rw, "kind", a->kind);
  jw_kv_int(&rw, "files", st.extracted);
  jw_kv_i64(&rw, "bytes", (int64_t)st.bytes);
  jw_kv_i64(&rw, "size", util_file_size(zip));
  jw_obj_end(&rw);
  cx_job_set_result(j, &rw);
  cx_job_progress(j, total, total, "Backup complete");
  LOGI("saves: backup %s", zip);
  return 0;
}

int cx_saves_backup_start(uint32_t uid, const char *titleId, const char *kind, char *job_id, size_t idcap, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  if (!uid) uid = cx_user_foreground();
  cx_user u;
  if (cx_user_find(uid, &u) != 0) { xsnprintf(err, errcap, "unknown user"); return -1; }
  if (!cx_titleid_valid(titleId)) { xsnprintf(err, errcap, "titleId must look like PPSA12345 / CUSA12345"); return -1; }
  backup_arg *a = calloc(1, sizeof *a);
  if (!a) { xstrlcpy(code, "oom", ccap); xsnprintf(err, errcap, "out of memory"); return -1; }
  a->uid = uid;
  xstrlcpy(a->titleId, titleId, sizeof a->titleId);
  if (cx_save_title_dir(uid, titleId, kind, a->title_dir, sizeof a->title_dir, a->kind, sizeof a->kind) != 0 || !util_dir_exists(a->title_dir)) {
    /* try the other kind before giving up */
    const char *alt = (kind && strcmp(kind, "ps4") == 0) ? "ps5" : "ps4";
    if (cx_save_title_dir(uid, titleId, alt, a->title_dir, sizeof a->title_dir, a->kind, sizeof a->kind) != 0 || !util_dir_exists(a->title_dir)) {
      free(a); xstrlcpy(code, "not_found", ccap); xsnprintf(err, errcap, "no save for %s on this profile", titleId); return -1;
    }
  }
  if (storage_sanitize_filename(u.name, a->uname, sizeof a->uname) != 0) xsnprintf(a->uname, sizeof a->uname, "user-%x", (unsigned)uid);
  char base[1024];
  cx_saves_backup_dir(base, sizeof base);
  xsnprintf(a->dest, sizeof a->dest, "%s/%s", base, a->uname);
  cat_game g;
  if (catalog_match_titleid(titleId, &g) == 0) xsnprintf(a->display, sizeof a->display, "%s (%s)", g.title, titleId);
  else xstrlcpy(a->display, titleId, sizeof a->display);
  if (cx_job_start("backup", a->display, backup_worker, a, job_id, idcap) != 0) { free(a); xstrlcpy(code, "busy", ccap); xsnprintf(err, errcap, "too many operations running"); return -1; }
  return 0;
}

int cx_saves_backup_all(uint32_t uid, jw *w, char *err, size_t errcap) {
  if (!uid) uid = cx_user_foreground();
  char home[700];
  if (cx_user_find(uid, NULL) != 0 || cx_user_home(uid, home, sizeof home) != 0) { xsnprintf(err, errcap, "unknown user"); return -1; }
  jw_key(w, "jobs");
  jw_arr_begin(w);
  const char *subs[2] = {"savedata_prospero", "savedata"};
  const char *kinds[2] = {"ps5", "ps4"};
  int started = 0;
  for (int k = 0; k < 2; k++) {
    char dir[800];
    xsnprintf(dir, sizeof dir, "%s/%s", home, subs[k]);
    DIR *d = opendir(dir);
    if (!d) continue;
    struct dirent *e;
    while ((e = readdir(d)) != NULL && started < 200) {
      if (!cx_titleid_valid(e->d_name)) continue;
      char id[16], code[32], e2[128];
      if (cx_saves_backup_start(uid, e->d_name, kinds[k], id, sizeof id, code, sizeof code, e2, sizeof e2) == 0) { jw_str(w, id); started++; }
    }
    closedir(d);
  }
  jw_arr_end(w);
  jw_kv_int(w, "started", started);
  return 0;
}

/* ---- backups list ------------------------------------------------------- */

static void parse_backup_name(const char *name, char *tid, size_t tcap, char *kind, size_t kcap, int *pre) {
  tid[0] = kind[0] = 0;
  *pre = strstr(name, ".pre-restore.") != NULL;
  util_find_titleid(name, tid, tcap);
  if (strstr(name, "_ps5_")) xstrlcpy(kind, "ps5", kcap);
  else if (strstr(name, "_ps4_")) xstrlcpy(kind, "ps4", kcap);
  else if (tid[0]) xstrlcpy(kind, tid[0] == 'P' ? "ps5" : "ps4", kcap);
}

static void list_backups_in(jw *w, const char *root, const char *dir, const char *user, int *count) {
  DIR *d = opendir(dir);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d)) != NULL && *count < 2000) {
    if (e->d_name[0] == '.' || !util_iends_with(e->d_name, ".zip")) continue;
    char path[1200];
    xsnprintf(path, sizeof path, "%s/%s", dir, e->d_name);
    struct stat st;
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) continue;
    char tid[16], kind[8];
    int pre;
    parse_backup_name(e->d_name, tid, sizeof tid, kind, sizeof kind, &pre);
    jw_obj_begin(w);
    jw_kv_str(w, "path", path);
    jw_kv_str(w, "name", e->d_name);
    jw_kv_str(w, "user", user);
    jw_kv_str(w, "root", root);
    if (tid[0]) {
      jw_kv_str(w, "titleId", tid);
      cat_game g;
      if (catalog_match_titleid(tid, &g) == 0) { jw_kv_str(w, "title", g.title); jw_kv_str(w, "cover", g.cover); jw_kv_str(w, "gameId", g.id); }
    }
    jw_kv_str(w, "kind", kind);
    jw_kv_i64(w, "size", (int64_t)st.st_size);
    jw_kv_i64(w, "mtime", (int64_t)st.st_mtime);
    jw_kv_bool(w, "preRestore", pre);
    jw_obj_end(w);
    (*count)++;
  }
  closedir(d);
}

void cx_saves_backups_json(jw *w) {
  storage_root roots[STORAGE_MAX_ROOTS];
  int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
  int count = 0;
  jw_key(w, "backups");
  jw_arr_begin(w);
  for (int i = 0; i < n; i++) {
    char base[700];
    xsnprintf(base, sizeof base, "%s/xeno-store/saves", roots[i].path);
    DIR *d = opendir(base);
    if (!d) continue;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
      if (e->d_name[0] == '.' || strcmp(e->d_name, "community") == 0 || strcmp(e->d_name, "export") == 0) continue;
      char dir[1000];
      xsnprintf(dir, sizeof dir, "%s/%s", base, e->d_name);
      if (!util_dir_exists(dir)) continue;
      list_backups_in(w, roots[i].path, dir, e->d_name, &count);
    }
    closedir(d);
  }
  jw_arr_end(w);
  jw_kv_int(w, "count", count);
}

int cx_saves_zip_allowed(const char *zipPath) {
  if (!cx_path_is_clean(zipPath) || !util_iends_with(zipPath, ".zip") || !util_file_exists(zipPath)) return 0;
  storage_root roots[STORAGE_MAX_ROOTS];
  int n = storage_get_roots(roots, STORAGE_MAX_ROOTS);
  for (int i = 0; i < n; i++) {
    char base[700];
    xsnprintf(base, sizeof base, "%s/xeno-store/saves/", roots[i].path);
    if (cx_path_under(zipPath, base)) return 1;
  }
  return 0;
}

/* ---- restore ------------------------------------------------------------ */

int cx_saves_restore(uint32_t uid, const char *zipPath, int overwrite, jw *w, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  if (!uid) uid = cx_user_foreground();
  if (cx_user_find(uid, NULL) != 0) { xsnprintf(err, errcap, "unknown user"); return -1; }
  if (!cx_saves_zip_allowed(zipPath)) { xstrlcpy(code, "forbidden", ccap); xsnprintf(err, errcap, "zipPath must be a backup below <drive>/xeno-store/saves/"); return -1; }
  char tid[16] = "", kind[8] = "";
  int pre = 0;
  void *mf = NULL;
  size_t mflen = 0;
  if (zip_extract_to_memory(zipPath, "xeno-backup.json", &mf, &mflen, 64 << 10) == 0) {
    jdoc *d = json_parse(mf, mflen, 1000, 8);
    if (d) { xstrlcpy(tid, jv_get_str(json_root(d), "titleId", ""), sizeof tid); xstrlcpy(kind, jv_get_str(json_root(d), "kind", ""), sizeof kind); json_free(d); }
    free(mf);
  }
  if (!tid[0]) parse_backup_name(util_basename(zipPath), tid, sizeof tid, kind, sizeof kind, &pre);
  if (!cx_titleid_valid(tid)) { xsnprintf(err, errcap, "cannot tell which title this backup belongs to"); return -1; }
  char title_dir[1024];
  if (cx_save_title_dir(uid, tid, kind, title_dir, sizeof title_dir, kind, sizeof kind) != 0) { xstrlcpy(code, "not_found", ccap); xsnprintf(err, errcap, "user home not found"); return -1; }
  int exists = util_dir_exists(title_dir) && cx_count_files(title_dir, 8) > 0;
  if (exists && !overwrite) { xstrlcpy(code, "exists", ccap); xsnprintf(err, errcap, "a save for %s already exists on this profile — pass overwrite:true to replace it (a .pre-restore backup is taken first)", tid); return -1; }
  cx_import_result r;
  char base[1024];
  cx_saves_backup_dir(base, sizeof base);
  settings_t s;
  settings_get(&s);
  if (cx_savemount_import_zip(uid, tid, "", zipPath, exists && s.saves.autoBackup, base, &r, code, ccap, err, errcap) != 0) return -1;
  jw_kv_str(w, "titleId", tid);
  jw_kv_str(w, "kind", kind);
  jw_kv_str(w, "path", title_dir);
  jw_kv_str(w, "preBackup", r.preBackup);
  jw_kv_str(w, "tier", r.tier);
  jw_kv_str(w, "style", r.style);
  jw_kv_int(w, "files", r.files);
  jw_kv_i64(w, "bytes", r.bytes);
  LOGI("saves: restored %s for user %x from %s", tid, (unsigned)uid, zipPath);
  return 0;
}

/* ---- transfer ----------------------------------------------------------- */

int cx_saves_transfer(uint32_t from, uint32_t to, const char *titleId, const char *kind, int move, jw *w, char *code, size_t ccap, char *err, size_t errcap) {
  xstrlcpy(code, "bad_request", ccap);
  if (!from || !to || from == to) { xsnprintf(err, errcap, "fromUser and toUser must be two different profiles"); return -1; }
  if (cx_user_find(from, NULL) != 0 || cx_user_find(to, NULL) != 0) { xsnprintf(err, errcap, "unknown user"); return -1; }
  if (!cx_titleid_valid(titleId)) { xsnprintf(err, errcap, "invalid title id"); return -1; }
  char src[1024], dst[1024], k[8];
  if (cx_save_title_dir(from, titleId, kind, src, sizeof src, k, sizeof k) != 0 || !util_dir_exists(src)) {
    const char *alt = (kind && strcmp(kind, "ps4") == 0) ? "ps5" : "ps4";
    if (cx_save_title_dir(from, titleId, alt, src, sizeof src, k, sizeof k) != 0 || !util_dir_exists(src)) { xstrlcpy(code, "not_found", ccap); xsnprintf(err, errcap, "no save for %s on the source profile", titleId); return -1; }
  }
  if (cx_save_title_dir(to, titleId, k, dst, sizeof dst, NULL, 0) != 0) { xstrlcpy(code, "not_found", ccap); xsnprintf(err, errcap, "destination profile has no home directory"); return -1; }
  char pre[1024] = "";
  settings_t s;
  settings_get(&s);
  if (util_dir_exists(dst) && cx_count_files(dst, 8) > 0) {
    if (s.saves.autoBackup) {
      char base[1024];
      cx_saves_backup_dir(base, sizeof base);
      cx_user u;
      cx_user_find(to, &u);
      char uname[64];
      if (storage_sanitize_filename(u.name, uname, sizeof uname) != 0) xsnprintf(uname, sizeof uname, "user-%x", (unsigned)to);
      char dir[1100], stamp[24];
      xsnprintf(dir, sizeof dir, "%s/%s", base, uname);
      util_mkdir_p(dir);
      cx_stamp(stamp, sizeof stamp);
      xsnprintf(pre, sizeof pre, "%s/%s_%s_%s.pre-restore.zip", dir, titleId, k, stamp);
      zip_stats st;
      if (zip_create_from_dir(pre, dst, NULL, NULL, &st) != 0) { xstrlcpy(code, "io", ccap); xsnprintf(err, errcap, "could not back up the destination save first (%s) — nothing was changed", st.error); return -1; }
    }
    cx_rm_rf(dst, 8);
  }
  int64_t bytes = 0;
  if (cx_copy_tree(src, dst, 8, &bytes) != 0) { xstrlcpy(code, "io", ccap); xsnprintf(err, errcap, "copy failed: %s", strerror(errno)); return -1; }
  int moved = 0;
  if (move) moved = cx_rm_rf(src, 8) == 0;
  jw_kv_i64(w, "fromUser", from);
  jw_kv_i64(w, "toUser", to);
  jw_kv_str(w, "titleId", titleId);
  jw_kv_str(w, "kind", k);
  jw_kv_str(w, "path", dst);
  jw_kv_i64(w, "bytes", bytes);
  jw_kv_str(w, "preBackup", pre);
  jw_kv_bool(w, "moved", moved);
  jw_kv_str(w, "note", "Saves are sealed to this console: same-console transfers work; saves from another console need re-signing.");
  LOGI("saves: transferred %s %x -> %x (%s)", titleId, (unsigned)from, (unsigned)to, move ? "move" : "copy");
  return 0;
}
