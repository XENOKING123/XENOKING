/*
 * cx_companions.h — companion payloads (SPEC §17.16/§17.18): owner-curated
 * list (updates/companions.json), sha256-verified download to
 * <data>/payloads/<id>.elf and launch by sending the raw bytes to the local
 * ELF loader on 127.0.0.1:9021.
 */
#ifndef XENO_CX_COMPANIONS_H
#define XENO_CX_COMPANIONS_H

#include "json.h"
#include <stddef.h>

void cx_companions_init(void);
/* Writes "payloads": [...], "loaderPort", "loaderAvailable". */
void cx_companions_json(jw *w);
/* Starts the download/verify job; writes the job id. */
int cx_companions_install(const char *id, char *job_id, size_t idcap, char *code, size_t ccap, char *err, size_t errcap);
/* Sends the installed ELF to the loader; writes "bytes", "port". */
int cx_companions_launch(const char *id, jw *w, char *code, size_t ccap, char *err, size_t errcap);
/* Finds an installed payload whose id/name/kind mentions `needle`. */
int cx_companions_find_installed(const char *needle, char *id_out, size_t cap);

#endif
