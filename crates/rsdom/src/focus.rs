//! AREA B (focus): focus target per document, focusability, `setFocus`/`focusedOf`/`isFocusable`
//! natives (DESIGN §5 Focus). The facade runs the focus update steps and fires the events (JS).
//!
//! - `DocData.focused` is the focused element of each document (0 = none: `activeElement` is body);
//!   the element carries `state::FOCUSED`; the main document mirrors it into `EP[FOCUS]` (zero-FFI
//!   `document.activeElement`).
//! - `EP[FOCUS_VER]` (slot 14, area B) is bumped on every focus change of any document: memos that depend
//!   on `:focus` / `:focus-within` (area A) can key on it.
//! - Focusing never bumps `EP[STYLE]` and never touches the selector or style memos.
//! - Removing the focused element (or an ancestor) clears the focus without blur (`on_node_disconnected`).

use crate::atoms::atom;
use crate::env::{Env, ep};
use crate::forms::element_state;
use crate::node::{Ns, kind, meta, state};
use crate::table::NodeId;

/// Epoch-page slot owned by area B: focus version (bumped on every focus change).
pub const EP_FOCUS_VER: usize = 14;

/// Env-wide focus state (`Env.focus`); per-document focus lives in `DocData.focused`.
#[derive(Default, Debug)]
pub struct FocusState {}

/// Hook: `id` was disconnected from its document. Focus fixup: if it was the focused element, clear focus
/// (activeElement becomes body) without firing blur (DESIGN §5 Focus 4).
#[inline]
pub(crate) fn on_node_disconnected(e: &mut Env, id: NodeId) {
    if e.rec(id).state & state::FOCUSED == 0 {
        return;
    }
    e.rec_mut(id).state &= !state::FOCUSED;
    let owner = e.rec(id).owner;
    if let Some(d) = e.doc_data_mut(owner) {
        if d.focused == id {
            d.focused = 0;
        }
    }
    if owner == e.main_doc {
        e.ep.set(ep::FOCUS, 0);
    }
    e.ep.bump(EP_FOCUS_VER);
}

/// The main document changed (`setMainDocument`): `EP[FOCUS]` mirrors the new main document's focus.
pub(crate) fn on_main_doc_changed(e: &mut Env) {
    let f = e.focused_of(e.main_doc);
    e.ep.set(ep::FOCUS, f);
    e.ep.bump(EP_FOCUS_VER);
}

/// JS `parseInt(v, 10)` is not NaN (jsdom's tabindex focusability test).
fn tabindex_parses(v: &str) -> bool {
    let t = v.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let t = t.strip_prefix(['+', '-']).unwrap_or(t);
    t.as_bytes().first().is_some_and(u8::is_ascii_digit)
}

impl Env {
    /// jsdom `isFocusableAreaElement` (the facade checks that the document has a window first).
    ///
    /// `&mut self`: the computed-display test fills area A's computed-style core memo.
    pub fn is_focusable(&mut self, id: NodeId) -> bool {
        let r = *self.rec(id);
        if r.meta & meta::KIND_MASK != kind::ELEMENT || r.meta & meta::CONNECTED == 0 {
            return false;
        }
        // jsdom: no flat-tree inclusive ancestor may compute to `display: none` (area A's cascade).
        let hidden = if self.shadow.any() {
            self.flat_tree_hidden(id, r.owner)
        } else {
            crate::style::cascade::display_none_inclusive_ancestor(self, id)
        };
        if hidden {
            return false;
        }
        let tabindex = |e: &Env| {
            e.get_attr_by_atoms(id, crate::atoms::Atom::NONE, atom::TABINDEX)
                .is_some_and(|v| tabindex_parses(v))
        };
        match self.ns_of(id) {
            Ns::Html => match crate::atoms::Atom(r.local) {
                atom::INPUT | atom::SELECT | atom::TEXTAREA | atom::BUTTON => {
                    if self.is_html_elem(id, atom::INPUT)
                        && element_state::input_type(self, id) == crate::forms::types::ty::HIDDEN
                    {
                        return false;
                    }
                    !element_state::is_disabled(self, id)
                }
                _ if tabindex(self) => true,
                atom::IFRAME => true,
                // `<a>` without href and non-first `<summary>` fall through to the editing-host test
                // (jsdom isFocusableAreaElement; M9 review).
                atom::A => {
                    self.has_attr_ns_null(id, atom::HREF) || self.has_attr_ns_null(id, atom::CONTENTEDITABLE)
                }
                atom::SUMMARY => {
                    element_state::is_summary_for_parent_details(self, id)
                        || self.has_attr_ns_null(id, atom::CONTENTEDITABLE)
                }
                _ => self.has_attr_ns_null(id, atom::CONTENTEDITABLE),
            },
            Ns::Svg => tabindex(self) || (r.local == atom::A.0 && self.has_attr_ns_null(id, atom::HREF)),
            _ => false,
        }
    }

    /// jsdom's display test over `flatTreeInclusiveAncestors` (helpers/shadow-dom.js): true if an element on
    /// the flat-tree path from connected `id` to `doc`'s document element computes to `display: none`, or the
    /// path breaks (an unassigned host child, fallback content of a slot that has assigned nodes).
    fn flat_tree_hidden(&mut self, id: NodeId, doc: NodeId) -> bool {
        let mut root = self.rec(doc).first;
        while root != 0 && !self.is_element(root) {
            root = self.rec(root).next;
        }
        let mut n = id;
        loop {
            if (crate::style::cascade::core(self, n) >> crate::style::cascade::pack::DISPLAY_SHIFT) & 31 == 2
            {
                return true;
            }
            if n == root {
                return false;
            }
            n = self.flat_tree_parent_element(n);
            if n == 0 {
                return true;
            }
        }
    }

    fn has_attr_ns_null(&self, id: NodeId, a: crate::atoms::Atom) -> bool {
        self.get_attr_by_atoms(id, crate::atoms::Atom::NONE, a).is_some()
    }

    /// Focused element of `doc` (0 = none).
    pub fn focused_of(&self, doc: NodeId) -> NodeId {
        self.doc_data(doc).map_or(0, |d| d.focused)
    }

    /// Moves the focus of `doc` to `id` (0 = none). `id` must be a connected element of `doc`, else the
    /// focus is cleared. Returns the previously focused element.
    pub fn set_focus(&mut self, doc: NodeId, id: NodeId) -> NodeId {
        let Some(prev) = self.doc_data(doc).map(|d| d.focused) else { return 0 };
        let r = *self.rec(id);
        let ok = id != 0
            && r.meta & (meta::KIND_MASK | meta::CONNECTED) == kind::ELEMENT | meta::CONNECTED
            && r.owner == doc;
        let new = if ok { id } else { 0 };
        if new == prev {
            return prev;
        }
        if prev != 0 && self.table.contains(prev) {
            self.rec_mut(prev).state &= !state::FOCUSED;
        }
        if new != 0 {
            self.rec_mut(new).state |= state::FOCUSED;
        }
        if let Some(d) = self.doc_data_mut(doc) {
            d.focused = new;
        }
        if doc == self.main_doc {
            self.ep.set(ep::FOCUS, new);
        }
        self.ep.bump(EP_FOCUS_VER);
        prev
    }
}

natives! {
    /// Focusability of an element (connected, not disabled, tabindex, ... ; jsdom isFocusableAreaElement).
    fn isFocusable(e, id: u32) -> bool {
        e.is_focusable(id)
    }
    /// Sets the focused element of `doc` (0 = none, body); returns the previously focused element.
    fn setFocus(e, doc: u32, id: u32) -> u32 {
        e.set_focus(doc, id)
    }
    /// Focused element of `doc` (0 = none).
    fn focusedOf(e, doc: u32) -> u32 {
        e.focused_of(doc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::DocKind;

    #[test]
    fn focus_and_fixup() {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        e.main_doc = doc;
        let body = e.rec(e.rec(doc).last).last;
        let div = e.create_element(doc, atom::DIV, Ns::Html);
        let input = e.create_element(doc, atom::INPUT, Ns::Html);
        e.append_child(div, input).unwrap();
        assert!(!e.is_focusable(input), "detached");
        e.append_child(body, div).unwrap();
        assert!(e.is_focusable(input));
        assert!(!e.is_focusable(div));
        e.set_attr(div, atom::TABINDEX, "-1").unwrap();
        assert!(e.is_focusable(div));
        e.set_attr(div, atom::TABINDEX, "x").unwrap();
        assert!(!e.is_focusable(div));
        assert_eq!(e.set_focus(doc, input), 0);
        assert_eq!(e.ep.get(ep::FOCUS), input);
        assert_ne!(e.rec(input).state & state::FOCUSED, 0);
        e.remove_child(body, div).unwrap();
        assert_eq!(e.ep.get(ep::FOCUS), 0);
        assert_eq!(e.focused_of(doc), 0);
        assert_eq!(e.rec(input).state & state::FOCUSED, 0);
        e.set_attr(input, atom::DISABLED, "").unwrap();
        e.append_child(body, input).unwrap();
        assert!(!e.is_focusable(input));
    }

    #[test]
    fn display_none_ancestor_is_not_focusable() {
        let mut e = Env::new();
        let doc = e.parse_document(
            "<style>.gone{display:none}</style><div id=a><input id=i></div><div class=gone><button id=b></button></div>",
        );
        e.main_doc = doc;
        let by_id = |e: &Env, s: &str| e.get_element_by_id(doc, e.atoms.get(s).unwrap());
        let (a, i, b) = (by_id(&e, "a"), by_id(&e, "i"), by_id(&e, "b"));
        assert!(e.is_focusable(i));
        assert!(!e.is_focusable(b), "author display:none ancestor");
        e.set_attr(a, atom::STYLE, "display: none").unwrap();
        assert!(!e.is_focusable(i), "inline display:none ancestor");
        assert!(e.remove_attr(a, atom::STYLE));
        assert!(e.is_focusable(i));
    }
}
