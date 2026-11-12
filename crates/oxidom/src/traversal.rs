//! NodeIterator removal support (DESIGN §16): the registry of live NodeIterators and the DOM §6.1
//! pre-removing steps, which the child-list module runs inside every removal step (`Env::remove`, before the
//! node is unlinked, as DOM §4.2.3 "remove" step 4 does).
//!
//! An iterator's reference and candidate pointers live in `Env.iter_words`, a JS-owned buffer shared with the
//! facade (lib/traversal.cjs, bound by `iterBind`): slot `h - 1` of handle `h` is two words, the reference
//! and the candidate, each packed `id << 1 | pointer before`, candidate 0 = not traversing. The facade walks
//! and writes them with zero FFI between natives; a removal (by any code, including a filter callback
//! mid-traversal) moves them here. Words read from that buffer are untrusted: `adjust` only follows table
//! links of valid ids, and an unknown id never matches.
//!
//! A removal adjusts the iterators whose root's node document is the removed node's, checked at removal time
//! (DOM §4.2.3 "remove" step 4). jsdom instead keeps iterators on the document `createNodeIterator()` was
//! called on (`Document._workingNodeIterators`, refs/jsdom/lib/jsdom/living/nodes/Node-impl.js L1239) and fails
//! WPT dom/traversal/NodeIterator-removal.html for iterators over another document's nodes; oxidom follows the
//! spec and passes it. Iterators are bucketed by their root's node document, so a removal looks only at its own
//! document's iterators, and a cross-document adoption re-buckets the ones whose root moved (template contents
//! included). The facade frees an iterator once JS no longer holds it (a FinalizationRegistry); until then it
//! stays in its document's bucket. With no iterator alive, a removal pays one emptiness check.

use rustc_hash::FxHashMap;

use crate::env::Env;
use crate::table::NodeId;

/// Words per iterator slot in `Env.iter_words`: [reference, candidate].
pub const SLOT_WORDS: usize = 2;

/// Env-wide NodeIterator registry (`Env.traversal`). Handles are slot index + 1 (0 is never a handle). Root 0 is
/// an Attr root, which no removal moves: it is in no bucket.
#[derive(Default, Debug)]
pub struct TraversalState {
    /// (root, the document whose bucket holds it) of each live iterator by slot (`None` = free)
    slots: Vec<Option<(NodeId, NodeId)>>,
    /// handles of the live iterators by their root's node document
    by_doc: FxHashMap<NodeId, Vec<u32>>,
    free: Vec<u32>,
    live: u32,
}

impl TraversalState {
    /// True when no NodeIterator is alive (removals skip the pre-removing steps).
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.live == 0
    }

    fn release(&mut self, h: u32) {
        if let Some(slot) = self.slots.get_mut((h as usize).wrapping_sub(1))
            && let Some((root, doc)) = slot.take()
        {
            self.live -= 1;
            self.free.push(h);
            if root != 0 {
                self.unbucket(doc, h);
            }
        }
    }

    fn bucket(&mut self, doc: NodeId, h: u32) {
        self.by_doc.entry(doc).or_default().push(h);
    }

    fn unbucket(&mut self, doc: NodeId, h: u32) {
        if let Some(hs) = self.by_doc.get_mut(&doc) {
            if let Some(i) = hs.iter().position(|&x| x == h) {
                hs.swap_remove(i);
            }
            if hs.is_empty() {
                self.by_doc.remove(&doc);
            }
        }
    }
}

impl Env {
    /// Registers an iterator over `root` (0 = an Attr root) in its root's document bucket; returns its handle.
    fn iter_create(&mut self, root: NodeId) -> u32 {
        let root = if self.table.contains(root) { root } else { 0 };
        let doc = if root == 0 { 0 } else { self.node_doc(root) };
        let t = &mut self.traversal;
        t.live += 1;
        let h = match t.free.pop() {
            Some(h) => {
                t.slots[h as usize - 1] = Some((root, doc));
                h
            }
            None => {
                t.slots.push(Some((root, doc)));
                t.slots.len() as u32
            }
        };
        if root != 0 {
            t.bucket(doc, h);
        }
        h
    }

    /// After a cross-document adoption: moves every iterator whose root changed document to its new bucket.
    pub(crate) fn node_iterators_rebucket(&mut self) {
        for i in 0..self.traversal.slots.len() {
            let Some((root, doc)) = self.traversal.slots[i] else { continue };
            if root == 0 {
                continue;
            }
            let now = self.node_doc(root);
            if now != doc {
                let h = i as u32 + 1;
                self.traversal.unbucket(doc, h);
                self.traversal.bucket(now, h);
                self.traversal.slots[i] = Some((root, now));
            }
        }
    }

    /// DOM §6.1 NodeIterator pre-removing steps for `node`, about to be removed from its parent, for every
    /// iterator whose root's node document is `node`'s: its reference and, mid-traversal, its candidate.
    pub(crate) fn node_iterators_pre_remove(&mut self, node: NodeId) {
        let doc = self.node_doc(node);
        let Some(hs) = self.traversal.by_doc.remove(&doc) else { return };
        for &h in &hs {
            let Some(Some((root, _))) = self.traversal.slots.get(h as usize - 1).copied() else { continue };
            let o = (h as usize - 1) * SLOT_WORDS;
            let (r, c) = match self.iter_words.words().get(o..o + SLOT_WORDS) {
                Some(w) => (w[0], w[1]),
                None => continue,
            };
            let r = adjust(self, root, r, node);
            let c = if c >> 1 != 0 { adjust(self, root, c, node) } else { c };
            self.iter_words.words()[o..o + SLOT_WORDS].copy_from_slice(&[r, c]);
        }
        self.traversal.by_doc.insert(doc, hs);
    }
}

/// The new packed pointer (`id << 1 | before`) when `removed` is removed
/// (refs/jsdom/lib/jsdom/living/traversal/NodeIterator-impl.js `_adjustNodePointer`): unchanged unless
/// `removed` contains the pointer but not the root; then the first node after `removed`'s subtree inside the
/// root (pointer stays before it), else the node just before `removed` in tree order (pointer after it).
fn adjust(e: &Env, root: NodeId, packed: u32, removed: NodeId) -> u32 {
    let (reference, before) = (packed >> 1, packed & 1 != 0);
    if reference == 0
        || !e.table.contains(reference)
        || !e.is_inclusive_ancestor(removed, reference)
        || e.is_inclusive_ancestor(removed, root)
    {
        return packed;
    }
    if before {
        let mut n = removed;
        while n != 0 && n != root {
            let next = e.rec(n).next;
            if next != 0 {
                return next << 1 | 1;
            }
            n = e.rec(n).parent;
        }
    }
    let prev = e.rec(removed).prev;
    let to = if prev == 0 { e.rec(removed).parent } else { last_inclusive_descendant(e, prev) };
    to << 1
}

/// The last node of `n`'s subtree in tree order.
fn last_inclusive_descendant(e: &Env, mut n: NodeId) -> NodeId {
    loop {
        let c = e.rec(n).last;
        if c == 0 {
            return n;
        }
        n = c;
    }
}

natives! {
    /// Binds the NodeIterator pointer words to the facade's resizable ArrayBuffer (first iterator of an env, and after every resize); returns its capacity in words.
    fn iterBind(e [env], buf: any) -> u32 {
        e.bind_iters(env, buf)
    }
    /// createNodeIterator: registers an iterator over `root` (0 = an Attr root, which no removal moves); returns its handle. The facade then writes its slot.
    fn iterNew(e, root: u32) -> u32 {
        e.iter_create(root)
    }
    /// Forgets iterator `h` (the facade's FinalizationRegistry, once JS no longer holds the iterator).
    fn iterFree(e, h: u32) -> () {
        e.traversal.release(h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atoms::atom;
    use crate::dom::DocKind;
    use crate::node::Ns;
    use crate::tree::Records;

    /// body > [a > [a1, a2], b, c]
    fn setup() -> (Env, NodeId, NodeId, [NodeId; 5]) {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let body = e.rec(e.rec(doc).last).last;
        let mut el = || e.create_element(doc, atom::DIV, Ns::Html);
        let [a, a1, a2, b, c] = [el(), el(), el(), el(), el()];
        for (p, n) in [(body, a), (a, a1), (a, a2), (body, b), (body, c)] {
            e.append_child(p, n).unwrap();
        }
        (e, doc, body, [a, a1, a2, b, c])
    }

    /// Registers an iterator and writes its slot as the facade does.
    fn iter(e: &mut Env, root: NodeId, reference: NodeId, before: bool) -> u32 {
        let h = e.iter_create(root);
        set(e, h, 0, reference, before);
        set(e, h, 1, 0, false);
        h
    }

    fn set(e: &mut Env, h: u32, which: usize, id: NodeId, before: bool) {
        let o = (h as usize - 1) * SLOT_WORDS + which;
        e.iter_words.own_at_least(o + 1)[o] = id << 1 | before as u32;
    }

    fn get(e: &mut Env, h: u32, which: usize) -> (NodeId, bool) {
        let p = e.iter_words.words()[(h as usize - 1) * SLOT_WORDS + which];
        (p >> 1, p & 1 != 0)
    }

    #[test]
    fn removing_the_reference_moves_it_after_the_subtree_while_before() {
        let (mut e, _, body, [a, _, _, b, _]) = setup();
        let h = iter(&mut e, body, a, true);
        e.remove(a, Records::Queue);
        assert_eq!(get(&mut e, h, 0), (b, true));
    }

    #[test]
    fn removing_an_ancestor_of_the_reference_moves_it_to_the_previous_node_when_after() {
        let (mut e, _, body, [a, _, a2, b, _]) = setup();
        let h = iter(&mut e, body, b, false);
        e.remove(b, Records::Queue);
        // the last inclusive descendant of b's previous sibling
        assert_eq!(get(&mut e, h, 0), (a2, false));
        e.remove(a, Records::Queue);
        // no previous sibling: the parent
        assert_eq!(get(&mut e, h, 0), (body, false));
    }

    #[test]
    fn last_node_removed_while_before_falls_back_to_the_previous_node() {
        let (mut e, _, body, [_, _, _, b, c]) = setup();
        let h = iter(&mut e, body, c, true);
        e.remove(c, Records::Queue);
        assert_eq!(get(&mut e, h, 0), (b, false));
    }

    #[test]
    fn the_candidate_moves_too_and_unrelated_or_root_removals_do_not() {
        let (mut e, _, _, [a, a1, a2, b, _]) = setup();
        let h = iter(&mut e, a, a1, false);
        set(&mut e, h, 1, a2, false);
        e.remove(b, Records::Queue); // outside the pointers
        assert_eq!(get(&mut e, h, 0), (a1, false));
        e.remove(a2, Records::Queue);
        assert_eq!(get(&mut e, h, 1), (a1, false));
        e.remove(a, Records::Queue); // the root itself
        assert_eq!(get(&mut e, h, 0), (a1, false));
    }

    #[test]
    fn replace_all_runs_the_steps_per_removed_child() {
        let (mut e, _, body, [_, _, _, _, c]) = setup();
        let h = iter(&mut e, body, c, true);
        e.replace_all(0, body);
        assert_eq!(get(&mut e, h, 0), (body, false));
    }

    #[test]
    fn removals_adjust_iterators_whose_root_is_in_the_removed_nodes_document() {
        let (mut e, _, _, [a, a1, a2, ..]) = setup();
        let other = e.create_document(DocKind::Html, None);
        let other_body = e.rec(e.rec(other).last).last;
        let x = e.create_element(other, atom::DIV, Ns::Html);
        e.append_child(other_body, x).unwrap();
        // an iterator over the other document's nodes, as `document.createNodeIterator(otherBody)` makes
        let h = iter(&mut e, other_body, x, false);
        e.remove(a1, Records::Queue); // this document: no effect
        assert_eq!(get(&mut e, h, 0), (x, false));
        e.remove(x, Records::Queue);
        assert_eq!(get(&mut e, h, 0), (other_body, false));
        // adopting the root moves the iterator to the root's new document
        let h2 = iter(&mut e, a, a2, false);
        e.adopt(a, other);
        e.append_child(other_body, a).unwrap();
        e.remove(a2, Records::Queue);
        assert_eq!(get(&mut e, h2, 0), (a, false));
    }

    #[test]
    fn removals_look_only_at_their_documents_bucket_and_freed_iterators_leave_it() {
        let (mut e, doc, body, [a, ..]) = setup();
        let other = e.create_document(DocKind::Html, None);
        let other_body = e.rec(e.rec(other).last).last;
        let hs: Vec<u32> = (0..3).map(|_| iter(&mut e, other_body, other_body, true)).collect();
        assert_eq!(e.traversal.by_doc.get(&other).map(Vec::len), Some(3));
        assert!(!e.traversal.by_doc.contains_key(&doc));
        e.remove(a, Records::Queue); // this document has no bucket
        for &h in &hs {
            e.traversal.release(h);
        }
        assert!(e.traversal.by_doc.is_empty());
        let _ = body;
    }

    #[test]
    fn untrusted_words_and_short_buffers_are_ignored() {
        let (mut e, _, body, [a, ..]) = setup();
        let h = iter(&mut e, body, a, true);
        set(&mut e, h, 0, 0x0fff_ffff, true); // not a node
        e.remove(a, Records::Queue);
        assert_eq!(get(&mut e, h, 0), (0x0fff_ffff, true));
        // a registered iterator whose slot lies past the buffer is skipped
        let far = e.iter_create(body);
        assert!(far as usize * SLOT_WORDS > e.iter_words.words().len());
        let b = e.rec(body).first;
        e.remove(b, Records::Queue);
    }

    #[test]
    fn freed_handles_are_reused() {
        let (mut e, _, body, [a, ..]) = setup();
        let h1 = e.iter_create(body);
        let h2 = e.iter_create(body);
        e.traversal.release(h1);
        e.traversal.release(h1);
        assert_eq!(e.traversal.live, 1);
        assert_eq!(e.iter_create(a), h1);
        e.traversal.release(h1);
        e.traversal.release(h2);
        assert!(e.traversal.is_empty());
    }
}
