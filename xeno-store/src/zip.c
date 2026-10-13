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
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

#define ZIP_BUF (1u << 20)

static void st_reset(zip_stats *st) { if (st) memset(st, 0, sizeof *st); }
static void st_err(zip_stats *st, const char *fmt, const char *a) {
  if (!st) return;
  xsnprintf(st->error, sizeof st->error, fmt, a ? a : "");
}

/* Validates that `s` is well-formed UTF-8 (no overlong forms, no surrogates,
 * no code points above U+10FFFF). An exFAT filename must be valid Unicode. */
static int utf8_valid(const char *s) {
  const unsigned char *p = (const unsigned char *)s;
  while (*p) {
    unsigned char c = *p;
    int n;
    uint32_t cp;
    if (c < 0x80) { p++; continue; }
    else if ((c & 0xE0) == 0xC0) { n = 1; cp = c & 0x1F; }
    else if ((c & 0xF0) == 0xE0) { n = 2; cp = c & 0x0F; }
    else if ((c & 0xF8) == 0xF0) { n = 3; cp = c & 0x07; }
    else return 0;
    for (int i = 0; i < n; i++) { if ((p[1 + i] & 0xC0) != 0x80) return 0; cp = (cp << 6) | (p[1 + i] & 0x3F); }
    if (n == 1 && cp < 0x80) return 0;           /* overlong */
    if (n == 2 && cp < 0x800) return 0;
    if (n == 3 && cp < 0x10000) return 0;
    if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return 0;
    p += n + 1;
  }
  return 1;
}

/* Archive housekeeping entries we quietly drop (not an error, not "unsafe"). */
int zip_name_is_junk(const char *name) {
  if (!name) return 1;
  if (strncmp(name, "__MACOSX/", 9) == 0 || strcmp(name, "__MACOSX") == 0) return 1;
  const char *base = strrchr(name, '/');
  base = base ? base + 1 : name;
  if (strcmp(base, ".DS_Store") == 0 || strcmp(base, "Thumbs.db") == 0 || strcmp(base, "desktop.ini") == 0) return 1;
  return 0;
}

int zip_name_is_safe(const char *name) {
  if (!name || !*name) return 0;
  if (name[0] == '/' || name[0] == '\\') return 0;          /* absolute */
  size_t len = strlen(name);
  if (len >= 500) return 0;
  if (!utf8_valid(name)) return 0;
  const char *p = name;
  while (*p) {
    unsigned char ch = (unsigned char)*p;
    if (ch < 0x20 || ch == 0x7f) return 0;                  /* control */
    /* exFAT-illegal filename characters (backslash is also a separator). */
    if (ch == ':' || ch == '*' || ch == '?' || ch == '"' || ch == '<' || ch == '>' || ch == '|') return 0;
    p++;
  }
  /* reject "." / ".." segments, backslash separators, and cap the depth */
  const char *seg = name;
  int depth = 0;
  for (;;) {
    const char *end = seg;
    while (*end && *end != '/' && *end != '\\') end++;
    size_t n = (size_t)(end - seg);
    if (n == 0 && *end) { /* empty segment ("a//b") */ if (seg != name) return 0; }
    if ((n == 1 && seg[0] == '.') || (n == 2 && seg[0] == '.' && seg[1] == '.')) return 0;
    if (n > 0 && ++depth > 32) return 0;                    /* too deeply nested */
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

/* ---- classic ZipCrypto (traditional PKWARE) decryption ------------------
 * miniz cannot decrypt, so the well-known community passwords for scene ZIPs
 * are handled here: a stream cipher over the compressed bytes, which we then
 * inflate (or copy) straight to disk. AES-ZIP (method 99 / WinZip AE) is not
 * supported and is reported, never guessed at. */
static uint32_t zc_crc_tab[256];
static int zc_crc_ready;
static void zc_crc_init(void) {
  for (uint32_t i = 0; i < 256; i++) { uint32_t c = i; for (int k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1); zc_crc_tab[i] = c; }
  zc_crc_ready = 1;
}
static uint32_t zc_crc_step(uint32_t crc, uint8_t b) { return zc_crc_tab[(crc ^ b) & 0xff] ^ (crc >> 8); }

typedef struct { uint32_t k0, k1, k2; } zc_keys;
static void zc_update(zc_keys *k, uint8_t c) {
  k->k0 = zc_crc_step(k->k0, c);
  k->k1 = (k->k1 + (k->k0 & 0xff)) * 134775813u + 1u;
  k->k2 = zc_crc_step(k->k2, (uint8_t)(k->k1 >> 24));
}
static void zc_init(zc_keys *k, const char *pw) {
  k->k0 = 305419896u; k->k1 = 591751049u; k->k2 = 878082192u;
  for (const unsigned char *p = (const unsigned char *)(pw ? pw : ""); *p; p++) zc_update(k, *p);
}
static uint8_t zc_decode(zc_keys *k, uint8_t c) {
  uint16_t t = (uint16_t)((uint16_t)(k->k2 & 0xffff) | 2);
  uint8_t plain = c ^ (uint8_t)(((uint32_t)t * (uint32_t)(t ^ 1)) >> 8);
  zc_update(k, plain);
  return plain;
}

static int write_full(int fd, const unsigned char *buf, size_t n) {
  size_t off = 0;
  while (off < n) { ssize_t w = write(fd, buf + off, n - off); if (w < 0) { if (errno == EINTR) continue; return -1; } off += (size_t)w; }
  return 0;
}

/* Returns the archive offset of an entry's file data, and its DOS mod-time
 * high byte (for the ZipCrypto check), or -1. Reads the LOCAL header, whose
 * name/extra lengths can differ from the central directory. */
static int64_t zc_data_offset(int zfd, uint64_t local_hdr_ofs, uint8_t *time_hi) {
  unsigned char lh[30];
  if (pread(zfd, lh, sizeof lh, (off_t)local_hdr_ofs) != (ssize_t)sizeof lh) return -1;
  if (lh[0] != 0x50 || lh[1] != 0x4b || lh[2] != 0x03 || lh[3] != 0x04) return -1;
  if (time_hi) *time_hi = lh[11];
  unsigned fn = (unsigned)lh[26] | ((unsigned)lh[27] << 8);
  unsigned ex = (unsigned)lh[28] | ((unsigned)lh[29] << 8);
  return (int64_t)local_hdr_ofs + 30 + fn + ex;
}

/* One full ZipCrypto pass with password `pw` into outfd. 0 ok (CRC matches),
 * 1 CRC mismatch (wrong password), -1 I/O or inflate error. */
static int zc_extract_pass(int zfd, int64_t doff, const mz_zip_archive_file_stat *s, const char *pw, int outfd) {
  if (ftruncate(outfd, 0) != 0 || lseek(outfd, 0, SEEK_SET) != 0) return -1;
  zc_keys k;
  zc_init(&k, pw);
  unsigned char hdr[12];
  if (pread(zfd, hdr, sizeof hdr, (off_t)doff) != (ssize_t)sizeof hdr) return -1;
  for (int i = 0; i < 12; i++) zc_decode(&k, hdr[i]);
  int64_t remaining = (int64_t)s->m_comp_size - 12;
  int64_t src = doff + 12;
  if (remaining < 0) return -1;
  uint32_t crc = (uint32_t)mz_crc32(0, NULL, 0);
  unsigned char inbuf[65536];
  if (s->m_method == 0) {   /* stored */
    while (remaining > 0) {
      size_t want = remaining < (int64_t)sizeof inbuf ? (size_t)remaining : sizeof inbuf;
      ssize_t rd = pread(zfd, inbuf, want, (off_t)src);
      if (rd <= 0) return -1;
      for (ssize_t i = 0; i < rd; i++) inbuf[i] = zc_decode(&k, inbuf[i]);
      if (write_full(outfd, inbuf, (size_t)rd) != 0) return -1;
      crc = (uint32_t)mz_crc32(crc, inbuf, (size_t)rd);
      src += rd; remaining -= rd;
    }
  } else if (s->m_method == 8) {   /* deflate, streamed through tinfl */
    tinfl_decompressor inf;
    tinfl_init(&inf);
    unsigned char *dict = malloc(TINFL_LZ_DICT_SIZE);
    if (!dict) return -1;
    size_t dict_ofs = 0, in_have = 0, in_ofs = 0;
    int rc = -1;
    for (;;) {
      if (in_ofs == in_have && remaining > 0) {
        size_t want = remaining < (int64_t)sizeof inbuf ? (size_t)remaining : sizeof inbuf;
        ssize_t rd = pread(zfd, inbuf, want, (off_t)src);
        if (rd <= 0) break;
        for (ssize_t i = 0; i < rd; i++) inbuf[i] = zc_decode(&k, inbuf[i]);
        in_ofs = 0; in_have = (size_t)rd; src += rd; remaining -= rd;
      }
      size_t in_bytes = in_have - in_ofs;
      size_t out_bytes = TINFL_LZ_DICT_SIZE - dict_ofs;
      mz_uint32 flags = remaining > 0 ? TINFL_FLAG_HAS_MORE_INPUT : 0;
      tinfl_status stt = tinfl_decompress(&inf, inbuf + in_ofs, &in_bytes, dict, dict + dict_ofs, &out_bytes, flags);
      in_ofs += in_bytes;
      if (out_bytes) {
        if (write_full(outfd, dict + dict_ofs, out_bytes) != 0) break;
        crc = (uint32_t)mz_crc32(crc, dict + dict_ofs, out_bytes);
        dict_ofs = (dict_ofs + out_bytes) & (TINFL_LZ_DICT_SIZE - 1);
      }
      if (stt == TINFL_STATUS_DONE) { rc = 0; break; }
      if (stt < TINFL_STATUS_DONE) break;                 /* inflate failure */
      if (stt == TINFL_STATUS_NEEDS_MORE_INPUT && remaining == 0 && in_ofs == in_have) break;  /* truncated */
    }
    free(dict);
    if (rc != 0) return -1;
  } else {
    return -1;   /* unsupported compression inside an encrypted entry */
  }
  return crc == s->m_crc32 ? 0 : 1;
}

/* 1 when the archive has any encrypted entry; *aes set when it is AES-ZIP. */
int zip_is_encrypted(const char *zip_path, int *aes) {
  if (aes) *aes = 0;
  mz_zip_archive z;
  memset(&z, 0, sizeof z);
  if (!mz_zip_reader_init_file(&z, zip_path, 0)) return 0;
  int n = (int)mz_zip_reader_get_num_files(&z), enc = 0;
  for (int i = 0; i < n; i++) {
    mz_zip_archive_file_stat s;
    if (!mz_zip_reader_file_stat(&z, (mz_uint)i, &s)) continue;
    if (s.m_is_encrypted) { enc = 1; if (s.m_method == 99 && aes) *aes = 1; }
  }
  mz_zip_reader_end(&z);
  return enc;
}

/* dest_dir free space must hold this file plus a 16 MiB headroom. */
static int zip_room_for(const char *dest_dir, uint64_t need) {
  struct statvfs fs;
  if (statvfs(dest_dir, &fs) != 0) return 1;   /* unknown → let the write try */
  uint64_t avail = (uint64_t)fs.f_bavail * (fs.f_frsize ? fs.f_frsize : fs.f_bsize);
  return avail >= need + (16ull << 20);
}

int zip_extract_to_dir_pw(const char *zip_path, const char *dest_dir, uint64_t max_total,
                          const char *const *passwords, int npasswords,
                          zip_progress_fn progress, void *user, zip_stats *st) {
  st_reset(st);
  if (!zc_crc_ready) zc_crc_init();
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
  if (max_total && total > max_total) { st_err(st, "%s", "archive is larger than the allowed size"); mz_zip_reader_end(&z); return -1; }
  if (st) st->entries = n;
  /* An encrypted entry needs raw reads of the archive file; open it once. */
  int zfd = open(zip_path, O_RDONLY);
  uint64_t done = 0;
  int rc = 0;
  for (int i = 0; i < n && rc == 0; i++) {
    mz_zip_archive_file_stat s;
    if (!mz_zip_reader_file_stat(&z, (mz_uint)i, &s)) continue;
    if (zip_name_is_junk(s.m_filename)) continue;                 /* __MACOSX, .DS_Store … */
    if (!zip_name_is_safe(s.m_filename)) { if (st) st->skipped++; LOGW("zip: skipping unsafe entry %s", s.m_filename); continue; }
    char path[1024];
    if (xsnprintf(path, sizeof path, "%s/%s", dest_dir, s.m_filename) >= (int)sizeof path - 1) { if (st) st->skipped++; continue; }
    if (mz_zip_reader_is_file_a_directory(&z, (mz_uint)i)) { util_mkdir_p(path); continue; }
    if (!zip_room_for(dest_dir, (uint64_t)s.m_uncomp_size)) { st_err(st, "not enough free space for %s", s.m_filename); rc = -1; break; }
    if (mkdirs_for(path) != 0) { st_err(st, "cannot create directory for %s", s.m_filename); rc = -1; break; }
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { st_err(st, "cannot write %s", s.m_filename); rc = -1; break; }
    if (s.m_is_encrypted) {
      if (s.m_method == 99) { close(fd); unlink(path); st_err(st, "%s uses AES encryption, which is not supported on the console", s.m_filename); rc = -1; break; }
      if (zfd < 0) { close(fd); st_err(st, "%s", "cannot reopen the archive for decryption"); rc = -1; break; }
      uint8_t time_hi = 0;
      int64_t doff = zc_data_offset(zfd, s.m_local_header_ofs, &time_hi);
      uint8_t crc_hi = (uint8_t)(s.m_crc32 >> 24);
      int got = -2;   /* -2 no candidate password, -1 error, 0 ok, 1 crc fail */
      for (int p = 0; p < npasswords && got != 0; p++) {
        if (!passwords[p] || !passwords[p][0]) continue;
        /* cheap check byte filter (matches CRC-high or time-high) */
        zc_keys k; zc_init(&k, passwords[p]);
        unsigned char hdr[12];
        if (doff < 0 || pread(zfd, hdr, sizeof hdr, (off_t)doff) != (ssize_t)sizeof hdr) { got = -1; break; }
        uint8_t last = 0;
        for (int b = 0; b < 12; b++) last = zc_decode(&k, hdr[b]);
        if (last != crc_hi && last != time_hi) continue;
        got = zc_extract_pass(zfd, doff, &s, passwords[p], fd);  /* 0 ok, 1 crc, -1 err */
        if (got == -1) break;
      }
      close(fd);
      if (got == 0) { done += (uint64_t)s.m_uncomp_size; if (st) { st->extracted++; st->bytes = done; } if (progress && progress(user, done, total, s.m_filename)) { rc = 1; break; } continue; }
      unlink(path);
      st_err(st, got == -1 ? "could not decrypt %s" : "wrong or missing password for %s", s.m_filename);
      rc = -1;
      break;
    }
    extract_ctx x = { fd, 0, done, total, progress, user, s.m_filename, 0, 0 };
    mz_bool ok = mz_zip_reader_extract_to_callback(&z, (mz_uint)i, extract_write_cb, &x, 0);
    close(fd);
    if (x.cancelled) { rc = 1; break; }
    if (!ok || x.failed) { st_err(st, "failed to extract %s", s.m_filename); rc = -1; break; }
    done += x.written;
    if (st) { st->extracted++; st->bytes = done; }
  }
  if (zfd >= 0) close(zfd);
  mz_zip_reader_end(&z);
  return rc;
}

int zip_extract_to_dir(const char *zip_path, const char *dest_dir, uint64_t max_total,
                       zip_progress_fn progress, void *user, zip_stats *st) {
  return zip_extract_to_dir_pw(zip_path, dest_dir, max_total, NULL, 0, progress, user, st);
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
