/* zip.c — see zip.h. miniz is compiled into this translation unit only. */
#define MINIZ_NO_ZLIB_COMPATIBLE_NAMES
/* The miniz implementation is compiled into this unit only; its warnings are
 * not ours to fix, so they are silenced for the vendored code alone. */
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wall"
#pragma GCC diagnostic ignored "-Wextra"
#pragma GCC diagnostic ignored "-Wunused-function"
#pragma GCC diagnostic ignored "-Wunused-parameter"
#pragma GCC diagnostic ignored "-Wsign-compare"
#pragma GCC diagnostic ignored "-Wimplicit-fallthrough"
#include "third_party/miniz.h"
#include "third_party/miniz.c"
#pragma GCC diagnostic pop

#include "zip.h"
#include "util.h"
#include "log.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define ZIP_BUF (1u << 20)

static void st_reset(zip_stats *st) { if (st) memset(st, 0, sizeof *st); }
static void st_err(zip_stats *st, const char *fmt, const char *a) {
  if (!st) return;
  xsnprintf(st->error, sizeof st->error, fmt, a ? a : "");
}

int zip_name_is_safe(const char *name) {
  if (!name || !*name) return 0;
  if (name[0] == '/' || name[0] == '\\') return 0;
  if (strlen(name) >= 500) return 0;
  if (strchr(name, ':') && name[1] == ':') return 0;      /* C:\ */
  const char *p = name;
  while (*p) {
    unsigned char ch = (unsigned char)*p;
    if (ch < 0x20 || ch == 0x7f) return 0;
    p++;
  }
  /* reject any "." or ".." path segment */
  const char *seg = name;
  for (;;) {
    const char *end = seg;
    while (*end && *end != '/' && *end != '\\') end++;
    size_t n = (size_t)(end - seg);
    if ((n == 1 && seg[0] == '.') || (n == 2 && seg[0] == '.' && seg[1] == '.')) return 0;
    if (!*end) break;
    seg = end + 1;
  }
  return 1;
}

static int mkdirs_for(const char *file_path) {
  char dir[1024];
  xstrlcpy(dir, file_path, sizeof dir);
  char *slash = strrchr(dir, '/');
  if (!slash) return 0;
  *slash = 0;
  return util_mkdir_p(dir);
}

int zip_list(const char *zip_path, zip_entry_info *out, int max, zip_stats *st) {
  st_reset(st);
  mz_zip_archive z;
  memset(&z, 0, sizeof z);
  if (!mz_zip_reader_init_file(&z, zip_path, 0)) { st_err(st, "not a readable zip: %s", zip_path); return -1; }
  int n = (int)mz_zip_reader_get_num_files(&z), w = 0;
  for (int i = 0; i < n && w < max; i++) {
    mz_zip_archive_file_stat s;
    if (!mz_zip_reader_file_stat(&z, (mz_uint)i, &s)) continue;
    xstrlcpy(out[w].name, s.m_filename, sizeof out[w].name);
    out[w].size = (uint64_t)s.m_uncomp_size;
    out[w].is_dir = mz_zip_reader_is_file_a_directory(&z, (mz_uint)i) ? 1 : 0;
    w++;
  }
  if (st) st->entries = n;
  mz_zip_reader_end(&z);
  return w;
}

int zip_extract_to_memory(const char *zip_path, const char *basename, void **out, size_t *out_len, size_t max_len) {
  *out = NULL; *out_len = 0;
  mz_zip_archive z;
  memset(&z, 0, sizeof z);
  if (!mz_zip_reader_init_file(&z, zip_path, 0)) return -1;
  int n = (int)mz_zip_reader_get_num_files(&z), rc = -1;
  for (int i = 0; i < n; i++) {
    mz_zip_archive_file_stat s;
    if (!mz_zip_reader_file_stat(&z, (mz_uint)i, &s) || mz_zip_reader_is_file_a_directory(&z, (mz_uint)i)) continue;
    const char *base = strrchr(s.m_filename, '/');
    base = base ? base + 1 : s.m_filename;
    if (!util_strieq(base, basename)) continue;
    if (s.m_uncomp_size > max_len) break;
    size_t len = 0;
    void *buf = mz_zip_reader_extract_to_heap(&z, (mz_uint)i, &len, 0);
    if (!buf) break;
    *out = buf; *out_len = len; rc = 0;
    break;
  }
  mz_zip_reader_end(&z);
  return rc;
}

typedef struct extract_ctx { int fd; uint64_t written; uint64_t done_before; uint64_t total; zip_progress_fn cb; void *user; const char *entry; int cancelled; int failed; } extract_ctx;

static size_t extract_write_cb(void *user, mz_uint64 ofs, const void *buf, size_t n) {
  (void)ofs;
  extract_ctx *x = (extract_ctx *)user;
  if (x->cancelled || x->failed) return 0;
  size_t off = 0;
  while (off < n) {
    ssize_t w = write(x->fd, (const char *)buf + off, n - off);
    if (w < 0) { if (errno == EINTR) continue; x->failed = 1; return 0; }
    off += (size_t)w;
  }
  x->written += n;
  if (x->cb && x->cb(x->user, x->done_before + x->written, x->total, x->entry)) { x->cancelled = 1; return 0; }
  return n;
}

int zip_extract_to_dir(const char *zip_path, const char *dest_dir, uint64_t max_total,
                       zip_progress_fn progress, void *user, zip_stats *st) {
  st_reset(st);
  mz_zip_archive z;
  memset(&z, 0, sizeof z);
  if (!mz_zip_reader_init_file(&z, zip_path, 0)) { st_err(st, "not a readable zip: %s", zip_path); return -1; }
  if (util_mkdir_p(dest_dir) != 0) { st_err(st, "cannot create %s", dest_dir); mz_zip_reader_end(&z); return -1; }
  int n = (int)mz_zip_reader_get_num_files(&z);
  uint64_t total = 0;
  for (int i = 0; i < n; i++) {
    mz_zip_archive_file_stat s;
    if (mz_zip_reader_file_stat(&z, (mz_uint)i, &s)) total += (uint64_t)s.m_uncomp_size;
  }
  if (max_total && total > max_total) { st_err(st, "archive is larger than the allowed size (%s)", ""); mz_zip_reader_end(&z); return -1; }
  if (st) st->entries = n;
  uint64_t done = 0;
  int rc = 0;
  for (int i = 0; i < n && rc == 0; i++) {
    mz_zip_archive_file_stat s;
    if (!mz_zip_reader_file_stat(&z, (mz_uint)i, &s)) continue;
    if (!zip_name_is_safe(s.m_filename)) { if (st) st->skipped++; LOGW("zip: skipping unsafe entry %s", s.m_filename); continue; }
    char path[1024];
    xsnprintf(path, sizeof path, "%s/%s", dest_dir, s.m_filename);
    if (mz_zip_reader_is_file_a_directory(&z, (mz_uint)i)) { util_mkdir_p(path); continue; }
    if (mkdirs_for(path) != 0) { st_err(st, "cannot create directory for %s", s.m_filename); rc = -1; break; }
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { st_err(st, "cannot write %s", s.m_filename); rc = -1; break; }
    extract_ctx x = { fd, 0, done, total, progress, user, s.m_filename, 0, 0 };
    mz_bool ok = mz_zip_reader_extract_to_callback(&z, (mz_uint)i, extract_write_cb, &x, 0);
    close(fd);
    if (x.cancelled) { rc = 1; break; }
    if (!ok || x.failed) { st_err(st, "failed to extract %s", s.m_filename); rc = -1; break; }
    done += x.written;
    if (st) { st->extracted++; st->bytes = done; }
  }
  mz_zip_reader_end(&z);
  return rc;
}

static int add_dir_recursive(mz_zip_archive *z, const char *root, const char *rel, zip_progress_fn cb, void *user, zip_stats *st, int depth) {
  if (depth > 16) return 0;
  char dir[1024];
  if (rel[0]) xsnprintf(dir, sizeof dir, "%s/%s", root, rel); else xstrlcpy(dir, root, sizeof dir);
  DIR *d = opendir(dir);
  if (!d) return -1;
  struct dirent *e;
  int rc = 0;
  while (rc == 0 && (e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    char relpath[1024], full[1024];
    if (rel[0]) xsnprintf(relpath, sizeof relpath, "%s/%s", rel, e->d_name); else xstrlcpy(relpath, e->d_name, sizeof relpath);
    xsnprintf(full, sizeof full, "%s/%s", root, relpath);
    struct stat sb;
    if (lstat(full, &sb) != 0) continue;
    if (S_ISLNK(sb.st_mode)) continue;               /* never follow links */
    if (S_ISDIR(sb.st_mode)) { rc = add_dir_recursive(z, root, relpath, cb, user, st, depth + 1); continue; }
    if (!S_ISREG(sb.st_mode)) continue;
    if (!mz_zip_writer_add_file(z, relpath, full, NULL, 0, MZ_BEST_SPEED)) { st_err(st, "cannot add %s", relpath); rc = -1; break; }
    if (st) { st->entries++; st->extracted++; st->bytes += (uint64_t)sb.st_size; }
    if (cb && cb(user, st ? st->bytes : 0, 0, relpath)) { rc = 1; break; }
  }
  closedir(d);
  return rc;
}

int zip_create_from_dir(const char *zip_path, const char *src_dir, zip_progress_fn progress, void *user, zip_stats *st) {
  st_reset(st);
  char tmp[1024];
  xsnprintf(tmp, sizeof tmp, "%s.tmp", zip_path);
  mz_zip_archive z;
  memset(&z, 0, sizeof z);
  if (!mz_zip_writer_init_file(&z, tmp, 0)) { st_err(st, "cannot create %s", zip_path); return -1; }
  int rc = add_dir_recursive(&z, src_dir, "", progress, user, st, 0);
  if (rc == 0 && !mz_zip_writer_finalize_archive(&z)) { st_err(st, "cannot finalize %s", zip_path); rc = -1; }
  mz_zip_writer_end(&z);
  if (rc != 0) { unlink(tmp); return rc; }
  if (rename(tmp, zip_path) != 0) { st_err(st, "cannot rename to %s", zip_path); unlink(tmp); return -1; }
  return 0;
}

int zip_add_memory(const char *zip_path, const char *entry_name, const void *data, size_t len) {
  if (!zip_name_is_safe(entry_name)) return -1;
  mz_zip_archive z;
  memset(&z, 0, sizeof z);
  int exists = util_file_exists(zip_path);
  if (exists) {
    if (!mz_zip_reader_init_file(&z, zip_path, 0)) return -1;
    if (!mz_zip_writer_init_from_reader(&z, zip_path)) { mz_zip_reader_end(&z); return -1; }
  } else if (!mz_zip_writer_init_file(&z, zip_path, 0)) return -1;
  int ok = mz_zip_writer_add_mem(&z, entry_name, data, len, MZ_DEFAULT_LEVEL) && mz_zip_writer_finalize_archive(&z);
  mz_zip_writer_end(&z);
  return ok ? 0 : -1;
}
