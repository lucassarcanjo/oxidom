//! Random-string robustness test (M9 review): the parsers that take user strings (form value
//! microsyntaxes, CSS values, media lists, selectors) and `:lang()` matching must never panic, whatever
//! the input. Non-ASCII characters are deliberately mixed into fixed-width fields ("00:0é") where byte
//! slicing used to hit a char boundary.
//!
//! `FUZZ_ITERS` overrides the default iteration count (20_000 per test; ~1 s in a debug build).

use oxidom::Env;
use oxidom::atoms::atom;
use oxidom::forms::types;
use oxidom::style::{cascade, sheet, value};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, k: usize) -> usize {
        (self.next() % k as u64) as usize
    }
}

const TOKENS: &[&str] = &[
    "0",
    "1",
    "9",
    "00",
    "12",
    "99999",
    "275760",
    "-",
    "+",
    ":",
    ".",
    ",",
    "/",
    "(",
    ")",
    "e",
    "E",
    "W",
    "T",
    " ",
    "\t",
    "\n",
    "\r",
    "é",
    "😀",
    "ﬀ",
    "\u{0}",
    "#",
    "@",
    "%",
    "px",
    "deg",
    "calc(",
    "rgb(",
    "hsl(",
    "var(",
    "url(",
    "\"",
    "'",
    "\\",
    "!",
    ";",
    "{",
    "}",
    "[",
    "]",
    "none",
    "auto",
    "inherit",
    "bold",
    "serif",
    "1e9",
    "1e-9",
    "1e999",
    "Infinity",
    "NaN",
    "a",
    "z",
    "-W",
    "solid",
    "red",
    "fr",
    "en-US",
    "*",
    ":lang(",
    ":dir(",
    "::",
    "|",
    ">",
    "~",
    "*|",
    "\u{10FFFF}",
];

fn random_string(r: &mut Rng) -> String {
    let mut s = String::new();
    for _ in 0..r.below(10) {
        if r.below(8) == 0 {
            s.push(char::from_u32((r.next() % 0x11_0000) as u32).unwrap_or('x'));
        } else {
            s.push_str(TOKENS[r.below(TOKENS.len())]);
        }
    }
    s
}

fn iters() -> usize {
    std::env::var("FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000)
}

#[test]
fn form_microsyntaxes_never_panic() {
    let mut r = Rng(0x9E37_79B9_7F4A_7C15);
    for case in ["00:0é", "0é:00", "12:3😀", "00:00:0é", "2024-01-01T00:0é", "2024-0é-01", "é", "00:00:00.é"]
    {
        let _ = types::parse_time(case);
        let _ = types::parse_datetime(case);
    }
    for _ in 0..iters() {
        let v = random_string(&mut r);
        let t = r.below(22) as u32;
        let _ = types::parse_float(&v);
        let _ = types::is_valid_float(&v);
        let _ = types::parse_month(&v);
        let _ = types::parse_date(&v);
        let _ = types::parse_time(&v);
        let _ = types::parse_week(&v);
        let _ = types::parse_datetime(&v);
        let _ = types::is_valid_email(&v);
        let _ = types::is_valid_email_list(&v);
        let _ = types::to_number(t, &v);
        let _ = types::sanitize(t, &v, true, Some(&types::RangeBounds { min: 0.0, max: 100.0 }));
        let _ = types::sanitize(t, &v, false, None);
        let _ = types::strip_and_collapse(&v);
    }
}

#[test]
fn css_values_media_and_selectors_never_panic() {
    let mut r = Rng(0x1234_5678_9ABC_DEF1);
    let mut e = Env::new();
    for _ in 0..iters() {
        let v = random_string(&mut r);
        let p = r.below(830) as u32;
        let _ = value::parse_declaration(p, &v);
        let _ = value::serialize_values(p, &[&v, &v, &v, &v, &v, &v, &v, &v, &v, &v, &v, &v]);
        let _ = sheet::media_matches(&v);
        let _ = oxidom::select::parse_selector_list(&mut e, &v);
    }
}

#[test]
fn lang_matching_never_panics() {
    let mut r = Rng(0x0DDB_A11C_AFE5_EED5);
    let mut e = Env::new();
    let d = e.parse_document(
        "<!DOCTYPE html><style>:lang(x){color:red} :lang(fr){display:none}</style><div id=a><p id=p>t</p></div>",
        false,
    );
    let a = e.get_element_by_id(d, e.atoms.get("a").unwrap());
    let p = e.get_element_by_id(d, e.atoms.get("p").unwrap());
    let ranges = ["x", "fr", "\"*\"", "é", "fr-CA", "\"\"", "\"😀\""];
    let sels: Vec<u32> = ranges.iter().map(|x| e.compile_sel(&format!(":lang({x})"))).collect();
    assert!(sels.iter().all(|&s| s != 0));
    for case in ["éa", "é", "fé", "f😀", "x-é", "😀"] {
        e.set_attr(a, atom::LANG, case).unwrap();
        for &s in &sels {
            let _ = e.sel_matches(p, s);
        }
        let _ = cascade::core(&mut e, p);
    }
    for _ in 0..iters() / 4 {
        let v = random_string(&mut r);
        e.set_attr(a, atom::LANG, &v).unwrap();
        for &s in &sels {
            let _ = e.sel_matches(p, s);
        }
        let _ = cascade::core(&mut e, p);
    }
}
