# Testing And Quality Strategy

This repo has three validation layers:

1. Hardware-free checks that must pass for every change.
2. Cross-platform compile checks that catch Windows/Linux/macOS drift.
3. Live PS5 validation for payload, protocol, throughput, and storage behavior.

## Local Gates

Use these from the repo root.

```sh
npm run validate
# same gate through Make:
make quality
```

Runs the normal non-hardware gate:

- Version drift check against `VERSION`.
- Script syntax checks for Node, Bash, Python, and PowerShell when `pwsh` is installed.
- Script inventory audit.
- `git diff --check`.
- Engine Rust `fmt`, `clippy`, and full workspace tests.
- Desktop/Tauri Rust `check`, `clippy`, and tests.
- Client TypeScript typecheck, ESLint, Vitest, and Vite build.

```sh
npm run validate:full
# same gate through Make:
make quality-full
```

Adds payload validation through `make test-payload`. This requires `PS5_PAYLOAD_SDK`.

```sh
npm run validate:hardware
# same gate through Make:
make quality-hardware
```

Runs the non-hardware gate and then `make validate`, which reloads the payload to the PS5, runs smoke tests, and runs the default sweep.

## Coverage

```sh
npm run coverage
# or:
make coverage
```

Outputs:

- `client/coverage/index.html` for frontend Vitest coverage.
- `coverage/engine/html/index.html` for Rust engine/core coverage.
- `coverage/engine/lcov.info` for CI/reporting tools.

Split coverage targets are available when you only need one side:

```sh
make coverage-client
make coverage-engine
```

Rust coverage uses `cargo-llvm-cov`. If missing:

```sh
npm run coverage -- --install-tools
```

or install manually:

```sh
cargo install cargo-llvm-cov --locked
```

## Mock And Unit Coverage

Rust mock/integration coverage lives in `engine/crates/ps5upload-tests/tests/`:

- `transfer_integration.rs` spins up a loopback FTX2 mock server and covers single-file, streaming file, directory, packed small-file shards, resume-after-drop, retry classification, digest mismatch, and exclude behavior.
- `hw_integration.rs` covers hardware-command protocol handling against mocks.
- `volumes_integration.rs` covers PS5 volume parsing and mock volume responses.

Rust unit coverage lives directly beside modules in `ps5upload-core` and `ftx2-proto`:

- Frame encoding/decoding.
- Filesystem operation parsing and inventory/reconcile behavior.
- Exclude rules.
- Game metadata parsing.
- Hardware telemetry parsing.
- Payload-loader behavior.
- Volume parsing.

Frontend mock/unit tests live under `client/src/**/*.test.ts`:

- Destination path resolution, including Windows separators.
- Error-message humanization.
- Firmware parsing.
- Polling/retry timing.

## Cross-Platform Support

CI checks the engine/core crate for all shipped OS/arch targets:

- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`
- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `x86_64-pc-windows-msvc`
- `aarch64-pc-windows-msvc`

Release CI builds the actual desktop bundles for the same target matrix. Local macOS machines usually cannot compile Windows/Linux targets unless those Rust stdlibs and cross-linkers are installed, so CI is the source of truth for full target coverage.

CI also runs desktop/Tauri Rust `cargo check`, `clippy`, and tests on native GitHub runners for:

- Linux (`ubuntu-24.04`)
- macOS (`macos-14`)
- Windows (`windows-2022`)

That native matrix exercises `#[cfg(target_os = "...")]` desktop code paths such as keep-awake, update/download path handling, launcher behavior, and sidecar extraction logic.

## Live PS5 Validation

Use live validation when touching any of these areas:

- Payload C runtime.
- FTX2 transfer framing.
- Transfer/reconcile/resume behavior.
- Storage, mount, cleanup, file browser, or volume commands.
- Performance-sensitive transfer code.

Commands:

```sh
make validate
```

Runs payload build/send, waits for runtime port `9113`, runs smoke, then runs the default sweep and writes `bench/reports/<timestamp>-sweep.{json,md}`.

```sh
make validate-xl
```

Adds the 200k-file stress profile.

```sh
node tests/smoke-hardware.mjs --no-spawn-engine
```

Use this when the engine is already running.

```sh
node bench/run-ftx2-upload.mjs \
  --source=/path/to/file-or-dir \
  --dest-root=/data/ps5upload/tests/manual \
  --spawn-engine \
  --no-write-result
```

Use this for targeted real-file validation. Clean test uploads with:

```sh
curl -X POST http://127.0.0.1:19113/api/ps5/cleanup \
  -H 'content-type: application/json' \
  -d '{"addr":"192.168.137.2:9114","path":"/data/ps5upload/tests/manual"}'
```

## Script Hygiene

```sh
npm run scripts:check
npm run scripts:audit
```

`scripts:check` is a syntax gate. `scripts:audit` lists tracked utility scripts and marks intentionally manual entry points. Do not remove a script just because it is not referenced by another script; lab/debug utilities can be intentionally manual. Remove only generated artifacts or scripts whose replacement path is documented.

## i18n Coverage

```sh
npm run i18n:check          # gate — fails on any non-allowlisted miss
npm run i18n:report         # same gate but always prints per-language summary
npm run i18n:bootstrap      # rewrites allowlist to current state — use sparingly
```

The 18-language `client/src/i18n.ts` table is parity-checked against English on every `npm run validate`. Per-language allowlists live at `scripts/i18n-known-missing.json`; entries record both keys English has but the language doesn't (`missing`) and keys the language has but English doesn't (`stale`). When you add a new English key, the gate fails with the missing key listed — translate it and add it to the language's table, OR add it to the allowlist if the translation is genuinely deferred. Never run `i18n:bootstrap` casually — it papers over every current gap and silences whatever you were about to forget to translate.

## Recommended Change Workflow

1. Run focused tests while editing.
2. Run `npm run validate` before committing.
3. Run `npm run coverage` for changes that affect logic or tests.
4. Run `make validate` for transfer/payload/storage changes when PS5 hardware is available.
5. Let CI validate all shipped OS/arch targets and release packaging.

## Fresh-Install Verification Matrix (Release Day)

CI proves the binaries build. It does NOT prove they launch on a vanilla
system that hasn't been used as a dev box. Every release artifact has at
least one historical "ships green, fails on fresh install" failure mode:

| Platform / arch       | Failure mode caught in the past                                              | Fix in tree (don't regress)                                                              |
| --------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Windows x64 / arm64   | `VCRUNTIME140.dll not found` (no C++ Redist on fresh Win11, especially arm64) | `.cargo/config.toml` sets `+crt-static` for both MSVC targets — embeds the MSVC CRT      |
| Windows x64 / arm64   | Windows Explorer "Extract All" → "compressed (zipped) folder is invalid"     | `publish.yml` packs the .zip via `pwsh Compress-Archive` (bit-3 free), not `tar -a`      |
| Linux x64 / arm64     | AppImage hangs / "AppImage requires FUSE" on fresh Ubuntu 24.04+              | `publish.yml` ships `PS5Upload.sh` wrapper that sets `APPIMAGE_EXTRACT_AND_RUN=1`         |
| Linux (any)           | glibc-too-new on older distros                                               | Build base is `ubuntu-24.04` (glibc 2.39) — users below 24.04 LTS are unsupported        |
| macOS x64 / arm64     | Gatekeeper / "unidentified developer" on first run                           | Documented in README — right-click → Open. No code-signing planned.                      |

Before tagging a release, run this hands-on test pass (the only fully
reliable proof; a green CI run is necessary but not sufficient):

1. **Windows x64** — fresh Win11 VM. Unzip with built-in **Extract All**.
   Run `PS5Upload.exe`. App window must open.
2. **Windows arm64** — same, on an arm64 VM (Surface Pro 9/X, Parallels
   arm64, etc.).
3. **Linux x64** — fresh Ubuntu 24.04 LTS desktop VM with no extra
   packages. Double-click `PS5Upload.sh`. App window must open.
4. **Linux arm64** — same, on a Raspberry Pi 5 / arm64 cloud VM.
5. **macOS arm64** — fresh macOS Sonoma+ user account. Mount the .dmg,
   drag to Applications, right-click → Open. App window must open.
6. **macOS x64** — same, on an Intel Mac (real or virtualised).

If any of those fails: the release is broken and needs a follow-up patch
— see `v2.5.1` (Windows zip bit-3) and `v2.5.2` (VCRUNTIME140 /
Linux libfuse2) for the playbook of "noticed-after-release, patched
same day."
