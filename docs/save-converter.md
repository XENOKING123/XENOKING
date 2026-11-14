# Save Converter (PS5 ⇄ PC)

Converts a game save between PS5 and PC, in both directions. The app tab is
**Save Converter** (`/save-converter`); the logic lives in the engine core so
it can be tested without a webview.

Goal: a database of 100+ games. Each game is one small JSON file; games that
share a save format share one codec.

## How it fits together

| Layer | Where | What it does |
|:--|:--|:--|
| Game database | `engine/crates/ps5upload-core/src/save_convert/games/*.json` | One profile per game: names, IDs, which file maps to which, which codec to use. Embedded into the app at build time. |
| Codecs | `engine/crates/ps5upload-core/src/save_convert/codec.rs` | The byte-level transforms (decrypt/encrypt, checksums, container rewrites). One per save *format*, not per game. |
| Orchestration | `.../save_convert/convert.rs` | Finds the save under the folder the user picked, matches files, runs the codec, writes a new folder. |
| Tauri commands | `client/src-tauri/src/commands/save_converter.rs` | Thin wrappers: `save_converter_games`, `_inspect`, `_convert`, `_reveal`. |
| Screen | `client/src/screens/SaveConverter/` | Pick game → direction → source folder → options → destination → convert. |

Guarantees the orchestration gives every game for free:

- The source folder is read-only to us. Nothing in it is ever changed, and
  the output folder may not be anywhere inside the folder being converted
  from.
- Output goes into a **new** folder (`<game-id>-pc-save`, `-2`, `-3`, …)
  inside the folder the user picks. Nothing existing is overwritten.
- All-or-nothing: if any file fails to convert — or the codec crashes — the
  new folder is removed, along with any parent folders created for it.
- The preview (`inspect`) and the conversion share one planning step, so
  what the user sees listed is exactly what gets converted.
- The user can pick the save folder itself or a folder above it; the save is
  located automatically. Two different saves under one folder is reported as
  ambiguous rather than guessed.

## What "PS5 save" means here

The **decrypted** contents of a save — the files the game sees when its save
is mounted. A backup from the **Save data** tab is the raw `sdimg_*` image,
sealed to the console that wrote it, and cannot be converted. Users export
the decrypted files on the console first (e.g. Garlic SaveMgr from the
Payloads tab), convert, then import the result the same way.

## Adding a game

1. Create `games/<id>.json` (the file name must equal the `id`).
2. Add it to `GAME_FILES` in `save_convert/db.rs`.
3. If the save bytes differ between platforms, write or reuse a codec (below).
4. `cd engine && cargo test -p ps5upload-core save_convert` — the database
   tests validate every profile and fail if a file isn't registered.

### Profile reference

```json
{
  "id": "example-game",
  "name": "Example Game",
  "status": "wip",
  "aliases": ["EG"],
  "ps5": {
    "title_ids": ["PPSA01234", "PPSA05678"],
    "save_hint": "Where the files sit inside the decrypted save."
  },
  "pc": {
    "steam_app_id": 123456,
    "save_path": "%APPDATA%\\ExampleGame\\Saves"
  },
  "files": [
    { "ps5": "SYSTEM.DAT", "pc": "system.sav", "label": "System data" },
    { "ps5": "SLOT*.DAT", "pc": "slot_*.sav", "label": "Character slot", "required": false }
  ],
  "codec": "passthrough",
  "codec_params": {},
  "options": [
    {
      "key": "steam_id64",
      "label": "Your SteamID64",
      "kind": "steam_id64",
      "help": "Shown under the field.",
      "directions": ["ps5_to_pc"]
    }
  ],
  "notes": ["Shown on the game's card before converting."],
  "next_steps": {
    "ps5_to_pc": ["Shown after a PS5 → PC conversion."],
    "pc_to_ps5": ["Shown after a PC → PS5 conversion."]
  },
  "credits": ["Research or tools the profile was built from."]
}
```

| Field | Notes |
|:--|:--|
| `id` | Lowercase letters/digits with single dashes. Also the output folder prefix. |
| `status` | `ready` — verified both ways against real saves. `experimental` — converts, not yet confirmed in-game both ways. `wip` — listed, conversion refused. |
| `ps5.title_ids` | Every regional ID covered (`PPSA…`; `CUSA…` for a PS4 build). |
| `files[].ps5` / `.pc` | Path relative to the save folder, `/`-separated. At most one `*` (one or more characters within a single path segment); whatever it matches on the source side is substituted on the destination side, so use it on both sides or neither. Matching is ASCII case-insensitive. An entry without `*` always wins over a wildcard entry that would also match the file. Two wildcard entries that could match the same name, or a name used as a file by one entry and a folder by another, are rejected. |
| `files[].required` | Default `true`. A missing required file blocks the conversion. For a `*` entry, "present" means at least one match. |
| `codec` / `codec_params` | Codec id from `codec.rs` and its settings. Params are checked when the database loads. |
| `options[]` | Values the user must type. `kind`: `steam_id64` (validated as a real individual-account id) or `text`. `directions` empty/omitted = both. `required` defaults to `true`. The same `key` may appear once per direction, to ask for the same value with different wording each way. |

Unknown fields are rejected, so a typo fails the tests instead of being
silently ignored.

## Adding a codec

Implement `Codec` in `codec.rs` and add it to `CODECS`:

```rust
impl Codec for MyFormat {
    fn id(&self) -> &'static str { "my-format" }
    fn validate_params(&self, params: &serde_json::Value) -> Result<()> { /* … */ }
    fn convert_file(&self, ctx: &CodecCtx<'_>, file: &FileMap, input: &[u8]) -> Result<Converted> {
        match ctx.direction {
            Direction::Ps5ToPc => { /* … */ }
            Direction::PcToPs5 => { /* … */ }
        }
    }
}
```

A codec can also take an early look at each source file while the user is
still choosing folders — return `true` from `checks_sources` and implement
`check_source`. It runs before any option is known, so it should judge only
what the bytes alone reveal ("this is a PC save, not a PS5 one", "this file
is damaged"). Whatever it rejects shows up in the folder preview and blocks
the conversion.

Codecs are pure functions over bytes — no file system access — so they are
unit-tested directly against captured samples. Rules of thumb:

- Verify what you can on the way in (magic, sizes, checksums) and fail with a
  plain-language error rather than emit a save the game will reject.
- A codec must round-trip: `PS5 → PC → PS5` should reproduce the original
  game data.
- Don't commit real saves. They carry account identifiers; keep test vectors
  synthetic or reduced to the bytes the test needs.

## The RE Engine (DSSS) codec

Monster Hunter Wilds — and, later, other RE Engine games that seal PC saves
the same way — uses the `re-engine-dsss` codec, in `save_convert/re_engine/`.
It is a self-contained, self-tested library for the "DSSS" save format:

- `container` — the file: header, DEFLATE layer, murmur3 checksum. Reads PS5
  (deflate only) and PC (per-account encrypted) saves and writes either.
- `mandarin` — the PC encryption (keyed on the Steam ID), and
  `find_steam_id64`, which recovers the account a PC save belongs to by
  trying account ids against the file.
- `stream` — the inner object stream, re-laid-out for the other platform's
  alignment base (12 on PS5, 16 on PC), the one real difference between them.

`codec_params`:

| Field | Meaning |
|:--|:--|
| `enc_seed` | Per-game block-plan seed, hex string (too large for a JSON number). |
| `rsa_seed` | Per-game trailer seed, hex string. |
| `reset_identity_fields` | String fields holding a per-account online id; reset to the game's fresh-hunter value on the cross-account move so the game issues a new one. |

The format was learned from ree-save-editor (kvasszn, GPL-3.0) and
MandarinJuice (mi5hmash, MIT); the code is original. Tests tagged with the
`XENO_SAVE_VECTORS` environment variable run against real game-written saves
and third-party reference vectors kept outside the repository; they skip
(with a note) when it is unset.

## Status

| Game | Status |
|:--|:--|
| Monster Hunter Wilds | Experimental — converts both ways; verified on real saves end to end (container, encryption, stream, account detection), not yet confirmed in-game |
