//! Stylesheets: the UA sheet (data/css/default-stylesheet.css, jsdom's, parsed once per process) and
//! author `<style>` sheets (per document, in tree order, re-parsed lazily when their text changes).
//!
//! A rule list is flattened into one `Rule` per complex selector, bucketed by the rightmost compound's
//! id, class, attribute name or type selector (most selective first); the cascade only matches the
//! buckets an element can hit. `@media` follows jsdom (`all` / `screen` only); other at-rules are ignored.

use std::sync::{Arc, OnceLock};

use rustc_hash::FxHashMap;
use selectors::parser::{Component, Selector};
use smallvec::SmallVec;

use super::inline::InlineStyle;
use super::props::props;
use crate::atoms::{Atom, Interner, atom};
use crate::env::{Env, ep};
use crate::select::Pre;
use crate::select::adapter::{self, Impl};
use crate::table::NodeId;

/// Core properties as a bit set (`Rule::core`).
pub mod core_bit {
    /// display
    pub const DISPLAY: u8 = 1;
    /// visibility
    pub const VISIBILITY: u8 = 2;
    /// pointer-events
    pub const POINTER_EVENTS: u8 = 4;
    /// opacity
    pub const OPACITY: u8 = 8;
    /// position
    pub const POSITION: u8 = 16;
}

/// One complex selector of a style rule with its declarations.
pub struct Rule {
    /// The selector.
    pub sel: Selector<Impl>,
    /// Fast reject.
    pub pre: Pre,
    /// Specificity (packed, comparable).
    pub spec: u32,
    /// Source order within the cascade (UA rules first, then author sheets in tree order).
    pub order: u32,
    /// Declarations (shared by the selectors of one rule).
    pub decls: Arc<InlineStyle>,
    /// Core properties the declarations touch (`core_bit`).
    pub core: u8,
    /// Bucket of the rightmost compound (the merged author index re-buckets rules by it).
    pub bucket: Bucket,
    /// Declared properties as a 64-bit Bloom filter (`prop_bit`): single-property cascades skip rules
    /// that cannot declare the property before matching.
    pub bloom: u64,
}

/// Bloom bit of property id `p` (`Rule::bloom`).
#[inline]
pub fn prop_bit(p: u32) -> u64 {
    1u64 << (p & 63)
}

/// Bucket key of a rule: its rightmost compound's id, else class, else attribute names, else type
/// selector names (lower / as written), else universal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bucket {
    /// `#id`
    Id(u32),
    /// `.class`
    Class(u32),
    /// `[attr]` (both spellings; equal when the selector is lowercase)
    Attr(u32, u32),
    /// `tag` (lower name, name)
    Tag(u32, u32),
    /// anything else
    Universal,
}

/// Rule lists keyed by `Bucket` (`T`: a rule index in one sheet, or a `RuleRef` in the merged index).
pub struct Buckets<T> {
    by_id: FxHashMap<u32, SmallVec<[T; 2]>>,
    by_class: FxHashMap<u32, SmallVec<[T; 2]>>,
    by_attr: FxHashMap<u32, SmallVec<[T; 2]>>,
    by_tag: FxHashMap<u32, SmallVec<[T; 4]>>,
    universal: Vec<T>,
}

impl<T> Default for Buckets<T> {
    fn default() -> Self {
        Buckets {
            by_id: FxHashMap::default(),
            by_class: FxHashMap::default(),
            by_attr: FxHashMap::default(),
            by_tag: FxHashMap::default(),
            universal: Vec::new(),
        }
    }
}

impl<T: Copy> Buckets<T> {
    fn insert(&mut self, b: Bucket, v: T) {
        match b {
            Bucket::Id(a) => self.by_id.entry(a).or_default().push(v),
            Bucket::Class(a) => self.by_class.entry(a).or_default().push(v),
            Bucket::Attr(a, b) => {
                self.by_attr.entry(a).or_default().push(v);
                if b != a {
                    self.by_attr.entry(b).or_default().push(v);
                }
            }
            Bucket::Tag(a, b) => {
                self.by_tag.entry(a).or_default().push(v);
                if b != a {
                    self.by_tag.entry(b).or_default().push(v);
                }
            }
            Bucket::Universal => self.universal.push(v),
        }
    }

    /// Appends the rules element `el` could match (duplicates possible, order unspecified). Ids and
    /// classes are looked up case-sensitively: callers handle quirks-mode documents separately.
    pub fn candidates(&self, e: &Env, el: NodeId, out: &mut SmallVec<[T; 32]>) {
        out.extend_from_slice(&self.universal);
        let r = e.rec(el);
        if !self.by_tag.is_empty()
            && let Some(v) = self.by_tag.get(&r.local)
        {
            out.extend_from_slice(v);
        }
        let Some(d) = e.elem(el) else { return };
        if !d.id.is_none()
            && !self.by_id.is_empty()
            && let Some(v) = self.by_id.get(&d.id.0)
        {
            out.extend_from_slice(v);
        }
        if !self.by_class.is_empty() {
            for c in &d.classes {
                if let Some(v) = self.by_class.get(&c.0) {
                    out.extend_from_slice(v);
                }
            }
        }
        if !self.by_attr.is_empty() {
            for a in &d.attrs {
                if let Some(v) = self.by_attr.get(&a.local.0) {
                    out.extend_from_slice(v);
                }
            }
        }
    }
}

/// A rule of the merged author index: author sheet position (tree order, 0-based) and rule index.
#[derive(Clone, Copy, Debug)]
pub struct RuleRef {
    /// Position of the sheet in `author_sheets` order.
    pub sheet: u32,
    /// Index into that sheet's `rules`.
    pub rule: u32,
}

/// All author rules of one document, bucketed once (rebuilt lazily when the sheet set or any sheet's
/// text changes): a cascade does one UA lookup plus one author lookup per element, whatever the number of
/// rules and `<style>` elements.
#[derive(Default)]
pub struct AuthorIndex {
    /// The parsed sheets, tree order (`RuleRef::sheet` indexes this).
    pub sheets: Vec<Arc<Sheet>>,
    /// Every rule.
    pub all: Buckets<RuleRef>,
    /// Rules declaring a core property.
    pub core: Buckets<RuleRef>,
    /// Rules declaring a core property, flat (scanned directly while short: `FLAT_MAX`).
    pub core_flat: Vec<RuleRef>,
    /// Rules declaring each property, flat (single-property cascades scan these while short).
    pub by_prop: FxHashMap<u32, Vec<RuleRef>>,
}

/// Up to this many rules, scanning a flat list (`Pre::rejects` is a few ns per rule) beats the
/// bucket lookups (one hash probe per class / attribute of the element).
pub const FLAT_MAX: usize = 16;

impl AuthorIndex {
    fn build(sheets: Vec<Arc<Sheet>>) -> AuthorIndex {
        let mut ix = AuthorIndex::default();
        for (k, sh) in sheets.iter().enumerate() {
            for (i, r) in sh.rules.iter().enumerate() {
                let rr = RuleRef { sheet: k as u32, rule: i as u32 };
                ix.all.insert(r.bucket, rr);
                if r.core != 0 {
                    ix.core.insert(r.bucket, rr);
                    ix.core_flat.push(rr);
                }
                for d in &r.decls.decls {
                    let v = ix.by_prop.entry(d.prop).or_default();
                    if v.last().is_none_or(|l| l.sheet != rr.sheet || l.rule != rr.rule) {
                        v.push(rr);
                    }
                }
            }
        }
        ix.sheets = sheets;
        ix
    }
}

/// A document's merged author index (`None`: no author sheets).
#[derive(Default, Clone, Copy)]
pub struct Authors<'a> {
    /// The index (with its sheets), `Some` after `prepare` whenever the document has `<style>` sheets.
    pub index: Option<&'a AuthorIndex>,
}

/// A parsed sheet with its buckets.
#[derive(Default)]
pub struct Sheet {
    /// Rules.
    pub rules: Vec<Rule>,
    buckets: Buckets<u32>,
    /// Rules declaring a core property, by the rightmost type selector (0 = none).
    core_by_tag: FxHashMap<u32, SmallVec<[u32; 4]>>,
    /// Rules declaring a core property without a rightmost type selector.
    core_other: Vec<u32>,
    /// Rules declaring each property (single-property cascades: `csStr`).
    by_prop: FxHashMap<u32, Vec<u32>>,
    /// Some selector uses a state pseudo-class (`:checked`, `:focus`, ...).
    pub uses_state: bool,
    /// Attribute names the selectors test.
    pub attrs: SmallVec<[Atom; 8]>,
    /// Some selector reads character data (`:empty`, `:has()`).
    pub uses_text: bool,
}

impl Sheet {
    pub(crate) fn push(&mut self, sel: Selector<Impl>, decls: Arc<InlineStyle>, order: u32) {
        let pre = Pre::of(&sel);
        if pre.never {
            return;
        }
        let core = core_mask(&decls);
        let spec = sel.specificity();
        // bucket key from the rightmost compound (most selective first)
        let (mut id, mut class, mut attr, mut tag) = (0u32, 0u32, None, None);
        for c in sel.iter() {
            match c {
                Component::ID(a) => id = a.0.0,
                Component::Class(a) => class = a.0.0,
                Component::AttributeInNoNamespaceExists { local_name, local_name_lower } => {
                    attr = Some((local_name.0.0, local_name_lower.0.0));
                }
                Component::AttributeInNoNamespace { local_name, .. } => {
                    attr = Some((local_name.0.0, local_name.0.0))
                }
                Component::AttributeOther(o) => attr = Some((o.local_name.0.0, o.local_name_lower.0.0)),
                Component::LocalName(l) => tag = Some((l.lower_name.0.0, l.name.0.0)),
                _ => {}
            }
        }
        let bucket = if id != 0 {
            Bucket::Id(id)
        } else if class != 0 {
            Bucket::Class(class)
        } else if let Some((a, b)) = attr {
            Bucket::Attr(a, b)
        } else if let Some((a, b)) = tag {
            Bucket::Tag(a, b)
        } else {
            Bucket::Universal
        };
        let mut flags = crate::select::adapter_flags(&sel);
        self.uses_state |= flags.state;
        self.uses_text |= flags.text;
        for a in flags.attrs.drain(..) {
            if !self.attrs.contains(&a) {
                self.attrs.push(a);
            }
        }
        let idx = self.rules.len() as u32;
        if core != 0 {
            if pre.tag != 0 {
                self.core_by_tag.entry(pre.tag).or_default().push(idx);
                if pre.tag2 != pre.tag {
                    self.core_by_tag.entry(pre.tag2).or_default().push(idx);
                }
            } else {
                self.core_other.push(idx);
            }
        }
        let mut bloom = 0;
        for d in &decls.decls {
            bloom |= prop_bit(d.prop);
            let v = self.by_prop.entry(d.prop).or_default();
            if v.last() != Some(&idx) {
                v.push(idx);
            }
        }
        self.buckets.insert(bucket, idx);
        self.rules.push(Rule { sel, pre, spec, order, decls, core, bucket, bloom });
    }

    /// Rules declaring a core property that element `el` (local name atom `local`) could match.
    pub fn core_candidates(&self, local: u32) -> (&[u32], &[u32]) {
        (self.core_by_tag.get(&local).map_or(&[][..], |v| v.as_slice()), &self.core_other)
    }

    /// Rules declaring property `p`.
    pub fn prop_rules(&self, p: u32) -> &[u32] {
        self.by_prop.get(&p).map_or(&[][..], |v| v.as_slice())
    }

    /// Indexes of the rules element `el` could match (duplicates possible, order unspecified; ids and
    /// classes case-sensitive).
    pub fn candidates(&self, e: &Env, el: NodeId, out: &mut SmallVec<[u32; 32]>) {
        out.clear();
        self.buckets.candidates(e, el, out);
    }
}

fn core_mask(decls: &InlineStyle) -> u8 {
    let ids = &props().ids;
    let mut m = 0;
    for d in &decls.decls {
        m |= if d.prop == ids.display {
            core_bit::DISPLAY
        } else if d.prop == ids.visibility {
            core_bit::VISIBILITY
        } else if d.prop == ids.pointer_events {
            core_bit::POINTER_EVENTS
        } else if d.prop == ids.opacity {
            core_bit::OPACITY
        } else if d.prop == ids.position {
            core_bit::POSITION
        } else {
            0
        };
    }
    m
}

// ------------------------------------------------------------------------------------- parsing

/// jsdom `evaluateMediaList`: true for an empty list or when some query is exactly `all` / `screen`.
pub fn media_matches(list: &str) -> bool {
    let t = list.trim();
    t.is_empty()
        || t.split(',')
            .any(|q| q.trim().eq_ignore_ascii_case("all") || q.trim().eq_ignore_ascii_case("screen"))
}

/// Parses sheet text into the cascade's rule list (through the CSSOM rule tree, `cssom.rs`). Runs with the env's
/// interner installed for selectors and custom properties.
fn parse_sheet(text: &str) -> Sheet {
    super::cssom::parse_tree(text).0.to_sheet()
}

// ------------------------------------------------------------------------------------------ UA

static UA_CSS: &str = include_str!("../../data/css/default-stylesheet.css");
static UA: OnceLock<UaSheet> = OnceLock::new();

/// The UA sheet and the number of rules (author rule orders start after it).
pub struct UaSheet {
    /// The sheet.
    pub sheet: Sheet,
    /// Highest UA rule order.
    pub max_order: u32,
    /// Dynamic atoms the UA sheet would have needed (must be 0: every UA name is a static atom).
    pub dynamic_atoms: u32,
}

/// The process-wide UA sheet (parsed once; its selectors only use static atoms).
pub fn ua() -> &'static UaSheet {
    UA.get_or_init(|| {
        let mut tmp = Interner::new();
        let sheet = adapter::with_interner(&mut tmp, || parse_sheet(UA_CSS));
        let order = sheet.rules.len() as u32;
        let dynamic_atoms = tmp.len() - crate::atoms::STATIC_LEN;
        UaSheet { sheet, max_order: order, dynamic_atoms }
    })
}

// ------------------------------------------------------------------------------- author sheets

/// Text of a `<style>` element (its child text nodes, concatenated).
pub(crate) fn style_text(e: &Env, el: NodeId) -> String {
    let mut s = String::new();
    // HTML "update a style block": a `type` other than "" / "text/css" (ASCII case-insensitive) creates no
    // sheet (jsdom too).
    if e.get_attr(el, atom::TYPE)
        .is_some_and(|t| !t.is_empty() && !t.as_str().eq_ignore_ascii_case("text/css"))
    {
        return s;
    }
    let mut c = e.rec(el).first;
    while c != 0 {
        if let Some(t) = e.is_text(c).then(|| e.char_data(c)).flatten() {
            s.push_str(t);
        }
        c = e.rec(c).next;
    }
    s
}

/// A `<style>` element became connected: register it (tree order) in its document.
pub(crate) fn attach(e: &mut Env, el: NodeId) {
    let doc = e.rec(el).owner;
    let Some(dd) = e.doc_data(doc) else { return };
    if dd.style.sheets.contains(&el) {
        return;
    }
    let mut list = dd.style.sheets.clone();
    let pos = list.iter().position(|&x| e.tree_order(el, x).is_lt()).unwrap_or(list.len());
    list.insert(pos, el);
    if let Some(dd) = e.doc_data_mut(doc) {
        dd.style.sheets = list;
        dd.style.index = None;
    }
    e.style.sheets.insert(el, None);
    e.style.sheet_count += 1;
    e.ep.bump(ep::STYLE);
}

/// A `<style>` element was disconnected.
pub(crate) fn detach(e: &mut Env, el: NodeId) {
    super::cssom::detach_owner(e, el);
    let doc = e.rec(el).owner;
    if let Some(dd) = e.doc_data_mut(doc) {
        dd.style.sheets.retain(|x| *x != el);
        dd.style.index = None;
    }
    if e.style.sheets.remove(&el).is_some() {
        e.style.sheet_count = e.style.sheet_count.saturating_sub(1);
        refresh_deps(e);
    }
    e.ep.bump(ep::STYLE);
}

/// The text of a registered `<style>` element changed.
pub(crate) fn mark_dirty(e: &mut Env, el: NodeId) {
    super::cssom::detach_owner(e, el);
    if let Some(s) = e.style.sheets.get_mut(&el) {
        *s = None;
        let doc = e.rec(el).owner;
        if let Some(dd) = e.doc_data_mut(doc) {
            dd.style.index = None;
        }
    }
}

fn refresh_deps(e: &mut Env) {
    let mut attrs: SmallVec<[Atom; 8]> = SmallVec::new();
    let mut state = false;
    let mut text = false;
    for s in e.style.sheets.values().flatten() {
        state |= s.uses_state;
        text |= s.uses_text;
        for a in &s.attrs {
            if !attrs.contains(a) {
                attrs.push(*a);
            }
        }
    }
    e.style.sheet_attrs = attrs;
    e.style.sheet_state = state;
    e.style.sheet_text = text;
    e.ep.set(super::EP_STYLE_DEP, state as u32);
}

/// Parses the dirty sheets of `doc` and rebuilds its merged author index (call before a cascade). A
/// valid index means no sheet of `doc` is dirty: then this returns without touching the sheet list.
pub(crate) fn prepare(e: &mut Env, doc: NodeId) {
    let Some(dd) = e.doc_data(doc) else { return };
    if dd.style.sheets.is_empty() || dd.style.index.is_some() {
        return;
    }
    let list = dd.style.sheets.clone();
    let mut changed = false;
    for &el in &list {
        if matches!(e.style.sheets.get(&el), Some(Some(_))) {
            continue;
        }
        let sheet = match super::cssom::owned_sheet(e, el) {
            Some(s) => s,
            None => {
                let text = style_text(e, el);
                adapter::with_interner(&mut e.atoms, || parse_sheet(&text))
            }
        };
        e.ep.set(ep::ATOM_LEN, e.atoms.len());
        e.style.sheets.insert(el, Some(Arc::new(sheet)));
        changed = true;
    }
    if changed {
        refresh_deps(e);
    }
    let sheets: Vec<Arc<Sheet>> =
        list.iter().filter_map(|el| e.style.sheets.get(el).cloned().flatten()).collect();
    let index = AuthorIndex::build(sheets);
    if let Some(dd) = e.doc_data_mut(doc) {
        dd.style.index = Some(Box::new(index));
    }
}

/// The parsed author sheets of `doc` in tree order and their merged index (after `prepare`).
pub fn author_sheets<'a>(e: &'a Env, doc: NodeId) -> Authors<'a> {
    Authors { index: e.doc_data(doc).and_then(|dd| dd.style.index.as_deref()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ua_sheet_uses_static_atoms_only() {
        let ua = ua();
        assert_eq!(
            ua.dynamic_atoms, 0,
            "every UA stylesheet name must be a static atom (data/atoms/41-style.txt)"
        );
        assert!(ua.sheet.rules.len() > 150, "{} rules", ua.sheet.rules.len());
    }

    #[test]
    fn media() {
        assert!(media_matches(""));
        assert!(media_matches("screen"));
        assert!(media_matches("print, all"));
        assert!(!media_matches("(scripting)"));
        assert!(!media_matches("(min-width: 1px)"));
    }
}
