# Monster Hunter Wilds save converter (PS5 ⇄ PC) — complete handoff

This document is a self-contained brief for another AI (or developer) to pick
up this project. It explains the goal, the save format in full, what has been
built and verified, the online-transfer problem (`EW_31512`), the "merge"
approach that is the current work, and where everything lives. The full source
is in this folder (`save-converter/`).

Nothing here depends on secrets. The only things NOT in the repo are the
third-party reference tools (credited below) and the user's own save files
(used for verification, kept outside the repo).

---

## 1. Goal

A tool that converts game saves between **PlayStation 5** and **PC (Steam)**.
First game: **Monster Hunter Wilds** (RE Engine, Steam app `2246340`). The
design is a game database so more games can be added. The end goal the user
stated is ~101 games.

Delivered form: a **single local HTML file** (`dist/xeno-save-converter.html`)
that runs entirely in the browser, offline — a Rust engine compiled to
WebAssembly and inlined into the page. No install, no upload.

---

## 2. Status (what works, what doesn't)

| Thing | State |
|:--|:--|
| PS5 ⇄ PC **format conversion** | ✅ Done, verified byte-for-byte against the user's real saves and two independent reference vectors. The converted save **loads and plays**. |
| PC save **decryption** + account recovery | ✅ Done and verified. |
| Steam ID auto-detect (from the save, or from the `SS1_` photo file) | ✅ Done. |
| Local/offline play after conversion | ✅ Works. |
| **Online** play after a cross-platform transfer | ❌ **Blocked by Capcom** (error `EW_31512`). See §6. Not fixable by a straight conversion. |
| Online **"merge"** (graft a genuine PS5 identity) | 🔶 Engine built + unit-tested; **needs a genuine PS5 reference save to run/validate**; unproven for Wilds. See §7. |

---

## 3. The save file format (DSSS v2)

A Wilds save file is a container called **DSSS** (version 2) wrapping one
block of data (the "object stream"). All integers are little-endian.

### 3.1 Container

```
PC (Steam):  flags 0x18 = Deflate | Mandarin
  0x00  "DSSS"
  0x04  u32 2                      (version)
  0x08  u32 0x18                   (flags)
  0x0C  u32 0                      (padding; header is 16 bytes when encrypted)
  0x10  Mandarin blocks + 0x80-byte trailer   (plaintext = compression header + raw DEFLATE)
  EOF-12  u64  length of that plaintext
  EOF-4   u32  murmur3_x86_32(everything before it, seed 0xFFFFFFFF)

PS5:  flags 0x08 = Deflate only
  0x00  "DSSS", u32 2, u32 0x08    (12-byte header)
  0x0C  4 "leftover" bytes         (gap to the next multiple of 8)
  0x10  compression header + raw DEFLATE
        0..=3 "leftover" bytes     (so the file length is a multiple of 4)
  EOF-4   u32  murmur3

Compression header (24 bytes):
  u64 (compressed_size + 0x10), u32 1, u32 compressed_size, u64 uncompressed_size
```

**"Leftover" bytes (PS5):** the game serialises the object stream into its
buffer at offset 12, then writes the compression header + compressed data over
it from offset 16. Bytes it doesn't overwrite (the 4 at 0x0C and the tail
padding) still hold the uncompressed stream's bytes for those offsets. A
game-written PS5 save rebuilds to its exact bytes this way, using zlib level 5
(the level the game uses). The reader accepts anything in those gaps.

The game uses **zlib** level 5; our engine uses **miniz_oxide** (via `flate2`),
which produces *different* DEFLATE bytes. That is fine — the game decompresses,
it does not byte-compare. So a converted file is not byte-identical to a
game-written one but decodes to the identical object stream.

### 3.2 Mandarin encryption (PC only)

The PC payload is encrypted per Steam account. Key = `!SteamID64` (bitwise NOT
of the full 64-bit id). Constants (Monster Hunter Wilds):

```
enc_seed = 0x7A36955255266CED     (block-size generator seed)
rsa_seed = 0xBFACF76C3F96         (encrypted-trailer seed)
P (LE) = f33b6fb972a0b72515e45c391829e182ad8a9bdc0a64d3444d79c810ab863717
Q (LE) = f99db75c39d0db920a72ae1c8c9470c156c54d6e05b269a2a63c648855c39b0b
R (LE) = e66f544afcce68c5ef07b9a07b277585344a1db61376e831f73b9fbd5f44f715
E = 0x14
X0 = R^E mod P (the fixed value every block header starts with once unmasked)
BLOCK_UNIT = 0x4000 ; HEADER_LEN = 0x210 ; TRAILER_LEN = 0x80
```

Algorithm (see `engine/src/mandarin.rs` for the exact, verified code):

- A **SplitMix64-style generator** (note: the *mixed* value becomes the new
  state, not standard SplitMix64) seeded from `enc_seed` draws a block plan:
  each block is `(1..=8) * 0x4000` bytes. After the plan, `key64` is added to
  the state.
- Each block: draw a 16-byte AES key + 16-byte IV from the generator; build a
  0x210-byte header = four `(X0, X1*word_i)` pairs (a 253-bit ElGamal-like key
  wrap over prime P) + `u64 CityHash64(plaintext)` + `u64 tail`; XOR the whole
  header with generator output; then `AES-128-OFB(key, iv)` over the block's
  plaintext (zero-padded to block size).
- After the last block, a 0x80-byte trailer (`m^65537 mod N`, from `rsa_seed`).
- A **wrong key is detectable**: after un-masking the first header, its first
  64 bytes must equal `X0`.

**Account recovery:** because every block header starts with `X0` only under
the right account's key stream, the 32-bit Steam *account id* can be found by
trying candidates against the first header (a few generator steps each, no
decryption). `find_account_in_range` does a slice; the page runs several across
Web Workers. The SteamID64 is `0x0110000100000000 + account_id`.

Two reference tools disagree on three write-time details (the `tail` value, the
0x80 trailer, last-block padding) and so does the game between its own files —
all are **ignored on read**, confirming nothing reads them back. Our writer
uses `tail = 0` and the deterministic ree-save-editor trailer.

### 3.3 The object stream (the only real PS5/PC difference)

After decrypt + inflate, the bytes are the RE Engine "RSZ" object stream:

```
stream : ( u32 native_field_hash ; Class )*   then < 8 zero bytes
Class  : u32 num_fields ; u32 class_hash ; Field * num_fields
Field  : u32 name_hash ; i32 type ; Value ; pad to 4
Value  : Array | Class | String(pad4;u32 n;n UTF-16 units) | other(pad4;u32 size;engine_align(size);size bytes)
Array  : pad4; i32 member_type; u32 member_size; u32 count; i32 kind(0 values|1 classes)
         kind 1: optional u32 0xFFEEFFEE then count u32 hashes, then count Classes
         pad4
engine_align(size): unless size==1, position = (position + size-1) & !(size-1)   // ABSOLUTE position
```

- `class_hash` / `name_hash` = `murmur3_x86_32(name, seed 0xFFFFFFFF)` of the
  UTF-8 class/field name. (So field/class names can be resolved from the RSZ
  schema — see §8.)
- **Alignment is computed from the ABSOLUTE position = stream offset + base.**
  The base is the file offset where the stream begins **before** decompression:
  **16 on PC, 12 on PS5.** This single difference is why the same objects need
  different padding per platform. **Converting = re-laying-out the stream for
  the other base** (`stream/walk.rs::rebase`), which is a streaming single
  pass, not a byte copy.

---

## 4. What the converter does, per direction

- **PS5 → PC:** decode the PS5 file (flags 0x08, no key) → stream at base 12 →
  rebase to 16 → reset the online identity → encode flags 0x18 encrypted for
  the **target PC account** (user supplies that SteamID64).
- **PC → PS5:** decode the PC file (flags 0x18, needs the **source** account's
  key; recovered from the file if not given) → stream at base 16 → rebase to
  12 → reset the online identity → encode flags 0x08 (no encryption). The
  output is a **decrypted** PS5 save; the user re-signs/re-encrypts it on-console
  with a save manager (Garlic SaveMgr / Apollo).

"Reset the online identity" = set `HunterId` and `HunterShortId` of each hunter
slot to `"--------"` (eight U+002D), the value the game writes for a
never-online hunter. See §6 for why this is necessary but not sufficient.

---

## 5. Build & run

```bash
rustup target add wasm32-unknown-unknown
cd save-converter
./build.sh            # compiles engine → wasm, inlines into dist/xeno-save-converter.html
```

Open `dist/xeno-save-converter.html` in any modern browser (works from `file://`).

Engine is also native-testable:

```bash
cd save-converter/engine
cargo test            # self-contained tests
XENO_SAVE_VECTORS=/path/to/sample/dir cargo test   # + real-save end-to-end tests
```

`XENO_SAVE_VECTORS` points at a directory holding the (third-party / user)
sample saves; those tests skip when it is unset. Expected layout used by the
tests: `samples/pc_wilds/2246340/remote/win64_save/{data001Slot.bin,data00-1.bin,SS1_data001Slot.bin}`,
`samples/ps5/{data00-1.bin,SS1_data001Slot.bin}`, plus the two reference
vectors under `repos/` (see §9).

---

## 6. The online problem: `EW_31512` (VERIFIED)

A PC save converted to PS5 **loads and plays**, but going **online** throws
`EW_31512`. Research verdict (sources below):

- **`EW_31512` = Capcom's server rejecting a hunter whose IDs don't match what
  the server has registered for the signed-in account.** The author of the
  other save tool (ree-save-editor) documented this exact error: *"core cause
  is some disconnect b/w the save's ids and whatever's on capcoms servers."*
- A hunter's **online identity lives on Capcom's servers**, tied to the account
  that created it. Capcom officially does **not** support cross-platform save
  sharing ("save data … managed separately by each platform").
- The in-game **"disable crossplay" prompt is a red herring** for this cause.
- **Wiping `HunterId`/`HunterShortId` is necessary but NOT sufficient**: the
  reset `"--------"` id was never registered on the target (PSN) account.

### Field investigation (important, empirical)

We decoded the user's real PC character save and resolved **every field by
name** via the RSZ schema. Findings:

- The online identity in the save is **only** `HunterId` and `HunterShortId`
  (two UTF-16 strings per hunter slot, class `app.savedata.cUserSaveParam`,
  class hash `0xD32F821C`; `HunterId` name hash `0x043F3BB4`, `HunterShortId`
  `0x9806D51D`).
- The hunter's GUID appears **exactly once** (that string). It is **not** stored
  as binary bytes, **not** as a murmur3 hash, **not** anywhere else. (Checked by
  searching the raw stream for the GUID in every encoding + its murmur3.)
- There is **no embedded Steam ID**, **no `ServerUserId`/`ServerSlotId`/
  `ServerPawnId`**, **no `_RegionHash`/`_ApplicationVersion`** in the save
  (unlike Dragon's Dogma 2 / RE Requiem, which do embed server ids).

So for Wilds, **the save carries nothing more to change** — the server linkage
is purely server-side. This both explains `EW_31512` and shapes the fix in §7.

---

## 7. The "merge" (current work; experimental)

Idea (the only pattern that has restored online for an RE Engine transfer — the
Dragon's Dogma 2 precedent): don't carry the PC hunter's identity across; put
the PC character's **progress** onto a **genuine PS5 hunter's identity** that is
already registered online on the target PSN account.

For Wilds this is clean because the only save-side identity is
`HunterId`/`HunterShortId`:

> **Convert PC → PS5, but per hunter slot keep the `HunterId`/`HunterShortId`
> of a genuine PS5 reference save instead of resetting them.** Progress from the
> PC save, online identity from the reference.

Implemented as `convert::merge_pc_to_ps5(game, pc_steam_id64, pc_input,
ps5_reference)` and the `xeno_merge` wasm export. Slots with no genuine
reference identity (reference has fewer slots, or that slot is empty
`"--------"`) fall back to a reset so they can't carry a stale PC id. Matched
**slot-for-slot by index**.

**What's needed to run it:** a genuine PS5 `data001Slot.bin` (decrypted) of a
hunter that currently works online on the target PSN account. (We have the PC
save; we do not yet have a PS5 *character* save — only PS5 system data.)

**Unknowns / risks (be honest with the user):**
- Unproven for Wilds. It should pass the *ID* check (`EW_31512`), but Capcom may
  separately validate/flag the sudden **progress** change (anti-cheat).
- **Ban risk** testing edited saves online — use a throwaway-risk account, keep
  backups.
- Slot matching may need tuning once a real reference save's slot layout is seen
  (which slot holds the registered hunter).

**Not yet wired into the page UI** — exposed only via `xeno_merge`; run it
off-UI first, confirm online, then add a button.

### Other games note

The user mentioned **Dragon Ball Xenoverse 2**, where online progress lives *in
the save* (not server-locked). For such games a straight conversion carries
online progress too — a good future target. (Different game/engine/format; needs
its own research. XV2 is not RE Engine.)

---

## 8. Resolving field names (how the §6 investigation was done)

The stream stores `murmur3_x86_32(name, 0xFFFFFFFF)` hashes, not names. The RE
Engine **RSZ schema** maps class CRCs → field names; for Wilds the schema's
class key equals the murmur3 class hash, so you can build `hash → name` for
every class and field and fully annotate a save. The schema ships with
ree-save-editor: `assets/mhwilds/rszmhwilds.json.gz` (322k classes). Scripts
that do this live in the scratch analysis dir (see §9); port them if continuing.

---

## 9. Source layout & references

```
save-converter/
  HANDOFF.md            this document
  README.md             user-facing readme
  index.html            the page (template; __WASM_B64__ replaced at build)
  build.sh              compile engine → wasm, inline into dist/
  dist/xeno-save-converter.html   the built, self-contained tool
  engine/               the Rust engine (compiles to wasm + native)
    Cargo.toml
    src/lib.rs          WebAssembly C ABI (see below)
    src/container.rs    DSSS file: header, DEFLATE, checksum, decode/encode
    src/mandarin.rs     PC per-account encryption + find_account_in_range
    src/hash.rs         murmur3_x86_32, cityhash64, name_hash
    src/stream/mod.rs   object-stream types + public API (probe/rebase/rebase_with)
    src/stream/walk.rs  the single-pass walker / re-layout
    src/convert.rs      convert(), merge_pc_to_ps5(), steam_id_from_photo()
    src/games.rs        the game database (one entry: Monster Hunter Wilds)
    src/error.rs        DsssError (player-facing messages)
    src/expected.rs     test-only known-answer vectors (from the Python reference)
    src/real_files_test.rs   end-to-end tests on real saves (XENO_SAVE_VECTORS)
```

### WebAssembly ABI (`engine/src/lib.rs`)

Result buffer (little-endian): `[i32 status][u32 len][u64 value][len bytes payload]`.
`status` 0=ok, 1=ok-but-empty, <0=error (payload = UTF-8 message).

- `xeno_alloc(len) -> ptr`, `xeno_free(ptr,len)`, `xeno_result_free(ptr)`
- `xeno_peek_flags(in,len)` → value = container flags (0x08 PS5 / 0x18 PC)
- `xeno_account_from_photo(in,len)` → value = SteamID64 (or status 1)
- `xeno_find_account(game, in,len, start, count)` → value = SteamID64 (or 1)
- `xeno_convert(game, direction(0=PS5→PC,1=PC→PS5), steam_id64, in,len)` → payload = converted file; value = #identity fields reset
- `xeno_merge(game, steam_id64, pc,pc_len, ref,ref_len)` → payload = merged PS5 file; value = #slots grafted

### Reference material (third-party; NOT in this repo)

- **ree-save-editor** — github.com/kvasszn/ree-save-editor (GPL-3.0). RE Engine
  save format, the RSZ schema (`assets/mhwilds/`), the `EW_31512` discussion
  (issues #5, #8), the DD2 online-fix precedent (#42), RE Requiem region hash
  (#41). The algorithms/constants here were learned from it; the code is
  original.
- **MandarinJuice** — github.com/mi5hmash/MandarinJuice (MIT). Second
  implementation of the Mandarin crypto + a reference decrypted vector.

### Verification artifacts (in the author's scratch dir, not the repo)

Independent Python reference (`mandarin_verify.py` — murmur3, cityhash64,
SplitMix64, block plan, key wrap, AES-OFB) and an object-stream
parser/serializer (`dsss_tree.py`) were used to cross-check the Rust
byte-for-byte. A field-name annotator (built from the RSZ schema) produced the
§6 findings. Re-create these from the format in §3 if continuing without them.

---

## 10. Suggested next steps

1. **Run the merge** with a genuine online-registered PS5 `data001Slot.bin`
   (`merge_pc_to_ps5` / `xeno_merge`), import on-console, test online. This is
   the open experiment that decides whether cross-platform online is reachable
   for Wilds at all.
2. If it works, add a "merge" mode to `index.html` (second file input for the
   reference save) and verify slot matching against a real multi-slot layout.
3. For more games: add a `Game` entry in `games.rs` (file names, `enc_seed`,
   `rsa_seed`, identity fields) and sample saves; the engine is shared. Confirm
   per game whether online progress is server-locked (Wilds) or in-save (likely
   Xenoverse 2).

## Key source URLs (online problem)

- https://github.com/kvasszn/ree-save-editor/issues/5  (EW_31512 = save-ids vs server mismatch)
- https://github.com/kvasszn/ree-save-editor/issues/42 (DD2 online fix: copy server ids from a working save)
- https://github.com/kvasszn/ree-save-editor/issues/41 (RE Requiem PC→PS5: _MainRegionHash + _ApplicationVersion)
- https://github.com/kvasszn/ree-save-editor/blob/main/docs/USAGE.md  (wipe HunterId/HunterShortId; lose online data on transfer)
- https://www.dexerto.com/gaming/monster-hunter-wilds-crossplay-cross-progression-2781642/  (Capcom: no cross-save)
