# XENO STORE — home-screen app & install routes

XENO STORE runs as a **payload** (an ELF loaded by the console's jailbreak), so
its downloads keep running after you close the browser. A payload leaves nothing
on the PS5 home screen, so this directory ships the pieces that put XENO STORE
on the **Games** row and open it with one press.

There are three ways to install it, plus a deep-link icon the running server
adds by itself. Pick whichever your setup supports.

| Route | Artifact | Built by | Needs |
|-------|----------|----------|-------|
| 1. Homebrew folder | `dist/XENO-STORE.zip` → `/data/homebrew/XENO-STORE/` | `make pkg` | a homebrew launcher (etaHEN / itemzflow) |
| 2. Installable package | `dist/XENO-STORE.pkg` | `make ffpkg` | a debug-package installer (fake-pkg capable console) |
| 3. Launcher ELF | `app/dist/xeno-store-launcher.elf` | `make launcher` | the jailbreak's ELF loader on `:9021` |
| + Deep-link icon | `/user/app/XENO00002` (auto) | the running payload | app-install service (usually already present) |

All four end at the same place: the XENO STORE web UI on
`http://127.0.0.1:9095/` (full-screen, `?tv=1`).

---

## 1. Homebrew folder (`make pkg`)

`tools/make_homebrew.py` builds `dist/XENO-STORE/` and `dist/XENO-STORE.zip`:

```
XENO-STORE/
  eboot.bin            the browser ELF (serves the store and opens the browser)
  homebrew.json        etaHEN / itemzflow launcher metadata (title XENO STORE, id XENO00002)
  sce_sys/icon0.png    512x512 XENO logo
  sce_sys/param.json   app metadata
```

Copy the folder to `/data/homebrew/XENO-STORE/` (or unzip it there) and launch
it from your homebrew enabler. The zip stores every entry mode `0777` so it
extracts runnable whichever tool unpacks it.

**Needs:** a homebrew launcher that runs an ELF `eboot.bin` from
`/data/homebrew` (etaHEN's Homebrew list, itemzflow, …). No ShadowMountPlus or
kstuff.

## 2. Installable package (`make ffpkg`)

`tools/make_ffpkg.py` stages a PS5 application folder and hands it to
ps5upload's `fpkg_build`, which writes and self-verifies `dist/XENO-STORE.pkg`:

```
build/apppkg/src/PPSA99500/
  eboot.bin            the browser ELF
  sce_sys/param.json   titleId PPSA99500, contentId IV0000-PPSA99500_00-XENOSTORE0000000
  sce_sys/icon0.png    512x512 XENO logo
```

Install the `.pkg` the way you install any debug/fake package (a remote package
installer, etaHEN's installer, a USB `.pkg` in the package list). It lands on
the home screen as **XENO STORE** and runs the server when launched.

**Needs:** a console that installs **fake / debug packages** (jailbroken with
fpkg support). `fpkg_build` must be on `PATH`, in `$XENO_FPKG_BUILD`, or passed
with `--fpkg`; build it once with
`cargo build --release -p ps5upload-fpkg --example fpkg_build` in the ps5upload
engine checkout. `make ffpkg` skips cleanly when the builder is absent.

## 3. Launcher ELF (`make launcher`)

`app/launcher_main.c` → `app/dist/xeno-store-launcher.elf`, built with
`prospero-clang` against only `SceSystemService` + `SceUserService`. Send it to
your payload loader like any other ELF. On run it:

1. probes `127.0.0.1:9095` — if the store already answers, skips to step 4;
2. otherwise streams the newest saved server ELF
   (`/data/xeno-store/xeno-store.elf`, or the homebrew copy) to the jailbreak's
   ELF loader on `127.0.0.1:9021` in 64 KiB chunks, then `shutdown(SHUT_WR)` and
   drains so nothing is cut short;
3. polls `GET /api/status` every 500 ms for up to 30 s until the store is live;
4. opens the PS5 browser full-screen on the store.

**Needs:** the jailbreak's **ELF loader listening on `:9021`** (the port payload
senders use). If no saved server ELF exists yet, open XENO STORE once from your
payload manager — the server then keeps a copy current for next time.

## Deep-link home-screen icon (automatic)

When the payload starts, `src/launcher_icon.c` writes a tiny shortcut app to
`/user/app/XENO00002` — a `param.json` whose `deeplinkUri` is
`http://127.0.0.1:9095/`, plus the 512x512 icon — then asks the shell to
register the title via libSceAppInstUtil's per-title installer (resolved at
runtime by NID, with a whole-directory rescan as a fallback). Pressing the icon
afterwards opens the store in the browser.

This is metadata only: the shortcut has **no `eboot.bin`** and never touches the
system volume, exactly like Payload Manager's own icon. It needs **no kstuff and
no ShadowMountPlus** — only the app-install service, which is normally already
loaded. Every Sony call is resolved at runtime and guarded: if the service is
missing, the files are still staged and the shell picks the icon up on its next
`/user/app` scan, and the server keeps running regardless. The outcome is
recorded in `/data/xeno-store/launcher.json`.

> The deep-link icon opens the store but does not *start* the payload. Use route
> 1, 2 or 3 to start XENO STORE; the icon is the one-press shortcut back to it.

---

## Building

```sh
export PS5_PAYLOAD_SDK=/path/to/ps5-payload-sdk
make ps5          # xeno-store.elf + xeno-store-browser.elf
make pkg          # dist/XENO-STORE/ + dist/XENO-STORE.zip   (route 1)
make ffpkg        # dist/XENO-STORE.pkg                      (route 2)
make launcher     # app/dist/xeno-store-launcher.elf         (route 3)
```

Title IDs: `XENO00002` for the homebrew app and the deep-link shortcut,
`PPSA99500` for the installable package.
