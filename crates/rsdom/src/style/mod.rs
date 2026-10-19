//! AREA A (style): inline style (`element.style`), UA sheet, author sheets, cascade, computed-style memo
//! (DESIGN §8, ROADMAP M5 style part + M6 computed style).
//!
//! - `props`:  the CSS property table (data/css/properties.tsv, from jsdom 30.1.3)
//! - `value`:  value parsing / normalisation / shorthand expansion and serialization
//! - `inline`: the inline declaration block and the `style*` natives
//! - `sheet`:  stylesheets (UA + author `<style>` elements), rule buckets
//! - `cascade`: computed values, the packed core snapshot (`csCore`), `csStr`, display-none helpers
//!
//! STYLE epoch (`EP[STYLE]`, validates the core snapshot memo in Rust and in the facade) is bumped only
//! by changes that can affect a core property (display, visibility, pointer-events, opacity, position):
//! child-list changes (inheritance, structural selectors), `style` / `hidden` / `type` / `open` /
//! `popover` attribute writes, `class` / `id` writes and the attributes author sheets select on (only
//! while the env has author sheets; this includes the attributes pseudo-classes read, e.g. `disabled`
//! for `:disabled`, `lang` / `xml:lang` for `:lang()`, `href` for `:link`), and `<style>` text changes.
//! Text writes bump it only while an author sheet uses `:empty` / `:has()`. `aria-*` and `data-*`
//! writes never bump it unless a sheet selects on them. Author sheets that use state pseudo-classes (`:checked`, `:focus`, ...) set `EP[STYLE_DEP]`
//! so the memo also validates against `EP[REC]` / `EP[FORM]` (area B writes those on state changes).

pub mod cascade;
pub mod inline;
pub mod props;
pub mod sheet;
pub mod value;

use rustc_hash::FxHashMap;
use smallvec::SmallVec;

use crate::atoms::{Atom, atom};
use crate::env::{Env, ep};
use crate::node::{kind, meta};
use crate::string::Str;
use crate::table::NodeId;

pub use inline::InlineStyle;

/// Epoch-page slot owned by area A: 1 while some author sheet selects on mutable state (`:checked`,
/// `:focus`, ...), so computed-style memos must also validate against `EP[REC]` and `EP[FORM]`.
pub const EP_STYLE_DEP: usize = 13;

/// Computed-style memo per element (`ElementExt.cs`), keyed by `EP[STYLE]`.
#[derive(Default, Clone, Copy, Debug)]
pub struct CsMemo {
    /// EP[STYLE] value the memo was computed at (0 = never).
    pub epoch: u32,
    /// Packed core properties (see `cascade::pack`).
    pub packed: u32,
    /// EP[REC] / EP[FORM] at computation (only compared while `EP[STYLE_DEP]` is set).
    pub rec: u32,
    /// EP[FORM] at computation.
    pub form: u32,
}

/// Per-document style state (`DocData.style`): connected `<style>` elements in tree order.
#[derive(Default)]
pub struct DocStyle {
    /// Owner `<style>` elements, tree order.
    pub sheets: SmallVec<[NodeId; 2]>,
    /// Merged author-rule index over `sheets` (None: rebuild in `sheet::prepare`; dropped whenever the
    /// sheet set or a sheet's text changes).
    pub index: Option<Box<sheet::AuthorIndex>>,
}

impl std::fmt::Debug for DocStyle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DocStyle({:?}, index: {})", self.sheets, self.index.is_some())
    }
}

/// Env-wide style engine state (`Env.style`).
pub struct StyleState {
    /// Set while the CSSOM writes the `style` attribute itself (the hook must not drop the block).
    pub syncing: bool,
    /// Parsed author sheets by owner `<style>` element (None = dirty, re-parse on next use).
    pub sheets: FxHashMap<NodeId, Option<std::sync::Arc<sheet::Sheet>>>,
    /// Number of connected `<style>` elements in the env (0: class/id writes never bump STYLE).
    pub sheet_count: u32,
    /// Attribute names author sheets select on (STYLE invalidation), recomputed after parsing.
    pub sheet_attrs: SmallVec<[Atom; 8]>,
    /// Some author sheet uses a state pseudo-class.
    pub sheet_state: bool,
    /// Some author sheet reads character data (`:empty`, `:has()`): text changes bump STYLE.
    pub sheet_text: bool,
    /// Computed-style memo enabled (`RSDOM_NO_MEMO=1` disables it, like the facade memos).
    pub memo: bool,
}

impl Default for StyleState {
    fn default() -> Self {
        StyleState {
            syncing: false,
            sheets: FxHashMap::default(),
            sheet_count: 0,
            sheet_attrs: SmallVec::new(),
            sheet_state: false,
            sheet_text: false,
            memo: std::env::var_os("RSDOM_NO_MEMO").is_none_or(|v| v != "1"),
        }
    }
}

impl std::fmt::Debug for StyleState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "StyleState({} sheets)", self.sheets.len())
    }
}

#[inline]
fn is_style_element(e: &Env, id: NodeId) -> bool {
    let r = e.rec(id);
    r.meta & meta::KIND_MASK == kind::ELEMENT
        && Atom(r.local) == atom::STYLE
        && matches!(r.meta & meta::NS_MASK, 0 | 0x10) // HTML or SVG <style>
}

/// Hook: attribute `local` (namespace `ns`) of element `el` changed.
#[inline]
pub(crate) fn on_attr_changed(e: &mut Env, el: NodeId, local: Atom, ns: Atom, _old: Option<&Str>) {
    if !ns.is_none() {
        // `xml:lang` (`:lang()`) and `[*|attr]` selectors read namespaced attributes.
        if e.style.sheet_count != 0 && e.style.sheet_attrs.contains(&local) {
            e.ep.bump(ep::STYLE);
        }
        return;
    }
    match local {
        atom::STYLE => {
            if !e.style.syncing {
                e.drop_inline(el);
            }
            e.ep.bump(ep::STYLE);
        }
        atom::HIDDEN | atom::TYPE | atom::OPEN | atom::POPOVER => {
            if local == atom::TYPE && is_style_element(e, el) {
                sheet::mark_dirty(e, el); // `<style type>` decides whether the element has a sheet
            }
            e.ep.bump(ep::STYLE);
        }
        _ if e.style.sheet_count != 0
            && (local == atom::CLASS || local == atom::ID || e.style.sheet_attrs.contains(&local)) =>
        {
            e.ep.bump(ep::STYLE);
        }
        _ => {}
    }
}

/// Hook: the child list of `parent` changed (insert/remove/replace/parser).
#[inline]
pub(crate) fn on_children_changed(e: &mut Env, parent: NodeId) {
    e.ep.bump(ep::STYLE);
    if is_style_element(e, parent) {
        sheet::mark_dirty(e, parent);
    }
}

/// Hook: character data of `id` changed (e.g. the text of a `<style>` element).
#[inline]
pub(crate) fn on_char_data_changed(e: &mut Env, id: NodeId) {
    let p = e.rec(id).parent;
    if p != 0 && is_style_element(e, p) {
        sheet::mark_dirty(e, p);
        e.ep.bump(ep::STYLE);
    } else if e.style.sheet_text && e.style.sheet_count != 0 {
        // `:empty` / `:has()` in an author sheet: emptiness depends on text data length.
        e.ep.bump(ep::STYLE);
    }
}

/// Hook: node `id` became connected (called for every inclusive descendant of an inserted subtree).
#[inline]
pub(crate) fn on_node_connected(e: &mut Env, id: NodeId) {
    if is_style_element(e, id) {
        sheet::attach(e, id);
    }
}

/// Hook: node `id` became disconnected (called for every inclusive descendant of a removed subtree).
#[inline]
pub(crate) fn on_node_disconnected(e: &mut Env, id: NodeId) {
    if is_style_element(e, id) {
        sheet::detach(e, id);
    }
}
