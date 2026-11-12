//! Shadow roots without retargeting (DESIGN §22, ROADMAP Stage 1 `shadow-root`): `attachShadow`, the host /
//! shadow root links, and the shadow-including tree walks the child-list module needs.
//!
//! A shadow root is a DocumentFragment record with [`meta::SHADOW`] set; its `payload` is its host (as a
//! template-contents fragment's payload is its `<template>`), its node document is the host's, and it has no
//! parent. The host carries the same bit (the kind tells the two apart) and its shadow root in
//! `ElementExt.shadow`. The mode lives in [`ShadowState`]; jsdom 30 implements only `mode` of
//! `ShadowRootInit` (`refs/jsdom/lib/jsdom/living/nodes/Element.webidl`), and so does oxidom.
//!
//! `CONNECTED` is the DOM's "connected": the shadow-including root is a document. A connected host's shadow
//! root and its shadow tree carry the bit, so `isConnected`, focus and the style hooks need no change. The
//! document id map holds elements *in a document tree* only (DOM "in a document tree"): `getElementById` on
//! the document never sees shadow trees, and `ShadowRoot.getElementById` walks its tree. Until the env's first
//! `attachShadow` every connected node is in a document tree, so the extra work is one load and compare.

use rustc_hash::FxHashMap;

use crate::atoms::{Atom, atom};
use crate::env::Env;
use crate::error::{DomError, DomResult};
use crate::node::{Ns, kind, meta};
use crate::table::NodeId;

/// Shadow root mode bits (the `attachShadow` / `shadowMode` wire value).
pub mod mode {
    /// `"open"`
    pub const OPEN: u32 = 0;
    /// `"closed"`
    pub const CLOSED: u32 = 1;
}

/// Env-wide shadow-root state (`Env.shadow`).
#[derive(Default, Debug)]
pub struct ShadowState {
    /// mode of each shadow root, by root id
    modes: FxHashMap<NodeId, u32>,
    /// assigned slot of each assigned slottable (crate::slots, DESIGN §42)
    pub(crate) assigned_slot: FxHashMap<NodeId, NodeId>,
    /// assigned nodes of each slot that has some
    pub(crate) assigned_nodes: FxHashMap<NodeId, Vec<NodeId>>,
    /// DOM "signal slots": slots to fire `slotchange` at, in signal order
    pub(crate) signals: Vec<NodeId>,
}

impl ShadowState {
    /// True once any shadow root exists in the env (the hot-path guard: nodes are never reclaimed, so a
    /// shadow root that existed may still be reachable).
    #[inline(always)]
    pub fn any(&self) -> bool {
        !self.modes.is_empty()
    }
}

/// DOM "valid shadow host name" (refs/jsdom/lib/jsdom/living/helpers/shadow-dom.js `VALID_HOST_ELEMENT_NAME`).
fn is_valid_host_name(local: Atom) -> bool {
    matches!(
        local,
        atom::ARTICLE
            | atom::ASIDE
            | atom::BLOCKQUOTE
            | atom::BODY
            | atom::DIV
            | atom::FOOTER
            | atom::HEADER
            | atom::MAIN
            | atom::NAV
            | atom::P
            | atom::SECTION
            | atom::SPAN
    ) || (atom::H1.0..=atom::H6.0).contains(&local.0)
}

/// HTML "valid custom element name": a potential custom element name (the PCENChar grammar of
/// `is-potential-custom-element-name`, which jsdom uses) that is not one of the reserved names.
pub fn is_valid_custom_element_name(name: &str) -> bool {
    const RESERVED: [&str; 8] = [
        "annotation-xml",
        "color-profile",
        "font-face",
        "font-face-src",
        "font-face-uri",
        "font-face-format",
        "font-face-name",
        "missing-glyph",
    ];
    let pcen = |c: char| {
        matches!(c,
            '-' | '.' | '0'..='9' | '_' | 'a'..='z' | '\u{B7}' | '\u{C0}'..='\u{D6}' | '\u{D8}'..='\u{F6}'
            | '\u{F8}'..='\u{37D}' | '\u{37F}'..='\u{1FFF}' | '\u{200C}' | '\u{200D}' | '\u{203F}' | '\u{2040}'
            | '\u{2070}'..='\u{218F}' | '\u{2C00}'..='\u{2FEF}' | '\u{3001}'..='\u{D7FF}' | '\u{F900}'..='\u{FDCF}'
            | '\u{FDF0}'..='\u{FFFD}' | '\u{10000}'..='\u{EFFFF}')
    };
    name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.contains('-')
        && name.chars().all(pcen)
        && !RESERVED.contains(&name)
}

impl Env {
    /// True if `id` is a shadow root.
    #[inline(always)]
    pub fn is_shadow_root(&self, id: NodeId) -> bool {
        self.rec(id).meta & (meta::KIND_MASK | meta::SHADOW) == kind::FRAGMENT | meta::SHADOW
    }

    /// Shadow root of host `el` (0 if `el` is not a shadow host).
    #[inline]
    pub fn shadow_root_of(&self, el: NodeId) -> NodeId {
        if self.rec(el).meta & (meta::KIND_MASK | meta::SHADOW) != kind::ELEMENT | meta::SHADOW {
            return 0;
        }
        self.elem(el).and_then(|d| d.ext.as_ref()).map_or(0, |x| x.shadow)
    }

    /// Host of shadow root `root` (0 if `root` is not a shadow root).
    #[inline]
    pub fn shadow_host(&self, root: NodeId) -> NodeId {
        if self.is_shadow_root(root) { self.rec(root).payload } else { 0 }
    }

    /// True if connected `n` is in a document tree (its root is a document, not a shadow root).
    #[inline]
    pub fn in_document_tree(&self, n: NodeId) -> bool {
        self.rec(n).meta & meta::CONNECTED != 0
            && (!self.shadow.any() || !self.is_shadow_root(self.root_of(n)))
    }

    /// DOM "attach a shadow root" as jsdom 30 does it (`Element-impl.js` `attachShadow`; `mode` only).
    /// Custom element definitions (`disabledFeatures`) do not exist yet (Stage 4 `custom-elements`).
    pub fn attach_shadow(&mut self, el: NodeId, mode: u32) -> DomResult<NodeId> {
        if !self.is_element(el) {
            return Err(DomError::Type);
        }
        if self.ns_of(el) != Ns::Html {
            return Err(DomError::NotSupported);
        }
        let local = self.local(el);
        if !is_valid_host_name(local) && !is_valid_custom_element_name(self.atoms.name(local)) {
            return Err(DomError::NotSupported);
        }
        if self.shadow_root_of(el) != 0 {
            return Err(DomError::NotSupported);
        }
        let host = *self.rec(el);
        let doc = host.owner;
        let root = self.create_fragment(doc);
        {
            let r = self.rec_mut(root);
            r.meta |= meta::SHADOW | (host.meta & (meta::CONNECTED | meta::IN_TEMPLATE));
            r.payload = el;
        }
        self.rec_mut(el).meta |= meta::SHADOW;
        if let Some(d) = self.elem_mut(el) {
            d.ext_mut().shadow = root;
        }
        self.shadow.modes.insert(root, mode & mode::CLOSED);
        Ok(root)
    }

    /// Mode of shadow root `root` (`mode::OPEN` for anything else).
    pub fn shadow_mode(&self, root: NodeId) -> u32 {
        self.shadow.modes.get(&root).copied().unwrap_or(mode::OPEN)
    }
}

natives! {
    /// attachShadow(el, mode): the new shadow root (0 + EP[ERR]: NotSupportedError for a non-HTML element, a name that cannot host one, or an existing host). Allocates.
    fn attachShadow(e, el: u32, mode: u32) -> u32 {
        let r = e.attach_shadow(el, mode);
        e.id_or_fail(r)
    }
    /// Shadow root of host `el`; with `open_only`, 0 for a closed one (Element.shadowRoot). 0 for non-hosts.
    fn shadowRootOf(e, el: u32, open_only: bool) -> u32 {
        let root = e.shadow_root_of(el);
        if open_only && e.shadow_mode(root) == mode::CLOSED { 0 } else { root }
    }
    /// Host of shadow root `root` (0 for other nodes).
    fn shadowHost(e, root: u32) -> u32 {
        e.shadow_host(root)
    }
    /// Mode of shadow root `root`: 0 open, 1 closed.
    fn shadowMode(e, root: u32) -> u32 {
        e.shadow_mode(root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::DocKind;

    fn doc_body(e: &mut Env) -> (NodeId, NodeId) {
        let doc = e.create_document(DocKind::Html, None);
        let body = e.rec(e.rec(doc).last).last; // html -> body
        assert!(e.is_html_elem(body, atom::BODY));
        (doc, body)
    }

    fn el(e: &mut Env, doc: NodeId, local: Atom) -> NodeId {
        e.create_element(doc, local, Ns::Html)
    }

    #[test]
    fn custom_element_names() {
        assert!(is_valid_custom_element_name("my-element"));
        assert!(is_valid_custom_element_name("x-\u{e9}"));
        assert!(!is_valid_custom_element_name("myelement"));
        assert!(!is_valid_custom_element_name("My-element"));
        assert!(!is_valid_custom_element_name("-x"));
        assert!(!is_valid_custom_element_name("font-face"));
        assert!(!is_valid_custom_element_name("x-A"));
    }

    #[test]
    fn shadow_tree_connects_with_its_host_but_stays_out_of_the_id_map() {
        let mut e = Env::new();
        let (doc, body) = doc_body(&mut e);
        let host = el(&mut e, doc, atom::DIV);
        let root = e.attach_shadow(host, mode::OPEN).unwrap();
        assert_eq!(e.attach_shadow(host, mode::OPEN), Err(DomError::NotSupported));
        let inner = el(&mut e, doc, atom::SPAN);
        e.set_attr(inner, atom::ID, "x").unwrap();
        e.append_child(root, inner).unwrap();
        assert_eq!(e.rec(inner).meta & meta::CONNECTED, 0);
        e.append_child(body, host).unwrap();
        assert_ne!(e.rec(root).meta & meta::CONNECTED, 0);
        assert_ne!(e.rec(inner).meta & meta::CONNECTED, 0);
        let x = e.intern("x");
        assert_eq!(e.get_element_by_id(doc, x), 0);
        assert_eq!(e.get_element_by_id(root, x), inner);
        // An id set while connected inside the shadow tree stays out of the map too.
        let late = el(&mut e, doc, atom::P);
        e.append_child(root, late).unwrap();
        e.set_attr(late, atom::ID, "y").unwrap();
        let y = e.intern("y");
        assert_eq!(e.get_element_by_id(doc, y), 0);
        assert_eq!(e.get_element_by_id(root, y), late);
        e.remove_child(body, host).unwrap();
        assert_eq!(e.rec(inner).meta & meta::CONNECTED, 0);
        assert_eq!(e.rec(root).meta & meta::CONNECTED, 0);
        assert_eq!(e.get_element_by_id(root, x), inner);
    }

    #[test]
    fn host_including_ancestors_cross_shadow_roots() {
        let mut e = Env::new();
        let (doc, _) = doc_body(&mut e);
        let host = el(&mut e, doc, atom::DIV);
        let root = e.attach_shadow(host, mode::CLOSED).unwrap();
        assert_eq!(e.shadow_mode(root), mode::CLOSED);
        assert_eq!(e.append_child(root, host), Err(DomError::HierarchyRequest));
        assert_eq!(e.clone_node(root, doc, true), Err(DomError::NotSupported));
        let other = e.create_document(DocKind::Html, None);
        assert_eq!(e.adopt_node(other, root), Err(DomError::HierarchyRequest));
        let c = e.clone_node(host, doc, true).unwrap();
        assert_eq!(e.shadow_root_of(c), 0);
        // Adopting the host moves its shadow tree too.
        let inner = el(&mut e, doc, atom::B);
        e.append_child(root, inner).unwrap();
        e.adopt_node(other, host).unwrap();
        assert_eq!(e.node_doc(root), other);
        assert_eq!(e.node_doc(inner), other);
    }

    #[test]
    fn deep_nested_shadow_trees_connect_iteratively() {
        let mut e = Env::new();
        let (doc, body) = doc_body(&mut e);
        let top = el(&mut e, doc, atom::DIV);
        let mut container = top;
        for _ in 0..2000 {
            let h = el(&mut e, doc, atom::DIV);
            let s = e.attach_shadow(h, mode::OPEN).unwrap();
            e.append_child(container, h).unwrap();
            container = s;
        }
        e.append_child(body, top).unwrap();
        let t = e.create_text(doc, "hi");
        e.append_child(container, t).unwrap();
        assert_ne!(e.rec(t).meta & meta::CONNECTED, 0);
        assert!(e.is_host_including_inclusive_ancestor(top, t));
    }
}
