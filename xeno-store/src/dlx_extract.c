/* dlx_extract.c — see dlx_extract.h. */
#include "dlx_extract.h"
#include "dlx_internal.h"
#include "log.h"
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

#define MAX_ENTRIES 4096

int dlx_extract_applies(const dl_job *j) { return util_strieq(j->format, "zip"); }

static int image_ext(const char *ext) {
  return util_strieq(ext, "exfat") || util_strieq(ext, "ffpfsc") || util_strieq(ext, "ffpkg") || util_strieq(ext, "ffpfs") ||
         util_strieq(ext, "pkg") || util_strieq(ext, "fpkg");
}

/* Removes a directory tree we created ourselves (bounded depth, no symlink following). */
static void rm_tree(const char *dir, int depth) {
  if (depth > 12) return;
  DIR *d = opendir(dir);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    char p[1024];
    if (xsnprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= (int)sizeof p - 1) continue;
    struct stat st;
    if (lstat(p, &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) rm_tree(p, depth + 1);
    else unlink(p);
  }
  closedir(d);
  rmdir(dir);
}

typedef struct prog { dl_job *j; int64_t last_pub; } prog;

static int progress_cb(void *user, uint64_t done, uint64_t total, const char *entry) {
  prog *p = user;
  dl_job *j = p->j;
  (void)entry;
  int64_t now = util_now_ms();
  if (now - p->last_pub >= 200 || done >= total) {
    p->last_pub = now;
    dl_lock();
    j->written = (int64_t)done;
    j->total = (int64_t)total;
    dl_unlock();
  }
  return j->stop_io || j->cancel ? 1 : 0;
}

static int finish_fail(dl_job *j, const char *code, const char *msg, const char *cleanup_dir) {
  if (cleanup_dir && *cleanup_dir) rm_tree(cleanup_dir, 0);
  dl_lock();
  j->state = DL_DONE;              /* the archive is kept; "Extract" retries */
  xstrlcpy(j->extract.state, "failed", sizeof j->extract.state);
  xstrlcpy(j->extract.message, msg, sizeof j->extract.message);
  j->phase[0] = 0;
  j->written = j->total = util_file_size(j->path) > 0 ? util_file_size(j->path) : j->total;
  dl_set_error_locked(j, code, msg);
  dl_mark_dirty_locked();
  dl_unlock();
  dl_jlog(j, "extract failed: %s", msg);
  return -1;
}

/* Well-known community passwords for scene ZIPs (classic ZipCrypto). The
 * catalog-supplied / user-override password (job->extractPassword) is tried
 * first. SPEC §17.19. */
static const char *const DLX_COMMUNITY_PW[] = {
  "DLPSGAME.COM", "[DLPSGAME.COM]", "www.DLPSGAME.COM", "SuperPSX", "downloadgameps3.com", "hako",
};

int dlx_extract_run(dl_job *j, const settings_t *s) {
  char archive[1024], root[256], label[32], filename[256], id[16], password[128];
  dl_lock();
  xstrlcpy(archive, j->path, sizeof archive);
  xstrlcpy(root, j->root, sizeof root);
  xstrlcpy(label, j->rootLabel, sizeof label);
  xstrlcpy(filename, j->filename, sizeof filename);
  xstrlcpy(id, j->id, sizeof id);
  xstrlcpy(password, j->extractPassword, sizeof password);
  j->state = DL_EXTRACTING;
  xstrlcpy(j->phase, "extracting", sizeof j->phase);
  xstrlcpy(j->extract.state, "extracting", sizeof j->extract.state);
  j->extract.dir[0] = j->extract.message[0] = 0;
  j->extract.files = 0;
  j->extract.bytes = 0;
  j->extract.archiveDeleted = 0;
  j->written = 0;
  dl_unlock();

  zip_entry_info *entries = calloc(MAX_ENTRIES, sizeof *entries);
  if (!entries) return finish_fail(j, "oom", "Out of memory", NULL);
  zip_stats st;
  int n = zip_list(archive, entries, MAX_ENTRIES, &st);
  if (n < 0) { free(entries); return finish_fail(j, "extract_failed", "The file is not a readable ZIP archive", NULL); }
  int files = 0, last_file = -1;
  uint64_t total = 0;
  for (int i = 0; i < n; i++) {
    if (entries[i].is_dir) continue;
    if (zip_name_is_junk(entries[i].name)) continue;
    if (!zip_name_is_safe(entries[i].name)) continue;
    files++;
    last_file = i;
    total += entries[i].size;
  }
  if (files == 0) { free(entries); return finish_fail(j, "extract_failed", "The archive holds no usable files", NULL); }
  if (st.entries > MAX_ENTRIES) { free(entries); return finish_fail(j, "extract_failed", "The archive holds too many entries to extract on the console", NULL); }
  /* AES-ZIP is outside miniz: report it clearly instead of failing obscurely. */
  int aes = 0;
  if (zip_is_encrypted(archive, &aes) && aes) {
    free(entries);
    return finish_fail(j, "extract_aes", "This archive uses AES encryption, which the console cannot open. Download a non-AES version or extract it on a PC.", NULL);
  }
  /* Password list: the job's catalog/user password first, then community defaults. */
  const char *pwlist[1 + (int)(sizeof DLX_COMMUNITY_PW / sizeof DLX_COMMUNITY_PW[0])];
  int npw = 0;
  if (password[0]) pwlist[npw++] = password;
  for (size_t pi = 0; pi < sizeof DLX_COMMUNITY_PW / sizeof DLX_COMMUNITY_PW[0]; pi++) pwlist[npw++] = DLX_COMMUNITY_PW[pi];
  int64_t fr;
  if (storage_free_space(root, &fr, NULL) == 0 && (uint64_t)fr < total + (uint64_t)DL_RESERVE_BYTES) {
    char a[32], b[32], m[200];
    util_fmt_bytes((int64_t)total, a, sizeof a);
    util_fmt_bytes(fr, b, sizeof b);
    xsnprintf(m, sizeof m, "Not enough free space on %s to extract: need %s, have %s", label, a, b);
    free(entries);
    return finish_fail(j, "no_space", m, NULL);
  }

  /* Decide the layout: one image/package file → straight to its final path;
   * anything else → <root>/homebrew/<archive name>/ as a folder dump. */
  char ext[16] = "";
  const char *single_base = NULL;
  if (files == 1) {
    single_base = strrchr(entries[last_file].name, '/');
    single_base = single_base ? single_base + 1 : entries[last_file].name;
    util_ext(single_base, ext, sizeof ext);
    if (!image_ext(ext)) single_base = NULL;
  }
  char dest[1024], tmpdir[1024], name[256];
  prog p = { j, 0 };
  int rc;
  if (single_base) {
    char safe[256];
    if (storage_sanitize_filename(single_base, safe, sizeof safe) != 0 ||
        storage_join(root, storage_category_for_format(ext), safe, dest, sizeof dest) != 0) {
      free(entries);
      return finish_fail(j, "extract_failed", "The file inside the archive has no usable name", NULL);
    }
    if (util_file_exists(dest)) { free(entries); char m[300]; xsnprintf(m, sizeof m, "%s already exists on %s", safe, label); return finish_fail(j, "exists", m, NULL); }
    char tmpname[64];
    xsnprintf(tmpname, sizeof tmpname, ".xeno-extract-%s", id);
    xsnprintf(tmpdir, sizeof tmpdir, "%s/xeno-store/files/%s", root, tmpname);
    rm_tree(tmpdir, 0);
    dl_jlog(j, "extracting %s → %s", single_base, dest);
    rc = zip_extract_to_dir_pw(archive, tmpdir, total + (1u << 20), pwlist, npw, progress_cb, &p, &st);
    if (rc == 1) { rm_tree(tmpdir, 0); free(entries); return 1; }
    if (rc != 0) { free(entries); return finish_fail(j, "extract_failed", st.error[0] ? st.error : "Extraction failed", tmpdir); }
    char produced[1024];
    xsnprintf(produced, sizeof produced, "%s/%s", tmpdir, entries[last_file].name);
    storage_ensure_parent_dir(dest);
    if (rename(produced, dest) != 0) { free(entries); return finish_fail(j, "extract_failed", "Cannot move the extracted file into place", tmpdir); }
    util_fsync_dir(dest);
    rm_tree(tmpdir, 0);
    xstrlcpy(name, dest, sizeof name);
  } else {
    char base[256];
    xstrlcpy(base, filename, sizeof base);
    size_t bl = strlen(base);
    if (bl > 4 && util_iends_with(base, ".zip")) base[bl - 4] = 0;
    char safe[256];
    if (storage_sanitize_filename(base, safe, sizeof safe) != 0 || storage_join(root, "homebrew", safe, dest, sizeof dest) != 0) {
      free(entries);
      return finish_fail(j, "extract_failed", "Cannot build a safe folder name for the archive", NULL);
    }
    if (util_file_exists(dest)) { free(entries); return finish_fail(j, "exists", "A file with the archive's name already exists in homebrew/", NULL); }
    /* Stage into a sibling temp folder, then publish atomically with rename so
     * a cancelled/failed extraction never leaves a half-written app behind. */
    char tmpname[64];
    xsnprintf(tmpname, sizeof tmpname, ".xeno-extract-%s", id);
    xsnprintf(tmpdir, sizeof tmpdir, "%s/xeno-store/files/%s", root, tmpname);
    rm_tree(tmpdir, 0);
    dl_jlog(j, "extracting %d files → %s/", files, dest);
    rc = zip_extract_to_dir_pw(archive, tmpdir, total + (1u << 20), pwlist, npw, progress_cb, &p, &st);
    if (rc == 1) { rm_tree(tmpdir, 0); free(entries); return 1; }
    if (rc != 0) { free(entries); return finish_fail(j, "extract_failed", st.error[0] ? st.error : "Extraction failed", tmpdir); }
    storage_ensure_parent_dir(dest);
    if (rename(tmpdir, dest) != 0) { free(entries); return finish_fail(j, "extract_failed", "Cannot move the extracted files into place", tmpdir); }
    util_fsync_dir(dest);
    xstrlcpy(name, dest, sizeof name);
  }
  free(entries);
  int deleted = 0;
  if (s->deleteArchiveAfterExtract) {
    if (unlink(archive) == 0) { deleted = 1; util_fsync_dir(archive); }
    else LOGW("extract: cannot delete %s: %s", archive, strerror(errno));
  }
  char fb[32];
  util_fmt_bytes((int64_t)st.bytes, fb, sizeof fb);
  dl_lock();
  j->state = DL_EXTRACTED;
  j->phase[0] = 0;
  xstrlcpy(j->extract.state, "extracted", sizeof j->extract.state);
  xstrlcpy(j->extract.dir, name, sizeof j->extract.dir);
  j->extract.files = st.extracted;
  j->extract.bytes = (int64_t)st.bytes;
  j->extract.archiveDeleted = deleted;
  j->written = j->total = (int64_t)st.bytes;
  j->finishedAt = util_now();
  j->errorCode[0] = j->error[0] = 0;
  if (st.skipped) xsnprintf(j->extract.message, sizeof j->extract.message, "%d unsafe entr%s skipped", st.skipped, st.skipped == 1 ? "y" : "ies");
  else j->extract.message[0] = 0;
  xsnprintf(j->message, sizeof j->message, "Extracted %d file%s (%s)%s", st.extracted, st.extracted == 1 ? "" : "s", fb,
            deleted ? " · archive removed" : "");
  dl_mark_dirty_locked();
  dl_unlock();
  dl_jlog(j, "extracted %d file(s), %s, %d skipped%s", st.extracted, fb, st.skipped, deleted ? ", archive deleted" : "");
  return 0;
}
