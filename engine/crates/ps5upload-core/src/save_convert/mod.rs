//! XENO Save Converter — convert game saves between PS5 and PC, both ways.
//!
//! Three layers, smallest responsibility each:
//!
//!   `db`      — the game database. One JSON file per game under `games/`,
//!               embedded at compile time. A profile names the game, says
//!               which file on one platform corresponds to which file on
//!               the other, and names the codec that rewrites the bytes.
//!   `codec`   — the byte-level transforms, in a small registry keyed by
//!               codec id. Codecs are written per save *format* (usually an
//!               engine family), not per game, so one implementation serves
//!               every game that shares the format.
//!   `convert` — the orchestration: find the save inside the folder the
//!               user picked, match files against the profile, run the
//!               codec, and write a brand-new output folder. The input is
//!               never modified and nothing is ever overwritten.
//!
//! "PS5 save" here always means the DECRYPTED contents of a save — the
//! files the game itself sees once its save is mounted. The raw `sdimg_*`
//! images the Saves tab backs up are sealed to the console that wrote them
//! and can't be converted; the user exports the decrypted files with an
//! on-console save manager first.
//!
//! Adding a game: see `docs/save-converter.md`.

pub mod codec;
// A complete, self-contained RE Engine save-format library (container,
// encryption, object stream), with its own unit tests. The Wilds codec uses
// part of its surface; the rest is kept whole and exercised by tests rather
// than trimmed to today's callers.
mod convert;
pub mod db;
mod pattern;
#[allow(dead_code)]
mod re_engine;

pub use convert::{
    convert, inspect, ConvertReport, ConvertRequest, ConvertedFile, InspectReport, InspectRequest,
    MissingFile, PlannedFile,
};
pub use db::{
    find_game, games, Direction, FileMap, GameProfile, NextSteps, OptionKind, OptionSpec, PcInfo,
    Ps5Info, Status,
};
