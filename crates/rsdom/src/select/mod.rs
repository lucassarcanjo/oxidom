//! AREA A (selectors): `selectors` 0.41 adapter, compiled-selector cache, prefilter metadata, qSA,
//! matches/closest, getElementsBy* (DESIGN §6, ROADMAP M3).
//!
//! - `adapter`: the `SelectorImpl`, parser and `Element` implementation over the arena.
//! - compiled selectors live in `Env.sel` (`SelectState`), addressed by a small integer `sel` id that the
//!   facade caches per selector string (the JS `SEL` map) and frees when it evicts the string.
//! - Rust fast paths (§6.2): the rightmost compound's tag / id / classes are checked against the node
//!   record and `ElementData` before `selectors` runs; a lone `#id` uses the document id map;
//!   `qsa` is one preorder walk with one `MatchingContext` (document order, no duplicates).

pub mod adapter;

use selectors::context::{
    MatchingContext, MatchingForInvalidation, MatchingMode, NeedsSelectorFlags, QuirksMode, SelectorCaches,
};
use selectors::matching::matches_selector;
use selectors::parser::{Component, ParseRelative, RelativeSelector, Selector, SelectorList};
use selectors::visitor::{SelectorListKind, SelectorVisitor};
use selectors::{Element, OpaqueElement};
use smallvec::SmallVec;

use crate::atoms::{Atom, atom};
use crate::env::{Env, ep};
use crate::node::{kind, meta};
use crate::table::NodeId;
use adapter::{ERef, Impl, PseudoClass, SAtom, SelParser};

/// Flags written to OUT[0] by `compileSel` (mirrored in packages/rsdom/lib/select.cjs).
pub mod sel_flags {
    /// Every complex selector is a lone type selector (`div`, `a, b`): a tag hit is a match.
    pub const TAG_ONLY: u32 = 1;
    /// Matching reads mutable non-attribute state (form state bits, values, focus).
    pub const STATE: u32 = 2;
    /// Uses `:focus`, `:focus-within` or `:focus-visible`.
    pub const FOCUS: u32 = 4;
    /// Contains a pseudo-element (never matches an element).
    pub const PSEUDO_ELEMENT: u32 = 8;
    /// Uses `:empty`, `:has()` or other structure that depends on text content.
    pub const TEXT: u32 = 16;
    /// Uses `:nth-*()` or `:has()`: matching writes the `selectors` caches (needs fresh ones per call).
    pub const CACHES: u32 = 32;
}

/// Rightmost-compound requirements of one complex selector (Rust fast path, DESIGN §6.2): the type
/// selector, id, classes and the attribute names it tests outside `:not()` (presence is necessary for
/// every attribute selector, whatever its operator: a positive-only requirement, never derived from
/// negations).
#[derive(Default, Debug, Clone)]
pub struct Pre {
    /// Lowercase type-selector atom (0 = none) and the as-written atom (equal when already lowercase).
    pub tag: u32,
    /// As-written type-selector atom.
    pub tag2: u32,
    /// Required id (NONE = none).
    pub id: Atom,
    /// Required classes.
    pub classes: SmallVec<[Atom; 2]>,
    /// Required attributes: (lowercase local name, as-written local name) atoms.
    pub attrs: SmallVec<[(u32, u32); 2]>,
    /// The selector can never match an element (pseudo-element).
    pub never: bool,
    /// The compound contains `:link` / `:any-link`: only `<a>` / `<area>` can match.
    pub link: bool,
    /// The compound contains `:focus` / `:focus-visible`: only the focused element (or, for `:focus`, a shadow host)
    /// can match.
    pub focus: bool,
    /// `rejects` alone decides the match (`decided`): 1 = always, 2 = outside quirks mode only (ids /
    /// classes are prechecked there), 0 = never.
    pub decides: u8,
}

impl Pre {
    /// True if `el` certainly does not match (cheap checks only). `quirks`: ids/classes are compared
    /// ASCII-case-insensitively there, so they are not prechecked.
    #[inline]
    pub fn rejects(&self, e: &Env, el: NodeId, quirks: bool) -> bool {
        if self.never {
            return true;
        }
        let r = e.rec(el);
        if self.tag != 0 && r.local != self.tag && r.local != self.tag2 {
            return true;
        }
        if self.link && !(e.is_html_elem(el, atom::A) || e.is_html_elem(el, atom::AREA)) {
            return true;
        }
        // a shadow host matches :focus when its shadow tree holds the focus (adapter `host_of_focus`)
        if self.focus && r.state & crate::node::state::FOCUSED == 0 && r.meta & crate::node::meta::SHADOW == 0
        {
            return true;
        }
        let check_ids = !quirks && !(self.id.is_none() && self.classes.is_empty());
        if !check_ids && self.attrs.is_empty() {
            return false;
        }
        let Some(d) = e.elem(el) else { return true };
        if check_ids {
            if !self.id.is_none() && d.id != self.id {
                return true;
            }
            if self.classes.iter().any(|c| !d.classes.contains(c)) {
                return true;
            }
        }
        self.attrs
            .iter()
            .any(|&(lower, name)| !d.attrs.iter().any(|a| a.local.0 == lower || a.local.0 == name))
    }

    /// True if passing `rejects` means `el` matches: the selector is one compound of only `*`, a
    /// lowercase type selector, an id and at most 4 classes (ids / classes only outside quirks mode).
    #[inline]
    pub fn decided(&self, quirks: bool) -> bool {
        self.decides == 1 || (self.decides == 2 && !quirks)
    }

    /// Fast-path requirements of one complex selector.
    pub fn of(sel: &Selector<Impl>) -> Pre {
        let mut p = Pre::default();
        let mut it = sel.iter();
        for c in &mut it {
            match c {
                Component::LocalName(ln) => {
                    p.tag = ln.lower_name.0.0;
                    p.tag2 = ln.name.0.0;
                }
                Component::ID(a) => p.id = a.0,
                Component::Class(a) => {
                    if p.classes.len() < 4 {
                        p.classes.push(a.0);
                    }
                }
                Component::AttributeInNoNamespaceExists { local_name, local_name_lower } => {
                    p.attrs.push((local_name_lower.0.0, local_name.0.0));
                }
                Component::AttributeInNoNamespace { local_name, .. } => {
                    p.attrs.push((local_name.0.0, local_name.0.0))
                }
                Component::AttributeOther(o) => p.attrs.push((o.local_name_lower.0.0, o.local_name.0.0)),
                Component::PseudoElement(_)
                | Component::Slotted(_)
                | Component::Part(_)
                | Component::NonTSPseudoClass(PseudoClass::Never(_) | PseudoClass::Dir(None, _)) => {
                    p.never = true
                }
                Component::NonTSPseudoClass(PseudoClass::Link | PseudoClass::AnyLink) => p.link = true,
                Component::NonTSPseudoClass(PseudoClass::Focus | PseudoClass::FocusVisible) => p.focus = true,
                _ => {}
            }
        }
        p.decides = decides(sel);
        p
    }
}

/// `Pre::decides` of a complex selector (see there).
fn decides(sel: &Selector<Impl>) -> u8 {
    let (mut ids, mut classes) = (0, 0);
    for c in sel.iter_raw_match_order() {
        match c {
            Component::ExplicitUniversalType => {}
            Component::LocalName(l) if l.name == l.lower_name => {}
            Component::ID(_) => ids += 1,
            Component::Class(_) => classes += 1,
            _ => return 0,
        }
    }
    // `Pre` keeps one id and at most 4 classes
    let ids_or_classes = ids + classes != 0;
    if ids > 1 || classes > 4 {
        0
    } else if ids_or_classes {
        2
    } else {
        1
    }
}

/// A compiled selector list.
pub struct Compiled {
    /// The parsed list.
    pub list: SelectorList<Impl>,
    /// Fast-path requirements, one per complex selector.
    pub pre: SmallVec<[Pre; 2]>,
    /// `sel_flags`.
    pub flags: u32,
    /// Lowercase type atoms for the JS prefilter (empty = no prefilter).
    pub tags: SmallVec<[u32; 4]>,
    /// The list is exactly one `#id` simple selector.
    pub id_only: Atom,
    /// Attribute local names the list tests (author-sheet STYLE invalidation, area A style/).
    pub attrs: SmallVec<[Atom; 4]>,
}

/// Collects flags and tested attribute names over every component (nested lists included).
struct FlagVisitor {
    flags: u32,
    attrs: SmallVec<[Atom; 4]>,
}

impl SelectorVisitor for FlagVisitor {
    type Impl = Impl;

    fn visit_attribute_selector(
        &mut self,
        _ns: &selectors::attr::NamespaceConstraint<&SAtom>,
        local_name: &SAtom,
        local_name_lower: &SAtom,
    ) -> bool {
        for a in [local_name.0, local_name_lower.0] {
            if !self.attrs.contains(&a) {
                self.attrs.push(a);
            }
        }
        true
    }

    fn visit_simple_selector(&mut self, c: &Component<Impl>) -> bool {
        match c {
            Component::NonTSPseudoClass(pc) => {
                for &a in pc.attr_deps() {
                    if !self.attrs.contains(&a) {
                        self.attrs.push(a);
                    }
                }
                if pc.uses_state() {
                    self.flags |= sel_flags::STATE;
                }
                if pc.uses_focus() {
                    self.flags |= sel_flags::FOCUS;
                }
                if matches!(
                    pc,
                    PseudoClass::PlaceholderShown
                        | PseudoClass::Valid
                        | PseudoClass::Invalid
                        | PseudoClass::Dir(..)
                ) {
                    self.flags |= sel_flags::TEXT;
                }
            }
            Component::Empty => self.flags |= sel_flags::TEXT,
            Component::Has(_) => self.flags |= sel_flags::TEXT | sel_flags::CACHES,
            Component::Nth(_) | Component::NthOf(_) => self.flags |= sel_flags::CACHES,
            Component::PseudoElement(_) | Component::Slotted(_) | Component::Part(_) => {
                self.flags |= sel_flags::PSEUDO_ELEMENT
            }
            _ => {}
        }
        true
    }

    fn visit_relative_selector_list(&mut self, list: &[RelativeSelector<Impl>]) -> bool {
        for r in list {
            r.selector.visit(self);
        }
        true
    }

    fn visit_selector_list(&mut self, _kind: SelectorListKind, list: &[Selector<Impl>]) -> bool {
        for s in list {
            s.visit(self);
        }
        true
    }
}

/// What a selector depends on besides the tree (used by stylesheet invalidation).
pub struct SelDeps {
    /// Uses a state pseudo-class (`:checked`, `:focus`, values, validity).
    pub state: bool,
    /// Attribute names it tests, including the attributes pseudo-classes read (`:disabled` ->
    /// `disabled`, `:lang()` -> `lang`, ...; `PseudoClass::attr_deps`).
    pub attrs: SmallVec<[Atom; 4]>,
    /// Matching reads character data (`:empty`, `:has()`): text changes must invalidate.
    pub text: bool,
}

/// Dependencies of one complex selector (nested lists included).
pub fn adapter_flags(sel: &Selector<Impl>) -> SelDeps {
    let mut v = FlagVisitor { flags: 0, attrs: SmallVec::new() };
    sel.visit(&mut v);
    SelDeps {
        state: v.flags & (sel_flags::STATE | sel_flags::FOCUS) != 0,
        attrs: v.attrs,
        text: v.flags & sel_flags::TEXT != 0,
    }
}

/// Parses `s` into a selector list, interning names into `e`'s atom table. `None` = SyntaxError.
pub fn parse_selector_list(e: &mut Env, s: &str) -> Option<SelectorList<Impl>> {
    let r = adapter::with_interner(&mut e.atoms, || {
        let s = crate::string::css_input(s);
        let mut p = cssparser::Parser::new(&s);
        match SelectorList::parse(&SelParser, &mut p, ParseRelative::No) {
            Ok(l) if p.is_exhausted() => Some(l),
            _ => None,
        }
    });
    e.ep.set(ep::ATOM_LEN, e.atoms.len());
    r
}

impl Compiled {
    /// Builds the fast-path metadata of a parsed list.
    pub fn new(list: SelectorList<Impl>) -> Compiled {
        let mut v = FlagVisitor { flags: 0, attrs: SmallVec::new() };
        let mut pre = SmallVec::new();
        let mut tags: SmallVec<[u32; 4]> = SmallVec::new();
        let mut all_tagged = true;
        let mut tag_only = true;
        for sel in list.slice() {
            sel.visit(&mut v);
            let p = Pre::of(sel);
            if p.tag == 0 {
                all_tagged = false;
            } else if !tags.contains(&p.tag) {
                tags.push(p.tag);
            }
            let raw: Vec<&Component<Impl>> = sel.iter_raw_match_order().collect();
            if !(raw.len() == 1 && matches!(raw[0], Component::LocalName(_))) {
                tag_only = false;
            }
            pre.push(p);
        }
        let mut flags = v.flags;
        if !all_tagged {
            tags.clear();
            tag_only = false;
        }
        if tag_only {
            flags |= sel_flags::TAG_ONLY;
        }
        let id_only = match list.slice() {
            [one] => {
                let raw: Vec<&Component<Impl>> = one.iter_raw_match_order().collect();
                match raw.as_slice() {
                    [Component::ID(a)] => a.0,
                    _ => Atom::NONE,
                }
            }
            _ => Atom::NONE,
        };
        Compiled { list, pre, flags, tags, id_only, attrs: v.attrs }
    }
}

/// Compiled selectors of one env (`Env.sel`).
#[derive(Default)]
pub struct SelectState {
    sels: Vec<Option<Box<Compiled>>>,
    free: Vec<u32>,
    /// Reused `selectors` caches for lists without `sel_flags::CACHES` (they never write them; building
    /// a fresh `SelectorCaches` costs ~25 ns per `matches()`).
    caches: std::cell::RefCell<SelectorCaches>,
}

impl std::fmt::Debug for SelectState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SelectState({} live)", self.sels.iter().filter(|s| s.is_some()).count())
    }
}

impl SelectState {
    fn get(&self, sel: u32) -> Option<&Compiled> {
        self.sels.get(sel as usize).and_then(|s| s.as_deref())
    }

    fn insert(&mut self, c: Compiled) -> u32 {
        if self.sels.is_empty() {
            self.sels.push(None); // id 0 = invalid
        }
        match self.free.pop() {
            Some(i) => {
                self.sels[i as usize] = Some(Box::new(c));
                i
            }
            None => {
                self.sels.push(Some(Box::new(c)));
                (self.sels.len() - 1) as u32
            }
        }
    }

    fn remove(&mut self, sel: u32) {
        if let Some(slot) = self.sels.get_mut(sel as usize) {
            if slot.take().is_some() {
                self.free.push(sel);
            }
        }
    }
}

/// A matching context for elements of the document of `el`.
fn ctx<'a>(
    caches: &'a mut SelectorCaches,
    quirks: QuirksMode,
    scope: Option<OpaqueElement>,
) -> MatchingContext<'a, Impl> {
    let mut c = MatchingContext::new(
        MatchingMode::Normal,
        None,
        caches,
        quirks,
        NeedsSelectorFlags::No,
        MatchingForInvalidation::No,
    );
    c.scope_element = scope;
    c
}

/// Matches `el` against `c` with an existing context (fast-path prechecks first).
#[inline]
fn match_in(e: &Env, c: &Compiled, el: NodeId, quirks: bool, cx: &mut MatchingContext<Impl>) -> bool {
    let er = ERef { e, id: el };
    for (sel, pre) in c.list.slice().iter().zip(&c.pre) {
        if pre.rejects(e, el, quirks) {
            continue;
        }
        if pre.decided(quirks) || matches_selector(sel, 0, None, &er, cx) {
            return true;
        }
    }
    false
}

#[inline]
fn is_elem(e: &Env, id: NodeId) -> bool {
    e.rec(id).meta & meta::KIND_MASK == kind::ELEMENT
}

/// Runs `f` with `selectors` caches: the env's reused ones for lists without `sel_flags::CACHES` (they
/// never write them; building a fresh `SelectorCaches` costs ~25-35 ns), fresh ones otherwise or when
/// the shared ones are borrowed.
#[inline]
fn with_caches<R>(e: &Env, c: &Compiled, f: impl FnOnce(&mut SelectorCaches) -> R) -> R {
    if c.flags & sel_flags::CACHES == 0
        && let Ok(mut caches) = e.sel.caches.try_borrow_mut()
    {
        return f(&mut caches);
    }
    f(&mut SelectorCaches::default())
}

/// True if `el` matches the compiled list `c`; `scope` is the `:scope` element.
pub fn element_matches(e: &Env, c: &Compiled, el: NodeId, scope: NodeId) -> bool {
    if !is_elem(e, el) {
        return false;
    }
    let q = adapter::quirks_of(e, el);
    let scope = (scope != 0).then(|| ERef { e, id: scope }.opaque());
    with_caches(e, c, |caches| {
        let mut cx = ctx(caches, q, scope);
        match_in(e, c, el, q == QuirksMode::Quirks, &mut cx)
    })
}

impl Env {
    /// `compileSel`: parses `s`, stores it, writes `[flags, nTags, tags...]` into OUT. 0 = SyntaxError.
    pub fn compile_sel(&mut self, s: &str) -> u32 {
        let Some(list) = parse_selector_list(self, s) else { return 0 };
        let c = Compiled::new(list);
        let mut out: SmallVec<[u32; 8]> = SmallVec::new();
        out.push(c.flags);
        out.push(c.tags.len() as u32);
        out.extend_from_slice(&c.tags);
        let id = self.sel.insert(c);
        self.write_out(&out);
        id
    }

    /// `matches(id, sel)`.
    pub fn sel_matches(&self, el: NodeId, sel: u32) -> bool {
        match self.sel.get(sel) {
            Some(c) => element_matches(self, c, el, el),
            None => false,
        }
    }

    /// `closest(id, sel)`: the nearest inclusive ancestor element that matches (0 = none).
    pub fn sel_closest(&self, el: NodeId, sel: u32) -> NodeId {
        let Some(c) = self.sel.get(sel) else { return 0 };
        if !is_elem(self, el) {
            return 0;
        }
        let q = adapter::quirks_of(self, el);
        let scope = Some(ERef { e: self, id: el }.opaque());
        with_caches(self, c, |caches| {
            let mut cx = ctx(caches, q, scope);
            let mut n = el;
            while n != 0 && is_elem(self, n) {
                if match_in(self, c, n, q == QuirksMode::Quirks, &mut cx) {
                    return n;
                }
                n = self.rec(n).parent;
            }
            0
        })
    }

    /// Descendants of `root` matching `sel`, in tree order (`first`: stop at the first one).
    fn sel_query(&mut self, root: NodeId, sel: u32, first: bool) -> u32 {
        let mut ids = std::mem::take(&mut self.ids);
        ids.clear();
        if let Some(c) = self.sel.get(sel) {
            // the id map is case-sensitive: quirks-mode documents match ids ASCII-case-insensitively
            if !c.id_only.is_none()
                && self.in_document_tree(root)
                && adapter::quirks_of(self, root) != QuirksMode::Quirks
            {
                self.ids_by_id_map(root, c.id_only, first, &mut ids);
            } else {
                query_walk(self, c, root, first, &mut ids);
            }
        }
        self.ids = ids;
        if first {
            return self.ids.first().copied().unwrap_or(0);
        }
        self.write_ids()
    }

    /// `#id` fast path through the document id map (connected roots only).
    fn ids_by_id_map(&self, root: NodeId, id: Atom, first: bool, out: &mut Vec<NodeId>) {
        let r = self.rec(root);
        let Some(doc) = self.doc_data(r.owner) else { return };
        let Some(cands) = doc.id_map.get(&id) else { return };
        let whole_doc = root == doc.id;
        for &c in cands {
            if whole_doc || (c != root && self.is_inclusive_ancestor(root, c)) {
                out.push(c);
            }
        }
        if out.len() > 1 {
            out.sort_by(|&a, &b| self.tree_order(a, b));
        }
        if first {
            out.truncate(1);
        }
    }

    /// `getElementsByTagName(qualifiedName)` under `root` (descendants only) into OUT.
    pub fn by_tag(&mut self, root: NodeId, qname: &str) -> u32 {
        let mut ids = std::mem::take(&mut self.ids);
        ids.clear();
        let all = qname == "*";
        let exact = self.atoms.get(qname).map_or(0, |a| a.0);
        let lower = if qname.bytes().any(|b| b.is_ascii_uppercase()) {
            self.atoms.get(&qname.to_ascii_lowercase()).map_or(0, |a| a.0)
        } else {
            exact
        };
        let mut n = self.next_in_subtree(root, root);
        while n != 0 {
            let r = self.rec(n);
            if r.meta & meta::KIND_MASK == kind::ELEMENT {
                let hit = if all {
                    true
                } else if r.meta & meta::HAS_PREFIX != 0 {
                    self.qualified_name_is(
                        n,
                        qname,
                        r.meta & (meta::NS_MASK | meta::HTML_DOC) == meta::HTML_DOC,
                    )
                } else if r.meta & (meta::NS_MASK | meta::HTML_DOC) == meta::HTML_DOC {
                    r.local == lower && lower != 0
                } else {
                    r.local == exact && exact != 0
                };
                if hit {
                    ids.push(n);
                }
            }
            n = self.next_in_subtree(n, root);
        }
        self.ids = ids;
        self.write_ids()
    }

    /// Element qualified name (`prefix:local` or `local`) equals `qname` (lowercased first for HTML
    /// elements in HTML documents). Only used for prefixed / other-namespace elements.
    fn qualified_name_is(&self, el: NodeId, qname: &str, html: bool) -> bool {
        let Some(d) = self.elem(el) else { return false };
        let local = self.atoms.name(Atom(self.rec(el).local));
        let want = if html { std::borrow::Cow::Owned(qname.to_ascii_lowercase()) } else { qname.into() };
        if d.prefix.is_none() {
            return local == want.as_ref();
        }
        let p = self.atoms.name(d.prefix);
        want.len() == p.len() + 1 + local.len()
            && want.starts_with(p)
            && want.as_bytes()[p.len()] == b':'
            && want.ends_with(local)
    }

    /// `getElementsByTagNameNS(ns, local)` under `root` into OUT (`ns` None = no namespace, `"*"` = any;
    /// `local` `"*"` = any).
    pub fn by_tag_ns(&mut self, root: NodeId, ns: Option<&str>, local: &str) -> u32 {
        let mut ids = std::mem::take(&mut self.ids);
        ids.clear();
        let any_ns = ns == Some("*");
        let ns_atom = match ns {
            Some("*") | None => Some(Atom::NONE),
            Some(s) => self.atoms.get(s),
        };
        let any_local = local == "*";
        let local_atom = self.atoms.get(local).map_or(0, |a| a.0);
        if let Some(ns_atom) = ns_atom {
            let mut n = self.next_in_subtree(root, root);
            while n != 0 {
                let r = self.rec(n);
                if r.meta & meta::KIND_MASK == kind::ELEMENT
                    && (any_local || (local_atom != 0 && r.local == local_atom))
                    && (any_ns || self.elem(n).is_some_and(|d| d.ns == ns_atom))
                {
                    ids.push(n);
                }
                n = self.next_in_subtree(n, root);
            }
        }
        self.ids = ids;
        self.write_ids()
    }

    /// `getElementsByClassName(names)` under `root` into OUT.
    pub fn by_class(&mut self, root: NodeId, names: &str) -> u32 {
        let mut ids = std::mem::take(&mut self.ids);
        ids.clear();
        let toks: SmallVec<[&str; 4]> =
            names.split([' ', '\t', '\n', '\r', '\u{c}']).filter(|t| !t.is_empty()).collect();
        if !toks.is_empty() {
            let quirks =
                self.doc_data(self.rec(root).owner).is_some_and(|d| d.quirks == crate::node::Quirks::Quirks);
            let atoms: Option<SmallVec<[Atom; 4]>> = toks.iter().map(|t| self.atoms.get(t)).collect();
            if quirks || atoms.is_some() {
                let atoms = atoms.unwrap_or_default();
                let mut n = self.next_in_subtree(root, root);
                while n != 0 {
                    let r = self.rec(n);
                    if r.meta & (meta::KIND_MASK | meta::HAS_CLASS) == kind::ELEMENT | meta::HAS_CLASS {
                        if let Some(d) = self.elem(n) {
                            let hit = if quirks {
                                toks.iter().all(|t| {
                                    d.classes.iter().any(|c| self.atoms.name(*c).eq_ignore_ascii_case(t))
                                })
                            } else {
                                atoms.iter().all(|a| d.classes.contains(a))
                            };
                            if hit {
                                ids.push(n);
                            }
                        }
                    }
                    n = self.next_in_subtree(n, root);
                }
            }
        }
        self.ids = ids;
        self.write_ids()
    }

    /// `document.getElementsByName(name)`: HTML elements whose `name` attribute equals `name`, into OUT.
    pub fn by_name(&mut self, doc: NodeId, name: &str) -> u32 {
        let mut ids = std::mem::take(&mut self.ids);
        ids.clear();
        let mut n = self.next_in_subtree(doc, doc);
        while n != 0 {
            let r = self.rec(n);
            if r.meta & (meta::KIND_MASK | meta::NS_MASK) == kind::ELEMENT
                && self.get_attr(n, atom::NAME).is_some_and(|v| v.as_str() == name)
            {
                ids.push(n);
            }
            n = self.next_in_subtree(n, doc);
        }
        self.ids = ids;
        self.write_ids()
    }

    /// The elements behind `document[name]` (HTML "dom-document-nameditem-filter", jsdom Document-impl.js
    /// `#namedPropertyElements`), in tree order, into OUT: HTML embed / form / iframe / img / object elements
    /// named `name`, and object elements, or img elements with a non-empty name, whose id is `name`. Null-namespace
    /// attributes only.
    pub fn doc_named(&mut self, doc: NodeId, name: &str) -> u32 {
        let mut ids = std::mem::take(&mut self.ids);
        ids.clear();
        let mut n = if name.is_empty() { 0 } else { self.next_in_subtree(doc, doc) };
        while n != 0 {
            let r = self.rec(n);
            let local = Atom(r.local);
            if r.meta & (meta::KIND_MASK | meta::NS_MASK) == kind::ELEMENT
                && matches!(local, atom::EMBED | atom::FORM | atom::IFRAME | atom::IMG | atom::OBJECT)
            {
                let own_name = self.get_attr_ns(n, None, "name").map(|v| v.as_str());
                let by_id = (local == atom::OBJECT
                    || (local == atom::IMG && own_name.is_some_and(|v| !v.is_empty())))
                    && self.get_attr_ns(n, None, "id").is_some_and(|v| v.as_str() == name);
                if by_id || own_name == Some(name) {
                    ids.push(n);
                }
            }
            n = self.next_in_subtree(n, doc);
        }
        self.ids = ids;
        self.write_ids()
    }
}

/// One preorder walk over the descendants of `root`.
fn query_walk(e: &Env, c: &Compiled, root: NodeId, first: bool, out: &mut Vec<NodeId>) {
    if c.pre.iter().all(|p| p.never) {
        return;
    }
    let q = adapter::quirks_of(e, root);
    let quirks = q == QuirksMode::Quirks;
    if let [p] = c.pre.as_slice()
        && p.decides == 1
        && p.tag == 0
    {
        // `*`: every element (DTL's ByText / ByLabelText query `container.querySelectorAll('*')`)
        let mut n = e.next_in_subtree(root, root);
        while n != 0 {
            if is_elem(e, n) {
                out.push(n);
                if first {
                    return;
                }
            }
            n = e.next_in_subtree(n, root);
        }
        return;
    }
    let scope = is_elem(e, root).then(|| ERef { e, id: root }.opaque());
    with_caches(e, c, |caches| {
        let mut cx = ctx(caches, q, scope);
        let mut n = e.next_in_subtree(root, root);
        while n != 0 {
            if is_elem(e, n) && match_in(e, c, n, quirks, &mut cx) {
                out.push(n);
                if first {
                    return;
                }
            }
            n = e.next_in_subtree(n, root);
        }
    })
}

natives! {
    /// getElementById: first element with id atom `a` among the descendants of `root` (doc or fragment).
    fn byId(e, root: u32, a: u32) -> u32 {
        e.get_element_by_id(root, Atom(a))
    }
    /// Compile a selector list; returns its id (0 = SyntaxError) and writes OUT = [flags, nTags, tags...] (prefilter metadata, DESIGN §6.3).
    fn compileSel(e, s: str) -> u32 {
        e.compile_sel(s)
    }
    /// Release a compiled selector (the facade evicted its string from the SEL cache).
    fn selFree(e, sel: u32) -> () {
        e.sel.remove(sel)
    }
    /// Element.matches(sel).
    fn matches(e, id: u32, sel: u32) -> bool {
        e.sel_matches(id, sel)
    }
    /// Element.closest(sel): nearest inclusive ancestor element that matches (0 = none).
    fn closest(e, id: u32, sel: u32) -> u32 {
        e.sel_closest(id, sel)
    }
    /// querySelector: first matching descendant of `root` in tree order (0 = none).
    fn qs(e, root: u32, sel: u32) -> u32 {
        e.sel_query(root, sel, true)
    }
    /// querySelectorAll: matching descendants of `root` in tree order into OUT; returns the count.
    fn qsa(e, root: u32, sel: u32) -> u32 {
        e.sel_query(root, sel, false)
    }
    /// getElementsByTagName(qualifiedName) under `root` into OUT; returns the count.
    fn byTag(e, root: u32, qname: str) -> u32 {
        e.by_tag(root, qname)
    }
    /// getElementsByTagNameNS(namespace, localName) under `root` into OUT (namespace null = none, "*" = any); returns the count.
    fn byTagNS(e, root: u32, ns: ostr, local: str) -> u32 {
        e.by_tag_ns(root, ns, local)
    }
    /// getElementsByClassName(classNames) under `root` into OUT; returns the count.
    fn byClass(e, root: u32, names: str) -> u32 {
        e.by_class(root, names)
    }
    /// document.getElementsByName(name) into OUT; returns the count.
    fn byName(e, doc: u32, name: str) -> u32 {
        e.by_name(doc, name)
    }
    /// The elements behind `document[name]` (Document's named getter) into OUT; returns the count.
    fn docNamed(e, doc: u32, name: str) -> u32 {
        e.doc_named(doc, name)
    }
}

impl Env {
    /// First element in tree order under `root` (inclusive of descendants only) whose id is `id`.
    /// Connected roots use the document id map; detached roots walk the subtree.
    pub fn get_element_by_id(&self, root: NodeId, id: Atom) -> NodeId {
        let r = self.rec(root);
        if id.is_none() || r.meta & meta::KIND_MASK == 0 {
            return 0;
        }
        if self.in_document_tree(root) {
            let Some(doc) = self.doc_data(r.owner) else { return 0 };
            let Some(cands) = doc.id_map.get(&id) else { return 0 };
            let in_root = |c: NodeId| root == doc.id || self.is_inclusive_ancestor(root, c) && c != root;
            if cands.len() == 1 {
                return if in_root(cands[0]) { cands[0] } else { 0 };
            }
            // Duplicates: first in tree order.
            return cands
                .iter()
                .copied()
                .filter(|&c| in_root(c))
                .min_by(|&a, &b| self.tree_order(a, b))
                .unwrap_or(0);
        }
        let mut n = self.next_in_subtree(root, root);
        while n != 0 {
            if self.rec(n).meta & meta::KIND_MASK == kind::ELEMENT && self.elem(n).is_some_and(|d| d.id == id)
            {
                return n;
            }
            n = self.next_in_subtree(n, root);
        }
        0
    }
}

#[cfg(test)]
mod tests;
