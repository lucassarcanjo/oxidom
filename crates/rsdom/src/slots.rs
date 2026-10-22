//! Slots and slot assignment (DESIGN §42 part 2, ROADMAP Stage 4 `shadow-dom`): a port of the slot half of
//! refs/jsdom/lib/jsdom/living/helpers/shadow-dom.js (`assignSlot`, `assignSlotable`, `assignSlotableForTree`,
//! `findSlot`, `findSlotable`, `findFlattenedSlotables`, `signalSlotChange`) and of the call sites in
//! `Node-impl.js` (`_insert`, `_remove`), `Slotable-impl.js` and `HTMLSlotElement-impl.js`.
//!
//! State lives in [`ShadowState`](crate::shadow::ShadowState): each slottable's assigned slot, each slot's
//! assigned nodes, and the signal slot list. Names are read from the attributes when needed (`slot` on a
//! slottable element, `name` on a slot), so parsing and cloning need no hook. tree.rs runs [`Env::slot_insert`]
//! and [`Env::slot_remove`], hooks.rs [`Env::slot_attr_changed`], all behind `shadow.any()`: until the env's
//! first `attachShadow` no slot can have an assigned node and none of this runs.
//!
//! Differences from jsdom, both what the DOM spec and browsers do:
//! - a node that leaves a slot's assigned nodes loses its assigned slot (jsdom keeps a stale `_assignedSlot`,
//!   which only its event path reads);
//! - `assignSlotableForTree` after an insertion runs only when the inserted subtree holds a slot (without one
//!   it cannot change any assignment), and recomputes the whole tree in one walk instead of one walk per slot.
//!
//! Signals: [`Env::slot_signal`] adds the slot to the env's list and sets bit 0 of `EP[MO_PENDING]`, so the
//! facade's mutation-observer microtask runs; lib/mo.cjs takes the list (`slotTakeSignals`) before calling
//! the observers and fires `slotchange` at each slot after them, as jsdom's `notifyMutationObservers` does.

use rustc_hash::FxHashMap;
use smallvec::SmallVec;

use crate::atoms::{Atom, atom};
use crate::env::Env;
use crate::node::{kind, meta};
use crate::shadow::mode;
use crate::string::Str;
use crate::table::NodeId;

type Nodes = SmallVec<[NodeId; 8]>;

impl Env {
    /// True if `n` is an HTML `<slot>` element.
    #[inline]
    pub fn is_slot(&self, n: NodeId) -> bool {
        let r = self.rec(n);
        r.meta & (meta::KIND_MASK | meta::NS_MASK) == kind::ELEMENT && r.local == atom::SLOT.0
    }

    /// True for slottables: elements and Text (CDATASection included).
    #[inline]
    fn is_slottable(&self, n: NodeId) -> bool {
        matches!(self.kind(n), kind::ELEMENT | kind::TEXT | kind::CDATA)
    }

    /// DOM "slot name" of slot `s` (its `name` attribute, or "").
    fn slot_name(&self, s: NodeId) -> &str {
        self.get_attr_by_atoms(s, Atom::NONE, atom::NAME).map_or("", Str::as_str)
    }

    /// DOM slottable "name" of `n` (an element's `slot` attribute, or "").
    fn slottable_name(&self, n: NodeId) -> &str {
        self.get_attr_by_atoms(n, Atom::NONE, atom::SLOT).map_or("", Str::as_str)
    }

    /// Slots of the tree rooted at `root` in tree order (inclusive, not shadow-including).
    fn slots_in(&self, root: NodeId) -> Nodes {
        let mut out = Nodes::new();
        let mut n = root;
        while n != 0 {
            if self.is_slot(n) {
                out.push(n);
            }
            n = self.next_in_subtree(n, root);
        }
        out
    }

    /// True if the subtree rooted at `n` holds a slot.
    fn has_slot_in(&self, n: NodeId) -> bool {
        let mut c = n;
        while c != 0 {
            if self.is_slot(c) {
                return true;
            }
            c = self.next_in_subtree(c, n);
        }
        false
    }

    /// First slot named `name` in shadow tree `root` (0 if none).
    fn first_slot_named(&self, root: NodeId, name: &str) -> NodeId {
        let mut n = root;
        while n != 0 {
            if self.is_slot(n) && self.slot_name(n) == name {
                return n;
            }
            n = self.next_in_subtree(n, root);
        }
        0
    }

    /// DOM "find a slot" for `n`; with `open_only`, none in a closed shadow root (Slottable.assignedSlot).
    pub fn find_slot(&self, n: NodeId, open_only: bool) -> NodeId {
        let parent = self.rec(n).parent;
        if parent == 0 || !self.is_slottable(n) {
            return 0;
        }
        let shadow = self.shadow_root_of(parent);
        if shadow == 0 || (open_only && self.shadow_mode(shadow) == mode::CLOSED) {
            return 0;
        }
        self.first_slot_named(shadow, self.slottable_name(n))
    }

    /// DOM "find slottables" for slot `s`.
    fn find_slottables(&self, s: NodeId) -> Nodes {
        let mut out = Nodes::new();
        let root = self.root_of(s);
        if !self.is_shadow_root(root) {
            return out;
        }
        let name = self.slot_name(s);
        if self.first_slot_named(root, name) != s {
            return out;
        }
        let mut c = self.rec(self.shadow_host(root)).first;
        while c != 0 {
            if self.is_slottable(c) && self.slottable_name(c) == name {
                out.push(c);
            }
            c = self.rec(c).next;
        }
        out
    }

    /// Assigned nodes of slot `s` (empty for anything else).
    pub fn slot_assigned_nodes(&self, s: NodeId) -> &[NodeId] {
        self.shadow.assigned_nodes.get(&s).map_or(&[], |v| v.as_slice())
    }

    /// Assigned slot of slottable `n` (0 if unassigned). Unlike [`Env::find_slot`] it ignores the mode.
    pub fn assigned_slot(&self, n: NodeId) -> NodeId {
        if self.shadow.assigned_slot.is_empty() {
            return 0;
        }
        self.shadow.assigned_slot.get(&n).copied().unwrap_or(0)
    }

    /// Sets slot `s`'s assigned nodes to `nodes` (the tail of DOM "assign slottables"): signals a slot change
    /// if the list differs, unassigns the nodes that left (unless another slot took them already) and assigns
    /// the new ones.
    fn set_assigned(&mut self, s: NodeId, nodes: Nodes) {
        let old = self.shadow.assigned_nodes.get(&s).map_or(&[][..], |v| v.as_slice());
        if old == nodes.as_slice() {
            return;
        }
        let old: Nodes = old.iter().copied().collect();
        self.slot_signal(s);
        let st = &mut self.shadow;
        for n in old {
            if !nodes.contains(&n) && st.assigned_slot.get(&n) == Some(&s) {
                st.assigned_slot.remove(&n);
            }
        }
        for &n in &nodes {
            st.assigned_slot.insert(n, s);
        }
        if nodes.is_empty() {
            st.assigned_nodes.remove(&s);
        } else {
            st.assigned_nodes.insert(s, nodes.into_vec());
        }
    }

    /// DOM "assign slottables" for slot `s`.
    fn assign_slottables(&mut self, s: NodeId) {
        let nodes = self.find_slottables(s);
        self.set_assigned(s, nodes);
    }

    /// DOM "assign a slot" for slottable `n`.
    fn assign_slot(&mut self, n: NodeId) {
        let s = self.find_slot(n, false);
        if s != 0 {
            self.assign_slottables(s);
        }
    }

    /// DOM "assign slottables for a tree" rooted at `root`: one walk for the slots, one pass over the host's
    /// children, then each slot in tree order (the order its slot changes are signalled in).
    fn assign_slottables_for_tree(&mut self, root: NodeId) {
        let slots = self.slots_in(root);
        if slots.is_empty() {
            return;
        }
        let mut lists: SmallVec<[Nodes; 4]> = slots.iter().map(|_| Nodes::new()).collect();
        if self.is_shadow_root(root) {
            let mut first: FxHashMap<&str, usize> = FxHashMap::default();
            for (i, &s) in slots.iter().enumerate() {
                first.entry(self.slot_name(s)).or_insert(i);
            }
            let mut c = self.rec(self.shadow_host(root)).first;
            while c != 0 {
                if self.is_slottable(c)
                    && let Some(&i) = first.get(self.slottable_name(c))
                {
                    lists[i].push(c);
                }
                c = self.rec(c).next;
            }
        }
        for (s, nodes) in slots.into_iter().zip(lists) {
            self.set_assigned(s, nodes);
        }
    }

    /// DOM "signal a slot change".
    pub fn slot_signal(&mut self, s: NodeId) {
        if !self.shadow.signals.contains(&s) {
            self.shadow.signals.push(s);
        }
        crate::mo::set_pending(self);
    }

    /// DOM "insert" steps 7.4-7.7 for `n`, just inserted into `parent` (shadows exist).
    #[cold]
    pub(crate) fn slot_insert(&mut self, parent: NodeId, n: NodeId) {
        if self.shadow_root_of(parent) != 0 && self.is_slottable(n) {
            self.assign_slot(n);
        }
        let root = self.root_of(parent);
        if !self.is_shadow_root(root) {
            return;
        }
        if self.is_slot(parent) && self.slot_assigned_nodes(parent).is_empty() {
            self.slot_signal(parent);
        }
        if self.has_slot_in(n) {
            self.assign_slottables_for_tree(root);
        }
    }

    /// The part of DOM "remove" that runs before unlinking `n` from `parent` (shadows exist): whether the
    /// slot steps after it have anything to do (`parent` is in a shadow tree) and whether `n`'s subtree holds
    /// a slot. Outside shadow trees no slot has assigned nodes, so neither step can change anything.
    #[cold]
    pub(crate) fn slot_pre_remove(&self, parent: NodeId, n: NodeId) -> (bool, bool) {
        let in_shadow = self.is_shadow_root(self.root_of(parent));
        (in_shadow, in_shadow && self.has_slot_in(n))
    }

    /// DOM "remove" steps 7-10 for `n`, just removed from `parent` (shadows exist).
    #[cold]
    pub(crate) fn slot_remove(&mut self, parent: NodeId, n: NodeId, in_shadow: bool, has_slot: bool) {
        let s = self.assigned_slot(n);
        if s != 0 {
            self.assign_slottables(s);
        }
        if in_shadow && self.is_slot(parent) && self.slot_assigned_nodes(parent).is_empty() {
            self.slot_signal(parent);
        }
        if has_slot {
            let root = self.root_of(parent);
            self.assign_slottables_for_tree(root);
            self.assign_slottables_for_tree(n);
        }
    }

    /// Attribute change steps of slottables (`slot`) and slots (`name`); `old` is the previous value.
    /// Changes between absent and "" do nothing (jsdom `Slotable-impl.js`, `HTMLSlotElement-impl.js`).
    #[cold]
    pub(crate) fn slot_attr_changed(&mut self, el: NodeId, local: Atom, old: Option<&Str>) {
        let old = old.map_or("", Str::as_str);
        if local == atom::SLOT {
            if self.slottable_name(el) == old {
                return;
            }
            let s = self.assigned_slot(el);
            if s != 0 {
                self.assign_slottables(s);
            }
            self.assign_slot(el);
        } else if local == atom::NAME && self.is_slot(el) {
            if self.slot_name(el) == old {
                return;
            }
            let root = self.root_of(el);
            self.assign_slottables_for_tree(root);
        }
    }

    /// DOM "find flattened slottables" for `s`, in order (an explicit stack: nested slots can be deep).
    pub fn find_flattened_slottables(&self, s: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack: Vec<NodeId> = vec![s];
        while let Some(x) = stack.pop() {
            if x != s && !(self.is_slot(x) && self.is_shadow_root(self.root_of(x))) {
                out.push(x);
                continue;
            }
            if !self.is_shadow_root(self.root_of(x)) {
                continue;
            }
            let assigned = self.slot_assigned_nodes(x);
            if !assigned.is_empty() {
                stack.extend(assigned.iter().rev());
            } else {
                let mut c = self.rec(x).last;
                while c != 0 {
                    if self.is_slottable(c) {
                        stack.push(c);
                    }
                    c = self.rec(c).prev;
                }
            }
        }
        out
    }

    /// Takes the signal slot list (DOM "notify mutation observers" step 3), into OUT; returns its length.
    pub fn slot_take_signals(&mut self) -> u32 {
        let list = std::mem::take(&mut self.shadow.signals);
        crate::mo::set_pending(self);
        self.write_out(&list)
    }
}

natives! {
    /// Assigned slot of `n` (0 if unassigned), whatever its shadow root's mode: the event path's parent.
    fn slotAssigned(e, n: u32) -> u32 {
        e.assigned_slot(n)
    }
    /// DOM "find a slot" for `n` (`open_only`: Slottable.assignedSlot).
    fn slotFind(e, n: u32, open_only: bool) -> u32 {
        e.find_slot(n, open_only)
    }
    /// HTMLSlotElement.assignedNodes({ flatten }) of slot `s`, into OUT; returns the length.
    fn slotAssignedNodes(e, s: u32, flatten: bool) -> u32 {
        if flatten {
            let v = e.find_flattened_slottables(s);
            e.write_out(&v)
        } else {
            let v: SmallVec<[NodeId; 8]> = e.slot_assigned_nodes(s).iter().copied().collect();
            e.write_out(&v)
        }
    }
    /// Takes the signal slot list (slots to fire `slotchange` at, in order), into OUT; returns the length.
    fn slotTakeSignals(e) -> u32 {
        e.slot_take_signals()
    }
}

#[cfg(test)]
mod tests {
    use crate::atoms::atom;
    use crate::dom::DocKind;
    use crate::env::Env;
    use crate::node::Ns;
    use crate::shadow::mode;
    use crate::table::NodeId;

    fn setup() -> (Env, NodeId, NodeId, NodeId) {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let host = e.create_element(doc, atom::DIV, Ns::Html);
        let root = e.attach_shadow(host, mode::OPEN).unwrap();
        (e, doc, host, root)
    }

    fn slot(e: &mut Env, doc: NodeId, name: Option<&str>) -> NodeId {
        let s = e.create_element(doc, atom::SLOT, Ns::Html);
        if let Some(n) = name {
            e.set_attr(s, atom::NAME, n).unwrap();
        }
        s
    }

    fn signals(e: &mut Env) -> Vec<NodeId> {
        std::mem::take(&mut e.shadow.signals)
    }

    #[test]
    fn assigns_by_name_in_tree_order() {
        let (mut e, doc, host, root) = setup();
        let a = e.create_element(doc, atom::SPAN, Ns::Html);
        e.set_attr(a, atom::SLOT, "x").unwrap();
        let t = e.create_text(doc, "hi");
        e.append_child(host, a).unwrap();
        e.append_child(host, t).unwrap();
        assert_eq!(e.assigned_slot(a), 0);
        let def = slot(&mut e, doc, None);
        let x1 = slot(&mut e, doc, Some("x"));
        e.append_child(root, def).unwrap();
        e.append_child(root, x1).unwrap();
        assert_eq!(e.slot_assigned_nodes(def), &[t]);
        assert_eq!(e.slot_assigned_nodes(x1), &[a]);
        assert_eq!(signals(&mut e), vec![def, x1]);
        // An earlier slot with the same name takes the nodes over.
        let x0 = slot(&mut e, doc, Some("x"));
        e.pre_insert(x0, root, def).unwrap();
        assert_eq!(e.slot_assigned_nodes(x0), &[a]);
        assert!(e.slot_assigned_nodes(x1).is_empty());
        assert_eq!(e.assigned_slot(a), x0);
        assert_eq!(signals(&mut e), vec![x0, x1]);
        // Renaming the slottable moves it; "" and absent are the same name.
        e.set_attr(a, atom::SLOT, "").unwrap();
        assert_eq!(e.slot_assigned_nodes(def), &[a, t]);
        assert!(e.slot_assigned_nodes(x0).is_empty());
        assert_eq!(signals(&mut e), vec![x0, def]);
        e.remove_attr(a, atom::SLOT);
        assert!(signals(&mut e).is_empty());
        // Removing a slottable unassigns it.
        e.remove_child(host, a).unwrap();
        assert_eq!(e.assigned_slot(a), 0);
        assert_eq!(e.slot_assigned_nodes(def), &[t]);
        // Removing a slot reassigns its nodes and empties its list.
        e.remove_child(root, def).unwrap();
        assert!(e.slot_assigned_nodes(def).is_empty());
        assert_eq!(e.assigned_slot(t), 0);
    }

    #[test]
    fn flattened_and_fallback() {
        let (mut e, doc, host, root) = setup();
        let s = slot(&mut e, doc, None);
        let fb = e.create_text(doc, "fallback");
        e.append_child(s, fb).unwrap();
        e.append_child(root, s).unwrap();
        assert_eq!(e.find_flattened_slottables(s), vec![fb]);
        // A slot in the host's light tree assigned to `s` flattens to its own assigned nodes.
        let inner_host = e.create_element(doc, atom::DIV, Ns::Html);
        let inner_root = e.attach_shadow(inner_host, mode::CLOSED).unwrap();
        let s2 = slot(&mut e, doc, None);
        e.append_child(inner_root, s2).unwrap();
        e.append_child(root, inner_host).unwrap();
        e.append_child(inner_host, s).unwrap(); // move `s` under the inner host
        assert_eq!(e.slot_assigned_nodes(s2), &[s]);
        let c = e.create_element(doc, atom::B, Ns::Html);
        e.append_child(host, c).unwrap();
        assert_eq!(e.slot_assigned_nodes(s), &[c]);
        assert_eq!(e.find_flattened_slottables(s2), vec![c]);
        assert_eq!(e.find_slot(s, true), 0);
        assert_eq!(e.find_slot(s, false), s2);
    }
}
