# Enrichment caches (SPEC §17.1)

Written by `tools/catalog/enrich/steam.py` and `tools/catalog/enrich/psstore.py` during
`build_catalog.py --online` and committed by the catalog-sync workflow so offline builds reuse them:

* `steam-cache.json` — `{"version": 1, "entries": {"<normalized title>": {appId, screenshots, about, developer,
  publisher, genres, metacritic, releaseDate, features, ageRating, languages, fetchedAt} | {"miss": true, fetchedAt}}}`
* `psstore-cache.json` — `{"version": 1, "entries": {"<store url>": {screenshots, about, cover, fetchedAt} | {"miss": true, fetchedAt}}}`

Both grow a little on every sync (one request every 2.5 s / 2 s, bounded by `--enrich-budget`); misses are
retried after 30 days, hits after 180. Never hand-edit: delete an entry to force a re-fetch.
