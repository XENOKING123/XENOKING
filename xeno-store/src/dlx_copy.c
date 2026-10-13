/* dlx_copy.c — see dlx_copy.h. */
#include "dlx_copy.h"
#include "dlx_internal.h"
#include "log.h"
#include "storage.h"
#include "util.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define COPY_CHUNK (8 << 20)
#define SYNC_EVERY (256LL << 20)

int dlx_copy_same_drive(const char *a, const char *b) {
  struct stat sa, sb;
  if (stat(a, &sa) != 0 || stat(b, &sb) != 0) return 0;
  return sa.st_dev == sb.st_dev;
}

static void sample_locked(dl_job *j, int64_t *last_ms, int64_t *last_written) {
  int64_t now = util_now_ms();
  if (*last_ms == 0) { *last_ms = now; *last_written = j->written; return; }
  int64_t dt = now - *last_ms;
  if (dt < 1000) return;
  double inst = (double)(j->written - *last_written) * 1000.0 / (double)dt;
  j->speed = j->speed > 0 ? 0.3 * inst + 0.7 * j->speed : inst;
  if (j->speed > j->peakSpeed) j->peakSpeed = j->speed;
  *last_ms = now;
  *last_written = j->written;
  int idx = (j->hist_head + j->hist_n) % DL_HISTORY;
  if (j->hist_n == DL_HISTORY) { idx = j->hist_head; j->hist_head = (j->hist_head + 1) % DL_HISTORY; }
  else j->hist_n++;
  j->hist[idx] = (int64_t)inst;
  int64_t remaining = j->total > j->written ? j->total - j->written : 0;
  j->eta = (j->speed > 0 && remaining > 0) ? (int64_t)((double)remaining / j->speed) : 0;
}

static int fail(dl_job *j, const char *code, const char *msg) {
  dl_lock();
  j->state = DL_FAILED;
  j->finishedAt = util_now();
  j->speed = 0;
  j->eta = 0;
  dl_set_error_locked(j, code, msg);
  dl_mark_dirty_locked();
  dl_unlock();
  dl_jlog(j, "%s: %s", code, msg);
  return -1;
}

int dlx_copy_run(dl_job *j) {
  char src[1024], dst_part[1040], dst[1024], label[32];
  int move;
  dl_lock();
  xstrlcpy(src, j->srcPath, sizeof src);
  xstrlcpy(dst_part, j->xpart, sizeof dst_part);
  xstrlcpy(dst, j->path, sizeof dst);
  xstrlcpy(label, j->rootLabel, sizeof label);
  move = j->move;
  j->state = DL_DOWNLOADING;
  xstrlcpy(j->phase, move ? "moving" : "copying", sizeof j->phase);
  j->message[0] = 0;
  dl_unlock();

  struct stat st;
  if (stat(src, &st) != 0 || !S_ISREG(st.st_mode)) return fail(j, "source_missing", "The source file is no longer there");
  int64_t total = (int64_t)st.st_size;
  if (!storage_root_present(j->root)) return fail(j, "drive_missing", "The destination drive is not connected");
  storage_ensure_parent_dir(dst);
  int64_t fr;
  if (storage_free_space(j->root, &fr, NULL) == 0) {
    int64_t have = util_file_size(dst_part);
    if (have < 0) have = 0;
    if (fr + have < total + DL_RESERVE_BYTES) {
      char a[32], b[32], m[200];
      util_fmt_bytes(total, a, sizeof a);
      util_fmt_bytes(fr, b, sizeof b);
      xsnprintf(m, sizeof m, "Not enough free space on %s: need %s, have %s", label, a, b);
      return fail(j, "no_space", m);
    }
  }
  int in = open(src, O_RDONLY);
  if (in < 0) return fail(j, "io_error", "Cannot read the source file");
  int out = open(dst_part, O_WRONLY | O_CREAT, 0644);
  if (out < 0) { close(in); return fail(j, "io_error", "Cannot create the destination file"); }
  /* Resume by size: the last chunk is rewritten in case the previous run
   * stopped before its fdatasync reached the disk. */
  int64_t off = util_file_size(dst_part);
  if (off < 0 || off > total) off = 0;
  off -= off % COPY_CHUNK;
  if (off < 0) off = 0;
  if (off > 0 && ftruncate(out, off) != 0) off = 0;
  char *buf = malloc(COPY_CHUNK);
  if (!buf) { close(in); close(out); return fail(j, "oom", "Out of memory"); }
  dl_lock();
  j->total = total;
  j->written = off;
  j->last_sample_ms = 0;
  dl_unlock();
  if (off > 0) { char fb[32]; util_fmt_bytes(off, fb, sizeof fb); dl_jlog(j, "resuming copy with %s already on %s", fb, label); }
  int64_t last_sync = off, last_ms = 0, last_written = off;
  int rc = 0, stopped = 0;
  while (off < total) {
    if (j->stop_io || j->cancel) { stopped = 1; break; }
    size_t want = (size_t)XS_MIN((int64_t)COPY_CHUNK, total - off);
    ssize_t n = pread(in, buf, want, off);
    if (n < 0) { if (errno == EINTR) continue; rc = -1; fail(j, "io_error", "Reading the source file failed"); break; }
    if (n == 0) { rc = -1; fail(j, "source_changed", "The source file shrank while copying"); break; }
    size_t done = 0;
    int werr = 0;
    while (done < (size_t)n) {
      ssize_t w = pwrite(out, buf + done, (size_t)n - done, off + (int64_t)done);
      if (w < 0) { if (errno == EINTR) continue; werr = errno; break; }
      done += (size_t)w;
    }
    if (werr) {
      rc = -1;
      fail(j, werr == ENOSPC ? "no_space" : "io_error", werr == ENOSPC ? "The destination drive is full" : "Writing the destination file failed");
      break;
    }
    off += n;
    dl_lock();
    j->written = off;
    sample_locked(j, &last_ms, &last_written);
    dl_unlock();
    if (off - last_sync >= SYNC_EVERY) { fdatasync(out); last_sync = off; }
  }
  fdatasync(out);
  free(buf);
  close(in);
  if (rc != 0) { close(out); return -1; }
  if (stopped) {
    close(out);
    dl_lock();
    j->speed = 0;
    j->eta = 0;
    dl_unlock();
    return 1;
  }
  struct stat ds;
  if (fstat(out, &ds) != 0 || (int64_t)ds.st_size != total) { close(out); return fail(j, "size_mismatch", "The copy does not have the same size as the source"); }
  close(out);
  if (stat(src, &st) != 0 || (int64_t)st.st_size != total) return fail(j, "source_changed", "The source file changed while copying");
  if (rename(dst_part, dst) != 0) return fail(j, "io_error", "Cannot rename the copied file");
  util_fsync_dir(dst);
  int unlinked = 0;
  if (move) {
    if (unlink(src) == 0) { unlinked = 1; util_fsync_dir(src); }
    else LOGW("copy: moved %s but could not remove the source: %s", src, strerror(errno));
  }
  char fb[32];
  util_fmt_bytes(total, fb, sizeof fb);
  dl_lock();
  j->state = DL_DONE;
  j->finishedAt = util_now();
  j->phase[0] = 0;
  j->speed = 0;
  j->eta = 0;
  j->written = total;
  j->errorCode[0] = j->error[0] = 0;
  if (move) xsnprintf(j->message, sizeof j->message, unlinked ? "Moved to %s (%s)" : "Copied to %s (%s) — the source could not be removed", label, fb);
  else xsnprintf(j->message, sizeof j->message, "Copied to %s (%s)", label, fb);
  dl_mark_dirty_locked();
  dl_unlock();
  dl_jlog(j, "%s %s → %s (%s)", move ? "moved" : "copied", src, dst, fb);
  return 0;
}
