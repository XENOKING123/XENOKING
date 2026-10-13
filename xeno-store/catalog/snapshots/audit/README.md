# Link audit results (SPEC §17.12)

`results.json` is written by `tools/catalog/audit.py` and committed by the catalog-sync workflow:

```
{"version": 1, "auditedAt": "<ISO>", "counts": {"ok": n, "flaky": n, "dead": n, "page": n},
 "results": {"<release url>": {"verdict": "ok|flaky|dead|page", "status": 206, "checkedAt": "<ISO>", "size": 123,
                               "contentType": "...", "failures": 0, "detail": "...", "kind": "archive|direct|page"}}}
```

`build_catalog.py` reads it on every build: `dead` releases are dropped, `release.health` is set and
`game.verified` becomes "any ok direct release". The file is resumable (a budgeted run checks what it can and
the next run continues), `ok` links are re-checked after 7 days, `flaky`/`page` every run, and URLs that left the
catalog are forgotten after 60 days.
