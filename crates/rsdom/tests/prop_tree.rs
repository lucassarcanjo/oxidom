//! Differential test (ROADMAP M1 acceptance): random sequences of tree operations applied to the Rust arena
//! and to a simple Vec-based reference model must produce identical trees and identical errors, and the
//! arena's link invariants (siblings, first/last, child_len, parent, CONNECTED, ownerDocument) must hold.
//! The child-list module's bookkeeping (DESIGN §16) is checked after every operation too: a changed child
//! list changes its `child_ver` and `EP[TREE]`, the document id map agrees with the tree, clones queue no
//! MutationObserver records, and replaying the childList records of an observed parent over its old child
//! list yields its new one.
//!
//! `PROPTEST_CASES` overrides the default of 10_000 sequences.

use proptest::prelude::*;
use rsdom::Env;
use rsdom::atoms::Atom;
use rsdom::atoms::atom;
use rsdom::dom::DocKind;
use rsdom::env::ep;
use rsdom::error::DomError;
use rsdom::mo::{HEADER_WORDS, REC_WORDS, opt};
use rsdom::node::{Ns, kind, meta};
use rsdom::table::NodeId;

/// Values of the `id` attributes `Op::SetId` assigns.
const IDS: [&str; 3] = ["i0", "i1", "i2"];

#[derive(Clone, Copy, Debug, PartialEq)]
enum K {
    Element,
    Text,
    Fragment,
}

#[derive(Clone, Debug)]
enum Op {
    CreateElement,
    CreateText,
    CreateFragment,
    Append(usize, usize),
    InsertBefore(usize, usize, usize),
    InsertBeforeNull(usize, usize),
    RemoveChild(usize, usize),
    ReplaceChild(usize, usize, usize),
    Remove(usize),
    ReplaceChildren(usize, Vec<usize>),
    AdoptToOther(usize),
    SetId(usize, usize),
    Clone(usize),
}

fn op() -> impl Strategy<Value = Op> {
    let i = || 0usize..64;
    prop_oneof![
        3 => Just(Op::CreateElement),
        1 => Just(Op::CreateText),
        1 => Just(Op::CreateFragment),
        6 => (i(), i()).prop_map(|(a, b)| Op::Append(a, b)),
        4 => (i(), i(), i()).prop_map(|(a, b, c)| Op::InsertBefore(a, b, c)),
        1 => (i(), i()).prop_map(|(a, b)| Op::InsertBeforeNull(a, b)),
        2 => (i(), i()).prop_map(|(a, b)| Op::RemoveChild(a, b)),
        2 => (i(), i(), i()).prop_map(|(a, b, c)| Op::ReplaceChild(a, b, c)),
        2 => i().prop_map(Op::Remove),
        1 => (i(), prop::collection::vec(i(), 0..3)).prop_map(|(a, v)| Op::ReplaceChildren(a, v)),
        1 => i().prop_map(Op::AdoptToOther),
        2 => (i(), 0..IDS.len()).prop_map(|(a, v)| Op::SetId(a, v)),
        1 => i().prop_map(Op::Clone),
    ]
}

/// Reference model: plain parent pointers + child vectors, indices = pool positions.
#[derive(Default)]
struct Model {
    kinds: Vec<K>,
    parent: Vec<Option<usize>>,
    children: Vec<Vec<usize>>,
    /// pool index 0 is <body> (connected through the fixed html/document chain, not modelled as nodes)
    connected_root: usize,
    other_doc: Vec<bool>,
    /// index into `IDS` of the element's id attribute
    id: Vec<Option<usize>>,
}

type R = Result<(), DomError>;

impl Model {
    fn add(&mut self, k: K) -> usize {
        self.kinds.push(k);
        self.parent.push(None);
        self.children.push(Vec::new());
        self.other_doc.push(false);
        self.id.push(None);
        self.kinds.len() - 1
    }

    /// Elements of `root`'s subtree in tree order.
    fn preorder(&self, root: usize, out: &mut Vec<usize>) {
        out.push(root);
        for &c in &self.children[root] {
            self.preorder(c, out);
        }
    }

    fn is_incl_ancestor(&self, a: usize, mut n: usize) -> bool {
        loop {
            if n == a {
                return true;
            }
            match self.parent[n] {
                Some(p) => n = p,
                None => return false,
            }
        }
    }

    fn root(&self, mut n: usize) -> usize {
        while let Some(p) = self.parent[n] {
            n = p;
        }
        n
    }

    fn detach(&mut self, n: usize) {
        if let Some(p) = self.parent[n].take() {
            self.children[p].retain(|&c| c != n);
        }
    }

    fn validate(&self, node: usize, parent: usize, child: Option<usize>, replace: bool) -> R {
        if self.kinds[parent] == K::Text {
            return Err(DomError::HierarchyRequest);
        }
        if self.is_incl_ancestor(node, parent) {
            return Err(DomError::HierarchyRequest);
        }
        if let Some(c) = child {
            if self.parent[c] != Some(parent) {
                return Err(DomError::NotFound);
            }
        } else if replace {
            return Err(DomError::NotFound);
        }
        Ok(())
    }

    fn insert(&mut self, node: usize, parent: usize, before: Option<usize>) {
        let nodes = if self.kinds[node] == K::Fragment { self.children[node].clone() } else { vec![node] };
        let doc = self.other_doc[parent];
        for &n in &nodes {
            self.detach(n);
            self.set_doc_subtree(n, doc);
        }
        let idx = match before {
            Some(b) => self.children[parent].iter().position(|&c| c == b).unwrap(),
            None => self.children[parent].len(),
        };
        for (k, n) in nodes.into_iter().enumerate() {
            self.children[parent].insert(idx + k, n);
            self.parent[n] = Some(parent);
        }
    }

    fn set_doc_subtree(&mut self, n: usize, other: bool) {
        self.other_doc[n] = other;
        for c in self.children[n].clone() {
            self.set_doc_subtree(c, other);
        }
    }

    fn pre_insert(&mut self, node: usize, parent: usize, child: Option<usize>) -> R {
        self.validate(node, parent, child, false)?;
        let mut reference = child;
        if child == Some(node) {
            let siblings = &self.children[parent];
            let i = siblings.iter().position(|&c| c == node).unwrap();
            reference = siblings.get(i + 1).copied();
        }
        self.insert(node, parent, reference);
        Ok(())
    }

    fn next_sibling(&self, n: usize) -> Option<usize> {
        let p = self.parent[n]?;
        let s = &self.children[p];
        let i = s.iter().position(|&c| c == n).unwrap();
        s.get(i + 1).copied()
    }

    fn replace_child(&mut self, parent: usize, node: usize, child: usize) -> R {
        self.validate(node, parent, Some(child), true)?;
        let mut reference = self.next_sibling(child);
        if reference == Some(node) {
            reference = self.next_sibling(node);
        }
        // "Adopt node into parent's node document" adopts the node itself (a fragment included).
        self.detach(node);
        self.set_doc_subtree(node, self.other_doc[parent]);
        if self.parent[child].is_some() {
            self.detach(child);
        }
        self.insert(node, parent, reference);
        Ok(())
    }
}

struct World {
    e: Env,
    doc: NodeId,
    other: NodeId,
    ids: Vec<NodeId>,
    m: Model,
    id_atoms: Vec<Atom>,
}

/// One decoded childList record: (target, added, removed, next sibling).
type ChildRec = (NodeId, Vec<NodeId>, Vec<NodeId>, NodeId);

/// What `World::step` compares an operation's effects against.
struct Before {
    children: Vec<Vec<usize>>,
    in_body: Vec<bool>,
    child_ver: Vec<u32>,
    tree: u32,
}

impl World {
    fn new() -> Self {
        let mut e = Env::with_capacity(64); // small: exercises table growth too
        let doc = e.create_document(DocKind::Html, None);
        let other = e.create_document(DocKind::Html, None);
        let body = e.rec(e.rec(doc).last).last;
        assert!(e.is_html_elem(body, atom::BODY));
        let mut m = Model::default();
        let b = m.add(K::Element);
        m.connected_root = b;
        let id_atoms = IDS.iter().map(|v| e.intern(v)).collect();
        // Observer 1 watches <body>'s subtree; `step` drains it after every operation.
        e.mo_observe(1, body, opt::CHILD_LIST | opt::SUBTREE, &[]).unwrap();
        World { e, doc, other, ids: vec![body], m, id_atoms }
    }

    /// Model nodes inside <body>'s subtree (observed by observer 1 whether or not <body> is attached).
    fn in_body(&self) -> Vec<bool> {
        (0..self.ids.len()).map(|i| self.m.root(i) == self.m.connected_root).collect()
    }

    /// Takes observer 1's records (the notification step, which also drops transient registrations).
    fn take_records(&mut self) -> Vec<ChildRec> {
        let _ = self.e.mo_take(0, u32::MAX).len();
        let n = self.e.out.read(0) as usize;
        let w = self.e.out.read_vec(n);
        let cnt = w[2] as usize;
        let ids = &w[HEADER_WORDS + cnt * REC_WORDS..];
        (0..cnt)
            .map(|i| {
                let r = &w[HEADER_WORDS + i * REC_WORDS..HEADER_WORDS + (i + 1) * REC_WORDS];
                let (add, rem) = (r[2] as usize, r[4] as usize);
                (r[1], ids[add..add + r[3] as usize].to_vec(), ids[rem..rem + r[5] as usize].to_vec(), r[7])
            })
            .collect()
    }

    /// Applies `op`, then checks the tree against the model and the bookkeeping against the change.
    fn step(&mut self, op: &Op) {
        let before = Before {
            children: self.m.children.clone(),
            in_body: self.in_body(),
            child_ver: self.ids.iter().map(|&id| self.e.rec(id).child_ver).collect(),
            tree: self.e.ep.get(ep::TREE),
        };
        self.apply(op);
        self.check();
        let recs = self.take_records();
        if matches!(op, Op::Clone(_)) {
            assert!(recs.is_empty(), "clones queue no records: {recs:?}");
        }
        let tree = self.e.ep.get(ep::TREE);
        let in_body = self.in_body();
        for (i, old) in before.children.iter().enumerate() {
            let id = self.ids[i];
            let changed = *old != self.m.children[i];
            if changed {
                assert_ne!(self.e.rec(id).child_ver, before.child_ver[i], "child_ver of pool[{i}]");
                assert!(tree > before.tree, "EP[TREE] after changing pool[{i}]");
            }
            assert!(self.e.rec(id).child_ver <= tree, "child_ver of pool[{i}] ahead of EP[TREE]");
            // Replaying the records of an observed parent over its old child list yields the new one.
            if before.in_body[i] && in_body[i] {
                let mut list: Vec<NodeId> = old.iter().map(|&c| self.ids[c]).collect();
                for (_, added, removed, next) in recs.iter().filter(|r| r.0 == id) {
                    list.retain(|c| !removed.contains(c));
                    let at = if *next != 0 {
                        list.iter().position(|c| c == next).expect("record's next sibling is a child")
                    } else {
                        list.len()
                    };
                    list.splice(at..at, added.iter().copied());
                }
                let want: Vec<NodeId> = self.m.children[i].iter().map(|&c| self.ids[c]).collect();
                assert_eq!(list, want, "records replayed over pool[{i}] (changed: {changed}) {recs:?}");
            }
        }
        // The id map agrees with the tree: the first connected element with the id, in tree order.
        // <body> is connected while it is still the html element's child (a model root with an arena parent).
        let body_connected = self.m.parent[0].is_none() && self.e.rec(self.ids[0]).parent != 0;
        let mut order = Vec::new();
        if body_connected {
            self.m.preorder(self.m.connected_root, &mut order);
        }
        for (v, &a) in self.id_atoms.iter().enumerate() {
            let want = order.iter().find(|&&i| self.m.id[i] == Some(v)).map_or(0, |&i| self.ids[i]);
            assert_eq!(self.e.get_element_by_id(self.doc, a), want, "getElementById({})", IDS[v]);
            assert_eq!(self.e.get_element_by_id(self.other, a), 0, "other document id map");
        }
    }

    /// Adds the model of the deep copy `copy` of pool node `src` (same shape and ids) and returns its index.
    fn add_clone(&mut self, src: usize, copy: NodeId) -> usize {
        let i = self.m.add(self.m.kinds[src]);
        self.ids.push(copy);
        self.m.other_doc[i] = self.m.other_doc[src];
        self.m.id[i] = self.m.id[src];
        let arena_children = self.e.children_vec(copy).to_vec();
        assert_eq!(arena_children.len(), self.m.children[src].len(), "clone of pool[{src}]");
        for (&c, cc) in self.m.children[src].clone().iter().zip(arena_children) {
            let ci = self.add_clone(c, cc);
            self.m.parent[ci] = Some(i);
            self.m.children[i].push(ci);
        }
        i
    }

    fn pick(&self, i: usize) -> usize {
        i % self.ids.len()
    }

    fn apply(&mut self, op: &Op) {
        match *op {
            Op::CreateElement => {
                let id = self.e.create_element(self.doc, atom::DIV, Ns::Html);
                self.ids.push(id);
                self.m.add(K::Element);
            }
            Op::CreateText => {
                let id = self.e.create_text(self.doc, "t");
                self.ids.push(id);
                self.m.add(K::Text);
            }
            Op::CreateFragment => {
                let id = self.e.create_fragment(self.doc);
                self.ids.push(id);
                self.m.add(K::Fragment);
            }
            Op::Append(p, c) => {
                let (p, c) = (self.pick(p), self.pick(c));
                let r = self.e.append_child(self.ids[p], self.ids[c]);
                assert_eq!(r, self.m.pre_insert(c, p, None), "append {p} {c}");
            }
            Op::InsertBefore(p, c, rf) => {
                let (p, c, rf) = (self.pick(p), self.pick(c), self.pick(rf));
                let r = self.e.pre_insert(self.ids[c], self.ids[p], self.ids[rf]);
                assert_eq!(r, self.m.pre_insert(c, p, Some(rf)), "insertBefore {p} {c} {rf}");
            }
            Op::InsertBeforeNull(p, c) => {
                let (p, c) = (self.pick(p), self.pick(c));
                let r = self.e.pre_insert(self.ids[c], self.ids[p], 0);
                assert_eq!(r, self.m.pre_insert(c, p, None));
            }
            Op::RemoveChild(p, c) => {
                let (p, c) = (self.pick(p), self.pick(c));
                let r = self.e.remove_child(self.ids[p], self.ids[c]);
                let want = if self.m.parent[c] == Some(p) {
                    self.m.detach(c);
                    Ok(())
                } else {
                    Err(DomError::NotFound)
                };
                assert_eq!(r, want, "removeChild {p} {c}");
            }
            Op::ReplaceChild(p, n, c) => {
                let (p, n, c) = (self.pick(p), self.pick(n), self.pick(c));
                let r = self.e.replace_child(self.ids[p], self.ids[n], self.ids[c]);
                assert_eq!(r, self.m.replace_child(p, n, c), "replaceChild {p} {n} {c}");
            }
            Op::Remove(c) => {
                let c = self.pick(c);
                self.e.remove_self(self.ids[c]);
                self.m.detach(c);
            }
            Op::ReplaceChildren(p, ref nodes) => {
                let p = self.pick(p);
                // Restrict to distinct, non-fragment nodes (the facade converts strings; fragments are covered
                // by the insert ops) so the model stays simple.
                let mut ns: Vec<usize> = nodes.iter().map(|&i| self.pick(i)).collect();
                ns.dedup();
                if ns.iter().any(|&n| self.m.kinds[n] == K::Fragment) || ns.len() > 1 && ns[0] == ns[1] {
                    return;
                }
                let ids: Vec<NodeId> = ns.iter().map(|&i| self.ids[i]).collect();
                // model: convert nodes into a node
                // Model of DOM replaceChildren: convert nodes into a node (moving them into a new fragment
                // first, even if validation fails afterwards), ensure pre-insert validity, replace all.
                let want: R = (|| {
                    let node = match ns.len() {
                        0 => None,
                        1 => Some(ns[0]),
                        _ => {
                            let f = self.m.add(K::Fragment);
                            self.m.other_doc[f] = self.m.other_doc[p];
                            self.ids.push(0); // placeholder, patched below
                            for &n in &ns {
                                self.m.pre_insert(n, f, None).unwrap();
                            }
                            Some(f)
                        }
                    };
                    if let Some(n) = node {
                        self.m.validate(n, p, None, false)?;
                    } else if self.m.kinds[p] == K::Text {
                        return Err(DomError::HierarchyRequest);
                    }
                    for c in self.m.children[p].clone() {
                        self.m.detach(c);
                    }
                    if let Some(n) = node {
                        self.m.insert(n, p, None);
                    }
                    Ok(())
                })();
                let before = self.e.table.len();
                let r = self.e.replace_children(self.ids[p], &ids);
                // A fragment allocated by Rust is the last id; patch the model placeholder.
                if self.ids.last() == Some(&0) {
                    let f = (before..self.e.table.len()).find(|&id| self.e.kind(id) == kind::FRAGMENT);
                    match f {
                        Some(f) => *self.ids.last_mut().unwrap() = f,
                        None => {
                            // Rust failed before creating the fragment: drop the model placeholder too.
                            self.ids.pop();
                            self.m.kinds.pop();
                            self.m.parent.pop();
                            self.m.children.pop();
                            self.m.other_doc.pop();
                            self.m.id.pop();
                        }
                    }
                }
                if want.is_ok() || r.is_ok() {
                    assert_eq!(r, want, "replaceChildren {p} {ns:?}");
                }
            }
            Op::SetId(n, v) => {
                let n = self.pick(n);
                if self.m.kinds[n] != K::Element {
                    return;
                }
                self.e.set_attr(self.ids[n], atom::ID, IDS[v]).unwrap();
                self.m.id[n] = Some(v);
            }
            Op::Clone(n) => {
                let n = self.pick(n);
                let src = self.ids[n];
                let copy = self.e.clone_node(src, self.e.node_doc(src), true).unwrap();
                self.add_clone(n, copy);
            }
            Op::AdoptToOther(n) => {
                let n = self.pick(n);
                if n == 0 {
                    return; // keep <body> in the main document
                }
                self.e.adopt_node(self.other, self.ids[n]).unwrap();
                self.m.detach(n);
                self.m.set_doc_subtree(n, true);
            }
        }
    }

    fn check(&self) {
        let e = &self.e;
        for (i, &id) in self.ids.iter().enumerate() {
            let r = e.rec(id);
            let want_children: Vec<NodeId> = self.m.children[i].iter().map(|&c| self.ids[c]).collect();
            assert_eq!(e.children_vec(id).to_vec(), want_children, "children of pool[{i}]");
            assert_eq!(r.child_len as usize, want_children.len(), "child_len of pool[{i}]");
            if i != 0 {
                let want_parent = self.m.parent[i].map_or(0, |p| self.ids[p]);
                assert_eq!(r.parent, want_parent, "parent of pool[{i}]");
            }
            // link invariants
            assert_eq!(r.first, want_children.first().copied().unwrap_or(0));
            assert_eq!(r.last, want_children.last().copied().unwrap_or(0));
            for w in want_children.windows(2) {
                assert_eq!(e.rec(w[0]).next, w[1]);
                assert_eq!(e.rec(w[1]).prev, w[0]);
            }
            if let Some(&f) = want_children.first() {
                assert_eq!(e.rec(f).prev, 0);
            }
            if let Some(&l) = want_children.last() {
                assert_eq!(e.rec(l).next, 0);
            }
            // CONNECTED == root is the document; ownerDocument follows adoption
            let connected = self.m.root(i) == self.m.connected_root && e.rec(self.ids[0]).parent != 0;
            assert_eq!(r.meta & meta::CONNECTED != 0, connected, "CONNECTED of pool[{i}]");
            let want_owner = if self.m.other_doc[i] { self.other } else { self.doc };
            assert_eq!(r.owner, want_owner, "owner of pool[{i}]");
        }
    }
}

fn cases() -> u32 {
    std::env::var("PROPTEST_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(10_000)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(), max_shrink_iters: 2000, ..ProptestConfig::default() })]

    #[test]
    fn random_tree_ops_match_model(ops in prop::collection::vec(op(), 1..80)) {
        let mut w = World::new();
        for _ in 0..4 {
            w.apply(&Op::CreateElement);
        }
        for op in &ops {
            w.step(op);
        }
    }
}
