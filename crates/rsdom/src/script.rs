//! Script execution state (DESIGN §45, ROADMAP Stage 4 `browsing-contexts` part 1): the Rust half of jsdom 30's
//! `HTMLScriptElement-impl.js` and `_globalEventChanged`. The facade (lib/scripts.cjs) runs scripts and compiles
//! inline event handlers; this module keeps the per-script flags and queues what a mutation owes a script element
//! or an `on*` attribute, on the custom element reaction queue (crate::ce), so the `mutated()` epilogue drains it.
//!
//! - Bound documents ([`ScriptState::docs`]): documents whose window runs scripts (`scriptBindDoc`). Every hook
//!   runs behind `script.on()`: an env with no bound document pays one emptiness test.
//! - Per script element: "parser-inserted" (set by the HTML parser, and by lib/xml.cjs) and "already started" (set
//!   by the fragment parser and in documents with scripting disabled, copied by cloning).
//! - Reactions: [`cb::SCRIPT`] (a script became connected, got children inserted while connected, or got a `src`
//!   while connected) and [`cb::HANDLER`] (an `on*` attribute of an HTML or SVG element changed; `a` = its local
//!   name).

use rustc_hash::{FxHashMap, FxHashSet};

use crate::atoms::{Atom, atom};
use crate::ce::cb;
use crate::env::Env;
use crate::node::{Ns, kind, meta};
use crate::table::NodeId;

/// Script element flag: created by the HTML parser.
pub const PARSER_INSERTED: u32 = 1;
/// Script element flag: "already started".
pub const STARTED: u32 = 2;

/// Env-wide script state (`Env.script`).
#[derive(Default, Debug)]
pub struct ScriptState {
    /// documents whose window runs scripts
    docs: FxHashSet<NodeId>,
    /// flags of script elements that have any
    flags: FxHashMap<NodeId, u32>,
}

impl ScriptState {
    /// True once some document runs scripts (the hot-path guard).
    #[inline(always)]
    pub fn on(&self) -> bool {
        !self.docs.is_empty()
    }

    /// True once some document runs scripts or some script element has flags (the cloning hook's guard).
    #[inline(always)]
    pub fn any(&self) -> bool {
        !self.docs.is_empty() || !self.flags.is_empty()
    }

    /// Marks a script element the HTML parser created: parser-inserted, and already started (`started`) when the
    /// parser is the fragment parsing algorithm's or scripting is disabled (`DOMParser`), as HTML "create an
    /// element for the token" says, so neither it nor a clone of it ever runs.
    #[inline]
    pub(crate) fn parser_created(&mut self, el: NodeId, started: bool) {
        self.flags.insert(el, if started { PARSER_INSERTED | STARTED } else { PARSER_INSERTED });
    }
}

/// True if `name` is an event handler content attribute name candidate (`on` + at least one character).
#[inline]
fn is_handler_name(name: &str) -> bool {
    name.len() > 2 && name.as_bytes().starts_with(b"on")
}

impl Env {
    #[inline]
    fn is_html_script(&self, id: NodeId) -> bool {
        let r = self.rec(id);
        r.meta & (meta::KIND_MASK | meta::NS_MASK) == kind::ELEMENT && r.local == atom::SCRIPT.0
    }

    fn script_push(&mut self, el: NodeId, kind: u32, a: u32) {
        self.ce_push_raw(el, kind, a);
    }

    /// Hook: `id` became connected (per node of the connect pass).
    #[inline]
    pub(crate) fn script_connected(&mut self, id: NodeId) {
        if self.is_html_script(id) && self.script.docs.contains(&self.node_doc(id)) {
            self.script_push(id, cb::SCRIPT, 0);
        }
    }

    /// Hook: nodes were inserted into `parent` (DOM "children changed", insertions only).
    #[inline]
    pub(crate) fn script_children_inserted(&mut self, parent: NodeId) {
        if self.rec(parent).meta & meta::CONNECTED != 0
            && self.is_html_script(parent)
            && self.script.docs.contains(&self.node_doc(parent))
        {
            self.script_push(parent, cb::SCRIPT, 0);
        }
    }

    /// Hook: attribute (`ns`, `local`) of element `el` changed (or was set to the same value).
    #[inline]
    pub(crate) fn script_attr_changed(&mut self, el: NodeId, local: Atom, ns: Atom) {
        if ns != Atom::NONE
            || (local != atom::SRC && !is_handler_name(self.atoms.name(local)))
            || !self.script.docs.contains(&self.node_doc(el))
        {
            return;
        }
        if local == atom::SRC {
            if self.rec(el).meta & meta::CONNECTED != 0
                && self.is_html_script(el)
                && self.get_attr_by_atoms(el, ns, local).is_some()
            {
                self.script_push(el, cb::SCRIPT, 0);
            }
        } else if is_handler_name(self.atoms.name(local)) && matches!(self.ns_of(el), Ns::Html | Ns::Svg) {
            self.script_push(el, cb::HANDLER, local.0);
        }
    }

    /// Queues a handler reaction for each `on*` attribute of HTML / SVG element `el`.
    fn script_handlers_of(&mut self, el: NodeId) {
        if !matches!(self.ns_of(el), Ns::Html | Ns::Svg) {
            return;
        }
        let Some(d) = self.elem(el) else { return };
        let names: smallvec::SmallVec<[Atom; 4]> = d
            .attrs
            .iter()
            .filter(|a| a.ns == Atom::NONE && is_handler_name(self.atoms.name(a.local)))
            .map(|a| a.local)
            .collect();
        for local in names {
            self.script_push(el, cb::HANDLER, local.0);
        }
    }

    /// Hook: fragment parsing created nodes `base..` in a bound document (their parsed attributes).
    #[cold]
    pub(crate) fn script_parsed(&mut self, base: NodeId, doc: NodeId) {
        if !self.script.docs.contains(&doc) {
            return;
        }
        for id in base..self.table.len() {
            if self.rec(id).meta & meta::KIND_MASK == kind::ELEMENT {
                self.script_handlers_of(id);
            }
        }
    }

    /// Hook: cloning steps for element `dst` (a copy of `src`).
    #[cold]
    pub(crate) fn script_cloned(&mut self, src: NodeId, dst: NodeId) {
        if let Some(&f) = self.script.flags.get(&src)
            && f & STARTED != 0
        {
            self.script.flags.insert(dst, STARTED);
        }
        if self.script.on() && self.script.docs.contains(&self.node_doc(dst)) {
            self.script_handlers_of(dst);
        }
    }

    /// The parsed document's scripts and `on*` attributes in tree order, into OUT: `[kind, el, local]` triples
    /// (`cb::SCRIPT` or `cb::HANDLER`). Returns the word count.
    pub fn script_parsed_list(&mut self, doc: NodeId) -> u32 {
        let mut words: Vec<u32> = Vec::new();
        let mut n = self.rec(doc).first;
        while n != 0 {
            if self.rec(n).meta & meta::KIND_MASK == kind::ELEMENT {
                if matches!(self.ns_of(n), Ns::Html | Ns::Svg)
                    && let Some(d) = self.elem(n)
                {
                    for a in &d.attrs {
                        if a.ns == Atom::NONE && is_handler_name(self.atoms.name(a.local)) {
                            words.extend_from_slice(&[cb::HANDLER, n, a.local.0]);
                        }
                    }
                }
                if self.is_html_script(n) {
                    words.extend_from_slice(&[cb::SCRIPT, n, 0]);
                }
            }
            n = self.next_in_subtree(n, doc);
        }
        self.write_out(&words)
    }
}

natives! {
    /// Binds (`on` = 1) or unbinds document `doc` as one whose window runs scripts (DESIGN §45).
    fn scriptBindDoc(e, doc: u32, on: u32) -> () {
        if on != 0 {
            e.script.docs.insert(doc);
        } else {
            e.script.docs.remove(&doc);
        }
    }
    /// Script element flags (PARSER_INSERTED = 1, STARTED = 2).
    fn scriptFlags(e, el: u32) -> u32 {
        e.script.flags.get(&el).copied().unwrap_or(0)
    }
    /// Sets script element flags.
    fn scriptSetFlags(e, el: u32, flags: u32) -> () {
        if flags == 0 {
            e.script.flags.remove(&el);
        } else {
            e.script.flags.insert(el, flags);
        }
    }
    /// The parsed document's scripts and `on*` attributes in tree order, into OUT (`script_parsed_list`); returns
    /// the word count.
    fn scriptParsed(e, doc: u32) -> u32 {
        e.script_parsed_list(doc)
    }
}
