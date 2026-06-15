# Feasibility: kstuff auto-pause around game launch (klog launch-watcher)

**Status:** research note, no code. Borrowed concept from the Elf Arsenal /
etaHEN style "klog_reader" that auto-pauses kstuff ~25 s after a game starts
and resumes ~10 s after it exits, because some games crash with kstuff's
kernel patches active.

## TL;DR

- **Detection is essentially already built.** The payload exposes both a
  kernel-log reader and a process list. Either can spot a game launching /
  exiting with no new kernel primitives.
- **The toggle is the only hard part, and it is the risky one.** ps5upload
  deliberately keeps *zero* per-firmware kernel offsets in-tree (it delegates
  that to EchoStretch kstuff, which resolves them at runtime via the SDK NID
  table). Re-implementing the sysentvec pause/resume sentinel here would
  re-import exactly the FW-offset maintenance burden the project avoids.
- **Value for a *transfer* tool is narrower than for an all-in-one panel.**
  Users launch games from the PS5 UI, not through ps5upload, so we don't own
  the gameplay session the way Elf Arsenal does. The win is limited to "a game
  you uploaded won't boot with kstuff active" — real, but a minority case.

## What we already have

| Capability | Where | Note |
|---|---|---|
| Kernel-log read | `FTX2_FRAME_KLOG_READ` 108 / ACK 109, `runtime.c:227-292` ("dmesg equivalent") | One-shot recent-log fetch; not a continuous stream today. |
| Process list | `proc_list_get_json` (`payload/include/proc_list.h:25`, `proc_list.c`); engine `hw::proc_list` (`hw.rs:465`) | FreeBSD-stable offsets 9.x–12.x, no per-FW table. |
| Kernel R/W | via `<ps5/kernel.h>` once kstuff elevated us (`main.c:83`) | We *read* ucred/authid; we never *toggle* kstuff. |

So **launch/exit detection** can be done two ways:

1. **Process polling (preferred):** poll `proc_list` for the foreground game
   process (e.g. `SceShellCore`-launched eboot / known game proc) appearing
   and disappearing. No kernel-log parsing, no new payload frame, works on
   every FW the proc list already works on. Cheapest and safest.
2. **Klog tailing:** parse `KLOG_READ` for Sony's launch/exit log lines (what
   Elf Arsenal does). More fragile (log strings drift across FW) and would
   need KLOG_READ upgraded from one-shot to a tail/stream. Not recommended.

## The blocker: toggling kstuff without owning FW offsets

Elf Arsenal flips a 16-bit sentinel (`0xdeb7` enabled / `0xffff` disabled) at
`sysentvec+14` in both the PS5-native and PS4-compat ABI tables, using a
hardcoded per-build offset table (FW 3.00–12.70). ps5upload has **no such
table by design** and should not grow one.

Options, best to worst:

1. **Ask kstuff to expose a toggle (preferred).** Check whether the
   EchoStretch kstuff build ps5upload already ships in its First-Run catalogue
   exposes a runtime pause/resume we can drive without knowing offsets — e.g.
   a control file under `/data`, a loopback socket, or a documented syscall.
   If it does, the watcher becomes pure userland glue (detect → poke kstuff's
   own toggle). **Action: read the EchoStretch kstuff source/release notes for
   a pause API before writing any payload code.**
2. **Drive the sentinel via a kstuff-provided symbol/NID** (same runtime
   resolution kstuff uses for everything else) rather than a literal offset.
   Viable only if kstuff exports the sysentvec address or a setter.
3. **Hardcode the sysentvec offset table ourselves.** Functionally possible
   (we have kernel R/W) but rejected: it re-creates the maintenance liability
   the architecture exists to avoid, and a wrong offset is a hard kernel fault
   (same failure class as the `hw_info.c` precise-FW read that crashed the
   Slim). Only as a last resort, gated + per-SKU validated.

## Recommended next step (if pursued)

1. Confirm the value with the user base: how often does an *uploaded* game
   fail to launch specifically because kstuff is active? If rare, deprioritize.
2. Investigate EchoStretch kstuff for a no-offset pause/resume hook (option 1).
   This determines whether the feature is "cheap userland glue" or "a kernel
   offset table we don't want."
3. If a hook exists: prototype detection via **process polling** (reuse
   `proc_list`), wire detect→toggle, default OFF, opt-in, with the same
   "needs HW validation per SKU/FW" discipline as the other kernel-touching
   paths.

## Risk summary

- Detection: **low risk** (reuses existing, FW-stable primitives).
- Toggle via kstuff hook: **low risk** if such a hook exists.
- Toggle via our own offset table: **high risk** (hard kernel fault on wrong
  offset) and **architecturally discouraged** — do not do this without a
  proven per-SKU/FW offset and an explicit opt-in gate.
