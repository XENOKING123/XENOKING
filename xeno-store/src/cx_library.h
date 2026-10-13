/*
 * cx_library.h — Library extras (SPEC §17.20): play now, uninstall a title
 * with a double-confirm token, disk analyzer and partial clean-up.
 */
#ifndef XENO_CX_LIBRARY_H
#define XENO_CX_LIBRARY_H

#include "json.h"
#include <stddef.h>

int cx_library_launch(const char *titleId, jw *w, char *code, size_t ccap, char *err, size_t errcap);
/* Without a valid token: writes confirmRequired/token/expiresIn and returns 1.
 * With it: uninstalls and returns 0. -1 on error. */
int cx_library_uninstall(const char *titleId, const char *token, jw *w, char *code, size_t ccap, char *err, size_t errcap);
/* Writes "roots": [{path,label,kind,free,total,used,categories:{...},partials:[...]}]. */
void cx_library_usage_json(jw *w);
/* Deletes partial files (not owned by a queue job) below one root ("" = all). */
int cx_library_clean_partials(const char *root, jw *w, char *err, size_t errcap);

#endif
