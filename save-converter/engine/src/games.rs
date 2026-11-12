//! The game database. One entry per supported game; the goal is to grow this
//! to many games over time. Each entry holds only data — the constants that
//! describe how that game seals its PC saves and which fields carry a
//! per-account online identity.

/// A supported game.
pub struct Game {
    /// Stable slug, also what the UI passes back.
    pub id: &'static str,
    /// Display name.
    pub name: &'static str,
    /// Steam app id, shown to the player.
    pub steam_app_id: u32,
    /// PS5 title ids this covers (for display / help).
    pub ps5_title_ids: &'static [&'static str],
    /// The files a save of this game is made of.
    pub files: &'static [SaveFile],
    /// Per-game seed for the Mandarin block-size generator.
    pub enc_seed: u64,
    /// Per-game seed for the Mandarin encrypted trailer.
    pub rsa_seed: u64,
    /// Names of the string fields that hold a per-account online identity. On a
    /// transfer between accounts each is reset so the game issues a new one.
    pub reset_identity_fields: &'static [&'static str],
}

/// One file within a game's save.
pub struct SaveFile {
    /// The file name, the same on PS5 and PC.
    pub name: &'static str,
    /// What it holds, shown to the player.
    pub label: &'static str,
    /// Whether a conversion needs it (a missing optional file is fine).
    pub required: bool,
}

/// Every supported game.
pub static GAMES: &[Game] = &[Game {
    id: "monster-hunter-wilds",
    name: "Monster Hunter Wilds",
    steam_app_id: 2246340,
    ps5_title_ids: &["PPSA07862", "PPSA24191"],
    files: &[
        SaveFile {
            name: "data001Slot.bin",
            label: "Character data (your hunters)",
            required: true,
        },
        SaveFile {
            name: "data00-1.bin",
            label: "System data (settings)",
            required: false,
        },
    ],
    enc_seed: 0x7A36_9552_5526_6CED,
    rsa_seed: 0xBFAC_F76C_3F96,
    reset_identity_fields: &["HunterId", "HunterShortId"],
}];

/// Look a game up by its id.
pub fn by_id(id: &str) -> Option<&'static Game> {
    GAMES.iter().find(|game| game.id == id)
}
