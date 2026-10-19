//! Input types, value modes, value sanitization and the HTML microsyntaxes they need (floating-point
//! numbers, dates, times, weeks, months, e-mail addresses). Pure functions over `&str`; behaviour follows
//! jsdom 30 (`helpers/form-controls.js` `sanitizeValueByType`, `helpers/dates-and-times.js`,
//! `helpers/number-and-date-inputs.js`), which is the oracle of the contract tests.

use std::borrow::Cow;

/// Normalized `<input type>` (stored in `NodeRec.state` bits 8-12; `TEXT = 0` so a fresh input needs no
/// initialisation). The order is part of the JS contract (`INPUT_TYPES` in packages/rsdom/lib/forms.cjs).
pub mod ty {
    /// text (also every unknown / missing type)
    pub const TEXT: u32 = 0;
    /// hidden
    pub const HIDDEN: u32 = 1;
    /// search
    pub const SEARCH: u32 = 2;
    /// tel
    pub const TEL: u32 = 3;
    /// url
    pub const URL: u32 = 4;
    /// email
    pub const EMAIL: u32 = 5;
    /// password
    pub const PASSWORD: u32 = 6;
    /// date
    pub const DATE: u32 = 7;
    /// month
    pub const MONTH: u32 = 8;
    /// week
    pub const WEEK: u32 = 9;
    /// time
    pub const TIME: u32 = 10;
    /// datetime-local
    pub const DATETIME_LOCAL: u32 = 11;
    /// number
    pub const NUMBER: u32 = 12;
    /// range
    pub const RANGE: u32 = 13;
    /// color
    pub const COLOR: u32 = 14;
    /// checkbox
    pub const CHECKBOX: u32 = 15;
    /// radio
    pub const RADIO: u32 = 16;
    /// file
    pub const FILE: u32 = 17;
    /// submit
    pub const SUBMIT: u32 = 18;
    /// image
    pub const IMAGE: u32 = 19;
    /// reset
    pub const RESET: u32 = 20;
    /// button
    pub const BUTTON: u32 = 21;
}

/// Type names indexed by the `ty` code.
pub const TYPE_NAMES: [&str; 22] = [
    "text",
    "hidden",
    "search",
    "tel",
    "url",
    "email",
    "password",
    "date",
    "month",
    "week",
    "time",
    "datetime-local",
    "number",
    "range",
    "color",
    "checkbox",
    "radio",
    "file",
    "submit",
    "image",
    "reset",
    "button",
];

/// `getTypeFromAttribute`: ASCII case-insensitive match against the allowed types; anything else is text.
pub fn parse_type(attr: Option<&str>) -> u32 {
    let Some(v) = attr else { return ty::TEXT };
    if v.len() > 14 {
        return ty::TEXT;
    }
    TYPE_NAMES.iter().position(|n| n.eq_ignore_ascii_case(v)).map_or(ty::TEXT, |i| i as u32)
}

/// Value mode of a type (HTML "value attribute mode").
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// value: the raw value + dirty flag
    Value,
    /// default: the `value` attribute ("" if absent)
    Default,
    /// default/on: the `value` attribute ("on" if absent)
    DefaultOn,
    /// filename
    Filename,
}

/// Value mode of input type `t`.
pub fn mode(t: u32) -> Mode {
    match t {
        ty::HIDDEN | ty::SUBMIT | ty::IMAGE | ty::RESET | ty::BUTTON => Mode::Default,
        ty::CHECKBOX | ty::RADIO => Mode::DefaultOn,
        ty::FILE => Mode::Filename,
        _ => Mode::Value,
    }
}

/// Types whose selection API applies (selectionStart/End/Direction, setSelectionRange, setRangeText).
pub fn has_selection(t: u32) -> bool {
    matches!(t, ty::TEXT | ty::SEARCH | ty::URL | ty::TEL | ty::PASSWORD)
}

/// Types for which `select()` applies.
pub fn select_applies(t: u32) -> bool {
    matches!(
        t,
        ty::TEXT
            | ty::SEARCH
            | ty::URL
            | ty::TEL
            | ty::EMAIL
            | ty::PASSWORD
            | ty::DATE
            | ty::MONTH
            | ty::WEEK
            | ty::TIME
            | ty::DATETIME_LOCAL
            | ty::NUMBER
            | ty::COLOR
            | ty::FILE
    )
}

/// Types with a numeric value (valueAsNumber, min/max/step).
pub fn is_numeric(t: u32) -> bool {
    matches!(t, ty::DATE | ty::MONTH | ty::WEEK | ty::TIME | ty::DATETIME_LOCAL | ty::NUMBER | ty::RANGE)
}

/// Types for which maxlength/minlength/pattern/size apply.
pub fn length_pattern_applies(t: u32) -> bool {
    matches!(t, ty::TEXT | ty::SEARCH | ty::URL | ty::TEL | ty::EMAIL | ty::PASSWORD)
}

/// Types for which `readonly` applies.
pub fn readonly_applies(t: u32) -> bool {
    length_pattern_applies(t)
        || matches!(t, ty::DATE | ty::MONTH | ty::WEEK | ty::TIME | ty::DATETIME_LOCAL | ty::NUMBER)
}

/// Types for which `required` applies.
pub fn required_applies(t: u32) -> bool {
    readonly_applies(t) || matches!(t, ty::CHECKBOX | ty::RADIO | ty::FILE)
}

// ------------------------------------------------------------------------------- string helpers

/// ASCII whitespace (infra).
#[inline]
pub fn is_ascii_ws(b: u8) -> bool {
    matches!(b, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

/// Strip leading and trailing ASCII whitespace.
pub fn trim_ascii_ws(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_ascii() && is_ascii_ws(c as u8))
}

/// Strip and collapse ASCII whitespace (`option.text`).
pub fn strip_and_collapse(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for w in s.split(|c: char| c.is_ascii() && is_ascii_ws(c as u8)).filter(|w| !w.is_empty()) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(w);
    }
    out
}

/// Removes every `\n` and `\r`.
fn strip_newlines(s: &str) -> Cow<'_, str> {
    if s.bytes().any(|b| b == b'\n' || b == b'\r') {
        Cow::Owned(s.chars().filter(|&c| c != '\n' && c != '\r').collect())
    } else {
        Cow::Borrowed(s)
    }
}

/// Infra "split on commas" (tokens trimmed of ASCII whitespace).
pub fn split_on_commas(s: &str) -> impl Iterator<Item = &str> {
    s.split(',').map(trim_ascii_ws)
}

// ------------------------------------------------------------------------- numbers and dates

/// HTML "valid floating-point number": `-?(\d+|\d*\.\d+)([eE][-+]?\d+)?`.
pub fn is_valid_float(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    if b.first() == Some(&b'-') {
        i = 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == f {
            return false;
        }
    } else if int_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e {
            return false;
        }
    }
    i == b.len()
}

/// `parseFloatingPointNumber` as jsdom implements it (`parseFloat` after ASCII-only leading whitespace;
/// non-finite results are errors). Only used on strings that already passed [`is_valid_float`] or on
/// attribute values (min/max/step), where `parseFloat`'s prefix semantics matter.
pub fn parse_float(s: &str) -> Option<f64> {
    let t = s.trim_start_matches(|c: char| c.is_ascii() && is_ascii_ws(c as u8));
    if t.starts_with(char::is_whitespace) {
        return None; // non-ASCII leading whitespace: parseFloat would skip it, the HTML rules do not
    }
    // Longest prefix that is a JS StrDecimalLiteral (parseFloat semantics).
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    if t[i..].starts_with("Infinity") {
        return None;
    }
    let ds = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i - ds;
    if i < b.len() && b[i] == b'.' {
        let save = i;
        i += 1;
        let fs = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        digits += i - fs;
        if i == fs && digits == 0 {
            i = save;
        }
    }
    if digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let save = i;
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let es = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == es {
            i = save;
        }
    }
    let v: f64 = t[..i].trim_end_matches('.').parse().ok()?;
    if v.is_finite() { Some(if v == 0.0 { 0.0 } else { v }) } else { None }
}

/// JS `Number#toString` for the values the forms code produces (integers and short decimals).
pub fn fmt_number(v: f64) -> String {
    if v == v.trunc() && v.abs() < 1e21 { format!("{}", v as i64) } else { format!("{v}") }
}

fn digits(s: &str, min: usize, max: usize) -> Option<u32> {
    if s.len() < min || s.len() > max || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn is_leap(y: i64) -> bool {
    y % 400 == 0 || (y % 4 == 0 && y % 100 != 0)
}

fn days_in_month(m: u32, y: i64) -> u32 {
    const D: [u32; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if m == 2 && is_leap(y) { 29 } else { D[(m - 1) as usize] }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Weekday (0 = Sunday) of a civil date.
fn weekday(y: i64, m: u32, d: u32) -> i64 {
    (days_from_civil(y, m, d) + 4).rem_euclid(7)
}

const DAY_MS: f64 = 86_400_000.0;

/// `YYYY-MM` (year >= 1).
pub fn parse_month(s: &str) -> Option<(i64, u32)> {
    let (y, m) = s.rsplit_once('-')?;
    let year = digits(y, 4, 9)? as i64;
    let month = digits(m, 2, 2)?;
    (year > 0 && (1..=12).contains(&month)).then_some((year, month))
}

/// `YYYY-MM-DD`.
pub fn parse_date(s: &str) -> Option<(i64, u32, u32)> {
    let (ym, d) = s.rsplit_once('-')?;
    let (y, m) = parse_month(ym)?;
    let day = digits(d, 2, 2)?;
    (day >= 1 && day <= days_in_month(m, y)).then_some((y, m, day))
}

/// `HH:MM[:SS[.s{1,3}]]` -> milliseconds since midnight.
pub fn parse_time(s: &str) -> Option<u32> {
    let b = s.as_bytes();
    if b.len() < 5 || b[2] != b':' {
        return None;
    }
    // `get`: user strings may hold non-ASCII bytes inside the fixed-width fields ("00:0é").
    let h = digits(s.get(0..2)?, 2, 2)?;
    let mi = digits(s.get(3..5)?, 2, 2)?;
    if h > 23 || mi > 59 {
        return None;
    }
    let mut ms = (h * 60 + mi) * 60_000;
    if b.len() > 5 {
        if b[5] != b':' {
            return None;
        }
        let rest = s.get(6..)?;
        let (sec, frac) = match rest.split_once('.') {
            Some((a, f)) => (a, Some(f)),
            None => (rest, None),
        };
        let sec = digits(sec, 2, 2)?;
        if sec > 59 {
            return None;
        }
        ms += sec * 1000;
        if let Some(f) = frac {
            let v = digits(f, 1, 3)?;
            ms += v * 10u32.pow(3 - f.len() as u32);
        }
    }
    Some(ms)
}

fn weeks_in_year(y: i64) -> u32 {
    let jan1 = weekday(y, 1, 1);
    if jan1 == 4 || (is_leap(y) && jan1 == 3) { 53 } else { 52 }
}

/// `YYYY-Www`.
pub fn parse_week(s: &str) -> Option<(i64, u32)> {
    let (y, w) = s.split_once("-W")?;
    let year = digits(y, 4, 5)? as i64;
    let week = digits(w, 2, 2)?;
    (year > 0 && week >= 1 && week <= weeks_in_year(year)).then_some((year, week))
}

/// Local date and time (`T` or, unless `normalized`, a space separator).
pub fn parse_datetime(s: &str) -> Option<((i64, u32, u32), u32)> {
    let i = s.find('T').or_else(|| s.find(' '))?;
    Some((parse_date(&s[..i])?, parse_time(&s[i + 1..])?))
}

fn pad(v: i64, w: usize) -> String {
    format!("{v:0w$}")
}

/// Serializes a time of day in ms (shortest form, as jsdom's `serializeTime`).
pub fn serialize_time(ms: u32) -> String {
    let (h, mi, sec, milli) = (ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000);
    let mut s = format!("{h:02}:{mi:02}");
    if sec != 0 || milli != 0 {
        s.push_str(&format!(":{sec:02}"));
        if milli != 0 {
            let f = format!("{milli:03}");
            s.push('.');
            s.push_str(f.trim_end_matches('0'));
        }
    }
    s
}

/// Value as a number for numeric types (`convertStringToNumberByType`).
pub fn to_number(t: u32, v: &str) -> Option<f64> {
    match t {
        // jsdom converts with parseFloatingPointNumber (prefix semantics), also for min/max attributes.
        ty::NUMBER | ty::RANGE => parse_float(v),
        ty::DATE => parse_date(v).map(|(y, m, d)| days_from_civil(y, m, d) as f64 * DAY_MS),
        ty::MONTH => parse_month(v).map(|(y, m)| ((y - 1970) * 12 + (m as i64 - 1)) as f64),
        ty::WEEK => parse_week(v).map(|(y, w)| {
            let jan1 = days_from_civil(y, 1, 1);
            let rel_monday = [-1i64, 0, 1, 2, 3, -3, -2][weekday(y, 1, 1) as usize];
            (jan1 + 7 * (w as i64 - 1) - rel_monday) as f64 * DAY_MS
        }),
        ty::TIME => parse_time(v).map(f64::from),
        ty::DATETIME_LOCAL => {
            parse_datetime(v).map(|((y, m, d), ms)| days_from_civil(y, m, d) as f64 * DAY_MS + ms as f64)
        }
        _ => None,
    }
}

/// Default minimum / maximum (range only).
pub fn default_min_max(t: u32) -> (Option<f64>, Option<f64>) {
    if t == ty::RANGE { (Some(0.0), Some(100.0)) } else { (None, None) }
}

/// Step scale factor and default step (`[stepScaleFactor, defaultStep]`).
pub fn step_scale(t: u32) -> (f64, f64) {
    match t {
        ty::WEEK => (7.0 * DAY_MS, 1.0),
        ty::DATE => (DAY_MS, 1.0),
        ty::DATETIME_LOCAL | ty::TIME => (1000.0, 60.0),
        _ => (1.0, 1.0),
    }
}

// ------------------------------------------------------------------------------------ e-mail

fn is_local_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+/=?^_`{|}~.-".contains(&b)
}

fn is_valid_label(l: &[u8]) -> bool {
    !l.is_empty()
        && l.len() <= 63
        && l[0].is_ascii_alphanumeric()
        && l[l.len() - 1].is_ascii_alphanumeric()
        && l.iter().all(|&b| b.is_ascii_alphanumeric() || b == b'-')
}

/// HTML "valid e-mail address" (the spec's regular expression, hand-matched).
pub fn is_valid_email(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else { return false };
    !local.is_empty()
        && local.bytes().all(is_local_char)
        && !domain.is_empty()
        && domain.split('.').all(|l| is_valid_label(l.as_bytes()))
}

/// Valid e-mail address list (`multiple`).
pub fn is_valid_email_list(s: &str) -> bool {
    split_on_commas(s).all(is_valid_email)
}

// ------------------------------------------------------------------------------- sanitization

/// Context for range sanitization (min/max attributes).
pub struct RangeBounds {
    /// minimum (default 0)
    pub min: f64,
    /// maximum (default 100)
    pub max: f64,
}

/// Strip newlines, then leading and trailing ASCII whitespace (borrowing when nothing changes).
fn strip_newlines_and_trim(v: &str) -> Cow<'_, str> {
    match strip_newlines(v) {
        Cow::Borrowed(b) => Cow::Borrowed(trim_ascii_ws(b)),
        Cow::Owned(o) => Cow::Owned(trim_ascii_ws(&o).to_string()),
    }
}

/// HTML value sanitization algorithm for input type `t` (`multiple` = email `multiple` attribute).
/// Borrows `v` when it is already sanitized (the common case: no allocation).
pub fn sanitize<'a>(t: u32, v: &'a str, multiple: bool, bounds: Option<&RangeBounds>) -> Cow<'a, str> {
    let keep_if = |ok: bool| if ok { Cow::Borrowed(v) } else { Cow::Borrowed("") };
    match t {
        ty::TEXT | ty::SEARCH | ty::TEL | ty::PASSWORD => strip_newlines(v),
        ty::URL => strip_newlines_and_trim(v),
        ty::EMAIL => {
            if multiple {
                Cow::Owned(v.split(',').map(trim_ascii_ws).collect::<Vec<_>>().join(","))
            } else {
                strip_newlines_and_trim(v)
            }
        }
        ty::COLOR => {
            let b = v.as_bytes();
            if b.len() == 7 && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit) {
                if b.iter().any(u8::is_ascii_uppercase) {
                    Cow::Owned(v.to_ascii_lowercase())
                } else {
                    Cow::Borrowed(v)
                }
            } else {
                Cow::Borrowed("#000000")
            }
        }
        ty::DATE => keep_if(parse_date(v).is_some()),
        ty::MONTH => keep_if(parse_month(v).is_some()),
        ty::WEEK => keep_if(parse_week(v).is_some()),
        ty::TIME => keep_if(parse_time(v).is_some()),
        ty::DATETIME_LOCAL => match parse_datetime(v) {
            Some(((y, m, d), ms)) => Cow::Owned(format!(
                "{}-{}-{}T{}",
                pad(y, 4),
                pad(m as i64, 2),
                pad(d as i64, 2),
                serialize_time(ms)
            )),
            None => Cow::Borrowed(""),
        },
        ty::NUMBER => keep_if(is_valid_float(v) && parse_float(v).is_some()),
        ty::RANGE => {
            let (min, max) = bounds.map_or((0.0, 100.0), |b| (b.min, b.max));
            match parse_float(v).filter(|_| is_valid_float(v)) {
                None => Cow::Owned(fmt_number(if max < min { min } else { (min + max) / 2.0 })),
                Some(x) if x < min => Cow::Owned(fmt_number(min)),
                Some(x) if x > max => Cow::Owned(fmt_number(max)),
                Some(_) => Cow::Borrowed(v),
            }
        }
        _ => Cow::Borrowed(v),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types() {
        assert_eq!(parse_type(None), ty::TEXT);
        assert_eq!(parse_type(Some("CheckBox")), ty::CHECKBOX);
        assert_eq!(parse_type(Some("datetime-local")), ty::DATETIME_LOCAL);
        assert_eq!(parse_type(Some("bogus")), ty::TEXT);
        assert_eq!(TYPE_NAMES[ty::BUTTON as usize], "button");
        assert_eq!(mode(ty::RADIO), Mode::DefaultOn);
        assert_eq!(mode(ty::HIDDEN), Mode::Default);
        assert_eq!(mode(ty::FILE), Mode::Filename);
        assert_eq!(mode(ty::EMAIL), Mode::Value);
    }

    #[test]
    fn floats() {
        for ok in ["1", "-1", ".5", "1.5", "1e5", "1E-5", "0", "-0.0"] {
            assert!(is_valid_float(ok), "{ok}");
        }
        for bad in ["", "-", "1.", "+1", "abc", "1e", "1.5.5", " 1", "0x10"] {
            assert!(!is_valid_float(bad), "{bad}");
        }
        assert_eq!(parse_float(" 12px"), Some(12.0));
        assert_eq!(parse_float("abc"), None);
        assert_eq!(parse_float("1e999"), None);
        assert_eq!(parse_float("5."), Some(5.0));
        assert_eq!(fmt_number(50.0), "50");
        assert_eq!(fmt_number(12.5), "12.5");
    }

    #[test]
    fn dates() {
        assert!(parse_date("2024-02-29").is_some());
        assert!(parse_date("2023-02-29").is_none());
        assert!(parse_date("0000-01-01").is_none());
        assert!(parse_month("2024-13").is_none());
        assert_eq!(parse_time("12:34"), Some((12 * 60 + 34) * 60_000));
        assert_eq!(parse_time("12:34:56.7"), Some(((12 * 60 + 34) * 60 + 56) * 1000 + 700));
        assert!(parse_time("24:00").is_none());
        assert!(parse_week("2020-W53").is_some());
        assert!(parse_week("2021-W53").is_none());
        assert_eq!(to_number(ty::DATE, "1970-01-02"), Some(DAY_MS));
        assert_eq!(to_number(ty::MONTH, "1971-02"), Some(13.0));
        // 1970-W01 starts on Monday 1969-12-29
        assert_eq!(to_number(ty::WEEK, "1970-W01"), Some(-3.0 * DAY_MS));
        assert_eq!(sanitize(ty::DATETIME_LOCAL, "2020-01-01 10:00:00", false, None), "2020-01-01T10:00");
        assert_eq!(
            sanitize(ty::DATETIME_LOCAL, "2020-01-01T10:00:01.500", false, None),
            "2020-01-01T10:00:01.5"
        );
    }

    #[test]
    fn sanitization() {
        assert_eq!(sanitize(ty::TEXT, "a\nb\rc", false, None), "abc");
        assert_eq!(sanitize(ty::NUMBER, "abc", false, None), "");
        assert_eq!(sanitize(ty::NUMBER, "1.5", false, None), "1.5");
        assert_eq!(sanitize(ty::EMAIL, "  a@b.c \n", false, None), "a@b.c");
        assert_eq!(sanitize(ty::EMAIL, " a@b , c@d ", true, None), "a@b,c@d");
        assert_eq!(sanitize(ty::COLOR, "#ABCDEF", false, None), "#abcdef");
        assert_eq!(sanitize(ty::COLOR, "red", false, None), "#000000");
        assert_eq!(sanitize(ty::RANGE, "", false, None), "50");
        assert_eq!(sanitize(ty::RANGE, "500", false, None), "100");
        assert_eq!(sanitize(ty::HIDDEN, "a\nb", false, None), "a\nb");
    }

    #[test]
    fn email() {
        assert!(is_valid_email("a@b.c"));
        assert!(is_valid_email("a.b+c@example-host.com"));
        assert!(!is_valid_email("bad"));
        assert!(!is_valid_email("a@-b.c"));
        assert!(!is_valid_email("a@b..c"));
        assert!(is_valid_email_list("a@b.c, d@e.f"));
        assert_eq!(strip_and_collapse("  a \n b  "), "a b");
    }
}
