# Multi-console redesign — fully isolated, parallel per-PS5 operation

## Goal

Run up to ~12 consoles **at the same time**, each totally independent — its own
upload queue, its own PS4/PS5 pkg-install queue, its own browse/hardware/FTP
view — like opening 12 copies of ps5upload in one window. A **tab per console**
switches which one you're *looking at*; every console's work keeps running in the
background regardless of the active tab.

## What already works (no changes needed)

The transport and backend are already multi-console:

- **Engine** (`engine/`) is stateless-per-request: every route takes an `addr`,
  jobs are keyed by UUID (`AppState.jobs: HashMap<Uuid, JobState>`), install
  sessions are keyed by UUID (each carries its own `ps5_mgmt_addr`). No
  cross-console lock or "current console" anywhere.
- **Host ports**: one engine listener `:19113`; the PS5-facing pkg-host is
  routed per session UUID (`/pkg-host/{session}/...`) with a peer-IP check — 12
  installs share it with no collision. No host-side DPI port.
- **PS5-side ports** (`:9113/:9114/:9021/:9040`) are outbound, per-IP — distinct
  per console.
- **Upload queue** (`client/src/state/uploadQueue.ts`) is **already per-console
  parallel**: `runningHosts: Record<host, bool>`, per-host generation counters
  (`hostGen`), `nextPendingForHost`, and `start()` fans out one drain loop per
  host via `Promise.all`. This is the reference implementation to copy.
- **Keep-awake** already ticks every host that has a running upload.
- `recentHostMetrics`, `fsLastPath`, `mountDest` are already keyed by host.

**Net: no engine, payload, or protocol work. This is a client state-shape + UI
refactor.**

## The actual blockers / coupling

### Tier A — the install serialization (the reported pain)

1. **`pkgLibrary.ts`** (the Install Package screen — the **active** install path)
   — a single global `installing: boolean` gates `install` / `refresh` /
   `addAndUpload`, app-wide, so an install on console A blocks console B. AND its
   `entries` is a single flat list holding only the *active* host's library
   (no host key). So fixing the flag alone is inconsistent — `pkgLibrary` must
   become fully per-console-keyed: `Record<host, { entries, installing,
   busyNotice, error, loading }>`. This is the real Phase-1 work and it merges
   with Phase 2 for this store.
2. **`installQueue.ts`** — a single global serial worker (`isRunning` + `runId`,
   `items.find(pending)` across all hosts). **Finding: it is effectively
   DORMANT** — no screen renders or starts it; only keep-awake reconcile + the
   Activity stop button reference it. The active path is `pkgLibrary`. So this
   is deprioritised: either delete it or, if it's to return as a real
   multi-console install queue, build it fresh on the `uploadQueue` per-host
   model. Not the cause of the user's current pain.

### Tier B — the single-active-console *view* model

- **`connection.ts`** is a flat singleton describing "the one host you're talking
  to": `host`, `payloadStatus/Version`, `ps5Kernel`, `ucredElevated`,
  `maxTransferStreams`, step flow. Switching console rewrites the single `host`.
  (`engineStatus`/`engineError` are global — the sidecar — and should split out.)
- **21 screens** read `useConnectionStore(s => s.host)` and build addrs from it —
  they all assume the single active host.
- **Status poller** (`AppShell`) polls only the active host (10 s) and writes
  back into the singleton, with elaborate `payloadStatusHost`/`carryOver` race
  logic that exists *only* to defend the single store against mid-flight
  console switches.
- **`staleHostGuard`** (used in 8 screens) discards an in-flight PS5 RPC result
  if the user switched consoles during the await — a workaround for the single
  store. The header notes it replaced 7 simultaneous P0/P1 "wrong-console data"
  bugs.
- Category-(b) stores still hold one active host's data: `library` (no host
  field at all — riskiest), `pkgLibrary`, `runningApps`, `fsClipboard`,
  `fsBulkOp`/`fsDownloadOp`, `transfer`, the `upload` compose draft.

## Target architecture

**Console identity becomes context, not a global.** Each screen instance is
pinned to a console for its whole lifetime; background workers run per-console
independent of the viewed tab.

1. **`consoleId`-keyed state.** Convert each Tier-B singleton into
   `Record<consoleId, State>` (the `uploadQueue`/`recentHostMetrics` pattern).
   Selectors/hooks take a `consoleId`. `engineStatus` moves to a global app
   store.
2. **Console context.** A `ConsoleContext` provider (or route segment
   `/c/:consoleId/...`) supplies the active tab's `consoleId`/host. Screens read
   host from context instead of `connection.host`. Addr helpers
   (`mgmtAddr/transferAddr`) already take host as a param, so each screen change
   is "where does host come from."
3. **Per-console background workers.** Status polling fans out over all roster
   consoles (one loop each, or one loop + `Promise.all`), each writing its own
   keyed slot. Upload + install queues already (will) run per-host loops. The
   viewed tab no longer gates any operation.
4. **Tab strip UI.** A persistent horizontal console tab bar: per-tab name,
   engine/payload status dot, and an activity badge (uploading/installing
   counts). Click → the whole app (sidebar + content) re-scopes to that console.
   "+" adds a console. Replaces the RosterPicker dropdown; the StatusBar's single
   dot pair becomes the per-tab status.
5. **Delete `staleHostGuard` + the poller `carryOver` machinery.** Once screens
   are console-pinned there is no "host switched under me" race. This *removes*
   code and a whole bug class — the redesign is net-simplifying long-term.

**Global (shared across tabs):** theme, lang, all settings, notifications,
schedules, the roster list itself, engine status, audit/activity history
(cross-console, filtered by console in the UI).

## Phased plan (each phase ships independently)

- **Phase 1 — Parallel installs (small, high value, low risk).** Convert
  `installQueue.ts` to the per-host model (`runningHosts` + `hostGen` +
  `nextPendingForHost` + `Promise.all` fan-out; keep within-host serial for
  Sony BGFT). De-globalize `pkgLibrary` (`installing`/`busyNotice`/`error` →
  per-host maps; scope `refresh`/`addAndUpload` gating to the same host).
  **Result: 12 consoles install in parallel — fixes the reported pain — with no
  engine changes and no UI change.** Add per-host queue tests.
- **Phase 2 — Per-console runtime state.** `connection.ts` →
  `Record<consoleId, ConnectionRuntime>` + split out global engine status.
  Status poller → per-console fan-out (drop `carryOver`). Key `library`,
  `pkgLibrary` list, `runningApps`, `fsClipboard`, `fsBulkOp`, `transfer`,
  `upload` draft by console. Data is now isolated even before the tab UI.
- **Phase 3 — Console context + screen re-pinning.** Introduce
  `ConsoleContext`; convert the ~21 screens to read host from context. Delete
  `staleHostGuard` and its 8 call sites.
- **Phase 4 — Tab strip UI.** Persistent console tab bar with per-tab status +
  activity badges; add/remove/rename; replaces RosterPicker. Per-tab StatusBar.
- **Phase 5 — Polish + validation.** Host-tag notification toasts; extend
  keep-awake to install-running hosts; persistence namespacing review; HW
  validation across multiple real consoles (parallel upload + install); i18n.

## Risk / effort

- Phase 1: low risk, isolated to two stores; directly mirrors a battle-tested
  store. Ships the user-visible win on its own.
- Phases 2–3: the bulk — mechanical but broad (~21 screens, ~7 stores). Mitigated
  by the `uploadQueue`/`recentHostMetrics` precedent and by deleting the
  stale-host machinery (negative net code in places).
- Phase 4: moderate UI work; `TabbedShell.tsx` is a reusable starting pattern.
- No engine/payload/protocol changes in any phase.
