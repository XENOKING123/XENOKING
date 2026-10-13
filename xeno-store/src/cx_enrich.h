/*
 * cx_enrich.h — on-console game enrichment (SPEC §17.2): Steam storesearch +
 * appdetails merged over the catalog entry, cached 30 days on disk, fail-soft.
 */
#ifndef XENO_CX_ENRICH_H
#define XENO_CX_ENRICH_H

#include "json.h"

/* Writes cached, screenshots, about, developer, publisher, metacritic,
 * features, languages, releaseDate, ageRating, steamId, source. Returns 0
 * (always answers; offline → cached:false, screenshots:[]); -1 when the game
 * id is unknown. */
int cx_enrich_json(const char *gameId, int refresh, jw *w);

#endif
