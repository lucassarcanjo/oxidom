//! AREA B (forms): form-control state, value modes, sanitization, selection (UTF-16), radio groups,
//! select/option selectedness, labels, form owner, form reset, constraint validation (DESIGN §7,
//! ROADMAP M5). Focus lives in `crate::focus`.
//!
//! State layout:
//! - shared, zero-FFI for JS (`NodeRec.state`, DESIGN §2.2): `CHECKED`, `SELECTED`, `INDETERMINATE`,
//!   `DIRTY_VALUE`, `DIRTY_CHECKED`, `DIRTY_SELECTED`, the normalized input type (5 bits, [`types::ty`]),
//!   `FOCUSED` (focus.rs).
//! - Rust-private, allocated on demand (`ElementExt.form`, [`FormState`]): the raw value, selection offsets
//!   (UTF-16 code units), the custom validity message.
//! - `NodeRec.form_ver` is set from `EP[FORM]` by every change that can alter a control's value, checkedness,
//!   selectedness or selection: the facade's value memo (`_vm`) is keyed by it.
//!
//! Behaviour follows jsdom 30 (the contract-test oracle): `HTMLInputElement-impl.js`,
//! `HTMLTextAreaElement-impl.js`, `HTMLSelectElement-impl.js`, `HTMLOptionElement-impl.js`,
//! `helpers/form-controls.js`, `DefaultConstraintValidation-impl.js`.
//!
//! Hooks (crate::hooks) keep the state in step with attribute and tree mutations; parser-created elements are
//! initialised by [`on_parsed`] (the parser inserts nodes raw, without per-node hooks).

pub mod element_state;
pub mod types;

use rustc_hash::FxHashMap;
use smallvec::SmallVec;

use crate::atoms::{Atom, atom};
use crate::env::{Env, ep};
use crate::error::{Code, DomError, DomResult, code};
use crate::node::{kind, meta, state};
use crate::string::Str;
use crate::table::NodeId;
use element_state::{has_datalist_ancestor, input_type, is_button, is_disabled, validity_bits};
use types::{Mode, ty};

type Ids = SmallVec<[NodeId; 16]>;

/// Per-control state (`ElementExt.form`), allocated on first need.
#[derive(Default, Debug, Clone)]
pub struct FormState {
    /// input: the raw value (stored in every value mode, like jsdom's `#value`); textarea: the raw value
    /// once dirty (a clean textarea reads its child text); output: the default-value override.
    pub value: Str,
    /// selectionStart (UTF-16 code units)
    pub sel_start: u32,
    /// selectionEnd (UTF-16 code units)
    pub sel_end: u32,
    /// selectionDirection: 0 none, 1 forward, 2 backward
    pub sel_dir: u8,
    /// setCustomValidity message ("" = none)
    pub custom: Str,
    /// select: signature of the list of options at the last selectedness reset (`OptSig`)
    pub opt_sig: u64,
}

/// Order-sensitive signature of a list of options (never 0): FNV-1a over the ids, then the count.
struct OptSig {
    h: u64,
    n: u64,
}

impl OptSig {
    fn new() -> Self {
        OptSig { h: 0xcbf2_9ce4_8422_2325, n: 0 }
    }

    #[inline]
    fn push(&mut self, o: NodeId) {
        self.h = (self.h ^ u64::from(o)).wrapping_mul(0x100_0000_01b3);
        self.n += 1;
    }

    fn finish(&self) -> u64 {
        (self.h ^ self.n.rotate_left(32)) | 1
    }
}

/// `scan_options` result.
struct OptScan {
    sig: u64,
    selected: u32,
    last_selected: NodeId,
    first_enabled: NodeId,
}

/// Env-wide forms state (`Env.forms`): the label-association memo.
#[derive(Default, Debug)]
pub struct FormsState {
    labels: LabelMemo,
    /// `<details>` elements with a queued toggle event task (HTML "details toggle task tracker"), in
    /// queue order; drained by the `takeToggles` native.
    toggles: Vec<NodeId>,
}

/// Bit of `EP[MO_PENDING]` (the post-mutation work mask) set while UA element tasks are queued.
pub const UA_TASKS_BIT: u32 = 2;

/// `labels` / DTL `getByLabelText` call `labels` for every candidate control; the associations of one root
/// are computed once per (EP[TREE], EP[ATTR]) like jsdom's memoized `labelAssociations`.
#[derive(Default, Debug)]
struct LabelMemo {
    root: NodeId,
    tree: u32,
    attr: u32,
    /// `CeState::def_gen`: a form-associated custom element is labelable once it has its definition
    ce: u32,
    map: FxHashMap<NodeId, SmallVec<[NodeId; 2]>>,
}

/// `validity` bits (the `validity` native; the facade decodes them).
pub mod vbits {
    /// valueMissing
    pub const VALUE_MISSING: u32 = 1;
    /// typeMismatch
    pub const TYPE_MISMATCH: u32 = 1 << 1;
    /// patternMismatch (computed by the facade with an ECMAScript `v`-flag RegExp, see `CHECK_PATTERN`)
    pub const PATTERN_MISMATCH: u32 = 1 << 2;
    /// tooLong (never set: only user edits can make a control too long; jsdom returns false too)
    pub const TOO_LONG: u32 = 1 << 3;
    /// tooShort (see `TOO_LONG`)
    pub const TOO_SHORT: u32 = 1 << 4;
    /// rangeUnderflow
    pub const RANGE_UNDERFLOW: u32 = 1 << 5;
    /// rangeOverflow
    pub const RANGE_OVERFLOW: u32 = 1 << 6;
    /// stepMismatch
    pub const STEP_MISMATCH: u32 = 1 << 7;
    /// badInput (never set)
    pub const BAD_INPUT: u32 = 1 << 8;
    /// customError
    pub const CUSTOM_ERROR: u32 = 1 << 9;
    /// willValidate (candidate for constraint validation)
    pub const CANDIDATE: u32 = 1 << 16;
    /// the facade must test the `pattern` attribute against the value
    pub const CHECK_PATTERN: u32 = 1 << 17;
    /// the facade must check that the value parses as an absolute URL (type=url typeMismatch)
    pub const CHECK_URL: u32 = 1 << 18;
    /// the facade must check `files.length === 0` (required file input)
    pub const CHECK_FILES: u32 = 1 << 19;
}

const TYPE_SHIFT: u32 = state::INPUT_TYPE_SHIFT;

/// `valueSet` success flag: the control's API value is now exactly the argument.
pub const VALUE_IS_ARG: u32 = 0x100;

// ------------------------------------------------------------------------------------ small helpers

#[inline]
fn st(e: &Env, id: NodeId) -> u32 {
    e.rec(id).state
}

/// Sets/clears `mask` in `state`; true if it changed.
#[inline]
fn set_bits(e: &mut Env, id: NodeId, mask: u32, on: bool) -> bool {
    let old = e.rec(id).state;
    let new = if on { old | mask } else { old & !mask };
    if new != old {
        e.rec_mut(id).state = new;
        true
    } else {
        false
    }
}

impl Env {
    /// HTML "queue a details toggle event task": one pending task per element (later changes coalesce
    /// into it, like jsdom's `_taskQueue`); the facade fires `toggle` from a task after `takeToggles`.
    fn queue_details_toggle(&mut self, el: NodeId) {
        if !self.forms.toggles.contains(&el) {
            self.forms.toggles.push(el);
        }
        let v = self.ep.get(ep::MO_PENDING) | UA_TASKS_BIT;
        self.ep.set(ep::MO_PENDING, v);
    }

    /// Drains the queued details toggle tasks into OUT; returns the count.
    fn take_toggles(&mut self) -> u32 {
        let v = self.ep.get(ep::MO_PENDING) & !UA_TASKS_BIT;
        self.ep.set(ep::MO_PENDING, v);
        let t = std::mem::take(&mut self.forms.toggles);
        let n = self.write_out(&t);
        self.forms.toggles = t;
        self.forms.toggles.clear();
        n
    }

    /// setCustomValidity: validity (`:valid` / `:invalid`, qSA memo, computed-style memo) changes, so
    /// the change bumps `EP[FORM]` and the node's `form_ver` like every other validity input.
    fn set_custom_validity(&mut self, id: NodeId, msg: &str) {
        if !self.is_element(id) {
            return;
        }
        if form_state(self, id).map_or("", |f| f.custom.as_str()) == msg {
            return;
        }
        if let Some(f) = form_state_mut(self, id) {
            f.custom = Str::from(msg);
            touch(self, id);
        }
    }
}

/// Marks a form-state change of `id`: `form_ver = ++EP[FORM]` (the facade's value memo key).
#[inline]
fn touch(e: &mut Env, id: NodeId) {
    let v = e.ep.bump(ep::FORM);
    e.rec_mut(id).form_ver = v;
}

/// Null-namespace attribute value (`getAttributeNS(null, a)`).
#[inline]
fn attr(e: &Env, id: NodeId, a: Atom) -> Option<&str> {
    let d = e.elem(id)?;
    d.find_ns(Atom::NONE, a).map(|i| d.attrs[i].value.as_str())
}

#[inline]
fn has(e: &Env, id: NodeId, a: Atom) -> bool {
    e.elem(id).is_some_and(|d| d.find_ns(Atom::NONE, a).is_some())
}

#[inline]
fn is_input(e: &Env, id: NodeId) -> bool {
    e.is_html_elem(id, atom::INPUT)
}

fn form_state(e: &Env, id: NodeId) -> Option<&FormState> {
    e.elem(id)?.ext.as_ref()?.form.as_deref()
}

fn form_state_mut(e: &mut Env, id: NodeId) -> Option<&mut FormState> {
    Some(e.elem_mut(id)?.ext_mut().form.get_or_insert_with(Default::default))
}

/// The raw value stored for `id` ("" when no state was allocated yet).
fn raw(e: &Env, id: NodeId) -> &str {
    form_state(e, id).map_or("", |f| f.value.as_str())
}

/// Element children of `p` (ids, in order).
fn element_children(e: &Env, p: NodeId) -> impl Iterator<Item = NodeId> + '_ {
    let mut c = e.rec(p).first;
    std::iter::from_fn(move || {
        while c != 0 {
            let n = c;
            c = e.rec(c).next;
            if e.is_element(n) {
                return Some(n);
            }
        }
        None
    })
}

/// Concatenated data of the Text children of `id` (HTML "child text content").
pub fn child_text(e: &Env, id: NodeId, out: &mut String) {
    let mut c = e.rec(id).first;
    while c != 0 {
        if e.is_text(c) {
            if let Some(s) = e.char_data(c) {
                out.push_str(s);
            }
        }
        c = e.rec(c).next;
    }
}

fn utf16(s: &str) -> u32 {
    crate::string::utf16_len(s)
}

fn api_value(raw: &str) -> std::borrow::Cow<'_, str> {
    if raw.contains('\r') {
        std::borrow::Cow::Owned(raw.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        std::borrow::Cow::Borrowed(raw)
    }
}

impl Env {
    // ============================================================================ form owner & co

    /// HTML form owner (jsdom's on-demand computation): `form=""` none, no `form` attribute the closest
    /// ancestor `<form>`, otherwise the first element with that id in the control's tree if it is a form.
    pub fn form_owner(&self, id: NodeId) -> NodeId {
        match attr(self, id, atom::FORM) {
            Some("") => 0,
            None => {
                let mut p = self.rec(id).parent;
                while p != 0 {
                    if self.is_html_elem(p, atom::FORM) {
                        return p;
                    }
                    p = self.rec(p).parent;
                }
                0
            }
            Some(v) => {
                let Some(a) = self.atoms.get(v) else { return 0 };
                let root = self.root_of(id);
                // the root itself counts (a disconnected `<form id=f>` holding `<input form=f>`), as in
                // jsdom's firstElementWithId
                let f = if attr(self, root, atom::ID) == Some(v) {
                    root
                } else {
                    self.get_element_by_id(root, a)
                };
                if self.is_html_elem(f, atom::FORM) { f } else { 0 }
            }
        }
    }

    /// Where a form looks for its controls: itself without an id, else its root.
    fn form_search_root(&self, form: NodeId) -> NodeId {
        match attr(self, form, atom::ID) {
            None | Some("") => form,
            Some(_) => self.root_of(form),
        }
    }

    /// Listed elements (`form.elements` / `fieldset.elements` membership).
    fn is_listed(&self, id: NodeId) -> bool {
        let r = self.rec(id);
        r.meta & (meta::KIND_MASK | meta::NS_MASK) == kind::ELEMENT
            && matches!(
                Atom(r.local),
                atom::BUTTON
                    | atom::FIELDSET
                    | atom::INPUT
                    | atom::OBJECT
                    | atom::OUTPUT
                    | atom::SELECT
                    | atom::TEXTAREA
            )
    }

    /// Submittable elements (constraint validation of a form).
    fn is_submittable(&self, id: NodeId) -> bool {
        let r = self.rec(id);
        r.meta & (meta::KIND_MASK | meta::NS_MASK) == kind::ELEMENT
            && matches!(
                Atom(r.local),
                atom::BUTTON | atom::INPUT | atom::OBJECT | atom::SELECT | atom::TEXTAREA
            )
    }

    /// `form.elements`: listed elements (minus image buttons) owned by `form`, in tree order.
    pub fn form_elements(&self, form: NodeId, out: &mut Vec<NodeId>) {
        out.clear();
        if !self.is_html_elem(form, atom::FORM) {
            return;
        }
        let root = self.form_search_root(form);
        let mut n = root;
        while n != 0 {
            if self.is_listed(n)
                && !(is_input(self, n) && input_type(self, n) == ty::IMAGE)
                && self.form_owner(n) == form
            {
                out.push(n);
            }
            n = self.next_in_subtree(n, root);
        }
    }

    /// The controls of `form` that contribute entries to its entry list, in tree order: the control filter
    /// of the HTML "construct the entry list" algorithm (jsdom `FormData-impl.js` `constructTheEntryList`)
    /// over the submittable elements `form` owns. Skipped: datalist descendants, disabled controls, buttons
    /// other than `submitter` (0 = none), unchecked checkboxes and radios, and `<object>`. The facade turns
    /// the rest into name/value entries (it owns the FileList and image coordinates).
    pub fn entry_list_controls(&self, form: NodeId, submitter: NodeId, out: &mut Vec<NodeId>) {
        out.clear();
        if !self.is_html_elem(form, atom::FORM) {
            return;
        }
        let root = self.form_search_root(form);
        let mut n = root;
        while n != 0 {
            if self.is_submittable(n)
                && self.form_owner(n) == form
                && !has_datalist_ancestor(self, n)
                && !is_disabled(self, n)
                && !(is_button(self, n) && n != submitter)
                && !(is_input(self, n)
                    && matches!(input_type(self, n), ty::CHECKBOX | ty::RADIO)
                    && st(self, n) & state::CHECKED == 0)
                && !self.is_html_elem(n, atom::OBJECT)
            {
                out.push(n);
            }
            n = self.next_in_subtree(n, root);
        }
    }

    /// `fieldset.elements`: listed descendants.
    fn fieldset_elements(&self, fs: NodeId, out: &mut Vec<NodeId>) {
        out.clear();
        let mut n = self.next_in_subtree(fs, fs);
        while n != 0 {
            if self.is_listed(n) {
                out.push(n);
            }
            n = self.next_in_subtree(n, fs);
        }
    }

    // ================================================================================== labels

    /// Labelable elements (HTML "labelable element" category).
    pub fn is_labelable(&self, id: NodeId) -> bool {
        let r = self.rec(id);
        if r.meta & (meta::KIND_MASK | meta::NS_MASK) != kind::ELEMENT {
            return false;
        }
        match Atom(r.local) {
            atom::BUTTON | atom::METER | atom::OUTPUT | atom::PROGRESS | atom::SELECT | atom::TEXTAREA => {
                true
            }
            atom::INPUT => input_type(self, id) != ty::HIDDEN,
            _ => self.ce_form_associated(id),
        }
    }

    /// `label.control`.
    pub fn label_control(&self, label: NodeId) -> NodeId {
        if !self.is_html_elem(label, atom::LABEL) {
            return 0;
        }
        if let Some(v) = attr(self, label, atom::FOR) {
            if v.is_empty() {
                return 0;
            }
            let Some(a) = self.atoms.get(v) else { return 0 };
            let el = self.get_element_by_id(self.root_of(label), a);
            return if self.is_labelable(el) { el } else { 0 };
        }
        let mut n = self.next_in_subtree(label, label);
        while n != 0 {
            if self.is_labelable(n) {
                return n;
            }
            n = self.next_in_subtree(n, label);
        }
        0
    }

    /// Labels of `id` in tree order (memoized per root, (EP[TREE], EP[ATTR]) and custom element definitions).
    pub fn labels_of(&mut self, id: NodeId, out: &mut Vec<NodeId>) {
        out.clear();
        let root = self.root_of(id);
        let (tree, at, ce) = (self.ep.get(ep::TREE), self.ep.get(ep::ATTR), self.ce.def_gen);
        let m = &self.forms.labels;
        if !(m.root == root && m.tree == tree && m.attr == at && m.ce == ce) {
            let mut map: FxHashMap<NodeId, SmallVec<[NodeId; 2]>> = FxHashMap::default();
            let mut n = root;
            while n != 0 {
                if self.is_html_elem(n, atom::LABEL) {
                    let c = self.label_control(n);
                    if c != 0 {
                        map.entry(c).or_default().push(n);
                    }
                }
                n = self.next_in_subtree(n, root);
            }
            self.forms.labels = LabelMemo { root, tree, attr: at, ce, map };
        }
        if let Some(v) = self.forms.labels.map.get(&id) {
            out.extend_from_slice(v);
        }
    }

    // ============================================================================ radio groups

    /// The other members of `id`'s radio group (same name, form owner and tree), optionally only the
    /// checked ones. Empty unless `id` is a named radio button.
    fn radio_group_others(&self, id: NodeId, checked_only: bool) -> Ids {
        let mut out = Ids::new();
        if !is_input(self, id) || input_type(self, id) != ty::RADIO {
            return out;
        }
        let Some(name) = attr(self, id, atom::NAME).filter(|n| !n.is_empty()) else { return out };
        let owner = self.form_owner(id);
        let root = if owner != 0 { self.form_search_root(owner) } else { self.root_of(id) };
        let mut n = root;
        while n != 0 {
            if n != id
                && is_input(self, n)
                && input_type(self, n) == ty::RADIO
                && (!checked_only || st(self, n) & state::CHECKED != 0)
                && attr(self, n, atom::NAME) == Some(name)
                && self.form_owner(n) == owner
            {
                out.push(n);
            }
            n = self.next_in_subtree(n, root);
        }
        out
    }

    /// jsdom `_checkedness` setter: sets checkedness; checking a radio unchecks the rest of its group.
    fn set_checkedness(&mut self, id: NodeId, on: bool, group: bool) {
        if set_bits(self, id, state::CHECKED, on) {
            touch(self, id);
        }
        if on && group {
            self.remove_other_radio_checkedness(id);
        }
    }

    fn remove_other_radio_checkedness(&mut self, id: NodeId) {
        for o in self.radio_group_others(id, true) {
            self.set_checkedness(o, false, false);
        }
    }

    /// `input.checked = on` (sets dirty checkedness).
    pub fn set_checked(&mut self, id: NodeId, on: bool) {
        if !is_input(self, id) {
            return;
        }
        set_bits(self, id, state::DIRTY_CHECKED, true);
        self.set_checkedness(id, on, true);
    }

    /// `input.indeterminate = on`.
    pub fn set_indeterminate(&mut self, id: NodeId, on: bool) {
        if self.is_element(id) && set_bits(self, id, state::INDETERMINATE, on) {
            touch(self, id);
        }
    }

    // ============================================================================ input values

    fn range_bounds(&self, id: NodeId) -> types::RangeBounds {
        let num = |a| attr(self, id, a).and_then(|v| types::to_number(ty::RANGE, v));
        types::RangeBounds { min: num(atom::MIN).unwrap_or(0.0), max: num(atom::MAX).unwrap_or(100.0) }
    }

    fn sanitize_for<'a>(&self, id: NodeId, t: u32, v: &'a str) -> std::borrow::Cow<'a, str> {
        let bounds = if t == ty::RANGE { Some(self.range_bounds(id)) } else { None };
        types::sanitize(t, v, has(self, id, atom::MULTIPLE), bounds.as_ref())
    }

    /// jsdom `#setValue`: stores the raw value (no dirty flag change).
    fn set_raw(&mut self, id: NodeId, v: &str) {
        if raw(self, id) == v {
            return;
        }
        if let Some(f) = form_state_mut(self, id) {
            f.value = Str::from(v);
        }
        touch(self, id);
    }

    /// Input type attribute changed: the HTML type-change steps (value mode conversion, sanitization,
    /// radio group, selection reset).
    fn input_type_changed(&mut self, id: NodeId) {
        let prev = input_type(self, id);
        let cur = types::parse_type(attr(self, id, atom::TYPE));
        if prev == cur {
            return;
        }
        let s = self.rec(id).state;
        self.rec_mut(id).state = (s & !state::INPUT_TYPE_MASK) | (cur << TYPE_SHIFT);
        touch(self, id);
        let (pm, cm) = (types::mode(prev), types::mode(cur));
        if pm == Mode::Value && !raw(self, id).is_empty() && matches!(cm, Mode::Default | Mode::DefaultOn) {
            let v = raw(self, id).to_string();
            let _ = self.set_attr(id, atom::VALUE, &v);
        } else if pm != Mode::Value && cm == Mode::Value {
            let v = attr(self, id, atom::VALUE).unwrap_or("").to_string();
            self.set_raw(id, &v);
            set_bits(self, id, state::DIRTY_VALUE, false);
        } else if pm != Mode::Filename && cm == Mode::Filename {
            self.set_raw(id, "");
        }
        if st(self, id) & state::CHECKED != 0 {
            self.remove_other_radio_checkedness(id);
        }
        let v = self.sanitize_for(id, cur, raw(self, id)).into_owned();
        self.set_raw(id, &v);
        if !types::has_selection(prev) && types::has_selection(cur) {
            if let Some(f) = form_state_mut(self, id) {
                f.sel_start = 0;
                f.sel_end = 0;
                f.sel_dir = 0;
            }
        }
    }

    /// Attribute change steps of `<input>` (null namespace). `group`: run the radio-group steps (false for
    /// parser-created elements, which are not yet in their final tree).
    fn input_attr_changed(&mut self, id: NodeId, local: Atom, group: bool) {
        match local {
            atom::TYPE => self.input_type_changed(id),
            atom::VALUE => {
                if st(self, id) & state::DIRTY_VALUE == 0 {
                    let t = input_type(self, id);
                    let v = self.sanitize_for(id, t, attr(self, id, atom::VALUE).unwrap_or("")).into_owned();
                    self.set_raw(id, &v);
                }
                touch(self, id); // default modes read the attribute
            }
            atom::CHECKED => {
                if st(self, id) & state::DIRTY_CHECKED == 0 {
                    let on = has(self, id, atom::CHECKED);
                    self.set_checkedness(id, on, group);
                }
            }
            atom::NAME | atom::FORM if group && st(self, id) & state::CHECKED != 0 => {
                self.remove_other_radio_checkedness(id);
            }
            _ => {}
        }
    }

    /// The API value of `id` into `out` (input in every mode but filename, textarea, select, option,
    /// button). Filename-mode inputs yield "" (the facade owns the FileList).
    pub fn value_into(&self, id: NodeId, out: &mut String) {
        let r = self.rec(id);
        if r.meta & (meta::KIND_MASK | meta::NS_MASK) != kind::ELEMENT {
            return;
        }
        match Atom(r.local) {
            atom::INPUT => match types::mode(input_type(self, id)) {
                Mode::Value => out.push_str(raw(self, id)),
                Mode::Default => out.push_str(attr(self, id, atom::VALUE).unwrap_or("")),
                Mode::DefaultOn => out.push_str(attr(self, id, atom::VALUE).unwrap_or("on")),
                Mode::Filename => {}
            },
            atom::TEXTAREA => {
                if st(self, id) & state::DIRTY_VALUE != 0 {
                    out.push_str(&api_value(raw(self, id)));
                } else {
                    let mut t = String::new();
                    child_text(self, id, &mut t);
                    out.push_str(&api_value(&t));
                }
            }
            atom::SELECT => {
                let mut sel = 0;
                self.for_each_option(id, |o| {
                    if sel == 0 && st(self, o) & state::SELECTED != 0 {
                        sel = o;
                    }
                });
                if sel != 0 {
                    self.option_value_into(sel, out);
                }
            }
            atom::OPTION => self.option_value_into(id, out),
            atom::BUTTON => out.push_str(attr(self, id, atom::VALUE).unwrap_or("")),
            _ => {}
        }
    }

    /// UTF-16 length of the API value (see [`Env::value_into`]); no copy for value-mode inputs.
    pub fn value_len16(&self, id: NodeId) -> u32 {
        if is_input(self, id) && types::mode(input_type(self, id)) == Mode::Value {
            return utf16(raw(self, id));
        }
        let mut s = String::new();
        self.value_into(id, &mut s);
        utf16(&s)
    }

    /// `value` setter of input / textarea / select (option.value is plain reflection). `Ok(true)` when the API
    /// value now equals `v` exactly (the facade may then memoise `v` under the new FORM_VER).
    pub fn value_set(&mut self, id: NodeId, v: &str) -> DomResult<bool> {
        let r = *self.rec(id);
        if r.meta & (meta::KIND_MASK | meta::NS_MASK) != kind::ELEMENT {
            return Ok(false);
        }
        match Atom(r.local) {
            atom::INPUT => {
                let t = input_type(self, id);
                match types::mode(t) {
                    Mode::Value => {
                        let new = self.sanitize_for(id, t, v);
                        let same_as_arg = *new == *v;
                        let changed = raw(self, id) != new;
                        if changed {
                            let n = utf16(&new);
                            if let Some(f) = form_state_mut(self, id) {
                                f.value = Str::from(&*new);
                                f.sel_start = n;
                                f.sel_end = n;
                                f.sel_dir = 0;
                            }
                        }
                        if set_bits(self, id, state::DIRTY_VALUE, true) || changed {
                            touch(self, id);
                        }
                        Ok(same_as_arg)
                    }
                    Mode::Default | Mode::DefaultOn => {
                        self.set_attr(id, atom::VALUE, v)?;
                        Ok(false)
                    }
                    Mode::Filename => {
                        if v.is_empty() {
                            Ok(false)
                        } else {
                            Err(DomError::InvalidState)
                        }
                    }
                }
            }
            atom::TEXTAREA => {
                let mut old = String::new();
                self.value_into(id, &mut old);
                let new_api = api_value(v);
                let same_as_arg = *new_api == *v;
                if old != new_api {
                    let n = utf16(&new_api);
                    if let Some(f) = form_state_mut(self, id) {
                        f.sel_start = n;
                        f.sel_end = n;
                        f.sel_dir = 0;
                    }
                }
                if let Some(f) = form_state_mut(self, id) {
                    f.value = Str::from(v);
                }
                set_bits(self, id, state::DIRTY_VALUE, true);
                touch(self, id);
                Ok(same_as_arg)
            }
            atom::SELECT => {
                let mut ov = String::new();
                for o in self.options_of(id) {
                    ov.clear();
                    self.option_value_into(o, &mut ov);
                    if ov == v {
                        self.set_selectedness(o, true);
                        set_bits(self, o, state::DIRTY_SELECTED, true);
                    } else {
                        self.set_selectedness(o, false);
                    }
                }
                Ok(false)
            }
            _ => Ok(false),
        }
    }

    // ============================================================================ textarea / output

    /// Output default-value override (`None` = follows textContent).
    fn output_override(&self, id: NodeId) -> Option<&str> {
        (st(self, id) & state::DIRTY_VALUE != 0).then(|| raw(self, id))
    }

    fn set_output_override(&mut self, id: NodeId, v: Option<&str>) {
        if !self.is_html_elem(id, atom::OUTPUT) {
            return;
        }
        set_bits(self, id, state::DIRTY_VALUE, v.is_some());
        if let Some(f) = form_state_mut(self, id) {
            f.value = Str::from(v.unwrap_or(""));
        }
    }

    // ============================================================================ selection

    fn selection_applies(&self, id: NodeId) -> bool {
        self.is_html_elem(id, atom::TEXTAREA)
            || (is_input(self, id) && types::has_selection(input_type(self, id)))
    }

    /// Selection of `id` as `(start, end, dir)`; None if the selection API does not apply.
    pub fn selection(&self, id: NodeId) -> Option<(u32, u32, u32)> {
        if !self.selection_applies(id) {
            return None;
        }
        Some(form_state(self, id).map_or((0, 0, 0), |f| (f.sel_start, f.sel_end, f.sel_dir as u32)))
    }

    /// `setSelectionRange(start, end, dir)` (dir 0 none, 1 forward, 2 backward), clamped to the value.
    pub fn set_selection(&mut self, id: NodeId, start: u32, end: u32, dir: u32) -> DomResult {
        if !self.selection_applies(id) {
            return Err(DomError::InvalidState);
        }
        self.store_selection(id, start, end, dir);
        Ok(())
    }

    fn store_selection(&mut self, id: NodeId, start: u32, end: u32, dir: u32) {
        let len = self.value_len16(id);
        let end = end.min(len);
        let start = start.min(end);
        if let Some(f) = form_state_mut(self, id) {
            f.sel_start = start;
            f.sel_end = end;
            f.sel_dir = if dir <= 2 { dir as u8 } else { 0 };
        }
        touch(self, id);
    }

    /// `select()`: selects everything; false if it does not apply (no select event).
    pub fn select_all(&mut self, id: NodeId) -> bool {
        let ok = self.is_html_elem(id, atom::TEXTAREA)
            || (is_input(self, id) && types::select_applies(input_type(self, id)));
        if ok {
            let len = self.value_len16(id);
            if let Some(f) = form_state_mut(self, id) {
                f.sel_start = 0;
                f.sel_end = len;
                f.sel_dir = 0;
            }
            touch(self, id);
        }
        ok
    }

    /// `setRangeText(repl[, start, end[, mode]])` (`explicit` = start/end were passed); mode 0 preserve,
    /// 1 select, 2 start, 3 end.
    pub fn set_range_text(
        &mut self,
        id: NodeId,
        repl: &str,
        start: u32,
        end: u32,
        mode: u32,
        explicit: bool,
    ) -> DomResult {
        let Some((ss, se, _)) = self.selection(id) else { return Err(DomError::InvalidState) };
        let (mut start, mut end) = if explicit { (start, end) } else { (ss, se) };
        if explicit && start > end {
            return Err(DomError::IndexSize);
        }
        let len = self.value_len16(id);
        start = start.min(len);
        end = end.min(len);
        let mut val = String::new();
        self.value_into(id, &mut val);
        let ascii = val.is_ascii();
        let (bs, be) = (
            crate::string::utf16_to_byte(&val, ascii, start),
            crate::string::utf16_to_byte(&val, ascii, end),
        );
        let mut next = String::with_capacity(val.len() + repl.len());
        next.push_str(&val[..bs]);
        next.push_str(repl);
        next.push_str(&val[be..]);
        self.value_set(id, &next)?;
        let rl = utf16(repl);
        let new_end = start + rl;
        let (s2, e2) = match mode {
            1 => (start, new_end),
            2 => (start, start),
            3 => (new_end, new_end),
            _ => {
                let delta = rl as i64 - (end as i64 - start as i64);
                let adj = |v: u32, after: u32| -> u32 {
                    if v > end {
                        (v as i64 + delta).max(0) as u32
                    } else if v > start {
                        after
                    } else {
                        v
                    }
                };
                (adj(ss, start), adj(se, new_end))
            }
        };
        self.store_selection(id, s2, e2, 0);
        Ok(())
    }

    // ============================================================================ select / option

    /// The select's list of options: option children and option children of optgroup children.
    pub fn options_of(&self, sel: NodeId) -> Ids {
        let mut out = Ids::new();
        self.for_each_option(sel, |o| out.push(o));
        out
    }

    /// Visits the list of options of `sel` in tree order without collecting it (`options_of`).
    #[inline]
    fn for_each_option(&self, sel: NodeId, mut f: impl FnMut(NodeId)) {
        for c in element_children(self, sel) {
            if self.is_html_elem(c, atom::OPTION) {
                f(c);
            } else if self.is_html_elem(c, atom::OPTGROUP) {
                for o in element_children(self, c) {
                    if self.is_html_elem(o, atom::OPTION) {
                        f(o);
                    }
                }
            }
        }
    }

    /// The option's select (parent, or grandparent through an optgroup or any element), as jsdom.
    fn select_of_option(&self, opt: NodeId) -> NodeId {
        let p = self.rec(opt).parent;
        if p == 0 {
            return 0;
        }
        if self.is_html_elem(p, atom::SELECT) {
            return p;
        }
        let pp = self.rec(p).parent;
        if self.is_html_elem(pp, atom::SELECT) { pp } else { 0 }
    }

    fn set_selectedness(&mut self, opt: NodeId, on: bool) {
        if set_bits(self, opt, state::SELECTED, on) {
            touch(self, opt);
        }
    }

    fn display_size(&self, sel: NodeId) -> u32 {
        attr(self, sel, atom::SIZE)
            .and_then(element_state::parse_non_negative_integer)
            .unwrap_or(if has(self, sel, atom::MULTIPLE) { 4 } else { 1 })
    }

    /// The select's "selectedness setting algorithm" (jsdom `_askedForAReset`).
    pub fn select_reset(&mut self, sel: NodeId) {
        if !self.is_html_elem(sel, atom::SELECT) || has(self, sel, atom::MULTIPLE) {
            return;
        }
        let scan = self.scan_options(sel);
        self.apply_reset(sel, &scan);
    }

    /// One allocation-free pass over the list of options of `sel`: its signature, how many options are
    /// selected, the last selected one and the first one that is not disabled (itself or its optgroup).
    fn scan_options(&self, sel: NodeId) -> OptScan {
        let mut sig = OptSig::new();
        let (mut selected, mut last_selected, mut first_enabled) = (0u32, 0, 0);
        self.for_each_option(sel, |o| {
            sig.push(o);
            if st(self, o) & state::SELECTED != 0 {
                selected += 1;
                last_selected = o;
            }
            if first_enabled == 0 {
                let p = self.rec(o).parent;
                if !(has(self, o, atom::DISABLED)
                    || (self.is_html_elem(p, atom::OPTGROUP) && has(self, p, atom::DISABLED)))
                {
                    first_enabled = o;
                }
            }
        });
        OptScan { sig: sig.finish(), selected, last_selected, first_enabled }
    }

    fn apply_reset(&mut self, sel: NodeId, scan: &OptScan) {
        if let Some(f) = form_state_mut(self, sel) {
            f.opt_sig = scan.sig;
        }
        if scan.selected == 0 {
            if scan.first_enabled != 0 && self.display_size(sel) == 1 {
                self.set_selectedness(scan.first_enabled, true);
            }
        } else if scan.selected >= 2 {
            // keep the last selected option in tree order
            let mut others = Ids::new();
            self.for_each_option(sel, |o| {
                if o != scan.last_selected && st(self, o) & state::SELECTED != 0 {
                    others.push(o);
                }
            });
            for o in others {
                self.set_selectedness(o, false);
            }
        }
    }

    /// A child list inside `sel` changed: HTML runs the selectedness setting algorithm only when its list
    /// of options gained or lost options (appending a `<span>` or a comment keeps `selectedIndex = -1`).
    /// One pass computes both the signature and the reset inputs (building a select is still O(n) per
    /// appended option, but without the two collected lists it used to allocate).
    fn select_children_changed(&mut self, sel: NodeId) {
        if !self.is_html_elem(sel, atom::SELECT) || has(self, sel, atom::MULTIPLE) {
            return;
        }
        let scan = self.scan_options(sel);
        if form_state(self, sel).is_some_and(|f| f.opt_sig == scan.sig) {
            return;
        }
        self.apply_reset(sel, &scan);
    }

    fn ask_reset(&mut self, opt: NodeId) {
        let s = self.select_of_option(opt);
        if s != 0 {
            self.select_reset(s);
        }
    }

    fn remove_other_selectedness(&mut self, opt: NodeId) {
        let s = self.select_of_option(opt);
        if s != 0 && !has(self, s, atom::MULTIPLE) {
            let mut others = Ids::new();
            self.for_each_option(s, |o| {
                if o != opt && st(self, o) & state::SELECTED != 0 {
                    others.push(o);
                }
            });
            for o in others {
                self.set_selectedness(o, false);
            }
        }
    }

    /// `option.selected = on`.
    pub fn set_selected(&mut self, opt: NodeId, on: bool) {
        if !self.is_html_elem(opt, atom::OPTION) {
            return;
        }
        set_bits(self, opt, state::DIRTY_SELECTED, true);
        self.set_selectedness(opt, on);
        if on {
            self.remove_other_selectedness(opt);
        }
        self.ask_reset(opt);
    }

    /// `select.selectedIndex`.
    pub fn selected_index(&self, sel: NodeId) -> i32 {
        let (mut i, mut found) = (0, -1);
        self.for_each_option(sel, |o| {
            if found < 0 && st(self, o) & state::SELECTED != 0 {
                found = i;
            }
            i += 1;
        });
        found
    }

    /// `select.selectedIndex = i`.
    pub fn set_selected_index(&mut self, sel: NodeId, i: i32) {
        let opts = self.options_of(sel);
        for &o in &opts {
            self.set_selectedness(o, false);
        }
        if i >= 0 {
            if let Some(&o) = opts.get(i as usize) {
                self.set_selectedness(o, true);
                set_bits(self, o, state::DIRTY_SELECTED, true);
            }
        }
    }

    /// Option text (`option.text`): child text excluding `<script>` descendants, stripped and collapsed.
    pub fn option_text(&self, opt: NodeId) -> String {
        let mut s = String::new();
        let mut n = self.next_in_subtree(opt, opt);
        while n != 0 {
            let r = self.rec(n);
            let k = r.meta & meta::KIND_MASK;
            if k == kind::ELEMENT
                && r.local == atom::SCRIPT.0
                && matches!((r.meta & meta::NS_MASK) >> meta::NS_SHIFT, 0 | 1)
            {
                n = self.next_skipping_children(n, opt);
                continue;
            }
            if k == kind::TEXT || k == kind::CDATA {
                if let Some(d) = self.char_data(n) {
                    s.push_str(d);
                }
            }
            n = self.next_in_subtree(n, opt);
        }
        types::strip_and_collapse(&s)
    }

    fn option_value_into(&self, opt: NodeId, out: &mut String) {
        match attr(self, opt, atom::VALUE) {
            Some(v) => out.push_str(v),
            None => out.push_str(&self.option_text(opt)),
        }
    }

    /// `option.index`: position in the closest select's options, 0 without a select.
    pub fn option_index(&self, opt: NodeId) -> i32 {
        let mut p = self.rec(opt).parent;
        while p != 0 && !self.is_html_elem(p, atom::SELECT) {
            p = self.rec(p).parent;
        }
        if p == 0 {
            return 0;
        }
        let (mut i, mut found) = (0, -1);
        self.for_each_option(p, |o| {
            if o == opt {
                found = i;
            }
            i += 1;
        });
        found
    }

    /// `select.selectedOptions`: selected option descendants in tree order.
    fn selected_options(&self, sel: NodeId, out: &mut Vec<NodeId>) {
        out.clear();
        let mut n = self.next_in_subtree(sel, sel);
        while n != 0 {
            if self.is_html_elem(n, atom::OPTION) && st(self, n) & state::SELECTED != 0 {
                out.push(n);
            }
            n = self.next_in_subtree(n, sel);
        }
    }

    // ============================================================================ activation

    /// Legacy-pre-activation behaviour of checkbox / radio inputs (before the click listeners run).
    /// Returns the packed previous state for [`Self::cancel_activation`] (0 = nothing done): bit 0 checkbox,
    /// bit 1 previous indeterminate, bit 2 radio, bit 3 radio was checked, bits 5.. previously checked radio.
    pub fn pre_activate(&mut self, id: NodeId) -> u32 {
        if !is_input(self, id) {
            return 0;
        }
        match input_type(self, id) {
            ty::CHECKBOX => {
                let s = st(self, id);
                let prev_ind = s & state::INDETERMINATE != 0;
                self.set_checked(id, s & state::CHECKED == 0);
                self.set_indeterminate(id, false);
                1 | (prev_ind as u32) << 1
            }
            ty::RADIO => {
                let was = st(self, id) & state::CHECKED != 0;
                let prev =
                    if was { id } else { self.radio_group_others(id, true).first().copied().unwrap_or(0) };
                self.set_checked(id, true);
                4 | (was as u32) << 3 | prev << 5
            }
            _ => 0,
        }
    }

    /// Legacy-canceled-activation behaviour: restores the state saved by [`Self::pre_activate`].
    pub fn cancel_activation(&mut self, id: NodeId, packed: u32) {
        if packed & 1 != 0 {
            let on = st(self, id) & state::CHECKED == 0;
            self.set_checked(id, on);
            self.set_indeterminate(id, packed & 2 != 0);
        } else if packed & 4 != 0 {
            let prev = packed >> 5;
            if prev != 0 && (prev == id || self.radio_group_others(id, false).contains(&prev)) {
                self.set_checkedness(prev, true, true);
            } else {
                self.set_checkedness(id, false, false);
            }
        }
    }

    // ============================================================================ reset

    /// Form reset of one control (input / textarea / select).
    fn reset_control(&mut self, id: NodeId) {
        let r = *self.rec(id);
        if r.meta & (meta::KIND_MASK | meta::NS_MASK) != kind::ELEMENT {
            return;
        }
        match Atom(r.local) {
            atom::INPUT => {
                let t = input_type(self, id);
                let v = self.sanitize_for(id, t, attr(self, id, atom::VALUE).unwrap_or("")).into_owned();
                self.set_raw(id, &v);
                set_bits(self, id, state::DIRTY_VALUE | state::DIRTY_CHECKED, false);
                let on = has(self, id, atom::CHECKED);
                self.set_checkedness(id, on, true);
                touch(self, id);
            }
            atom::TEXTAREA => {
                let mut t = String::new();
                child_text(self, id, &mut t);
                if let Some(f) = form_state_mut(self, id) {
                    f.value = Str::from(t.as_str());
                }
                set_bits(self, id, state::DIRTY_VALUE, false);
                touch(self, id);
            }
            atom::SELECT => {
                for o in self.options_of(id) {
                    let on = has(self, o, atom::SELECTED);
                    self.set_selectedness(o, on);
                    set_bits(self, o, state::DIRTY_SELECTED, false);
                }
                self.select_reset(id);
            }
            _ => {}
        }
    }

    /// `form.reset()` steps after the (uncanceled) reset event: resets every control of `form.elements`.
    pub fn form_reset(&mut self, form: NodeId) {
        let mut els = Vec::new();
        self.form_elements(form, &mut els);
        for id in els {
            self.reset_control(id);
        }
    }

    /// Submittable controls of `form` that are candidates for constraint validation (the facade checks
    /// each one's validity, including the pattern / url / files parts it owns).
    fn form_validation_candidates(&self, form: NodeId, out: &mut Vec<NodeId>) {
        let mut els = Vec::new();
        self.form_elements(form, &mut els);
        out.clear();
        out.extend(
            els.into_iter()
                .filter(|&c| self.is_submittable(c) && validity_bits(self, c) & vbits::CANDIDATE != 0),
        );
    }

    // ============================================================================ hooks

    fn option_attr_changed(&mut self, opt: NodeId, local: Atom) {
        if local == atom::SELECTED && st(self, opt) & state::DIRTY_SELECTED == 0 {
            let on = has(self, opt, atom::SELECTED);
            self.set_selectedness(opt, on);
            if on {
                self.remove_other_selectedness(opt);
            }
            self.ask_reset(opt);
        }
    }
}

/// Hook: attribute changed (null-namespace attributes drive form state).
#[inline]
pub(crate) fn on_attr_changed(e: &mut Env, el: NodeId, local: Atom, ns: Atom, old: Option<&Str>) {
    if !ns.is_none() {
        return;
    }
    let r = e.rec(el);
    if r.meta & (meta::KIND_MASK | meta::NS_MASK) != kind::ELEMENT {
        return;
    }
    match Atom(r.local) {
        atom::DETAILS if local == atom::OPEN && old.is_some() != e.has_attr(el, atom::OPEN) => {
            e.queue_details_toggle(el)
        }
        atom::INPUT => e.input_attr_changed(el, local, true),
        atom::OPTION => e.option_attr_changed(el, local),
        atom::SELECT if matches!(local, atom::MULTIPLE | atom::SIZE) => e.select_reset(el),
        _ => {}
    }
}

/// Hook: child list of `parent` changed: options inserted/removed (select reset), textarea default value.
#[inline]
pub(crate) fn on_children_changed(e: &mut Env, parent: NodeId) {
    let r = e.rec(parent);
    if r.meta & (meta::KIND_MASK | meta::NS_MASK) != kind::ELEMENT {
        return;
    }
    match Atom(r.local) {
        atom::SELECT => e.select_children_changed(parent),
        atom::OPTGROUP => {
            let p = r.parent;
            if e.is_html_elem(p, atom::SELECT) {
                e.select_children_changed(p);
            }
        }
        atom::TEXTAREA => touch(e, parent),
        _ => {}
    }
}

/// Hook: character data of `id` changed (a clean textarea's value follows its text children).
#[inline]
pub(crate) fn on_char_data_changed(e: &mut Env, id: NodeId) {
    let p = e.rec(id).parent;
    if p != 0 && e.is_html_elem(p, atom::TEXTAREA) {
        touch(e, p);
    }
}

/// Hook: node became connected: a checked radio unchecks the rest of its group (insertion steps).
#[inline]
pub(crate) fn on_node_connected(e: &mut Env, id: NodeId) {
    if st(e, id) & state::CHECKED != 0 && is_input(e, id) {
        e.remove_other_radio_checkedness(id);
    }
}

/// Hook: node became disconnected.
#[inline]
pub(crate) fn on_node_disconnected(_e: &mut Env, _id: NodeId) {}

/// Hook: cloning steps (`src` cloned into `dst`, attributes already copied): inputs copy value,
/// checkedness, dirty flags and indeterminate; textareas their raw value; options take their default
/// selectedness from the copied `selected` attribute (jsdom runs attribute-change steps on clones).
#[inline]
pub(crate) fn on_cloned(e: &mut Env, src: NodeId, dst: NodeId) {
    let r = *e.rec(src);
    if r.meta & (meta::KIND_MASK | meta::NS_MASK) != kind::ELEMENT {
        return;
    }
    match Atom(r.local) {
        atom::INPUT | atom::TEXTAREA => {
            const COPY: u32 = state::CHECKED
                | state::INDETERMINATE
                | state::DIRTY_VALUE
                | state::DIRTY_CHECKED
                | state::INPUT_TYPE_MASK;
            let s = e.rec(dst).state;
            e.rec_mut(dst).state = (s & !COPY) | (r.state & COPY);
            if let Some(f) = form_state(e, src).cloned() {
                // Cloning steps copy value, dirty value, checkedness and dirty checkedness only: the
                // clone's selection starts at 0 like a freshly created control's (jsdom; M9 review).
                if let Some(d) = form_state_mut(e, dst) {
                    d.value = f.value;
                }
            }
            touch(e, dst);
        }
        atom::OPTION if has(e, dst, atom::SELECTED) => e.set_selectedness(dst, true),
        _ => {}
    }
}

/// Parser hook: nodes `base..` were created by one parse (inserted raw, without per-node hooks). Runs the
/// attribute-change steps of inputs and options in attribute order (radio-group exclusivity waits for the
/// connection, as for jsdom's parser-created elements), then the selectedness algorithm of each select.
pub(crate) fn on_parsed(e: &mut Env, base: NodeId) {
    let end = e.table.len();
    let mut selects: SmallVec<[NodeId; 4]> = SmallVec::new();
    for id in base..end {
        let r = *e.rec(id);
        if r.meta & (meta::KIND_MASK | meta::NS_MASK) != kind::ELEMENT {
            continue;
        }
        match Atom(r.local) {
            atom::INPUT => {
                let names: SmallVec<[Atom; 8]> = e
                    .elem(id)
                    .map(|d| d.attrs.iter().filter(|a| a.ns.is_none()).map(|a| a.local).collect())
                    .unwrap_or_default();
                for a in names {
                    e.input_attr_changed(id, a, false);
                }
            }
            atom::OPTION => {
                if has(e, id, atom::SELECTED) {
                    e.set_selectedness(id, true);
                }
            }
            atom::SELECT => selects.push(id),
            // the parser appends attributes, which runs the details attribute change steps (jsdom too)
            atom::DETAILS if has(e, id, atom::OPEN) => e.queue_details_toggle(id),
            _ => {}
        }
    }
    for s in selects {
        e.select_reset(s);
    }
}

// ================================================================================== natives

natives! {
    /// API `value` of input (all modes but filename) / textarea / select / option / button.
    fn valueGet(e, id: u32) -> &str {
        let mut s = std::mem::take(&mut e.scratch);
        s.clear();
        e.value_into(id, &mut s);
        e.scratch = s;
        e.scratch.as_str()
    }
    /// `value` setter of input / textarea / select. An error code (InvalidStateError for file inputs), else 0,
    /// or VALUE_IS_ARG (0x100) when the API value now equals `v` (the facade memoises it).
    fn valueSet(e, id: u32, v: str) -> Code {
        match e.value_set(id, v) {
            Ok(true) => VALUE_IS_ARG,
            Ok(false) => 0,
            Err(err) => err as u32,
        }
    }
    /// input.checked = on (dirty checkedness, radio group).
    fn setChecked(e, id: u32, on: bool) -> () {
        e.set_checked(id, on)
    }
    /// input.indeterminate = on.
    fn setIndeterminate(e, id: u32, on: bool) -> () {
        e.set_indeterminate(id, on)
    }
    /// option.selected = on (dirtiness, single-select exclusivity, select reset).
    fn setSelected(e, id: u32, on: bool) -> () {
        e.set_selected(id, on)
    }
    /// An option's selectedness alone, as `new Option(..., selected)` sets it (jsdom Window.js: no dirtiness,
    /// no reset: the option has no select yet).
    fn setSelectedness(e, id: u32, on: bool) -> () {
        if e.is_html_elem(id, atom::OPTION) {
            e.set_selectedness(id, on)
        }
    }
    /// select.selectedIndex (-1 when nothing is selected).
    fn selectedIndexGet(e, id: u32) -> i32 {
        e.selected_index(id)
    }
    /// select.selectedIndex = i.
    fn selectedIndexSet(e, id: u32, i: i32) -> () {
        e.set_selected_index(id, i)
    }
    /// select.options -> OUT ids; returns the count.
    fn selectOptions(e, id: u32) -> u32 {
        let o = e.options_of(id);
        e.write_out(&o)
    }
    /// select.selectedOptions -> OUT ids; returns the count.
    fn selectedOptions(e, id: u32) -> u32 {
        let mut v = std::mem::take(&mut e.ids);
        e.selected_options(id, &mut v);
        e.ids = v;
        e.write_ids()
    }
    /// option.index.
    fn optionIndex(e, id: u32) -> i32 {
        e.option_index(id)
    }
    /// option.text (stripped and collapsed, script descendants excluded).
    fn optionText(e, id: u32) -> &str {
        let t = e.option_text(id);
        e.scratch = t;
        e.scratch.as_str()
    }
    /// Child text content (textarea.defaultValue).
    fn childText(e, id: u32) -> &str {
        let mut s = std::mem::take(&mut e.scratch);
        s.clear();
        child_text(e, id, &mut s);
        e.scratch = s;
        e.scratch.as_str()
    }
    /// Selection of input/textarea: 1 + OUT=[start16, end16, dir] or 0 when the API does not apply.
    fn selGet(e, id: u32) -> u32 {
        match e.selection(id) {
            Some((s, en, d)) => {
                e.write_out(&[s, en, d]);
                1
            }
            None => 0,
        }
    }
    /// setSelectionRange(start16, end16, dir 0 none/1 forward/2 backward). 0 or InvalidStateError.
    fn selSet(e, id: u32, start: u32, end: u32, dir: u32) -> Code {
        code(e.set_selection(id, start, end, dir))
    }
    /// select(): true if it applied (the facade then queues the select event).
    fn selectAll(e, id: u32) -> bool {
        e.select_all(id)
    }
    /// setRangeText(repl, start, end, mode 0 preserve/1 select/2 start/3 end); `explicit` = start/end given.
    fn setRangeText(e, id: u32, repl: str, start: u32, end: u32, mode: u32, explicit: bool) -> Code {
        code(e.set_range_text(id, repl, start, end, mode, explicit))
    }
    /// Legacy-pre-activation (checkbox toggle / radio check); returns packed previous state (0 = none).
    fn preActivate(e, id: u32) -> u32 {
        e.pre_activate(id)
    }
    /// Legacy-canceled-activation: restores the state packed by preActivate.
    fn cancelActivation(e, id: u32, packed: u32) -> () {
        e.cancel_activation(id, packed)
    }
    /// Form owner of a form-associated element (0 = none).
    fn formOwner(e, id: u32) -> u32 {
        e.form_owner(id)
    }
    /// form.elements -> OUT ids; returns the count.
    fn formElements(e, id: u32) -> u32 {
        let mut v = std::mem::take(&mut e.ids);
        e.form_elements(id, &mut v);
        e.ids = v;
        e.write_ids()
    }
    /// Controls of a form that contribute FormData entries (submitter 0 = none) -> OUT ids; returns the count.
    fn formEntryControls(e, form: u32, submitter: u32) -> u32 {
        let mut v = std::mem::take(&mut e.ids);
        e.entry_list_controls(form, submitter, &mut v);
        e.ids = v;
        e.write_ids()
    }
    /// fieldset.elements -> OUT ids; returns the count.
    fn fieldsetElements(e, id: u32) -> u32 {
        let mut v = std::mem::take(&mut e.ids);
        e.fieldset_elements(id, &mut v);
        e.ids = v;
        e.write_ids()
    }
    /// Reset steps of form.reset() (after the facade's uncanceled reset event).
    fn formReset(e, id: u32) -> () {
        e.form_reset(id)
    }
    /// Constraint-validation candidates of a form (submittable, willValidate) -> OUT ids; returns the count.
    fn formCandidates(e, id: u32) -> u32 {
        let mut v = std::mem::take(&mut e.ids);
        e.form_validation_candidates(id, &mut v);
        e.ids = v;
        e.write_ids()
    }
    /// label.control (0 = none).
    fn labelControl(e, id: u32) -> u32 {
        e.label_control(id)
    }
    /// labels of a labelable element -> OUT ids; returns the count, or 0xFFFFFFFF if not labelable.
    fn labels(e, id: u32) -> u32 {
        if !e.is_labelable(id) {
            u32::MAX
        } else {
            let mut v = std::mem::take(&mut e.ids);
            e.labels_of(id, &mut v);
            e.ids = v;
            e.write_ids()
        }
    }
    /// Queued `<details>` toggle event tasks (ids in queue order) into OUT; clears `EP[MO_PENDING]` bit 1. Returns the count.
    fn takeToggles(e) -> u32 {
        e.take_toggles()
    }
    /// setCustomValidity(message).
    fn setCustomValidity(e, id: u32, msg: str) -> () {
        e.set_custom_validity(id, msg)
    }
    /// The custom validity message ("" = none).
    fn customValidity(e, id: u32) -> &str {
        form_state(e, id).map_or("", |f| f.custom.as_str())
    }
    /// valueAsNumber of numeric inputs (NaN when not applicable or unparseable).
    fn inputNumber(e, id: u32) -> f64 {
        let t = input_type(e, id);
        if is_input(e, id) && types::is_numeric(t) { types::to_number(t, raw(e, id)).unwrap_or(f64::NAN) } else { f64::NAN }
    }
    /// jsdom `#setValue` for a value-mode input: stores `v` as is (no sanitization, dirty flag unchanged), as
    /// `stepUp()` / `valueAsNumber` / `valueAsDate` do.
    fn valueSetRaw(e, id: u32, v: str) -> () {
        if is_input(e, id) && types::mode(input_type(e, id)) == Mode::Value {
            e.set_raw(id, v);
        }
    }
    /// `s` as a number for input type `ty` (the value-string conversion of numeric types; NaN when invalid).
    fn formNumber(e, ty: str, s: str) -> f64 {
        let _ = e;
        types::to_number(types::parse_type(Some(ty)), s).unwrap_or(f64::NAN)
    }
    /// output default-value override (null = none).
    fn outputOverride(e, id: u32) -> Option<&str> {
        e.output_override(id)
    }
    /// Sets (string) or clears (null) the output default-value override.
    fn setOutputOverride(e, id: u32, v: ostr) -> () {
        e.set_output_override(id, v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::DocKind;
    use crate::node::Ns;

    fn setup() -> (Env, NodeId) {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        e.main_doc = doc;
        (e, doc)
    }

    fn el(e: &mut Env, doc: NodeId, a: Atom) -> NodeId {
        e.create_element(doc, a, Ns::Html)
    }

    fn body(e: &Env, doc: NodeId) -> NodeId {
        let html = e.rec(doc).last;
        e.rec(html).last
    }

    fn val(e: &Env, id: NodeId) -> String {
        let mut s = String::new();
        e.value_into(id, &mut s);
        s
    }

    #[test]
    fn value_vs_default_value_oracle() {
        // docs/lab/research/jsdom.md §6.8
        let (mut e, doc) = setup();
        let i = el(&mut e, doc, atom::INPUT);
        e.set_attr(i, atom::VALUE, "a").unwrap();
        assert_eq!(val(&e, i), "a");
        e.value_set(i, "typed").unwrap();
        assert_eq!(val(&e, i), "typed");
        e.set_attr(i, atom::VALUE, "b").unwrap();
        assert_eq!(val(&e, i), "typed");
        let j = el(&mut e, doc, atom::INPUT);
        e.set_attr(j, atom::VALUE, "x").unwrap();
        assert_eq!(val(&e, j), "x");
        assert_eq!(e.selection(j), Some((0, 0, 0)));
        e.value_set(j, "hello").unwrap();
        assert_eq!(e.selection(j), Some((5, 5, 0)));
    }

    #[test]
    fn modes_and_sanitization() {
        let (mut e, doc) = setup();
        let i = el(&mut e, doc, atom::INPUT);
        e.set_attr(i, atom::TYPE, "checkbox").unwrap();
        assert_eq!(val(&e, i), "on");
        assert_eq!(e.selection(i), None);
        e.value_set(i, "yes").unwrap();
        assert_eq!(e.get_attr(i, atom::VALUE).map(|s| s.as_str()), Some("yes"));
        let n = el(&mut e, doc, atom::INPUT);
        e.set_attr(n, atom::TYPE, "number").unwrap();
        e.value_set(n, "abc").unwrap();
        assert_eq!(val(&e, n), "");
        let r = el(&mut e, doc, atom::INPUT);
        e.set_attr(r, atom::TYPE, "range").unwrap();
        assert_eq!(val(&e, r), "50");
        let f = el(&mut e, doc, atom::INPUT);
        e.set_attr(f, atom::TYPE, "file").unwrap();
        assert_eq!(e.value_set(f, "x"), Err(DomError::InvalidState));
        // text -> hidden with a value writes the attribute
        let t = el(&mut e, doc, atom::INPUT);
        e.value_set(t, "kept").unwrap();
        e.set_attr(t, atom::TYPE, "hidden").unwrap();
        assert_eq!(e.get_attr(t, atom::VALUE).map(|s| s.as_str()), Some("kept"));
    }

    #[test]
    fn radio_group_and_activation() {
        let (mut e, doc) = setup();
        let b = body(&e, doc);
        let form = el(&mut e, doc, atom::FORM);
        e.append_child(b, form).unwrap();
        let mut rs = Vec::new();
        for _ in 0..3 {
            let r = el(&mut e, doc, atom::INPUT);
            e.set_attr(r, atom::TYPE, "radio").unwrap();
            e.set_attr(r, atom::NAME, "g").unwrap();
            e.append_child(form, r).unwrap();
            rs.push(r);
        }
        e.set_checked(rs[0], true);
        e.set_checked(rs[1], true);
        assert_eq!(st(&e, rs[0]) & state::CHECKED, 0);
        assert_ne!(st(&e, rs[1]) & state::CHECKED, 0);
        let p = e.pre_activate(rs[2]);
        assert_ne!(st(&e, rs[2]) & state::CHECKED, 0);
        assert_eq!(st(&e, rs[1]) & state::CHECKED, 0);
        e.cancel_activation(rs[2], p);
        assert_eq!(st(&e, rs[2]) & state::CHECKED, 0);
        assert_ne!(st(&e, rs[1]) & state::CHECKED, 0);
        let c = el(&mut e, doc, atom::INPUT);
        e.set_attr(c, atom::TYPE, "checkbox").unwrap();
        let p = e.pre_activate(c);
        assert_ne!(st(&e, c) & state::CHECKED, 0);
        e.cancel_activation(c, p);
        assert_eq!(st(&e, c) & state::CHECKED, 0);
    }

    /// The single-pass reset: first enabled option (disabled option / optgroup skipped), last of
    /// several selected options wins, appending a non-option keeps selectedIndex -1, optgroup options
    /// count, option index / select value read the list in place.
    #[test]
    fn select_reset_single_pass() {
        let (mut e, doc) = setup();
        let b = body(&e, doc);
        e.set_inner_html(
            b,
            "<select id=s><option disabled>a<optgroup disabled><option>b</optgroup><optgroup><option id=c>c<option id=d>d</optgroup></select>",
        )
        .unwrap();
        let s = e.rec(b).first;
        assert_eq!(e.selected_index(s), 2);
        let opts = e.options_of(s);
        assert_eq!(opts.len(), 4);
        assert_eq!(e.option_index(opts[3]), 3);
        e.set_attr(opts[3], atom::SELECTED, "").unwrap();
        assert_eq!(e.selected_index(s), 3);
        // two selected options (a parsed duplicate): the last one wins on the next reset
        set_bits(&mut e, opts[2], state::SELECTED, true);
        e.select_reset(s);
        assert_eq!(e.selected_index(s), 3);
        assert_eq!(st(&e, opts[2]) & state::SELECTED, 0);
        let mut v = String::new();
        e.value_into(s, &mut v);
        assert_eq!(v, "d");
        // an empty select gaining a non-option stays at -1; gaining an option selects it
        let s2 = el(&mut e, doc, atom::SELECT);
        let span = el(&mut e, doc, atom::SPAN);
        e.append_child(s2, span).unwrap();
        assert_eq!(e.selected_index(s2), -1);
        let o = el(&mut e, doc, atom::OPTION);
        e.append_child(s2, o).unwrap();
        assert_eq!(e.selected_index(s2), 0);
    }

    #[test]
    fn select_reset_and_value() {
        let (mut e, doc) = setup();
        let s = el(&mut e, doc, atom::SELECT);
        let mut opts = Vec::new();
        for v in ["a", "b", "c"] {
            let o = el(&mut e, doc, atom::OPTION);
            e.set_attr(o, atom::VALUE, v).unwrap();
            e.append_child(s, o).unwrap();
            opts.push(o);
        }
        assert_eq!(e.selected_index(s), 0);
        e.value_set(s, "c").unwrap();
        assert_eq!(e.selected_index(s), 2);
        assert_eq!(val(&e, s), "c");
        e.value_set(s, "nope").unwrap();
        assert_eq!(e.selected_index(s), -1);
        assert_eq!(val(&e, s), "");
        e.set_attr(opts[1], atom::SELECTED, "").unwrap();
        assert_eq!(e.selected_index(s), 1);
        assert_eq!(e.option_index(opts[2]), 2);
    }

    #[test]
    fn parsed_controls() {
        let (mut e, doc) = setup();
        let b = body(&e, doc);
        e.set_inner_html(
            b,
            "<form><input type=checkbox checked><input type=radio name=r checked><input type=radio name=r checked>\
             <select><option>x<option selected>y</select><textarea>t\r\nx</textarea><label for=q>L</label><input id=q value=v></form>",
        )
        .unwrap();
        let form = e.rec(b).first;
        let mut els = Vec::new();
        e.form_elements(form, &mut els);
        assert_eq!(els.len(), 6);
        assert_ne!(st(&e, els[0]) & state::CHECKED, 0);
        assert_eq!(input_type(&e, els[0]), ty::CHECKBOX);
        // first checked radio wins on connection (jsdom insertion steps)
        assert_ne!(st(&e, els[1]) & state::CHECKED, 0);
        assert_eq!(st(&e, els[2]) & state::CHECKED, 0);
        assert_eq!(e.selected_index(els[3]), 1);
        assert_eq!(val(&e, els[4]), "t\nx");
        assert_eq!(val(&e, els[5]), "v");
        let mut ls = Vec::new();
        e.labels_of(els[5], &mut ls);
        assert_eq!(ls.len(), 1);
        assert_eq!(e.label_control(ls[0]), els[5]);
    }

    #[test]
    fn validity_bits_of_controls() {
        let (mut e, doc) = setup();
        let i = el(&mut e, doc, atom::INPUT);
        e.set_attr(i, atom::REQUIRED, "").unwrap();
        assert_ne!(validity_bits(&e, i) & vbits::VALUE_MISSING, 0);
        e.value_set(i, "x").unwrap();
        assert_eq!(validity_bits(&e, i) & vbits::VALUE_MISSING, 0);
        e.set_attr(i, atom::TYPE, "email").unwrap();
        assert_ne!(validity_bits(&e, i) & vbits::TYPE_MISMATCH, 0);
        e.value_set(i, "a@b.co").unwrap();
        assert_eq!(validity_bits(&e, i) & vbits::TYPE_MISMATCH, 0);
        let n = el(&mut e, doc, atom::INPUT);
        e.set_attr(n, atom::TYPE, "number").unwrap();
        e.set_attr(n, atom::MIN, "2").unwrap();
        e.set_attr(n, atom::MAX, "5").unwrap();
        e.value_set(n, "7").unwrap();
        assert_ne!(validity_bits(&e, n) & vbits::RANGE_OVERFLOW, 0);
        e.value_set(n, "1").unwrap();
        assert_ne!(validity_bits(&e, n) & vbits::RANGE_UNDERFLOW, 0);
        e.value_set(n, "2.5").unwrap();
        assert_ne!(validity_bits(&e, n) & vbits::STEP_MISMATCH, 0);
        assert_ne!(validity_bits(&e, n) & vbits::CANDIDATE, 0);
        e.set_attr(n, atom::DISABLED, "").unwrap();
        assert_eq!(validity_bits(&e, n) & vbits::CANDIDATE, 0);
    }

    #[test]
    fn set_range_text_and_textarea() {
        let (mut e, doc) = setup();
        let t = el(&mut e, doc, atom::TEXTAREA);
        e.value_set(t, "a😀b").unwrap();
        assert_eq!(e.selection(t), Some((4, 4, 0)));
        e.set_selection(t, 1, 3, 1).unwrap();
        e.set_range_text(t, "XY", 0, 0, 0, false).unwrap();
        assert_eq!(val(&e, t), "aXYb");
        assert_eq!(e.selection(t), Some((1, 3, 0)));
    }
}
