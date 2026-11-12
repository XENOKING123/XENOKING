//! One pass over an object stream.
//!
//! A single [`Walker`] does everything this crate offers. It reads the
//! stream item by item at one base and hands every item to a [`Sink`]. The
//! sink either throws the bytes away (probing) or writes them out again
//! with the padding another base calls for (rebasing). Classes and arrays
//! that are still open are kept on a small explicit stack, so the nesting of
//! the input never turns into nesting of function calls.

use super::{ArrayShape, StreamError, StringField, Summary, Survey, TopLevel};

/// The deepest nesting of classes and arrays that is accepted. A top-level
/// object is at depth 1 and every class or array inside it adds one. The
/// Monster Hunter Wilds sample save reaches depth 12.
pub const MAX_DEPTH: usize = 128;

/// In an array of classes, this value in place of the first class announces
/// a table with one hash per element.
const HASH_TABLE_MARKER: u32 = 0xFFEE_FFEE;

/// The type codes of the format.
mod code {
    pub const ARRAY: i32 = -1;
    pub const UNKNOWN: i32 = 0;
    pub const ENUM: i32 = 1;
    pub const BOOL: i32 = 2;
    pub const S8: i32 = 3;
    pub const U8: i32 = 4;
    pub const S16: i32 = 5;
    pub const U16: i32 = 6;
    pub const S32: i32 = 7;
    pub const U32: i32 = 8;
    pub const S64: i32 = 9;
    pub const U64: i32 = 10;
    pub const F32: i32 = 11;
    pub const F64: i32 = 12;
    pub const C8: i32 = 13;
    pub const C16: i32 = 14;
    pub const STRING: i32 = 15;
    pub const STRUCT: i32 = 16;
    pub const CLASS: i32 = 17;
}

/// Array kind: the elements are plain values, strings or arrays.
const KIND_VALUES: i32 = 0;
/// Array kind: the elements are classes.
const KIND_CLASSES: i32 = 1;

/// The fewest bytes a top-level object takes: its hash and an empty class.
const MIN_OBJECT_BYTES: usize = 12;
/// The fewest bytes a class takes: its field count and its hash.
const MIN_CLASS_BYTES: u32 = 8;
/// The fewest bytes a field takes: name hash, type, and the length of an
/// empty string, which is the shortest value there is.
const MIN_FIELD_BYTES: u32 = 12;
/// The fewest bytes an array takes: its header.
const MIN_ARRAY_BYTES: u32 = 16;
/// The fewest bytes a string takes: its length.
const MIN_STRING_BYTES: u32 = 4;

pub fn type_name(code: i32) -> Option<&'static str> {
    Some(match code {
        code::ARRAY => "array",
        code::UNKNOWN => "unknown",
        code::ENUM => "enum",
        code::BOOL => "bool",
        code::S8 => "s8",
        code::U8 => "u8",
        code::S16 => "s16",
        code::U16 => "u16",
        code::S32 => "s32",
        code::U32 => "u32",
        code::S64 => "s64",
        code::U64 => "u64",
        code::F32 => "f32",
        code::F64 => "f64",
        code::C8 => "c8",
        code::C16 => "c16",
        code::STRING => "string",
        code::STRUCT => "struct",
        code::CLASS => "class",
        _ => return None,
    })
}

/// How long a size-prefixed value of some type may be.
enum Width {
    /// Numbers and characters have one possible size.
    Exactly(u32),
    /// An enum is stored as the integer underneath it.
    Enum,
    /// A struct is as long as it says.
    Any,
}

/// The sizes a type allows when it is stored as "size, then that many
/// bytes". `None` for the types that are not stored that way.
fn width_of(type_code: i32) -> Option<Width> {
    Some(match type_code {
        code::ENUM => Width::Enum,
        code::BOOL | code::S8 | code::U8 | code::C8 => Width::Exactly(1),
        code::S16 | code::U16 | code::C16 => Width::Exactly(2),
        code::S32 | code::U32 | code::F32 => Width::Exactly(4),
        code::S64 | code::U64 | code::F64 => Width::Exactly(8),
        code::STRUCT => Width::Any,
        _ => return None,
    })
}

/// Check that a value of `type_code` may be `size` bytes long.
///
/// The format writes a size in front of every plain value, and for
/// everything but structs the type already fixes it. A size that disagrees
/// with the type is a sign of damage, and the reference reader and writer
/// would not agree on such a value either, so it is refused rather than
/// carried along.
fn check_size(type_code: i32, size: u32, at: usize) -> Result<(), StreamError> {
    let name = type_name(type_code).unwrap_or("unknown");
    let what = match width_of(type_code) {
        None => format!("a value of type \"{name}\" is stored where only plain values can be"),
        Some(_) if size == 0 => "a value is recorded as 0 bytes long".to_string(),
        Some(Width::Exactly(width)) if size != width => format!(
            "a value of type \"{name}\" is always {width} bytes long, but this one is recorded \
             as {size}"
        ),
        Some(Width::Enum) if !matches!(size, 1 | 2 | 4 | 8) => {
            format!("an enum value is 1, 2, 4 or 8 bytes long, but this one is recorded as {size}")
        }
        Some(_) => return Ok(()),
    };
    Err(StreamError::Malformed { at, what })
}

/// How many bytes padding to a multiple of 4 skips at `position`.
fn padding_to_4(position: u64) -> usize {
    (position.wrapping_neg() & 3) as usize
}

/// How many bytes the engine's alignment to `size` skips at `position`.
///
/// The engine moves to `(position + size - 1) & !(size - 1)` unless `size`
/// is 1. With `mask = size - 1` that is `position + mask` with the mask bits
/// cleared, so the distance moved is `mask - ((position + mask) & mask)`.
/// Written this way only the low 32 bits of the position take part, so no
/// base and no stream length can overflow the sum.
///
/// A `size` of 0 has no meaning in the formula; callers refuse it first.
fn engine_padding(position: u64, size: u32) -> usize {
    if size <= 1 {
        return 0;
    }
    let mask = u64::from(size - 1);
    (mask - (position.wrapping_add(mask) & mask)) as usize
}

/// The stream being read.
struct Source<'a> {
    data: &'a [u8],
    /// Offset of the next unread byte; never beyond `data.len()`.
    pos: usize,
    base: u64,
}

impl<'a> Source<'a> {
    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    /// Where the next byte would sit in the file: offset plus base.
    fn position(&self) -> u64 {
        self.base.wrapping_add(self.pos as u64)
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], StreamError> {
        let truncated = StreamError::Truncated { at: self.pos };
        let Some(end) = self.pos.checked_add(count) else {
            return Err(truncated);
        };
        let Some(bytes) = self.data.get(self.pos..end) else {
            return Err(truncated);
        };
        self.pos = end;
        Ok(bytes)
    }

    fn u32(&mut self) -> Result<u32, StreamError> {
        let at = self.pos;
        let bytes = self.take(4)?;
        <[u8; 4]>::try_from(bytes)
            .map(u32::from_le_bytes)
            .map_err(|_| StreamError::Truncated { at })
    }

    /// The next four bytes as a number, without consuming them.
    fn peek_u32(&self) -> Option<u32> {
        let bytes = self.data.get(self.pos..self.pos.checked_add(4)?)?;
        <[u8; 4]>::try_from(bytes).ok().map(u32::from_le_bytes)
    }

    /// Whether at least `count` more bytes follow and all of them are zero.
    fn zeros_ahead(&self, count: usize) -> bool {
        self.pos
            .checked_add(count)
            .and_then(|end| self.data.get(self.pos..end))
            .is_some_and(|bytes| bytes.iter().all(|&byte| byte == 0))
    }

    /// Skip `count` bytes of alignment padding, which must be there.
    ///
    /// Their content is not checked: the game does not clear the gap when
    /// it lines a value up, so real saves carry leftover bytes in it (seen
    /// in game-written system and photo saves on both PC and PS5). Nothing
    /// reads them back, and a rebase writes fresh zero padding.
    fn skip_padding(&mut self, count: usize) -> Result<(), StreamError> {
        self.take(count).map(|_| ())
    }

    /// Fail unless `count` items of at least `each` bytes can still follow.
    /// `at` is where the item that makes the claim starts.
    ///
    /// This runs before anything is looped over or reserved on the strength
    /// of a count, so a made-up count costs nothing: every item that is then
    /// read uses up input, and the whole walk stays linear in the input.
    fn need(&self, count: u32, each: u32, at: usize) -> Result<(), StreamError> {
        if u64::from(count) * u64::from(each) > self.remaining() as u64 {
            return Err(StreamError::Truncated { at });
        }
        Ok(())
    }
}

/// Where the walker sends what it reads. `at` arguments are offsets in the
/// source, used only to say where a problem was noticed.
trait Sink {
    fn bytes(&mut self, bytes: &[u8]);
    fn align4(&mut self, at: usize) -> Result<(), StreamError>;
    fn engine_align(&mut self, size: u32, at: usize) -> Result<(), StreamError>;
}

/// A sink for walks that only check the stream.
struct NoOutput;

impl Sink for NoOutput {
    fn bytes(&mut self, _bytes: &[u8]) {}

    fn align4(&mut self, _at: usize) -> Result<(), StreamError> {
        Ok(())
    }

    fn engine_align(&mut self, _size: u32, _at: usize) -> Result<(), StreamError> {
        Ok(())
    }
}

/// A sink that writes the stream out again for another base.
struct Layout {
    out: Vec<u8>,
    base: u64,
    /// How many more bytes of padding may be written.
    ///
    /// Padding is the only thing that can make the output longer than the
    /// input. In front of a value it is always shorter than the value
    /// itself, which the input must contain, so in total it stays below the
    /// input length. The one exception is an array of arrays: its elements
    /// are aligned to a size the header names freely, with nothing of that
    /// size behind it, so a few bytes of forged input could ask for
    /// gigabytes of padding. This budget of twice the input length is far
    /// above anything a real stream needs (the two layouts of a real save
    /// differ by a few bytes) and stops that.
    padding_left: u64,
}

impl Layout {
    fn new(source_len: usize, base: usize) -> Self {
        Layout {
            out: Vec::with_capacity(source_len.saturating_add(64)),
            base: base as u64,
            padding_left: (source_len as u64).saturating_mul(2).saturating_add(64),
        }
    }

    fn position(&self) -> u64 {
        self.base.wrapping_add(self.out.len() as u64)
    }

    fn pad(&mut self, count: usize, at: usize) -> Result<(), StreamError> {
        let new_len = match self.out.len().checked_add(count) {
            Some(new_len) if count as u64 <= self.padding_left => new_len,
            _ => {
                return Err(StreamError::Malformed {
                    at,
                    what: "lining this value up for the other platform would take more filler \
                           bytes than the whole save is long"
                        .to_string(),
                })
            }
        };
        self.padding_left -= count as u64;
        self.out.resize(new_len, 0);
        Ok(())
    }
}

impl Sink for Layout {
    fn bytes(&mut self, bytes: &[u8]) {
        self.out.extend_from_slice(bytes);
    }

    fn align4(&mut self, at: usize) -> Result<(), StreamError> {
        self.pad(padding_to_4(self.position()), at)
    }

    fn engine_align(&mut self, size: u32, at: usize) -> Result<(), StreamError> {
        self.pad(engine_padding(self.position(), size), at)
    }
}

/// Hooks for collecting statistics during a walk. The default does nothing
/// and costs nothing.
trait Observer {
    fn value_field(&mut self, _type_code: i32, _size: u32) {}
    fn string_field(&mut self) {}
    fn class_field(&mut self) {}
    fn array(&mut self, _shape: ArrayShape, _count: u32) {}
    fn engine_aligned(&mut self, _size: u32, _padding: usize) {}
}

struct Unobserved;

impl Observer for Unobserved {}

impl Observer for Survey {
    fn value_field(&mut self, type_code: i32, size: u32) {
        *self.field_values.entry((type_code, size)).or_default() += 1;
    }

    fn string_field(&mut self) {
        self.string_fields += 1;
    }

    fn class_field(&mut self) {
        self.class_fields += 1;
    }

    fn array(&mut self, shape: ArrayShape, count: u32) {
        let tally = self.arrays.entry(shape).or_default();
        tally.arrays += 1;
        tally.elements += u64::from(count);
    }

    fn engine_aligned(&mut self, size: u32, padding: usize) {
        if !size.is_power_of_two() {
            *self.odd_alignments.entry((size, padding)).or_default() += 1;
        }
    }
}

/// A class or array that has been entered and not yet left.
#[derive(Clone, Copy)]
enum Frame {
    /// A class with this many fields still to come.
    Class { fields_left: u32, class_hash: u32 },
    /// An array of classes with this many still to come.
    ClassArray { left: u32 },
    /// An array of arrays with this many still to come. Each one is first
    /// aligned to `align`, the element size the outer array's header names.
    ArrayArray { left: u32, align: u32 },
    /// An array of plain values or strings. Nothing can nest inside those,
    /// so the elements are dealt with as soon as the header is read and
    /// only the end of the array is left to do.
    FlatArray,
}

/// What to do next, decided by the innermost open class or array.
enum Step {
    Field { class_hash: u32 },
    ClassElement,
    ArrayElement { align: u32 },
    Close,
}

/// The callback of [`super::rebase_with`].
type Edit<'e> = &'e mut dyn FnMut(&StringField<'_>) -> Option<Vec<u8>>;

struct Walker<'a, 'e, S, O> {
    src: Source<'a>,
    sink: S,
    observer: O,
    edit: Option<Edit<'e>>,
    stack: Vec<Frame>,
    summary: Summary,
    max_depth: usize,
}

pub fn probe(stream: &[u8], base: usize) -> Result<Summary, StreamError> {
    let mut walker = Walker::new(stream, base, NoOutput, Unobserved, None);
    walker.run()?;
    Ok(walker.summary)
}

pub fn survey(stream: &[u8], base: usize) -> Result<Survey, StreamError> {
    let mut walker = Walker::new(stream, base, NoOutput, Survey::default(), None);
    walker.run()?;
    let mut survey = walker.observer;
    survey.summary = walker.summary;
    survey.max_depth = walker.max_depth;
    Ok(survey)
}

pub fn rebase(
    stream: &[u8],
    from_base: usize,
    to_base: usize,
    edit: Option<Edit<'_>>,
) -> Result<Vec<u8>, StreamError> {
    let layout = Layout::new(stream.len(), to_base);
    let mut walker = Walker::new(stream, from_base, layout, Unobserved, edit);
    walker.run()?;
    Ok(walker.sink.out)
}

impl<'a, 'e, S: Sink, O: Observer> Walker<'a, 'e, S, O> {
    fn new(stream: &'a [u8], base: usize, sink: S, observer: O, edit: Option<Edit<'e>>) -> Self {
        Walker {
            src: Source {
                data: stream,
                pos: 0,
                base: base as u64,
            },
            sink,
            observer,
            edit,
            stack: Vec::with_capacity(MAX_DEPTH),
            summary: Summary::default(),
            max_depth: 0,
        }
    }

    /// Walk the whole stream: objects until fewer than 8 bytes are left,
    /// then nothing but zeros.
    fn run(&mut self) -> Result<(), StreamError> {
        loop {
            // Twelve zero bytes would read as an object with no hash, no
            // class and no fields. That says nothing, so it is taken for
            // what it almost certainly is: filler, which may not be that
            // long.
            if self.src.zeros_ahead(MIN_OBJECT_BYTES) {
                let at = self.src.pos;
                return Err(if at == 0 {
                    StreamError::Malformed {
                        at,
                        what: "the data starts with zeros where the first save entry should be"
                            .to_string(),
                    }
                } else {
                    StreamError::TrailingData { at }
                });
            }
            let native_field_hash = self.copy_u32()?;
            let (num_fields, class_hash) = self.open_class()?;
            self.summary.top_level.push(TopLevel {
                native_field_hash,
                class_hash,
                num_fields,
            });
            self.finish_open()?;

            // The game stops looking for objects once fewer than 8 bytes
            // are left. An object takes at least 12, so 8 to 11 left-over
            // bytes cannot be one either.
            let left = self.src.remaining();
            if left < 8 {
                break;
            }
            if left < MIN_OBJECT_BYTES {
                return Err(StreamError::TrailingData { at: self.src.pos });
            }
        }

        let at = self.src.pos;
        let rest = self.src.take(self.src.remaining())?;
        if let Some(offset) = rest.iter().position(|&byte| byte != 0) {
            return Err(StreamError::TrailingData { at: at + offset });
        }
        self.summary.trailing_zero_bytes = rest.len();
        self.sink.bytes(rest);
        Ok(())
    }

    /// Work through everything that is open until nothing is.
    fn finish_open(&mut self) -> Result<(), StreamError> {
        loop {
            let step = match self.stack.last_mut() {
                None => return Ok(()),
                Some(Frame::Class {
                    fields_left,
                    class_hash,
                }) if *fields_left > 0 => {
                    *fields_left -= 1;
                    Step::Field {
                        class_hash: *class_hash,
                    }
                }
                Some(Frame::ClassArray { left }) if *left > 0 => {
                    *left -= 1;
                    Step::ClassElement
                }
                Some(Frame::ArrayArray { left, align }) if *left > 0 => {
                    *left -= 1;
                    Step::ArrayElement { align: *align }
                }
                Some(_) => Step::Close,
            };
            match step {
                Step::Field { class_hash } => self.field(class_hash)?,
                Step::ClassElement => {
                    self.open_class()?;
                }
                Step::ArrayElement { align } => {
                    self.engine_align(align)?;
                    self.open_array()?;
                }
                Step::Close => self.close()?,
            }
        }
    }

    /// Enter a class or array.
    fn push(&mut self, frame: Frame) -> Result<(), StreamError> {
        if self.stack.len() >= MAX_DEPTH {
            return Err(StreamError::TooDeep);
        }
        self.stack.push(frame);
        self.max_depth = self.max_depth.max(self.stack.len());
        Ok(())
    }

    /// Leave the innermost class or array.
    fn close(&mut self) -> Result<(), StreamError> {
        // Every array ends on a multiple of 4.
        if !matches!(self.stack.pop(), Some(Frame::Class { .. }) | None) {
            self.align4()?;
        }
        // If what was just left was the value of a field, the field ends on
        // a multiple of 4 as well. Elements of arrays and top-level objects
        // get nothing after them.
        if matches!(self.stack.last(), Some(Frame::Class { .. })) {
            self.align4()?;
        }
        Ok(())
    }

    /// `u32 num_fields ; u32 class_hash`, then the fields, which follow once
    /// the class is on the stack.
    fn open_class(&mut self) -> Result<(u32, u32), StreamError> {
        let at = self.src.pos;
        let num_fields = self.copy_u32()?;
        let class_hash = self.copy_u32()?;
        self.src.need(num_fields, MIN_FIELD_BYTES, at)?;
        self.push(Frame::Class {
            fields_left: num_fields,
            class_hash,
        })?;
        Ok((num_fields, class_hash))
    }

    /// `u32 name_hash ; i32 type ; value ; pad to 4`.
    fn field(&mut self, class_hash: u32) -> Result<(), StreamError> {
        self.summary.fields += 1;
        let name_hash = self.copy_u32()?;
        let type_at = self.src.pos;
        let type_code = self.copy_i32()?;
        match type_code {
            // For these two the closing pad to 4 happens when the array or
            // class is left, see `close`.
            code::ARRAY => self.open_array(),
            code::CLASS => {
                self.observer.class_field();
                self.open_class().map(|_| ())
            }
            code::STRING => {
                self.observer.string_field();
                self.string(Some((class_hash, name_hash)))?;
                self.align4()
            }
            _ if width_of(type_code).is_some() => {
                self.align4()?;
                let size_at = self.src.pos;
                let size = self.copy_u32()?;
                check_size(type_code, size, size_at)?;
                self.observer.value_field(type_code, size);
                self.engine_align(size)?;
                self.copy(size as usize)?;
                self.align4()
            }
            code::UNKNOWN => Err(StreamError::Malformed {
                at: type_at,
                what: "a field has the type \"unknown\" (0), which cannot be read".to_string(),
            }),
            _ => Err(StreamError::Malformed {
                at: type_at,
                what: format!(
                    "a field has type number {type_code}, which this save format does not use"
                ),
            }),
        }
    }

    /// `pad to 4 ; u32 n ; n UTF-16 code units`. `field` is the class hash
    /// and name hash when the string is the value of a field.
    fn string(&mut self, field: Option<(u32, u32)>) -> Result<(), StreamError> {
        self.summary.strings += 1;
        self.align4()?;
        let at = self.src.pos;
        let units = self.src.u32()?;
        self.src.need(units, 2, at)?;
        let text = self.src.take(units as usize * 2)?;

        let replacement = match (field, self.edit.as_mut()) {
            (Some((class_hash, name_hash)), Some(edit)) => edit(&StringField {
                class_hash,
                name_hash,
                depth: self.stack.len(),
                units: text,
            }),
            _ => None,
        };
        let Some(replacement) = replacement else {
            self.sink.bytes(&units.to_le_bytes());
            self.sink.bytes(text);
            return Ok(());
        };

        if replacement.len() & 1 != 0 {
            return Err(StreamError::Malformed {
                at,
                what: format!(
                    "the new text for a string field is {} bytes long, which is not a whole \
                     number of UTF-16 characters",
                    replacement.len()
                ),
            });
        }
        let Ok(units) = u32::try_from(replacement.len() / 2) else {
            return Err(StreamError::Malformed {
                at,
                what: "the new text for a string field is too long to be stored".to_string(),
            });
        };
        self.sink.bytes(&units.to_le_bytes());
        self.sink.bytes(&replacement);
        Ok(())
    }

    /// `pad to 4 ; i32 member_type ; u32 member_size ; u32 count ; i32 kind`,
    /// then the elements and a closing pad to 4. Elements that can hold
    /// classes or arrays follow once the array is on the stack; the others
    /// are read here.
    fn open_array(&mut self) -> Result<(), StreamError> {
        self.summary.arrays += 1;
        self.align4()?;
        let at = self.src.pos;
        let member_type = self.copy_i32()?;
        let member_size = self.copy_u32()?;
        let count = self.copy_u32()?;
        let kind = self.copy_i32()?;
        if type_name(member_type).is_none() {
            return Err(StreamError::Malformed {
                at,
                what: format!(
                    "an array has element type number {member_type}, which this save format \
                     does not use"
                ),
            });
        }

        let mut hash_table = false;
        let frame = match kind {
            KIND_CLASSES => {
                if self.src.peek_u32() == Some(HASH_TABLE_MARKER) {
                    hash_table = true;
                    self.copy_u32()?;
                    self.src.need(count, 4, at)?;
                    self.copy(count as usize * 4)?;
                }
                self.src.need(count, MIN_CLASS_BYTES, at)?;
                Frame::ClassArray { left: count }
            }
            KIND_VALUES if member_type == code::ARRAY => {
                if count > 0 && member_size == 0 {
                    return Err(StreamError::Malformed {
                        at,
                        what: "an array of arrays gives 0 as the size to line its elements up to"
                            .to_string(),
                    });
                }
                self.src.need(count, MIN_ARRAY_BYTES, at)?;
                Frame::ArrayArray {
                    left: count,
                    align: member_size,
                }
            }
            KIND_VALUES => Frame::FlatArray,
            _ => {
                return Err(StreamError::Malformed {
                    at,
                    what: format!(
                        "an array has kind {kind}, but only 0 (values) and 1 (classes) exist"
                    ),
                })
            }
        };
        self.observer.array(
            ArrayShape {
                kind,
                member_type,
                member_size,
                hash_table,
            },
            count,
        );
        self.push(frame)?;
        if matches!(frame, Frame::FlatArray) {
            self.flat_elements(member_type, member_size, count, at)?;
        }
        Ok(())
    }

    /// The elements of an array of strings or of plain values.
    fn flat_elements(
        &mut self,
        member_type: i32,
        member_size: u32,
        count: u32,
        at: usize,
    ) -> Result<(), StreamError> {
        if count == 0 {
            // Nothing is read, so whatever the header says about the
            // elements is never acted on.
            return Ok(());
        }
        if member_type == code::STRING {
            self.src.need(count, MIN_STRING_BYTES, at)?;
            for _ in 0..count {
                self.string(None)?;
            }
            return Ok(());
        }

        check_size(member_type, member_size, at)?;
        self.src.need(count, member_size, at)?;
        if member_size.is_power_of_two() {
            // Once the first element is lined up, every later one already
            // is, so the elements sit back to back.
            self.engine_align(member_size)?;
            self.copy(count as usize * member_size as usize)?;
        } else {
            for _ in 0..count {
                self.engine_align(member_size)?;
                self.copy(member_size as usize)?;
            }
        }
        Ok(())
    }

    fn copy(&mut self, count: usize) -> Result<(), StreamError> {
        let bytes = self.src.take(count)?;
        self.sink.bytes(bytes);
        Ok(())
    }

    fn copy_u32(&mut self) -> Result<u32, StreamError> {
        let value = self.src.u32()?;
        self.sink.bytes(&value.to_le_bytes());
        Ok(value)
    }

    fn copy_i32(&mut self) -> Result<i32, StreamError> {
        self.copy_u32().map(|value| value as i32)
    }

    /// Pad to a multiple of 4 on both sides.
    fn align4(&mut self) -> Result<(), StreamError> {
        let at = self.src.pos;
        self.src.skip_padding(padding_to_4(self.src.position()))?;
        self.sink.align4(at)
    }

    /// Apply the engine's alignment to `size` on both sides.
    fn engine_align(&mut self, size: u32) -> Result<(), StreamError> {
        let at = self.src.pos;
        let padding = engine_padding(self.src.position(), size);
        self.observer.engine_aligned(size, padding);
        self.src.skip_padding(padding)?;
        self.sink.engine_align(size, at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The engine's formula, written out the long way with room to spare.
    fn engine_align_reference(position: u64, size: u32) -> u64 {
        if size == 1 {
            return 0;
        }
        let position = u128::from(position);
        let size = u128::from(size);
        (((position + size - 1) & !(size - 1)) - position) as u64
    }

    #[test]
    fn engine_padding_matches_the_formula() {
        let sizes = [
            1u32,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            12,
            16,
            24,
            32,
            40,
            48,
            64,
            100,
            1000,
            4096,
            0x7FFF_FFCD,
            0x8000_0000,
            u32::MAX,
        ];
        let positions = (0u64..600)
            .chain([0xFFFF_FFF0, 0x1_0000_0003, 0x7FFF_FFFF_FFFF_FFF9])
            .chain((0..64).map(|shift| 1u64 << shift));
        for position in positions {
            for size in sizes {
                assert_eq!(
                    engine_padding(position, size) as u64,
                    engine_align_reference(position, size),
                    "position {position:#x}, size {size}"
                );
            }
        }
    }

    #[test]
    fn engine_padding_is_ordinary_alignment_for_powers_of_two() {
        for shift in 0..12 {
            let size = 1u32 << shift;
            for position in 0u64..5000 {
                let padding = engine_padding(position, size) as u64;
                assert!(padding < u64::from(size));
                assert_eq!((position + padding) % u64::from(size), 0);
            }
        }
    }

    /// Hand-checked values for a size that is not a power of two. 24 is
    /// binary 11000 and 23 is binary 10111, so the formula clears bits 0, 1,
    /// 2 and 4 of `position + 23`: it lands on a multiple of 8 whose bit 4
    /// is clear, which can be up to 20 bytes on.
    #[test]
    fn engine_padding_for_24_byte_values() {
        let expected = [
            (0u64, 0usize),
            (4, 4),
            (8, 0),
            (12, 20),
            (16, 16),
            (20, 20),
            (24, 16),
            (28, 4),
            (32, 0),
            (36, 4),
            (40, 0),
            (44, 20),
        ];
        for (position, padding) in expected {
            assert_eq!(engine_padding(position, 24), padding, "position {position}");
        }
    }

    #[test]
    fn padding_to_4_rounds_up() {
        assert_eq!(padding_to_4(0), 0);
        assert_eq!(padding_to_4(1), 3);
        assert_eq!(padding_to_4(2), 2);
        assert_eq!(padding_to_4(3), 1);
        assert_eq!(padding_to_4(4), 0);
        assert_eq!(padding_to_4(u64::MAX), 1);
    }

    #[test]
    fn every_type_code_has_a_name_and_a_size_rule() {
        for type_code in -1..=17 {
            assert!(type_name(type_code).is_some(), "type {type_code}");
            let sized = width_of(type_code).is_some();
            let unsized_codes = [code::ARRAY, code::UNKNOWN, code::STRING, code::CLASS];
            assert_eq!(
                sized,
                !unsized_codes.contains(&type_code),
                "type {type_code}"
            );
        }
        assert!(type_name(-2).is_none());
        assert!(type_name(18).is_none());
        assert!(width_of(18).is_none());
    }
}
