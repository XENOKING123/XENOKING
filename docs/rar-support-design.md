# Design: .rar support (multi-part + password)

Status: proposal (not yet implemented). Requested alongside the existing
`.zip` / `.7z` host-side streaming, referencing `bizkut/unrar-ps5`.

## Goal

Let a user pick a `.rar` (incl. multi-volume sets and password-protected
archives) in the Upload flow and have its contents land **already-extracted**
on the PS5 — exactly like `.zip` / `.7z` do today (`transfer_zip` /
`transfer_7z` in `engine/crates/ps5upload-core/src/transfer.rs`: plan from
metadata → BEGIN_TX manifest → stream each entry as FTX2 shards → COMMIT_TX).

## Two hard constraints up front

RAR is not like zip/7z. Before any design, two things must be acknowledged
because they shape every option:

### 1. There is no production-grade pure-Rust RAR decoder

`zip` and `sevenz-rust2` are pure Rust, which is *why* they cross-compile
cleanly to `aarch64-linux-android` with no C toolchain — a constraint the
Cargo.toml comments call out explicitly. For RAR:

- The real-world decoder is the **official UnRAR C++ source** (what
  `unrar-ps5` compiles, what the `unrar` Rust crate binds to). It's the only
  thing that fully handles **RAR5**, **multi-volume sets**, and **AES
  passwords**.
- Pure-Rust RAR crates exist but are incomplete (partial RAR4, no/*weak* RAR5,
  no AES password) — not viable for "any .rar a user has."

⇒ Real RAR support means a **C dependency** (UnRAR), which **breaks the
Android pure-Rust cross-compile**. Android would have to keep zip/7z only.

### 2. UnRAR's license is incompatible with ps5upload's GPL-3.0

UnRAR's license (`unrar-ps5/src/license.txt`) permits using the source to
**extract** RAR "without limitations free of charge," **but** forbids using it
to build a RAR-compatible *archiver* and requires its text be reproduced. That
"field-of-use" restriction is an **additional restriction GPL §7 forbids**, so
UnRAR-derived code **cannot be distributed as part of a GPL-3.0 work under GPL
terms** (this is exactly why Debian/Fedora keep `unrar` in non-free). ps5upload
is GPL-3.0.

This is not a blocker we can hand-wave — it must be chosen deliberately.
Options in the License section below.

---

## Architecture options

### Option A — Host-side via `unrar` crate, desktop-only (recommended)

Mirror zip/7z exactly, but gate behind a Cargo feature that is **excluded from
the Android build**:

- New `transfer_rar()` in `transfer.rs` behind `#[cfg(feature = "rar")]`.
- `unrar = { version = "...", optional = true }`; `rar = ["dep:unrar"]`. The
  desktop builds enable `rar`; the Android build does **not** (so Android stays
  pure-Rust and keeps zip/7z). The Cargo.toml gets a comment block like the
  sevenz one explaining the C-dep / Android exclusion.
- Engine routes (`/api/transfer/rar`, `/api/rar/inspect`), Tauri command
  (`transfer_rar`), `api/ps5.ts` (`startTransferRar`), Upload-screen wiring —
  all mirror the 7z plumbing one-to-one. On Android the RAR option is simply
  hidden (feature-detected via an engine capability flag).

**Why recommended:** best UX (stream extracted files, no double storage),
identical mental model to zip/7z, contained blast radius (one feature flag).
Cost: desktop-only; the license decision (below).

**RAR specifics map cleanly onto the existing plan/stream split:**

- *Inspect/plan*: UnRAR can enumerate entries + uncompressed sizes from the
  archive headers without extracting — same as `inspect_7z` /
  `sevenz_plan_preview`. Build the manifest from that.
- *Stream*: UnRAR extraction is **forward-only** within a volume set (like 7z's
  LZMA2), so use the **7z streaming model, not the zip seek model** — iterate
  entries in archive order, emit each as shards, resume = re-open and skip
  already-acked shards.

### Option B — Console-side, port `unrar-ps5`

Upload the `.rar` as-is, then a PS5-side module (UnRAR compiled into the
payload, as `unrar-ps5` does) extracts it on the console into the destination.

- Pros: no host C dep, so **no Android cross-compile problem** (the unrar code
  lives in the already-C, PS5-only payload); handles multi-part/password/RAR5
  via full UnRAR.
- Cons: **2× PS5 storage** (the full `.rar` must land before extraction, then
  the extracted files) — bad for a 100 GB game on a console with limited free
  space; slower (PS5 CPU vs host); much larger payload binary; extraction
  progress/cancel is harder to surface than host-side streaming. Same UnRAR
  license question applies to the payload binary.

Use only if Android RAR support is a hard requirement *and* double-storage is
acceptable.

### Option C — Don't bundle; pre-convert (status quo + docs)

Tell users to extract `.rar` → `.zip`/`.7z` on their PC first. Zero new deps,
zero license question. Worst UX; listed for completeness.

### Recommendation

**Option A** for desktop, **Android stays zip/7z** (RAR hidden), with the
license handled per the next section. Revisit Option B only if Android RAR
becomes a real ask.

---

## License: how to ship Option A compliantly

ps5upload is GPL-3.0 and `phantomptr` is the **sole author** — which gives a
clean path the typical project doesn't have:

1. **Add a GPL exception for UnRAR (recommended).** As sole copyright holder,
   phantomptr can add an explicit exception to ps5upload's license: "As a
   special exception, you may link/combine this program with the UnRAR source
   code and distribute the result; the UnRAR portions remain under their own
   license." This is a standard, well-understood mechanism (OpenSSL-exception
   style) and resolves the GPL §7 conflict for this project's own code. Caveat:
   it only works if *every* copyright holder in ps5upload agrees — verify no
   third-party GPL code (vendored or dep) is statically combined in a way that
   would also need the exception. (The offact/profile code we vendored is
   GPL-3.0 from ps5-payload-dev — those authors would also need to consent, or
   keep RAR out of any build that links their code.)
2. **Or: don't distribute UnRAR in the official binaries.** Ship RAR as an
   opt-in feature the user enables at build time (or via a separately-downloaded
   component the app loads). The official GPL release contains no UnRAR; users
   who want RAR add it themselves. Compliant, worse UX.
3. **Or: libarchive's independent RAR reader** (BSD-licensed, *not* UnRAR
   source) — sidesteps the UnRAR license, but it's still a C dep (Android) and
   its RAR5 + AES-password support is incomplete. Not recommended for "any
   .rar."

Always reproduce UnRAR's license text in the distribution regardless of path.

**Decision needed from the maintainer before implementing:** which license
path. #1 is cleanest if the third-party-GPL question checks out.

---

## Multi-part archives

UnRAR opens a **volume set** natively: given the first volume, it pulls in the
siblings automatically when they're in the same directory. The plumbing:

- **Selection**: the user picks the first volume — modern `name.part1.rar` /
  `name.part01.rar`, or legacy `name.rar` + `name.r00` + `name.r01`. The engine
  detects the scheme and verifies the sibling set is complete *before* starting
  (so we fail fast on a missing `.part3` instead of mid-stream).
- **Inspect** reports total uncompressed size across all volumes (so the
  progress bar + free-space pre-check are correct).
- This mirrors how the user already points at a single `archive.7z`; for RAR
  they point at the first volume and we resolve the rest.

## Passwords

- **UI**: when inspect reports the archive is encrypted (UnRAR flags this from
  the header without the password for RAR5; RAR4 headers may need a probe), the
  Upload screen prompts for a password before transfer. Wrong password →
  surface "incorrect password," let them retry; never start the multi-hour
  transfer on a bad password.
- **Handling**: the password flows engine→core only for the decode call; it is
  **never written to logs, the job record, or persisted state** (treat like a
  secret — same care as any credential). Passed as a transient field on the
  transfer request, dropped after the job ends.
- Header-encrypted archives (where even the file list is encrypted) need the
  password for *inspect* too — handle by prompting, then inspecting.

---

## Full-stack work breakdown (Option A)

Mirrors the 7z feature 1:1; each layer already has the template:

1. **core** `transfer.rs`: `inspect_rar`, `rar_plan_preview`,
   `transfer_rar_with_opts` / `_resumable` (7z forward-only streaming model).
   `Cargo.toml`: `unrar` optional + `rar` feature + the Android-exclusion
   comment. Unit/integration tests with a fixture multi-part + password `.rar`.
2. **engine**: `/api/transfer/rar`, `/api/rar/inspect`(+stream) handlers; a
   capability flag in `/api/version` so the client can hide RAR when the engine
   was built without the feature (e.g. Android).
3. **client**: `transfer_rar` Tauri command; `api/ps5.ts` `rarInspect` +
   `startTransferRar` (+ password param); Upload screen — recognize `.rar` /
   `.part1.rar` / `.r00`, password prompt, route to `startTransferRar`; the
   archive-format helper learns `"rar"`.
4. **verify**: desktop build with `rar` feature (tests + clippy); confirm the
   **Android build without `rar` still cross-compiles pure-Rust** and hides the
   option; HW test a real multi-part + password `.rar` on a lab console.

## Open decisions for the maintainer

1. **License path — RESOLVED: GPLv3 §7 linking exception.** Audit confirmed the
   engine has NO third-party GPL code (the only GPL-3.0 crates are ps5upload's
   own; the offact/profile GPL code lives in the *separate* payload binary, not
   linked with UnRAR — mere aggregation). So the project can grant a GPLv3 §7
   exception for UnRAR directly. Done: `LICENSES/UnRAR-exception.md` (the
   exception + the required UnRAR paragraph-2 notice), `LICENSES/UnRAR-license.txt`
   (verbatim), the notice in `transfer.rs`'s `rar_support` header, and README.
   UnRAR is used to *extract only*, never to compress.
2. **Android**: accept RAR as desktop-only (recommended), or pursue Option B
   for Android parity.
3. The vendored GPL-3.0 profile/offact code's authors vs a UnRAR exception —
   confirm there's no conflict, or keep RAR out of builds that link that code.
