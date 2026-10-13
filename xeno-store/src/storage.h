/*
 * storage.h — download roots, free space, safe path building and the library
 * scan (SPEC §3, §5, §6.4).
 */
#ifndef XENO_STORAGE_H
#define XENO_STORAGE_H

#include "json.h"
#include <stddef.h>
#include <stdint.h>

#define STORAGE_MAX_ROOTS 12

typedef struct storage_root {
  char path[256];
  char label[32];
  char kind[12];        /* internal | m2 | usb */
  int64_t free, total;
  int writable;
  int is_default;
} storage_root;

void storage_init(void);
int storage_scan_roots(void);                         /* re-discovers, returns count */
int storage_get_roots(storage_root *out, int max);     /* snapshot */
int storage_find_root(const char *path, storage_root *out);  /* known root by exact path */
int storage_root_present(const char *root);            /* stat() says directory */
int storage_free_space(const char *path, int64_t *free_out, int64_t *total_out);
/* "homebrew" for images, "pkg" for packages, "files" for everything else. */
const char *storage_category_for_format(const char *format);
/* Strips path separators/control chars/leading dots; truncates to 200 bytes.
 * Returns -1 when nothing usable remains. */
int storage_sanitize_filename(const char *in, char *out, size_t cap);
/* Builds <root>/<category dir>/<filename>; the root must be a known root. */
int storage_join(const char *root, const char *category, const char *filename, char *out, size_t cap);
int storage_ensure_parent_dir(const char *path);
/* Where installed titles live: /user/app on PS5, <data>/user/app on host. */
const char *storage_user_app_dir(void);
int storage_title_installed(const char *titleId);

/* Library scan: writes "files", "installed", "scannedAt" keys. */
typedef int (*storage_job_lookup_fn)(const char *path, char *job_id, size_t cap);
void storage_set_job_lookup(storage_job_lookup_fn fn);
void storage_library_json(jw *w);
int storage_library_path_allowed(const char *path);
int storage_library_delete(const char *path, char *err, size_t errcap);

#endif
