//! AREA C (MutationObserver, DESIGN §9, ROADMAP M6): registrations, transient registered observers and
//! per-observer record queues. Records are produced here by the mutation algorithms (tree.rs, attrs.rs,
//! text.rs, parse.rs call `queue_*`); the facade (packages/rsdom/lib/mo.cjs) drains them with one crossing per
//! observer that has records and builds the JS `MutationRecord` objects.
//!
//! Cost model:
//! - no registration anywhere in the env (`nregs == 0`): every `queue_*` returns after one load; the
//!   character-data old value is not even copied (`active` is false);
//! - `observe` / `disconnect` are O(1) / O(nodes observed by that observer): no subtree walk (happy-dom
//!   walks the whole subtree on every `observe`, and DTL's `waitFor` observes on every call);
//! - with observers: one walk over the target's inclusive ancestors (table reads, a hash lookup only on
//!   nodes with the `OBSERVED` meta bit), then one record per interested observer.
//!
//! Observer ids are assigned by the facade in creation order (callbacks run in that order).
//!
//! `DocData.observers` is not used: an env-wide registration count is both cheaper to test and stays
//! correct when observed nodes are adopted into another document.

use rustc_hash::FxHashMap;
use smallvec::SmallVec;

use crate::atoms::Atom;
use crate::env::{Env, ep};
use crate::error::{Code, DomError, DomResult, code};
use crate::node::meta;
use crate::string::Str;
use crate::table::NodeId;

/// `MutationObserverInit` bits passed by the facade (already validated and normalised there).
pub mod opt {
    /// childList
    pub const CHILD_LIST: u32 = 1;
    /// attributes
    pub const ATTRIBUTES: u32 = 2;
    /// characterData
    pub const CHAR_DATA: u32 = 4;
    /// subtree
    pub const SUBTREE: u32 = 8;
    /// attributeOldValue
    pub const ATTR_OLD: u32 = 16;
    /// characterDataOldValue
    pub const CHAR_OLD: u32 = 32;
    /// attributeFilter present (the filter atoms follow in OUT)
    pub const FILTER: u32 = 64;
    /// every valid bit
    pub const ALL: u32 = 127;
}

/// `NodeRec.meta` bit (area C range 26-31): the node carries transient registered observers. `OBSERVED`
/// (foundation bit 7) marks nodes with ordinary registrations; keeping them apart means the transient list is
/// only scanned for nodes that are actually in it.
pub const TRANSIENT: u32 = 1 << 26;

/// Record types on the wire (`MutationRecord.type`).
pub mod rtype {
    /// "attributes"
    pub const ATTRIBUTES: u32 = 1;
    /// "characterData"
    pub const CHAR_DATA: u32 = 2;
    /// "childList"
    pub const CHILD_LIST: u32 = 3;
}

/// u32 words per record in the `moTake` / `moRecords` output.
pub const REC_WORDS: usize = 12;
/// Header words of the `moTake` / `moRecords` output: `[total words, observer id, record count]`.
pub const HEADER_WORDS: usize = 3;

/// One registered observer on a node (DOM "registered observer"). `Copy`: the attributeFilter lives in
/// `MoState.filters` (interned), so copying a registration into transient ones never allocates.
#[derive(Clone, Copy, Debug)]
struct Reg {
    obs: u32,
    opts: u32,
    /// Index into `MoState.filters` (0 = no filter).
    filter: u32,
}

/// A transient registered observer (DOM "remove" step 13): lives until the next notification of `obs`.
/// Kept in a flat list (not in `regs`): removals create one per removed node and observer, and a list push
/// is far cheaper than a hash insert; lookups only happen for nodes with the `OBSERVED` bit.
#[derive(Clone, Copy, Debug)]
struct Transient {
    node: NodeId,
    reg: Reg,
    /// The node holding the source registration.
    source: NodeId,
}

/// A queued record. Node lists are ranges of the owning observer's `ids` pool, old values ranges of its
/// `olds` string.
#[derive(Clone, Copy, Debug, Default)]
struct Record {
    ty: u32,
    target: NodeId,
    add_start: u32,
    add_len: u32,
    rem_len: u32,
    prev: NodeId,
    next: NodeId,
    name: Atom,
    ns: Atom,
    has_old: bool,
    old_start: u32,
    old_len: u32,
}

/// Per-observer state (kept while the observer has registrations or queued records).
#[derive(Default, Debug)]
struct ObsState {
    id: u32,
    /// Nodes with a (non-transient) registration of this observer.
    nodes: SmallVec<[NodeId; 2]>,
    recs: Vec<Record>,
    ids: Vec<NodeId>,
    olds: String,
    /// Queued a record since the current delivery took its snapshot (DOM "mutation observers" list).
    active: bool,
    /// In the snapshot of the delivery in progress (DOM "notify list").
    in_round: bool,
}

/// MutationObserver registry and pending records (`Env.mo`).
#[derive(Debug)]
pub struct MoState {
    /// Non-transient registrations per node.
    regs: FxHashMap<NodeId, SmallVec<[Reg; 1]>>,
    /// Registrations (incl. transient ones) in the env: 0 => every queue function is a no-op.
    nregs: u32,
    /// Observers sorted by id (notification order = creation order = id order); a handful at a time.
    observers: Vec<ObsState>,
    transients: Vec<Transient>,
    /// Interned attributeFilters (index 0 = none) and their dedupe index.
    filters: Vec<Box<[Atom]>>,
    filter_ids: FxHashMap<Box<[Atom]>, u32>,
    /// Records queued and not yet taken (mirrored into bit 0 of `EP[MO_PENDING]`).
    pending: u32,
    /// Output scratch.
    words: Vec<u32>,
}

impl Default for MoState {
    fn default() -> Self {
        MoState {
            regs: FxHashMap::default(),
            nregs: 0,
            observers: Vec::new(),
            transients: Vec::new(),
            filters: vec![Box::default()],
            filter_ids: FxHashMap::default(),
            pending: 0,
            words: Vec::new(),
        }
    }
}

/// True if any observer could be interested in a mutation (`queue_char_data`'s `old` is only filled then).
#[inline(always)]
pub(crate) fn active(e: &Env, _target: NodeId) -> bool {
    e.mo.nregs != 0
}

/// Mutation type being queued (with the attribute key for attribute records).
#[derive(Clone, Copy)]
enum Kind {
    Attr { local: Atom, ns: Atom },
    Char,
    Child,
}

/// Interested observers of one record: (observer, wants the old value).
type Interested = SmallVec<[(u32, bool); 4]>;

/// DOM "queue a mutation record" steps 1-3 for one registration `reg` found on `node`.
#[inline]
fn consider(mo: &MoState, out: &mut Interested, reg: Reg, at_target: bool, kind: Kind) {
    let o = reg.opts;
    if !at_target && o & opt::SUBTREE == 0 {
        return;
    }
    let old = match kind {
        Kind::Attr { local, ns } => {
            if o & opt::ATTRIBUTES == 0
                || (o & opt::FILTER != 0
                    && (ns != Atom::NONE || !mo.filters[reg.filter as usize].contains(&local)))
            {
                return;
            }
            o & opt::ATTR_OLD != 0
        }
        Kind::Char => {
            if o & opt::CHAR_DATA == 0 {
                return;
            }
            o & opt::CHAR_OLD != 0
        }
        Kind::Child => {
            if o & opt::CHILD_LIST == 0 {
                return;
            }
            false
        }
    };
    match out.iter_mut().find(|(ob, _)| *ob == reg.obs) {
        Some(x) => x.1 |= old,
        None => out.push((reg.obs, old)),
    }
}

/// DOM "queue a mutation record" steps 1-4: the interested observers and whether each wants the old value.
/// For childList records with removals it also collects the subtree registrations of the ancestors
/// (`(registration, source node)`: transient registered observers for the removed nodes).
fn interested(
    e: &Env,
    target: NodeId,
    kind: Kind,
    mut tr: Option<&mut SmallVec<[(Reg, NodeId); 2]>>,
) -> Interested {
    let mo = &e.mo;
    let mut out = Interested::new();
    let mut n = target;
    let mut guard = 0u32;
    while n != 0 {
        let r = e.rec(n);
        if r.meta & (meta::OBSERVED | TRANSIENT) != 0 {
            let at_target = n == target;
            if let Some(list) = (r.meta & meta::OBSERVED != 0).then(|| mo.regs.get(&n)).flatten() {
                for &reg in list {
                    if let Some(t) = tr.as_deref_mut()
                        && reg.opts & opt::SUBTREE != 0
                    {
                        t.push((reg, n));
                    }
                    consider(mo, &mut out, reg, at_target, kind);
                }
            }
            let transient = if r.meta & TRANSIENT != 0 { &mo.transients[..] } else { &[] };
            for t in transient.iter().filter(|t| t.node == n) {
                if let Some(v) = tr.as_deref_mut()
                    && t.reg.opts & opt::SUBTREE != 0
                {
                    v.push((t.reg, t.source));
                }
                consider(mo, &mut out, t.reg, at_target, kind);
            }
        }
        n = r.parent;
        guard += 1;
        if guard > crate::table::MAX_CAP {
            break; // a corrupted (cyclic) parent chain must not hang the worker
        }
    }
    out
}

impl MoState {
    fn obs_index(&self, obs: u32) -> Result<usize, usize> {
        self.observers.binary_search_by_key(&obs, |s| s.id)
    }

    fn obs_mut(&mut self, obs: u32) -> &mut ObsState {
        let i = match self.obs_index(obs) {
            Ok(i) => i,
            Err(i) => {
                self.observers.insert(i, ObsState { id: obs, ..Default::default() });
                i
            }
        };
        &mut self.observers[i]
    }

    fn push(&mut self, obs: u32, mut rec: Record, added: &[NodeId], removed: &[NodeId], old: Option<&str>) {
        let st = self.obs_mut(obs);
        rec.add_start = st.ids.len() as u32;
        rec.add_len = added.len() as u32;
        rec.rem_len = removed.len() as u32;
        st.ids.extend_from_slice(added);
        st.ids.extend_from_slice(removed);
        if let Some(s) = old {
            rec.has_old = true;
            rec.old_start = st.olds.len() as u32;
            rec.old_len = s.len() as u32;
            st.olds.push_str(s);
        }
        st.recs.push(rec);
        st.active = true;
        self.pending += 1;
    }

    /// Interns an attributeFilter (0 for none).
    fn filter_id(&mut self, filter: &[Atom]) -> u32 {
        if let Some(&i) = self.filter_ids.get(filter) {
            return i;
        }
        let i = self.filters.len() as u32;
        self.filters.push(filter.into());
        self.filter_ids.insert(filter.into(), i);
        i
    }
}

/// Mirrors "records or signal slots pending" into bit 0 of `EP[MO_PENDING]`.
pub(crate) fn set_pending(e: &mut Env) {
    // bit 0 of the post-mutation mask; bit 1 belongs to area B's UA tasks (forms::UA_TASKS_BIT)
    let other = e.ep.get(ep::MO_PENDING) & !1;
    let pending = e.mo.pending != 0 || !e.shadow.signals.is_empty();
    e.ep.set(ep::MO_PENDING, other | pending as u32);
}

/// Queue a childList record (`added`/`removed` in order; `prev`/`next` siblings, 0 = null). Removed nodes
/// receive transient registrations for the subtree observers of `target`'s inclusive ancestors.
#[inline]
pub(crate) fn queue_child_list(
    e: &mut Env,
    target: NodeId,
    added: &[NodeId],
    removed: &[NodeId],
    prev: NodeId,
    next: NodeId,
) {
    if e.mo.nregs == 0 {
        return;
    }
    queue_child_list_slow(e, target, added, removed, prev, next);
}

#[inline(never)]
fn queue_child_list_slow(
    e: &mut Env,
    target: NodeId,
    added: &[NodeId],
    removed: &[NodeId],
    prev: NodeId,
    next: NodeId,
) {
    let mut tr: SmallVec<[(Reg, NodeId); 2]> = SmallVec::new();
    let list = interested(e, target, Kind::Child, (!removed.is_empty()).then_some(&mut tr));
    if !tr.is_empty() {
        for &n in removed {
            for &(reg, source) in &tr {
                e.mo.transients.push(Transient { node: n, reg, source });
                e.mo.nregs += 1;
            }
            e.rec_mut(n).meta |= TRANSIENT;
        }
    }
    if list.is_empty() {
        return;
    }
    let rec = Record { ty: rtype::CHILD_LIST, target, prev, next, ..Default::default() };
    for (obs, _) in list {
        e.mo.push(obs, rec, added, removed, None);
    }
    set_pending(e);
}

/// Queue an attributes record; `old` is the previous value (None if the attribute was absent).
#[inline]
pub(crate) fn queue_attribute(e: &mut Env, target: NodeId, local: Atom, ns: Atom, old: Option<&Str>) {
    if e.mo.nregs == 0 {
        return;
    }
    queue_attribute_slow(e, target, local, ns, old);
}

#[inline(never)]
fn queue_attribute_slow(e: &mut Env, target: NodeId, local: Atom, ns: Atom, old: Option<&Str>) {
    let list = interested(e, target, Kind::Attr { local, ns }, None);
    if list.is_empty() {
        return;
    }
    let rec = Record { ty: rtype::ATTRIBUTES, target, name: local, ns, ..Default::default() };
    for (obs, want_old) in list {
        // A requested old value of an absent attribute is null: `has_old` stays false.
        let old = if want_old { old.map(Str::as_str) } else { None };
        e.mo.push(obs, rec, &[], &[], old);
    }
    set_pending(e);
}

/// Queue a characterData record with the old data.
#[inline]
pub(crate) fn queue_char_data(e: &mut Env, target: NodeId, old: &Str) {
    if e.mo.nregs == 0 {
        return;
    }
    queue_char_data_slow(e, target, old);
}

#[inline(never)]
fn queue_char_data_slow(e: &mut Env, target: NodeId, old: &Str) {
    let list = interested(e, target, Kind::Char, None);
    if list.is_empty() {
        return;
    }
    let rec = Record { ty: rtype::CHAR_DATA, target, ..Default::default() };
    for (obs, want_old) in list {
        e.mo.push(obs, rec, &[], &[], want_old.then_some(old.as_str()));
    }
    set_pending(e);
}

/// Clears `OBSERVED` / `TRANSIENT` on `node` when no registration of that kind is left on it.
fn refresh_observed(e: &mut Env, node: NodeId) {
    if !e.table.contains(node) {
        return;
    }
    let mut clear = 0;
    let m = e.rec(node).meta;
    if m & meta::OBSERVED != 0 && !e.mo.regs.contains_key(&node) {
        clear |= meta::OBSERVED;
    }
    if m & TRANSIENT != 0 && !e.mo.transients.iter().any(|t| t.node == node) {
        clear |= TRANSIENT;
    }
    if clear != 0 {
        e.rec_mut(node).meta &= !clear;
    }
}

/// Removes every transient registration matching `pred`.
fn remove_transients(e: &mut Env, pred: impl Fn(&Transient) -> bool) {
    if e.mo.transients.is_empty() {
        return;
    }
    let mut gone: SmallVec<[NodeId; 16]> = SmallVec::new();
    let mo = &mut e.mo;
    mo.transients.retain(|t| {
        if pred(t) {
            gone.push(t.node);
            false
        } else {
            true
        }
    });
    e.mo.nregs -= gone.len() as u32;
    for n in gone {
        refresh_observed(e, n);
    }
}

impl Env {
    /// `MutationObserver.observe(target, options)`: `opts` are validated `opt::*` bits; `filter` the
    /// attributeFilter local-name atoms (when `opt::FILTER`).
    pub fn mo_observe(&mut self, obs: u32, target: NodeId, opts: u32, filter: &[Atom]) -> DomResult {
        if target == 0 || !self.table.contains(target) || obs == 0 || opts & !opt::ALL != 0 {
            return Err(DomError::Type);
        }
        let filter = if opts & opt::FILTER != 0 { self.mo.filter_id(filter) } else { 0 };
        let reg = Reg { obs, opts, filter };
        let existing = self.mo.regs.get_mut(&target).and_then(|l| l.iter_mut().find(|r| r.obs == obs));
        if let Some(r) = existing {
            // DOM "observe" step 6: replace the options, then drop the transient registrations whose source
            // is this registration.
            *r = reg;
            remove_transients(self, |t| t.reg.obs == obs && t.source == target);
        } else {
            self.mo.regs.entry(target).or_default().push(reg);
            self.mo.nregs += 1;
            self.rec_mut(target).meta |= meta::OBSERVED;
            self.mo.obs_mut(obs).nodes.push(target);
        }
        Ok(())
    }

    /// `MutationObserver.disconnect()`: drops every registration of `obs` (incl. transient ones) and its
    /// record queue.
    pub fn mo_disconnect(&mut self, obs: u32) {
        let Ok(i) = self.mo.obs_index(obs) else {
            return;
        };
        let st = self.mo.observers.remove(i);
        for n in st.nodes {
            if let Some(list) = self.mo.regs.get_mut(&n) {
                let before = list.len();
                list.retain(|r| r.obs != obs);
                self.mo.nregs -= (before - list.len()) as u32;
                if list.is_empty() {
                    self.mo.regs.remove(&n);
                }
            }
            refresh_observed(self, n);
        }
        remove_transients(self, |t| t.reg.obs == obs);
        self.mo.pending -= st.recs.len() as u32;
        set_pending(self);
    }

    /// Notification step for the first observer with id in `(after, max]` that has queued records: takes its
    /// queue (written to OUT, see [`Env::mo_encode`]) and removes the transient registrations of every
    /// observer in `(after, taken]` (all of `(after, max]` when none has records). Returns the old-values
    /// string.
    ///
    /// The first call of a delivery (`after == 0`) snapshots the observers that queued records since the last
    /// one (DOM "notify mutation observers" step 2): an observer that receives its first record from another
    /// observer's callback waits for the next delivery, as in jsdom.
    pub fn mo_take(&mut self, after: u32, max: u32) -> &str {
        if after == 0 {
            for s in &mut self.mo.observers {
                s.in_round = std::mem::take(&mut s.active);
            }
        }
        let found = if after >= max {
            None
        } else {
            self.mo
                .observers
                .iter()
                .find(|s| s.id > after && s.id <= max && s.in_round && !s.recs.is_empty())
                .map(|s| s.id)
        };
        let upto = found.unwrap_or(max);
        remove_transients(self, |t| t.reg.obs > after && t.reg.obs <= upto);
        self.mo_encode(found.unwrap_or(0))
    }

    /// `takeRecords()`: takes `obs`'s queue only (no transient removal).
    pub fn mo_records(&mut self, obs: u32) -> &str {
        self.mo_encode(obs)
    }

    /// Moves `obs`'s queue into OUT: `[total, obs, n, n x REC_WORDS record words, ids...]` with record
    /// words `[type | hasOld << 4, target, addStart, addLen, remStart, remLen, prev, next, name, ns,
    /// oldStart16, oldLen16]` (id offsets relative to the start of the id section, old-value offsets in
    /// UTF-16 units into the returned string). `obs` 0 or without records writes `[3, obs, 0]`.
    fn mo_encode(&mut self, obs: u32) -> &str {
        let mut words = std::mem::take(&mut self.mo.words);
        words.clear();
        words.extend_from_slice(&[0, obs, 0]);
        self.scratch.clear();
        let mut olds_empty = true;
        if let Ok(i) = self.mo.obs_index(obs) {
            let st = &mut self.mo.observers[i];
            let n = st.recs.len();
            words[2] = n as u32;
            words.reserve(n * REC_WORDS + st.ids.len());
            let mut off16 = 0u32;
            for r in &st.recs {
                let (os, ol) = if r.has_old {
                    let s = &st.olds[r.old_start as usize..(r.old_start + r.old_len) as usize];
                    let l16 = crate::string::utf16_len(s);
                    let start = off16;
                    off16 += l16;
                    (start, l16)
                } else {
                    (0, 0)
                };
                words.extend_from_slice(&[
                    r.ty | (r.has_old as u32) << 4,
                    r.target,
                    r.add_start,
                    r.add_len,
                    r.add_start + r.add_len,
                    r.rem_len,
                    r.prev,
                    r.next,
                    r.name.0,
                    r.ns.0,
                    os,
                    ol,
                ]);
            }
            words.extend_from_slice(&st.ids);
            olds_empty = st.olds.is_empty();
            std::mem::swap(&mut self.scratch, &mut st.olds);
            st.olds.clear();
            st.recs.clear();
            st.ids.clear();
            let drop_state = st.nodes.is_empty();
            self.mo.pending -= n as u32;
            if drop_state {
                self.mo.observers.remove(i);
            }
        }
        words[0] = words.len() as u32;
        self.out.write(&mut self.ep, &words);
        self.mo.words = words;
        set_pending(self);
        if olds_empty { "" } else { self.scratch.as_str() }
    }

    /// Registrations in the env (incl. transient ones); test/bench introspection.
    pub fn mo_registrations(&self) -> u32 {
        self.mo.nregs
    }
}

/// Reads the attributeFilter atoms written by the facade into OUT[0..n] (clamped to OUT's capacity).
fn filter_atoms(e: &mut Env, n: u32) -> SmallVec<[Atom; 4]> {
    e.out.read_vec(n as usize).into_iter().map(Atom).collect()
}

fn observe_native(e: &mut Env, obs: u32, target: NodeId, opts: u32, nfilter: u32) -> Code {
    // Arguments from JS are untrusted: validate before reading OUT (an unchecked count used to drive a
    // 16 GiB allocation, which aborts the process instead of unwinding).
    if nfilter != 0 && opts & opt::FILTER == 0 {
        return code(Err(DomError::Type));
    }
    let filter = filter_atoms(e, nfilter);
    code(e.mo_observe(obs, target, opts, &filter))
}

natives! {
    /// MutationObserver.observe: observer id (facade-assigned, creation order), target, validated option bits (mo.rs `opt`), attributeFilter atom count (atoms in OUT[0..n]). 0 or a TypeError code.
    fn moObserve(e, obs: u32, target: u32, opts: u32, nfilter: u32) -> Code {
        observe_native(e, obs, target, opts, nfilter)
    }
    /// MutationObserver.disconnect: drops the observer's registrations and queued records.
    fn moDisconnect(e, obs: u32) -> () {
        e.mo_disconnect(obs)
    }
    /// Notify step: takes the records of the first observer in (after, max] that has any (OUT = [total, obs, n, records..., ids...]) and removes transient registrations of the observers passed; returns the old values (UTF-16 offsets in the record words).
    fn moTake(e, after: u32, max: u32) -> &str {
        e.mo_take(after, max)
    }
    /// takeRecords(): takes one observer's queue (same OUT layout as moTake).
    fn moRecords(e, obs: u32) -> &str {
        e.mo_records(obs)
    }
    /// Number of registered observers (incl. transient) in the env (tests).
    fn moRegistrations(e) -> u32 {
        e.mo_registrations()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atoms::atom;
    use crate::dom::DocKind;
    use crate::node::Ns;

    struct Rec {
        ty: u32,
        target: NodeId,
        added: Vec<NodeId>,
        removed: Vec<NodeId>,
        prev: NodeId,
        next: NodeId,
        name: u32,
        old: Option<String>,
    }

    fn decode(e: &mut Env, s: String) -> (u32, Vec<Rec>) {
        let n = e.out.read(0) as usize;
        let w = e.out.read_vec(n);
        let s16: Vec<u16> = s.encode_utf16().collect();
        let cnt = w[2] as usize;
        let ids = &w[HEADER_WORDS + cnt * REC_WORDS..];
        let mut out = Vec::new();
        for i in 0..cnt {
            let r = &w[HEADER_WORDS + i * REC_WORDS..HEADER_WORDS + (i + 1) * REC_WORDS];
            let old = (r[0] & 16 != 0)
                .then(|| String::from_utf16(&s16[r[10] as usize..(r[10] + r[11]) as usize]).unwrap());
            out.push(Rec {
                ty: r[0] & 15,
                target: r[1],
                added: ids[r[2] as usize..(r[2] + r[3]) as usize].to_vec(),
                removed: ids[r[4] as usize..(r[4] + r[5]) as usize].to_vec(),
                prev: r[6],
                next: r[7],
                name: r[8],
                old,
            });
        }
        (w[1], out)
    }

    fn take(e: &mut Env, after: u32) -> (u32, Vec<Rec>) {
        let s = e.mo_take(after, u32::MAX).to_string();
        decode(e, s)
    }

    fn setup() -> (Env, NodeId, NodeId) {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let body = e.rec(e.rec(doc).last).last;
        let div = e.create_element(doc, atom::DIV, Ns::Html);
        e.append_child(body, div).unwrap();
        (e, doc, div)
    }

    #[test]
    fn no_observers_no_records() {
        let (mut e, doc, div) = setup();
        let p = e.create_element(doc, atom::P, Ns::Html);
        e.append_child(div, p).unwrap();
        e.set_attr(p, atom::ID, "x").unwrap();
        assert_eq!(e.mo.pending, 0);
        assert_eq!(e.ep.get(ep::MO_PENDING), 0);
        assert!(e.mo.observers.is_empty());
    }

    #[test]
    fn child_list_subtree_and_siblings() {
        let (mut e, doc, div) = setup();
        let a = e.create_element(doc, atom::P, Ns::Html);
        let b = e.create_element(doc, atom::P, Ns::Html);
        e.append_child(div, a).unwrap();
        e.mo_observe(1, div, opt::CHILD_LIST, &[]).unwrap();
        assert_eq!(e.rec(div).meta & meta::OBSERVED, meta::OBSERVED);
        e.append_child(div, b).unwrap();
        // grandchild change: not observed without subtree
        let t = e.create_text(doc, "x");
        e.append_child(a, t).unwrap();
        assert_eq!(e.ep.get(ep::MO_PENDING), 1);
        let (obs, recs) = take(&mut e, 0);
        assert_eq!(obs, 1);
        assert_eq!(recs.len(), 1);
        assert_eq!((recs[0].ty, recs[0].target, recs[0].prev, recs[0].next), (rtype::CHILD_LIST, div, a, 0));
        assert_eq!(recs[0].added, vec![b]);
        assert_eq!(e.ep.get(ep::MO_PENDING), 0);
        e.mo_observe(1, div, opt::CHILD_LIST | opt::SUBTREE, &[]).unwrap();
        e.remove_child(a, t).unwrap();
        let (_, recs) = take(&mut e, 0);
        assert_eq!(recs.len(), 1);
        assert_eq!((recs[0].target, recs[0].removed.clone()), (a, vec![t]));
        let (obs, recs) = take(&mut e, 1);
        assert_eq!((obs, recs.len()), (0, 0));
    }

    #[test]
    fn attributes_filter_and_old_values() {
        let (mut e, _doc, div) = setup();
        e.set_attr(div, atom::ID, "a").unwrap();
        e.mo_observe(1, div, opt::ATTRIBUTES | opt::ATTR_OLD | opt::FILTER, &[atom::ID]).unwrap();
        e.mo_observe(2, div, opt::ATTRIBUTES, &[]).unwrap();
        e.set_attr(div, atom::ID, "b").unwrap();
        e.set_attr(div, atom::TITLE, "t").unwrap();
        e.set_attr(div, atom::ID, "ü😀").unwrap();
        e.set_attr(div, atom::ID, "c").unwrap();
        let (obs, recs) = take(&mut e, 0);
        assert_eq!(obs, 1);
        let olds: Vec<_> = recs.iter().map(|r| r.old.clone()).collect();
        assert_eq!(olds, vec![Some("a".into()), Some("b".into()), Some("ü😀".into())]);
        assert!(recs.iter().all(|r| r.name == atom::ID.0 && r.ty == rtype::ATTRIBUTES));
        let (obs, recs) = take(&mut e, 1);
        assert_eq!(obs, 2);
        assert_eq!(recs.len(), 4);
        assert!(recs.iter().all(|r| r.old.is_none()));
        // absent attribute: requested old value is null
        e.mo_observe(1, div, opt::ATTRIBUTES | opt::ATTR_OLD, &[]).unwrap();
        e.set_attr(div, atom::LANG, "en").unwrap();
        let (_, recs) = take(&mut e, 0);
        assert!(recs[0].old.is_none());
    }

    #[test]
    fn char_data_old_value_and_disconnect() {
        let (mut e, doc, div) = setup();
        let t = e.create_text(doc, "old");
        e.append_child(div, t).unwrap();
        e.mo_observe(3, div, opt::CHAR_DATA | opt::CHAR_OLD | opt::SUBTREE, &[]).unwrap();
        e.replace_data(t, 0, 1, "N").unwrap();
        e.set_data(t, "new").unwrap();
        let (_, recs) = take(&mut e, 0);
        let olds: Vec<_> = recs.iter().map(|r| r.old.clone().unwrap()).collect();
        assert_eq!(olds, vec!["old", "Nld"]);
        e.set_data(t, "x").unwrap();
        e.mo_disconnect(3);
        assert_eq!(e.ep.get(ep::MO_PENDING), 0);
        assert_eq!(e.mo_registrations(), 0);
        assert_eq!(e.rec(div).meta & meta::OBSERVED, 0);
        e.set_data(t, "y").unwrap();
        assert_eq!(e.mo.pending, 0);
    }

    #[test]
    fn transient_observers_see_removed_subtree_until_notify() {
        let (mut e, doc, div) = setup();
        let p = e.create_element(doc, atom::P, Ns::Html);
        let t = e.create_text(doc, "x");
        e.append_child(p, t).unwrap();
        e.append_child(div, p).unwrap();
        e.mo_observe(1, div, opt::CHILD_LIST | opt::CHAR_DATA | opt::SUBTREE, &[]).unwrap();
        e.remove_child(div, p).unwrap();
        // p is detached but still observed (transiently) until the next notification
        e.set_data(t, "y").unwrap();
        let (_, recs) = take(&mut e, 0);
        assert_eq!(recs.len(), 2);
        assert_eq!((recs[1].ty, recs[1].target), (rtype::CHAR_DATA, t));
        // the take removed the transient registration
        assert_eq!(e.mo_registrations(), 1);
        e.set_data(t, "z").unwrap();
        assert_eq!(e.mo.pending, 0);
    }

    #[test]
    fn transients_per_observer_and_reobserve() {
        let (mut e, doc, div) = setup();
        let p = e.create_element(doc, atom::P, Ns::Html);
        let t = e.create_text(doc, "x");
        e.append_child(p, t).unwrap();
        e.append_child(div, p).unwrap();
        let all = opt::CHILD_LIST | opt::CHAR_DATA | opt::SUBTREE;
        e.mo_observe(1, div, all, &[]).unwrap();
        e.mo_observe(2, div, all, &[]).unwrap();
        e.remove_child(div, p).unwrap();
        assert_eq!(e.mo_registrations(), 4);
        assert_eq!(e.rec(p).meta & TRANSIENT, TRANSIENT);
        // observer 1's turn removes only its transient registration
        let (obs, _) = take(&mut e, 0);
        assert_eq!(obs, 1);
        assert_eq!(e.mo_registrations(), 3);
        assert_eq!(e.rec(p).meta & TRANSIENT, TRANSIENT);
        e.set_data(t, "y").unwrap();
        let (obs, recs) = take(&mut e, 1);
        assert_eq!(obs, 2);
        assert_eq!(recs.len(), 2, "childList + characterData through the remaining transient");
        assert_eq!(e.rec(p).meta & TRANSIENT, 0);
        assert_eq!(e.mo_registrations(), 2);
        // re-observing the source target drops the transients created from it
        e.append_child(div, p).unwrap();
        e.remove_child(div, p).unwrap();
        assert_eq!(e.mo_registrations(), 4);
        e.mo_observe(1, div, opt::CHILD_LIST, &[]).unwrap();
        assert_eq!(e.mo_registrations(), 3);
        e.mo_disconnect(2);
        assert_eq!(e.mo_registrations(), 1);
        assert_eq!(e.rec(p).meta & (TRANSIENT | meta::OBSERVED), 0);
    }

    #[test]
    fn one_record_per_inner_html_and_replace_all() {
        let (mut e, _doc, div) = setup();
        e.set_inner_html(div, "<p>old</p><p>old2</p>").unwrap();
        e.mo_observe(1, div, opt::CHILD_LIST | opt::SUBTREE, &[]).unwrap();
        e.set_inner_html(div, "<table><tr><td>a<td>b</table><ul><li>1<li>2</ul>text").unwrap();
        let (_, recs) = take(&mut e, 0);
        assert_eq!(recs.len(), 1);
        assert_eq!((recs[0].added.len(), recs[0].removed.len()), (3, 2));
        e.set_text_content(div, "x").unwrap();
        let (_, recs) = take(&mut e, 0);
        assert_eq!(recs.len(), 1);
    }

    #[test]
    fn take_respects_creation_order_and_range() {
        let (mut e, doc, div) = setup();
        e.mo_observe(5, div, opt::CHILD_LIST, &[]).unwrap();
        e.mo_observe(2, div, opt::CHILD_LIST, &[]).unwrap();
        let p = e.create_element(doc, atom::P, Ns::Html);
        e.append_child(div, p).unwrap();
        assert_eq!(take(&mut e, 0).0, 2);
        assert_eq!(e.ep.get(ep::MO_PENDING), 1);
        assert_eq!(take(&mut e, 2).0, 5);
        assert_eq!(take(&mut e, 5).0, 0);
        // max bound: observers created after the notification started are skipped
        let q = e.create_text(doc, "q");
        e.append_child(div, q).unwrap();
        let s = e.mo_take(0, 4).to_string();
        assert_eq!(decode(&mut e, s).0, 2);
        let s = e.mo_take(2, 4).to_string();
        assert_eq!(decode(&mut e, s).0, 0);
        let s = e.mo_take(4, 4).to_string();
        assert_eq!(decode(&mut e, s).0, 0);
        let s = e.mo_take(9, 4).to_string();
        assert_eq!(decode(&mut e, s).0, 0);
        assert_eq!(e.mo_records(5).len(), 0);
        assert_eq!(e.out.read(2), 1);
    }

    #[test]
    fn invalid_arguments() {
        let (mut e, _doc, div) = setup();
        assert_eq!(e.mo_observe(1, 0, opt::CHILD_LIST, &[]), Err(DomError::Type));
        assert_eq!(e.mo_observe(1, 999_999, opt::CHILD_LIST, &[]), Err(DomError::Type));
        assert_eq!(e.mo_observe(1, div, 1 << 20, &[]), Err(DomError::Type));
        e.mo_disconnect(42);
        let s = e.mo_take(0, u32::MAX).to_string();
        assert_eq!(decode(&mut e, s).1.len(), 0);
    }

    /// `cargo test --release --lib mo::tests::cost_probe -- --ignored --nocapture`: per-record cost.
    #[test]
    #[ignore]
    fn cost_probe() {
        let (mut e, doc, root) = setup();
        let mut leaf = root;
        for _ in 0..8 {
            let c = e.create_element(doc, atom::DIV, Ns::Html);
            e.append_child(leaf, c).unwrap();
            leaf = c;
        }
        let n = 200_000;
        let run = |e: &mut Env, label: &str| {
            let t0 = std::time::Instant::now();
            let mut take = std::time::Duration::ZERO;
            for i in 0..n {
                let c = e.create_element(doc, atom::P, Ns::Html);
                e.append_child(leaf, c).unwrap();
                e.remove_self(c);
                if i % 1000 == 999 {
                    let t1 = std::time::Instant::now();
                    e.mo_take(0, u32::MAX);
                    take += t1.elapsed();
                }
            }
            let per = |d: std::time::Duration| d.as_nanos() as f64 / n as f64;
            println!("{label}: {:.1} ns/pair ({:.1} in mo_take)", per(t0.elapsed()), per(take));
        };
        run(&mut e, "no observer");
        e.mo_observe(1, root, opt::CHILD_LIST | opt::ATTRIBUTES | opt::CHAR_DATA | opt::SUBTREE, &[])
            .unwrap();
        run(&mut e, "subtree observer, take every 1000");
    }
}
