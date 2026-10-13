/*
 * storage.c — see storage.h.
 *
 * Roots are rediscovered on demand (/api/storage) because USB drives come and
 * go. All filesystem paths the engine touches are produced by storage_join(),
 * which validates the filename and only accepts known roots.
 */
#include "storage.h"
#include "catalog.h"
#include "config.h"
#include "log.h"
#include "settings.h"
#include "util.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

static pthread_mutex_t storage_mu = PTHREAD_MUTEX_INITIALIZER;
static storage_root roots[STORAGE_MAX_ROOTS];
static int n_roots;
static storage_job_lookup_fn job_lookup;

/* allowlist of paths produced by the last library scan */
#define LIB_MAX_FILES 2000
static char (*lib_paths)[1024];
static int n_lib_paths;

/* ---- roots -------------------------------------------------------------- */

int storage_free_space(const char *path, int64_t *free_out, int64_t *total_out) {
  struct statvfs sv;
  if (statvfs(path, &sv) != 0) return -1;
  int64_t fr = (int64_t)sv.f_bavail * (int64_t)sv.f_frsize;
  int64_t tot = (int64_t)sv.f_blocks * (int64_t)sv.f_frsize;
#ifdef XENO_HOST
  const char *fake = getenv("XENO_FAKE_FREE");   /* test hook: simulate a nearly-full drive */
  if (fake && *fake) { int64_t f; if (util_parse_i64(fake, &f) == 0) fr = f; }
#endif
  if (free_out) *free_out = fr;
  if (total_out) *total_out = tot;
  return 0;
}

int storage_root_present(const char *root) { return util_dir_exists(root); }

static int test_writable(const char *root) {
  char dir[300], probe[340];
  xsnprintf(dir, sizeof dir, "%s/xeno-store", root);
  if (util_mkdir_p(dir) != 0) return 0;
  xsnprintf(probe, sizeof probe, "%s/.wtest", dir);
  int fd = open(probe, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return 0;
  int ok = write(fd, "x", 1) == 1;
  close(fd);
  unlink(probe);
  return ok;
}

static void add_root(const char *path, const char *label, const char *kind) {
  if (n_roots >= STORAGE_MAX_ROOTS) return;
  if (!util_dir_exists(path)) return;
  storage_root *r = &roots[n_roots];
  memset(r, 0, sizeof *r);
  if (storage_free_space(path, &r->free, &r->total) != 0) return;
  xstrlcpy(r->path, path, sizeof r->path);
  xstrlcpy(r->label, label, sizeof r->label);
  xstrlcpy(r->kind, kind, sizeof r->kind);
  r->writable = test_writable(path);
  n_roots++;
}

static void mark_default_locked(void) {
  settings_t s;
  settings_get(&s);
  int found = -1;
  for (int i = 0; i < n_roots; i++) {
    roots[i].is_default = 0;
    if (strcmp(roots[i].path, s.defaultRoot) == 0) found = i;
  }
  if (found < 0 && n_roots) found = 0;
  if (found >= 0) roots[found].is_default = 1;
}

int storage_scan_roots(void) {
  pthread_mutex_lock(&storage_mu);
  n_roots = 0;
#ifdef XENO_HOST
  char dl[600];
  xsnprintf(dl, sizeof dl, "%s/downloads", g_cfg.data_dir);
  util_mkdir_p(dl);
  add_root(dl, "Downloads", "internal");
  for (int i = 0; i < g_cfg.n_extra_roots; i++) {
    char label[32];
    xsnprintf(label, sizeof label, "%s", util_basename(g_cfg.extra_roots[i]));
    if (!label[0]) xsnprintf(label, sizeof label, "Root %d", i + 1);
    add_root(g_cfg.extra_roots[i], label, "usb");
  }
#else
  add_root("/data", "Internal", "internal");
  add_root("/mnt/ext0", "M.2 SSD", "m2");
  add_root("/mnt/ext1", "M.2 SSD 2", "m2");
  for (int i = 0; i < 8; i++) {
    char p[32], l[32];
    xsnprintf(p, sizeof p, "/mnt/usb%d", i);
    xsnprintf(l, sizeof l, "USB %d", i);
    add_root(p, l, "usb");
  }
#endif
  mark_default_locked();
  int n = n_roots;
  pthread_mutex_unlock(&storage_mu);
  return n;
}

void storage_init(void) {
  int n = storage_scan_roots();
  LOGI("storage: %d root(s)", n);
  for (int i = 0; i < n; i++) {
    char fr[32];
    util_fmt_bytes(roots[i].free, fr, sizeof fr);
    LOGI("  %s (%s, %s) free %s%s", roots[i].path, roots[i].label, roots[i].kind, fr,
         roots[i].writable ? "" : " [read-only]");
  }
}

int storage_get_roots(storage_root *out, int max) {
  pthread_mutex_lock(&storage_mu);
  mark_default_locked();
  int n = n_roots < max ? n_roots : max;
  for (int i = 0; i < n; i++) {
    out[i] = roots[i];
    storage_free_space(out[i].path, &out[i].free, &out[i].total);
  }
  pthread_mutex_unlock(&storage_mu);
  return n;
}

int storage_find_root(const char *path, storage_root *out) {
  int rc = -1;
  pthread_mutex_lock(&storage_mu);
  for (int i = 0; i < n_roots; i++) {
    if (strcmp(roots[i].path, path) == 0) {
      if (out) { *out = roots[i]; storage_free_space(out->path, &out->free, &out->total); }
      rc = 0;
      break;
    }
  }
  pthread_mutex_unlock(&storage_mu);
  return rc;
}

/* ---- paths -------------------------------------------------------------- */

const char *storage_category_for_format(const char *format) {
  if (!format) return "files";
  if (util_strieq(format, "exfat") || util_strieq(format, "ffpfsc") || util_strieq(format, "ffpkg") ||
      util_strieq(format, "ffpfs"))
    return "homebrew";
  if (util_strieq(format, "pkg") || util_strieq(format, "fpkg")) return "pkg";
  return "files";
}

int storage_sanitize_filename(const char *in, char *out, size_t cap) {
  size_t o = 0;
  if (cap == 0) return -1;
  for (const unsigned char *p = (const unsigned char *)in; *p && o + 1 < cap && o < 200; p++) {
    unsigned char c = *p;
    if (c < 0x20 || c == 0x7f || c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' ||
        c == '<' || c == '>' || c == '|')
      c = '_';
    if (o == 0 && (c == '.' || c == ' ' || c == '_')) continue;   /* no hidden/odd names */
    out[o++] = (char)c;
  }
  /* Never cut a UTF-8 sequence in half at the 200-byte limit. */
  while (o > 0 && ((unsigned char)out[o - 1] & 0xC0) == 0x80) o--;
  if (o > 0 && ((unsigned char)out[o - 1] & 0xC0) == 0xC0) o--;
  while (o > 0 && (out[o - 1] == ' ' || out[o - 1] == '.')) o--;
  out[o] = 0;
  if (o == 0) return -1;
  if (strcmp(out, "..") == 0) return -1;
  return 0;
}

int storage_join(const char *root, const char *category, const char *filename, char *out, size_t cap) {
  if (!root || !filename || !*filename) return -1;
  if (storage_find_root(root, NULL) != 0) return -1;
  if (strchr(filename, '/') || strchr(filename, '\\') || filename[0] == '.') return -1;
  for (const unsigned char *p = (const unsigned char *)filename; *p; p++) if (*p < 0x20) return -1;
  if (strlen(filename) > 200) return -1;
  const char *sub;
  if (strcmp(category, "homebrew") == 0) sub = "homebrew";
  else if (strcmp(category, "pkg") == 0) sub = "xeno-store/pkg";
  else sub = "xeno-store/files";
  int n = xsnprintf(out, cap, "%s/%s/%s", root, sub, filename);
  return (size_t)n + 1 >= cap ? -1 : 0;
}

int storage_ensure_parent_dir(const char *path) {
  char dir[1024];
  xstrlcpy(dir, path, sizeof dir);
  char *s = strrchr(dir, '/');
  if (!s || s == dir) return 0;
  *s = 0;
  return util_mkdir_p(dir);
}

const char *storage_user_app_dir(void) {
#ifdef XENO_HOST
  static char dir[600];
  if (!dir[0]) xsnprintf(dir, sizeof dir, "%s/user/app", g_cfg.data_dir);
  return dir;
#else
  return "/user/app";
#endif
}

int storage_title_installed(const char *titleId) {
  char p[700];
  if (!titleId || !*titleId) return 0;
  xsnprintf(p, sizeof p, "%s/%s", storage_user_app_dir(), titleId);
  return util_dir_exists(p);
}

/* ---- library scan ------------------------------------------------------- */

void storage_set_job_lookup(storage_job_lookup_fn fn) { job_lookup = fn; }

static int known_ext(const char *ext) {
  static const char *const exts[] = {"exfat", "ffpfsc", "ffpkg", "ffpfs", "pkg", "fpkg", "zip", "rar", "7z", "xpart"};
  for (size_t i = 0; i < XS_ARRAY_LEN(exts); i++) if (strcmp(ext, exts[i]) == 0) return 1;
  return 0;
}

static const char *format_for_ext(const char *ext) {
  static const char *const names[][2] = {{"exfat", "exFAT"}, {"ffpfsc", "FFPFSC"}, {"ffpkg", "FFPKG"}, {"ffpfs", "FFPFS"},
                                         {"pkg", "PKG"}, {"fpkg", "FPKG"}, {"zip", "ZIP"}, {"rar", "RAR"}, {"7z", "7z"}};
  for (size_t i = 0; i < XS_ARRAY_LEN(names); i++) if (strcmp(ext, names[i][0]) == 0) return names[i][1];
  return "";
}

/* Derives a search title from a filename: drop extension, title id tokens,
 * version tags and separators. */
static void title_from_name(const char *name, char *out, size_t cap) {
  char tmp[300];
  xstrlcpy(tmp, name, sizeof tmp);
  char *dot = strrchr(tmp, '.');
  if (dot && dot != tmp) *dot = 0;
  if (util_iends_with(tmp, ".xpart")) tmp[strlen(tmp) - 6] = 0;
  dot = strrchr(tmp, '.');
  if (dot && dot != tmp && strlen(dot) <= 7) *dot = 0;
  size_t o = 0;
  for (char *p = tmp; *p && o + 1 < cap;) {
    char tid[16];
    if ((util_istarts_with(p, "PPSA") || util_istarts_with(p, "CUSA")) && util_find_titleid(p, tid, sizeof tid) == 0 &&
        util_istarts_with(p, tid)) { p += 9; continue; }
    if (*p == '[' || *p == '(') {              /* skip bracketed tags */
      char close = *p == '[' ? ']' : ')';
      char *e = strchr(p, close);
      if (e) { p = e + 1; continue; }
    }
    char c = *p++;
    if (c == '_' || c == '-' || c == '.') c = ' ';
    if (c == ' ' && (o == 0 || out[o - 1] == ' ')) continue;
    out[o++] = c;
  }
  out[o] = 0;
  util_trim(out);
}

typedef struct scan_ctx {
  jw *w;
  int count;
} scan_ctx;

static void emit_file(scan_ctx *sc, const char *root, const char *path, const char *name, const struct stat *st) {
  char ext[16];
  util_ext(name, ext, sizeof ext);
  if (!known_ext(ext)) return;
  if (sc->count >= LIB_MAX_FILES) return;
  int partial = strcmp(ext, "xpart") == 0;
  char inner[16] = "";
  if (partial) {
    char base[300];
    xstrlcpy(base, name, sizeof base);
    base[strlen(base) - 6] = 0;
    util_ext(base, inner, sizeof inner);
  }
  const char *format = format_for_ext(partial ? inner : ext);
  char tid[16] = "";
  if (util_find_titleid(name, tid, sizeof tid) != 0) util_find_titleid(path, tid, sizeof tid);
  cat_game g;
  int matched = 0;
  if (tid[0] && catalog_match_titleid(tid, &g) == 0) matched = 1;
  if (!matched) {
    char t[256];
    title_from_name(name, t, sizeof t);
    if (strlen(t) >= 3 && catalog_match_title(t, "", &g) == 0) matched = 1;
  }
  jw *w = sc->w;
  jw_obj_begin(w);
  jw_kv_str(w, "path", path);
  jw_kv_str(w, "name", name);
  jw_kv_i64(w, "size", (int64_t)st->st_size);
  jw_kv_i64(w, "mtime", (int64_t)st->st_mtime);
  jw_kv_str(w, "format", format);
  jw_kv_str(w, "root", root);
  if (tid[0]) jw_kv_str(w, "titleId", tid);
  if (matched) {
    jw_kv_str(w, "gameId", g.id);
    jw_kv_str(w, "title", g.title);
    jw_kv_str(w, "cover", g.cover);
    jw_kv_str(w, "platform", g.platform);
  }
  jw_kv_bool(w, "partial", partial);
  char jid[32];
  if (job_lookup && job_lookup(path, jid, sizeof jid) == 0) jw_kv_str(w, "jobId", jid);
  jw_obj_end(w);
  if (n_lib_paths < LIB_MAX_FILES && lib_paths) xstrlcpy(lib_paths[n_lib_paths++], path, 1024);
  sc->count++;
}

static void scan_dir(scan_ctx *sc, const char *root, const char *dir, int depth) {
  DIR *d = opendir(dir);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (e->d_name[0] == '.') continue;
    char path[1024];
    if (xsnprintf(path, sizeof path, "%s/%s", dir, e->d_name) >= (int)sizeof path - 1) continue;
    struct stat st;
    if (stat(path, &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) { if (depth < 2) scan_dir(sc, root, path, depth + 1); continue; }
    if (S_ISREG(st.st_mode)) emit_file(sc, root, path, e->d_name, &st);
  }
  closedir(d);
}

static void scan_installed(jw *w) {
  const char *base = storage_user_app_dir();
  DIR *d = opendir(base);
  if (!d) return;
  struct dirent *e;
  int n = 0;
  while ((e = readdir(d)) != NULL && n < 1000) {
    char tid[16];
    if (util_find_titleid(e->d_name, tid, sizeof tid) != 0 || strlen(e->d_name) != 9) continue;
    char path[700];
    xsnprintf(path, sizeof path, "%s/%s", base, e->d_name);
    if (!util_dir_exists(path)) continue;
    jw_obj_begin(w);
    jw_kv_str(w, "titleId", tid);
    cat_game g;
    if (catalog_match_titleid(tid, &g) == 0) {
      jw_kv_str(w, "gameId", g.id);
      jw_kv_str(w, "title", g.title);
      jw_kv_str(w, "cover", g.cover);
      jw_kv_str(w, "platform", g.platform);
    }
    jw_kv_str(w, "path", path);
    jw_obj_end(w);
    n++;
  }
  closedir(d);
}

void storage_library_json(jw *w) {
  storage_root snap[STORAGE_MAX_ROOTS];
  int n = storage_get_roots(snap, STORAGE_MAX_ROOTS);
  pthread_mutex_lock(&storage_mu);
  if (!lib_paths) lib_paths = calloc(LIB_MAX_FILES, 1024);
  n_lib_paths = 0;
  scan_ctx sc = { w, 0 };
  jw_key(w, "files");
  jw_arr_begin(w);
  static const char *const subs[] = {"homebrew", "xeno-store/pkg", "xeno-store/files"};
  for (int i = 0; i < n; i++) {
    for (size_t s = 0; s < XS_ARRAY_LEN(subs); s++) {
      char dir[600];
      xsnprintf(dir, sizeof dir, "%s/%s", snap[i].path, subs[s]);
      scan_dir(&sc, snap[i].path, dir, 1);
    }
  }
  jw_arr_end(w);
  jw_key(w, "installed");
  jw_arr_begin(w);
  scan_installed(w);
  jw_arr_end(w);
  jw_kv_i64(w, "scannedAt", (int64_t)util_now());
  pthread_mutex_unlock(&storage_mu);
}

int storage_library_path_allowed(const char *path) {
  int ok = 0;
  pthread_mutex_lock(&storage_mu);
  for (int i = 0; i < n_lib_paths; i++) if (strcmp(lib_paths[i], path) == 0) { ok = 1; break; }
  pthread_mutex_unlock(&storage_mu);
  return ok;
}

int storage_library_delete(const char *path, char *err, size_t errcap) {
  if (!storage_library_path_allowed(path)) { xsnprintf(err, errcap, "Path is not in the last library scan"); return -1; }
  if (unlink(path) != 0 && errno != ENOENT) { xsnprintf(err, errcap, "Cannot delete: %s", strerror(errno)); return -1; }
  if (util_iends_with(path, ".xpart")) {
    char side[1100];
    xsnprintf(side, sizeof side, "%s.json", path);
    util_unlink_quiet(side);
  }
  LOGI("library: deleted %s", path);
  return 0;
}
