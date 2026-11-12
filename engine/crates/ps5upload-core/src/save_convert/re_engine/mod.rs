//! Reading and writing Monster Hunter Wilds (and other RE Engine) save files,
//! and moving a save between PS5 and PC.
//!
//! A Wilds save file ("DSSS") is an object stream — the game's save data —
//! inside a container. On PC the container is per-account encrypted
//! ("Mandarin") and compressed; on PS5 it is only compressed. The object
//! stream is the same on both platforms apart from the padding that lines
//! values up, which is computed from each value's position in the *file*, so
//! it differs by the container's header size.
//!
//! Converting a save is therefore: open the container on one side, lay the
//! object stream out again for the other side's header size, and close the
//! container on that side.
//!
//! * [`container`] — the file container: header, compression, checksum.
//! * [`mandarin`] — the per-account PC encryption, and finding the account a
//!   save belongs to.
//! * [`stream`] — walking and re-laying-out the object stream.
//! * [`hash`] — MurmurHash3 and CityHash64, shared by the above.
//!
//! The format was learned from two open-source projects whose findings are
//! reused here but whose code is not: ree-save-editor by kvasszn (GPL-3.0) and
//! MandarinJuice by mi5hmash (MIT).

pub mod container;
pub mod error;
pub mod hash;
pub mod mandarin;
pub mod stream;
pub mod wilds;

#[cfg(test)]
mod expected;

// Facade for the whole format library; the Wilds codec uses a subset.
#[allow(unused_imports)]
pub use container::{
    decode, encode, peek_flags, stream_base, Decoded, FLAG_DEFLATE, FLAG_MANDARIN,
};
pub use error::DsssError;
pub use mandarin::MandarinKey;
pub(crate) use wilds::ReEngineDsss;
