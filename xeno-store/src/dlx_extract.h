/*
 * dlx_extract.h — ZIP extraction after a download (SPEC §17.19): folder dumps
 * go to <root>/homebrew/<name>/, a zip holding a single image/package file is
 * extracted straight to its final location; the archive is deleted after a
 * successful extraction when settings.downloads.deleteArchiveAfterExtract.
 */
#ifndef XENO_DLX_EXTRACT_H
#define XENO_DLX_EXTRACT_H

#include "dl.h"
#include "settings.h"

/* Runs on the worker thread; j->state must be DL_EXTRACTING on entry.
 * Returns 0 extracted, 1 cancelled, -1 failed. Fills j->extract and sets
 * j->state to DL_EXTRACTED or DL_DONE (archive kept) accordingly. */
int dlx_extract_run(dl_job *j, const settings_t *s);
/* 1 when the job's format is ZIP. */
int dlx_extract_applies(const dl_job *j);

#endif
