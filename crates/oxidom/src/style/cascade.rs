//! The cascade and computed values (DESIGN §8.2).
//!
//! Order (jsdom 30 semantics, the parity oracle): UA rules, then author `<style>` rules in tree order,
//! compared by (importance, specificity, source order) with no origin split for normal declarations
//! (so `[hidden]` keeps winning over a less specific author rule, as in jsdom), then the inline block
//! (normal inline beats every normal rule, inline `!important` beats everything).
//!
//! Computed values start from the specified serialization (the same serializer as `element.style`) and
//! resolve what jsdom 30 resolves (ROADMAP Stage 3 `computed-values`): colour keywords, system colours,
//! `transparent` and `currentcolor` to `rgb()`/`rgba()`, `font-weight` keywords to numbers, and single
//! `<length>`s in absolute, font-relative and viewport units to px. So, as on jsdom, jest-dom
//! `toHaveStyle('color: red')` / `{fontWeight: 'bold'}` no longer match (the expected side keeps the
//! keyword). Unspecified properties use jsdom's resolved initial values (`rgb(0, 0, 0)`, `400`, `16px`,
//! `rgba(0, 0, 0, 0)`, ...); border widths of `none` borders are 0px. Not resolved: `calc()`, `color-mix()`,
//! `lab()` & co, `color-scheme: dark` system colours.
//!
//! The core snapshot (`csCore`): display, visibility, pointer-events, opacity == 1 and position packed in
//! a u32, memoised per element (`ElementExt.cs`) against `EP[STYLE]`; inherited fields come from the
//! parent's memo.

use selectors::context::{
    MatchingContext, MatchingForInvalidation, MatchingMode, NeedsSelectorFlags, SelectorCaches,
};
use selectors::matching::matches_selector;
use smallvec::SmallVec;

use super::inline::InlineStyle;
use super::props::{CUSTOM_BASE, flag, props};
use super::sheet::{self, Authors, Sheet, core_bit, prop_bit};
use super::value::{self, fmt_num, is_wide_keyword};
use super::{CsMemo, EP_STYLE_DEP};
use crate::env::{Env, ep};
use crate::node::{kind, meta};
use crate::select::adapter::{self, ERef};
use crate::table::NodeId;

/// Packed core layout (mirrored in packages/oxidom/lib/style.cjs).
pub mod pack {
    /// display index (`DISPLAY_KW`, 31 = other) bits 0-4
    pub const DISPLAY_SHIFT: u32 = 0;
    /// visibility index (`VISIBILITY_KW`, 3 = other) bits 5-6
    pub const VISIBILITY_SHIFT: u32 = 5;
    /// pointer-events index (`POINTER_EVENTS_KW`, 15 = other) bits 7-10
    pub const POINTER_EVENTS_SHIFT: u32 = 7;
    /// opacity is exactly 1
    pub const OPACITY_ONE: u32 = 1 << 11;
    /// position index (`POSITION_KW`, 7 = other) bits 12-14
    pub const POSITION_SHIFT: u32 = 12;
    /// always set in a computed value (0 = not computed)
    pub const VALID: u32 = 1 << 15;
}

/// `display` keywords by packed index (31 = other: ask `csStr`).
pub const DISPLAY_KW: &[&str] = &[
    "inline",
    "block",
    "none",
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
];
/// `visibility` keywords (3 = other).
pub const VISIBILITY_KW: &[&str] = &["visible", "hidden", "collapse"];
/// `pointer-events` keywords (15 = other).
pub const POINTER_EVENTS_KW: &[&str] = &[
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
/// `position` keywords (7 = other).
pub const POSITION_KW: &[&str] = &["static", "relative", "absolute", "fixed", "sticky"];

fn idx(table: &[&str], v: &str, other: u32) -> u32 {
    table.iter().position(|k| *k == v).map_or(other, |i| i as u32)
}

/// Cascade winner of one property.
#[derive(Clone, Copy)]
struct Win<'a> {
    key: u64,
    val: &'a str,
}

const KEY_IMPORTANT: u64 = 1 << 62;
const KEY_INLINE: u64 = ((1u64 << 30) - 1) << 32 | u32::MAX as u64;

#[inline]
fn key(important: bool, spec: u32, order: u32) -> u64 {
    if important { KEY_IMPORTANT | order as u64 } else { ((spec as u64) << 32) | order as u64 }
}

/// Lazily created selector-matching state for one element (most rules are decided by `Pre` alone).
struct Matcher<'a> {
    e: &'a Env,
    el: NodeId,
    quirks_mode: selectors::context::QuirksMode,
    quirks: bool,
    caches: Option<SelectorCaches>,
}

impl<'a> Matcher<'a> {
    fn new(e: &'a Env, el: NodeId, q: selectors::context::QuirksMode) -> Self {
        Matcher { e, el, quirks_mode: q, quirks: q == selectors::context::QuirksMode::Quirks, caches: None }
    }

    #[inline]
    fn matches(&mut self, rule: &sheet::Rule) -> bool {
        if rule.pre.rejects(self.e, self.el, self.quirks) {
            return false;
        }
        if rule.pre.decided(self.quirks) {
            return true;
        }
        let caches = self.caches.get_or_insert_with(SelectorCaches::default);
        let mut cx = MatchingContext::<adapter::Impl>::new(
            MatchingMode::Normal,
            None,
            caches,
            self.quirks_mode,
            NeedsSelectorFlags::No,
            MatchingForInvalidation::No,
        );
        matches_selector(&rule.sel, 0, None, &ERef { e: self.e, id: self.el }, &mut cx)
    }
}

/// Applies a matching rule (order base `base`) to the winners of `want`.
#[inline]
fn apply_rule<'a>(
    m: &mut Matcher<'_>,
    rule: &'a sheet::Rule,
    base: u32,
    want: &[u32],
    core_filter: u8,
    out: &mut [Option<Win<'a>>],
) {
    if core_filter != 0 {
        if rule.core & core_filter == 0 {
            return;
        }
    } else if rule.bloom & prop_bit(want[0]) == 0 {
        return;
    }
    if !m.matches(rule) {
        return;
    }
    for d in &rule.decls.decls {
        if let Some(k) = want.iter().position(|&w| w == d.prop) {
            let nk = key(d.important, rule.spec, base | rule.order);
            if out[k].is_none_or(|w| nk >= w.key) {
                out[k] = Some(Win { key: nk, val: &d.value });
            }
        }
    }
}

/// Applies matching rules `list` of a sheet (order base `base`) to the winners of `want`.
#[inline]
fn apply_rules<'a>(
    m: &mut Matcher<'_>,
    sh: &'a Sheet,
    list: &[u32],
    base: u32,
    want: &[u32],
    core_filter: u8,
    out: &mut [Option<Win<'a>>],
) {
    for &i in list {
        apply_rule(m, &sh.rules[i as usize], base, want, core_filter, out);
    }
}

/// Order base of author sheet `k` (tree order, 0-based): UA rule orders are < 2^20.
#[inline]
fn author_base(k: u32) -> u32 {
    (k + 1) << 20
}

/// Visits the author rules `el` could match for core properties (`p` = None) or property `p`: a short
/// flat list (`sheet::FLAT_MAX`) as is, else the merged index's bucket candidates; every rule in a
/// quirks-mode document (ids and classes match case-insensitively there, which the case-sensitive
/// buckets cannot answer). Duplicates are possible.
fn for_author_candidates<'a>(
    e: &Env,
    el: NodeId,
    quirks: bool,
    authors: &Authors<'a>,
    p: Option<u32>,
    mut f: impl FnMut(&'a sheet::Rule, u32),
) {
    let Some(ix) = authors.index else { return };
    let flat = match p {
        None => Some(&ix.core_flat[..]),
        Some(p) => Some(ix.by_prop.get(&p).map_or(&[][..], |v| &v[..])),
    }
    .filter(|v| v.len() <= sheet::FLAT_MAX || quirks);
    let mut cands: SmallVec<[sheet::RuleRef; 32]> = SmallVec::new();
    let list = match flat {
        Some(v) => v,
        None => {
            (if p.is_none() { &ix.core } else { &ix.all }).candidates(e, el, &mut cands);
            &cands[..]
        }
    };
    for r in list {
        f(&ix.sheets[r.sheet as usize].rules[r.rule as usize], author_base(r.sheet));
    }
}

/// Every author rule (tree order of sheets, then source order) for `declared_props`: the `all` bucket
/// candidates, or every rule in a quirks-mode document.
fn for_all_author_candidates<'a>(
    e: &Env,
    el: NodeId,
    quirks: bool,
    authors: &Authors<'a>,
    mut f: impl FnMut(&'a sheet::Rule, u32),
) {
    let Some(ix) = authors.index else { return };
    if quirks {
        for (k, sh) in ix.sheets.iter().enumerate() {
            for rule in &sh.rules {
                f(rule, author_base(k as u32));
            }
        }
        return;
    }
    let mut cands: SmallVec<[sheet::RuleRef; 32]> = SmallVec::new();
    ix.all.candidates(e, el, &mut cands);
    for r in cands {
        f(&ix.sheets[r.sheet as usize].rules[r.rule as usize], author_base(r.sheet));
    }
}

/// Runs the cascade for `want` on `el`, writing winners into `out`. With `core_filter` != 0, `want`
/// are core properties and only rules declaring one of them are considered; otherwise `want` is one
/// property and only the rules that may declare it are matched.
fn cascade<'a>(
    e: &'a Env,
    el: NodeId,
    q: selectors::context::QuirksMode,
    authors: &Authors<'a>,
    want: &[u32],
    core_filter: u8,
    out: &mut [Option<Win<'a>>],
) {
    let ua = sheet::ua();
    let mut m = Matcher::new(e, el, q);
    if core_filter != 0 {
        let (by_tag, other) = ua.sheet.core_candidates(e.rec(el).local);
        apply_rules(&mut m, &ua.sheet, by_tag, 0, want, core_filter, out);
        apply_rules(&mut m, &ua.sheet, other, 0, want, core_filter, out);
    } else {
        apply_rules(&mut m, &ua.sheet, ua.sheet.prop_rules(want[0]), 0, want, 0, out);
    }
    let quirks = m.quirks;
    let p = (core_filter == 0).then(|| want[0]);
    for_author_candidates(e, el, quirks, authors, p, |rule, base| {
        apply_rule(&mut m, rule, base, want, core_filter, out)
    });
    if e.rec(el).meta & meta::HAS_STYLE != 0 {
        if let Some(st) = e.inline(el) {
            apply_inline(st, want, out);
        }
    }
}

/// `revert` / `revert-layer` in an author or inline declaration roll back to the user-agent origin: the
/// UA sheet's winner for `p` on `el` (None: no UA declaration, i.e. `unset`).
fn ua_winner<'a>(
    e: &'a Env,
    el: NodeId,
    q: selectors::context::QuirksMode,
    p: u32,
    core_filter: u8,
) -> Option<Win<'a>> {
    let ua = sheet::ua();
    let mut m = Matcher::new(e, el, q);
    let mut out = [None];
    if core_filter != 0 {
        let (by_tag, other) = ua.sheet.core_candidates(e.rec(el).local);
        apply_rules(&mut m, &ua.sheet, by_tag, 0, &[p], core_filter, &mut out);
        apply_rules(&mut m, &ua.sheet, other, 0, &[p], core_filter, &mut out);
    } else {
        apply_rules(&mut m, &ua.sheet, ua.sheet.prop_rules(p), 0, &[p], 0, &mut out);
    }
    out[0]
}

fn is_revert(v: &str) -> bool {
    v.eq_ignore_ascii_case("revert") || v.eq_ignore_ascii_case("revert-layer")
}

fn apply_inline<'a>(st: &'a InlineStyle, want: &[u32], out: &mut [Option<Win<'a>>]) {
    for d in &st.decls {
        if let Some(k) = want.iter().position(|&w| w == d.prop) {
            let nk = if d.important { KEY_IMPORTANT | u32::MAX as u64 } else { KEY_INLINE };
            if out[k].is_none_or(|w| nk >= w.key) {
                out[k] = Some(Win { key: nk, val: &d.value });
            }
        }
    }
}

/// The document element of `el`'s node document (0 if it has none).
fn document_element(e: &Env, el: NodeId) -> NodeId {
    let mut c = e.rec(e.rec(el).owner).first;
    while c != 0 && e.rec(c).meta & meta::KIND_MASK != kind::ELEMENT {
        c = e.rec(c).next;
    }
    c
}

fn parent_element(e: &Env, el: NodeId) -> NodeId {
    let p = e.rec(el).parent;
    if p != 0 && e.rec(p).meta & meta::KIND_MASK == kind::ELEMENT { p } else { 0 }
}

// ------------------------------------------------------------------------------------ core

/// Computes the packed core of `el` given its parent's packed core (0 = no parent element).
fn compute_core<'a>(
    e: &'a Env,
    el: NodeId,
    parent: u32,
    q: selectors::context::QuirksMode,
    authors: &Authors<'a>,
) -> u32 {
    let ids = &props().ids;
    let want = [ids.display, ids.visibility, ids.pointer_events, ids.opacity, ids.position];
    let mut out = [None; 5];
    const ALL_CORE: u8 = core_bit::DISPLAY
        | core_bit::VISIBILITY
        | core_bit::POINTER_EVENTS
        | core_bit::OPACITY
        | core_bit::POSITION;
    cascade(e, el, q, authors, &want, ALL_CORE, &mut out);
    for (k, w) in out.iter_mut().enumerate() {
        if w.is_some_and(|w| is_revert(w.val)) {
            *w = ua_winner(e, el, q, want[k], ALL_CORE);
        }
    }
    let has_parent = parent & pack::VALID != 0;
    let field = |shift: u32, mask: u32| (parent >> shift) & mask;
    let resolve =
        |w: Option<Win>, inherited: bool, shift: u32, mask: u32, table: &[&str], other: u32| -> u32 {
            let initial = 0; // index 0 of each table is the initial value
            match w.map(|w| w.val) {
                None if inherited && has_parent => field(shift, mask),
                None => initial,
                Some(v) if v == "inherit" || (v == "unset" && inherited) => {
                    if has_parent {
                        field(shift, mask)
                    } else {
                        initial
                    }
                }
                Some(v) if is_wide_keyword(v) => initial,
                Some(v) => idx(table, v, other),
            }
        };
    let display = resolve(out[0], false, pack::DISPLAY_SHIFT, 31, DISPLAY_KW, 31);
    let visibility = resolve(out[1], true, pack::VISIBILITY_SHIFT, 3, VISIBILITY_KW, 3);
    let pe = resolve(out[2], true, pack::POINTER_EVENTS_SHIFT, 15, POINTER_EVENTS_KW, 15);
    let position = resolve(out[4], false, pack::POSITION_SHIFT, 7, POSITION_KW, 7);
    let opacity_one = match out[3].map(|w| w.val) {
        None => true,
        Some("inherit") => !has_parent || parent & pack::OPACITY_ONE != 0,
        Some(v) if is_wide_keyword(v) => true,
        Some(v) => opacity_value(v) == Some(1.0),
    };
    pack::VALID
        | display << pack::DISPLAY_SHIFT
        | visibility << pack::VISIBILITY_SHIFT
        | pe << pack::POINTER_EVENTS_SHIFT
        | if opacity_one { pack::OPACITY_ONE } else { 0 }
        | position << pack::POSITION_SHIFT
}

fn opacity_value(v: &str) -> Option<f32> {
    if let Some(p) = v.strip_suffix('%') {
        return p.parse::<f32>().ok().map(|x| (x / 100.0).clamp(0.0, 1.0));
    }
    v.parse::<f32>().ok().map(|x| x.clamp(0.0, 1.0))
}

fn memo_valid(e: &Env, m: &CsMemo) -> bool {
    e.style.memo
        && m.epoch == e.ep.get(ep::STYLE)
        && m.packed != 0
        && (e.ep.get(EP_STYLE_DEP) == 0 || (m.rec == e.ep.get(ep::REC) && m.form == e.ep.get(ep::FORM)))
}

fn memo_of(e: &Env, el: NodeId) -> Option<u32> {
    let m = &e.elem(el)?.ext.as_ref()?.cs;
    memo_valid(e, m).then_some(m.packed)
}

/// Prepares sheets + inline blocks of `el`'s inclusive element ancestors; returns the chain (el first).
fn prepare_chain(e: &mut Env, el: NodeId, stop_at_memo: bool) -> SmallVec<[NodeId; 32]> {
    sheet::prepare(e, e.rec(el).owner);
    let mut chain: SmallVec<[NodeId; 32]> = SmallVec::new();
    let mut n = el;
    while n != 0 {
        chain.push(n);
        if stop_at_memo && n != el && memo_of(e, n).is_some() {
            break;
        }
        n = parent_element(e, n);
    }
    for &n in &chain {
        if e.rec(n).meta & meta::HAS_STYLE != 0 {
            e.ensure_inline(n);
        }
    }
    chain
}

/// The packed core computed style of `el` (memoised against `EP[STYLE]`); 0 for non-elements.
pub fn core(e: &mut Env, el: NodeId) -> u32 {
    if !e.is_element(el) {
        return 0;
    }
    if let Some(p) = memo_of(e, el) {
        return p;
    }
    let chain = prepare_chain(e, el, true);
    let (epoch, rec, form) = (e.ep.get(ep::STYLE), e.ep.get(ep::REC), e.ep.get(ep::FORM));
    // Compute top-down with shared lookups (every element of the chain has the same node document),
    // then store the memos.
    let mut fresh: SmallVec<[(NodeId, u32); 32]> = SmallVec::new();
    let mut parent = 0;
    {
        let e: &Env = e;
        let q = adapter::quirks_of(e, el);
        let authors = sheet::author_sheets(e, e.rec(el).owner);
        for &n in chain.iter().rev() {
            parent = match memo_of(e, n) {
                Some(p) => p,
                None => {
                    let p = compute_core(e, n, parent, q, &authors);
                    fresh.push((n, p));
                    p
                }
            };
        }
    }
    for (n, p) in fresh {
        if let Some(d) = e.elem_mut(n) {
            d.ext_mut().cs = CsMemo { epoch, packed: p, rec, form };
        }
    }
    parent
}

/// True if `el` or one of its ancestor elements computes to `display: none` (area B's focusability
/// rule, DTL/jest-dom visibility). Uses and fills the core memo.
pub fn display_none_inclusive_ancestor(e: &mut Env, el: NodeId) -> bool {
    let mut n = el;
    while n != 0 && e.is_element(n) {
        if (core(e, n) >> pack::DISPLAY_SHIFT) & 31 == 2 {
            return true;
        }
        n = e.rec(n).parent;
    }
    false
}

// ---------------------------------------------------------------------------------- strings

/// jsdom's resolved value for an unspecified property (`None`: the table's initial value).
fn resolved_initial(name: &str) -> Option<&'static str> {
    Some(match name {
        "color" => "rgb(0, 0, 0)",
        "background-color" => "rgba(0, 0, 0, 0)",
        "font-weight" => "400",
        "font-size" => "16px",
        "font-family" => "depends on user agent",
        "text-align" => "start",
        _ => return None,
    })
}

const ABS_FONT_SIZES: &[(&str, f64)] = &[
    ("xx-small", 9.0),
    ("x-small", 10.0),
    ("small", 13.0),
    ("medium", 16.0),
    ("large", 18.0),
    ("x-large", 24.0),
    ("xx-large", 32.0),
    ("xxx-large", 48.0),
];

/// The viewport `vw`/`vh` resolve against when the caller has no window: the default `innerWidth` /
/// `innerHeight` (packages/oxidom/lib/window.cjs). The facade passes the window's current values to `csStr`.
pub const DEFAULT_VIEWPORT: (f64, f64) = (1024.0, 768.0);

/// A resolved length: jsdom 30 serialises it as `${Number(px.toPrecision(6))}px`, so JS number formatting
/// (exponent form below 1e-6 and from 1e21).
fn px(v: f64) -> String {
    let r: f64 = format!("{v:.5e}").parse().unwrap_or(v);
    if r == 0.0 {
        return "0px".into(); // also -0
    }
    if r.abs() < 1e-6 || r.abs() >= 1e21 {
        let s = format!("{r:e}");
        return match s.split_once('e') {
            Some((m, x)) if !x.starts_with('-') => format!("{m}e+{x}px"),
            _ => format!("{s}px"),
        };
    }
    format!("{r}px")
}

/// jsdom 30's `resolveLengthInPixels` for a single `<number><unit>` value (refs/jsdom/lib/jsdom/living/css/
/// helpers/font-sizes.js): absolute, font-relative and viewport units in px. `em` and `rem` give the font
/// sizes the relative units use (only called for those units); `vp` is the viewport in px, None on the root
/// element, where jsdom leaves viewport units unresolved. None for anything else: percentages, unitless
/// numbers, keywords, `calc()`.
fn length_px(v: &str, em: impl Fn() -> f64, rem: impl Fn() -> f64, vp: Option<(f64, f64)>) -> Option<f64> {
    let b = v.as_bytes();
    if !b.first().is_some_and(|c| c.is_ascii_digit() || matches!(c, b'.' | b'+' | b'-')) {
        return None;
    }
    // the longest numeric prefix followed by a letters-only unit (`1e1px` is 1e1 px, `1em` is 1 em)
    let (n, unit) = (1..b.len()).rev().find_map(|i| {
        let unit = &v[i..];
        if !unit.bytes().all(|c| c.is_ascii_alphabetic()) {
            return None;
        }
        v[..i].parse::<f64>().ok().map(|n| (n, unit))
    })?;
    let (vw, vh) = vp.map_or((f64::NAN, f64::NAN), |(w, h)| (w / 100.0, h / 100.0));
    let r = n * match unit {
        "px" => 1.0,
        "cm" => 96.0 / 2.54,
        "mm" => 96.0 / 25.4,
        "q" => 96.0 / 101.6,
        "in" => 96.0,
        "pc" => 16.0,
        "pt" => 96.0 / 72.0,
        "rem" | "rcap" | "ric" => rem(),
        "rch" | "rex" => rem() * 0.5,
        "rlh" => rem() * 1.2,
        "em" | "cap" | "ic" => em(),
        "ch" | "ex" => em() * 0.5,
        "lh" => em() * 1.2,
        "vw" | "vi" => vw,
        "vh" | "vb" => vh,
        "vmin" => vw.min(vh),
        "vmax" => vw.max(vh),
        _ => return None,
    };
    r.is_finite().then_some(r)
}

fn weight_num(v: &str) -> f32 {
    match v {
        "normal" => 400.0,
        "bold" => 700.0,
        _ => v.parse().unwrap_or(400.0),
    }
}

/// Context for string computations on one element and its ancestors (same node document: quirks
/// mode and author sheets are looked up once).
struct Strs<'a> {
    e: &'a Env,
    q: selectors::context::QuirksMode,
    authors: Authors<'a>,
    /// the window's innerWidth / innerHeight (viewport units)
    vp: (f64, f64),
}

impl<'a> Strs<'a> {
    fn new(e: &'a Env, el: NodeId, vp: (f64, f64)) -> Self {
        Strs { e, q: adapter::quirks_of(e, el), authors: sheet::author_sheets(e, e.rec(el).owner), vp }
    }

    /// The viewport for lengths on `el`: none on the root element (jsdom 30 `#prepareDimension` is skipped
    /// there, so `vh` & co stay as specified).
    fn vp_of(&self, el: NodeId) -> Option<(f64, f64)> {
        (document_element(self.e, el) != el).then_some(self.vp)
    }

    fn cascaded(&self, el: NodeId, p: u32) -> Option<&'a str> {
        let mut out = [None];
        cascade(self.e, el, self.q, &self.authors, &[p], 0, &mut out);
        out[0].map(|w| w.val)
    }

    /// Computed value of a longhand / plain / custom property. Inheritance walks up iteratively to the
    /// nearest ancestor with a cascaded value (no per-level allocation).
    fn computed(&self, el: NodeId, p: u32) -> String {
        let info = props().info(p);
        if info.is_some() && value::is_expanded_shorthand(p) {
            return self.shorthand(el, p);
        }
        // custom properties are inherited
        let inherited = info.is_none_or(|i| i.inherited);
        let is_color = info.is_some_and(|i| i.flags & (flag::COLOR | flag::PAINT) != 0);
        let at = |n: NodeId| if is_color { el } else { n };
        let mut n = el;
        loop {
            let parent = parent_element(self.e, n);
            let mut c = self.cascaded(n, p);
            if c.is_some_and(is_revert) {
                c = ua_winner(self.e, n, self.q, p, 0).map(|w| w.val);
            }
            let up = match c {
                None => inherited,
                Some("inherit") => true,
                Some("initial") => false,
                Some("unset") => inherited,
                // a colour inherits as specified and resolves on `el` (jsdom 30: `currentcolor` is el's colour)
                Some(v) => return if info.is_none() { v.to_string() } else { self.resolve(at(n), p, v) },
            };
            if !up || parent == 0 {
                return self.initial(at(n), p);
            }
            n = parent;
        }
    }

    fn initial(&self, el: NodeId, p: u32) -> String {
        let pr = props();
        let Some(info) = pr.info(p) else { return String::new() };
        if let Some(v) = resolved_initial(info.name) {
            return v.to_string();
        }
        let ids = &pr.ids;
        if info.initial == "currentcolor" {
            return self.computed(el, ids.color);
        }
        self.resolve(el, p, info.initial)
    }

    /// The computed `font-size` of `el` in px (16 for none).
    fn font_px(&self, el: NodeId) -> f64 {
        self.computed(el, props().ids.font_size)
            .strip_suffix("px")
            .and_then(|n| n.parse().ok())
            .unwrap_or(16.0)
    }

    /// The font size `rem` resolves against on `el`: the root element's, but 16 on the root element itself
    /// (jsdom 30 `#prepareDimension`).
    fn rem_px(&self, el: NodeId) -> f64 {
        match document_element(self.e, el) {
            0 => 16.0,
            root if root == el => 16.0,
            root => self.font_px(root),
        }
    }

    /// jsdom computed-value adjustments of a specified value.
    fn resolve(&self, el: NodeId, p: u32, v: &str) -> String {
        let pr = props();
        let ids = &pr.ids;
        // jsdom resolves longhands only; the shorthands it stores as one value keep the specified value
        let flags = pr.info(p).filter(|i| i.longhands.is_empty()).map_or(0, |i| i.flags);
        let is_color = flags & (flag::COLOR | flag::PAINT) != 0;
        if v == "currentcolor" && is_color {
            return if p == ids.color {
                match parent_element(self.e, el) {
                    0 => "rgb(0, 0, 0)".into(),
                    par => self.computed(par, ids.color),
                }
            } else {
                self.computed(el, ids.color)
            };
        }
        if is_color {
            return value::computed_color(v).unwrap_or_else(|| v.to_string());
        }
        if let Some(side) = ids.border_side_width.iter().position(|&x| x == p) {
            let style = self.computed(el, ids.border_side_style[side]);
            if style == "none" || style == "hidden" {
                return "0px".into();
            }
            return match v {
                "thin" => "1px".into(),
                "medium" => "3px".into(),
                "thick" => "5px".into(),
                _ => self.length(el, v),
            };
        }
        if p == ids.font_size {
            let parent_px = match parent_element(self.e, el) {
                0 => 16.0,
                par => self.font_px(par),
            };
            if let Some(&(_, x)) = ABS_FONT_SIZES.iter().find(|(k, _)| *k == v) {
                return px(x);
            }
            let r = match v {
                "larger" => Some(parent_px * 1.2),
                "smaller" => Some(parent_px / 1.2),
                _ => match v.strip_suffix('%').and_then(|n| n.parse::<f64>().ok()) {
                    Some(n) => Some(n * parent_px / 100.0),
                    None => length_px(v, || parent_px, || self.rem_px(el), self.vp_of(el)),
                },
            };
            return r.map(px).unwrap_or_else(|| v.to_string());
        }
        if p == ids.font_weight {
            match v {
                "normal" => return "400".into(),
                "bold" => return "700".into(),
                "bolder" | "lighter" => {}
                _ => return v.to_string(),
            }
            let pw = match parent_element(self.e, el) {
                0 => 400.0,
                par => weight_num(&self.computed(par, ids.font_weight)),
            };
            let w = if v == "bolder" {
                if pw < 350.0 {
                    400.0
                } else if pw < 550.0 {
                    700.0
                } else {
                    900.0_f32.max(pw)
                }
            } else if pw < 550.0 {
                100.0_f32.min(pw)
            } else if pw < 750.0 {
                400.0
            } else {
                700.0
            };
            return fmt_num(w);
        }
        if flags & flag::LENGTH != 0 {
            return self.length(el, v);
        }
        v.to_string()
    }

    /// A `<length>` longhand's computed value: jsdom resolves relative units against the element's own
    /// font size (`em`) and the root's (`rem`).
    fn length(&self, el: NodeId, v: &str) -> String {
        match length_px(v, || self.font_px(el), || self.rem_px(el), self.vp_of(el)) {
            Some(r) => px(r),
            None => v.to_string(),
        }
    }

    /// Computed value of an expanded shorthand (jsdom serializes computed shorthands in full).
    fn shorthand(&self, el: NodeId, p: u32) -> String {
        let ids = &props().ids;
        let get = |l: u32| Some(self.computed(el, l));
        if p == ids.border || ids.border_side.contains(&p) {
            let sides: Vec<usize> = if p == ids.border {
                vec![0, 1, 2, 3]
            } else {
                vec![ids.border_side.iter().position(|&x| x == p).unwrap_or(0)]
            };
            let parts: Vec<[String; 3]> = sides
                .iter()
                .map(|&i| {
                    [
                        self.computed(el, ids.border_side_width[i]),
                        self.computed(el, ids.border_side_style[i]),
                        self.computed(el, ids.border_side_color[i]),
                    ]
                })
                .collect();
            if parts.iter().any(|x| *x != parts[0]) {
                return String::new();
            }
            return parts[0].join(" ");
        }
        let mut vals: Vec<String> = value::longhands(p).iter().map(|&l| get(l).unwrap_or_default()).collect();
        if p == ids.font && vals.get(2).is_some_and(|w| w == "400") {
            // font-weight computes `normal` to 400, which jsdom's computed `font` leaves out like `normal`
            vals[2] = "normal".into();
        }
        let refs: SmallVec<[&str; 12]> = vals.iter().map(String::as_str).collect();
        value::serialize_values(p, &refs).unwrap_or_default()
    }
}

/// `getComputedStyle(el).getPropertyValue(p)` for any property (non-core path).
pub fn computed_str(e: &mut Env, el: NodeId, p: u32) -> String {
    computed_str_in(e, el, p, DEFAULT_VIEWPORT)
}

/// [`computed_str`] in a window of `vp` = (innerWidth, innerHeight).
pub fn computed_str_in(e: &mut Env, el: NodeId, p: u32, vp: (f64, f64)) -> String {
    if !e.is_element(el) {
        return String::new();
    }
    prepare_chain(e, el, false);
    // `rem` reads the root element, which is not an ancestor of a detached or shadow-tree element
    let root = document_element(e, el);
    if root != 0 {
        prepare_chain(e, root, false);
    }
    // inheritance and currentcolor resolution may visit any ancestor; prepare_chain covered them all
    Strs::new(e, el, vp).computed(el, p)
}

/// Property ids with a cascaded value on `el` (jsdom's computed declaration `length` / `item`), in
/// first-declaration cascade order (UA, author sheets, inline).
pub fn declared_props(e: &mut Env, el: NodeId) -> Vec<u32> {
    let mut out = Vec::new();
    if !e.is_element(el) {
        return out;
    }
    prepare_chain(e, el, false);
    let e: &Env = e;
    let ua = sheet::ua();
    let authors = sheet::author_sheets(e, e.rec(el).owner);
    let q = adapter::quirks_of(e, el);
    let quirks = q == selectors::context::QuirksMode::Quirks;
    let mut caches = SelectorCaches::default();
    let mut cx = MatchingContext::<adapter::Impl>::new(
        MatchingMode::Normal,
        None,
        &mut caches,
        q,
        NeedsSelectorFlags::No,
        MatchingForInvalidation::No,
    );
    let er = ERef { e, id: el };
    let mut matched: Vec<(u32, &InlineStyle)> = Vec::new();
    let mut cands: SmallVec<[u32; 32]> = SmallVec::new();
    // UA ids / classes are never quirks-sensitive (the UA sheet selects on neither).
    ua.sheet.candidates(e, el, &mut cands);
    for &i in &cands {
        let r = &ua.sheet.rules[i as usize];
        if !r.pre.rejects(e, el, quirks) && matches_selector(&r.sel, 0, None, &er, &mut cx) {
            matched.push((r.order, &r.decls));
        }
    }
    for_all_author_candidates(e, el, quirks, &authors, |r, base| {
        if !r.pre.rejects(e, el, quirks) && matches_selector(&r.sel, 0, None, &er, &mut cx) {
            matched.push((base | r.order, &r.decls));
        }
    });
    // candidates may repeat a rule (two bucket keys): keep each order once
    matched.sort_by_key(|(o, _)| *o);
    matched.dedup_by_key(|(o, _)| *o);
    let inline = e.inline(el);
    for st in matched.iter().map(|(_, d)| *d).chain(inline) {
        for d in &st.decls {
            if d.prop < CUSTOM_BASE && !out.contains(&d.prop) {
                out.push(d.prop);
            }
        }
    }
    out
}

natives! {
    /// getComputedStyle core snapshot: display | visibility | pointer-events | opacity==1 | position packed (see style/cascade.rs `pack`); 0 for non-elements.
    fn csCore(e, id: u32) -> u32 {
        core(e, id)
    }
    /// getComputedStyle(el).getPropertyValue(p) for property id `p`.
    fn csStr(e, id: u32, p: u32, vw: f64, vh: f64) -> &str {
        let s = computed_str_in(e, id, p, (vw, vh));
        e.scratch.clear();
        e.scratch.push_str(&s);
        &e.scratch
    }
    /// Property ids with a cascaded value (computed declaration length / item) into OUT; returns the count.
    fn csProps(e, id: u32) -> u32 {
        let v = declared_props(e, id);
        e.write_out(&v)
    }
    /// True if `id` or an ancestor element computes to display: none.
    fn csHidden(e, id: u32) -> bool {
        display_none_inclusive_ancestor(e, id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atoms::{Atom, atom};

    fn doc(html: &str) -> (Env, NodeId) {
        let mut e = Env::new();
        let d = e.parse_document(html, false);
        (e, d)
    }

    fn by_id(e: &Env, d: NodeId, id: &str) -> NodeId {
        e.get_element_by_id(d, e.atoms.get(id).unwrap())
    }

    fn display_of(e: &mut Env, d: NodeId, id: &str) -> &'static str {
        let el = by_id(e, d, id);
        display(e, el)
    }

    fn display(e: &mut Env, el: NodeId) -> &'static str {
        let p = core(e, el);
        DISPLAY_KW.get(((p >> pack::DISPLAY_SHIFT) & 31) as usize).copied().unwrap_or("other")
    }

    #[test]
    fn ua_display() {
        let (mut e, d) = doc(
            "<!DOCTYPE html><div id=d></div><span id=s></span><p id=p hidden></p><input id=h type=HIDDEN><table><tr><td id=td></td></tr></table><button id=b></button><dialog id=dl></dialog><li id=li></li>",
        );
        assert_eq!(display_of(&mut e, d, "d"), "block");
        assert_eq!(display_of(&mut e, d, "s"), "inline");
        assert_eq!(display_of(&mut e, d, "p"), "none");
        assert_eq!(display_of(&mut e, d, "h"), "none");
        assert_eq!(display_of(&mut e, d, "td"), "table-cell");
        assert_eq!(display_of(&mut e, d, "b"), "inline-block");
        assert_eq!(display_of(&mut e, d, "dl"), "none");
        assert_eq!(display_of(&mut e, d, "li"), "list-item");
    }

    #[test]
    fn inline_and_inheritance() {
        let (mut e, d) =
            doc("<!DOCTYPE html><div id=o style='visibility: hidden; color: red'><span id=i>x</span></div>");
        let i = by_id(&e, d, "i");
        let p = core(&mut e, i);
        assert_eq!((p >> pack::VISIBILITY_SHIFT) & 3, 1);
        let color = props().ids.color;
        assert_eq!(computed_str(&mut e, i, color), "rgb(255, 0, 0)");
        let o = by_id(&e, d, "o");
        e.set_attr(o, atom::STYLE, "display: none !important").unwrap();
        assert_eq!(display(&mut e, o), "none");
        assert!(display_none_inclusive_ancestor(&mut e, i));
        assert_eq!(computed_str(&mut e, i, color), "rgb(0, 0, 0)");
    }

    /// M9 review: pseudo-classes that read attributes or text must invalidate the core memo even when
    /// no state pseudo-class is in use (`EP[STYLE_DEP]` = 0).
    #[test]
    fn pseudo_class_inputs_invalidate_memo() {
        let (mut e, d) = doc(
            "<!DOCTYPE html><style>button:disabled{display:none} section:lang(fr) i{display:none} \
             a:link{display:flex} input:required{display:none} p:empty{display:flex}</style>\
             <button id=b></button><section id=s><i id=i></i></section><a id=a></a><input id=n><p id=p>x</p>",
        );
        assert_eq!(e.ep.get(EP_STYLE_DEP), 0);
        let (b, s, i, a, n, p) = (
            by_id(&e, d, "b"),
            by_id(&e, d, "s"),
            by_id(&e, d, "i"),
            by_id(&e, d, "a"),
            by_id(&e, d, "n"),
            by_id(&e, d, "p"),
        );
        for el in [b, i, a, n, p] {
            core(&mut e, el);
        }
        e.set_attr(b, atom::DISABLED, "").unwrap();
        assert_eq!(display(&mut e, b), "none");
        e.set_attr(s, atom::LANG, "fr-CA").unwrap();
        assert_eq!(display(&mut e, i), "none");
        e.set_attr(a, atom::HREF, "#").unwrap();
        assert_eq!(display(&mut e, a), "flex");
        e.set_attr(n, atom::REQUIRED, "").unwrap();
        assert_eq!(display(&mut e, n), "none");
        let t = e.rec(p).first;
        assert_eq!(display(&mut e, p), "block");
        e.set_data(t, "").unwrap();
        assert_eq!(display(&mut e, p), "flex");
        // xml:lang is namespaced
        e.remove_attr(s, atom::LANG);
        assert_eq!(display(&mut e, i), "inline");
        e.set_attr_ns(s, Some("http://www.w3.org/XML/1998/namespace"), "xml:lang", "fr").unwrap();
        assert_eq!(display(&mut e, i), "none");
    }

    #[test]
    fn memo_ablation_recomputes() {
        let (mut e, d) = doc("<!DOCTYPE html><div id=x></div>");
        let x = by_id(&e, d, "x");
        assert_eq!(display(&mut e, x), "block");
        // corrupt the memo: with the memo enabled it is trusted, with OXIDOM_NO_MEMO it is ignored
        let m = e.elem(x).unwrap().ext.as_ref().unwrap().cs;
        let bogus = (m.packed & !(31 << pack::DISPLAY_SHIFT)) | (2 << pack::DISPLAY_SHIFT);
        e.elem_mut(x).unwrap().ext_mut().cs.packed = bogus;
        e.style.memo = true;
        assert_eq!(display(&mut e, x), "none");
        e.style.memo = false;
        assert_eq!(display(&mut e, x), "block");
    }

    #[test]
    fn author_sheets() {
        let (mut e, d) = doc(
            "<!DOCTYPE html><style>.red { color: red } #x { display: flex } div > p { visibility: hidden }</style><div id=x class=red><p id=p>t</p></div>",
        );
        let x = by_id(&e, d, "x");
        let p = by_id(&e, d, "p");
        assert_eq!(display(&mut e, x), "flex");
        assert_eq!(computed_str(&mut e, p, props().ids.color), "rgb(255, 0, 0)");
        assert_eq!((core(&mut e, p) >> pack::VISIBILITY_SHIFT) & 3, 1);
        e.set_attr(x, atom::ID, "y").unwrap();
        assert_eq!(display(&mut e, x), "block");
    }

    /// The merged author index: source order across `<style>` elements, rebuilt when a sheet is
    /// removed or its text changes; single-property cascades and `declared_props` use it too.
    #[test]
    fn merged_author_index() {
        let (mut e, d) =
            doc("<!DOCTYPE html><style id=s1>.a{display:flex;color:red} [data-k]{opacity:.5}</style>\
             <style id=s2>.a{display:grid} div{color:blue}</style><div id=x class=a data-k></div>");
        let (x, s1, s2) = (by_id(&e, d, "x"), by_id(&e, d, "s1"), by_id(&e, d, "s2"));
        let color = props().ids.color;
        assert_eq!(display(&mut e, x), "grid");
        assert_eq!(computed_str(&mut e, x, color), "rgb(255, 0, 0)"); // .a beats div by specificity
        assert_eq!(core(&mut e, x) & pack::OPACITY_ONE, 0);
        let width = props().id("width").unwrap();
        assert!(!declared_props(&mut e, x).contains(&width));
        assert!(declared_props(&mut e, x).contains(&color));
        e.remove(s2, crate::tree::Records::Queue);
        assert_eq!(display(&mut e, x), "flex");
        e.set_text_content(s1, ".a{width:1px}").unwrap();
        assert_eq!(display(&mut e, x), "block");
        assert_eq!(computed_str(&mut e, x, color), "rgb(0, 0, 0)");
        assert_ne!(core(&mut e, x) & pack::OPACITY_ONE, 0);
        assert!(declared_props(&mut e, x).contains(&width));
    }

    /// Quirks mode: ids and classes match ASCII-case-insensitively, which the case-sensitive buckets
    /// cannot answer, so the cascade scans every author rule there.
    #[test]
    fn quirks_mode_author_rules() {
        let (mut e, d) = doc(
            "<style>.FOO{display:flex;color:red} #BAR{visibility:hidden}</style><div class=foo id=bar></div>",
        );
        let x = by_id(&e, d, "bar");
        assert_eq!(display(&mut e, x), "flex");
        assert_eq!((core(&mut e, x) >> pack::VISIBILITY_SHIFT) & 3, 1);
        assert_eq!(computed_str(&mut e, x, props().ids.color), "rgb(255, 0, 0)");
        assert!(declared_props(&mut e, x).contains(&props().ids.color));
    }

    #[test]
    fn resolved_values() {
        let (mut e, d) =
            doc("<!DOCTYPE html><h1 id=h>t<b id=b>b</b></h1><a id=a href=x>l</a><div id=d></div>");
        let pr = props();
        let h = by_id(&e, d, "h");
        assert_eq!(computed_str(&mut e, h, pr.ids.font_size), "32px");
        assert_eq!(computed_str(&mut e, h, pr.ids.font_weight), "700");
        let b = by_id(&e, d, "b");
        assert_eq!(computed_str(&mut e, b, pr.ids.font_weight), "900");
        let a = by_id(&e, d, "a");
        assert_eq!(computed_str(&mut e, a, pr.ids.color), "rgb(0, 0, 238)");
        assert_eq!(computed_str(&mut e, a, pr.ids.border), "0px none rgb(0, 0, 238)");
        let dv = by_id(&e, d, "d");
        assert_eq!(computed_str(&mut e, dv, pr.ids.margin), "0");
        assert_eq!(computed_str(&mut e, dv, pr.ids.background_color), "rgba(0, 0, 0, 0)");
        assert_eq!(computed_str(&mut e, dv, pr.ids.flex), "0 1 auto");
        assert_eq!(computed_str(&mut e, dv, pr.id("width").unwrap()), "auto");
    }

    #[test]
    fn computed_colours_and_lengths() {
        let (mut e, d) = doc("<!DOCTYPE html><html style='font-size: 10px'><style>.g { color: grey } \
             .t { background-color: transparent; border-top-color: Canvas; outline-color: auto }</style>\
             <div id=p class=g style='font-size: 20px'><p id=c class=t style='width: 2em; height: 3rem; \
             margin-left: 1in; padding-top: 10vh; line-height: 1.5; text-indent: 50%; font-weight: normal'>\
             </p></div></html>");
        let pr = props();
        let id = |n: &str| pr.id(n).unwrap();
        let (p, c) = (by_id(&e, d, "p"), by_id(&e, d, "c"));
        assert_eq!(computed_str(&mut e, p, pr.ids.color), "rgb(128, 128, 128)");
        // inherited colours and an unspecified currentcolor resolve on the element
        assert_eq!(computed_str(&mut e, c, pr.ids.color), "rgb(128, 128, 128)");
        assert_eq!(computed_str(&mut e, c, id("column-rule-color")), "rgb(128, 128, 128)");
        assert_eq!(computed_str(&mut e, c, pr.ids.background_color), "rgba(0, 0, 0, 0)");
        assert_eq!(computed_str(&mut e, c, id("border-top-color")), "rgb(255, 255, 255)");
        assert_eq!(computed_str(&mut e, c, id("outline-color")), "rgba(0, 0, 0, 0)"); // jsdom 30
        assert_eq!(computed_str(&mut e, c, id("width")), "40px");
        assert_eq!(computed_str(&mut e, c, id("height")), "30px");
        assert_eq!(computed_str(&mut e, c, id("margin-left")), "96px");
        assert_eq!(computed_str(&mut e, c, id("padding-top")), "76.8px");
        assert_eq!(computed_str(&mut e, c, pr.ids.line_height), "1.5");
        assert_eq!(computed_str(&mut e, c, id("text-indent")), "50%");
        assert_eq!(computed_str(&mut e, c, pr.ids.font_weight), "400");
        assert_eq!(computed_str(&mut e, c, pr.ids.font), "20px / 1.5 depends on user agent");
        // rem is 16px on the root element itself
        let root = document_element(&e, c);
        assert_eq!(computed_str(&mut e, root, pr.ids.font_size), "10px");
        assert_eq!(px(96.0 / 72.0 * 10.0), "13.3333px");
        assert_eq!(px(9.6e-7), "9.6e-7px");
        assert_eq!(px(1e21), "1e+21px");
        assert_eq!(length_px("10vh", || 0.0, || 0.0, None), None); // root element: jsdom leaves it
        assert_eq!(length_px("10vw", || 0.0, || 0.0, Some((500.0, 400.0))), Some(50.0));
        assert_eq!(length_px("1e1px", || 0.0, || 0.0, None), Some(10.0));
        assert_eq!(length_px("3ex", || 20.0, || 0.0, None), Some(30.0));
        assert_eq!(length_px("2", || 20.0, || 0.0, None), None);
        assert_eq!(length_px("calc(1em + 2px)", || 20.0, || 0.0, None), None);
    }

    /// A 300-row table under an author sheet of `rules` class-keyed rules, none matching (Tailwind- /
    /// CSS-module-sized sheets), either in one `<style>` or one `<style>` per rule (emotion's non-speedy
    /// mode in tests).
    fn big_sheet_doc(rules: usize, multi: bool) -> (Env, NodeId) {
        let mut css = String::new();
        let mut styles = String::new();
        for i in 0..rules {
            let r = if i % 2 == 0 {
                format!(".u{i}{{display:flex;color:red}}")
            } else {
                format!(".p{i}{{position:absolute}}")
            };
            if multi {
                styles.push_str(&format!("<style>{r}</style>"));
            } else {
                css.push_str(&r);
            }
        }
        let mut rows = String::new();
        for i in 0..300 {
            rows.push_str(&format!(
                "<tr class='row r{i}'><td class=cell>{i}</td><td class=cell><span>n</span></td><td><input type=checkbox></td><td><button>b</button></td><td><a href=#>l</a></td></tr>"
            ));
        }
        let html = format!(
            "<!DOCTYPE html><style>{css}</style>{styles}<main><section><div><table><tbody>{rows}</tbody></table></div></section></main>"
        );
        doc(&html)
    }

    /// `cargo test --release --lib timing_big_sheet -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn timing_big_sheet() {
        for (rules, multi) in [(0, false), (800, false), (400, true)] {
            let (mut e, d) = big_sheet_doc(rules, multi);
            let mut all = Vec::new();
            let mut n = d;
            while n != 0 {
                if e.is_element(n) {
                    all.push(n);
                }
                n = e.next_in_subtree(n, d);
            }
            let b = all.iter().copied().rfind(|&x| Atom(e.rec(x).local) == atom::BUTTON).unwrap();
            let color = props().ids.color;
            let mut s = 0u64;
            let reps = 20;
            let t = std::time::Instant::now();
            for _ in 0..reps {
                e.ep.bump(ep::STYLE);
                for &x in &all {
                    s += core(&mut e, x) as u64;
                }
            }
            let core_all = t.elapsed().as_secs_f64() * 1e3 / reps as f64;
            let n = 2000;
            let t = std::time::Instant::now();
            for _ in 0..n {
                e.ep.bump(ep::STYLE);
                s += core(&mut e, b) as u64;
            }
            let core_cold = t.elapsed().as_nanos() as f64 / n as f64;
            let t = std::time::Instant::now();
            for _ in 0..n {
                s += computed_str(&mut e, b, color).len() as u64;
            }
            let color_ns = t.elapsed().as_nanos() as f64 / n as f64;
            let t = std::time::Instant::now();
            for _ in 0..n {
                s += declared_props(&mut e, b).len() as u64;
            }
            let decl_ns = t.elapsed().as_nanos() as f64 / n as f64;
            println!(
                "rules={rules:4} multi={multi:5} elements={}: core_all {core_all:.3} ms, core_cold(button) {:.2} us, computed_str(color) {:.2} us, declared_props {:.2} us",
                all.len(),
                core_cold / 1e3,
                color_ns / 1e3,
                decl_ns / 1e3
            );
            assert!(s > 0);
        }
    }

    /// `cargo test --release --lib timing_core -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn timing_core() {
        let (mut e, d) = doc(
            "<!DOCTYPE html><main><section><div><table><tbody><tr><td><button id=b>b</button></td></tr></tbody></table></div></section></main>",
        );
        let b = by_id(&e, d, "b");
        let body = e.rec(b).parent;
        let _ = body;
        let n = 200_000;
        let t = std::time::Instant::now();
        let mut s = 0;
        for _ in 0..n {
            e.ep.bump(ep::STYLE);
            s += core(&mut e, b);
        }
        println!("core cold deep: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
        let t = std::time::Instant::now();
        for _ in 0..n {
            let authors = sheet::author_sheets(&e, e.rec(b).owner);
            s += compute_core(&e, b, 0x8000, adapter::quirks_of(&e, b), &authors);
        }
        println!("compute_core one element: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
        let td = e.rec(b).parent;
        let t = std::time::Instant::now();
        for _ in 0..n {
            s += compute_core(&e, td, 0x8000, adapter::quirks_of(&e, td), &Authors::default());
        }
        println!("compute_core td: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
        let ua = sheet::ua();
        let t = std::time::Instant::now();
        for _ in 0..n {
            let mut m = Matcher::new(&e, b, adapter::quirks_of(&e, b));
            let (by_tag, other) = ua.sheet.core_candidates(e.rec(b).local);
            for &i in by_tag.iter().chain(other) {
                s += m.matches(&ua.sheet.rules[i as usize]) as u32;
            }
        }
        println!(
            "match core candidates: {:.1} ns ({} + {} rules)",
            t.elapsed().as_nanos() as f64 / n as f64,
            ua.sheet.core_candidates(e.rec(b).local).0.len(),
            ua.sheet.core_candidates(e.rec(b).local).1.len()
        );
        let color = props().ids.color;
        let t = std::time::Instant::now();
        for _ in 0..n {
            s += computed_str(&mut e, b, color).len() as u32;
        }
        println!("computed_str color deep: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
        let t = std::time::Instant::now();
        for _ in 0..n {
            let st = Strs::new(&e, b, DEFAULT_VIEWPORT);
            s += st.cascaded(b, color).map_or(0, |v| v.len()) as u32;
        }
        println!("cascaded color one element: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
        assert!(s > 0);
    }
}
