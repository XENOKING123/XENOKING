//! The object stream inside an RE Engine save file, and how to move it
//! between platforms.
//!
//! A Monster Hunter Wilds save (a "DSSS" file) wraps one block of data: the
//! game's save objects written out one after another. This crate calls that
//! block the *object stream*. It is what is left once the container has been
//! decrypted and inflated, and it is the same on PS5 and PC except for one
//! thing: the padding the game puts in front of values to line them up.
//!
//! That padding is worked out from where a value would sit in the *file*,
//! not from where it sits in the stream. The stream starts 16 bytes into a
//! PC file and 12 bytes into a PS5 file, so the same objects need different
//! padding on each. That start offset is the *base*. Converting a save
//! therefore means reading the stream with one base and writing it out again
//! with the other, which is what [`rebase`] does.
//!
//! # Layout
//!
//! All numbers are little-endian. "Position" always means the offset in the
//! stream plus the base.
//!
//! ```text
//! stream : ( u32 native_field_hash ; Class )*   then fewer than 8 zero bytes
//! Class  : u32 num_fields ; u32 class_hash ; Field * num_fields
//! Field  : u32 name_hash ; i32 type ; Value ; pad to 4
//! Value  : Array  -> Array
//!          Class  -> Class
//!          String -> pad to 4 ; u32 n ; n UTF-16 code units
//!          other  -> pad to 4 ; u32 size ; engine_align(size) ; size bytes
//! Array  : pad to 4 ; i32 member_type ; u32 member_size ; u32 count ; i32 kind
//!          kind 1 (classes): an optional table, u32 0xFFEEFFEE ; u32 * count,
//!                            then count Classes
//!          kind 0 (values):  count elements, each
//!                            String -> pad to 4 ; u32 n ; n UTF-16 code units
//!                            Array  -> engine_align(member_size) ; Array
//!                            other  -> engine_align(member_size) ; member_size bytes
//!          pad to 4
//!
//! engine_align(size): unless size is 1,
//!                     position = (position + size - 1) & !(size - 1)
//! ```
//!
//! `engine_align` rounds up to a multiple of `size` when `size` is a power of
//! two. For other sizes (24-byte structs exist in real saves) it does
//! something less tidy, and the game's result has to be reproduced exactly,
//! so the formula is applied as written.
//!
//! Type codes: -1 array, 1 enum, 2 bool, 3 s8, 4 u8, 5 s16, 6 u16, 7 s32,
//! 8 u32, 9 s64, 10 u64, 11 f32, 12 f64, 13 c8, 14 c16, 15 string,
//! 16 struct, 17 class. 0 means "unknown" and cannot be read.
//!
//! # What is checked
//!
//! Save files come from outside, so nothing in a stream is trusted. Every
//! function here reads the whole stream and fails as a whole if anything in
//! it is off: an unknown type code, a count or size that does not fit in the
//! data that is left, padding that is not zero, a value whose recorded size
//! does not suit its type, nesting deeper than [`MAX_DEPTH`], or anything but
//! a few zero bytes after the last object. A stream that is accepted comes
//! back byte for byte from `rebase(stream, base, base)`.
//!
//! The work is one pass over the input with a small fixed-size stack. No
//! tree of the save is built, and memory use is the input plus the output.
//!
//! # Credits
//!
//! The layout was learned from two open-source projects, whose findings are
//! used here but whose code is not:
//!
//! - ree-save-editor by kvasszn (GPL-3.0) worked out the object stream and
//!   the role of the base.
//! - MandarinJuice by mi5hmash (MIT) ships a decrypted save of another RE
//!   Engine game, which served as a second stream to test against.

mod walk;

use std::collections::BTreeMap;
use std::fmt;

pub use super::hash::name_hash;
pub use walk::MAX_DEPTH;

/// Why a stream was rejected.
///
/// Every offset is a byte offset into the stream that was passed in (the
/// base is not added).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamError {
    /// The data ends before the item that starts at `at` is complete. A
    /// count or size that asks for more data than is left is reported the
    /// same way.
    Truncated { at: usize },
    /// The bytes at `at` cannot be part of a save; `what` says why in plain
    /// words.
    Malformed { at: usize, what: String },
    /// Classes and arrays are nested more than [`MAX_DEPTH`] levels deep.
    TooDeep,
    /// Something other than fewer than 8 zero bytes follows the last object.
    /// `at` is the first byte that should not be there.
    TrailingData { at: usize },
}

impl fmt::Display for StreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StreamError::Truncated { at } => write!(
                f,
                "the save data is incomplete: it ends before the item at byte {at} is finished, \
                 so the file is cut short or damaged"
            ),
            StreamError::Malformed { at, what } => {
                write!(f, "the save data cannot be used: at byte {at}, {what}")
            }
            StreamError::TooDeep => write!(
                f,
                "the save data is damaged: its contents are nested more than {MAX_DEPTH} levels \
                 deep, which no real save is"
            ),
            StreamError::TrailingData { at } => write!(
                f,
                "the save data has extra content after its last entry, starting at byte {at}, \
                 so the file is damaged or is not a save of this kind"
            ),
        }
    }
}

impl std::error::Error for StreamError {}

/// One object at the top of the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TopLevel {
    /// The hash stored in front of the object. It identifies the slot the
    /// object fills, not its type.
    pub native_field_hash: u32,
    /// The hash of the object's type name, see [`name_hash`].
    pub class_hash: u32,
    /// How many fields the object has.
    pub num_fields: u32,
}

/// What a walk over a whole stream found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Summary {
    /// The top-level objects in stream order.
    pub top_level: Vec<TopLevel>,
    /// Fields of classes at every level.
    pub fields: u64,
    /// Strings, both string fields and elements of string arrays.
    pub strings: u64,
    /// Arrays at every level, empty ones included.
    pub arrays: u64,
    /// Zero bytes after the last object (always fewer than 8).
    pub trailing_zero_bytes: usize,
}

/// One String *field* of a class, as seen during a walk. The strings inside
/// string arrays are not reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StringField<'a> {
    /// Hash of the type name of the class the field belongs to.
    pub class_hash: u32,
    /// Hash of the field's name, see [`name_hash`].
    pub name_hash: u32,
    /// How deep the owning class sits: 1 for a top-level object, plus one
    /// for every class or array entered on the way down. A field of a class
    /// that is an element of an array field of a top-level object is at
    /// depth 3.
    pub depth: usize,
    /// The text as raw UTF-16LE bytes, two per code unit, without a
    /// terminator.
    pub units: &'a [u8],
}

/// Walk the whole stream without producing output.
///
/// `Ok` means the stream parses cleanly from the first byte to the last for
/// this base, and holds at least one object. A stream laid out for another
/// base is rejected, which is how the two platforms can be told apart.
pub fn probe(stream: &[u8], base: usize) -> Result<Summary, StreamError> {
    walk::probe(stream, base)
}

/// Re-lay-out the stream for another base.
///
/// The objects are untouched; only the alignment padding is recomputed. For
/// a stream that is accepted, `rebase(s, b, b) == s`, and going to another
/// base and back returns the original bytes.
pub fn rebase(stream: &[u8], from_base: usize, to_base: usize) -> Result<Vec<u8>, StreamError> {
    walk::rebase(stream, from_base, to_base, None)
}

/// As [`rebase`], but `edit` is shown every String field of every class, in
/// stream order, and may return `Some(new UTF-16LE bytes)` to replace that
/// field's value. Returning `None` keeps the value.
///
/// A replacement must hold whole UTF-16 code units, that is an even number
/// of bytes; anything else fails the call with [`StreamError::Malformed`].
/// The padding after the string is recomputed for the new length.
pub fn rebase_with(
    stream: &[u8],
    from_base: usize,
    to_base: usize,
    edit: &mut dyn FnMut(&StringField<'_>) -> Option<Vec<u8>>,
) -> Result<Vec<u8>, StreamError> {
    walk::rebase(stream, from_base, to_base, Some(edit))
}

/// The shape of an array, as its header describes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ArrayShape {
    /// 0 for an array of values, 1 for an array of classes.
    pub kind: i32,
    /// The type code of the elements.
    pub member_type: i32,
    /// The size in bytes the header gives for one element.
    pub member_size: u32,
    /// Whether the array carries the `0xFFEEFFEE` table of per-element
    /// hashes.
    pub hash_table: bool,
}

/// How often an [`ArrayShape`] occurs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ArrayTally {
    /// Arrays of this shape, empty ones included.
    pub arrays: u64,
    /// Elements in all of them together.
    pub elements: u64,
}

/// A closer look at a stream than [`Summary`] gives. Meant for diagnosing a
/// new kind of save and for tests, not for converting.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Survey {
    /// The same counts [`probe`] returns.
    pub summary: Summary,
    /// The deepest nesting reached, counted as in [`StringField::depth`].
    pub max_depth: usize,
    /// Class fields that hold a size-prefixed value, by (type code, size in
    /// bytes).
    pub field_values: BTreeMap<(i32, u32), u64>,
    /// Class fields that hold a string.
    pub string_fields: u64,
    /// Class fields that hold a class.
    pub class_fields: u64,
    /// Every array, by shape.
    pub arrays: BTreeMap<ArrayShape, ArrayTally>,
    /// Alignments to a size that is not a power of two, by (size, bytes of
    /// padding that resulted). These are the cases where the engine's
    /// rounding differs from ordinary alignment.
    pub odd_alignments: BTreeMap<(u32, usize), u64>,
}

/// Walk the whole stream as [`probe`] does and report what it is made of.
pub fn survey(stream: &[u8], base: usize) -> Result<Survey, StreamError> {
    walk::survey(stream, base)
}

/// The name of a type code, or `None` for a number that is not a type code.
pub fn type_name(code: i32) -> Option<&'static str> {
    walk::type_name(code)
}
