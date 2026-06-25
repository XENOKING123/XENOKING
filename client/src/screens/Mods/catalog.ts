// XENOKING curated Elden Ring mod catalog — v3.2.27 seed.
//
// All 7 mods here are confirmed file-only (no DLL/ModEngine dependency) and
// verified to physically work on PS5 once `xenoking-modloader.elf` mounts
// them. Each entry's `whatItReplaces` lists the real /app0/ paths the
// install will overlay, so users see exactly what's being swapped.
//
// Cover images use Nexus's staticdelivery CDN — added to the CSP img-src
// allowlist so they render inline without proxying.

export type ModCategory =
  | "anime"
  | "balance"
  | "visuals"
  | "audio"
  | "movesets"
  | "cosmetic"
  | "gameplay"
  | "other";

export interface CatalogReplaces {
  /** Game path the mod overlays, e.g. /app0/regulation.bin */
  gamePath: string;
  /** Human label, e.g. "game balance & parameter data" */
  what: string;
}

export interface CatalogMod {
  id: string;
  nexusId: string;
  url: string;
  title: string;
  author: string;
  version: string;
  category: ModCategory;
  /** 1-sentence summary for the card. */
  short: string;
  /** Long-form description for the detail modal. Paragraphs separated by \n\n. */
  long: string;
  /** Step-by-step usage instructions for the detail modal. */
  howToUse: string;
  whatItReplaces: CatalogReplaces[];
  coverUrl: string;
  endorsements: number;
  fileSize: string;
  /** Tags for filtering / chip display. */
  tags: string[];
  /** PS5 compatibility advisory. "" = drop-in. Otherwise a short caveat. */
  ps5Note: string;
  /** Other catalog ids this mod conflicts with (same regulation.bin / animations). */
  conflictsWith: string[];
  /** Other catalog ids this mod requires installed first. */
  requires: string[];
}

export const TITLE_ID_ER = "CUSA18000";

export const CATALOG: CatalogMod[] = [
  {
    id: "all-weapons-buffable",
    nexusId: "732",
    url: "https://www.nexusmods.com/eldenring/mods/732",
    title: "All Weapons Buffable + Spell Buffs Last Forever",
    author: "Clever (clevererraptor6)",
    version: "1.3",
    category: "balance",
    short:
      "Makes every weapon (Moonveil, Blasphemous Blade, etc.) accept spell/grease buffs, and gives weapon-buff spells infinite duration.",
    long:
      "A pure regulation.bin tweak by Clever that rewrites two parameter restrictions: the WeaponBuffable flag (so every weapon can accept a spell/incantation/grease buff, including Moonveil and the Blasphemous Blade that the base game blocks) and the buff duration values (so Scholar's Armament, Flame Grant Me Strength, Bloodflame Blade, and the rest never tick down).\n\nOne single file — regulation.bin — drops into the mod folder and overlays the game's parameter data the moment you load a save. No animations, no models, no scripts. Trivially safe.",
    howToUse:
      "1. Download the zip from Nexus and drop it into the Import panel.\n2. Click Stage to PS5 — the tool pushes regulation.bin to /data/xeno_mods/CUSA18000/all-weapons-buffable/.\n3. Toggle the mod ON. The v3.2.28 daemon nullfs-mounts it over /app0/regulation.bin on next game launch.\n4. Cast any weapon buff (Scholar's Armament, Flame Grant Me Strength, Bloodflame Blade, etc.) — it now lasts forever and applies to every weapon, including the bosses' own.",
    whatItReplaces: [
      { gamePath: "/app0/regulation.bin", what: "game balance & parameter data (weapon buffable flags + buff duration values)" },
    ],
    coverUrl: "https://staticdelivery.nexusmods.com/mods/4333/images/thumbnails/732/732-1649917043-740719988.png",
    endorsements: 2448,
    fileSize: "~2 MB",
    tags: ["Balance", "Magic", "QoL"],
    ps5Note: "",
    conflictsWith: ["clevers-moveset-modpack", "eternal-blades"],
    requires: [],
  },
  {
    id: "slayer-set",
    nexusId: "4211",
    url: "https://www.nexusmods.com/eldenring/mods/4211",
    title: "Slayer Set (Lost Ark)",
    author: "tchjay92",
    version: "1.0",
    category: "cosmetic",
    short:
      "Ports the Slayer armor + Dismounter greatsword from Lost Ark, replacing the Bloodhound Knight set and the Dismounter weapon.",
    long:
      "A faithful Lost Ark cosmetic port. The Slayer's full body, head, arms, and legs replace the Bloodhound Knight armor; the matching Dismounter greatsword model takes over the in-game Dismounter weapon slot. The armor has a glow-in-the-dark variant — the trim and waist sash light up at night.\n\nMechanically nothing changes. Bloodhound Knight stats, weight class, talisman synergies, and the Dismounter's moveset / scaling all stay vanilla. Pure mesh + texture swap.",
    howToUse:
      "1. Download the zip and import it.\n2. Stage to PS5 — files land in /data/xeno_mods/CUSA18000/slayer-set/parts/.\n3. Toggle ON. The daemon mounts the swapped meshes over /app0/parts/.\n4. In-game, get the Bloodhound Knight Set (Volcano Manor / Black Knife Catacombs) and the Dismounter (Warmaster's Shack merchant). They now look like the Slayer set + Lost Ark Dismounter.",
    whatItReplaces: [
      { gamePath: "/app0/parts/bd_a_1230.partsbnd.dcx", what: "Bloodhound Knight body armor" },
      { gamePath: "/app0/parts/hd_a_1230.partsbnd.dcx", what: "Bloodhound Knight helm" },
      { gamePath: "/app0/parts/am_a_1230.partsbnd.dcx", what: "Bloodhound Knight gauntlets" },
      { gamePath: "/app0/parts/lg_a_1230.partsbnd.dcx", what: "Bloodhound Knight greaves" },
      { gamePath: "/app0/parts/wp_a_*.partsbnd.dcx", what: "Dismounter greatsword model" },
    ],
    coverUrl: "https://staticdelivery.nexusmods.com/mods/4333/images/thumbnails/4211/4211-1700579983-578661564.jpeg",
    endorsements: 840,
    fileSize: "~25 MB",
    tags: ["Cosmetic", "Lost Ark", "Armor"],
    ps5Note: "",
    conflictsWith: [],
    requires: [],
  },
  {
    id: "eternal-blades",
    nexusId: "3538",
    url: "https://www.nexusmods.com/eldenring/mods/3538",
    title: "Eternal Blades (Sekiro movesets)",
    author: "Hotbite",
    version: "1.0",
    category: "movesets",
    short:
      "Three Sekiro-style weapon movesets — Sword Saint, Ashina Style, Divine Blade — with an L1 deflect/reflect mechanic and ported Sekiro VFX.",
    long:
      "A moveset overhaul that grafts three new combat archetypes onto existing katanas and greatswords. Sword Saint Style attaches to a Lightning-affinity Uchigatana, Ashina Style to a Fire/Flame Art Uchigatana, Divine Blade to a Keen Greatsword. All three can also be bought from Merchant Kale.\n\nThe headline feature is the Reflect system: while you're being struck mid-motion, tapping L1 transforms the incoming hit into a counter — a real Sekiro-style perfect parry, not the vanilla guard counter.\n\nThis is a compound mod: regulation.bin (new weapon entries + cooldown params) + chr/c0000.anibnd.dcx (the three movesets + reflect/deflect animations) + parts/wp_* (new weapon models) + sfx (Sekiro particle effects).",
    howToUse:
      "RECOMMENDED PS5 path: download the pre-merged 'Eternal Blades merged with Convergence' optional file from Nexus.\n\n1. Download the merged optional file and import it.\n2. Stage to PS5.\n3. Toggle ON. Daemon mounts regulation.bin + chr/ + parts/ + sfx/ over /app0/.\n4. In-game: Lightning Uchigatana = Sword Saint, Flame Art Uchigatana = Ashina, Keen Greatsword = Divine Blade. Press L1 mid-attack to deflect.\n\nIf you don't use Convergence, the base zip is fine on its own — but it conflicts with any other regulation.bin or c0000.anibnd.dcx mod (only one of those at a time).",
    whatItReplaces: [
      { gamePath: "/app0/regulation.bin", what: "adds new weapon entries + cooldown params" },
      { gamePath: "/app0/chr/c0000.anibnd.dcx", what: "player animations — the 3 movesets + reflect/deflect anims" },
      { gamePath: "/app0/parts/wp_*.partsbnd.dcx", what: "new katana + greatsword models" },
      { gamePath: "/app0/sfx/*.ffxbnd.dcx", what: "ported Sekiro VFX particles" },
    ],
    coverUrl: "https://staticdelivery.nexusmods.com/mods/4333/images/thumbnails/3538/3538-1685338482-1093978563.png",
    endorsements: 361,
    fileSize: "~80 MB",
    tags: ["Sekiro", "Movesets", "Parry"],
    ps5Note:
      "Conflicts with any other regulation.bin OR c0000.anibnd.dcx mod (Convergence, Clever's Moveset, All Weapons Buffable). Use the pre-merged optional file if you want it with Convergence.",
    conflictsWith: ["all-weapons-buffable", "clevers-moveset-modpack"],
    requires: [],
  },
  {
    id: "minecraft-horse-torrent",
    nexusId: "3017",
    url: "https://www.nexusmods.com/eldenring/mods/3017",
    title: "Minecraft Horse Torrent",
    author: "ScrubMilk",
    version: "1.0",
    category: "visuals",
    short:
      "Replaces Torrent's spectral steed with a blocky low-poly Minecraft horse. Stats, controls, and summoning are unchanged — pure visual swap.",
    long:
      "Pure joke mod — your mount Torrent is now a Minecraft horse. The polygonal, low-res brown-and-white Minecraft horse model is dropped over Torrent's character bundle, riding animations work normally, Torrent's vocalizations are unchanged (still ghostly horse noises, not the Minecraft hrf-hrf).\n\nNothing about the mount's stats, double-jump, or summoning changes — Torrent's whistle, the Spectral Steed Whistle, HP, stamina, and his death/revive flow are all stock. The visual is the only thing swapped. Trivially safe.",
    howToUse:
      "1. Download the zip and import it.\n2. Stage to PS5 — single chr/c8000.chrbnd.dcx lands at /data/xeno_mods/CUSA18000/minecraft-horse-torrent/chr/.\n3. Toggle ON. The daemon mounts it over /app0/chr/c8000.chrbnd.dcx.\n4. Whistle for Torrent anywhere in the Lands Between. Enjoy your blocky horse.",
    whatItReplaces: [
      { gamePath: "/app0/chr/c8000.chrbnd.dcx", what: "Torrent (mount) — mesh, skeleton, textures" },
    ],
    coverUrl: "https://staticdelivery.nexusmods.com/mods/4333/images/thumbnails/3017/3017-1676350125-1640901768.png",
    endorsements: 344,
    fileSize: "~3 MB",
    tags: ["Mount", "Joke", "Minecraft"],
    ps5Note: "",
    conflictsWith: ["lansseax-mount"],
    requires: [],
  },
  {
    id: "lansseax-mount",
    nexusId: "2541",
    url: "https://www.nexusmods.com/eldenring/mods/2541",
    title: "Lansseax Mount (ride a dragon)",
    author: "ApolloHoo",
    version: "1.0",
    category: "visuals",
    short:
      "Replaces Torrent with Lansseax — the ancient dragon boss from Caelid. Ride a dragon across the Lands Between.",
    long:
      "ApolloHoo lifts the Lansseax dragon mesh straight out of the Caelid boss room and grafts it onto Torrent's mount slot. The wings, scales, horns, lightning glow, and idle breathing animation all come along. You keep all of Torrent's mount mechanics — double jump, sprint, dismount on hit, summoning via Spectral Steed Whistle — but you're now perched on a full-size ancient dragon.\n\nThe model is significantly larger than Torrent so in tight environments (caves, the Subterranean Shunning-Grounds, indoor sites of grace) the dragon's wings and tail clip through walls. ApolloHoo hasn't scaled it down — for fashion-ride purposes it works best in open Caelid / Limgrave / Atlus.",
    howToUse:
      "1. Download the zip and import it.\n2. Stage to PS5.\n3. Toggle ON. The daemon mounts the dragon over Torrent's character bundle.\n4. Whistle for Torrent — you'll get Lansseax instead. All normal mount controls work.\n5. Avoid tight indoor spaces if clipping bothers you.",
    whatItReplaces: [
      { gamePath: "/app0/chr/c8000.chrbnd.dcx", what: "Torrent (mount) — replaced with Lansseax dragon mesh + skeleton" },
      { gamePath: "/app0/chr/c8000.anibnd.dcx", what: "(may also touch) Torrent idle/flying animations" },
    ],
    coverUrl: "https://staticdelivery.nexusmods.com/mods/4333/images/thumbnails/2541/2541-1668487225-166179506.jpeg",
    endorsements: 387,
    fileSize: "~25 MB",
    tags: ["Mount", "Dragon", "Caelid"],
    ps5Note: "",
    conflictsWith: ["minecraft-horse-torrent"],
    requires: [],
  },
  {
    id: "naruto-six-paths",
    nexusId: "1052",
    url: "https://www.nexusmods.com/eldenring/mods/1052",
    title: "Naruto Six Paths Sage Mode",
    author: "Rena (uploaded by giap211)",
    version: "1.1",
    category: "anime",
    short:
      "Replaces Radahn's armor and the Royal Remains helm with Naruto's Six Paths Sage Mode outfit — black robe, magatama necklace, headband.",
    long:
      "Rena's Six Paths cosmetic ports the Naruto: Ultimate Ninja Storm 4 Six Paths Sage Mode model into Elden Ring as a full armor swap. The body, arms, and legs replace Radahn's set (the giant lion-pelt war armor from the Caelid red sky boss); the helm replaces the Royal Remains Helm — so in-game you walk around as Naruto in his Six Paths cloak, complete with the toad-style hair and the magatama necklace clipping over the collar.\n\nThe zip contains 8 files (bd_m_2010, hd_m_1310, lg_m_2010, am_m_2010 — each with a _l low-LOD variant). All four pieces are male-character armor slots. Pure mesh + texture swap, no stat changes.",
    howToUse:
      "1. Download the zip and import it (you already have it in Downloads).\n2. Stage to PS5 — 8 files land in /data/xeno_mods/CUSA18000/naruto-six-paths/parts/.\n3. Toggle ON. The daemon mounts each over /app0/parts/.\n4. Equip the Radahn set (drops from Starscourge Radahn) + Royal Remains Helm (Roundtable Hold chest after Mohg) on a male character.\n5. You're now Naruto in Six Paths Sage Mode.",
    whatItReplaces: [
      { gamePath: "/app0/parts/bd_m_2010.partsbnd.dcx", what: "Radahn body armor → Naruto Six Paths cloak" },
      { gamePath: "/app0/parts/hd_m_1310.partsbnd.dcx", what: "Royal Remains Helm → Naruto headband + hair" },
      { gamePath: "/app0/parts/am_m_2010.partsbnd.dcx", what: "Radahn gauntlets → Naruto arms" },
      { gamePath: "/app0/parts/lg_m_2010.partsbnd.dcx", what: "Radahn greaves → Naruto legs" },
    ],
    coverUrl: "https://staticdelivery.nexusmods.com/mods/4333/images/thumbnails/1052/1052-1651891495-2052341922.png",
    endorsements: 233,
    fileSize: "57 MB",
    tags: ["Anime", "Naruto", "Armor"],
    ps5Note: "",
    conflictsWith: [],
    requires: [],
  },
  {
    id: "clevers-moveset-modpack",
    nexusId: "1928",
    url: "https://www.nexusmods.com/eldenring/mods/1928",
    title: "Clever's Moveset Modpack (26 movesets)",
    author: "Clever (clevererraptor6)",
    version: "25.0",
    category: "movesets",
    short:
      "26-weapon moveset megapack — Great Shinobi Blade (Owl), Nonosama Bo, Meteor Fists, Sacred Arsenal, Tachikaze, Heaven Splitter, Firebending, and 20 more.",
    long:
      "Clever's flagship work and the biggest standalone moveset pack on the Elden Ring nexus. Version 25.0 bundles 26 separate movesets into one cohesive download — each one a unique weapon with custom animations, custom VFX, and original sound design.\n\nHighlights: Great Shinobi Blade does Owl from Sekiro, Nonosama Bo is a lightning staff with thunder-step combos, Meteor Fists are gravitational martial arts, Sacred Arsenal cycles through sword / spear / shield mid-combo, Bloodstarved Spear is a bleed assassin moveset, Tachikaze does Iai katana draws, Dark Moon Ring is a Spellblade Knight, Heaven Splitter is Genichiro, God's Bane is Blackflame Knight, Hinokami is Firebending Samurai, Deathwalker is Berserking Ghostflame, Vengeance & Glory is Holy Paladin.\n\nAlso ships: Morgott's Holy Armaments, Masterworked Starscourge Greatswords, Storm Demon, Thunderclap & Flash, Frenzied Reaper, Earthbending, Marais Dancing Blade, Lightblades, Voidwalker, Deathborne Odachi, Airbending, Martial Arts, Firebending, Icefrayed Blade, Way of the Wind, God-Slaying Nagamaki, Awakened Dragon Greatclaw.\n\nMajor footprint — touches the player's whole combat layer: regulation.bin (26 weapons + cooldowns), chr/c0000.anibnd.dcx (player animations), chr/c0000.behbnd.dcx (Havok behavior graph), chr/c0000.chrbnd.dcx (player skeleton), action/script/c0000.hks (Havok script), 26 weapon partsbnd + English DLC text + sfx bundles + UI textures.",
    howToUse:
      "1. Download the moveset_modpack zip (~480 MB) and import it.\n2. Stage to PS5 — every file lands at the matching path under /data/xeno_mods/CUSA18000/clevers-moveset-modpack/.\n3. Toggle ON. The daemon mounts the entire bundle as a nullfs overlay on /app0/.\n4. Load any save (or start a new character — Confessor gets Sacred Arsenal, Samurai gets Heaven Splitter).\n5. Visit Merchant Kale at the Church of Elleh or the Twin Maiden Husks at Roundtable Hold to buy the new weapons. Or boot the included new-character starter loadouts.",
    whatItReplaces: [
      { gamePath: "/app0/regulation.bin", what: "26 weapon stat blocks, cooldowns, scaling rewrites" },
      { gamePath: "/app0/chr/c0000.anibnd.dcx", what: "player animations — 26 movesets premerged" },
      { gamePath: "/app0/chr/c0000.behbnd.dcx", what: "player Havok behavior graph (matched to anibnd)" },
      { gamePath: "/app0/chr/c0000.chrbnd.dcx", what: "player character bundle (skeleton + bind)" },
      { gamePath: "/app0/action/script/c0000.hks", what: "player Havok script (TAE-event reactions)" },
      { gamePath: "/app0/parts/wp_a_*.partsbnd.dcx", what: "26 new weapon models" },
      { gamePath: "/app0/msg/engus/*_dlc02.msgbnd.dcx", what: "English text/names for the new weapons" },
      { gamePath: "/app0/sfx/sfxbnd_*.ffxbnd.dcx", what: "VFX particle bundles" },
    ],
    coverUrl: "https://staticdelivery.nexusmods.com/mods/4333/images/thumbnails/1928/1928-1738532669-1280747215.png",
    endorsements: 10837,
    fileSize: "~480 MB",
    tags: ["Movesets", "Sekiro", "Anime", "Modpack"],
    ps5Note:
      "Hard-conflict with any other regulation.bin OR c0000.anibnd.dcx mod (All Weapons Buffable, Eternal Blades, Convergence). Use it as your ONE big combat-overhaul mod.",
    conflictsWith: ["all-weapons-buffable", "eternal-blades"],
    requires: [],
  },
];

export function modById(id: string): CatalogMod | undefined {
  return CATALOG.find((m) => m.id === id);
}
