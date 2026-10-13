/*
 * cx_uninstall.h — clean uninstall (SPEC §17.16) and the ghost icon cleaner
 * for /data/homebrew folders.
 */
#ifndef XENO_CX_UNINSTALL_H
#define XENO_CX_UNINSTALL_H

#include "json.h"
#include <stddef.h>

/* Performs the selected deletions (exact paths only) and writes "removed",
 * "kept", "failed". Returns 0; the caller stops the server afterwards. */
int cx_uninstall(int data, int homebrew, int payload_manager, int downloads, jw *w);
/* Writes "dirs": [{name,path,size,hasEboot,hasIcon,isXenoStore,mtime}]. */
void cx_homebrew_dirs_json(jw *w);
/* Deletes one listed folder; confirm must equal the folder name. */
int cx_homebrew_dir_delete(const char *name, const char *confirm, char *code, size_t ccap, char *err, size_t errcap);

#endif
