//! HTML parsing with html5ever 0.40: a `TreeSink` whose handles are node ids and which writes straight into
//! the arena (DESIGN §10). Parser-created nodes are fresh (no wrappers, no observers), so they are linked
//! with raw `link`s: no per-node hooks, records or epoch bumps. Afterwards the caller inserts the result
//! with ONE tree operation (replace-all / replace / insert), which runs the CONNECTED pass, the hooks and
//! queues ONE MutationObserver record.
//!
//! `<template>` contents get their own inert fragment owned by the document's template-contents owner; the
//! nodes the parser puts into it are re-owned by one pass after the parse (`reown_template_contents`).
//! Nothing runs during a parse; scripts the parser creates are flagged for crate::script (DESIGN §45). The
//! scripting flag is on (`<noscript>` content parses as raw text) except in documents with
//! `DocData.no_scripting`: DOMParser documents and documents of windows that do not run scripts, as in jsdom.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};

use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::tree_builder::{ElemName, ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::{Attribute, LocalName, Namespace, ParseOpts, Prefix, QualName, local_name, ns};
use rustc_hash::FxHashMap;
use smallvec::SmallVec;

use crate::atoms::{Atom, atom};
use crate::env::Env;
use crate::error::{Code, DomError, DomResult, code};
use crate::node::{Attr, Ns, Quirks, kind};
use crate::string::Str;
use crate::table::NodeId;
use crate::tree::FreshTree;

/// Per-Env cache from html5ever atoms to oxidom atoms (html5ever atoms hash by a precomputed u64).
#[derive(Default)]
pub struct ParseCache {
    locals: FxHashMap<LocalName, Atom>,
}

/// Owned element name returned by `TreeSink::elem_name`.
#[derive(Debug)]
pub struct Name {
    ns: Namespace,
    local: LocalName,
}

impl ElemName for Name {
    fn ns(&self) -> &Namespace {
        &self.ns
    }
    fn local_name(&self) -> &LocalName {
        &self.local
    }
}

struct Sink<'a> {
    env: RefCell<&'a mut Env>,
    /// The parser's document handle (a real document for `parseDocument`, a scratch fragment otherwise).
    root: NodeId,
    /// Node document of every created node.
    doc: NodeId,
    /// html5ever names of elements created during this parse (index = id - base) + the context element.
    names: RefCell<Vec<Option<(Namespace, LocalName)>>>,
    base: NodeId,
    context: Option<(NodeId, Namespace, LocalName)>,
    integration_points: RefCell<SmallVec<[NodeId; 2]>>,
    quirks: Cell<QuirksMode>,
    /// A template-contents fragment was handed out (its subtree needs re-owning after the parse).
    saw_template: Cell<bool>,
}

fn ns_atom(env: &mut Env, ns: &Namespace) -> Atom {
    match *ns {
        ns!(html) => atom::NS_HTML,
        ns!(svg) => atom::NS_SVG,
        ns!(mathml) => atom::NS_MATHML,
        ns!(xlink) => atom::NS_XLINK,
        ns!(xml) => atom::NS_XML,
        ns!(xmlns) => atom::NS_XMLNS,
        ns!() => Atom::NONE,
        _ => env.intern(ns),
    }
}

fn local_atom(env: &mut Env, local: &LocalName) -> Atom {
    if let Some(&a) = env.parse_cache.locals.get(local) {
        return a;
    }
    let a = env.intern(local);
    env.parse_cache.locals.insert(local.clone(), a);
    a
}

fn prefix_atom(env: &mut Env, p: &Option<Prefix>) -> Atom {
    match p {
        Some(p) => env.intern(p),
        None => Atom::NONE,
    }
}

impl Sink<'_> {
    fn append_text(&self, parent: NodeId, before: NodeId, text: &str) {
        let mut env = self.env.borrow_mut();
        // Merge with the adjacent previous Text node (the parser's "insert a character" step).
        let prev = if before != 0 { env.rec(before).prev } else { env.rec(parent).last };
        if prev != 0 && env.kind(prev) == kind::TEXT {
            if let Some(s) = env.char_data_mut(prev) {
                s.push_str(text);
                return;
            }
        }
        let t = env.create_text(self.doc, text);
        env.link(t, parent, before);
    }

    fn insert(&self, parent: NodeId, before: NodeId, child: NodeOrText<NodeId>) {
        match child {
            NodeOrText::AppendNode(n) => {
                let mut env = self.env.borrow_mut();
                env.unlink(n);
                env.link(n, parent, before);
            }
            NodeOrText::AppendText(t) => self.append_text(parent, before, &t),
        }
    }
}

impl TreeSink for Sink<'_> {
    type Handle = NodeId;
    /// (quirks mode, whether template contents were created: they need `reown_template_contents`)
    type Output = (QuirksMode, bool);
    type ElemName<'b>
        = Name
    where
        Self: 'b;

    fn finish(self) -> (QuirksMode, bool) {
        (self.quirks.get(), self.saw_template.get())
    }

    fn parse_error(&self, _msg: Cow<'static, str>) {}

    fn get_document(&self) -> NodeId {
        self.root
    }

    fn elem_name<'b>(&'b self, target: &'b NodeId) -> Name {
        if let Some((id, ns, local)) = &self.context {
            if id == target {
                return Name { ns: ns.clone(), local: local.clone() };
            }
        }
        if let Some(i) = target.checked_sub(self.base) {
            if let Some(Some((ns, local))) = self.names.borrow().get(i as usize) {
                return Name { ns: ns.clone(), local: local.clone() };
            }
        }
        // Not created by this parse (should not happen): rebuild from the arena.
        let env = self.env.borrow();
        let local = LocalName::from(env.atoms.name(env.local(*target)));
        let ns = match env.ns_of(*target) {
            Ns::Html => ns!(html),
            Ns::Svg => ns!(svg),
            Ns::MathMl => ns!(mathml),
            Ns::Other => Namespace::from(env.atoms.name(env.elem(*target).map_or(Atom::NONE, |d| d.ns))),
        };
        Name { ns, local }
    }

    fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> NodeId {
        let mut env = self.env.borrow_mut();
        let local = local_atom(&mut env, &name.local);
        let ns = ns_atom(&mut env, &name.ns);
        let prefix = prefix_atom(&mut env, &name.prefix);
        let el = env.create_element_full(self.doc, local, ns, prefix);
        if local == atom::SCRIPT && ns == crate::node::Ns::Html.uri() {
            let started = self.context.is_some() || env.doc_data(self.doc).is_some_and(|d| d.no_scripting);
            env.script.parser_created(el, started);
        }
        if !attrs.is_empty() {
            let mut list: SmallVec<[Attr; 1]> = SmallVec::with_capacity(attrs.len());
            for a in &attrs {
                let alocal = local_atom(&mut env, &a.name.local);
                let ans = ns_atom(&mut env, &a.name.ns);
                let apfx = prefix_atom(&mut env, &a.name.prefix);
                let qname = if apfx.is_none() {
                    alocal
                } else {
                    let q = format!("{}:{}", a.name.prefix.as_ref().map_or("", |p| &**p), &*a.name.local);
                    env.intern(&q)
                };
                list.push(Attr { local: alocal, qname, ns: ans, prefix: apfx, value: Str::from(&*a.value) });
            }
            env.init_attrs(el, list);
            // HTML "create an element for a token": the `is` attribute is the `is` value (crate::ce)
            if let Some(is) = attrs.iter().find(|a| a.name.ns.is_empty() && &*a.name.local == "is")
                && ns == crate::node::Ns::Html.uri()
            {
                let is = env.intern(&is.value);
                env.ce_set_is(el, is);
            }
        }
        drop(env);
        let i = (el - self.base) as usize;
        let mut names = self.names.borrow_mut();
        if names.len() <= i {
            names.resize(i + 1, None);
        }
        names[i] = Some((name.ns, name.local));
        if flags.mathml_annotation_xml_integration_point {
            self.integration_points.borrow_mut().push(el);
        }
        el
    }

    fn create_comment(&self, text: StrTendril) -> NodeId {
        self.env.borrow_mut().create_comment(self.doc, &text)
    }

    fn create_pi(&self, target: StrTendril, data: StrTendril) -> NodeId {
        let mut env = self.env.borrow_mut();
        // The HTML parser never produces PIs; keep the node valid even for odd targets.
        let doc = self.doc;
        env.create_pi(doc, &target, &data).unwrap_or_else(|_| env.create_comment(doc, &data))
    }

    fn append(&self, parent: &NodeId, child: NodeOrText<NodeId>) {
        self.insert(*parent, 0, child);
    }

    fn append_based_on_parent_node(
        &self,
        element: &NodeId,
        prev_element: &NodeId,
        child: NodeOrText<NodeId>,
    ) {
        let has_parent = self.env.borrow().rec(*element).parent != 0;
        if has_parent {
            self.append_before_sibling(element, child);
        } else {
            self.append(prev_element, child);
        }
    }

    fn append_doctype_to_document(&self, name: StrTendril, public_id: StrTendril, system_id: StrTendril) {
        let mut env = self.env.borrow_mut();
        let dt = env.create_doctype(self.doc, &name, &public_id, &system_id);
        env.link(dt, self.root, 0);
    }

    fn get_template_contents(&self, target: &NodeId) -> NodeId {
        self.saw_template.set(true);
        self.env.borrow_mut().template_content(*target)
    }

    fn same_node(&self, x: &NodeId, y: &NodeId) -> bool {
        x == y
    }

    fn set_quirks_mode(&self, mode: QuirksMode) {
        self.quirks.set(mode);
    }

    fn append_before_sibling(&self, sibling: &NodeId, new_node: NodeOrText<NodeId>) {
        let parent = self.env.borrow().rec(*sibling).parent;
        if parent != 0 {
            self.insert(parent, *sibling, new_node);
        }
    }

    fn add_attrs_if_missing(&self, target: &NodeId, attrs: Vec<Attribute>) {
        let mut env = self.env.borrow_mut();
        for a in attrs {
            let local = local_atom(&mut env, &a.name.local);
            let ns = ns_atom(&mut env, &a.name.ns);
            let present = env.elem(*target).is_some_and(|d| d.find_ns(ns, local).is_some());
            if !present && ns.is_none() {
                let _ = env.set_attr(*target, local, &a.value);
            }
        }
    }

    fn remove_from_parent(&self, target: &NodeId) {
        self.env.borrow_mut().unlink(*target);
    }

    fn reparent_children(&self, node: &NodeId, new_parent: &NodeId) {
        let mut env = self.env.borrow_mut();
        let mut c = env.rec(*node).first;
        while c != 0 {
            let next = env.rec(c).next;
            env.unlink(c);
            env.link(c, *new_parent, 0);
            c = next;
        }
    }

    fn is_mathml_annotation_xml_integration_point(&self, handle: &NodeId) -> bool {
        self.integration_points.borrow().contains(handle)
    }
}

fn opts(scripting: bool) -> ParseOpts {
    let mut o = ParseOpts::default();
    o.tree_builder.scripting_enabled = scripting;
    o
}

impl Env {
    /// Gives every node the parser placed into template contents created during this parse (ids >= `base`)
    /// the contents' owner document (the inert template-contents owner), as the HTML parser's "appropriate
    /// template contents owner document" requires. Nested contents fragments are visited by the id scan.
    fn reown_template_contents(&mut self, base: NodeId) {
        for id in base..self.table.len() {
            let r = *self.rec(id);
            if r.meta & (crate::node::meta::KIND_MASK | crate::node::meta::TEMPLATE_CONTENT)
                != kind::FRAGMENT | crate::node::meta::TEMPLATE_CONTENT
            {
                continue;
            }
            let owner = r.owner;
            let html = self.doc_data(owner).is_some_and(|d| d.html);
            let mut n = self.rec(id).first;
            while n != 0 {
                let nr = self.rec_mut(n);
                nr.owner = owner;
                if html {
                    nr.meta |= crate::node::meta::HTML_DOC;
                } else {
                    nr.meta &= !crate::node::meta::HTML_DOC;
                }
                n = self.next_in_subtree(n, id);
            }
        }
    }

    /// DOMParser / parseDocument: parses `html` into a new HTML document, with the HTML parser's scripting flag
    /// `scripting` (off for DOMParser documents and windows that do not run scripts, as in jsdom; DESIGN §45).
    pub fn parse_document(&mut self, html: &str, scripting: bool) -> NodeId {
        let doc = self.create_document(crate::dom::DocKind::HtmlEmpty, None);
        if let Some(d) = self.doc_data_mut(doc) {
            d.no_scripting = !scripting;
        }
        let base = self.table.len();
        let sink = Sink {
            env: RefCell::new(self),
            root: doc,
            doc,
            names: RefCell::new(Vec::new()),
            base,
            context: None,
            integration_points: RefCell::new(SmallVec::new()),
            quirks: Cell::new(QuirksMode::NoQuirks),
            saw_template: Cell::new(false),
        };
        let (quirks, saw_template) =
            html5ever::parse_document(sink, opts(scripting)).one(StrTendril::from_slice(html));
        if saw_template {
            self.reown_template_contents(base);
        }
        self.hook_parsed(base);
        self.set_quirks(
            doc,
            match quirks {
                QuirksMode::NoQuirks => Quirks::NoQuirks,
                QuirksMode::LimitedQuirks => Quirks::LimitedQuirks,
                QuirksMode::Quirks => Quirks::Quirks,
            },
        );
        // Everything below the (connected) document becomes connected: id map, hooks.
        let mut tree = FreshTree::default();
        tree.take_linked(self, doc);
        tree.finish(self);
        doc
    }

    /// HTML fragment parsing algorithm with `context` (0 = a `<body>` context in `doc`). Returns a new
    /// DocumentFragment (node document = the context's) holding the parsed nodes.
    pub fn parse_fragment(&mut self, context: NodeId, doc: NodeId, html: &str) -> DomResult<NodeId> {
        let (ctx_ns, ctx_local, doc) = if context != 0 && self.is_element(context) {
            let local = LocalName::from(self.atoms.name(self.local(context)));
            let ns = match self.ns_of(context) {
                Ns::Html => ns!(html),
                Ns::Svg => ns!(svg),
                Ns::MathMl => ns!(mathml),
                Ns::Other => {
                    Namespace::from(self.atoms.name(self.elem(context).map_or(Atom::NONE, |d| d.ns)))
                }
            };
            (ns, local, self.node_doc(context))
        } else {
            self.require_doc(doc)?;
            (ns!(html), local_name!("body"), doc)
        };
        let scratch = self.create_fragment(doc);
        let base = self.table.len();
        let ctx_handle = if context != 0 && self.is_element(context) { context } else { scratch };
        let scripting = !self.doc_data(doc).is_some_and(|d| d.no_scripting);
        let saw_template;
        {
            let sink = Sink {
                env: RefCell::new(self),
                root: scratch,
                doc,
                names: RefCell::new(Vec::new()),
                base,
                context: Some((ctx_handle, ctx_ns, ctx_local)),
                integration_points: RefCell::new(SmallVec::new()),
                quirks: Cell::new(QuirksMode::NoQuirks),
                saw_template: Cell::new(false),
            };
            let parser =
                html5ever::driver::parse_fragment_for_element(sink, opts(scripting), ctx_handle, true, None);
            (_, saw_template) = parser.one(StrTendril::from_slice(html));
        }
        if saw_template {
            self.reown_template_contents(base);
        }
        self.hook_parsed(base);
        if self.script.on() {
            self.script_parsed(base, doc);
        }
        // The parser created <html> under `scratch`; its children are the result.
        let html_root = self.rec(scratch).first;
        let frag = self.create_fragment(doc);
        if html_root != 0 {
            let mut c = self.rec(html_root).first;
            while c != 0 {
                let next = self.rec(c).next;
                self.unlink(c);
                self.link(c, frag, 0);
                c = next;
            }
        }
        Ok(frag)
    }

    /// `innerHTML` setter (template elements replace their template contents).
    pub fn set_inner_html(&mut self, el: NodeId, html: &str) -> DomResult {
        // ShadowRoot.innerHTML parses with the host as the context element (jsdom InnerHTML-impl.js).
        let (ctx, target) = match self.shadow_host(el) {
            0 if !self.is_element(el) => return Err(DomError::Type),
            0 if self.is_html_elem(el, atom::TEMPLATE) => (el, self.template_content(el)),
            0 => (el, el),
            host => (host, el),
        };
        let frag = self.parse_fragment(ctx, 0, html)?;
        if self.rec(frag).first == 0 && self.rec(target).first == 0 {
            return Ok(());
        }
        self.replace_all(frag, target);
        Ok(())
    }

    /// `outerHTML` setter.
    pub fn set_outer_html(&mut self, el: NodeId, html: &str) -> DomResult {
        let parent = self.rec(el).parent;
        if parent == 0 {
            return Ok(());
        }
        let pk = self.kind(parent);
        if pk == kind::DOCUMENT {
            return Err(DomError::NoModificationAllowed);
        }
        let ctx = if pk == kind::FRAGMENT { 0 } else { parent };
        let doc = self.node_doc(el);
        let frag = self.parse_fragment(ctx, doc, html)?;
        self.replace_child(parent, frag, el)
    }

    /// `insertAdjacentHTML(position, html)`; position 0 beforebegin, 1 afterbegin, 2 beforeend, 3 afterend.
    pub fn insert_adjacent_html(&mut self, el: NodeId, pos: u32, html: &str) -> DomResult {
        let (ctx, parent, before) = match pos {
            0 | 3 => {
                let parent = self.rec(el).parent;
                if parent == 0 || self.kind(parent) == kind::DOCUMENT {
                    return Err(DomError::NoModificationAllowed);
                }
                let before = if pos == 0 { el } else { self.rec(el).next };
                (parent, parent, before)
            }
            1 => (el, el, self.rec(el).first),
            2 => (el, el, 0),
            _ => return Err(DomError::Syntax),
        };
        let use_body = !self.is_element(ctx) || (self.in_html_doc(ctx) && self.is_html_elem(ctx, atom::HTML));
        let doc = self.node_doc(el);
        let frag = self.parse_fragment(if use_body { 0 } else { ctx }, doc, html)?;
        self.pre_insert(frag, parent, before)
    }

    /// Quirks mode setter used by `parseDocument`.
    pub fn set_quirks(&mut self, doc: NodeId, q: Quirks) {
        if let Some(d) = self.doc_data_mut(doc) {
            d.quirks = q;
        }
    }
}

natives! {
    /// innerHTML setter (fragment parsing + replace-all, one record). Returns 0 or an error code.
    fn innerHTMLSet(e, id: u32, html: str) -> Code {
        code(e.set_inner_html(id, html))
    }
    /// outerHTML setter. Returns 0 or an error code (NoModificationAllowedError under a document).
    fn outerHTMLSet(e, id: u32, html: str) -> Code {
        code(e.set_outer_html(id, html))
    }
    /// insertAdjacentHTML(id, pos 0..3, html). Returns 0 or an error code.
    fn insertAdjacentHTML(e, id: u32, pos: u32, html: str) -> Code {
        code(e.insert_adjacent_html(id, pos, html))
    }
    /// Fragment parsing with context element `ctx` (0 = body context in `doc`): new fragment id or 0 + EP[ERR].
    fn parseFragment(e, ctx: u32, html: str, doc: u32) -> u32 {
        let r = e.parse_fragment(ctx, doc, html);
        e.id_or_fail(r)
    }
    /// DOMParser text/html (`scripting` = 0), a window's document: new document id.
    fn parseDocument(e, html: str, scripting: u32) -> u32 {
        e.parse_document(html, scripting != 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::DocKind;

    #[test]
    fn one_record_per_inner_html_set() {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let body = e.rec(e.rec(doc).last).last;
        let div = e.create_element(doc, atom::DIV, Ns::Html);
        e.append_child(body, div).unwrap();
        e.set_inner_html(div, "<p>old</p><p>old2</p>").unwrap();
        // Records are counted through the MutationObserver natives (area C, src/mo.rs).
        e.mo_observe(1, div, crate::mo::opt::CHILD_LIST, &[]).unwrap();
        let on_div = |e: &mut Env| {
            e.mo_take(0, u32::MAX);
            e.out.read(2)
        };
        e.set_inner_html(div, "<table><tr><td>a<td>b</table><ul><li>1<li>2</ul>text").unwrap();
        assert_eq!(on_div(&mut e), 1);
        e.set_text_content(div, "x").unwrap();
        assert_eq!(on_div(&mut e), 1);
    }

    #[test]
    fn parsed_template_contents_are_owned_by_the_template_doc() {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let body = e.rec(e.rec(doc).last).last;
        e.set_inner_html(body, "<template><p>x<template><i>y</i></template></p></template>").unwrap();
        let t = e.rec(body).first;
        let content = e.elem(t).unwrap().template;
        let tdoc = e.template_doc(doc);
        assert_eq!(e.node_doc(content), tdoc);
        let p = e.rec(content).first;
        assert_eq!(e.node_doc(p), tdoc);
        assert_eq!(e.node_doc(e.rec(p).first), tdoc);
        let inner = e.rec(p).last;
        let inner_content = e.elem(inner).unwrap().template;
        assert_eq!(e.node_doc(e.rec(inner_content).first), tdoc);
        // DOMParser documents: scripting disabled, so <noscript> holds markup
        let d2 = e.parse_document("<noscript><b>x</b></noscript>", false);
        assert!(e.doc_data(d2).unwrap().no_scripting);
        let b2 = e.rec(e.rec(d2).last).last;
        assert_eq!(e.inner_html(b2), "<b>x</b>");
    }

    #[test]
    fn parsed_ids_are_connected_and_mapped() {
        let mut e = Env::new();
        let doc = e.parse_document("<!DOCTYPE html><p id=a>x</p><template><b id=t></b></template>", false);
        let a = e.intern("a");
        let t = e.intern("t");
        let p = e.get_element_by_id(doc, a);
        assert!(p != 0 && e.rec(p).meta & crate::node::meta::CONNECTED != 0);
        assert_eq!(e.get_element_by_id(doc, t), 0, "template contents are not in the document");
        assert_eq!(e.doc_data(doc).unwrap().quirks, Quirks::NoQuirks);
        let q = e.parse_document("<p>quirky", false);
        assert_eq!(e.doc_data(q).unwrap().quirks, Quirks::Quirks);
    }
}
