/*
 * zip.h — ZIP read/write on top of the vendored miniz (src/third_party/miniz.h).
 *
 * Used for: extracting ZIP game archives after a download (dl.c), community
 * save bundles and companion payload zips (saves.c / companions.c), and
 * writing save backups (saves.c). Paths inside archives are sanitized: no
 * absolute paths, no "..", no NUL/control characters; entries that fail are
 * skipped and counted. Extraction streams entry by entry (no whole-archive
 * in memory) with 1 MiB buffers.
 */
#ifndef XENO_ZIP_H
#define XENO_ZIP_H

#include <stddef.h>
#include <stdint.h>

typedef struct zip_entry_info {
  char name[512];
  uint64_t size;       /* uncompressed */
  int is_dir;
} zip_entry_info;

/* Progress callback: bytes_done/bytes_total over all entries; return non-zero to cancel. */
typedef int (*zip_progress_fn)(void *user, uint64_t bytes_done, uint64_t bytes_total, const char *entry);

typedef struct zip_stats {
  int entries;         /* entries seen */
  int extracted;       /* files written */
  int skipped;         /* unsafe names or over the limit */
  uint64_t bytes;      /* bytes written */
  char error[256];     /* set when the return value is non-zero */
} zip_stats;

/* Lists entries (up to max). Returns the count, or -1 on error (st->error set). */
int zip_list(const char *zip_path, zip_entry_info *out, int max, zip_stats *st);

/* Finds an entry by basename (case-insensitive, e.g. "icon0.png") and copies it
 * into a malloc'd buffer (caller frees). Returns 0, or -1 when absent/too big. */
int zip_extract_to_memory(const char *zip_path, const char *basename, void **out, size_t *out_len, size_t max_len);

/* Extracts every safe entry below dest_dir (created as needed). Directory
 * entries are created; files are written with 0644. `max_total` (0 = no
 * limit) bounds the total uncompressed size. Returns 0, 1 when cancelled by
 * the callback, -1 on error (st->error set; partial output is left in place
 * for the caller to clean up). */
int zip_extract_to_dir(const char *zip_path, const char *dest_dir, uint64_t max_total,
                       zip_progress_fn progress, void *user, zip_stats *st);

/* Creates/overwrites zip_path from every regular file below src_dir (recursively,
 * stored with paths relative to src_dir, deflate level 6). Returns 0 or -1. */
int zip_create_from_dir(const char *zip_path, const char *src_dir, zip_progress_fn progress, void *user, zip_stats *st);

/* Adds one in-memory file to an existing or new archive (e.g. a manifest). */
int zip_add_memory(const char *zip_path, const char *entry_name, const void *data, size_t len);

/* 1 when `name` is a safe relative path for extraction. */
int zip_name_is_safe(const char *name);

#endif
