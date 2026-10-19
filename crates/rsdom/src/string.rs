//! DOM string storage: UTF-8 with a cached ASCII flag and UTF-16 length (DESIGN §2.3).
//!
//! html5ever, cssparser and selectors all need UTF-8, so strings are stored as UTF-8. DOM offsets are
//! UTF-16 code units; for ASCII strings they equal byte offsets, otherwise they are converted with a
//! linear walk. Known divergences (CONTRIBUTING.md §8): lone surrogates become U+FFFD (V8's UTF-8
//! conversion does this), and a UTF-16 offset inside a surrogate pair rounds down to the start of the code
//! point, so CharacterData edits at such offsets act on the whole code point.
//!
//! Each `Str` caches its UTF-16 length and ASCII / Latin-1 flags (one vectorized `scan`), which drive offset
//! conversion and the egress encoding (src/ffi.rs `js_string`).

use compact_str::CompactString;
use std::fmt;

/// An immutable-ish DOM string: inline up to 24 bytes (no allocation for typical attribute values).
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Str {
    s: CompactString,
    utf16_len: u32,
    /// every byte is ASCII
    ascii: bool,
    /// every code point is <= U+00FF (egress as a one-byte latin1 string)
    latin1: bool,
}

/// `(utf16_len, ascii, latin1)` of `s` in one vectorizable pass.
///
/// UTF-16 units = non-continuation bytes + one extra unit per 4-byte sequence (surrogate pair). Latin-1
/// holds iff every lead byte is ASCII, 0xC2 or 0xC3.
#[inline]
pub fn scan(s: &str) -> (u32, bool, bool) {
    let b = s.as_bytes();
    if b.is_ascii() {
        return (b.len() as u32, true, true);
    }
    // u8 accumulators over 255-byte chunks: LLVM vectorizes this (~0.15 ns/byte; a usize-accumulator loop
    // or `encode_utf16().count()` measured 0.8-2 ns/byte).
    let (mut units, mut astral, mut wide) = (0usize, 0usize, 0usize);
    for chunk in b.chunks(255) {
        let (mut u, mut a, mut w) = (0u8, 0u8, 0u8);
        for &x in chunk {
            u += ((x as i8) >= -64) as u8; // not a continuation byte (0x80..=0xBF)
            a += (x >= 0xF0) as u8; // 4-byte lead: one extra unit (surrogate pair)
            w += (x >= 0xC4) as u8; // lead byte of a code point above U+00FF
        }
        units += u as usize;
        astral += a as usize;
        wide += w as usize;
    }
    ((units + astral) as u32, false, wide == 0)
}

/// UTF-16 length of `s` (see [`scan`]).
#[inline]
pub fn utf16_len(s: &str) -> u32 {
    scan(s).0
}

impl Str {
    /// The empty string.
    pub const fn new() -> Self {
        Str { s: CompactString::const_new(""), utf16_len: 0, ascii: true, latin1: true }
    }

    /// Copies `s`.
    #[inline]
    pub fn copy_of(s: &str) -> Self {
        let (utf16_len, ascii, latin1) = scan(s);
        Str { s: CompactString::new(s), utf16_len, ascii, latin1 }
    }

    /// Takes ownership of `s` (no copy when it is heap-allocated).
    pub fn from_string(s: String) -> Self {
        let (utf16_len, ascii, latin1) = scan(&s);
        Str { s: CompactString::from(s), utf16_len, ascii, latin1 }
    }

    /// The UTF-8 contents.
    #[inline(always)]
    pub fn as_str(&self) -> &str {
        self.s.as_str()
    }

    /// True if every byte is ASCII (UTF-16 offsets == byte offsets; latin1 egress).
    #[inline(always)]
    pub fn is_ascii(&self) -> bool {
        self.ascii
    }

    /// True if every code point is <= U+00FF (one-byte JS string on egress).
    #[inline(always)]
    pub fn is_latin1(&self) -> bool {
        self.latin1
    }

    /// Length in UTF-16 code units (`CharacterData.length`).
    #[inline(always)]
    pub fn utf16_len(&self) -> u32 {
        self.utf16_len
    }

    /// Length in bytes.
    #[inline(always)]
    pub fn len(&self) -> usize {
        self.s.len()
    }

    /// True if empty.
    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.s.is_empty()
    }

    /// Byte offset of UTF-16 offset `off16` (clamped to the length). An offset inside a surrogate pair
    /// rounds down to the start of that code point (see the module docs: documented divergence).
    pub fn byte_offset(&self, off16: u32) -> usize {
        utf16_to_byte(self.as_str(), self.ascii, off16)
    }

    /// Replaces UTF-16 range `[off16, off16 + count16)` with `data` (clamped like DOM `replaceData`), in
    /// place: no copy of the untouched parts beyond what the splice itself moves, and the cached flags are
    /// maintained from the edited range only (a full rescan only when a non-ASCII range was removed).
    /// The caller has already checked `off16 <= utf16_len`.
    pub fn replace_range16(&mut self, off16: u32, count16: u32, data: &str) {
        let start = self.byte_offset(off16);
        let end = self.byte_offset(off16.saturating_add(count16).min(self.utf16_len));
        let (rm16, rm_ascii, rm_latin1) = scan(&self.s[start..end]);
        let (add16, add_ascii, add_latin1) = scan(data);
        if end == self.s.len() && start == end {
            self.s.push_str(data);
        } else {
            self.s.replace_range(start..end, data);
        }
        self.utf16_len = self.utf16_len - rm16 + add16;
        if (self.ascii || rm_ascii) && (self.latin1 || rm_latin1) {
            // Nothing that could clear a flag was removed: flags only get narrower with `data`.
            self.ascii &= add_ascii;
            self.latin1 &= add_latin1;
        } else {
            let (_, ascii, latin1) = scan(&self.s);
            self.ascii = ascii;
            self.latin1 = latin1;
        }
    }

    /// Substring by UTF-16 range (clamped).
    pub fn substring16(&self, off16: u32, count16: u32) -> &str {
        let start = self.byte_offset(off16);
        let end = self.byte_offset(off16.saturating_add(count16).min(self.utf16_len));
        &self.s[start..end]
    }

    /// Appends `data`.
    pub fn push_str(&mut self, data: &str) {
        let (n16, ascii, latin1) = scan(data);
        self.s.push_str(data);
        self.ascii &= ascii;
        self.latin1 &= latin1;
        self.utf16_len += n16;
    }
}

/// Byte offset of a UTF-16 offset within `s` (clamped).
pub fn utf16_to_byte(s: &str, ascii: bool, off16: u32) -> usize {
    if ascii {
        return (off16 as usize).min(s.len());
    }
    let mut units = 0u32;
    for (i, ch) in s.char_indices() {
        let w = ch.len_utf16() as u32;
        if units + w > off16 {
            return i;
        }
        units += w;
    }
    s.len()
}

impl From<&str> for Str {
    fn from(s: &str) -> Self {
        Str::copy_of(s)
    }
}

impl fmt::Debug for Str {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self.as_str(), f)
    }
}

impl std::ops::Deref for Str {
    type Target = str;
    fn deref(&self) -> &str {
        self.as_str()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets() {
        let s = Str::from("a😀b");
        assert_eq!(s.utf16_len(), 4);
        assert!(!s.is_ascii());
        assert_eq!(s.byte_offset(1), 1);
        assert_eq!(s.byte_offset(3), 5);
        assert_eq!(s.byte_offset(2), 1, "inside a surrogate pair rounds down");
        assert_eq!(s.substring16(1, 2), "😀");
        let mut t = s.clone();
        t.replace_range16(1, 2, "xy");
        assert_eq!(t.as_str(), "axyb");
        assert!(t.is_ascii());
        assert_eq!(t.utf16_len(), 4);
    }

    #[test]
    fn scan_counts_and_flags() {
        for s in ["", "abc", "é", "Grüße ÿ", "a😀b", "日本", "\u{7F}\u{80}\u{FF}\u{100}", &"ü".repeat(600)]
        {
            let (n16, ascii, latin1) = scan(s);
            assert_eq!(n16 as usize, s.encode_utf16().count(), "{s:?}");
            assert_eq!(ascii, s.is_ascii(), "{s:?}");
            assert_eq!(latin1, s.chars().all(|c| (c as u32) <= 0xFF), "{s:?}");
        }
    }

    #[test]
    fn replace_range_keeps_flags_exact() {
        let check = |s: &Str| {
            let (n16, ascii, latin1) = scan(s.as_str());
            assert_eq!((s.utf16_len(), s.is_ascii(), s.is_latin1()), (n16, ascii, latin1), "{s:?}");
        };
        let mut s = Str::from("abc");
        s.replace_range16(3, 0, "é");
        check(&s);
        s.replace_range16(3, 1, "");
        check(&s); // non-ASCII removed: flags recomputed
        assert!(s.is_ascii());
        s.replace_range16(1, 0, "日");
        check(&s);
        s.replace_range16(0, 99, "ÿ");
        check(&s);
        assert!(s.is_latin1() && !s.is_ascii());
        s.replace_range16(1, 0, "😀x");
        check(&s);
        assert_eq!(s.as_str(), "ÿ😀x");
    }

    #[test]
    fn push() {
        let mut s = Str::from("ab");
        s.push_str("é");
        assert_eq!(s.utf16_len(), 3);
        assert!(!s.is_ascii());
    }
}
