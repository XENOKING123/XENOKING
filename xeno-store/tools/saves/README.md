# tools/saves — Save Data Store intake

`intake.py` turns a `save-submission` GitHub issue into a row of
`updates/saves.json` (SPEC §17.22.5). Stdlib only, Python 3.10+.

```
tools/saves/
  intake.py                 parse issue body → validate → capped download → sha256 → zip inspection → index upsert
  tests/test_intake.py      44 tests (parsing, validation, download against a local HTTP server, zips, index, end-to-end runs)
  tests/fixtures/           make_fixtures.py (deterministic) → good-save.zip, garlic-save.zip, sealed-save.zip,
                            raw-backup.zip, issue-good.md, event-opened.json
```

| command (from `xeno-store/`) | what |
|---|---|
| `python3 -I tools/saves/intake.py --event "$GITHUB_EVENT_PATH" --index updates/saves.json --out result.json` | what the workflow runs |
| `python3 -I tools/saves/intake.py --body issue.md --number 12 --labels approved --file save.zip --dry-run` | check a local zip against an issue body, write nothing |
| `python3 -I tools/saves/intake.py --issue-json issue.json` | input from `gh issue view N --json number,title,body,labels,createdAt,url` |
| `python3 -I tools/saves/intake.py --validate-index updates/saves.json` | schema check of the index (exit 1 on errors) |
| `python3 -I -m unittest discover -s tools/saves/tests -v` | tests |
| `python3 -I tools/saves/tests/fixtures/make_fixtures.py` | regenerate the fixtures (same bytes every run) |

Exit codes: 0 the intake ran (the result JSON holds the verdict), 1 tool
error (unreadable index, bad arguments), 2 with `--strict` when the submission
was rejected. The result JSON has `ok`, `status` (`pending` / `published` /
`rejected`), `errors`, `warnings`, `checks` (size, sha256, layout, dataFiles,
manifest), `entry`, `changed`, `comment` (the Markdown the workflow posts).

Index rules: entries with `status: "example"` are left untouched at the top;
intake rows are keyed by issue number, sorted by it, written with a fixed key
order, 2-space indent and a trailing newline, so an unchanged run produces the
same bytes and the workflow has nothing to commit. See `docs/SAVES.md` §7 for
the checks and the label → status table.
