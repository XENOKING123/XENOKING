# XENO STORE — web UI

Single-file UI (`dist/index.html`) for the PS5 payload, plain ES2017 JavaScript, no framework.
SPEC §11 is the contract; `src/js/50-router.js` is the route table and `src/js/4x-*.js` are the screens.

```
node web/build.mjs                 # src/** → dist/index.html (prints the size; fails on missing i18n keys / ES2017+ syntax)
node web/dev-server.mjs --port 9095  # serves dist/ + a mock of the whole API (§6) with simulated downloads
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node web/verify-ui.mjs   # build + mock + screenshots + keyboard walk
```

Dev-server flags: `--art local|remote|none` (generated SVG art works offline), `--speed 6`,
`--update`, `--no-downloads`, `--acknowledged` (skip the first-run wizard), `--catalog PATH`.

Layout of `src/`:

| path | role |
|---|---|
| `index.html` | shell with the `<!--XS:…-->` slots the bundler fills |
| `css/00…50-*.css` | tokens → base → components → screens → themes → phone (filename order = cascade order) |
| `js/00…90-*.js` | util, i18n, state, api, nav, sound, components, screens (40–46), router, boot |
| `i18n/en.json` | canonical strings; every other `i18n/<code>.json` mirrors its keys and is embedded too |
| `logo.jpg` | header badge, inlined as a data URI |

Adding a screen: register it with `XS.router.register(id, {tab, icon, label, mount, show, hide, refresh, key})`
in a new numbered file; tabs appear automatically in the top bar and phone bar.
Adding a source kind: `catalog.sources[].kind` drives the download sheet (`direct` | `browser` | `page`).
