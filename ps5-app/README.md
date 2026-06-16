# XENO Game Store — native PS5 app

A tiny on-console build of the XENO Game Store: a self-contained HTTP server
payload that serves the games catalog + UI straight from the PS5, plus a
home-screen homebrew package branded with the XENO logo.

Everything here is cross-compiled in the cloud by GitHub Actions
(`.github/workflows/ps5-app.yml`) against the
[ps5-payload-dev SDK](https://github.com/ps5-payload-dev/sdk) — **no local PS5
toolchain is needed.** Push, and the Release is built for you.

## What you get (GitHub Release `ps5-app-v1.0.0`)

| Artifact | What it is | How to use |
|---|---|---|
| **`xeno-store.elf`** | The payload (server only). **Supported, guaranteed path.** | XENO TOOL → **Payloads → Send file** (port 9021), or any ELF loader. Then open `http://<ps5-ip>:9095` in the PS5 browser. |
| **`xeno-store-browser.elf`** | Same server, but also auto-opens the PS5 browser to the store. | Send it the same way for a one-tap launch. |
| **`XENO-Game-Store-homebrew.zip`** | Home-screen homebrew app folder (`eboot.bin` + `sce_sys/icon0.png` = the XENO logo + metadata). | For etaHEN / itemzflow homebrew loaders — drop into `/data/homebrew/`. Shows the XENO icon and runs the store. |
| **`XENO-Game-Store-bubble-EXPERIMENTAL.zip`** | A fake-signed Sony app bubble. | **Experimental, unverified on hardware.** Try it if your setup installs bubbles; fall back to the ELF if it doesn't appear. |

The ELF is the proven path (it's the same `browser`/`websrv` payload pattern the
scene already runs). The homebrew package just wraps that ELF with the logo so it
shows up as an app; the bubble is an extra, clearly-labelled experiment.

## Layout

```
ps5-app/
  main.c              HTTP server (+ optional -DLAUNCH_BROWSER one-tap build)
  Makefile            builds both ELFs, the homebrew pkg, and the experimental bubble
  homebrew/           the UI embedded into the ELF at build time
    index.html        the store front-end
    catalog.json      the embedded games catalog
    logo.jpg          header badge (served at /logo.jpg)
  sce_sys/
    icon0.png         512×512 XENO logo (home-screen icon)
    param.json        PS5 app metadata
  tools/
    gen_assets.py     embeds homebrew/* into assets.h
    make_param_sfo.py generates sce_sys/param.sfo (for the bubble)
  make_fself.py       SDK fake-signer (ELF → eboot.bin, for the bubble)
  eboot.x             procparam linker script (for the bubble)
```

## Build it yourself (optional)

```bash
export PS5_PAYLOAD_SDK=/opt/ps5-payload-sdk     # install the ps5-payload-dev SDK first
cd ps5-app
make all        # -> xeno-store.elf, xeno-store-browser.elf, dist/XENO-Game-Store/
make bubble     # -> dist/bubble/XENO00001/ (experimental fake-signed)
```

---
XENO TOOL — ALL-IN-ONE · by **XENOKING** · Discord **XENOKING123.**
