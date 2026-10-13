# XENO STORE · Save Data Store

The Save Data Store is the community save library built into XENO STORE: PS5
saves shared by other players, checked before they are listed, installed to
your profile with one press. This guide covers how it works on the console,
what the categories and compatibility badges mean, what each re-sign engine
can and cannot do, how to share your own save, and — for the owner — how the
two backends and the review labels work.

PS5 titles only (`PPSA…` ids). PS4 saves (`CUSA…`) are not listed, and there
is no CUSA → PPSA conversion: there is no safe generic converter, so the store
says so instead of pretending.

---

## 1. Where it is on the console

* **Game page → Saves (n)**: every PS5 game page has a Saves tab next to
  Download with the saves for that exact title id.
* **Library → Community Saves**: browse everything, search by game, title id
  or author, category chips, "Compatible with my games", "My saves", and
  **Upload my save**.
* **Discover → New community saves** rail.

Saves are listed from two feeds, merged and deduped (by sha256 / Garlic id):

| feed | what | where it comes from |
|---|---|---|
| GitHub index | `updates/saves.json` in this repo (cached 1 h on the console) | submissions through GitHub issues, reviewed by the XENO team (§5) |
| Database | a Supabase project the owner deploys | console uploads + the Garlic mirror (§6) |

Settings → Saves → **Sources** lets you add more `saves.json` URLs (another
curated index), and **Backend** lets you point one console at a database
without changing the repo.

## 2. Categories

| chip | `category` | typical description |
|---|---|---|
| Maxed Starter | `starter` | start of the game with money, levels, gear, NG+ unlocked |
| 100% Platinum | `platinum` | everything done, platinum-ready or earned |
| Trophy checkpoint | `checkpoint` | right before a boss, a missable, a specific trophy |
| Modded / Glitched | `modded` | edited values, glitched states — use at your own risk |
| Chapter | `chapter` | a specific chapter / act / mission |
| Other | `other` | anything else |

When a submission has no category, the store infers one from the text
(`100%`/`platinum` → platinum, `start`/`ng+`/`max` → starter, `trophy`/`boss`
→ checkpoint, `mod`/`glitch` → modded, `chapter` → chapter). The same rule
runs on the console, in the intake tool and in the database sync, so chips
match everywhere.

## 3. Compatibility (what the badges mean)

For every save the console checks your own installation before you press
anything:

| badge | meaning |
|---|---|
| ✓ Matches your 01.004.000 | the game is installed and the save was made on your version |
| ⚠ Made on 01.004.000, you have 01.000.000 | update the game first (one tap opens the game's Updates); older game + newer save usually fails to load |
| ⚠ Compatibility could not be checked | the save has no version (Garlic layout) — compare before installing |
| ✗ Game not installed | listed so you can download it for later |
| Other regions | same game, different title id — **a save never loads on a different title id** |

Incompatible saves are hidden by default ("Show all" reveals them). The
installed version comes from `/system_data/priv/appmeta/<titleId>/param.json`
(`contentVersion`), falling back to the app's own `param.json`.

## 4. The re-sign engine — three tiers, reported honestly

PS5 saves are sealed to the console and account that created them. To make a
community save load on *your* profile it has to be written through the
console's own save system (or re-signed). XENO STORE picks the best engine it
finds and shows which one it used; `GET /api/saves/engine` reports the same.

| tier | shown as | needs | what it does | limits |
|---|---|---|---|---|
| 1 · **native** | "Native" | the PS5 SaveData API reachable (`libSceSaveData.sprx`) **and** kstuff-style save patches active on your firmware | creates/mounts the save for your user and title id, copies the decrypted files in, sets the account id in `param.sfo` to yours, unmounts. Export does the reverse and strips the account id. | without the save patches the mount call fails; XENO STORE logs the return code and falls back — it never pretends a mount worked |
| 2 · **garlic** | "via Garlic" | Garlic Save Manager running and answering on `127.0.0.1:8082` | hands the zip to Garlic's local import/export API | depends on Garlic being loaded; XENO STORE does not bundle it |
| 3 · **raw** | "Same console only" | nothing | copies the folder `/user/home/<uid>/savedata_prospero/<TITLEID>/` directly (after an automatic backup) | works only for saves **made on this console** (your own backups, profile transfers). A community save installed this way will not load |

The UI labels tier 3 clearly and the Install button on a community save says
so when only the raw tier is available; the host build simulates tier 1 so the
whole flow is covered by `tests/host/test_saves.py`.

Offline-activated accounts (Settings → Accounts) have an account id too, which
tier 1 uses when PSN is absent.

## 5. Installing and downloading a save

On a save card:

* **Install to my saves** — downloads the zip (normal queue job
  `save-install`), verifies its sha256 against the index, then imports it
  with the engine above. "Back up my current save first" is on by default
  (`.pre-restore` zip under `<drive>/xeno-store/saves/<user>/`). Toast: "Save
  installed — launch the game".
* **Download file** — just saves the zip to
  `<drive>/xeno-store/saves/community/<game>/` (job `save-download`); reach it
  from a PC via XENO TOOL / FTP.
* **Report** — opens a prefilled GitHub issue for a broken or wrong save.

Download counts are bumped only after a verified install/download.

## 6. Sharing your own save (Upload my save)

Library → Community Saves → **Upload my save**:

1. pick the profile, then the PS5 title (only installed titles with saves are
   offered; name, cover, installed version and region are filled in from the
   catalog / appmeta),
2. pick the save directory,
3. the engine **exports** it: decrypted files + `sce_sys/param.sfo` with the
   account id zeroed + `sce_sys/icon0.png` + the `xeno-save.json` manifest.
   Sealed keys (`sealedkey`, `keystone`) are never included. If only the raw
   tier is available the export is marked `sameConsoleOnly` and the wizard
   stops: a raw export cannot be shared, it would not load anywhere else.
4. **upload** to pixeldrain (default) or catbox (≤ 200 MB), or your own
   endpoint (Settings → Saves → Upload host "custom": multipart `file` →
   `{url}`),
5. fill the form: category chips, name, description (≤ 300), tags, nickname —
   game, version, region, size and sha256 are already there,
6. **submit**:
   * with the GitHub backend (default): the console shows a QR code and a
     short link to a prefilled issue; open it on your phone and press *Submit
     new issue*. The checks (§7) run within minutes and comment on the issue;
     the XENO team labels it `approved` and it appears in every store within
     the hour.
   * with a database backend: the row is inserted as `pending` and goes live
     when the owner publishes it (or immediately when the owner enabled
     auto-publish).

Privacy: no account id, console id or PSN name leaves the console. The only
name attached to a save is the nickname you type.

### The xeno-save-zip format

```
SAVEDATA00.bin …           decrypted save files at the zip root
sce_sys/param.sfo          ACCOUNT_ID zeroed
sce_sys/icon0.png          used as the card cover
xeno-save.json             {titleId, dirName, kind:"ps5", format:"xeno-save-zip", gameVersion, region,
                            accountIdStripped:true, sameConsoleOnly:false, createdBy:"XENO STORE 1.0.0",
                            createdAt, files:[{path,size,sha256}]}
```

Garlic's "decrypted save zip" (same files, optionally wrapped in one folder,
no manifest) is accepted as-is everywhere: the title id comes from the index
row, version/region from the row when present, otherwise the badge says
"could not be checked". XENO uploads use the same layout plus the manifest, so
they also work in Garlic and Apollo-style tools.

## 7. What the checks enforce (GitHub intake)

`tools/saves/intake.py` runs in `.github/workflows/saves-intake.yml` on every
`save-submission` issue (opened, edited, labeled):

1. **Fields** — PPSA title id; title, name, nickname lengths; description
   ≤ 300; category from the list (or inferred); version like `01.004.000`;
   region letters; `dirName`; size ≤ 2 GiB; 64-hex sha256; a plain `https://`
   link without credentials; up to 10 short tags; `format` must be
   `xeno-save-zip` and `kind` `ps5`.
2. **Download** — streamed with a cap (never more than the declared size, never
   more than 2 GiB); HTML pages instead of files, HTTP errors and empty files are
   reported in plain words.
3. **Hash + size** must match the submission exactly.
4. **Zip** — must contain decrypted save files at the root (or in one wrapper
   folder), optionally `sce_sys/param.sfo` / `icon0.png`; must **not** contain
   `sealedkey`, `keystone`, `sdimg_*` raw images, `xeno-backup.json`, absolute
   or `..` paths or symlinks; a `xeno-save.json` manifest must match the title
   id, must not say `sameConsoleOnly` or `accountIdStripped:false`, and every
   file it lists must be in the zip with the right size.
5. **Duplicates** — the same file (sha256) already published or pending under
   another issue is refused.

Then the index row is written with status from the labels:

| labels on the issue | status | consoles |
|---|---|---|
| none / only `save-submission` | `pending` | hidden |
| `approved` | `published` | listed |
| `rejected` (wins over approved) | `rejected` | hidden, issue closed |
| any failed check, whatever the labels | `rejected` (new issue: nothing recorded; known entry: kept with `reasons`) | hidden |

Every run posts (or updates) one comment on the issue with the outcome, the
size, the hash, the layout and the file count, signed "XENO team · automated
intake". The index commit message is `saves: intake #<n> [skip ci]`.

`updates/saves.json` ships with three entries of `status: "example"` that show
the record shape; the app ignores any status other than `published`.

Run the checks yourself:

```sh
cd xeno-store
python3 -I tools/saves/intake.py --body issue.md --number 1 --file save.zip --dry-run   # local zip, no write
python3 -I tools/saves/intake.py --validate-index updates/saves.json
python3 -I -m unittest discover -s tools/saves/tests -v
```

## 8. For the owner: moderation day to day

* A new issue with the `save-submission` label arrives → the workflow checks
  it and comments. Read the comment (and the save's description), then add
  **`approved`** or **`rejected`**. The workflow runs again, rewrites the index,
  commits, updates its comment and closes the issue.
* To pull a published save: add `rejected` (reopen the issue first if it was
  closed, or edit `updates/saves.json` by hand — the tool keeps hand edits
  as long as the file stays valid; `--validate-index` tells you).
* Submissions by hand (no console): the template at
  `.github/ISSUE_TEMPLATE/save-submission.md` explains every field.
* Labels are the only switch: nobody without triage rights on the repo can
  publish, because only collaborators can add labels.

## 9. For the owner: the database backend (Supabase)

Deploy steps, schema and the edge functions live in
[`backend/supabase/README.md`](../backend/supabase/README.md). In short:

1. run `migrations/0000 → 0001 → 0002 → 0004` (0003 is the optional Garlic
   sync cron),
2. set the secrets (Garlic cookies for the mirror, optional `XENO_SYNC_TOKEN`,
   optional `XENO_AUTO_PUBLISH=1`),
3. `supabase functions deploy xeno-save-submit` (and `garlic-savedb` for the
   mirror),
4. put the project URL + anon key into `updates/saves-backend.json`
   (`backend/supabase/config/saves-backend.example.json` is the template) or
   into Settings → Saves → Backend on a console.

Console uploads land as `status = 'pending'` (row-level security refuses
anything else from the public key); publish them from the Table editor or let
`xeno-save-submit` publish what passes its server-side check. The function
reads only the zip's central directory (one 1 MiB `Range` request) to refuse
sealed keys, raw images and bad paths — it does not hash a 2 GiB object; the
console verifies the sha256 after download.

Garlic mirror rows (`file_path = 'garlic:<id>'`) stream from garlicsaves.com
through the function on demand and depend on a live Garlic session (cookies
expire after days to weeks; refresh them when downloads start failing — the
XENO uploads and the GitHub index keep working regardless).

## 10. Honest limits

* **Re-signing needs the native tier or Garlic.** Without save patches on your
  firmware and without Garlic, community saves can only be downloaded (and
  restored as-is, which works for saves made on the same console).
* **Version and region matter.** A save made on a newer game version may not
  load on an older one; a save never loads on another region's title id. The
  badges tell you before you install; "Show all" is there for people who know
  what they are doing.
* **Modded / glitched saves** can break trophies or progression. They are
  labelled, not hidden.
* **No PS4 saves, no conversion.**
* **Hosting is third-party** (pixeldrain, catbox, Garlic, the owner's
  database). Links can die; "Report" sends the XENO team a prefilled issue.
* **Nothing is faked**: every engine tier, every check and every failure is
  shown as it happened, with the reason.
