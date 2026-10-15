# Naruto trainer pack (for building a cheat editor)

Everything XENO TOOL has for the Naruto Storm games, pulled out of
`client/src-tauri/resources/trainers-seed.zip` so it can be handed to an
editor project (e.g. Lovable) in one place.

> These are the trainers bundled in the XENO TOOL seed library. They are not
> new work from a separate session; no other Naruto trainer exists in this
> repo or its branches.

## Files

| File | Game | Ver | Format | Author | Editable? |
|---|---|---|---|---|---|
| `files/CUSA06381_01.02.json` | Storm 4: Road to Boruto | 01.02 | JSON (CheatRunner/GoldHEN) | Weysincha | Yes, plain text |
| `files/CUSA06381_01.02.shn` | Storm 4: Road to Boruto | 01.02 | SHN (XML) | TLH, Dante | Yes, plain text |
| `files/CUSA06381_01.02.mc4` | Storm 4: Road to Boruto | 01.02 | MC4 (encrypted) | Weysincha | No, opaque blob |
| `files/CUSA06381_01.02.mc4.xml` | Storm 4: Road to Boruto | 01.02 | MC4 sidecar (names only) | Weysincha | Names only |
| `files/Naruto_Shippuden_..._Weysincha.mc4` | Storm 4: Road to Boruto | 01.02 | MC4 (encrypted) | Weysincha | No, opaque blob |
| `files/CUSA06291_01.02.json` | Storm Trilogy | 01.02 | JSON | Weysincha | Yes, but see warning |

The seed zip also had byte-identical `_2` copies of the JSON, SHN and MC4
files; they were left out. The `*-NEWAPI.json` / `*-OLDAPI.json` files for
these title IDs are PlayStation Store product listings, not cheats.

Title IDs: `CUSA06381` = Storm 4 Road to Boruto (US), `CUSA06291` = Storm
Trilogy (EU). Every cheat targets `eboot.bin`, game version `01.02`.

## What the cheats do

### JSON: `CUSA06381_01.02.json` (3 cheats)

| Cheat | Patches |
|---|---|
| Godmode Left Player | `0x20BF800` (32 B code cave) + `0x919EA6` (6 B jump) |
| Infinite Chakra Left Player | `0x20BF820` (32 B cave) + `0x91A5A6` (6 B jump) |
| Infinite Money / Ryo | `0x20BF840` (18 B cave) + `0x53B71A` (7 B jump) + `0x20BF852` (18 B cave) + `0xAC646A` (7 B jump) |

There are no overlaps, so all three can be on at once.

### SHN: `CUSA06381_01.02.shn` (6 cheats)

| Cheat | Patches |
|---|---|
| Infite Health + 1 Hit Kills *(sic)* | `0x20BF800` (48 B cave) + `0x919EAC` (5 B jump) |
| Infinite Health | `0x20BF800` (1 B flag → `01`) |
| 1 Hit Kill (Turn off in Boss Battle) | `0x20BF801` (1 B flag → `01`) |
| Infinite Chakra | `0x20BF830` (23 B cave) + `0x91A5AC` (5 B jump) |
| infinite Ryo on Gain | `0x20BF847` (19 B cave) + `0x53B71A` (7 B jump) |
| Infinite Items on Spend | `0x20BF800` (17 B cave) + `0x565B49` (7 B jump) |

How the cheats depend on each other:
- **Infinite Health** and **1 Hit Kill** are only on/off switches. They flip
  the first two bytes of the "Infite Health + 1 Hit Kills" code. Turn that
  main cheat on first, or the switches do nothing.
- **Infinite Items on Spend writes to the same address (`0x20BF800`) as the
  health cheat.** If both are on, one overwrites the other, and the game will
  likely crash. Don't run them together.

### MC4: names only (sidecar `CUSA06381_01.02.mc4.xml`)

The MC4 file is encrypted. The `.mc4.xml` sidecar only lists the cheat
names: *Godmode Left Player*, *Infinite Chakra Left Player*, *Infinite
Money / Ryo*. Those are the same three cheats as the JSON. CheatRunner
on the PS5 decrypts MC4 itself. XENO TOOL never decrypts it, and an editor
shouldn't either: show it read-only, with names from the sidecar.

### ⚠ Trilogy file is a copy

`CUSA06291_01.02.json` (Trilogy) has **exactly the same `mods` block** as the
Road to Boruto JSON. Only `name` and `id` differ. Trilogy has a different
`eboot.bin`, so these offsets almost certainly don't fit it. Treat it as
unverified. Ideally the editor warns when two files for different title IDs
have identical patches.

## File formats (editor spec)

### JSON (CheatRunner / GoldHEN style)

```json
{
  "name": "Game title",
  "id": "CUSA06381",
  "version": "01.02",
  "process": "eboot.bin",
  "mods": [
    {
      "name": "Cheat name",
      "type": "checkbox",
      "memory": [
        { "offset": "20BF800", "on": "0F86B2…", "off": "000000…" }
      ]
    }
  ],
  "credits": ["Author"]
}
```

Rules:
- `offset`: hex string, **no `0x`**, uppercase. It's relative to the
  process's base address (eboot.bin).
- `on` / `off`: continuous hex strings, even length, **same length as each
  other**. Byte count = `length / 2`.
- `type`: every file here uses `"checkbox"` (on/off toggle).
- `id`: `CUSA#####` (PS4) or `PPSA#####` (PS5).
- `version`: `NN.NN`.

### SHN (XML)

```xml
<?xml version="1.0" encoding="utf-8"?>
<Trainer Game="…" Moder="…" Cusa="CUSA06381" Version="01.02" Process="eboot.bin">
  <Genres Name="Fighting" />
  <Items />
  <Cheat Text="Cheat name">
    <Cheatline>
      <Offset>20BF800</Offset>
      <Section>0</Section>
      <ValueOn>01-02-03</ValueOn>
      <ValueOff>00-00-00</ValueOff>
    </Cheatline>
  </Cheat>
</Trainer>
```

Rules:
- One `<Cheat>` = one toggle. One `<Cheatline>` = one memory write.
- Bytes are dash-separated (`E9-51-59-7A-01`); `ValueOn` and `ValueOff` must
  have the same byte count.
- `Section` is `0` everywhere here (main executable).
- `Moder` is the author attribute (the misspelling is part of the format).
- Some sites give the extension as `.ShnExt`; CheatRunner only accepts
  `.shn`.

### MC4

- `.mc4`: encrypted text blob. Read-only.
- `.mc4.xml` sidecar: same `<Trainer>` header as SHN, plus `<Cheat Text="…">`
  entries **with no cheatlines**. Use it for names only.

### Converting JSON ⇄ SHN

| JSON | SHN |
|---|---|
| `name` | `Trainer@Game` |
| `id` | `Trainer@Cusa` |
| `version` | `Trainer@Version` |
| `process` | `Trainer@Process` |
| `credits.join(", ")` | `Trainer@Moder` |
| `mods[i].name` | `Cheat@Text` |
| `memory[j].offset` | `Cheatline/Offset` |
| `memory[j].on` (`"E95159"`) | `Cheatline/ValueOn` (`"E9-51-59"`) |
| `memory[j].off` | `Cheatline/ValueOff` |
| *(none)* | `Cheatline/Section` = `0` |

SHN `Genres` have no JSON equivalent. Keep them on round-trips, or drop
them when exporting to JSON.

## Installing on the console (how XENO TOOL does it)

- CheatRunner listens on **port 9999**. Upload is
  `POST http://<ps5-ip>:9999/api/cheats/upload?filename=<name>` with the raw
  file bytes as the body (`Content-Type: application/octet-stream`, **not**
  multipart).
- CheatRunner files the upload by extension into
  `/data/cheatrunner/cheats/{json,shn,mc4}/`.
- Allowed extensions: `.json`, `.shn`, `.mc4`. Size caps: JSON **2 MiB**, SHN
  and MC4 **1 MiB**.
- Filenames may only contain `[A-Za-z0-9._-]` (no spaces or brackets), and
  the extension must be lowercase. Keep the `TITLEID_VERSION` pattern
  (`CUSA06381_01.02.json`), because the daemon matches on it.
- See `client/src/lib/cheatRunner.ts` (`sanitizeCheatFilename`) and
  `client/src-tauri/src/commands/xeno_store.rs` (`cheatrunner_upload`).

A Lovable app is hosted on `https://`. Browsers block an https page from
calling a plain `http://192.168.x.x` address, so it **cannot push directly to
the PS5**. Have it export or download the file, then send it with XENO TOOL.

## Lovable prompt (paste this)

```
Build "Cheat Editor": a client-only React + TypeScript + Tailwind + shadcn/ui
web app (no backend, no login) for editing PS4/PS5 trainer files. Use a plain
dark UI. No game or character artwork.

IMPORT
- Drag-and-drop or file picker for .json, .shn, .ShnExt, .mc4 and .mc4.xml.
- JSON format: { name, id, version, process, mods: [{ name, type: "checkbox",
  memory: [{ offset, on, off }] }], credits: [] }. offset = hex, no 0x;
  on/off = continuous hex byte strings of equal length.
- SHN format: XML <Trainer Game Moder Cusa Version Process> with <Genres
  Name>, <Items/>, and <Cheat Text> containing <Cheatline> with <Offset>,
  <Section>, <ValueOn>, <ValueOff>. Bytes are dash-separated ("E9-51-59").
- .mc4 is encrypted: show it read-only as "encrypted". If a matching .mc4.xml
  sidecar is loaded, list its <Cheat Text> names. Never try to decrypt it.

EDITOR
- Header form: game name, title ID (CUSA#####/PPSA#####), version (NN.NN),
  process (default eboot.bin), authors.
- Cheat list (add / rename / duplicate / delete / drag to reorder).
- Per cheat: table of memory writes (offset, ON bytes, OFF bytes, section).
  Show bytes as an editable hex grid with byte count.
- Live validation: hex only, even length, ON and OFF same length, offset is
  valid hex, title ID and version patterns.
- Overlap detector: flag any two cheats whose [offset, offset+len) ranges
  overlap and say which cheats conflict. Treat 1-byte writes that land
  inside another cheat's range as "flag/switch for <that cheat>" (info, not
  error).
- Duplicate detector: warn if two loaded files with different title IDs have
  identical memory patches.

EXPORT
- Save as JSON or SHN (convert both ways: JSON credits <-> SHN Moder,
  hex "E95159" <-> "E9-51-59", Section defaults to 0). Keep SHN Genres on
  SHN round-trips.
- Output filename = TITLEID_VERSION.ext (e.g. CUSA06381_01.02.json), only
  [A-Za-z0-9._-], lowercase extension, .ShnExt becomes .shn.
- Size limits: warn if JSON > 2 MiB or SHN > 1 MiB.
- Side-by-side diff vs the originally imported file before download.

Include the attached CUSA06381_01.02.json and CUSA06381_01.02.shn as built-in
sample files the user can open with one click.
```

Attach `files/CUSA06381_01.02.json` and `files/CUSA06381_01.02.shn` to the
Lovable chat as the sample files.
