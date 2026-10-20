//! The child-list module (DESIGN §17): every change to a child list goes through it. Pre-insert validation
//! (order per jsdom `Node-impl.js` L833-1009 / DOM §4.2.3), then the DOM primitives [`Env::insert`] and
//! [`Env::remove`], which own one step's bookkeeping in spec order: adoption, linking, the connect /
//! disconnect pass (CONNECTED bits, document id map, per-node hooks), the MutationObserver record (unless
//! the caller passes [`Records::Suppress`] and queues a merged one) and the children-changed steps
//! (`child_ver` / `EP[TREE]` and the area hooks, see `crate::hooks`). Replace, replace-all and adopt are
//! composed from them exactly as in DOM §4.2.3, so they run the children-changed steps once per step
//! (replace-all: once per removed child and once for the insertion), as jsdom does.
//!
//! Nodes created inside the current native call (document creation, cloning) are assembled with
//! [`FreshTree`], the only quiet path; the HTML parser links its own nodes and settles them through
//! `Env::hook_parsed` plus an ordinary insert (fragments) or [`FreshTree::take_linked`] (documents).
//!
//! `remove` runs the NodeIterator pre-removing steps (crate::traversal, DESIGN §16) before unlinking, as DOM
//! §4.2.3 "remove" step 4 does. Live-range fix-ups (not implemented) belong in `insert` / `remove` too; fresh
//! nodes are unreachable for both.

use smallvec::SmallVec;

use crate::atoms::Atom;
use crate::env::Env;
use crate::error::{Code, DomError, DomResult, code};
use crate::node::{kind, meta};
use crate::table::NodeId;

type Nodes = SmallVec<[NodeId; 8]>;

/// DOM "suppress observers flag" of insert / remove: replace-a-child and replace-all suppress the
/// per-step records and queue one merged record themselves.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Records {
    /// The step queues its own childList record.
    Queue,
    /// The caller queues a merged record.
    Suppress,
}

/// Assembles a subtree from nodes created inside the current native call. Nothing outside the call can
/// reach them yet, so [`FreshTree::append`] queues no record and defers the children-changed steps to
/// [`FreshTree::finish`], which runs them once per parent after the subtree is complete (jsdom clones
/// bottom-up, so its insertion steps always see complete subtrees: a cloned `<select>` resets its
/// selectedness against all of its options). Appends into a connected parent run the connect pass at once.
#[derive(Default)]
#[must_use = "call `finish` to run the deferred children-changed steps"]
pub(crate) struct FreshTree {
    parents: SmallVec<[NodeId; 16]>,
}

impl FreshTree {
    /// Appends fresh `child` (no parent) to fresh or connected `parent`.
    #[inline]
    pub(crate) fn append(&mut self, e: &mut Env, parent: NodeId, child: NodeId) {
        e.link(child, parent, 0);
        if e.rec(parent).meta & meta::CONNECTED != 0 {
            e.connect_subtree(child);
        }
        self.note(parent);
    }

    /// Takes over children the HTML parser already linked into `parent` (the tree builder moves nodes
    /// itself while parsing).
    pub(crate) fn take_linked(&mut self, e: &mut Env, parent: NodeId) {
        if e.rec(parent).meta & meta::CONNECTED != 0 {
            let mut c = e.rec(parent).first;
            while c != 0 {
                e.connect_subtree(c);
                c = e.rec(c).next;
            }
        }
        self.note(parent);
    }

    #[inline]
    fn note(&mut self, parent: NodeId) {
        // Parents fill in batches; a repeat that slips through only reruns idempotent steps.
        if self.parents.last() != Some(&parent) {
            self.parents.push(parent);
        }
    }

    /// Runs the deferred children-changed steps, once per parent.
    pub(crate) fn finish(self, e: &mut Env) {
        for p in self.parents {
            e.hook_children_changed(p);
        }
    }
}

impl Env {
    // ------------------------------------------------------------------------------- raw linking

    /// Links a detached `node` into `parent` before `before` (0 = append). No hooks or records.
    pub(crate) fn link(&mut self, node: NodeId, parent: NodeId, before: NodeId) {
        let prev = if before != 0 { self.rec(before).prev } else { self.rec(parent).last };
        {
            let n = self.rec_mut(node);
            n.parent = parent;
            n.prev = prev;
            n.next = before;
        }
        if prev != 0 {
            self.rec_mut(prev).next = node;
        } else {
            self.rec_mut(parent).first = node;
        }
        if before != 0 {
            self.rec_mut(before).prev = node;
        } else {
            self.rec_mut(parent).last = node;
        }
        self.rec_mut(parent).child_len += 1;
    }

    /// Unlinks `node` from its parent. No hooks or records.
    pub(crate) fn unlink(&mut self, node: NodeId) {
        let r = *self.rec(node);
        let parent = r.parent;
        if parent == 0 {
            return;
        }
        if r.prev != 0 {
            self.rec_mut(r.prev).next = r.next;
        } else {
            self.rec_mut(parent).first = r.next;
        }
        if r.next != 0 {
            self.rec_mut(r.next).prev = r.prev;
        } else {
            self.rec_mut(parent).last = r.prev;
        }
        let p = self.rec_mut(parent);
        p.child_len = p.child_len.saturating_sub(1);
        let n = self.rec_mut(node);
        n.parent = 0;
        n.prev = 0;
        n.next = 0;
    }

    // ------------------------------------------------------------------------- connectivity

    /// Marks the subtree rooted at `root` connected: CONNECTED bits, id map, per-node hooks.
    pub(crate) fn connect_subtree(&mut self, root: NodeId) {
        let mut n = root;
        while n != 0 {
            let r = self.rec_mut(n);
            r.meta |= meta::CONNECTED;
            if r.meta & (meta::KIND_MASK | meta::HAS_ID) == kind::ELEMENT | meta::HAS_ID {
                self.id_map_add(n);
            }
            self.hook_node_connected(n);
            n = self.next_in_subtree(n, root);
        }
    }

    /// Marks the subtree rooted at `root` disconnected (focus fixup and id-map removal included).
    pub(crate) fn disconnect_subtree(&mut self, root: NodeId) {
        let mut n = root;
        while n != 0 {
            let r = self.rec_mut(n);
            r.meta &= !meta::CONNECTED;
            if r.meta & (meta::KIND_MASK | meta::HAS_ID) == kind::ELEMENT | meta::HAS_ID {
                self.id_map_remove(n);
            }
            self.hook_node_disconnected(n);
            n = self.next_in_subtree(n, root);
        }
    }

    /// Adds connected element `el` to its document's id map (no-op without an id).
    pub(crate) fn id_map_add(&mut self, el: NodeId) {
        let Some(id) = self.elem(el).map(|d| d.id).filter(|a| !a.is_none()) else { return };
        let doc = self.node_doc(el);
        if let Some(d) = self.doc_data_mut(doc) {
            d.id_map.entry(id).or_default().push(el);
        }
    }

    /// Removes `el` from its document's id map.
    pub(crate) fn id_map_remove(&mut self, el: NodeId) {
        let Some(id) = self.elem(el).map(|d| d.id).filter(|a| !a.is_none()) else { return };
        self.id_map_remove_atom(el, id);
    }

    /// Removes `el` under key `id` (used when the id attribute changes).
    pub(crate) fn id_map_remove_atom(&mut self, el: NodeId, id: Atom) {
        let doc = self.node_doc(el);
        if let Some(d) = self.doc_data_mut(doc) {
            if let Some(v) = d.id_map.get_mut(&id) {
                if let Some(i) = v.iter().position(|&x| x == el) {
                    v.swap_remove(i);
                }
                if v.is_empty() {
                    d.id_map.remove(&id);
                }
            }
        }
    }

    // ------------------------------------------------------------------------- validation

    #[inline]
    fn node_kind(&self, id: NodeId) -> DomResult<u32> {
        match self.kind(id) {
            0 => Err(DomError::Type),
            k => Ok(k),
        }
    }

    fn element_children(&self, p: NodeId) -> u32 {
        let mut n = 0;
        let mut c = self.rec(p).first;
        while c != 0 {
            if self.is_element(c) {
                n += 1;
            }
            c = self.rec(c).next;
        }
        n
    }

    fn has_child_of_kind(&self, p: NodeId, k: u32, except: NodeId) -> bool {
        let mut c = self.rec(p).first;
        while c != 0 {
            if c != except && self.kind(c) == k {
                return true;
            }
            c = self.rec(c).next;
        }
        false
    }

    fn has_text_child(&self, p: NodeId) -> bool {
        let mut c = self.rec(p).first;
        while c != 0 {
            if self.kind(c) == kind::TEXT {
                return true;
            }
            c = self.rec(c).next;
        }
        false
    }

    /// True if a doctype follows `child` among its siblings.
    fn doctype_following(&self, child: NodeId) -> bool {
        let mut c = self.rec(child).next;
        while c != 0 {
            if self.kind(c) == kind::DOCTYPE {
                return true;
            }
            c = self.rec(c).next;
        }
        false
    }

    /// True if an element precedes `child` among its siblings.
    fn element_preceding(&self, child: NodeId) -> bool {
        let mut c = self.rec(child).prev;
        while c != 0 {
            if self.is_element(c) {
                return true;
            }
            c = self.rec(c).prev;
        }
        false
    }

    /// DOM "ensure pre-insert validity" (`replace` = the replace-child variant with `child` excluded;
    /// `exclude_all` = every current child of `parent` is excluded from the document checks, as jsdom does
    /// for `replaceChildren`, whose replace-all removes them).
    fn ensure_validity(
        &self,
        node: NodeId,
        parent: NodeId,
        child: NodeId,
        replace: bool,
        exclude_all: bool,
    ) -> DomResult {
        let pk = self.node_kind(parent)?;
        let nk = self.node_kind(node)?;
        // 1. parent must be a Document, DocumentFragment or Element.
        if !matches!(pk, kind::DOCUMENT | kind::FRAGMENT | kind::ELEMENT) {
            return Err(DomError::HierarchyRequest);
        }
        // 2. node must not be a (host-including) inclusive ancestor of parent.
        if self.is_host_including_inclusive_ancestor(node, parent) {
            return Err(DomError::HierarchyRequest);
        }
        // 3. child (if any) must be a child of parent.
        if (child != 0 || replace) && self.rec(child).parent != parent {
            return Err(DomError::NotFound);
        }
        // 4. node kind.
        if !matches!(
            nk,
            kind::FRAGMENT
                | kind::DOCTYPE
                | kind::ELEMENT
                | kind::TEXT
                | kind::CDATA
                | kind::PI
                | kind::COMMENT
        ) {
            return Err(DomError::HierarchyRequest);
        }
        // 5. Text into a document, or a doctype into a non-document.
        if (nk == kind::TEXT && pk == kind::DOCUMENT) || (nk == kind::DOCTYPE && pk != kind::DOCUMENT) {
            return Err(DomError::HierarchyRequest);
        }
        // 6. Document-only constraints.
        if pk != kind::DOCUMENT {
            return Ok(());
        }
        let excl = if replace { child } else { 0 };
        let parent_has_element = || {
            if exclude_all {
                return false;
            }
            let mut c = self.rec(parent).first;
            while c != 0 {
                if c != excl && self.is_element(c) {
                    return true;
                }
                c = self.rec(c).next;
            }
            false
        };
        match nk {
            kind::FRAGMENT => {
                let els = self.element_children(node);
                if els > 1 || self.has_text_child(node) {
                    return Err(DomError::HierarchyRequest);
                }
                if els == 1
                    && (parent_has_element()
                        || (!replace && child != 0 && self.kind(child) == kind::DOCTYPE)
                        || (child != 0 && self.doctype_following(child)))
                {
                    return Err(DomError::HierarchyRequest);
                }
            }
            kind::ELEMENT => {
                if parent_has_element()
                    || (!replace && child != 0 && self.kind(child) == kind::DOCTYPE)
                    || (child != 0 && self.doctype_following(child))
                {
                    return Err(DomError::HierarchyRequest);
                }
            }
            kind::DOCTYPE => {
                let has_doctype = !exclude_all && self.has_child_of_kind(parent, kind::DOCTYPE, excl);
                let bad = if replace {
                    has_doctype || self.element_preceding(child)
                } else {
                    has_doctype
                        || (child != 0 && self.element_preceding(child))
                        || (child == 0 && parent_has_element())
                };
                if bad {
                    return Err(DomError::HierarchyRequest);
                }
            }
            _ => {}
        }
        Ok(())
    }

    // ------------------------------------------------------------------------- algorithms

    /// The document nodes inserted into `parent` must belong to.
    #[inline]
    fn doc_for_children_of(&self, parent: NodeId) -> NodeId {
        // A document's `owner` is itself, so this works for every parent kind.
        self.rec(parent).owner
    }

    /// DOM "pre-insert": validates, then inserts `node` into `parent` before `child` (0 = append).
    pub fn pre_insert(&mut self, node: NodeId, parent: NodeId, child: NodeId) -> DomResult {
        self.ensure_validity(node, parent, child, false, false)?;
        let reference = if child == node { self.rec(node).next } else { child };
        self.insert(node, parent, reference, Records::Queue);
        Ok(())
    }

    /// `appendChild`.
    pub fn append_child(&mut self, parent: NodeId, node: NodeId) -> DomResult {
        self.pre_insert(node, parent, 0)
    }

    /// DOM "insert" (no validation). Fragments insert their children; nodes are adopted (which removes
    /// them from their old parent first, with its own record).
    pub fn insert(&mut self, node: NodeId, parent: NodeId, child: NodeId, records: Records) {
        let is_frag = self.kind(node) == kind::FRAGMENT;
        let nodes: Nodes = if is_frag { self.children_vec(node) } else { smallvec::smallvec![node] };
        if nodes.is_empty() {
            return;
        }
        if is_frag {
            for &c in &nodes {
                self.remove(c, Records::Suppress);
            }
            // Unconditional (DOM "insert" step 4.2): the fragment's own record ignores the caller's flag.
            crate::mo::queue_child_list(self, node, &[], &nodes, 0, 0);
        }
        // previousSibling is computed before adoption (spec order; it can be `node` itself on a move).
        let prev = if child != 0 { self.rec(child).prev } else { self.rec(parent).last };
        let doc = self.doc_for_children_of(parent);
        let connected = self.rec(parent).meta & meta::CONNECTED != 0;
        for &n in &nodes {
            self.adopt(n, doc);
            self.link(n, parent, child);
            if connected {
                self.connect_subtree(n);
            }
        }
        if records == Records::Queue {
            crate::mo::queue_child_list(self, parent, &nodes, &[], prev, child);
        }
        self.hook_children_changed(parent);
    }

    /// DOM "pre-remove": `child` must be a child of `parent`.
    pub fn remove_child(&mut self, parent: NodeId, child: NodeId) -> DomResult {
        self.node_kind(parent)?;
        self.node_kind(child)?;
        if self.rec(child).parent != parent {
            return Err(DomError::NotFound);
        }
        self.remove(child, Records::Queue);
        Ok(())
    }

    /// DOM "remove" (`node` must have a parent; otherwise a no-op).
    pub fn remove(&mut self, node: NodeId, records: Records) {
        let r = *self.rec(node);
        let parent = r.parent;
        if parent == 0 {
            return;
        }
        if !self.traversal.is_empty() {
            self.node_iterators_pre_remove(node);
        }
        let was_connected = r.meta & meta::CONNECTED != 0;
        self.unlink(node);
        if was_connected {
            self.disconnect_subtree(node);
        }
        if records == Records::Queue {
            crate::mo::queue_child_list(self, parent, &[], &[node], r.prev, r.next);
        }
        self.hook_children_changed(parent);
    }

    /// DOM "adopt": removes `node` from its parent, then moves its subtree to `doc` if needed.
    pub fn adopt(&mut self, node: NodeId, doc: NodeId) {
        if self.rec(node).parent != 0 {
            self.remove(node, Records::Queue);
        }
        let old_doc = self.node_doc(node);
        if old_doc == doc || self.kind(node) == kind::DOCUMENT {
            return;
        }
        // Work list of (subtree root, new owner document). Template contents (at any nesting depth) move to
        // the new document's template-contents owner (HTML adopting steps).
        let mut work: SmallVec<[(NodeId, NodeId); 4]> = smallvec::smallvec![(node, doc)];
        while let Some((root, owner)) = work.pop() {
            let html = self.doc_data(owner).is_some_and(|d| d.html);
            let mut n = root;
            while n != 0 {
                let r = self.rec_mut(n);
                r.owner = owner;
                if html {
                    r.meta |= meta::HTML_DOC;
                } else {
                    r.meta &= !meta::HTML_DOC;
                }
                if let Some(content) = self.elem(n).map(|d| d.template).filter(|&t| t != 0) {
                    let tdoc = self.template_doc(owner);
                    work.push((content, tdoc));
                }
                n = self.next_in_subtree(n, root);
            }
        }
        if !self.traversal.is_empty() {
            // NodeIterators rooted in the moved nodes now belong to their new document (crate::traversal)
            self.node_iterators_rebucket();
        }
    }

    /// `document.adoptNode`.
    pub fn adopt_node(&mut self, doc: NodeId, node: NodeId) -> DomResult {
        match self.node_kind(node)? {
            kind::DOCUMENT => Err(DomError::NotSupported),
            _ if self.doc_data(doc).is_none() => Err(DomError::Type),
            _ => {
                self.adopt(node, doc);
                Ok(())
            }
        }
    }

    /// DOM "replace a child" (`parent.replaceChild(node, child)`).
    pub fn replace_child(&mut self, parent: NodeId, node: NodeId, child: NodeId) -> DomResult {
        self.ensure_validity(node, parent, child, true, false)?;
        let mut reference = self.rec(child).next;
        if reference == node {
            reference = self.rec(node).next;
        }
        let mut prev = self.rec(child).prev;
        if prev == node {
            prev = self.rec(node).prev;
        }
        let doc = self.doc_for_children_of(parent);
        self.adopt(node, doc);
        let mut removed: Nodes = SmallVec::new();
        if self.rec(child).parent != 0 {
            removed.push(child);
            self.remove(child, Records::Suppress);
        }
        let nodes: Nodes = if self.kind(node) == kind::FRAGMENT {
            self.children_vec(node)
        } else {
            smallvec::smallvec![node]
        };
        self.insert(node, parent, reference, Records::Suppress);
        crate::mo::queue_child_list(self, parent, &nodes, &removed, prev, reference);
        Ok(())
    }

    /// DOM "replace all" (`node` = 0 for none): textContent / innerHTML / replaceChildren.
    pub fn replace_all(&mut self, node: NodeId, parent: NodeId) {
        let removed = self.children_vec(parent);
        let added: Nodes = match node {
            0 => SmallVec::new(),
            n if self.kind(n) == kind::FRAGMENT => self.children_vec(n),
            n => smallvec::smallvec![n],
        };
        if node != 0 {
            let doc = self.doc_for_children_of(parent);
            self.adopt(node, doc);
        }
        for &c in &removed {
            self.remove(c, Records::Suppress);
        }
        if node != 0 {
            self.insert(node, parent, 0, Records::Suppress);
        }
        if !added.is_empty() || !removed.is_empty() {
            crate::mo::queue_child_list(self, parent, &added, &removed, 0, 0);
        }
    }

    /// DOM "convert nodes into a node": one node is returned as is; several are moved into a new
    /// fragment (each via pre-insert, so they leave their old parents).
    pub fn nodes_into_node(&mut self, doc: NodeId, nodes: &[NodeId]) -> DomResult<NodeId> {
        for &n in nodes {
            self.node_kind(n)?;
        }
        match nodes {
            [] => Ok(self.create_fragment(doc)),
            [one] => Ok(*one),
            many => {
                let frag = self.create_fragment(doc);
                for &n in many {
                    self.pre_insert(n, frag, 0)?;
                }
                Ok(frag)
            }
        }
    }

    /// `replaceChildren(...nodes)`.
    pub fn replace_children(&mut self, parent: NodeId, nodes: &[NodeId]) -> DomResult {
        self.node_kind(parent)?;
        let doc = self.doc_for_children_of(parent);
        let node = self.nodes_into_node(doc, nodes)?;
        self.ensure_validity(node, parent, 0, false, true)?;
        self.replace_all(node, parent);
        Ok(())
    }

    /// `ChildNode.remove()`.
    pub fn remove_self(&mut self, node: NodeId) {
        self.remove(node, Records::Queue);
    }
}

natives! {
    /// insertBefore(parent, node, child) with child 0 = append. Returns 0 or an error code.
    fn insertBefore(e, parent: u32, node: u32, child: u32) -> Code {
        code(e.pre_insert(node, parent, child))
    }
    /// appendChild(parent, node). Returns 0 or an error code.
    fn appendChild(e, parent: u32, node: u32) -> Code {
        code(e.append_child(parent, node))
    }
    /// removeChild(parent, child). Returns 0 or an error code.
    fn removeChild(e, parent: u32, child: u32) -> Code {
        code(e.remove_child(parent, child))
    }
    /// replaceChild(parent, node, child). Returns 0 or an error code.
    fn replaceChild(e, parent: u32, node: u32, child: u32) -> Code {
        code(e.replace_child(parent, node, child))
    }
    /// ChildNode.remove().
    fn remove(e, id: u32) -> () {
        e.remove_self(id)
    }
    /// document.adoptNode(node) (detach + ownerDocument update). Returns 0 or an error code.
    fn adopt(e, doc: u32, id: u32) -> Code {
        code(e.adopt_node(doc, id))
    }
    /// replaceChildren(parent, count): node ids are read from OUT[0..count].
    fn replaceChildren(e, parent: u32, count: u32) -> Code {
        let ids = e.out.read_vec(count as usize);
        code(e.replace_children(parent, &ids))
    }
    /// Convert nodes (ids in OUT[0..count]) into one node, creating a fragment for several. 0 + EP[ERR] on error.
    fn nodesToNode(e, doc: u32, count: u32) -> u32 {
        let ids = e.out.read_vec(count as usize);
        let r = e.require_doc(doc).and_then(|d| e.nodes_into_node(d, &ids));
        e.id_or_fail(r)
    }
    /// contains(a, b): b is an inclusive descendant of a.
    fn contains(e, a: u32, b: u32) -> bool {
        a != 0 && e.kind(a) != 0 && e.is_inclusive_ancestor(a, b)
    }
    /// Child ids of `id` into OUT (elements only if `elems_only`). Returns the count.
    fn children(e, id: u32, elems_only: bool) -> u32 {
        let mut ids = std::mem::take(&mut e.ids);
        ids.clear();
        let mut c = e.rec(id).first;
        while c != 0 {
            if !elems_only || e.is_element(c) { ids.push(c); }
            c = e.rec(c).next;
        }
        e.ids = ids;
        e.write_ids()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atoms::atom;
    use crate::dom::DocKind;
    use crate::node::Ns;

    fn setup() -> (Env, NodeId, NodeId) {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let body = e.rec(e.rec(doc).last).last; // html -> body
        assert!(e.is_html_elem(body, atom::BODY));
        (e, doc, body)
    }

    fn div(e: &mut Env, doc: NodeId) -> NodeId {
        e.create_element(doc, atom::DIV, Ns::Html)
    }

    #[test]
    fn append_move_remove() {
        let (mut e, doc, body) = setup();
        let a = div(&mut e, doc);
        let b = div(&mut e, doc);
        e.append_child(body, a).unwrap();
        e.append_child(body, b).unwrap();
        assert_eq!(e.children_vec(body).as_slice(), &[a, b]);
        assert!(e.rec(a).meta & meta::CONNECTED != 0);
        // insertBefore(n, n) is a no-op position-wise.
        e.pre_insert(a, body, a).unwrap();
        assert_eq!(e.children_vec(body).as_slice(), &[a, b]);
        // move b before a
        e.pre_insert(b, body, a).unwrap();
        assert_eq!(e.children_vec(body).as_slice(), &[b, a]);
        e.remove_child(body, b).unwrap();
        assert_eq!(e.children_vec(body).as_slice(), &[a]);
        assert_eq!(e.rec(body).child_len, 1);
        assert!(e.rec(b).meta & meta::CONNECTED == 0);
        assert_eq!(e.remove_child(body, b), Err(DomError::NotFound));
    }

    #[test]
    fn validation_order() {
        let (mut e, doc, body) = setup();
        let p = div(&mut e, doc);
        let c = div(&mut e, doc);
        e.append_child(body, p).unwrap();
        e.append_child(p, c).unwrap();
        // ancestor into descendant
        assert_eq!(e.append_child(c, p), Err(DomError::HierarchyRequest));
        // foreign ref
        let x = div(&mut e, doc);
        let y = div(&mut e, doc);
        assert_eq!(e.pre_insert(x, p, y), Err(DomError::NotFound));
        // ancestor check wins over NotFound (step 2 before step 3)
        assert_eq!(e.pre_insert(p, c, y), Err(DomError::HierarchyRequest));
        // text into document; second element into document
        let t = e.create_text(doc, "x");
        assert_eq!(e.append_child(doc, t), Err(DomError::HierarchyRequest));
        assert_eq!(e.append_child(doc, x), Err(DomError::HierarchyRequest));
        // doctype into element
        let dt = e.create_doctype(doc, "html", "", "");
        assert_eq!(e.append_child(p, dt), Err(DomError::HierarchyRequest));
        // parent is text
        assert_eq!(e.append_child(t, x), Err(DomError::HierarchyRequest));
    }

    #[test]
    fn fragments() {
        let (mut e, doc, body) = setup();
        let f = e.create_fragment(doc);
        let a = div(&mut e, doc);
        let t = e.create_text(doc, "t");
        e.append_child(f, a).unwrap();
        e.append_child(f, t).unwrap();
        e.append_child(body, f).unwrap();
        assert_eq!(e.rec(f).child_len, 0);
        assert_eq!(e.children_vec(body).as_slice(), &[a, t]);
        assert_eq!(e.rec(t).parent, body);
    }

    #[test]
    fn adopt_across_documents() {
        let (mut e, doc, body) = setup();
        let other = e.create_document(DocKind::Html, Some("o"));
        let a = e.create_element(other, atom::DIV, Ns::Html);
        let c = e.create_text(other, "x");
        e.append_child(a, c).unwrap();
        e.append_child(body, a).unwrap();
        assert_eq!(e.node_doc(a), doc);
        assert_eq!(e.node_doc(c), doc);
    }

    #[test]
    fn replace_and_replace_all() {
        let (mut e, doc, body) = setup();
        let a = div(&mut e, doc);
        let b = div(&mut e, doc);
        let c = div(&mut e, doc);
        e.append_child(body, a).unwrap();
        e.append_child(body, b).unwrap();
        e.replace_child(body, c, a).unwrap();
        assert_eq!(e.children_vec(body).as_slice(), &[c, b]);
        e.replace_all(0, body);
        assert_eq!(e.rec(body).child_len, 0);
        assert_eq!(e.rec(body).first, 0);
    }

    #[test]
    fn id_map_and_focus_fixup() {
        let (mut e, doc, body) = setup();
        let a = div(&mut e, doc);
        e.set_attr(a, atom::ID, "x").unwrap();
        let x = e.intern("x");
        assert_eq!(e.get_element_by_id(doc, x), 0, "detached elements are not in the id map");
        e.append_child(body, a).unwrap();
        assert_eq!(e.get_element_by_id(doc, x), a);
        e.rec_mut(a).state |= crate::node::state::FOCUSED;
        e.doc_data_mut(doc).unwrap().focused = a;
        e.remove_child(body, a).unwrap();
        assert_eq!(e.get_element_by_id(doc, x), 0);
        assert_eq!(e.doc_data(doc).unwrap().focused, 0);
    }

    #[test]
    fn compare_positions() {
        let (mut e, doc, body) = setup();
        let a = div(&mut e, doc);
        let b = div(&mut e, doc);
        e.append_child(body, a).unwrap();
        e.append_child(body, b).unwrap();
        assert_eq!(e.compare_document_position(a, b), 4);
        assert_eq!(e.compare_document_position(b, a), 2);
        assert_eq!(e.compare_document_position(a, body), 8 | 2);
        assert_eq!(e.compare_document_position(body, a), 16 | 4);
        let d = div(&mut e, doc);
        assert_eq!(e.compare_document_position(a, d) & 1, 1);
    }

    #[test]
    fn host_including_ancestor_blocks_template_cycles() {
        let (mut e, doc, _body) = setup();
        let t = e.create_element(doc, atom::TEMPLATE, Ns::Html);
        let content = e.template_content(t);
        assert_eq!(e.append_child(content, t), Err(DomError::HierarchyRequest));
        let x = div(&mut e, doc);
        e.append_child(content, x).unwrap();
        assert_eq!(e.append_child(x, t), Err(DomError::HierarchyRequest));
        // ancestor check (step 2) before the child check (step 3)
        let stray = div(&mut e, doc);
        assert_eq!(e.replace_child(x, t, stray), Err(DomError::HierarchyRequest));
        // nested: inner template inside the outer's contents
        let inner = e.create_element(doc, atom::TEMPLATE, Ns::Html);
        e.append_child(x, inner).unwrap();
        let inner_content = e.template_content(inner);
        assert_eq!(e.append_child(inner_content, t), Err(DomError::HierarchyRequest));
        assert!(e.is_host_including_inclusive_ancestor(t, inner_content));
        assert!(!e.is_inclusive_ancestor(t, inner_content));
    }

    #[test]
    fn replace_children_of_document_excludes_current_children() {
        let (mut e, doc, _body) = setup();
        let html = e.create_element(doc, atom::HTML, Ns::Html);
        e.replace_children(doc, &[html]).unwrap();
        assert_eq!(e.children_vec(doc).as_slice(), &[html]);
        let a = div(&mut e, doc);
        let b = div(&mut e, doc);
        assert_eq!(e.replace_children(doc, &[a, b]), Err(DomError::HierarchyRequest));
    }

    #[test]
    fn adopt_reowns_nested_template_contents() {
        let (mut e, doc, body) = setup();
        let other = e.create_document(DocKind::Html, None);
        let t = e.create_element(other, atom::TEMPLATE, Ns::Html);
        let t2 = e.create_element(other, atom::TEMPLATE, Ns::Html);
        let c1 = e.template_content(t);
        e.append_child(c1, t2).unwrap();
        let p = e.create_element(other, atom::P, Ns::Html);
        let c2 = e.template_content(t2);
        e.append_child(c2, p).unwrap();
        e.append_child(body, t).unwrap();
        let tdoc = e.template_doc(doc);
        for n in [c1, t2, c2, p] {
            assert_eq!(e.node_doc(n), tdoc, "node {n}");
        }
    }

    #[test]
    fn replace_all_runs_children_changed_per_step() {
        // DOM replace-all removes each child (children-changed steps each time), then inserts: the select
        // resets at every removal, so options auto-selected on the way out stay selected (jsdom too).
        let (mut e, _doc, body) = setup();
        e.set_inner_html(body, "<select><option selected>a<option>b<option>c</select>").unwrap();
        let s = e.rec(body).first;
        let opts = e.options_of(s);
        e.replace_all(0, s);
        let selected: Vec<bool> =
            opts.iter().map(|&o| e.rec(o).state & crate::node::state::SELECTED != 0).collect();
        assert_eq!(selected, [true, true, true]);
    }

    #[test]
    fn clone_settles_select_against_all_options() {
        let (mut e, doc, body) = setup();
        e.set_inner_html(body, "<select><optgroup><option>o1</optgroup><option>x</select>").unwrap();
        let s = e.rec(body).first;
        let copy = e.clone_node(s, doc, true).unwrap();
        assert_eq!(e.selected_index(copy), 0, "the reset sees the optgroup's options too");
        e.set_inner_html(body, "<select><option selected>a<option selected>b</select>").unwrap();
        let s = e.rec(body).first;
        let copy = e.clone_node(s, doc, true).unwrap();
        assert_eq!(e.selected_index(copy), 1, "the last selected option wins");
    }

    #[test]
    fn fresh_trees_queue_no_records_and_bump_child_ver() {
        let (mut e, doc, body) = setup();
        e.set_inner_html(body, "<div><p>x</p></div>").unwrap();
        e.mo_observe(1, doc, crate::mo::opt::CHILD_LIST | crate::mo::opt::SUBTREE, &[]).unwrap();
        let d = e.rec(body).first;
        let tree = e.ep.get(crate::env::ep::TREE);
        let copy = e.clone_node(d, doc, true).unwrap();
        let other = e.create_document(DocKind::Html, Some("t"));
        assert_eq!(e.ep.get(crate::env::ep::MO_PENDING) & 1, 0, "no record queued");
        assert!(e.ep.get(crate::env::ep::TREE) > tree);
        for parent in [copy, e.rec(copy).first, other, e.rec(other).last] {
            assert!(e.rec(parent).child_ver > tree, "child_ver of {parent}");
        }
    }

    #[test]
    fn cloned_document_owns_its_copies() {
        let (mut e, doc, body) = setup();
        let a = div(&mut e, doc);
        e.set_attr(a, atom::ID, "k").unwrap();
        e.append_child(body, a).unwrap();
        let copy = e.clone_node(doc, doc, true).unwrap();
        let k = e.intern("k");
        let ca = e.get_element_by_id(copy, k);
        assert!(ca != 0 && ca != a);
        assert_eq!(e.node_doc(ca), copy);
        assert!(e.rec(ca).meta & meta::CONNECTED != 0);
        // The copy is in its own document's id map only.
        e.remove_child(body, a).unwrap();
        assert_eq!(e.get_element_by_id(doc, k), 0);
        assert_eq!(e.get_element_by_id(copy, k), ca);
    }

    #[test]
    fn create_document_skeleton_is_connected() {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, Some("t"));
        let mut n = doc;
        let mut count = 0;
        while n != 0 {
            assert!(e.rec(n).meta & meta::CONNECTED != 0, "node {n}");
            count += 1;
            n = e.next_in_subtree(n, doc);
        }
        assert_eq!(count, 7, "document, doctype, html, head, title, text, body");
    }

    #[test]
    fn growth_preserves_tree() {
        let mut e = Env::with_capacity(8);
        let doc = e.create_document(DocKind::Html, None);
        let body = e.rec(e.rec(doc).last).last;
        let gen0 = e.ep.get(crate::env::ep::GEN);
        let mut last = body;
        for _ in 0..100 {
            let d = div(&mut e, doc);
            e.append_child(last, d).unwrap();
            last = d;
        }
        assert!(e.ep.get(crate::env::ep::GEN) > gen0);
        assert!(e.table.capacity() >= 100);
        assert!(e.is_inclusive_ancestor(body, last));
    }
}
