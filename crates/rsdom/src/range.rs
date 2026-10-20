//! Live ranges (DESIGN §25): the registry of live Range objects and the DOM §5.5 / §4.2.3 / §4.10 steps that move
//! their boundary points when the tree or character data changes. The child-list module runs the insert and
//! remove steps inside `Env::insert` / `Env::remove` (DESIGN §17); text.rs runs the replace-data, split-text and
//! normalize steps.
//!
//! A range's boundary points live in `Env.range_words`, a JS-owned buffer shared with the facade
//! (lib/range.cjs, bound by `rangeBind`): slot `h - 1` of handle `h` is [start id, start offset, end id, end
//! offset, bucket document]. The facade reads and writes the first four with zero FFI; Rust writes the fifth and
//! moves the points here. Words read from that buffer are untrusted: an id is only followed when the table
//! contains it, and an unknown id never matches.
//!
//! Ranges are bucketed by their boundary nodes' node document (both points share a root, so a document), so a
//! mutation looks only at its own document's ranges (one hash lookup). The facade calls `rangeSync` when it sets a
//! boundary point in another document than the bucket word says; a cross-document adoption re-buckets the ranges
//! of the documents it moved nodes out of. Attr boundary points (id 0: Attrs have no table id) are in no bucket:
//! no mutation moves them. The facade frees a range once JS no longer holds it (a FinalizationRegistry). With no
//! range alive, a mutation pays one emptiness check.

use rustc_hash::FxHashMap;

use crate::env::Env;
use crate::error::{Code, code};
use crate::table::NodeId;

/// Words per range slot in `Env.range_words`: [start id, start offset, end id, end offset, bucket document].
pub const SLOT_WORDS: usize = 5;
const DOC: usize = 4;

/// Env-wide live-range registry (`Env.ranges`). Handles are slot index + 1 (0 is never a handle).
#[derive(Default, Debug)]
pub struct RangeState {
    /// the bucket document of each live range by slot (`None` = free, `Some(0)` = in no bucket)
    slots: Vec<Option<NodeId>>,
    /// handles of the live ranges by their boundary nodes' node document
    by_doc: FxHashMap<NodeId, Vec<u32>>,
    free: Vec<u32>,
    live: u32,
}

impl RangeState {
    /// True when no live range exists (mutations skip the range steps).
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.live == 0
    }

    fn release(&mut self, h: u32) {
        if let Some(slot) = self.slots.get_mut((h as usize).wrapping_sub(1))
            && let Some(doc) = slot.take()
        {
            self.live -= 1;
            self.free.push(h);
            self.unbucket(doc, h);
        }
    }

    fn bucket(&mut self, doc: NodeId, h: u32) {
        if doc != 0 {
            self.by_doc.entry(doc).or_default().push(h);
        }
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

/// A boundary point as the steps edit it.
#[derive(Clone, Copy)]
struct Bp {
    node: NodeId,
    offset: u32,
}

impl Env {
    /// Registers a range with boundary points (sid, so) and (eid, eo), writing its slot; returns its handle. The
    /// facade makes room for handle `hi water + 1` before the call.
    fn range_create(&mut self, sid: NodeId, so: u32, eid: NodeId, eo: u32) -> u32 {
        let r = &mut self.ranges;
        r.live += 1;
        let h = match r.free.pop() {
            Some(h) => h,
            None => {
                r.slots.push(None);
                r.slots.len() as u32
            }
        };
        self.ranges.slots[h as usize - 1] = Some(0);
        let o = (h as usize - 1) * SLOT_WORDS;
        if let Some(w) = self.range_words.words().get_mut(o..o + SLOT_WORDS) {
            w.copy_from_slice(&[sid, so, eid, eo, 0]);
        }
        self.range_sync(h);
        h
    }

    /// The document whose bucket a range with start node `sid` belongs in (0 = none: an Attr or unknown id).
    fn range_doc(&self, sid: NodeId) -> NodeId {
        if sid != 0 && self.table.contains(sid) { self.node_doc(sid) } else { 0 }
    }

    /// Moves range `h` to the bucket of its start node's document and records it in the slot's bucket word.
    fn range_sync(&mut self, h: u32) {
        let Some(Some(old)) = self.ranges.slots.get((h as usize).wrapping_sub(1)).copied() else { return };
        let o = (h as usize - 1) * SLOT_WORDS;
        let Some(&sid) = self.range_words.words().get(o) else { return };
        let doc = self.range_doc(sid);
        if doc != old {
            self.ranges.unbucket(old, h);
            self.ranges.bucket(doc, h);
            self.ranges.slots[h as usize - 1] = Some(doc);
        }
        if let Some(w) = self.range_words.words().get_mut(o + DOC) {
            *w = doc;
        }
    }

    /// After a cross-document adoption out of the documents `olds`: moves their ranges whose nodes moved.
    pub(crate) fn live_ranges_rebucket(&mut self, olds: &[NodeId]) {
        for &old in olds {
            let Some(hs) = self.ranges.by_doc.get(&old).cloned() else { continue };
            for h in hs {
                self.range_sync(h);
            }
        }
    }

    /// Runs `f` on both boundary points of every live range in `doc`'s bucket, writing back what it returns.
    fn each_range_bp(&mut self, doc: NodeId, mut f: impl FnMut(&Env, Bp) -> Bp) {
        let Some(hs) = self.ranges.by_doc.remove(&doc) else { return };
        for &h in &hs {
            let o = (h as usize - 1) * SLOT_WORDS;
            let w = match self.range_words.words().get(o..o + 4) {
                Some(w) => [w[0], w[1], w[2], w[3]],
                None => continue,
            };
            let s = f(self, Bp { node: w[0], offset: w[1] });
            let e = f(self, Bp { node: w[2], offset: w[3] });
            self.range_words.words()[o..o + 4].copy_from_slice(&[s.node, s.offset, e.node, e.offset]);
        }
        self.ranges.by_doc.insert(doc, hs);
    }

    /// True when some live range has a boundary point in `doc`.
    #[inline]
    fn has_ranges_in(&self, doc: NodeId) -> bool {
        !self.ranges.is_empty() && self.ranges.by_doc.contains_key(&doc)
    }

    /// Index of `node` among its siblings.
    pub(crate) fn index_of(&self, node: NodeId) -> u32 {
        let mut i = 0;
        let mut c = self.rec(node).prev;
        while c != 0 {
            i += 1;
            c = self.rec(c).prev;
        }
        i
    }

    /// DOM "insert" step 5: `count` nodes are about to be inserted into `parent` before `child` (non-zero).
    pub(crate) fn live_ranges_insert(&mut self, parent: NodeId, child: NodeId, count: u32) {
        let doc = self.node_doc(parent);
        if !self.has_ranges_in(doc) {
            return;
        }
        let index = self.index_of(child);
        self.each_range_bp(doc, |_, bp| {
            if bp.node == parent && bp.offset > index { Bp { offset: bp.offset + count, ..bp } } else { bp }
        });
    }

    /// DOM "remove" steps 3-6 for `node`, about to be removed from `parent`.
    pub(crate) fn live_ranges_pre_remove(&mut self, node: NodeId, parent: NodeId) {
        let doc = self.node_doc(node);
        if !self.has_ranges_in(doc) {
            return;
        }
        let index = self.index_of(node);
        self.each_range_bp(doc, |e, bp| {
            if bp.node == parent {
                if bp.offset > index { Bp { offset: bp.offset - 1, ..bp } } else { bp }
            } else if bp.node != 0 && e.table.contains(bp.node) && e.is_inclusive_ancestor(node, bp.node) {
                Bp { node: parent, offset: index }
            } else {
                bp
            }
        });
    }

    /// DOM "replace data" steps 8-11: `count` code units at `offset` of `node` were replaced by `added` ones
    /// (`count` already clamped to the data).
    pub(crate) fn live_ranges_replace_data(&mut self, node: NodeId, offset: u32, count: u32, added: u32) {
        let doc = self.node_doc(node);
        if !self.has_ranges_in(doc) {
            return;
        }
        let end = offset + count;
        self.each_range_bp(doc, |_, bp| {
            if bp.node != node || bp.offset <= offset {
                bp
            } else if bp.offset <= end {
                Bp { offset, ..bp }
            } else {
                Bp { offset: bp.offset + added - count, ..bp }
            }
        });
    }

    /// DOM "split a Text node" steps 7.2-7.5: `node` was split at `offset` into `new`, already inserted after it
    /// into `parent`.
    pub(crate) fn live_ranges_split(&mut self, node: NodeId, new: NodeId, offset: u32, parent: NodeId) {
        let doc = self.node_doc(node);
        if !self.has_ranges_in(doc) {
            return;
        }
        let after = self.index_of(node) + 1;
        self.each_range_bp(doc, |_, bp| {
            if bp.node == node && bp.offset > offset {
                Bp { node: new, offset: bp.offset - offset }
            } else if bp.node == parent && bp.offset == after {
                Bp { offset: after + 1, ..bp }
            } else {
                bp
            }
        });
    }

    /// DOM "normalize" step 6.5-6.6 for `current`, the next Text sibling merged into `node`, whose data starts
    /// at `at` in the merged data.
    pub(crate) fn live_ranges_merge(&mut self, node: NodeId, current: NodeId, at: u32) {
        let doc = self.node_doc(node);
        if !self.has_ranges_in(doc) {
            return;
        }
        let parent = self.rec(current).parent;
        let index = self.index_of(current);
        self.each_range_bp(doc, |_, bp| {
            if bp.node == current {
                Bp { node, offset: bp.offset + at }
            } else if bp.node == parent && bp.offset == index {
                Bp { node, offset: at }
            } else {
                bp
            }
        });
    }
}

natives! {
    /// Binds the live-range boundary words to the facade's resizable ArrayBuffer (first range of an env, and after every resize); returns its capacity in words.
    fn rangeBind(e [env], buf: any) -> u32 {
        e.bind_ranges(env, buf)
    }
    /// Registers a live range with boundary points (sid, so), (eid, eo) and writes its slot; returns its handle. The facade makes room for one more slot first.
    fn rangeNew(e, sid: u32, so: u32, eid: u32, eo: u32) -> u32 {
        e.range_create(sid, so, eid, eo)
    }
    /// Re-buckets range `h` after the facade set a boundary point in another document than its bucket word says.
    fn rangeSync(e, h: u32) -> () {
        e.range_sync(h)
    }
    /// DOM "ensure pre-insertion validity" of inserting `node` into `parent` before `child` (0 = append), without inserting (Range.insertNode validates before it splits a Text node). Returns 0 or an error code.
    fn preInsertCheck(e, node: u32, parent: u32, child: u32) -> Code {
        code(e.ensure_validity(node, parent, child, false, false))
    }
    /// Forgets range `h` (the facade's FinalizationRegistry, once JS no longer holds the range).
    fn rangeFree(e, h: u32) -> () {
        e.ranges.release(h)
    }
    /// The number of registered live ranges (tests and benchmarks).
    fn rangeLive(e) -> u32 {
        e.ranges.live
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atoms::atom;
    use crate::dom::DocKind;
    use crate::node::Ns;
    use crate::tree::Records;

    /// body > [a > [t "hello"], b, c]
    fn setup() -> (Env, NodeId, NodeId, [NodeId; 4]) {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let body = e.rec(e.rec(doc).last).last;
        let [a, b, c] = [(); 3].map(|_| e.create_element(doc, atom::DIV, Ns::Html));
        let t = e.create_text(doc, "hello");
        for (p, n) in [(body, a), (a, t), (body, b), (body, c)] {
            e.append_child(p, n).unwrap();
        }
        (e, doc, body, [a, t, b, c])
    }

    /// Registers a range as the facade does (room for one more slot first).
    fn range(e: &mut Env, s: (NodeId, u32), end: (NodeId, u32)) -> u32 {
        let n = (e.ranges.slots.len() + 1) * SLOT_WORDS;
        e.range_words.own_at_least(n);
        e.range_create(s.0, s.1, end.0, end.1)
    }

    fn get(e: &mut Env, h: u32) -> [u32; 5] {
        let o = (h as usize - 1) * SLOT_WORDS;
        e.range_words.words()[o..o + SLOT_WORDS].try_into().unwrap()
    }

    #[test]
    fn insert_shifts_offsets_after_the_reference_child() {
        let (mut e, doc, body, [a, _, b, _]) = setup();
        let h = range(&mut e, (body, 1), (body, 2));
        assert_eq!(get(&mut e, h)[DOC], doc);
        let x = e.create_element(doc, atom::DIV, Ns::Html);
        e.pre_insert(x, body, b).unwrap(); // index 1: offset 1 is not past it
        assert_eq!(get(&mut e, h), [body, 1, body, 3, doc]);
        let y = e.create_element(doc, atom::DIV, Ns::Html);
        e.append_child(body, y).unwrap(); // appends never shift
        assert_eq!(get(&mut e, h), [body, 1, body, 3, doc]);
        let _ = a;
    }

    #[test]
    fn remove_moves_points_inside_the_node_to_its_parent_and_shifts_later_ones() {
        let (mut e, doc, body, [a, t, _, c]) = setup();
        let h = range(&mut e, (t, 2), (body, 3));
        e.remove(a, Records::Queue);
        assert_eq!(get(&mut e, h), [body, 0, body, 2, doc]);
        e.remove(c, Records::Queue); // index 1 (after a's removal): offset 2 shifts to 1
        assert_eq!(get(&mut e, h), [body, 0, body, 1, doc]);
    }

    #[test]
    fn replace_data_clamps_and_shifts_offsets() {
        let (mut e, doc, _, [_, t, ..]) = setup();
        let h = range(&mut e, (t, 2), (t, 5));
        e.replace_data(t, 1, 2, "XYZW").unwrap(); // "hXYZWlo": 2 is inside the replaced span, 5 after it
        assert_eq!(get(&mut e, h), [t, 1, t, 7, doc]);
        e.set_data(t, "ab").unwrap();
        assert_eq!(get(&mut e, h), [t, 0, t, 0, doc]);
    }

    #[test]
    fn split_text_moves_points_past_the_offset_into_the_new_node() {
        let (mut e, doc, _, [a, t, ..]) = setup();
        let h = range(&mut e, (t, 1), (t, 4));
        let h2 = range(&mut e, (a, 1), (a, 1));
        let n = e.split_text(t, 3).unwrap();
        assert_eq!(get(&mut e, h), [t, 1, n, 1, doc]);
        assert_eq!(get(&mut e, h2), [a, 2, a, 2, doc]); // (parent, index + 1) follows the new node
    }

    #[test]
    fn normalize_moves_points_into_the_merged_node() {
        let (mut e, doc, _, [a, t, ..]) = setup();
        let t2 = e.create_text(doc, "world");
        e.append_child(a, t2).unwrap();
        let h = range(&mut e, (t2, 2), (a, 2));
        let h2 = range(&mut e, (a, 1), (a, 1));
        e.normalize(a);
        assert_eq!(get(&mut e, h), [t, 7, a, 1, doc]);
        assert_eq!(get(&mut e, h2), [t, 5, t, 5, doc]);
    }

    #[test]
    fn adoption_rebuckets_and_other_documents_are_untouched() {
        let (mut e, doc, body, [a, t, ..]) = setup();
        let other = e.create_document(DocKind::Html, None);
        e.remove(a, Records::Queue);
        let h = range(&mut e, (t, 1), (t, 3));
        e.adopt(a, other);
        assert_eq!(get(&mut e, h)[DOC], other);
        assert!(!e.ranges.by_doc.contains_key(&doc));
        // a mutation in the first document does not look at it; one in the other does
        e.remove(e.rec(body).first, Records::Queue);
        e.replace_data(t, 0, 1, "").unwrap();
        assert_eq!(get(&mut e, h), [t, 0, t, 2, other]);
    }

    #[test]
    fn untrusted_words_short_buffers_and_freed_handles() {
        let (mut e, _, body, [a, ..]) = setup();
        let h = range(&mut e, (0x0fff_ffff, 1), (0x0fff_ffff, 2));
        assert_eq!(get(&mut e, h)[DOC], 0); // unknown id: in no bucket
        let h2 = range(&mut e, (body, 1), (body, 1));
        let o = (h2 as usize - 1) * SLOT_WORDS;
        e.range_words.words()[o] = 0x0fff_fffe; // the facade scribbled over a bucketed slot
        e.remove(a, Records::Queue);
        assert_eq!(get(&mut e, h2)[0], 0x0fff_fffe);
        e.ranges.release(h2);
        e.ranges.release(h2);
        e.ranges.release(h);
        assert!(e.ranges.is_empty() && e.ranges.by_doc.is_empty());
        // with no buffer bound, a range is registered in no bucket and mutations skip it
        let (mut e, _, body, [a, ..]) = setup();
        let h = e.range_create(body, 2, body, 2);
        assert!(!e.ranges.is_empty() && e.ranges.by_doc.is_empty());
        e.remove(a, Records::Queue);
        e.ranges.release(h);
    }
}
