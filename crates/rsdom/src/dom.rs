//! Node accessors, traversal helpers and node creation (documents, elements, character data, doctypes,
//! fragments, cloning).

use std::cmp::Ordering;

use smallvec::SmallVec;

use crate::atoms::{self, Atom, atom};
use crate::env::Env;
use crate::error::{DomError, DomResult};
use crate::node::{Attr, DocData, DoctypeData, ElementData, Ns, kind, meta};
use crate::string::Str;
use crate::table::{NodeId, NodeRec};
use crate::tree::FreshTree;

/// Which document `createDocument` builds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DocKind {
    /// HTML document with `<!DOCTYPE html><html><head>[<title>]</head><body></body></html>`
    /// (`createHTMLDocument` / the window document).
    Html,
    /// Empty XML document (`new Document()`-like; no children).
    Xml,
    /// Empty HTML document (DOMParser target, template-contents owner).
    HtmlEmpty,
}

impl Env {
    // ------------------------------------------------------------------------------------ accessors

    /// nodeType of `id` (0 for invalid ids).
    #[inline(always)]
    pub fn kind(&self, id: NodeId) -> u32 {
        self.rec(id).meta & meta::KIND_MASK
    }

    /// True if `id` is an element.
    #[inline(always)]
    pub fn is_element(&self, id: NodeId) -> bool {
        self.kind(id) == kind::ELEMENT
    }

    /// True for Text and CDATASection.
    #[inline(always)]
    pub fn is_text(&self, id: NodeId) -> bool {
        matches!(self.kind(id), kind::TEXT | kind::CDATA)
    }

    /// Element payload.
    #[inline]
    pub fn elem(&self, id: NodeId) -> Option<&ElementData> {
        let r = self.rec(id);
        if r.meta & meta::KIND_MASK == kind::ELEMENT { self.elems.get(r.payload as usize) } else { None }
    }

    /// Mutable element payload.
    #[inline]
    pub fn elem_mut(&mut self, id: NodeId) -> Option<&mut ElementData> {
        let r = *self.rec(id);
        if r.meta & meta::KIND_MASK == kind::ELEMENT { self.elems.get_mut(r.payload as usize) } else { None }
    }

    /// Character data of Text / CDATA / Comment / PI nodes.
    #[inline]
    pub fn char_data(&self, id: NodeId) -> Option<&Str> {
        let r = self.rec(id);
        match r.meta & meta::KIND_MASK {
            kind::TEXT | kind::CDATA | kind::COMMENT | kind::PI => self.chars.get(r.payload as usize),
            _ => None,
        }
    }

    /// Mutable character data.
    #[inline]
    pub fn char_data_mut(&mut self, id: NodeId) -> Option<&mut Str> {
        let r = *self.rec(id);
        match r.meta & meta::KIND_MASK {
            kind::TEXT | kind::CDATA | kind::COMMENT | kind::PI => self.chars.get_mut(r.payload as usize),
            _ => None,
        }
    }

    /// Document payload of a document node.
    #[inline]
    pub fn doc_data(&self, doc: NodeId) -> Option<&DocData> {
        let r = self.rec(doc);
        if r.meta & meta::KIND_MASK == kind::DOCUMENT { self.docs.get(r.payload as usize) } else { None }
    }

    /// Mutable document payload.
    #[inline]
    pub fn doc_data_mut(&mut self, doc: NodeId) -> Option<&mut DocData> {
        let r = *self.rec(doc);
        if r.meta & meta::KIND_MASK == kind::DOCUMENT { self.docs.get_mut(r.payload as usize) } else { None }
    }

    /// Doctype payload.
    #[inline]
    pub fn doctype(&self, id: NodeId) -> Option<&DoctypeData> {
        let r = self.rec(id);
        if r.meta & meta::KIND_MASK == kind::DOCTYPE { self.doctypes.get(r.payload as usize) } else { None }
    }

    /// The node document of `id` (a document is its own node document).
    #[inline(always)]
    pub fn node_doc(&self, id: NodeId) -> NodeId {
        self.rec(id).owner
    }

    /// True if the node document of `id` is an HTML document.
    #[inline(always)]
    pub fn in_html_doc(&self, id: NodeId) -> bool {
        self.rec(id).meta & meta::HTML_DOC != 0
    }

    /// Namespace class of an element.
    #[inline(always)]
    pub fn ns_of(&self, id: NodeId) -> Ns {
        Ns::from_bits(self.rec(id).meta >> meta::NS_SHIFT)
    }

    /// True if `id` is an HTML-namespace element with local name `local`.
    #[inline(always)]
    pub fn is_html_elem(&self, id: NodeId, local: Atom) -> bool {
        let r = self.rec(id);
        r.meta & (meta::KIND_MASK | meta::NS_MASK) == kind::ELEMENT && r.local == local.0
    }

    /// Local name atom of an element (0 otherwise).
    #[inline(always)]
    pub fn local(&self, id: NodeId) -> Atom {
        Atom(if self.is_element(id) { self.rec(id).local } else { 0 })
    }

    // ------------------------------------------------------------------------------------ traversal

    /// Preorder successor of `n` within the subtree rooted at `root` (0 when done). Never leaves `root`.
    #[inline]
    pub fn next_in_subtree(&self, n: NodeId, root: NodeId) -> NodeId {
        let r = self.rec(n);
        if r.first != 0 {
            return r.first;
        }
        let mut c = n;
        while c != root && c != 0 {
            let cr = self.rec(c);
            if cr.next != 0 {
                return cr.next;
            }
            c = cr.parent;
        }
        0
    }

    /// Preorder successor skipping `n`'s children.
    #[inline]
    pub fn next_skipping_children(&self, n: NodeId, root: NodeId) -> NodeId {
        let mut c = n;
        while c != root && c != 0 {
            let cr = self.rec(c);
            if cr.next != 0 {
                return cr.next;
            }
            c = cr.parent;
        }
        0
    }

    /// True if `anc` is `n` or an ancestor of `n`.
    #[inline]
    pub fn is_inclusive_ancestor(&self, anc: NodeId, n: NodeId) -> bool {
        let mut c = n;
        while c != 0 {
            if c == anc {
                return true;
            }
            c = self.rec(c).parent;
        }
        false
    }

    /// DOM "host-including inclusive ancestor": like [`Self::is_inclusive_ancestor`], but when the walk
    /// reaches the root of template contents or a shadow root it continues from the owning `<template>`
    /// element or the shadow host (both fragments record their host in `payload`). Bounded by the node
    /// count, so even a corrupted tree cannot make it loop.
    pub fn is_host_including_inclusive_ancestor(&self, anc: NodeId, n: NodeId) -> bool {
        let mut c = n;
        let mut steps = self.table.len();
        while c != 0 && steps != 0 {
            if c == anc {
                return true;
            }
            let r = self.rec(c);
            c = if r.parent != 0 {
                r.parent
            } else if r.meta & (meta::KIND_MASK | meta::TEMPLATE_CONTENT)
                == kind::FRAGMENT | meta::TEMPLATE_CONTENT
                && self.is_html_elem(r.payload, atom::TEMPLATE)
                || r.meta & (meta::KIND_MASK | meta::SHADOW) == kind::FRAGMENT | meta::SHADOW
            {
                r.payload
            } else {
                0
            };
            steps -= 1;
        }
        false
    }

    /// Root of `n`'s tree.
    #[inline]
    pub fn root_of(&self, n: NodeId) -> NodeId {
        let mut c = n;
        loop {
            let p = self.rec(c).parent;
            if p == 0 {
                return c;
            }
            c = p;
        }
    }

    /// Children of `p` (copied, so callers may mutate while iterating).
    pub fn children_vec(&self, p: NodeId) -> SmallVec<[NodeId; 8]> {
        let mut v = SmallVec::new();
        let mut c = self.rec(p).first;
        while c != 0 {
            v.push(c);
            c = self.rec(c).next;
        }
        v
    }

    /// Ancestor chain from the root down to `n` (inclusive).
    fn path_from_root(&self, n: NodeId) -> SmallVec<[NodeId; 32]> {
        let mut v: SmallVec<[NodeId; 32]> = SmallVec::new();
        let mut c = n;
        while c != 0 {
            v.push(c);
            c = self.rec(c).parent;
        }
        v.reverse();
        v
    }

    /// Tree order of two nodes of the same tree (`Equal` iff same node). Nodes of different trees are
    /// ordered by root id (consistent, implementation-specific).
    pub fn tree_order(&self, a: NodeId, b: NodeId) -> Ordering {
        if a == b {
            return Ordering::Equal;
        }
        if !self.table.contains(a) || !self.table.contains(b) {
            return a.cmp(&b); // ids from JS are untrusted: invalid ids order by id, never panic
        }
        let pa = self.path_from_root(a);
        let pb = self.path_from_root(b);
        if pa[0] != pb[0] {
            return pa[0].cmp(&pb[0]);
        }
        let mut i = 0;
        while i < pa.len() && i < pb.len() && pa[i] == pb[i] {
            i += 1;
        }
        if i == pa.len() {
            return Ordering::Less; // a is an ancestor of b
        }
        if i == pb.len() {
            return Ordering::Greater;
        }
        // pa[i] and pb[i] are siblings: walk forward from pa[i].
        let mut c = self.rec(pa[i]).next;
        while c != 0 {
            if c == pb[i] {
                return Ordering::Less;
            }
            c = self.rec(c).next;
        }
        Ordering::Greater
    }

    /// `compareDocumentPosition` for two table nodes (Attr cases are handled by the facade).
    pub fn compare_document_position(&self, reference: NodeId, other: NodeId) -> u32 {
        const DISCONNECTED: u32 = 1;
        const PRECEDING: u32 = 2;
        const FOLLOWING: u32 = 4;
        const CONTAINS: u32 = 8;
        const CONTAINED_BY: u32 = 16;
        const IMPLEMENTATION_SPECIFIC: u32 = 32;
        if reference == other {
            return 0;
        }
        if !self.table.contains(reference) || !self.table.contains(other) {
            return DISCONNECTED | IMPLEMENTATION_SPECIFIC | PRECEDING;
        }
        let pr = self.path_from_root(reference);
        let po = self.path_from_root(other);
        if pr[0] != po[0] {
            return DISCONNECTED
                | IMPLEMENTATION_SPECIFIC
                | if other < reference { PRECEDING } else { FOLLOWING };
        }
        if po.len() < pr.len() && pr[po.len() - 1] == other {
            return CONTAINS | PRECEDING;
        }
        if pr.len() < po.len() && po[pr.len() - 1] == reference {
            return CONTAINED_BY | FOLLOWING;
        }
        match self.tree_order(other, reference) {
            Ordering::Less => PRECEDING,
            _ => FOLLOWING,
        }
    }

    /// `isEqualNode` (DOM "equals"), iterative.
    pub fn is_equal_node(&self, a: NodeId, b: NodeId) -> bool {
        if self.kind(a) == 0 || self.kind(b) == 0 {
            return a == b;
        }
        let mut stack: SmallVec<[(NodeId, NodeId); 16]> = SmallVec::new();
        stack.push((a, b));
        while let Some((x, y)) = stack.pop() {
            if !self.node_shallow_equal(x, y) {
                return false;
            }
            let (rx, ry) = (self.rec(x), self.rec(y));
            if rx.child_len != ry.child_len {
                return false;
            }
            let (mut cx, mut cy) = (rx.first, ry.first);
            while cx != 0 && cy != 0 {
                stack.push((cx, cy));
                cx = self.rec(cx).next;
                cy = self.rec(cy).next;
            }
            if cx != cy {
                return false;
            }
        }
        true
    }

    fn node_shallow_equal(&self, x: NodeId, y: NodeId) -> bool {
        let k = self.kind(x);
        if k != self.kind(y) {
            return false;
        }
        match k {
            kind::DOCTYPE => match (self.doctype(x), self.doctype(y)) {
                (Some(p), Some(q)) => {
                    p.name == q.name && p.public_id == q.public_id && p.system_id == q.system_id
                }
                _ => false,
            },
            kind::ELEMENT => {
                let (Some(p), Some(q)) = (self.elem(x), self.elem(y)) else { return false };
                self.rec(x).local == self.rec(y).local
                    && p.ns == q.ns
                    && p.prefix == q.prefix
                    && p.attrs.len() == q.attrs.len()
                    && p.attrs.iter().all(|a| {
                        q.attrs.iter().any(|b| a.ns == b.ns && a.local == b.local && a.value == b.value)
                    })
            }
            kind::PI => self.rec(x).local == self.rec(y).local && self.char_data(x) == self.char_data(y),
            kind::TEXT | kind::CDATA | kind::COMMENT => self.char_data(x) == self.char_data(y),
            _ => true,
        }
    }

    // ------------------------------------------------------------------------------------ creation

    fn new_rec(&self, doc: NodeId, kind_bits: u32, local: u32, payload: u32) -> NodeRec {
        let html = self.doc_data(doc).is_some_and(|d| d.html);
        NodeRec {
            meta: kind_bits | if html { meta::HTML_DOC } else { 0 },
            local,
            owner: doc,
            payload,
            ..NodeRec::default()
        }
    }

    /// Creates a document. See [`DocKind`].
    pub fn create_document(&mut self, dk: DocKind, title: Option<&str>) -> NodeId {
        let html = dk != DocKind::Xml;
        let payload = self.docs.len() as u32;
        let rec = NodeRec {
            meta: kind::DOCUMENT | meta::CONNECTED | if html { meta::HTML_DOC } else { 0 },
            payload,
            ..NodeRec::default()
        };
        let id = self.alloc_node(rec);
        self.rec_mut(id).owner = id;
        self.docs.push(DocData { id, html, ..DocData::default() });
        if dk == DocKind::Html {
            let dt = self.create_doctype(id, "html", "", "");
            let html_el = self.create_element(id, atom::HTML, Ns::Html);
            let head = self.create_element(id, atom::HEAD, Ns::Html);
            let body = self.create_element(id, atom::BODY, Ns::Html);
            // Bottom-up, one batch per parent; appending into the (connected) document connects.
            let mut tree = FreshTree::default();
            if let Some(t) = title {
                let te = self.create_element(id, atom::TITLE, Ns::Html);
                let tx = self.create_text(id, t);
                tree.append(self, te, tx);
                tree.append(self, head, te);
            }
            tree.append(self, html_el, head);
            tree.append(self, html_el, body);
            tree.append(self, id, dt);
            tree.append(self, id, html_el);
            tree.finish(self);
        }
        id
    }

    /// The inert document that owns template contents for `doc` (created on first use).
    pub fn template_doc(&mut self, doc: NodeId) -> NodeId {
        match self.doc_data(doc) {
            Some(d) if d.template_doc != 0 => d.template_doc,
            Some(_) => {
                let t = self.create_document(DocKind::HtmlEmpty, None);
                if let Some(td) = self.doc_data_mut(t) {
                    td.template_doc = t;
                }
                if let Some(d) = self.doc_data_mut(doc) {
                    d.template_doc = t;
                }
                t
            }
            None => 0,
        }
    }

    /// Creates an element in a known namespace class (`Ns::Other` is not allowed here).
    pub fn create_element(&mut self, doc: NodeId, local: Atom, ns: Ns) -> NodeId {
        debug_assert!(ns != Ns::Other);
        self.create_element_full(doc, local, ns.uri(), Atom::NONE)
    }

    /// Creates an element with an explicit namespace URI atom and prefix.
    pub fn create_element_full(&mut self, doc: NodeId, local: Atom, ns_uri: Atom, prefix: Atom) -> NodeId {
        let ns = Ns::of_uri(ns_uri);
        let payload = self.elems.len() as u32;
        let mut bits = kind::ELEMENT | (ns as u32) << meta::NS_SHIFT;
        if ns == Ns::Other || !prefix.is_none() {
            bits |= meta::HAS_PREFIX;
        }
        let rec = self.new_rec(doc, bits, local.0, payload);
        self.elems.push(ElementData { ns: ns_uri, prefix, ..ElementData::default() });
        self.alloc_node(rec)
    }

    /// `createElementNS` (validate and extract).
    pub fn create_element_ns(&mut self, doc: NodeId, ns: Option<&str>, qname: &str) -> DomResult<NodeId> {
        let (ns_atom, prefix, local) = self.validate_and_extract(ns, qname, true)?;
        Ok(self.create_element_full(doc, local, ns_atom, prefix))
    }

    /// DOM "validate and extract": returns (namespace, prefix, local name) atoms.
    pub fn validate_and_extract(
        &mut self,
        ns: Option<&str>,
        qname: &str,
        element: bool,
    ) -> DomResult<(Atom, Atom, Atom)> {
        let ns = ns.filter(|s| !s.is_empty());
        let (prefix, local) = match qname.split_once(':') {
            Some((p, l)) => {
                if !atoms::is_valid_namespace_prefix(p) {
                    return Err(DomError::InvalidCharacter);
                }
                (Some(p), l)
            }
            None => (None, qname),
        };
        let valid = if element {
            atoms::is_valid_element_local_name(local)
        } else {
            atoms::is_valid_attribute_local_name(local)
        };
        if !valid {
            return Err(DomError::InvalidCharacter);
        }
        const XML: &str = "http://www.w3.org/XML/1998/namespace";
        const XMLNS: &str = "http://www.w3.org/2000/xmlns/";
        if prefix.is_some() && ns.is_none() {
            return Err(DomError::Namespace);
        }
        if prefix == Some("xml") && ns != Some(XML) {
            return Err(DomError::Namespace);
        }
        if (qname == "xmlns" || prefix == Some("xmlns")) && ns != Some(XMLNS) {
            return Err(DomError::Namespace);
        }
        if ns == Some(XMLNS) && qname != "xmlns" && prefix != Some("xmlns") {
            return Err(DomError::Namespace);
        }
        let ns_atom = ns.map_or(Atom::NONE, |s| self.intern(s));
        let prefix_atom = prefix.map_or(Atom::NONE, |s| self.intern(s));
        let local_atom = self.intern(local);
        Ok((ns_atom, prefix_atom, local_atom))
    }

    fn create_chars(&mut self, doc: NodeId, k: u32, local: u32, s: &str) -> NodeId {
        self.create_chars_owned(doc, k, local, Str::from(s))
    }

    /// Creates a character-data node of kind `k` that takes ownership of `s` (no copy).
    pub(crate) fn create_chars_owned(&mut self, doc: NodeId, k: u32, local: u32, s: Str) -> NodeId {
        let payload = self.chars.len() as u32;
        self.chars.push(s);
        let rec = self.new_rec(doc, k, local, payload);
        self.alloc_node(rec)
    }

    /// `createTextNode`.
    pub fn create_text(&mut self, doc: NodeId, s: &str) -> NodeId {
        self.create_chars(doc, kind::TEXT, 0, s)
    }

    /// `createComment`.
    pub fn create_comment(&mut self, doc: NodeId, s: &str) -> NodeId {
        self.create_chars(doc, kind::COMMENT, 0, s)
    }

    /// `createCDATASection` (the facade rejects it for HTML documents).
    pub fn create_cdata(&mut self, doc: NodeId, s: &str) -> DomResult<NodeId> {
        if s.contains("]]>") {
            return Err(DomError::InvalidCharacter);
        }
        Ok(self.create_chars(doc, kind::CDATA, 0, s))
    }

    /// `createProcessingInstruction`.
    pub fn create_pi(&mut self, doc: NodeId, target: &str, data: &str) -> DomResult<NodeId> {
        if !atoms::is_xml_name(target) || data.contains("?>") {
            return Err(DomError::InvalidCharacter);
        }
        let t = self.intern(target);
        Ok(self.create_chars(doc, kind::PI, t.0, data))
    }

    /// `createDocumentFragment`.
    pub fn create_fragment(&mut self, doc: NodeId) -> NodeId {
        let rec = self.new_rec(doc, kind::FRAGMENT, 0, 0);
        self.alloc_node(rec)
    }

    /// `createDocumentType` (name validity is checked by the facade-facing native).
    pub fn create_doctype(&mut self, doc: NodeId, name: &str, public_id: &str, system_id: &str) -> NodeId {
        let payload = self.doctypes.len() as u32;
        self.doctypes.push(DoctypeData {
            name: Str::from(name),
            public_id: Str::from(public_id),
            system_id: Str::from(system_id),
        });
        let rec = self.new_rec(doc, kind::DOCTYPE, 0, payload);
        self.alloc_node(rec)
    }

    /// Template contents fragment of a `<template>` element (created lazily; 0 for other nodes).
    pub fn template_content(&mut self, el: NodeId) -> NodeId {
        if !self.is_html_elem(el, atom::TEMPLATE) {
            return 0;
        }
        if let Some(t) = self.elem(el).map(|d| d.template).filter(|&t| t != 0) {
            return t;
        }
        let doc = self.node_doc(el);
        let tdoc = self.template_doc(doc);
        let frag = self.create_fragment(tdoc);
        let r = self.rec_mut(frag);
        r.meta |= meta::TEMPLATE_CONTENT | meta::IN_TEMPLATE;
        r.payload = el;
        if let Some(d) = self.elem_mut(el) {
            d.template = frag;
        }
        frag
    }

    // ------------------------------------------------------------------------------------ cloning

    /// DOM "clone a node" into `doc` (`cloneNode` uses the node's own document, `importNode` another).
    /// Fully iterative: children and (nested) template contents go through one explicit work stack, so no
    /// input depth can overflow the native stack.
    pub fn clone_node(&mut self, node: NodeId, doc: NodeId, deep: bool) -> DomResult<NodeId> {
        let k = self.kind(node);
        if k == 0 {
            return Err(DomError::Type);
        }
        // (src parent, dst parent, node document of the copies)
        let mut stack: Vec<(NodeId, NodeId, NodeId)> = Vec::new();
        let copy = self.clone_one(node, doc, deep, &mut stack)?;
        if deep && self.rec(node).first != 0 {
            // DOM "clone a node": a document's copy is the node document of its descendants' copies.
            let child_doc = if k == kind::DOCUMENT { copy } else { doc };
            stack.push((node, copy, child_doc));
        }
        // Copies are fresh (only a cloned document is connected): see `FreshTree`.
        let mut tree = FreshTree::default();
        while let Some((src, dst, d)) = stack.pop() {
            let mut c = self.rec(src).first;
            while c != 0 {
                let cc = self.clone_one(c, d, true, &mut stack)?;
                tree.append(self, dst, cc);
                if self.rec(c).first != 0 {
                    stack.push((c, cc, d));
                }
                c = self.rec(c).next;
            }
        }
        tree.finish(self);
        Ok(copy)
    }

    /// Clones one node (no children). With `deep`, a template's contents are queued on `stack` (HTML
    /// cloning steps) instead of being cloned recursively.
    fn clone_one(
        &mut self,
        node: NodeId,
        doc: NodeId,
        deep: bool,
        stack: &mut Vec<(NodeId, NodeId, NodeId)>,
    ) -> DomResult<NodeId> {
        let r = *self.rec(node);
        let k = r.meta & meta::KIND_MASK;
        let copy = match k {
            kind::ELEMENT => {
                // Copy the attribute list and the state derived from it (id / class atoms, flag bits)
                // instead of re-deriving it: no re-tokenizing or re-interning.
                let (ns, prefix, attrs, classes, id, template) = {
                    let d = self.elem(node).ok_or(DomError::Type)?;
                    (d.ns, d.prefix, d.attrs.clone(), d.classes.clone(), d.id, d.template)
                };
                let el = self.create_element_full(doc, Atom(r.local), ns, prefix);
                if let Some(d) = self.elem_mut(el) {
                    d.attrs = attrs;
                    d.classes = classes;
                    d.id = id;
                }
                const DERIVED: u32 = meta::HAS_ID | meta::HAS_CLASS | meta::HAS_STYLE | meta::DISABLED_ATTR;
                self.rec_mut(el).meta |= r.meta & DERIVED;
                if deep
                    && template != 0
                    && self.rec(template).first != 0
                    && self.is_html_elem(node, atom::TEMPLATE)
                {
                    let dst_content = self.template_content(el);
                    let tdoc = self.node_doc(dst_content);
                    stack.push((template, dst_content, tdoc));
                }
                self.hook_cloned(node, el);
                el
            }
            kind::TEXT | kind::CDATA | kind::COMMENT | kind::PI => {
                // `Str::clone` keeps the cached ASCII flag and UTF-16 length (one copy, no rescan).
                let s = self.char_data(node).cloned().unwrap_or_default();
                self.create_chars_owned(doc, k, if k == kind::PI { r.local } else { 0 }, s)
            }
            kind::DOCTYPE => {
                let d = self.doctype(node).cloned().unwrap_or_default();
                let payload = self.doctypes.len() as u32;
                self.doctypes.push(d);
                let rec = self.new_rec(doc, kind::DOCTYPE, 0, payload);
                self.alloc_node(rec)
            }
            // DOM "clone a node" step 1 (jsdom `cloneNode`): shadow roots are not clonable.
            kind::FRAGMENT if r.meta & meta::SHADOW != 0 => return Err(DomError::NotSupported),
            kind::FRAGMENT => self.create_fragment(doc),
            kind::DOCUMENT => {
                let html = self.doc_data(node).is_some_and(|d| d.html);
                let quirks = self.doc_data(node).map(|d| d.quirks).unwrap_or_default();
                let d = self.create_document(if html { DocKind::HtmlEmpty } else { DocKind::Xml }, None);
                if let Some(dd) = self.doc_data_mut(d) {
                    dd.quirks = quirks;
                }
                d
            }
            _ => return Err(DomError::NotSupported),
        };
        Ok(copy)
    }

    /// Installs the attribute list of a fresh element and derives the cached id / class / flag state.
    pub(crate) fn init_attrs(&mut self, el: NodeId, attrs: SmallVec<[Attr; 1]>) {
        let mut flags = 0;
        let mut id_atom = Atom::NONE;
        let mut classes = SmallVec::new();
        for a in attrs.iter().filter(|a| a.ns.is_none()) {
            match a.local {
                atom::ID if flags & meta::HAS_ID == 0 => {
                    flags |= meta::HAS_ID;
                    id_atom = if a.value.is_empty() { Atom::NONE } else { self.intern(&a.value) };
                }
                atom::CLASS if flags & meta::HAS_CLASS == 0 => {
                    flags |= meta::HAS_CLASS;
                    classes = self.split_classes(&a.value);
                }
                atom::STYLE => flags |= meta::HAS_STYLE,
                atom::DISABLED => flags |= meta::DISABLED_ATTR,
                _ => {}
            }
        }
        if let Some(d) = self.elem_mut(el) {
            d.attrs = attrs;
            d.id = id_atom;
            d.classes = classes;
        }
        self.rec_mut(el).meta |= flags;
    }

    /// Splits a class attribute value into interned tokens (ASCII whitespace separated).
    /// `str::split_ascii_whitespace` is byte-level and its whitespace set is exactly HTML's ASCII
    /// whitespace; the SmallVec is sized once (no regrowth reallocs).
    pub(crate) fn split_classes(&mut self, v: &str) -> SmallVec<[Atom; 2]> {
        let mut out = SmallVec::with_capacity(v.split_ascii_whitespace().count());
        for t in v.split_ascii_whitespace() {
            out.push(self.intern(t));
        }
        out
    }
}

impl Env {
    /// `Ok(doc)` if `doc` is a document node (ids from JS are untrusted).
    #[inline]
    pub fn require_doc(&self, doc: NodeId) -> DomResult<NodeId> {
        if self.doc_data(doc).is_some() { Ok(doc) } else { Err(DomError::Type) }
    }

    /// Id-returning natives: `Ok(id) -> id`, `Err(e) -> 0` with `EP[ERR] = e`.
    #[inline]
    pub fn id_or_fail(&mut self, r: DomResult<NodeId>) -> NodeId {
        match r {
            Ok(id) => id,
            Err(err) => self.fail(err),
        }
    }
}

natives! {
    /// createDocument: kind 0 = HTML (doctype + html/head[/title]/body), 1 = empty XML, 2 = empty HTML.
    fn createDocument(e, dk: u32, title: ostr) -> u32 {
        let k = match dk { 1 => DocKind::Xml, 2 => DocKind::HtmlEmpty, _ => DocKind::Html };
        e.create_document(k, title)
    }
    /// Marks `doc` as the env's main document (EP[FOCUS] mirrors its focus).
    fn setMainDocument(e, doc: u32) -> bool {
        if e.doc_data(doc).is_some() {
            e.main_doc = doc;
            crate::focus::on_main_doc_changed(e);
            true
        } else {
            false
        }
    }
    /// createElement with a known atom; ns 0 = HTML, 1 = SVG, 2 = MathML, 3 = no namespace (an XML document's
    /// `createElement`: the whole name is the local name, DESIGN §38). 0 + EP[ERR] on bad ids.
    fn createElement(e, doc: u32, a: u32, ns: u32) -> u32 {
        let r = e.require_doc(doc).and_then(|d| {
            if !e.atoms.is_valid(Atom(a)) {
                return Err(DomError::InvalidCharacter);
            }
            Ok(match ns {
                1 => e.create_element(d, Atom(a), Ns::Svg),
                2 => e.create_element(d, Atom(a), Ns::MathMl),
                3 => e.create_element_full(d, Atom(a), Atom::NONE, Atom::NONE),
                _ => e.create_element(d, Atom(a), Ns::Html),
            })
        });
        e.id_or_fail(r)
    }
    /// createElementNS: returns 0 with EP[ERR] set on failure.
    fn createElementNS(e, doc: u32, ns: ostr, qname: str) -> u32 {
        let r = e.require_doc(doc).and_then(|d| e.create_element_ns(d, ns, qname));
        e.id_or_fail(r)
    }
    /// Namespace URI atom of an element (0 = null).
    fn elemNs(e, id: u32) -> u32 {
        e.elem(id).map_or(0, |d| d.ns.0)
    }
    /// Prefix atom of an element (0 = null).
    fn elemPrefix(e, id: u32) -> u32 {
        e.elem(id).map_or(0, |d| d.prefix.0)
    }
    /// createTextNode.
    fn createText(e, doc: u32, s: str) -> u32 {
        let r = e.require_doc(doc).map(|d| e.create_text(d, s));
        e.id_or_fail(r)
    }
    /// createComment.
    fn createComment(e, doc: u32, s: str) -> u32 {
        let r = e.require_doc(doc).map(|d| e.create_comment(d, s));
        e.id_or_fail(r)
    }
    /// createCDATASection (0 + EP[ERR] on failure).
    fn createCDATA(e, doc: u32, s: str) -> u32 {
        let r = e.require_doc(doc).and_then(|d| e.create_cdata(d, s));
        e.id_or_fail(r)
    }
    /// createProcessingInstruction (0 + EP[ERR] on failure).
    fn createPI(e, doc: u32, target: str, data: str) -> u32 {
        let r = e.require_doc(doc).and_then(|d| e.create_pi(d, target, data));
        e.id_or_fail(r)
    }
    /// createDocumentFragment.
    fn createFragment(e, doc: u32) -> u32 {
        let r = e.require_doc(doc).map(|d| e.create_fragment(d));
        e.id_or_fail(r)
    }
    /// createDocumentType (0 + EP[ERR] on an invalid name).
    fn createDoctype(e, doc: u32, name: str, public_id: str, system_id: str) -> u32 {
        let r = e.require_doc(doc).and_then(|d| {
            if atoms::is_valid_doctype_name(name) { Ok(e.create_doctype(d, name, public_id, system_id)) } else { Err(DomError::InvalidCharacter) }
        });
        e.id_or_fail(r)
    }
    /// Doctype field: 0 = name, 1 = publicId, 2 = systemId.
    fn doctypeField(e, id: u32, which: u32) -> &str {
        match (e.doctype(id), which) {
            (Some(d), 0) => d.name.as_str(),
            (Some(d), 1) => d.public_id.as_str(),
            (Some(d), _) => d.system_id.as_str(),
            (None, _) => "",
        }
    }
    /// Template contents fragment of a template element (0 for other nodes).
    fn templateContent(e, id: u32) -> u32 {
        e.template_content(id)
    }
    /// The inert template-contents owner document of `doc`.
    fn templateDoc(e, doc: u32) -> u32 {
        e.template_doc(doc)
    }
    /// True if `doc` is an HTML document.
    fn isHtmlDoc(e, doc: u32) -> bool {
        e.doc_data(doc).is_some_and(|d| d.html)
    }
    /// Quirks mode of a document: 0 no-quirks, 1 limited, 2 quirks.
    fn quirksMode(e, doc: u32) -> u32 {
        e.doc_data(doc).map_or(0, |d| d.quirks as u32)
    }
    /// cloneNode (0 + EP[ERR] on failure).
    fn cloneNode(e, id: u32, deep: bool) -> u32 {
        let doc = e.node_doc(id);
        let r = e.clone_node(id, doc, deep);
        e.id_or_fail(r)
    }
    /// importNode (0 + EP[ERR]; documents raise NotSupportedError).
    fn importNode(e, doc: u32, id: u32, deep: bool) -> u32 {
        let r = e.require_doc(doc).and_then(|d| {
            if e.kind(id) == kind::DOCUMENT { Err(DomError::NotSupported) } else { e.clone_node(id, d, deep) }
        });
        e.id_or_fail(r)
    }
    /// compareDocumentPosition(reference, other) for table nodes.
    fn compareDocumentPosition(e, reference: u32, other: u32) -> u32 {
        e.compare_document_position(reference, other)
    }
    /// isEqualNode.
    fn isEqualNode(e, a: u32, b: u32) -> bool {
        e.is_equal_node(a, b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_and_order_tolerate_invalid_ids() {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        assert_eq!(e.compare_document_position(0, doc), 1 | 2 | 32);
        assert_eq!(e.compare_document_position(doc, 0x3fff_ffff), 1 | 2 | 32);
        assert_eq!(e.tree_order(0, doc), Ordering::Less);
    }

    #[test]
    fn deep_clone_is_iterative_and_copies_derived_state() {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let div = e.create_element(doc, atom::DIV, Ns::Html);
        e.set_inner_html(div, &format!("{}x", "<template>".repeat(20_000))).unwrap();
        let html = e.inner_html(div).to_string();
        let copy = e.clone_node(div, doc, true).unwrap();
        assert_eq!(e.inner_html(copy), html);
        let el = e.create_element(doc, atom::SPAN, Ns::Html);
        e.set_attr(el, atom::CLASS, "a b").unwrap();
        e.set_attr(el, atom::ID, "i").unwrap();
        let c = e.clone_node(el, doc, false).unwrap();
        assert_eq!(e.elem(c).unwrap().classes, e.elem(el).unwrap().classes);
        assert_eq!(e.elem(c).unwrap().id, e.elem(el).unwrap().id);
        assert_eq!(e.rec(c).meta & (meta::HAS_ID | meta::HAS_CLASS), meta::HAS_ID | meta::HAS_CLASS);
    }
}
