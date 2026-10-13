/*
 * cx_savestore.h — PS5 Save Data Store engine side (SPEC §17.22): merged
 * community index (GitHub index feeds + Supabase REST + Garlic rows through
 * the edge function), compatibility against the installed titles, install /
 * download jobs, export, upload adapters and submission.
 */
#ifndef XENO_CX_SAVESTORE_H
#define XENO_CX_SAVESTORE_H

#include "json.h"
#include <stddef.h>
#include <stdint.h>

void cx_savestore_init(void);
/* Writes "saves": [...], "sources": [...], "updatedAt", "count". */
int cx_savestore_list_json(const char *titleId, const char *category, const char *q, int refresh, jw *w);
/* Installed version of a title (appmeta param.json contentVersion, then
 * /user/app/<id>/sce_sys/param.json). source gets "appmeta"|"app"|"". */
int cx_installed_version(const char *titleId, char *out, size_t cap, char *source, size_t scap);
/* Starts a save-install / save-download job. */
int cx_savestore_install(const char *id, uint32_t uid, int backup_first, int download_only, char *job_id, size_t idcap, char *code, size_t ccap, char *err, size_t errcap);
/* Export (synchronous): writes zipPath, manifest, sha256, size, format, tier. */
int cx_savestore_export(uint32_t uid, const char *titleId, const char *dirName, jw *w, char *code, size_t ccap, char *err, size_t errcap);
/* Upload (synchronous): writes url, sha256, size, host. */
int cx_savestore_upload(const char *zipPath, const char *host, jw *w, char *code, size_t ccap, char *err, size_t errcap);
/* Submit metadata: writes method, issueUrl, qr (and id when inserted). */
int cx_savestore_submit(jv meta, jw *w, char *code, size_t ccap, char *err, size_t errcap);
/* Cover redirect target for a store row ("" when none). */
int cx_savestore_cover_url(const char *id, char *out, size_t cap);
void cx_savestore_tick(void);

#endif
