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
use std::borrow::Cow;
use std::fmt;

/// First lone-surrogate escape (DESIGN §44): U+D800 + k is stored as `ESC_BASE + k`.
pub const ESC_BASE: u32 = 0x10F800;

/// The escape of surrogate unit `u` (U+D800..U+DFFF).
#[inline]
pub fn escape_unit(u: u16) -> char {
    // SAFETY-free: ESC_BASE + (u - 0xD800) is in U+10F800..U+10FFFF, valid scalar values.
    char::from_u32(ESC_BASE + (u as u32 - 0xD800)).unwrap_or('\u{FFFD}')
}

/// The surrogate unit `c` escapes, if it is an escape.
#[inline]
pub fn unescape(c: char) -> Option<u16> {
    let c = c as u32;
    (c >= ESC_BASE).then(|| (c - ESC_BASE + 0xD800) as u16)
}

/// UTF-16 width of `c` in DOM terms (an escape is one unit).
#[inline]
fn width16(c: char) -> u32 {
    if (c as u32) >= ESC_BASE { 1 } else { c.len_utf16() as u32 }
}

/// UTF-16 code units -> UTF-8 with lone surrogates escaped (string ingress, DESIGN §44).
pub fn from_utf16_escaped(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() * 3);
    for r in char::decode_utf16(units.iter().copied()) {
        out.push(match r {
            Ok(c) => c,
            Err(e) => escape_unit(e.unpaired_surrogate()),
        });
    }
    out
}

/// CSS Syntax "preprocess the input stream" for lone surrogates: CSS sees U+FFFD where the DOM string holds a
/// lone surrogate's escape (DESIGN §44). Borrows unless there is one.
pub fn css_input(s: &str) -> Cow<'_, str> {
    if !has_escape(s) {
        return Cow::Borrowed(s);
    }
    Cow::Owned(s.chars().map(|c| if (c as u32) >= ESC_BASE { '\u{FFFD}' } else { c }).collect())
}

/// True if `s` holds a lone surrogate's escape.
#[inline]
pub fn has_escape(s: &str) -> bool {
    memchr::memchr(0xF4, s.as_bytes()).is_some() && count_escapes(s.as_bytes()) != 0
}

/// Number of escapes in `b` (bytes `F4 8F A0..BF xx`).
fn count_escapes(b: &[u8]) -> usize {
    let mut n = 0;
    let mut i = 0;
    while let Some(k) = memchr::memchr(0xF4, &b[i..]) {
        let j = i + k;
        if j + 2 < b.len() && b[j + 1] == 0x8F && b[j + 2] >= 0xA0 {
            n += 1;
        }
        i = j + 1;
    }
    n
}

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
/// UTF-16 units = non-continuation bytes + one extra unit per 4-byte sequence (surrogate pair), minus one
/// per lone-surrogate escape (one unit, DESIGN §44). Latin-1 holds iff every lead byte is ASCII, 0xC2 or 0xC3.
#[inline]
pub fn scan(s: &str) -> (u32, bool, bool) {
    let b = s.as_bytes();
    if b.is_ascii() {
        return (b.len() as u32, true, true);
    }
    // u8 accumulators over 255-byte chunks: LLVM vectorizes this (~0.15 ns/byte; a usize-accumulator loop
    // or `encode_utf16().count()` measured 0.8-2 ns/byte).
    let (mut units, mut astral, mut wide, mut f4) = (0usize, 0usize, 0usize, 0usize);
    for chunk in b.chunks(255) {
        let (mut u, mut a, mut w, mut f) = (0u8, 0u8, 0u8, 0u8);
        for &x in chunk {
            u += ((x as i8) >= -64) as u8; // not a continuation byte (0x80..=0xBF)
            a += (x >= 0xF0) as u8; // 4-byte lead: one extra unit (surrogate pair)
            w += (x >= 0xC4) as u8; // lead byte of a code point above U+00FF
            f += (x == 0xF4) as u8; // lead byte of plane 16, where the escapes are
        }
        units += u as usize;
        astral += a as usize;
        wide += w as usize;
        f4 += f as usize;
    }
    let esc = if f4 == 0 { 0 } else { count_escapes(b) };
    ((units + astral - esc) as u32, false, wide == 0)
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
    /// rounds down to the start of that code point; the editing methods split the pair first.
    pub fn byte_offset(&self, off16: u32) -> usize {
        utf16_to_byte(self.as_str(), self.ascii, off16)
    }

    /// Replaces UTF-16 range `[off16, off16 + count16)` with `data` (clamped like DOM `replaceData`), in
    /// place: no copy of the untouched parts beyond what the splice itself moves, and the cached flags are
    /// maintained from the edited range only (a full rescan only when a non-ASCII range was removed).
    /// The caller has already checked `off16 <= utf16_len`.
    pub fn replace_range16(&mut self, off16: u32, count16: u32, data: &str) {
        let end16 = off16.saturating_add(count16).min(self.utf16_len);
        let (mut start, in_s) = locate16(&self.s, self.ascii, off16);
        let (mut end, in_e) = locate16(&self.s, self.ascii, end16);
        if in_s || in_e {
            self.split_pair_at(off16);
            self.split_pair_at(end16);
            start = self.byte_offset(off16);
            end = self.byte_offset(end16);
        }
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
        if !self.ascii {
            self.join_escapes_at(start + data.len());
            self.join_escapes_at(start);
        }
    }

    /// Substring by UTF-16 range (clamped). A bound inside a surrogate pair cuts the pair, leaving the
    /// half inside the range as its escape (owned only then).
    pub fn substring16(&self, off16: u32, count16: u32) -> Cow<'_, str> {
        let end16 = off16.saturating_add(count16).min(self.utf16_len);
        let (start, in_s) = locate16(&self.s, self.ascii, off16);
        let (end, in_e) = locate16(&self.s, self.ascii, end16);
        if !in_s && !in_e {
            return Cow::Borrowed(&self.s[start..end]);
        }
        let mut t = self.clone();
        t.split_pair_at(off16);
        t.split_pair_at(end16);
        let start = t.byte_offset(off16);
        let end = t.byte_offset(end16);
        Cow::Owned(t.s[start..end].to_owned())
    }

    /// Appends `data`.
    pub fn push_str(&mut self, data: &str) {
        let (n16, ascii, latin1) = scan(data);
        let at = self.s.len();
        self.s.push_str(data);
        self.ascii &= ascii;
        self.latin1 &= latin1;
        self.utf16_len += n16;
        if !self.ascii {
            self.join_escapes_at(at);
        }
    }

    /// True if UTF-16 offset `off16` falls between the two units of a surrogate pair.
    fn inside_pair(&self, off16: u32) -> bool {
        locate16(&self.s, self.ascii, off16).1
    }

    /// Splits the surrogate pair `off16` falls inside of (if any) into its two escapes (DESIGN §44).
    fn split_pair_at(&mut self, off16: u32) {
        if !self.inside_pair(off16) {
            return;
        }
        let i = self.byte_offset(off16);
        let c = self.s[i..].chars().next().unwrap_or('\0');
        let mut units = [0u16; 2];
        c.encode_utf16(&mut units);
        let mut esc = String::with_capacity(8);
        esc.push(escape_unit(units[0]));
        esc.push(escape_unit(units[1]));
        self.s.replace_range(i..i + c.len_utf8(), &esc);
    }

    /// Joins an escaped high surrogate ending at byte `at` with an escaped low one starting there into the
    /// code point they encode (what JS concatenation produces). Lengths and flags are unchanged.
    fn join_escapes_at(&mut self, at: usize) {
        if at < 4 || at + 4 > self.s.len() || !self.s.is_char_boundary(at) {
            return;
        }
        let hi = self.s[..at].chars().next_back().and_then(unescape);
        let lo = self.s[at..].chars().next().and_then(unescape);
        if let (Some(h @ 0xD800..=0xDBFF), Some(l @ 0xDC00..=0xDFFF)) = (hi, lo) {
            let c = char::decode_utf16([h, l]).next().and_then(Result::ok).unwrap_or('\u{FFFD}');
            let mut b = [0u8; 4];
            self.s.replace_range(at - 4..at + 4, c.encode_utf8(&mut b));
        }
    }
}

/// Byte offset of a UTF-16 offset within `s` (clamped).
pub fn utf16_to_byte(s: &str, ascii: bool, off16: u32) -> usize {
    locate16(s, ascii, off16).0
}

/// [`utf16_to_byte`] plus whether `off16` falls between the two units of a surrogate pair, in one walk.
fn locate16(s: &str, ascii: bool, off16: u32) -> (usize, bool) {
    if ascii {
        return ((off16 as usize).min(s.len()), false);
    }
    let mut units = 0u32;
    for (i, ch) in s.char_indices() {
        let w = width16(ch);
        if units + w > off16 {
            return (i, units != off16);
        }
        units += w;
    }
    (s.len(), false)
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
    fn lone_surrogates_round_trip_as_escapes() {
        let units: Vec<u16> = vec![0x61, 0xD83D, 0x62, 0xDE00];
        let s = Str::from(from_utf16_escaped(&units).as_str());
        assert_eq!(s.utf16_len(), 4);
        assert_eq!(s.byte_offset(2), 5);
        // deleting the high half of a pair leaves the low half as an escape
        let mut t = Str::from("a😀b");
        t.replace_range16(1, 1, "");
        assert_eq!(t.utf16_len(), 3);
        assert_eq!(t.as_str().chars().nth(1).and_then(unescape), Some(0xDE00));
        // inserting the high half back joins them into the code point
        t.replace_range16(1, 0, &escape_unit(0xD83D).to_string());
        assert_eq!(t.as_str(), "a😀b");
        assert_eq!(t.utf16_len(), 4);
        // a substring cut inside a pair
        let u = Str::from("a😀b");
        assert_eq!(u.substring16(0, 2).chars().nth(1).and_then(unescape), Some(0xD83D));
        let (n16, _, _) = scan(&format!("x{}y", escape_unit(0xDC00)));
        assert_eq!(n16, 3);
    }

    #[test]
    fn push() {
        let mut s = Str::from("ab");
        s.push_str("é");
        assert_eq!(s.utf16_len(), 3);
        assert!(!s.is_ascii());
    }
}
