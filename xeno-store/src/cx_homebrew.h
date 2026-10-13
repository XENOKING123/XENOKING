/*
 * cx_homebrew.h — homebrew apps store (SPEC §17.21): live pkg-zone listing
 * parser (7-day cache) merged with the catalog's HOMEBREW entries, installed
 * state from installed.json + /user/app, and the allowlisted cover proxy.
 */
#ifndef XENO_CX_HOMEBREW_H
#define XENO_CX_HOMEBREW_H

#include "json.h"
#include "server.h"
#include <stddef.h>

void cx_homebrew_init(void);
/* Writes "items": [...], "categories", "fetchedAt", "cached", "source". */
int cx_homebrew_json(int refresh, const char *q, const char *category, jw *w);
/* Parses one pkg-zone listing page into the writer (array elements). Returns the count. */
int cx_homebrew_parse_page(const char *html, size_t len, jw *w, int *seen_ids);
int cx_homebrew_record_installed(const char *id, const char *titleId, const char *version, char *err, size_t errcap);
/* GET /api/image?url= — answers the request itself (image bytes or JSON error). */
void cx_image_proxy(http_req *req, const char *url);

#endif
