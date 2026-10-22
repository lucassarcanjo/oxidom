//! Custom element state and reaction queue (DESIGN §43, ROADMAP Stage 4 `custom-elements`): the Rust half of
//! jsdom 30's `living/helpers/custom-elements.js`. The facade (lib/custom-elements.cjs) owns constructors and
//! callbacks; this module owns what the mutation algorithms need to decide whether a custom element is owed a
//! reaction, and queues the reactions for the facade's `mutated()` epilogue to invoke ([CEReactions]).
//!
//! - Definitions: registry (one per window, bound to its document by `ceBindDoc`), name, local name, which
//!   lifecycle callbacks exist, observed attribute local names.
//! - Elements: custom element state, definition and `is` value in [`CeState::elems`], mirrored into
//!   [`CE_CUSTOM`] / [`CE_UNDEFINED`] meta bits; uncustomized elements (nearly all) have no entry.
//! - Reactions: [`CeState::queue`], drained by `ceTake`. Enqueuing sets [`CE_BIT`] in `EP[MO_PENDING]`.
//!
//! The hooks (`ce_*` on [`Env`]) run behind `ce.any()` (creation, attributes, cloning) or `ce.defined()` (connect,
//! disconnect, adopt): until the env's first potential custom element, or its first definition, nothing here runs.

use rustc_hash::FxHashMap;
use smallvec::SmallVec;

use crate::atoms::Atom;
use crate::env::{Env, ep};
use crate::node::{Ns, kind, meta};
use crate::string::{Str, utf16_len};
use crate::table::NodeId;

/// `NodeRec.meta` bit: custom element state "custom".
pub const CE_CUSTOM: u32 = meta::CE_CUSTOM;
/// `NodeRec.meta` bit: custom element state "undefined", "failed" or "precustomized" (not `:defined`).
pub const CE_UNDEFINED: u32 = meta::CE_UNDEFINED;
/// Bit of `EP[MO_PENDING]` set while custom element reactions are queued.
pub const CE_BIT: u32 = 4;

/// Custom element states (the `ceSetState` / `ceState` wire values; 0 = uncustomized).
pub mod state {
    /// "uncustomized"
    pub const UNCUSTOMIZED: u32 = 0;
    /// "undefined"
    pub const UNDEFINED: u32 = 1;
    /// "failed"
    pub const FAILED: u32 = 2;
    /// "precustomized"
    pub const PRECUSTOMIZED: u32 = 3;
    /// "custom"
    pub const CUSTOM: u32 = 4;
}

/// Lifecycle callback bits of a definition, and reaction kinds on the wire.
pub mod cb {
    /// connectedCallback
    pub const CONNECTED: u32 = 1;
    /// disconnectedCallback
    pub const DISCONNECTED: u32 = 2;
    /// adoptedCallback
    pub const ADOPTED: u32 = 4;
    /// attributeChangedCallback
    pub const ATTRIBUTE: u32 = 8;
    /// an upgrade reaction (wire kind only)
    pub const UPGRADE: u32 = 16;
}

#[derive(Debug)]
struct Def {
    callbacks: u32,
    observed: SmallVec<[Atom; 4]>,
}

#[derive(Clone, Copy, Debug, Default)]
struct ElemCe {
    state: u32,
    def: u32,
    is: Atom,
}

#[derive(Debug)]
struct Reaction {
    el: NodeId,
    kind: u32,
    a: u32,
    b: u32,
    old: Option<Str>,
    new: Option<Str>,
}

/// Env-wide custom element state (`Env.ce`).
#[derive(Default, Debug)]
pub struct CeState {
    /// registry of each document that has one (a window's document)
    regs: FxHashMap<NodeId, u32>,
    /// document of each registry
    reg_docs: FxHashMap<u32, NodeId>,
    /// definitions; id = index + 1
    defs: Vec<Def>,
    /// (registry, name, local name) -> definition id
    lookup: FxHashMap<(u32, Atom, Atom), u32>,
    /// per-element state; uncustomized elements have no entry
    elems: FxHashMap<NodeId, ElemCe>,
    queue: Vec<Reaction>,
    /// output scratch (the attribute values of a take)
    scratch: String,
}

impl CeState {
    /// True once the env has a definition or a potential custom element (the hot-path guard).
    #[inline(always)]
    pub fn any(&self) -> bool {
        !self.elems.is_empty() || !self.defs.is_empty()
    }

    /// True once the env has a definition: the guard of the connect / disconnect / adopt hooks, which only act on
    /// custom elements (state custom needs a definition) and on upgrade candidates (an upgrade needs one).
    #[inline(always)]
    pub fn defined(&self) -> bool {
        !self.defs.is_empty()
    }

    /// Drops the upgrade reaction "create an element" just queued for `el`, if any: the last record, since
    /// nothing runs between an element's creation and this call.
    fn unqueue_created(&mut self, el: NodeId) {
        if self.queue.last().is_some_and(|r| r.el == el) {
            self.queue.pop();
        }
    }
}

impl Env {
    /// The definition for (`doc`, HTML namespace, `local`, `is`) (HTML "look up a custom element definition");
    /// 0 for none.
    fn ce_lookup(&self, doc: NodeId, local: Atom, is: Atom) -> u32 {
        if self.ce.defs.is_empty() {
            return 0;
        }
        let Some(&reg) = self.ce.regs.get(&doc) else { return 0 };
        if let Some(&d) = self.ce.lookup.get(&(reg, local, local)) {
            return d;
        }
        if is.is_none() {
            return 0;
        }
        self.ce.lookup.get(&(reg, is, local)).copied().unwrap_or(0)
    }

    fn ce_elem(&self, el: NodeId) -> ElemCe {
        self.ce.elems.get(&el).copied().unwrap_or_default()
    }

    /// `is` value of `el` (none for most elements).
    pub(crate) fn ce_is(&self, el: NodeId) -> Atom {
        if self.ce.elems.is_empty() { Atom::NONE } else { self.ce_elem(el).is }
    }

    /// Sets `el`'s state, definition and `is` value, and its meta bits.
    pub fn ce_set(&mut self, el: NodeId, st: u32, def: u32, is: Atom) {
        let bits = match st {
            state::CUSTOM => CE_CUSTOM,
            state::UNCUSTOMIZED => 0,
            _ => CE_UNDEFINED,
        };
        let r = self.rec_mut(el);
        r.meta = (r.meta & !(CE_CUSTOM | CE_UNDEFINED)) | bits;
        if st == state::UNCUSTOMIZED && is.is_none() {
            self.ce.elems.remove(&el);
        } else {
            self.ce.elems.insert(el, ElemCe { state: st, def, is });
        }
    }

    fn ce_push(&mut self, r: Reaction) {
        self.ce.queue.push(r);
        let v = self.ep.get(ep::MO_PENDING) | CE_BIT;
        self.ep.set(ep::MO_PENDING, v);
    }

    /// Enqueues callback `kind` for custom element `el` if its definition has that callback.
    fn ce_callback(&mut self, el: NodeId, kind: u32, a: u32, b: u32) {
        let def = self.ce_elem(el).def;
        if def != 0 && self.ce.defs[def as usize - 1].callbacks & kind != 0 {
            self.ce_push(Reaction { el, kind, a, b, old: None, new: None });
        }
    }

    /// HTML "enqueue a custom element upgrade reaction".
    fn ce_enqueue_upgrade(&mut self, el: NodeId, def: u32) {
        self.ce_push(Reaction { el, kind: cb::UPGRADE, a: def, b: 0, old: None, new: None });
    }

    /// HTML "try to upgrade an element".
    fn ce_try_upgrade(&mut self, el: NodeId) {
        let c = self.ce_elem(el);
        if c.state != state::UNDEFINED {
            return;
        }
        let def = self.ce_lookup(self.node_doc(el), Atom(self.rec(el).local), c.is);
        if def != 0 {
            self.ce_enqueue_upgrade(el, def);
        }
    }

    /// Element creation (DOM "create an element" without synchronous custom elements): marks a valid custom
    /// element name (or an `is` value) undefined and enqueues an upgrade when a definition exists.
    pub(crate) fn ce_created(&mut self, el: NodeId, local: Atom, is: Atom) {
        let name = self.atoms.name(local);
        if is.is_none() && !(name.contains('-') && crate::shadow::is_valid_custom_element_name(name)) {
            return;
        }
        self.ce_set(el, state::UNDEFINED, 0, is);
        let def = self.ce_lookup(self.rec(el).owner, local, is);
        if def != 0 {
            self.ce_enqueue_upgrade(el, def);
        }
    }

    /// Shadow-including inclusive descendants of `root` in shadow-including tree order (elements only).
    fn ce_elements(&self, root: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack: SmallVec<[NodeId; 16]> = smallvec::smallvec![root];
        while let Some(n) = stack.pop() {
            let r = self.rec(n);
            if r.meta & meta::KIND_MASK == kind::ELEMENT {
                out.push(n);
            }
            let mut c = r.last;
            while c != 0 {
                stack.push(c);
                c = self.rec(c).prev;
            }
            let sr = self.shadow_root_of(n);
            if sr != 0 {
                stack.push(sr);
            }
        }
        out
    }

    /// DOM "insert" step 7.7 for connected `node`: connectedCallback or try to upgrade, per element.
    #[cold]
    pub(crate) fn ce_connected(&mut self, node: NodeId) {
        for el in self.ce_elements(node) {
            let m = self.rec(el).meta;
            if m & CE_CUSTOM != 0 {
                self.ce_callback(el, cb::CONNECTED, 0, 0);
            } else if m & CE_UNDEFINED != 0 {
                self.ce_try_upgrade(el);
            }
        }
    }

    /// DOM "remove" steps 15-16 for `node`, removed from a connected parent: disconnectedCallback.
    #[cold]
    pub(crate) fn ce_disconnected(&mut self, node: NodeId) {
        for el in self.ce_elements(node) {
            if self.rec(el).meta & CE_CUSTOM != 0 {
                self.ce_callback(el, cb::DISCONNECTED, 0, 0);
            }
        }
    }

    /// DOM "adopt" step 3.3: adoptedCallback(old, new) for each custom shadow-including inclusive descendant.
    #[cold]
    pub(crate) fn ce_adopted(&mut self, node: NodeId, old_doc: NodeId, new_doc: NodeId) {
        for el in self.ce_elements(node) {
            if self.rec(el).meta & CE_CUSTOM != 0 {
                self.ce_callback(el, cb::ADOPTED, old_doc, new_doc);
            }
        }
    }

    /// DOM "handle attribute changes" for custom element `el`: attributeChangedCallback(local, old, new, ns)
    /// when `local` is observed.
    #[cold]
    pub(crate) fn ce_attr_changed(&mut self, el: NodeId, local: Atom, ns: Atom, old: Option<&Str>) {
        let def = self.ce_elem(el).def;
        if def == 0 {
            return;
        }
        let d = &self.ce.defs[def as usize - 1];
        if d.callbacks & cb::ATTRIBUTE == 0 || !d.observed.contains(&local) {
            return;
        }
        let new = self.get_attr_by_atoms(el, ns, local).cloned();
        let old = old.cloned();
        self.ce_push(Reaction { el, kind: cb::ATTRIBUTE, a: local.0, b: ns.0, old, new });
    }

    /// Gives freshly created HTML element `el` the `is` value `is` (createElement's `{ is }`, the parser's `is`
    /// attribute): "create an element" with that `is` value instead of none.
    pub(crate) fn ce_set_is(&mut self, el: NodeId, is: Atom) {
        self.ce.unqueue_created(el);
        let local = Atom(self.rec(el).local);
        self.ce_created(el, local, is);
    }

    /// Cloning steps: the copy keeps the `is` value (DOM "clone a node" step 2.1), with its upgrade.
    #[cold]
    pub(crate) fn ce_cloned(&mut self, src: NodeId, dst: NodeId) {
        let is = self.ce_elem(src).is;
        if !is.is_none() && self.ns_of(dst) == Ns::Html {
            self.ce_set_is(dst, is);
        }
    }

    /// `customElements.define` step 15-17: registers the definition and enqueues upgrades for the
    /// document's shadow-including candidates. Returns the definition id.
    pub fn ce_define(&mut self, reg: u32, name: Atom, local: Atom, callbacks: u32, observed: &[Atom]) -> u32 {
        self.ce.defs.push(Def { callbacks, observed: observed.into() });
        let id = self.ce.defs.len() as u32;
        self.ce.lookup.insert((reg, name, local), id);
        let Some(&doc) = self.ce.reg_docs.get(&reg) else { return id };
        let customized = name != local;
        for el in self.ce_elements(doc) {
            let r = self.rec(el);
            if r.local == local.0
                && r.meta & meta::NS_MASK == 0
                && (!customized || self.ce_elem(el).is == name)
            {
                self.ce_enqueue_upgrade(el, id);
            }
        }
        id
    }

    /// `customElements.upgrade(root)`: try to upgrade each shadow-including inclusive descendant element.
    pub fn ce_upgrade_tree(&mut self, root: NodeId) {
        if self.ce.elems.is_empty() {
            return;
        }
        for el in self.ce_elements(root) {
            self.ce_try_upgrade(el);
        }
    }

    /// Takes the reaction queue into OUT: `[total, n, n x [el, kind, a, b, oldStart, oldLen, newStart,
    /// newLen]]` (string offsets in UTF-16 units into the returned string, `u32::MAX` length = null).
    pub fn ce_take(&mut self) -> &str {
        let queue = std::mem::take(&mut self.ce.queue);
        let v = self.ep.get(ep::MO_PENDING) & !CE_BIT;
        self.ep.set(ep::MO_PENDING, v);
        let mut words: Vec<u32> = Vec::with_capacity(2 + queue.len() * 8);
        words.extend_from_slice(&[0, queue.len() as u32]);
        self.ce.scratch.clear();
        let mut off = 0u32;
        for r in queue {
            let mut s = |v: &Option<Str>, scratch: &mut String| match v {
                Some(v) => {
                    let start = off;
                    let l = utf16_len(v.as_str());
                    scratch.push_str(v.as_str());
                    off += l;
                    (start, l)
                }
                None => (0, u32::MAX),
            };
            let (os, ol) = s(&r.old, &mut self.ce.scratch);
            let (ns, nl) = s(&r.new, &mut self.ce.scratch);
            words.extend_from_slice(&[r.el, r.kind, r.a, r.b, os, ol, ns, nl]);
        }
        words[0] = words.len() as u32;
        self.write_out(&words);
        self.ce.scratch.as_str()
    }
}

fn split_names(e: &mut Env, s: &str) -> SmallVec<[Atom; 4]> {
    if s.is_empty() {
        return SmallVec::new();
    }
    s.split('\u{0}').map(|n| e.intern(n)).collect()
}

natives! {
    /// Binds window document `doc` to custom element registry `reg` (1-based, assigned by the facade).
    fn ceBindDoc(e, doc: u32, reg: u32) -> () {
        e.ce.regs.insert(doc, reg);
        e.ce.reg_docs.insert(reg, doc);
    }
    /// customElements.define: registers (reg, name, local name, callback bits, observed names joined by U+0000), enqueues upgrades; returns the definition id.
    fn ceDefine(e, reg: u32, name: str, local: str, callbacks: u32, observed: str) -> u32 {
        let name = e.intern(name);
        let local = e.intern(local);
        let obs = split_names(e, observed);
        e.ce_define(reg, name, local, callbacks, &obs)
    }
    /// HTMLConstructor with an empty construction stack: a new HTML element `local` in `doc`, state custom with definition `def` and `is` value (empty: none). Allocates.
    fn ceCreate(e, doc: u32, local: str, def: u32, is: str) -> u32 {
        let local = e.intern(local);
        let is = if is.is_empty() { Atom::NONE } else { e.intern(is) };
        let el = e.create_element_full(doc, local, Ns::Html.uri(), Atom::NONE);
        e.ce.unqueue_created(el);
        e.ce_set(el, state::CUSTOM, def, is);
        el
    }
    /// Gives HTML element `el`, just created, the `is` value `is` (createElement's `{ is }`): state undefined, and an upgrade reaction if a definition exists.
    fn ceSetIs(e, el: u32, is: str) -> () {
        if e.is_element(el) && e.ns_of(el) == Ns::Html {
            let is = e.intern(is);
            e.ce_set_is(el, is);
        }
    }
    /// Sets the custom element state and definition of `el` (upgrades, failed constructions).
    fn ceSetState(e, el: u32, st: u32, def: u32) -> () {
        let is = e.ce_elem(el).is;
        e.ce_set(el, st, def, is);
    }
    /// Sets the namespace prefix of element `el` (createElementNS of a custom element: after construction).
    fn ceSetPrefix(e, el: u32, prefix: str) -> () {
        let p = e.intern(prefix);
        if let Some(d) = e.elem_mut(el) {
            d.prefix = p;
        }
        if e.is_element(el) {
            e.rec_mut(el).meta |= meta::HAS_PREFIX;
        }
    }
    /// DOM "validate and extract" of `qname` (InvalidCharacterError / NamespaceError for a bad qualified name).
    fn validateQName(e, qname: str) -> u32 {
        match e.validate_and_extract(Some("http://www.w3.org/1999/xhtml"), qname, true) {
            Ok(_) => 1,
            Err(err) => e.fail(err),
        }
    }
    /// Custom element state of `el` (crate::ce::state).
    fn ceState(e, el: u32) -> u32 {
        e.ce_elem(el).state
    }
    /// Definition id of `el` (0 = none).
    fn ceDef(e, el: u32) -> u32 {
        e.ce_elem(el).def
    }
    /// `is` value of `el` (null = none).
    fn ceIs(e, el: u32) -> Option<&str> {
        let is = e.ce_elem(el).is;
        if is.is_none() { None } else { Some(e.atoms.name(is)) }
    }
    /// customElements.upgrade(root).
    fn ceUpgradeTree(e, root: u32) -> () {
        e.ce_upgrade_tree(root)
    }
    /// Takes the queued reactions (see `Env::ce_take`); returns the attribute value string.
    fn ceTake(e) -> &str {
        e.ce_take()
    }
}
