# Save Converter — PS5 ⇄ PC

A small, **fully local** tool that converts game saves between PlayStation 5
and PC. It runs entirely in your browser from a single HTML file — nothing is
uploaded, nothing is installed, and it works offline.

First game: **Monster Hunter Wilds**. The design is a database, so more games
are added over time.

## Use it

Open **`dist/xeno-save-converter.html`** in any modern browser (Chrome, Edge or
Firefox). Double-click the file — that's it.

1. Pick the game and the direction (PS5 → PC or PC → PS5).
2. Drop your save file(s). The files it uses:
   - `data001Slot.bin` — your hunters (required)
   - `data00-1.bin` — system settings (optional)
   - `SS1_data001Slot.bin` — in-game photo file; drop it too (PC → PS5) and your
     Steam ID is read from it automatically.
3. Give the Steam account:
   - **PS5 → PC**: the SteamID64 of the account that will *play* the save.
   - **PC → PS5**: the SteamID64 of the account that *made* the save — filled in
     from the photo file, typed, or found automatically from the save.
4. Convert, and download the result.

**PS5 → PC** produces a Steam save, encrypted for the account you chose: drop it
into `…\userdata\<id>\2246340\remote\win64_save`.

**PC → PS5** produces **decrypted** PS5 save files. Import them with an
on-console save manager (e.g. Garlic SaveMgr / Apollo), which re-signs and
re-encrypts them for your console.

> The online hunter identity is reset during conversion so the game issues a
> fresh one (the save is moving to a different account). Keep a backup of any
> save you replace, and test before relying on it.

## How it works

The conversion engine is Rust, compiled to WebAssembly and inlined into the
page. A Wilds save is a "DSSS" container holding an object stream:

- **PS5** saves are DEFLATE-compressed only.
- **PC** saves are additionally encrypted per Steam account ("Mandarin").
- The object stream is the same on both platforms apart from the byte alignment,
  which is computed from each value's position in the file — so the one real
  difference between the platforms is the container's header size.

Converting therefore means: open the container on one side, lay the object
stream out again for the other side's alignment, reset the online identity, and
close the container on the other side. For PC → PS5 the Steam account can be
recovered straight from the save (every block header decodes to a fixed value
only under the right account's key), which the "find it automatically" button
does across several Web Workers.

## Build

Needs Rust with the `wasm32-unknown-unknown` target.

```bash
rustup target add wasm32-unknown-unknown
./build.sh    # compiles the engine and writes dist/xeno-save-converter.html
```

The engine's logic is also unit-tested natively:

```bash
cd engine && cargo test
```

End-to-end tests against real game saves are gated behind `XENO_SAVE_VECTORS`
(the directory holding the sample files, which are not in the repository) and
skip when it is unset.

## Layout

```
index.html        the page (template; __WASM_B64__ is replaced at build time)
build.sh          compile the engine to wasm and inline it into dist/
engine/           the Rust conversion engine (compiles to wasm and native)
  src/container.rs   DSSS file: header, DEFLATE, checksum
  src/mandarin.rs    PC per-account encryption + account recovery
  src/stream/        the object stream and re-layout
  src/convert.rs     one file, platform to platform
  src/games.rs       the game database
  src/lib.rs         the WebAssembly ABI
dist/             the built, self-contained HTML
```

## Credits

Save-format research from the open-source projects
[ree-save-editor](https://github.com/kvasszn/ree-save-editor) (kvasszn, GPL-3.0)
and [MandarinJuice](https://github.com/mi5hmash/MandarinJuice) (mi5hmash, MIT).
The code here is original; the algorithms and constants are facts of the format.
