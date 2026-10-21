//! CSS value parsing, validation and normalisation (DESIGN §8.1), shared by `element.style`, author
//! sheets, the UA sheet and computed values (one serializer everywhere, so jest-dom's `toHaveStyle`
//! round-trips).
//!
//! Behaviour follows jsdom 30's CSSOM where it matters for tests: hex/rgb/hsl colours become
//! `rgb()`/`rgba()`, named colours stay lowercase keywords, lengths lose trailing zeros and get lowercase
//! units (`0` becomes `0px` for length properties), unitless non-zero lengths are rejected, keywords are
//! validated for the common keyword properties, and the shorthands jsdom expands (margin, padding,
//! border*, flex, background, font) are stored as longhands. Other properties keep their (trimmed)
//! source text when it has several components, like jsdom's generic descriptor.
//!
//! Hot path (React `style[prop] = value`): components borrow the input (`CowRcStr`, a small inline
//! vector), keywords compare case-insensitively against static tables, and each property's grammar is
//! resolved once when the property table is built (`Grammar`), so only the final value is allocated.

use std::fmt::Write as _;

use cssparser::{CowRcStr, Parser, Token};
use smallvec::SmallVec;

use super::props::{BACKGROUND_INITIAL, CUSTOM_BASE, flag, props};

/// A parsed component value.
#[derive(Debug, Clone)]
pub(crate) enum Tok<'a> {
    Ident(CowRcStr<'a>),
    Num {
        v: f32,
        int: bool,
    },
    Pct(f32),
    Dim {
        v: f32,
        unit: CowRcStr<'a>,
    },
    Hash(CowRcStr<'a>),
    Str(CowRcStr<'a>),
    Url(CowRcStr<'a>),
    /// a function (name as written; the full source is `Comp::src`)
    Func(CowRcStr<'a>),
    Delim(char),
    Comma,
}

/// A component value and its source text.
#[derive(Debug, Clone)]
pub(crate) struct Comp<'a> {
    pub tok: Tok<'a>,
    pub src: &'a str,
}

type Comps<'a> = SmallVec<[Comp<'a>; 4]>;

/// Top-level component values of `s`, or None if `s` cannot be a declaration value (`!`, `;`, `{}`,
/// unbalanced closers, bad strings/urls).
pub(crate) fn components(s: &str) -> Option<Comps<'_>> {
    let mut p = Parser::new(s);
    let mut out = Comps::new();
    loop {
        let start = p.position();
        let tok = match p.next() {
            Ok(t) => t.clone(),
            Err(_) => break,
        };
        let t = match tok {
            Token::Ident(v) => Tok::Ident(v),
            Token::Number { value, int_value, .. } => Tok::Num { v: value, int: int_value.is_some() },
            Token::Percentage { unit_value, .. } => Tok::Pct(unit_value * 100.0),
            Token::Dimension { value, unit, .. } => Tok::Dim { v: value, unit },
            Token::Hash(v) | Token::IDHash(v) => Tok::Hash(v),
            Token::QuotedString(v) => Tok::Str(v),
            Token::UnquotedUrl(v) => Tok::Url(v),
            Token::Function(name) => {
                let is_url = name.eq_ignore_ascii_case("url");
                let inner: Result<Option<CowRcStr>, cssparser::ParseError<()>> = p.parse_nested_block(|p| {
                    let mut url = None;
                    while let Ok(t) = p.next() {
                        match t {
                            Token::QuotedString(v) if url.is_none() => url = Some(v.clone()),
                            Token::BadString(_) | Token::BadUrl(_) => {
                                return Err(p.new_error_for_next_token());
                            }
                            _ => {}
                        }
                    }
                    Ok(url)
                });
                let inner = inner.ok()?;
                if is_url { Tok::Url(inner.unwrap_or_else(|| "".into())) } else { Tok::Func(name) }
            }
            Token::ParenthesisBlock | Token::SquareBracketBlock => {
                let r: Result<(), cssparser::ParseError<()>> = p.parse_nested_block(|p| {
                    while p.next().is_ok() {}
                    Ok(())
                });
                r.ok()?;
                Tok::Delim('(')
            }
            Token::Comma => Tok::Comma,
            Token::Delim('!') => return None,
            Token::Delim(c) => Tok::Delim(c),
            Token::Colon => Tok::Delim(':'),
            Token::Semicolon
            | Token::CurlyBracketBlock
            | Token::CloseCurlyBracket
            | Token::CloseParenthesis
            | Token::CloseSquareBracket
            | Token::BadString(_)
            | Token::BadUrl(_)
            | Token::AtKeyword(_) => return None,
            _ => Tok::Delim('?'),
        };
        let src = p.slice_from(start).trim();
        out.push(Comp { tok: t, src });
    }
    Some(out)
}

// ------------------------------------------------------------------------------------- numbers

/// CSS number serialization: shortest round-trip form, no trailing zeros, `-0` -> `0`.
pub fn fmt_num(v: f32) -> String {
    let mut s = String::new();
    push_num(&mut s, v);
    s
}

/// Appends the serialization of `v` (see [`fmt_num`]).
pub fn push_num(s: &mut String, v: f32) {
    if v == 0.0 {
        s.push('0');
    } else if v.fract() == 0.0 && v.abs() < 1e9 {
        let _ = write!(s, "{}", v as i64);
    } else {
        // Round to 6 decimals like browsers do, then print the shortest form.
        let r = (v as f64 * 1e6).round() / 1e6;
        let start = s.len();
        let _ = write!(s, "{}", r as f32);
        if s[start..].contains('e') {
            s.truncate(start);
            let _ = write!(s, "{r}");
        }
    }
}

fn num_unit(v: f32, unit: &str) -> String {
    let mut s = String::with_capacity(8);
    push_num(&mut s, v);
    for b in unit.bytes() {
        s.push(b.to_ascii_lowercase() as char);
    }
    s
}

const LENGTH_UNITS: &[&str] = &[
    "px", "em", "rem", "ex", "rex", "ch", "rch", "cap", "rcap", "ic", "ric", "lh", "rlh", "vw", "vh", "vi",
    "vb", "vmin", "vmax", "svw", "svh", "lvw", "lvh", "dvw", "dvh", "svmin", "svmax", "lvmin", "lvmax",
    "dvmin", "dvmax", "cqw", "cqh", "cqi", "cqb", "cqmin", "cqmax", "cm", "mm", "q", "in", "pt", "pc",
];
const ANGLE_UNITS: &[&str] = &["deg", "rad", "grad", "turn"];

#[inline]
fn is_length_unit(u: &str) -> bool {
    LENGTH_UNITS.iter().any(|x| x.eq_ignore_ascii_case(u))
}

/// `<length>` (`nonneg`: reject negatives). Unitless `0` -> `0px`.
fn length(c: &Comp, nonneg: bool) -> Option<String> {
    match &c.tok {
        Tok::Dim { v, unit } if is_length_unit(unit) && (!nonneg || *v >= 0.0) => Some(num_unit(*v, unit)),
        Tok::Num { v, .. } if *v == 0.0 => Some("0px".into()),
        Tok::Func(n) if is_math_fn(n) => Some(lower_fn(c.src)),
        _ => None,
    }
}

fn percentage(c: &Comp, nonneg: bool) -> Option<String> {
    match c.tok {
        Tok::Pct(v) if !nonneg || v >= 0.0 => Some(num_unit(v, "%")),
        _ => None,
    }
}

fn length_pct(c: &Comp, nonneg: bool) -> Option<String> {
    length(c, nonneg).or_else(|| percentage(c, nonneg))
}

fn number(c: &Comp, nonneg: bool) -> Option<String> {
    match c.tok {
        Tok::Num { v, .. } if !nonneg || v >= 0.0 => Some(fmt_num(v)),
        Tok::Func(ref n) if is_math_fn(n) => Some(lower_fn(c.src)),
        _ => None,
    }
}

fn is_math_fn(n: &str) -> bool {
    ["calc", "min", "max", "clamp", "var", "env", "-webkit-calc", "round", "mod", "rem", "abs", "sign"]
        .iter()
        .any(|x| x.eq_ignore_ascii_case(n))
}

/// `NAME(args)` with the function name lowercased (args kept as written).
fn lower_fn(src: &str) -> String {
    match src.find('(') {
        Some(i) => src[..i].to_ascii_lowercase() + &src[i..],
        None => src.to_string(),
    }
}

/// The canonical (lowercase, static) keyword of `c` if it is one of `set`.
#[inline]
fn kw(c: &Comp, set: &'static [&'static str]) -> Option<&'static str> {
    match &c.tok {
        Tok::Ident(s) => set.iter().copied().find(|k| k.eq_ignore_ascii_case(s)),
        _ => None,
    }
}

#[inline]
fn keyword(c: &Comp, set: &'static [&'static str]) -> Option<String> {
    kw(c, set).map(str::to_string)
}

// --------------------------------------------------------------------------------------- colors

/// CSS Color 4 system colours with their light-scheme values (jsdom 30 `css/helpers/system-colors.js`;
/// `color-scheme: dark` is not modelled).
const SYSTEM_COLORS: &[(&str, [u8; 3])] = &[
    ("accentcolor", [0, 153, 255]),
    ("accentcolortext", [0, 0, 0]),
    ("activetext", [255, 0, 0]),
    ("buttonborder", [51, 51, 51]),
    ("buttonface", [204, 204, 204]),
    ("buttontext", [0, 0, 0]),
    ("canvas", [255, 255, 255]),
    ("canvastext", [0, 0, 0]),
    ("field", [255, 255, 255]),
    ("fieldtext", [0, 0, 0]),
    ("graytext", [102, 102, 102]),
    ("highlight", [0, 153, 255]),
    ("highlighttext", [255, 255, 255]),
    ("linktext", [0, 0, 255]),
    ("mark", [255, 255, 0]),
    ("marktext", [0, 0, 0]),
    ("selecteditem", [0, 153, 255]),
    ("selecteditemtext", [255, 255, 255]),
    ("visitedtext", [128, 0, 128]),
    ("activeborder", [51, 51, 51]),
    ("activecaption", [255, 255, 255]),
    ("appworkspace", [255, 255, 255]),
    ("background", [255, 255, 255]),
    ("buttonhighlight", [204, 204, 204]),
    ("buttonshadow", [204, 204, 204]),
    ("captiontext", [0, 0, 0]),
    ("inactiveborder", [51, 51, 51]),
    ("inactivecaption", [255, 255, 255]),
    ("inactivecaptiontext", [102, 102, 102]),
    ("infobackground", [255, 255, 255]),
    ("infotext", [0, 0, 0]),
    ("menu", [255, 255, 255]),
    ("menutext", [0, 0, 0]),
    ("scrollbar", [255, 255, 255]),
    ("threeddarkshadow", [51, 51, 51]),
    ("threedface", [204, 204, 204]),
    ("threedhighlight", [51, 51, 51]),
    ("threedlightshadow", [51, 51, 51]),
    ("threedshadow", [51, 51, 51]),
    ("window", [255, 255, 255]),
    ("windowframe", [51, 51, 51]),
    ("windowtext", [0, 0, 0]),
];

/// `rgb(r, g, b)` / `rgba(r, g, b, a)` (alpha rounded like browsers: 2 decimals when that round-trips
/// the 8-bit alpha, else 3).
pub fn fmt_rgba(r: u8, g: u8, b: u8, a: f32) -> String {
    // hand-rolled (no core::fmt machinery: it was ~30% of a hex `style.color` set)
    let mut s = String::with_capacity(24);
    let opaque = a >= 1.0;
    s.push_str(if opaque { "rgb(" } else { "rgba(" });
    push_u8(&mut s, r);
    s.push_str(", ");
    push_u8(&mut s, g);
    s.push_str(", ");
    push_u8(&mut s, b);
    if !opaque {
        let a8 = (a.clamp(0.0, 1.0) * 255.0).round();
        let mut v = (a8 / 255.0 * 100.0).round() / 100.0;
        if ((v * 255.0).round() - a8).abs() > 0.0 {
            v = (a8 / 255.0 * 1000.0).round() / 1000.0;
        }
        s.push_str(", ");
        s.push_str(&fmt_num(v));
    }
    s.push(')');
    s
}

/// Appends the decimal digits of `v`.
#[inline]
fn push_u8(s: &mut String, v: u8) {
    if v >= 100 {
        s.push((b'0' + v / 100) as char);
    }
    if v >= 10 {
        s.push((b'0' + v / 10 % 10) as char);
    }
    s.push((b'0' + v % 10) as char);
}

fn channel(c: &Comp, pct_scale: f32) -> Option<f32> {
    match c.tok {
        Tok::Num { v, .. } => Some(v),
        Tok::Pct(v) => Some(v * pct_scale / 100.0),
        Tok::Ident(ref s) if s.eq_ignore_ascii_case("none") => Some(0.0),
        _ => None,
    }
}

fn alpha(c: &Comp) -> Option<f32> {
    match c.tok {
        Tok::Num { v, .. } => Some(v.clamp(0.0, 1.0)),
        Tok::Pct(v) => Some((v / 100.0).clamp(0.0, 1.0)),
        Tok::Ident(ref s) if s.eq_ignore_ascii_case("none") => Some(0.0),
        _ => None,
    }
}

fn hue(c: &Comp) -> Option<f32> {
    match &c.tok {
        Tok::Num { v, .. } => Some(*v),
        Tok::Dim { v, unit } => {
            let u = unit.to_ascii_lowercase();
            match u.as_str() {
                "deg" => Some(*v),
                "rad" => Some(v.to_degrees()),
                "grad" => Some(v * 0.9),
                "turn" => Some(v * 360.0),
                _ => None,
            }
        }
        Tok::Ident(s) if s.eq_ignore_ascii_case("none") => Some(0.0),
        _ => None,
    }
}

/// Splits function arguments into (values, alpha) for both legacy comma and modern space syntax.
fn color_args(src: &str) -> Option<(SmallVec<[Comp<'_>; 3]>, Option<Comp<'_>>)> {
    let open = src.find('(')?;
    let inner = src[open + 1..].strip_suffix(')').unwrap_or(&src[open + 1..]);
    let comps = components(inner)?;
    let mut vals = SmallVec::new();
    if comps.iter().any(|c| matches!(c.tok, Tok::Comma)) {
        let mut groups = comps.split(|c| matches!(c.tok, Tok::Comma));
        let mut all: SmallVec<[Comp; 4]> = SmallVec::new();
        for g in &mut groups {
            match g {
                [one] => all.push(one.clone()),
                _ => return None,
            }
        }
        let a = match all.len() {
            3 => None,
            4 => all.pop(),
            _ => return None,
        };
        vals.extend(all);
        return Some((vals, a));
    }
    let mut a = None;
    let mut it = comps.into_iter();
    while let Some(c) = it.next() {
        if matches!(c.tok, Tok::Delim('/')) {
            a = Some(it.next()?);
            if it.next().is_some() {
                return None;
            }
            break;
        }
        vals.push(c);
    }
    (vals.len() == 3).then_some((vals, a))
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
    let h = h.rem_euclid(360.0) / 360.0;
    let s = s.clamp(0.0, 1.0);
    let l = l.clamp(0.0, 1.0);
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let f = |t: f32| {
        let t = t.rem_euclid(1.0);
        let v = if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        };
        (v * 255.0).round().clamp(0.0, 255.0) as u8
    };
    (f(h + 1.0 / 3.0), f(h), f(h - 1.0 / 3.0))
}

/// `<color>` normalised (see module docs). None if `c` is not a colour.
pub(crate) fn color(c: &Comp) -> Option<String> {
    match &c.tok {
        Tok::Ident(s) => {
            let l = s.to_ascii_lowercase();
            if l == "transparent" || l == "currentcolor" || SYSTEM_COLORS.iter().any(|(n, _)| *n == l) {
                return Some(l);
            }
            cssparser::color::parse_named_color(&l).ok().map(|_| l)
        }
        Tok::Hash(h) => {
            let (r, g, b, a) = cssparser::color::parse_hash_color(h.as_bytes()).ok()?;
            Some(fmt_rgba(r, g, b, a))
        }
        Tok::Func(n) => {
            let n = n.to_ascii_lowercase();
            match n.as_str() {
                "rgb" | "rgba" => {
                    let (vals, a) = color_args(c.src)?;
                    let pct = matches!(vals[0].tok, Tok::Pct(_));
                    let mut rgb = [0u8; 3];
                    for (i, v) in vals.iter().enumerate() {
                        if matches!(v.tok, Tok::Pct(_)) != pct && !matches!(v.tok, Tok::Ident(_)) {
                            return None;
                        }
                        rgb[i] = channel(v, 255.0)?.round().clamp(0.0, 255.0) as u8;
                    }
                    let a = match a {
                        Some(a) => alpha(&a)?,
                        None => 1.0,
                    };
                    Some(fmt_rgba(rgb[0], rgb[1], rgb[2], a))
                }
                "hsl" | "hsla" => {
                    let (vals, a) = color_args(c.src)?;
                    let h = hue(&vals[0])?;
                    let s = channel(&vals[1], 100.0)? / 100.0;
                    let l = channel(&vals[2], 100.0)? / 100.0;
                    let (r, g, b) = hsl_to_rgb(h, s, l);
                    let a = match a {
                        Some(a) => alpha(&a)?,
                        None => 1.0,
                    };
                    Some(fmt_rgba(r, g, b, a))
                }
                "hwb" | "lab" | "lch" | "oklab" | "oklch" | "color" | "color-mix" | "light-dark" | "var" => {
                    Some(lower_fn(c.src))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// The computed value of a specified `<color>`/`<paint>` keyword (`v` is already normalised by
/// [`color`]): named and system colours become `rgb()`, `transparent` `rgba(0, 0, 0, 0)`. Like jsdom 30,
/// any other bare keyword on a colour property (`auto`, `none`, `invert`) also computes to
/// `rgba(0, 0, 0, 0)`. None leaves the value as specified (`rgb()` already, functions, `url()`, ...).
/// `currentcolor` is resolved by the cascade before this.
pub(crate) fn computed_color(v: &str) -> Option<String> {
    if v.is_empty() || !v.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-') {
        return None;
    }
    if let Some((_, [r, g, b])) = SYSTEM_COLORS.iter().find(|(n, _)| *n == v) {
        return Some(fmt_rgba(*r, *g, *b, 1.0));
    }
    Some(match cssparser::color::parse_named_color(v) {
        Ok((r, g, b)) => fmt_rgba(r, g, b, 1.0),
        Err(()) => fmt_rgba(0, 0, 0, 0.0),
    })
}

// ---------------------------------------------------------------------------------- grammars

/// The value grammar of a property (resolved once per property when the table is built).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grammar {
    /// `display`
    Display,
    /// `position`
    Position,
    /// `visibility`
    Visibility,
    /// `pointer-events`
    PointerEvents,
    /// `float`
    Float,
    /// `clear`
    Clear,
    /// `box-sizing`
    BoxSizing,
    /// `overflow` (1-2 keywords, not expanded, like jsdom)
    Overflow,
    /// `overflow-x` & co
    OverflowAxis,
    /// `white-space`
    WhiteSpace,
    /// `text-align`
    TextAlign,
    /// `font-style`
    FontStyle,
    /// `font-weight`
    FontWeight,
    /// `font-size`
    FontSize,
    /// `line-height`
    LineHeight,
    /// `opacity` & the SVG opacities
    Opacity,
    /// `z-index`
    ZIndex,
    /// `order`
    Order,
    /// `flex-grow` / `flex-shrink`
    FlexFactor,
    /// `flex-basis`
    FlexBasis,
    /// `width` / `height` / `min-*`
    Size,
    /// `max-*`
    MaxSize,
    /// `top` / `right` / `bottom` / `left` / `inset-*-*`
    Inset,
    /// `margin-*`
    Margin,
    /// `padding-*`
    Padding,
    /// `border-*-width`
    BorderWidth,
    /// `border-*-style`
    BorderStyle,
    /// `outline-style`
    OutlineStyle,
    /// `font-family`
    FontFamily,
    /// everything else: jsdom's generic descriptor semantics
    Generic,
    /// a `<color>` property that also takes `auto` (jsdom 30 accepts it on these four only)
    ColorOrAuto,
}

/// Grammar of a property name.
pub fn grammar_of(name: &str) -> Grammar {
    let side = |base: &str| {
        name.strip_prefix(base).is_some_and(|r| matches!(r, "-top" | "-right" | "-bottom" | "-left"))
    };
    let dashes = name.matches('-').count();
    match name {
        "display" => Grammar::Display,
        "position" => Grammar::Position,
        "visibility" => Grammar::Visibility,
        "pointer-events" => Grammar::PointerEvents,
        "float" => Grammar::Float,
        "clear" => Grammar::Clear,
        "box-sizing" => Grammar::BoxSizing,
        "overflow" => Grammar::Overflow,
        "overflow-x" | "overflow-y" | "overflow-inline" | "overflow-block" => Grammar::OverflowAxis,
        "white-space" => Grammar::WhiteSpace,
        "text-align" => Grammar::TextAlign,
        "font-style" => Grammar::FontStyle,
        "font-weight" => Grammar::FontWeight,
        "font-size" => Grammar::FontSize,
        "line-height" => Grammar::LineHeight,
        "opacity" | "fill-opacity" | "stroke-opacity" | "flood-opacity" | "stop-opacity" => Grammar::Opacity,
        "z-index" => Grammar::ZIndex,
        "order" => Grammar::Order,
        "flex-grow" | "flex-shrink" => Grammar::FlexFactor,
        "flex-basis" => Grammar::FlexBasis,
        "width" | "height" | "min-width" | "min-height" | "inline-size" | "block-size"
        | "min-inline-size" | "min-block-size" => Grammar::Size,
        "max-width" | "max-height" | "max-inline-size" | "max-block-size" => Grammar::MaxSize,
        "top" | "right" | "bottom" | "left" | "inset-block-start" | "inset-block-end"
        | "inset-inline-start" | "inset-inline-end" => Grammar::Inset,
        "outline-style" => Grammar::OutlineStyle,
        "font-family" => Grammar::FontFamily,
        _ if side("margin") || name.starts_with("margin-block-") || name.starts_with("margin-inline-") => {
            Grammar::Margin
        }
        _ if side("padding") || name.starts_with("padding-block-") || name.starts_with("padding-inline-") => {
            Grammar::Padding
        }
        _ if name.starts_with("border-") && name.ends_with("-width") && dashes == 2 => Grammar::BorderWidth,
        _ if name.starts_with("border-") && name.ends_with("-style") && dashes == 2 => Grammar::BorderStyle,
        "accent-color" | "caret-color" | "outline-color" | "scrollbar-color" => Grammar::ColorOrAuto,
        _ => Grammar::Generic,
    }
}

/// CSS-wide keywords.
pub fn is_wide_keyword(s: &str) -> bool {
    ["inherit", "initial", "unset", "revert", "revert-layer"].iter().any(|k| k.eq_ignore_ascii_case(s))
}

fn has_var(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 4 && b.windows(4).any(|w| w.eq_ignore_ascii_case(b"var(") || w.eq_ignore_ascii_case(b"env("))
}

const DISPLAY: &[&str] = &[
    "none",
    "block",
    "inline",
    "inline-block",
    "flex",
    "inline-flex",
    "grid",
    "inline-grid",
    "contents",
    "list-item",
    "table",
    "inline-table",
    "table-row",
    "table-cell",
    "table-column",
    "table-column-group",
    "table-header-group",
    "table-footer-group",
    "table-row-group",
    "table-caption",
    "flow-root",
    "ruby",
    "ruby-text",
    "ruby-base",
    "ruby-base-container",
    "ruby-text-container",
    "run-in",
    "flow",
    "math",
    "-webkit-box",
    "-webkit-inline-box",
    "-webkit-flex",
    "-webkit-inline-flex",
    "-moz-box",
    "-ms-flexbox",
];
const DISPLAY_MULTI: &[&str] =
    &["block", "inline", "run-in", "flow", "flow-root", "table", "flex", "grid", "ruby", "list-item"];
const BORDER_STYLE: &[&str] =
    &["none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"];
const BORDER_WIDTH_KW: &[&str] = &["thin", "medium", "thick"];
const SIZE_KW: &[&str] = &[
    "auto",
    "min-content",
    "max-content",
    "fit-content",
    "stretch",
    "-webkit-fill-available",
    "-moz-available",
];
const MAX_SIZE_KW: &[&str] = &["none", "min-content", "max-content", "fit-content", "stretch"];
const FONT_SIZE_KW: &[&str] = &[
    "xx-small",
    "x-small",
    "small",
    "medium",
    "large",
    "x-large",
    "xx-large",
    "xxx-large",
    "larger",
    "smaller",
    "math",
];
const OVERFLOW: &[&str] = &["visible", "hidden", "clip", "scroll", "auto", "overlay"];
const POSITION: &[&str] = &["static", "relative", "absolute", "fixed", "sticky", "-webkit-sticky"];
const VISIBILITY: &[&str] = &["visible", "hidden", "collapse"];
const POINTER_EVENTS: &[&str] = &[
    "auto",
    "none",
    "visiblepainted",
    "visiblefill",
    "visiblestroke",
    "visible",
    "painted",
    "fill",
    "stroke",
    "all",
    "bounding-box",
];
const FLOAT: &[&str] = &["left", "right", "none", "inline-start", "inline-end"];
const CLEAR: &[&str] = &["none", "left", "right", "both", "inline-start", "inline-end"];
const BOX_SIZING: &[&str] = &["content-box", "border-box"];
const WHITE_SPACE: &[&str] = &["normal", "pre", "nowrap", "pre-wrap", "break-spaces", "pre-line"];
const TEXT_ALIGN: &[&str] =
    &["start", "end", "left", "right", "center", "justify", "match-parent", "justify-all", "-webkit-center"];
const FONT_WEIGHT_KW: &[&str] = &["normal", "bold", "bolder", "lighter"];
const FLEX_BASIS_KW: &[&str] = &["auto", "content", "min-content", "max-content", "fit-content"];
const OUTLINE_STYLE: &[&str] =
    &["auto", "none", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"];

/// One component that must be one keyword of `set`.
fn one_kw(comps: &[Comp], set: &'static [&'static str]) -> Option<String> {
    match comps {
        [c] => keyword(c, set),
        _ => None,
    }
}

/// Grammar `g` on `comps` (source `src`); None = invalid.
fn parse_simple(g: Grammar, flags: u32, comps: &[Comp], src: &str) -> Option<String> {
    let one = if comps.len() == 1 { Some(&comps[0]) } else { None };
    match g {
        Grammar::Display => {
            if let Some(c) = one {
                return keyword(c, DISPLAY);
            }
            if comps.is_empty() || comps.len() > 3 {
                return None;
            }
            let mut s = String::new();
            for (i, c) in comps.iter().enumerate() {
                if i > 0 {
                    s.push(' ');
                }
                s.push_str(kw(c, DISPLAY_MULTI)?);
            }
            Some(s)
        }
        Grammar::Position => one_kw(comps, POSITION),
        Grammar::Visibility => one_kw(comps, VISIBILITY),
        Grammar::PointerEvents => one_kw(comps, POINTER_EVENTS),
        Grammar::Float => one_kw(comps, FLOAT),
        Grammar::Clear => one_kw(comps, CLEAR),
        Grammar::BoxSizing => one_kw(comps, BOX_SIZING),
        Grammar::Overflow => match comps {
            [a] => keyword(a, OVERFLOW),
            [a, b] => Some(format!("{} {}", kw(a, OVERFLOW)?, kw(b, OVERFLOW)?)),
            _ => None,
        },
        Grammar::OverflowAxis => one_kw(comps, OVERFLOW),
        Grammar::WhiteSpace => one_kw(comps, WHITE_SPACE),
        Grammar::TextAlign => one_kw(comps, TEXT_ALIGN),
        Grammar::FontStyle => {
            let k = kw(comps.first()?, &["normal", "italic", "oblique"])?;
            match comps {
                [_] => Some(k.to_string()),
                [_, Comp { tok: Tok::Dim { v, unit }, .. }]
                    if k == "oblique" && ANGLE_UNITS.iter().any(|x| x.eq_ignore_ascii_case(unit)) =>
                {
                    Some(format!("oblique {}", num_unit(*v, unit)))
                }
                _ => None,
            }
        }
        Grammar::FontWeight => {
            let c = one?;
            match c.tok {
                Tok::Num { v, .. } if (1.0..=1000.0).contains(&v) => Some(fmt_num(v)),
                _ => keyword(c, FONT_WEIGHT_KW),
            }
        }
        Grammar::FontSize => {
            let c = one?;
            keyword(c, FONT_SIZE_KW).or_else(|| length_pct(c, true))
        }
        Grammar::LineHeight => {
            let c = one?;
            keyword(c, &["normal"]).or_else(|| number(c, true)).or_else(|| length_pct(c, true))
        }
        Grammar::Opacity => {
            let c = one?;
            number(c, false).or_else(|| percentage(c, false))
        }
        Grammar::ZIndex | Grammar::Order => {
            let c = one?;
            match c.tok {
                Tok::Num { v, int: true } => Some(fmt_num(v)),
                _ if g == Grammar::ZIndex => keyword(c, &["auto"]),
                _ => None,
            }
        }
        Grammar::FlexFactor => number(one?, true),
        Grammar::FlexBasis => {
            let c = one?;
            keyword(c, FLEX_BASIS_KW).or_else(|| length_pct(c, true))
        }
        Grammar::Size => {
            let c = one?;
            keyword(c, SIZE_KW).or_else(|| length_pct(c, true)).or_else(|| fit_content_fn(c))
        }
        Grammar::MaxSize => {
            let c = one?;
            keyword(c, MAX_SIZE_KW).or_else(|| length_pct(c, true)).or_else(|| fit_content_fn(c))
        }
        Grammar::Inset | Grammar::Margin => {
            let c = one?;
            keyword(c, &["auto"]).or_else(|| length_pct(c, false))
        }
        Grammar::Padding => length_pct(one?, true),
        Grammar::BorderWidth => {
            let c = one?;
            keyword(c, BORDER_WIDTH_KW).or_else(|| length(c, true))
        }
        Grammar::BorderStyle => one_kw(comps, BORDER_STYLE),
        Grammar::OutlineStyle => one_kw(comps, OUTLINE_STYLE),
        Grammar::FontFamily => font_family(comps, src),
        Grammar::Generic => generic(flags, comps, src, false),
        Grammar::ColorOrAuto => generic(flags, comps, src, true),
    }
}

fn fit_content_fn(c: &Comp) -> Option<String> {
    matches!(&c.tok, Tok::Func(n) if n.eq_ignore_ascii_case("fit-content")).then(|| lower_fn(c.src))
}

/// `font-family`: comma-separated family names (identifier sequences or strings), kept as written.
fn font_family(comps: &[Comp], src: &str) -> Option<String> {
    if comps.is_empty() {
        return None;
    }
    for group in comps.split(|c| matches!(c.tok, Tok::Comma)) {
        match group {
            [Comp { tok: Tok::Str(_), .. }] => {}
            g if !g.is_empty() && g.iter().all(|c| matches!(c.tok, Tok::Ident(_))) => {}
            _ => return None,
        }
    }
    let mut out = String::with_capacity(src.len());
    for (i, group) in comps.split(|c| matches!(c.tok, Tok::Comma)).enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        match group {
            [Comp { tok: Tok::Str(s), .. }] => {
                let _ = cssparser::serialize_string(s, &mut out);
            }
            g => {
                for (j, c) in g.iter().enumerate() {
                    if j > 0 {
                        out.push(' ');
                    }
                    out.push_str(c.src);
                }
            }
        }
    }
    Some(out)
}

/// jsdom's generic descriptor: single components are normalised by type, multi-component values are
/// kept as written.
fn generic(flags: u32, comps: &[Comp], src: &str, allow_auto: bool) -> Option<String> {
    let c = match comps {
        [] => return None,
        [c] => c,
        _ => return Some(src.to_string()),
    };
    match &c.tok {
        Tok::Dim { v, unit } => {
            if flags & flag::LENGTH != 0 && is_length_unit(unit) {
                length(c, flags & flag::LENGTH_NONNEG != 0)
            } else {
                Some(num_unit(*v, unit))
            }
        }
        Tok::Num { v, .. } => {
            if flags & flag::NUMBER == 0 && flags & flag::LENGTH != 0 {
                (*v == 0.0).then(|| "0px".to_string())
            } else {
                Some(fmt_num(*v))
            }
        }
        Tok::Pct(v) => Some(num_unit(*v, "%")),
        Tok::Hash(_) => color(c),
        Tok::Ident(s) => {
            if flags & (flag::COLOR | flag::PAINT) != 0 {
                if let Some(col) = color(c) {
                    return Some(col);
                }
                // pure <color> properties accept no other identifier (but `auto` for caret/accent & co)
                if flags & !flag::CASE_SENSITIVE == flag::COLOR
                    && !(allow_auto && s.eq_ignore_ascii_case("auto"))
                {
                    return None;
                }
            }
            Some(if flags & flag::CASE_SENSITIVE != 0 { s.to_string() } else { s.to_ascii_lowercase() })
        }
        Tok::Str(s) => {
            let mut o = String::new();
            let _ = cssparser::serialize_string(s, &mut o);
            Some(o)
        }
        Tok::Url(u) => Some(url(u)),
        Tok::Func(_) => {
            if flags & (flag::COLOR | flag::PAINT) != 0 {
                if let Some(col) = color(c) {
                    return Some(col);
                }
                if flags & !flag::CASE_SENSITIVE == flag::COLOR {
                    return None;
                }
            }
            Some(lower_fn(c.src))
        }
        _ => Some(src.to_string()),
    }
}

fn url(u: &str) -> String {
    let mut o = String::from("url(");
    let _ = cssparser::serialize_string(u, &mut o);
    o.push(')');
    o
}

// ----------------------------------------------------------------------------------- shorthands

/// Longhand values of an expanded shorthand.
pub type Longhands = Vec<(u32, String)>;

/// The result of parsing one declaration.
#[derive(Debug, PartialEq)]
pub enum Parsed {
    /// The value of the property itself.
    One(String),
    /// Longhand values (shorthand expansion).
    Many(Longhands),
}

/// Shorthands rsdom (like jsdom) stores as longhands.
#[inline]
pub fn is_expanded_shorthand(p: u32) -> bool {
    p < CUSTOM_BASE && props().info(p).is_some_and(|i| !i.expanded.is_empty())
}

/// Longhands of an expanded shorthand in serialization order (empty for anything else).
#[inline]
pub fn longhands(p: u32) -> &'static [u32] {
    if p >= CUSTOM_BASE {
        return &[];
    }
    props().info(p).map_or(&[], |i| &i.expanded)
}

/// Parses `value` for property `p` (known id or custom). None = invalid (ignored by the caller).
pub fn parse_declaration(p: u32, value: &str) -> Option<Parsed> {
    let value = value.trim_matches(|c: char| matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{c}'));
    if value.is_empty() {
        return None;
    }
    if p >= CUSTOM_BASE {
        // Custom properties: any value without top-level `!`/`;` is valid, stored trimmed.
        components(value)?;
        return Some(Parsed::One(value.to_string()));
    }
    let info = props().info(p)?;
    let comps = components(value)?;
    let wide = match comps.as_slice() {
        [] => return None,
        [Comp { tok: Tok::Ident(s), .. }] if is_wide_keyword(s) => Some(s.to_ascii_lowercase()),
        _ => None,
    };
    if let Some(k) = wide {
        if !info.expanded.is_empty() {
            return Some(Parsed::Many(info.expanded.iter().map(|&l| (l, k.clone())).collect()));
        }
        return Some(Parsed::One(k));
    }
    if has_var(value) {
        return Some(Parsed::One(value.to_string()));
    }
    if !info.expanded.is_empty() {
        return expand(p, &comps, value).map(Parsed::Many);
    }
    parse_simple(info.grammar, info.flags, &comps, value).map(Parsed::One)
}

fn four_sides(longs: &[u32], vals: &[String]) -> Option<Longhands> {
    let (t, r, b, l) = match vals {
        [a] => (a, a, a, a),
        [a, b] => (a, b, a, b),
        [a, b, c] => (a, b, c, b),
        [a, b, c, d] => (a, b, c, d),
        _ => return None,
    };
    Some([t, r, b, l].iter().zip(longs).map(|(v, &p)| (p, (*v).clone())).collect())
}

fn expand(p: u32, comps: &[Comp], src: &str) -> Option<Longhands> {
    let pr = props();
    let ids = &pr.ids;
    let info = pr.info(p)?;
    if p == ids.margin
        || p == ids.padding
        || p == ids.border_width
        || p == ids.border_style
        || p == ids.border_color
    {
        let longs = &info.expanded;
        let first = pr.info(*longs.first()?)?;
        let vals: Vec<String> = if p == ids.border_color {
            // border-top-color goes through the generic path: require real colours
            comps.iter().map(color).collect::<Option<Vec<_>>>()?
        } else {
            comps
                .iter()
                .map(|c| parse_simple(first.grammar, first.flags, std::slice::from_ref(c), c.src))
                .collect::<Option<Vec<_>>>()?
        };
        return four_sides(longs, &vals);
    }
    if p == ids.border || ids.border_side.contains(&p) {
        let (w, s, c) = border_parts(comps)?;
        let sides: &[usize] =
            if p == ids.border { &[0, 1, 2, 3] } else { &[ids.border_side.iter().position(|&x| x == p)?] };
        let mut out = Vec::with_capacity(sides.len() * 3);
        for &i in sides {
            out.push((ids.border_side_width[i], w.clone().unwrap_or_else(|| "medium".into())));
        }
        for &i in sides {
            out.push((ids.border_side_style[i], s.clone().unwrap_or_else(|| "none".into())));
        }
        for &i in sides {
            out.push((ids.border_side_color[i], c.clone().unwrap_or_else(|| "currentcolor".into())));
        }
        return Some(out);
    }
    if p == ids.flex {
        return flex(comps)
            .map(|(g, s, b)| vec![(ids.flex_grow, g), (ids.flex_shrink, s), (ids.flex_basis, b)]);
    }
    if p == ids.background {
        return background(comps);
    }
    if p == ids.font {
        return font(comps, src);
    }
    None
}

fn border_parts(comps: &[Comp]) -> Option<(Option<String>, Option<String>, Option<String>)> {
    if comps.is_empty() || comps.len() > 3 {
        return None;
    }
    let (mut w, mut s, mut c) = (None, None, None);
    for comp in comps {
        if let Some(v) =
            w.is_none().then(|| keyword(comp, BORDER_WIDTH_KW).or_else(|| length(comp, true))).flatten()
        {
            w = Some(v);
        } else if let Some(v) = s.is_none().then(|| keyword(comp, BORDER_STYLE)).flatten() {
            s = Some(v);
        } else {
            c = Some(c.is_none().then(|| color(comp)).flatten()?);
        }
    }
    Some((w, s, c))
}

fn flex(comps: &[Comp]) -> Option<(String, String, String)> {
    if let [c] = comps {
        if let Some(k) = kw(c, &["none", "auto"]) {
            return Some(if k == "none" {
                ("0".into(), "0".into(), "auto".into())
            } else {
                ("1".into(), "1".into(), "auto".into())
            });
        }
    }
    let (mut g, mut s, mut b) = (None, None, None);
    for c in comps {
        if let Tok::Num { v, .. } = c.tok {
            if v < 0.0 {
                return None;
            }
            if g.is_none() {
                g = Some(fmt_num(v));
            } else if s.is_none() && b.is_none() {
                s = Some(fmt_num(v));
            } else if b.is_none() && v == 0.0 {
                b = Some("0px".into());
            } else {
                return None;
            }
        } else {
            let basis = b.is_none().then(|| keyword(c, FLEX_BASIS_KW).or_else(|| length_pct(c, true)));
            b = Some(basis.flatten()?);
        }
    }
    if g.is_none() && b.is_none() {
        return None;
    }
    let basis = b.unwrap_or_else(|| if g.is_some() { "0%".into() } else { "auto".into() });
    Some((g.unwrap_or_else(|| "1".into()), s.unwrap_or_else(|| "1".into()), basis))
}

fn background(comps: &[Comp]) -> Option<Longhands> {
    let ids = &props().ids;
    let mut vals: [Option<String>; 8] = Default::default();
    let mut pos: Vec<String> = Vec::new();
    let mut i = 0;
    while i < comps.len() {
        let c = &comps[i];
        let is_image = matches!(&c.tok, Tok::Url(_))
            || matches!(&c.tok, Tok::Func(n) if n.to_ascii_lowercase().contains("gradient") || n.eq_ignore_ascii_case("image-set"))
            || kw(c, &["none"]).is_some();
        if is_image && vals[0].is_none() {
            vals[0] = Some(match &c.tok {
                Tok::Url(u) => url(u),
                Tok::Ident(_) => "none".into(),
                _ => lower_fn(c.src),
            });
        } else if let Some(k) = kw(c, &["repeat", "repeat-x", "repeat-y", "no-repeat", "space", "round"]) {
            vals[3] = Some(match vals[3].take() {
                Some(prev) => format!("{prev} {k}"),
                None => k.to_string(),
            });
        } else if let Some(k) = keyword(c, &["scroll", "fixed", "local"]) {
            vals[4] = Some(k);
        } else if let Some(k) = keyword(c, &["border-box", "padding-box", "content-box"]) {
            if vals[5].is_none() {
                vals[5] = Some(k);
            } else {
                vals[6] = Some(k);
            }
        } else if let Some(k) =
            keyword(c, &["left", "right", "top", "bottom", "center"]).or_else(|| length_pct(c, false))
        {
            pos.push(k);
        } else if matches!(c.tok, Tok::Delim('/')) && !pos.is_empty() {
            let mut size = Vec::new();
            i += 1;
            while let Some(v) = comps
                .get(i)
                .and_then(|x| keyword(x, &["auto", "cover", "contain"]).or_else(|| length_pct(x, true)))
            {
                size.push(v);
                i += 1;
            }
            if size.is_empty() {
                return None;
            }
            vals[2] = Some(size.join(" "));
            continue;
        } else {
            vals[7] = Some(vals[7].is_none().then(|| color(c)).flatten()?);
        }
        i += 1;
    }
    if !pos.is_empty() {
        vals[1] = Some(pos.join(" "));
    }
    if vals[5].is_some() && vals[6].is_none() {
        vals[6] = vals[5].clone();
    }
    Some(
        ids.background_longhands
            .iter()
            .zip(vals)
            .enumerate()
            .map(|(i, (&p, v))| (p, v.unwrap_or_else(|| BACKGROUND_INITIAL[i].to_string())))
            .collect(),
    )
}

fn font(comps: &[Comp], src: &str) -> Option<Longhands> {
    let ids = &props().ids;
    let (mut style, mut variant, mut weight) = (None, None, None);
    let mut i = 0;
    while i < comps.len() {
        let c = &comps[i];
        if kw(c, &["normal"]).is_some() {
            // `normal` resets any of style / variant / weight: nothing to record
        } else if let Some(k) = style.is_none().then(|| keyword(c, &["italic", "oblique"])).flatten() {
            style = Some(k);
        } else if let Some(k) = variant.is_none().then(|| keyword(c, &["small-caps"])).flatten() {
            variant = Some(k);
        } else if let Some(k) = weight
            .is_none()
            .then(|| parse_simple(Grammar::FontWeight, 0, std::slice::from_ref(c), c.src))
            .flatten()
        {
            if matches!(c.tok, Tok::Num { .. })
                && i + 1 < comps.len()
                && matches!(comps[i + 1].tok, Tok::Delim('/'))
            {
                break;
            }
            weight = Some(k);
        } else {
            break;
        }
        i += 1;
    }
    let size = parse_simple(Grammar::FontSize, 0, std::slice::from_ref(comps.get(i)?), comps[i].src)?;
    i += 1;
    let mut lh = None;
    if i < comps.len() && matches!(comps[i].tok, Tok::Delim('/')) {
        let c = comps.get(i + 1)?;
        lh = Some(parse_simple(Grammar::LineHeight, 0, std::slice::from_ref(c), c.src)?);
        i += 2;
    }
    let fam_src = src.get(comps.get(i)?.src.as_ptr() as usize - src.as_ptr() as usize..)?;
    let family = font_family(&comps[i..], fam_src)?;
    let n = || "normal".to_string();
    Some(vec![
        (ids.font_style, style.unwrap_or_else(n)),
        (ids.font_variant, variant.unwrap_or_else(n)),
        (ids.font_weight, weight.unwrap_or_else(n)),
        (ids.font_size, size),
        (ids.line_height, lh.unwrap_or_else(n)),
        (ids.font_family, family),
    ])
}

/// Serializes shorthand `p` from its longhand values (`get(longhand)` -> value). None when a longhand
/// is missing or the combination has no shorthand form.
pub fn serialize_shorthand<'a>(p: u32, get: &dyn Fn(u32) -> Option<&'a str>) -> Option<String> {
    let longs = longhands(p);
    let mut vals: SmallVec<[&str; 12]> = SmallVec::new();
    for &l in longs {
        vals.push(get(l)?);
    }
    serialize_values(p, &vals)
}

/// [`serialize_shorthand`] over the longhand values in `longhands(p)` order.
pub fn serialize_values(p: u32, vals: &[&str]) -> Option<String> {
    let pr = props();
    let ids = &pr.ids;
    if vals.len() != longhands(p).len() || vals.is_empty() {
        return None;
    }
    if let Some(first) = vals.first().filter(|f| is_wide_keyword(f)) {
        return vals.iter().all(|v| v == first).then(|| first.to_string());
    }
    if vals.iter().any(|v| is_wide_keyword(v)) {
        return None;
    }
    let collapse = |v: &[&str]| -> String {
        let (t, r, b, l) = (v[0], v[1], v[2], v[3]);
        if l == r {
            if b == t {
                if r == t { t.to_string() } else { format!("{t} {r}") }
            } else {
                format!("{t} {r} {b}")
            }
        } else {
            format!("{t} {r} {b} {l}")
        }
    };
    if p == ids.margin
        || p == ids.padding
        || p == ids.border_width
        || p == ids.border_style
        || p == ids.border_color
    {
        return Some(collapse(vals));
    }
    let side_parts = |w: &str, s: &str, c: &str| -> String {
        let mut parts: SmallVec<[&str; 3]> = SmallVec::new();
        if w != "medium" {
            parts.push(w);
        }
        if s != "none" {
            parts.push(s);
        }
        if c != "currentcolor" {
            parts.push(c);
        }
        if parts.is_empty() { w.to_string() } else { parts.join(" ") }
    };
    if p == ids.border {
        let all_eq = |a: &[&str]| a.iter().all(|x| *x == a[0]);
        if !(all_eq(&vals[0..4]) && all_eq(&vals[4..8]) && all_eq(&vals[8..12])) {
            return None;
        }
        return Some(side_parts(vals[0], vals[4], vals[8]));
    }
    if ids.border_side.contains(&p) {
        return Some(side_parts(vals[0], vals[1], vals[2]));
    }
    if p == ids.flex {
        return Some(format!("{} {} {}", vals[0], vals[1], vals[2]));
    }
    if p == ids.background {
        let mut parts: Vec<String> = Vec::new();
        for (i, &v) in vals.iter().enumerate() {
            if v != BACKGROUND_INITIAL[i] {
                if i == 2 {
                    // size needs a position before the slash
                    if vals[1] == BACKGROUND_INITIAL[1] {
                        parts.push(vals[1].to_string());
                    }
                    parts.push(format!("/ {v}"));
                } else {
                    parts.push(v.to_string());
                }
            }
        }
        return Some(if parts.is_empty() { "none".into() } else { parts.join(" ") });
    }
    if p == ids.font {
        let mut s = String::new();
        for &v in &vals[0..3] {
            if v != "normal" {
                s.push_str(v);
                s.push(' ');
            }
        }
        s.push_str(vals[3]);
        if vals[4] != "normal" {
            let _ = write!(s, " / {}", vals[4]);
        }
        if !vals[5].is_empty() {
            s.push(' ');
            s.push_str(vals[5]);
        }
        return Some(s);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(name: &str, v: &str) -> Option<String> {
        let p = props().id(name).unwrap();
        match parse_declaration(p, v)? {
            Parsed::One(s) => Some(s),
            Parsed::Many(m) => {
                let get = |l: u32| m.iter().find(|(x, _)| *x == l).map(|(_, v)| v.as_str());
                serialize_shorthand(p, &get)
            }
        }
    }

    #[test]
    fn colors() {
        assert_eq!(one("color", "red").as_deref(), Some("red"));
        assert_eq!(one("color", "RED").as_deref(), Some("red"));
        assert_eq!(one("color", "#f00").as_deref(), Some("rgb(255, 0, 0)"));
        assert_eq!(one("color", "#ff000080").as_deref(), Some("rgba(255, 0, 0, 0.5)"));
        assert_eq!(one("color", "rgb(1,2,3)").as_deref(), Some("rgb(1, 2, 3)"));
        assert_eq!(one("color", "RGBA(1,2,3,.5)").as_deref(), Some("rgba(1, 2, 3, 0.5)"));
        assert_eq!(one("color", "rgba(1,2,3,1)").as_deref(), Some("rgb(1, 2, 3)"));
        assert_eq!(one("color", "rgb(1 2 3 / 50%)").as_deref(), Some("rgba(1, 2, 3, 0.5)"));
        assert_eq!(one("color", "hsl(120,100%,50%)").as_deref(), Some("rgb(0, 255, 0)"));
        assert_eq!(one("color", "currentColor").as_deref(), Some("currentcolor"));
        assert_eq!(one("color", "notacolor"), None);
        assert_eq!(one("color", "inherit").as_deref(), Some("inherit"));
        assert_eq!(one("color", "var(--x)").as_deref(), Some("var(--x)"));
        assert_eq!(one("background-color", "#1e1e1e").as_deref(), Some("rgb(30, 30, 30)"));
    }

    #[test]
    fn lengths_and_keywords() {
        assert_eq!(one("width", "10"), None);
        assert_eq!(one("width", "10px").as_deref(), Some("10px"));
        assert_eq!(one("width", "0").as_deref(), Some("0px"));
        assert_eq!(one("width", "1.50PX").as_deref(), Some("1.5px"));
        assert_eq!(one("width", "-5px"), None);
        assert_eq!(one("width", ".5em").as_deref(), Some("0.5em"));
        assert_eq!(one("width", "calc(100% - 10px)").as_deref(), Some("calc(100% - 10px)"));
        assert_eq!(one("display", "NONE").as_deref(), Some("none"));
        assert_eq!(one("display", "inline FLEX").as_deref(), Some("inline flex"));
        assert_eq!(one("display", "blah"), None);
        assert_eq!(one("opacity", ".50").as_deref(), Some("0.5"));
        assert_eq!(one("opacity", "50%").as_deref(), Some("50%"));
        assert_eq!(one("z-index", "1.5"), None);
        assert_eq!(one("font-weight", "heavy"), None);
        assert_eq!(one("font-weight", "650").as_deref(), Some("650"));
        assert_eq!(one("font-style", "oblique 10DEG").as_deref(), Some("oblique 10deg"));
        assert_eq!(one("top", "0").as_deref(), Some("0px"));
        assert_eq!(one("color", "red !important"), None);
        assert_eq!(
            one("box-shadow", "0 0 0 1px rgba(0,0,0,.1)").as_deref(),
            Some("0 0 0 1px rgba(0,0,0,.1)")
        );
        assert_eq!(
            one("transform", "translateX(10px) rotate(45deg)").as_deref(),
            Some("translateX(10px) rotate(45deg)")
        );
        assert_eq!(
            one("font-family", "Arial, \"Helvetica Neue\", sans-serif").as_deref(),
            Some("Arial, \"Helvetica Neue\", sans-serif")
        );
    }

    #[test]
    fn shorthands() {
        assert_eq!(one("margin", "-5px").as_deref(), Some("-5px"));
        assert_eq!(one("margin", "1px 2px 1px 2px").as_deref(), Some("1px 2px"));
        assert_eq!(one("margin", "1px 2px 3px").as_deref(), Some("1px 2px 3px"));
        assert_eq!(one("margin", "0 auto").as_deref(), Some("0px auto"));
        assert_eq!(one("padding", "8px 12px").as_deref(), Some("8px 12px"));
        assert_eq!(one("border", "1px solid red").as_deref(), Some("1px solid red"));
        assert_eq!(one("border", "1px solid").as_deref(), Some("1px solid"));
        assert_eq!(one("border", "none").as_deref(), Some("medium"));
        assert_eq!(one("border", "0").as_deref(), Some("0px"));
        assert_eq!(one("border-color", "#fff").as_deref(), Some("rgb(255, 255, 255)"));
        assert_eq!(one("border-bottom", "2px dashed #333").as_deref(), Some("2px dashed rgb(51, 51, 51)"));
        assert_eq!(one("flex", "1").as_deref(), Some("1 1 0%"));
        assert_eq!(one("flex", "auto").as_deref(), Some("1 1 auto"));
        assert_eq!(one("flex", "none").as_deref(), Some("0 0 auto"));
        assert_eq!(one("flex", "1 0 auto").as_deref(), Some("1 0 auto"));
        assert_eq!(one("background", "#fff").as_deref(), Some("rgb(255, 255, 255)"));
        assert_eq!(one("background", "red url(a.png)").as_deref(), Some("url(\"a.png\") red"));
        assert_eq!(one("background", "url('b.png') no-repeat").as_deref(), Some("url(\"b.png\") no-repeat"));
        assert_eq!(one("font", "12px Arial").as_deref(), Some("12px Arial"));
        assert_eq!(
            one("font", "bold 12px/1.5 \"A B\", serif").as_deref(),
            Some("bold 12px / 1.5 \"A B\", serif")
        );
        assert_eq!(one("margin", "inherit").as_deref(), Some("inherit"));
        assert_eq!(one("overflow", "hidden auto").as_deref(), Some("hidden auto"));
    }

    #[test]
    fn numbers() {
        assert_eq!(fmt_num(1.5), "1.5");
        assert_eq!(fmt_num(-0.0), "0");
        assert_eq!(fmt_num(0.1), "0.1");
        assert_eq!(fmt_num(100.0), "100");
        assert_eq!(fmt_num(0.333_333_34), "0.333333");
    }
}
