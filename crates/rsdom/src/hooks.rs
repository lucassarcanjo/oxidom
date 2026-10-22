//! Mutation hook fan-out. tree.rs / attrs.rs / text.rs / parse.rs call these at the spec'd points; each
//! hook forwards to the area modules (style/, forms.rs, focus.rs, mo.rs). Area owners implement the
//! functions in THEIR module and should not need to touch this file or the mutation algorithms.
//!
//! | hook | when | forwards to |
//! |---|---|---|
//! | `node_connected` | each inclusive descendant of a subtree that became connected | style, forms |
//! | `node_disconnected` | each inclusive descendant of a subtree that became disconnected | focus fixup, style, forms |
//! | `children_changed` | DOM "children changed steps": after each insert or remove step on `parent` (replace-all runs it once per removed child and once for the insertion, as jsdom does); for a `FreshTree`, once per parent when it finishes | style, forms |
//! | `attr_changed` | after an attribute was added, removed or set to a different value | style, forms, mo |
//! | `attr_same_value` | after a same-value set of class/id/style/type/hidden/open/popover (no `attr_ver` / `EP[ATTR]` bump; other same-value sets take `attr_changed`) | forms, mo |
//! | `char_data_changed` | after Text/Comment/PI data changed | style, forms, mo |
//! | `cloned` | cloning steps for each cloned element | forms |
//! | `parsed` | once per parse, for the nodes it created (ids `base..`), before they are inserted | forms |
//!
//! Children-changed and both attribute hooks also bump the document version (`bump_doc_version`).
//!
//! The child-list module (tree.rs, DESIGN §17) is the only caller of the connectivity and children-changed
//! hooks, and it queues the MutationObserver childList records itself (they need the exact
//! added/removed/prev/next of each step, or the merged record of replace / replace-all).

use crate::atoms::Atom;
use crate::env::{Env, ep};
use crate::node::meta;
use crate::string::Str;
use crate::table::NodeId;

impl Env {
    /// Bumps the document version (the document record's `attr_ver`: documents have no attributes) when `n`
    /// is connected: what jsdom's `Document#_version` counts, child-list and attribute changes in the
    /// document, for XPathResult's `invalidIteratorState` (lib/xpath.cjs, DESIGN §39). A plain increment, not
    /// an epoch value, so it never returns to an earlier value. `CONNECTED` is shadow-including, so a
    /// shadow tree's changes count too, where jsdom's parent chain stops at the shadow root.
    #[inline]
    fn bump_doc_version(&mut self, n: NodeId) {
        let r = self.rec(n);
        if r.meta & meta::CONNECTED != 0 {
            let d = self.rec_mut(r.owner);
            d.attr_ver = d.attr_ver.wrapping_add(1);
        }
    }

    /// See module docs.
    #[inline]
    pub(crate) fn hook_node_connected(&mut self, id: NodeId) {
        crate::style::on_node_connected(self, id);
        crate::forms::on_node_connected(self, id);
    }

    /// See module docs.
    #[inline]
    pub(crate) fn hook_node_disconnected(&mut self, id: NodeId) {
        crate::focus::on_node_disconnected(self, id);
        crate::style::on_node_disconnected(self, id);
        crate::forms::on_node_disconnected(self, id);
    }

    /// A set that leaves the value of an attribute with derived state unchanged (attrs.rs
    /// `has_derived_state`). It is still an attribute change for
    /// MutationObservers (a record with the old value) and for the forms attribute change steps (jsdom runs
    /// them too: re-setting `checked` re-checks a clean radio and unchecks its group), but nothing derived
    /// from the value can change: attrs.rs allocates no `Str` and skips the class re-split / id cache /
    /// meta flags, style is not invalidated, and `attr_ver` / `EP[ATTR]` stay put (every JS memo they
    /// validate depends on attribute values and presence only). React re-sets `type` / `name` / `class` on
    /// every update (class: 31k of the heavy file's setAttribute calls).
    #[cold]
    #[inline(never)]
    pub(crate) fn hook_attr_same_value(&mut self, el: NodeId, local: Atom, ns: Atom) {
        if crate::mo::active(self, el) {
            let old = self.elem(el).and_then(|d| d.find_ns(ns, local).map(|i| d.attrs[i].value.clone()));
            crate::mo::queue_attribute(self, el, local, ns, old.as_ref());
        }
        self.bump_doc_version(el);
        // forms only tests `old.is_some()` (the attribute was present: it still is)
        crate::forms::on_attr_changed(self, el, local, ns, Some(&Str::default()));
    }

    /// See module docs. Also bumps `parent.child_ver` and `EP[TREE]`.
    #[inline]
    pub(crate) fn hook_children_changed(&mut self, parent: NodeId) {
        let v = self.ep.bump(ep::TREE);
        self.rec_mut(parent).child_ver = v;
        self.bump_doc_version(parent);
        crate::style::on_children_changed(self, parent);
        crate::forms::on_children_changed(self, parent);
    }

    /// See module docs. Also bumps `attr_ver` and `EP[ATTR]`, and queues the MO record.
    #[inline]
    pub(crate) fn hook_attr_changed(&mut self, el: NodeId, local: Atom, ns: Atom, old: Option<&Str>) {
        let v = self.ep.bump(ep::ATTR);
        self.rec_mut(el).attr_ver = v;
        self.bump_doc_version(el);
        crate::mo::queue_attribute(self, el, local, ns, old);
        crate::style::on_attr_changed(self, el, local, ns, old);
        crate::forms::on_attr_changed(self, el, local, ns, old);
    }

    /// See module docs. Also bumps `EP[TEXT]`, stores the new value as the node's data version
    /// (`NodeRec.attr_ver`, which character-data nodes use as `DATA_VER`: the facade's data memo key) and
    /// queues the MO record. `old` is only meaningful when `mo::active(id)` (callers skip the copy otherwise).
    #[inline]
    pub(crate) fn hook_char_data_changed(&mut self, id: NodeId, old: &Str) {
        let v = self.ep.bump(ep::TEXT);
        self.rec_mut(id).attr_ver = v;
        crate::mo::queue_char_data(self, id, old);
        crate::style::on_char_data_changed(self, id);
        crate::forms::on_char_data_changed(self, id);
    }

    /// See module docs.
    #[inline]
    pub(crate) fn hook_cloned(&mut self, src: NodeId, dst: NodeId) {
        crate::forms::on_cloned(self, src, dst);
    }

    /// See module docs. The parser links nodes raw (no per-node hooks); this lets areas initialise state
    /// derived from the parsed attributes (e.g. input checkedness / type bits, option selectedness).
    #[inline]
    pub(crate) fn hook_parsed(&mut self, base: NodeId) {
        crate::forms::on_parsed(self, base);
    }
}
