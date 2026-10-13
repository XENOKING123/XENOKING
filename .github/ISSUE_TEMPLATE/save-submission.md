---
name: Share a PS5 save (XENO STORE)
about: Submit a community save to the XENO STORE Save Data Store. XENO STORE prefills this from the console; you only need to press "Submit new issue".
title: "[save] <game> — <what the save is>"
labels: save-submission
---

<!--
XENO STORE Save Data Store · community submission

If you opened this from the console (Library → Community Saves → Upload my
save), everything below is already filled in: press "Submit new issue" and
you are done. The checks run automatically within a few minutes and leave a
comment here; the XENO team then adds the `approved` label and the save
appears in every console's store.

Filling it in by hand? Upload your decrypted save zip (xeno-save-zip or
Garlic layout: the save files at the zip root, optionally sce_sys/param.sfo
and sce_sys/icon0.png — never sealedkey or keystone) to pixeldrain or
catbox, then fill the JSON block. Rules the checks enforce:

  titleId      PS5 title id, PPSA + 5 digits (PS4 CUSA saves are not accepted)
  title        game name (1–120 characters)
  category     starter | platinum | checkpoint | modded | chapter | other
  name         what the save is (1–80 characters)
  description  up to 300 characters
  author       your nickname (1–60 characters, no links, never a PSN id)
  gameVersion  the game version the save was made on, e.g. 01.004.000 (or "")
  region       EUR, USA, JPN, ASIA, … (or "")
  dirName      the save directory, e.g. SAVEDATA00 (or "" when the zip has xeno-save.json)
  size         zip size in bytes (2 GiB maximum)
  sha256       lowercase SHA-256 of the zip
  url          direct https link to the zip (the checks download it)
  tags         up to 10 short tags

Keep the ```json fence; do not add text inside it.
-->

```json
{
  "titleId": "PPSA00000",
  "gameId": "",
  "title": "",
  "category": "other",
  "name": "",
  "description": "",
  "author": "",
  "gameVersion": "",
  "region": "",
  "dirName": "SAVEDATA00",
  "size": 0,
  "sha256": "",
  "url": "https://",
  "format": "xeno-save-zip",
  "kind": "ps5",
  "tags": []
}
```

<!-- Anything else for the reviewers (optional) goes below this line. -->
