# ps5upload v3 design — "Control Deck"

The v3 visual and interaction direction, what's implemented, and the
roadmap of larger UX moves that need product decisions before code.

## Direction

A console-grade, machined-panel aesthetic. The app should feel like
hardware: deep atmospheric blue-black surfaces with layered elevation
(not flat borders-everywhere), a luminous PlayStation-blue accent
(oklch hue 255), one motion language across the whole machine, and a
signature loading mark — the four PlayStation face symbols (△ ○ ✕ □)
pulsing in sequence.

Typography deliberately stays on the system stack: the app ships in 18
languages including Arabic, Thai, Hindi, Japanese and Korean, and a
custom Latin display font would fracture those scripts. Identity comes
from color, depth, and motion. Numerals are tabular app-wide so live
counters (MiB/s, ETAs, temperatures) don't jitter.

## Implemented (v3 pass 1)

### Design system (`client/src/index.css`)

- Refined three-theme palette (dark / light / OLED), hue moved 250→255,
  deeper dark surface, more vivid accent. All token NAMES unchanged —
  no screen needed edits.
- Elevation ramp `--shadow-1/2/3` + `--edge-highlight` (machined top
  edge); `.elev-1/2/3` utility classes pair with existing card markup.
- `--atmosphere`: faint accent glow bleeding from the top of the window
  (painted on `#root`); disabled on OLED (pixels-off black is the point).
- Motion system: `ps-fade-in / ps-pop-in / ps-rise-in / ps-drawer-in /
  ps-sheet-in / ps-shimmer / ps-soft-pulse` keyframes exposed as
  `.anim-*` classes; one easing curve (`cubic-bezier(.2,.8,.2,1)`);
  everything disabled under `prefers-reduced-motion`.
- Universal `:focus-visible` ring on every interactive element
  (previously only `<Button>` had one). Un-layered so Tailwind's
  `outline-none` can never remove it.
- Themed slim scrollbars; accent `::selection`; proper monospace stack.
- **Cascade-layer fix:** the `min-width: 0` width-safety net moved into
  `@layer base`. Un-layered it was silently defeating every `min-w-*`
  utility app-wide (un-layered author CSS outranks all `@layer` rules).

### Component layer (`client/src/components/`)

- `ProgressBar` — shared determinate/indeterminate bar (tones:
  accent/good/warn/bad) replacing per-screen hand-rolled fills.
- `Skeleton` / `SkeletonRows` — shimmer placeholders; used by Library
  (first scan) and InstalledApps (tile grid).
- `ShapesLoader` — the △○✕□ signature loader; used for "checking your
  PS5" moments. DualShock palette mapped to theme tokens.
- `ConnectionGate` — THE edge-case fix. One shared ladder for every
  console-backed screen: engine down → no console → helper down →
  probing → ready. Each state names the actual problem and has a CTA
  out. Applied to: Hardware, Shell, InstalledApps, FileSystem,
  DiskUsage, Search, Saves, Dashboard.
- `ErrorCard` / `WarningCard` / `SuccessCard` gained `onDismiss`.
- `EmptyState` compact variant gained icon + action support.
- Entrance animations wired into ConfirmDialog, CommandPalette,
  ShortcutsOverlay, OverflowMenu, NotificationInbox, LocalPathPicker,
  the mobile drawer, and route navigation (`.anim-screen` keyed by
  pathname in AppShell).

### Flow fixes

- Fresh installs land on **Connection** (LandingRedirect in App.tsx) —
  not the changelog. Returning users keep changelog + route-restore.
- Upload "done" card now closes the loop with **"Open Library"** CTA +
  hint about Register/Mount (the #1 post-upload confusion).
- Upload preflight error clears when the destination changes (was only
  clearing on source change — stale error accused the new destination).
- Connection first-run nudge stacks on narrow screens (min-w floor).

## Implemented (v3 pass 2)

- **Keep-PS5-awake, three policies** (Settings → Upload): Off / During
  transfers (default) / **Always while connected**. "Always" power-ticks
  every console whose helper answers, every 2 minutes, for as long as
  the app is open — the console can't auto-enter rest mode while you
  work, while manual rest from the controller still works (the tick
  resets only the IDLE timer). A `⚡ keeping awake` StatusBar indicator
  makes the active policy visible. Hardware-verified on both lab
  consoles (FW 5.10 + 9.60): 20/20 sustained ticks + smoke, via the new
  `ps5upload-lab power tick` subcommand.
- **Register-after-upload** ("Add to PS5 home screen when done",
  default ON, game folders): both the one-shot Upload and the queue now
  register the game right after commit — with the Library flow's
  DRM-patch retry — collapsing upload → Library → Register → launch
  into one step. Registration failure is a warning, never an upload
  failure.
- **Errors reach the inbox**: 23 operation-failure sites across Library
  and FileSystem (delete/chmod/mount/move/download/rename/mkdir/bulk)
  now push persistent notifications in addition to their inline error —
  navigating away no longer destroys the evidence.
- **Library render cap**: sections render 100 rows + "Show all N"
  (collapse resets on console/filter change) — a 200+ entry library no
  longer mounts hundreds of metadata-fetching rows at once.
- **De-jargon (en)**: "Register/Unregister" → "Add to / Remove from
  home screen" in the Library; tooltips rewritten in plain words.
  Non-English locales keep prior terminology until a translation pass.
- **IA**: Dashboard moved from System to Setup (it's the "am I
  connected, what's running?" morning check, not a hardware tool).

## Roadmap (needs product decisions — NOT implemented)

1. **Sidebar IA consolidation.** 26 items / 6 sections is too many.
   Proposal: a task-first nav — Overview (Dashboard+Connection merged
   header state), Add Games (Upload + Install Package + queue), My PS5
   (Library + Installed Apps merged with a source filter), Files
   (FileSystem + Search + Volumes + Disk usage as tabs/views), Tools
   (Payloads, Shell, nanoDNS, Hardware), Activity (Activity + Stats +
   Logs + Audit unified with filters). Heavy i18n + muscle-memory
   impact; needs a migration plan.
2. **De-jargoning.** "Register" → "Add to home screen"; one consistent
   word for the helper (never "payload" for ps5upload itself);
   explain mount in plain words at point of use. Copy-only change but
   touches every locale.
3. **Register-after-upload automation.** Offer a "register when done"
   toggle on game-folder uploads, collapsing the upload→library→
   register→launch journey into one step.
4. **Unify Connection + FirstRun.** Two parallel flows implement the
   same portCheck/send; should be one progressive flow with per-step
   retry.
5. **Library virtualization.** 200+ entries render unbounded rows
   (Upload caps at 200 with a note; Library has no cap). Adopt a
   virtual list before the skeleton work fully pays off.
6. **Error → inbox routing.** Library/FileSystem row-operation failures
   still vanish on navigation (component-local state); they should
   also push to the NotificationInbox like upload/install failures do.
7. **Engine-down recovery.** ConnectionGate explains it; a "restart
   engine" action (Tauri respawn command) would fix it in place.

## Verification

All gates green at time of writing: tsc, eslint, 611 vitest tests,
vite production build, i18n coverage (18 languages). Visual pass via
Playwright on dark/light/OLED at 1440px and 400px widths.
