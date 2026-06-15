<div align="center">

# XENO TOOL — ALL-IN-ONE

**The all-in-one PS5 companion, by XENOKING.**

Package install · file transfer · saves · **cheats & trainers (live apply)** ·
payloads + favorites · the XENO Game Store · Title Search · nanoDNS.

</div>

---

## Download

Grab the latest **`XENO TOOL_x.x.x_x64-setup.exe`** from the
[**Releases**](../../releases) page and run it.

- Windows 10/11, 64-bit. No extra runtime needed.
- If SmartScreen appears: **More info → Run anyway**.
- First launch unpacks the full trainer library (~9,200 trainers) — give it a
  few seconds. It opens on the **Home** showcase every time.

## What it does

| Area | What you get |
|------|--------------|
| **Trainers** | The full library (~9,200) ships with the app, one card per game, all versions merged. **Attach** to a running game, toggle cheats live (red/green), **Detach** to revert + disconnect. Auto-updates every 24h. |
| **My Games** | Lists what's running on the console; Cheats auto-finds the right trainers. |
| **Game Store** | Browse the whole PS4/PS5 catalog (every page), then **Get links** for the real download mirrors. |
| **Title Search** | Search the library; missing names resolve online (PS5 covers via prosperopatches) + the bundled title catalog. |
| **Payloads** | Catalog (curated homebrew), Send-file, and **Favorites** — your own folder, star + inject-all. |
| **nanoDNS** | Live **ON/OFF** with a real port-53 probe so you know it's running and blocking PSN. |
| **Files / Saves / Install** | FTP-free transfers, save backup/restore, `.pkg` install, file system, hardware, volumes. |

## Build from source

```bash
# 1) frontend deps
cd client && npm install

# 2) build the engine sidecar first (it gets embedded)
cd ../engine && cargo build --release

# 3) build the desktop app + installer
cd ../client && npm run tauri build
```

The installer lands in
`client/src-tauri/target/release/bundle/nsis/`.

Requirements: Node 20+, Rust (stable, MSVC on Windows). The bundled trainer +
title seeds live in `client/src-tauri/resources/*.zip`.

## License

Released under the **GNU GPL-3.0** — see [`LICENSE`](LICENSE) and the
[`LICENSES/`](LICENSES) folder for full terms and third-party notices. The
in-app **About** screen lists full credits.

<div align="center">

*Made by XENOKING.*

</div>
