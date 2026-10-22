//! Element state (DESIGN §19): the HTML predicates over form controls and `<details>` / `<summary>` that
//! more than one consumer asks, with one implementation each. The consumers are selector matching
//! (`select/adapter.rs`), the forms algorithms (`forms/mod.rs`), focusability (`focus.rs`) and the facade
//! (the natives at the bottom of this file, and the input-type table build.rs generates from
//! `types::TYPE_NAMES` into `lib/generated/input-types.cjs`).
//!
//! Where jsdom itself answers one question two ways, both answers live here under their own names, each
//! citing its source:
//! - disabled: [`is_disabled`] (`helpers/form-controls.js` `isDisabled`: focus, activation, form
//!   submission and validation) and [`matches_disabled`] (dom-selector's `:disabled`, which also covers
//!   `<option>`, `<optgroup>` and `<fieldset>` itself). Both share the fieldset / legend rule.
//! - validity: [`validity_bits`] (`validity.valid` and the `ValidityState` bits) and [`matches_valid`]
//!   (dom-selector's `:valid` / `:invalid`, which replaces that answer with a `maxlength` / `minlength`
//!   length check).
//! - submit buttons: [`is_submit_button`] (the normalized `type`) and [`is_default_button_candidate`]
//!   (dom-selector's `:default`, which compares the raw `type` attribute case-sensitively).
//!
//! Every function only reads the tree (`&Env`). Paths cite jsdom 30.1.3 (`refs/jsdom/lib/jsdom/living/...`)
//! and @asamuzakjp/dom-selector 10 (`node_modules/@asamuzakjp/dom-selector/src/js/pseudo-class.js`).

use super::types::{self, Mode, ty};
use super::{FormState, attr, form_state, has, is_input, raw, st, vbits};
use crate::atoms::{Atom, atom};
use crate::env::Env;
use crate::node::{kind, meta, state};
use crate::table::NodeId;

#[inline]
fn is_html_element(e: &Env, id: NodeId) -> bool {
    e.rec(id).meta & (meta::KIND_MASK | meta::NS_MASK) == kind::ELEMENT
}

// ================================================================================== input types

/// Normalized type of an `<input>` (`input.type` as a [`ty`] code), read from the state bits that the
/// attribute-change, parser and cloning steps keep in step with the null-namespace `type` attribute.
/// Elements other than inputs read as [`ty::TEXT`].
#[inline]
pub fn input_type(e: &Env, id: NodeId) -> u32 {
    (st(e, id) & state::INPUT_TYPE_MASK) >> state::INPUT_TYPE_SHIFT
}

/// `input.type` as a string (`types::TYPE_NAMES`).
#[inline]
pub fn input_type_name(e: &Env, id: NodeId) -> &'static str {
    types::TYPE_NAMES[input_type(e, id) as usize]
}

/// `button.type` as a [`ty`] code: submit unless the attribute is reset / button (ASCII case-insensitive).
pub fn button_type(e: &Env, id: NodeId) -> u32 {
    match attr(e, id, atom::TYPE) {
        Some(v) if v.eq_ignore_ascii_case("reset") => ty::RESET,
        Some(v) if v.eq_ignore_ascii_case("button") => ty::BUTTON,
        _ => ty::SUBMIT,
    }
}

// ====================================================================================== buttons

/// HTML "button" category (`helpers/form-controls.js` `isButton`): `<button>`, and inputs of type submit,
/// image, reset or button.
pub fn is_button(e: &Env, id: NodeId) -> bool {
    e.is_html_elem(id, atom::BUTTON)
        || (is_input(e, id) && matches!(input_type(e, id), ty::SUBMIT | ty::IMAGE | ty::RESET | ty::BUTTON))
}

/// HTML "submit button" (`helpers/form-controls.js` `isSubmitButton`): inputs of type submit / image,
/// `<button>` of type submit.
pub fn is_submit_button(e: &Env, id: NodeId) -> bool {
    if is_input(e, id) {
        return matches!(input_type(e, id), ty::SUBMIT | ty::IMAGE);
    }
    e.is_html_elem(id, atom::BUTTON) && button_type(e, id) == ty::SUBMIT
}

/// dom-selector's `:default` button test (`#matchDefaultPseudoClass`): `<button>` unless its RAW `type`
/// is exactly `reset` / `button`; `<input>` whose raw `type` is exactly `image` / `submit`. Unlike
/// [`is_submit_button`], `<input type=SUBMIT>` is not a candidate.
pub fn is_default_button_candidate(e: &Env, id: NodeId) -> bool {
    let raw_type = || e.get_attr(id, atom::TYPE).map(|s| s.as_str());
    if e.is_html_elem(id, atom::BUTTON) {
        return !matches!(raw_type(), Some("reset" | "button"));
    }
    is_input(e, id) && matches!(raw_type(), Some("image" | "submit"))
}

// ===================================================================================== disabled

/// The fieldset part of "actually disabled": a `<fieldset disabled>` ancestor disables `id` unless `id` is
/// inside that fieldset's first `<legend>` child (jsdom: `!firstLegendElementChild.contains(control)`;
/// the legend contains `id` exactly when it is the fieldset's child on the path up from `id`).
fn in_disabled_fieldset(e: &Env, id: NodeId) -> bool {
    let mut child = id;
    let mut p = e.rec(id).parent;
    while p != 0 {
        let pr = e.rec(p);
        if pr.meta & meta::DISABLED_ATTR != 0
            && e.is_html_elem(p, atom::FIELDSET)
            && first_child(e, p, atom::LEGEND) != child
        {
            return true;
        }
        child = p;
        p = pr.parent;
    }
    false
}

/// The first HTML element child of `p` with local name `local` (jsdom `firstChildWithLocalName`, whose
/// namespace defaults to HTML); 0 if none.
fn first_child(e: &Env, p: NodeId, local: Atom) -> NodeId {
    let mut c = e.rec(p).first;
    while c != 0 && !e.is_html_elem(c, local) {
        c = e.rec(c).next;
    }
    c
}

/// HTML "actually disabled" as jsdom's `isDisabled` (`helpers/form-controls.js`): an own `disabled` on
/// button / input / select / textarea, or [the fieldset rule](in_disabled_fieldset) for any element. Used
/// by focusability, `click()`, activation, constraint validation and the form entry list.
pub fn is_disabled(e: &Env, id: NodeId) -> bool {
    let r = e.rec(id);
    if r.meta & meta::DISABLED_ATTR != 0
        && is_html_element(e, id)
        && matches!(Atom(r.local), atom::BUTTON | atom::INPUT | atom::SELECT | atom::TEXTAREA)
    {
        return true;
    }
    in_disabled_fieldset(e, id)
}

/// dom-selector's `:disabled` (`#matchDisabledPseudoClass`), over a wider set of elements than
/// [`is_disabled`]: an own `disabled` on button / input / select / textarea / optgroup / option /
/// fieldset; an `<option>` in a disabled `<optgroup>`; the fieldset rule for every listed element except
/// option and optgroup. `:enabled` is its negation over the same elements.
pub fn matches_disabled(e: &Env, id: NodeId) -> bool {
    let r = e.rec(id);
    if !is_html_element(e, id) {
        return false;
    }
    let own = r.meta & meta::DISABLED_ATTR != 0;
    match Atom(r.local) {
        atom::OPTION => {
            own || (e.is_html_elem(r.parent, atom::OPTGROUP)
                && e.rec(r.parent).meta & meta::DISABLED_ATTR != 0)
        }
        atom::OPTGROUP => own,
        atom::BUTTON | atom::INPUT | atom::SELECT | atom::TEXTAREA | atom::FIELDSET => {
            own || in_disabled_fieldset(e, id)
        }
        _ => false,
    }
}

/// Elements `:disabled` / `:enabled` can match (dom-selector `KEYS_FORM_PS_DISABLED`).
pub fn is_disableable(e: &Env, id: NodeId) -> bool {
    is_html_element(e, id)
        && matches!(
            Atom(e.rec(id).local),
            atom::BUTTON
                | atom::INPUT
                | atom::SELECT
                | atom::TEXTAREA
                | atom::OPTGROUP
                | atom::OPTION
                | atom::FIELDSET
        )
}

// ============================================================================== details / summary

/// HTML "summary for its parent details" (`helpers/details.js`): an HTML `<summary>` that is the first
/// HTML `<summary>` child of an HTML `<details>`. Decides `summary.tabIndex`'s default, focusability and the
/// summary's activation behaviour (toggling `open`).
pub fn is_summary_for_parent_details(e: &Env, id: NodeId) -> bool {
    if !e.is_html_elem(id, atom::SUMMARY) {
        return false;
    }
    let p = e.rec(id).parent;
    e.is_html_elem(p, atom::DETAILS) && first_child(e, p, atom::SUMMARY) == id
}

// ====================================================================================== parsing

/// HTML "rules for parsing non-negative integers", as jsdom's `parseNonNegativeInteger`
/// (`helpers/strings.js`): leading ASCII whitespace, an optional sign, then at least one digit; `-0` is 0,
/// any other negative is an error. Values saturate at `u32::MAX` (jsdom keeps the double; every consumer
/// only compares it).
pub fn parse_non_negative_integer(v: &str) -> Option<u32> {
    let t = v.trim_start_matches(['\t', '\n', '\x0c', '\r', ' ']);
    let (neg, t) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let end = t.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(t.len());
    if end == 0 {
        return None;
    }
    let n = t[..end].bytes().fold(0u64, |acc, b| (acc * 10 + u64::from(b - b'0')).min(u64::from(u32::MAX)));
    if neg && n != 0 { None } else { Some(n as u32) }
}

/// `maxLength` / `minLength`: the attribute parsed as a non-negative integer that fits a `long` (jsdom's
/// generated reflection: anything else reflects as -1, here None).
fn length_limit(e: &Env, id: NodeId, a: Atom) -> Option<u32> {
    attr(e, id, a).and_then(parse_non_negative_integer).filter(|&n| n <= i32::MAX as u32)
}

// ===================================================================================== validity

/// Inside a `<datalist>` (barred from constraint validation and from the form entry list; jsdom
/// `closest(field, "datalist")`).
pub fn has_datalist_ancestor(e: &Env, id: NodeId) -> bool {
    let mut p = e.rec(id).parent;
    while p != 0 {
        if e.is_html_elem(p, atom::DATALIST) {
            return true;
        }
        p = e.rec(p).parent;
    }
    false
}

/// Candidate for constraint validation (`willValidate`).
fn is_candidate(e: &Env, id: NodeId) -> bool {
    let r = e.rec(id);
    if r.meta & (meta::KIND_MASK | meta::NS_MASK) != kind::ELEMENT {
        return false;
    }
    let barred = match Atom(r.local) {
        atom::INPUT => {
            let t = input_type(e, id);
            matches!(t, ty::HIDDEN | ty::RESET | ty::BUTTON)
                || (types::readonly_applies(t) && has(e, id, atom::READONLY))
        }
        atom::TEXTAREA | atom::SELECT => has(e, id, atom::READONLY),
        atom::BUTTON => button_type(e, id) != ty::SUBMIT,
        _ => true,
    };
    !barred && !is_disabled(e, id) && !has_datalist_ancestor(e, id)
}

fn input_mutable(e: &Env, id: NodeId, t: u32) -> bool {
    !is_disabled(e, id) && !(types::readonly_applies(t) && has(e, id, atom::READONLY))
}

fn input_required(e: &Env, id: NodeId) -> bool {
    is_input(e, id) && types::required_applies(input_type(e, id)) && has(e, id, atom::REQUIRED)
}

fn input_validity(e: &Env, id: NodeId) -> u32 {
    use vbits::*;
    let t = input_type(e, id);
    let v = raw(e, id);
    let mut b = 0;
    let required = input_required(e, id);
    if required && types::mode(t) == Mode::Value && input_mutable(e, id, t) && v.is_empty() {
        b |= VALUE_MISSING;
    }
    match t {
        ty::CHECKBOX if required && st(e, id) & state::CHECKED == 0 => b |= VALUE_MISSING,
        ty::RADIO => {
            let others = e.radio_group_others(id, false);
            let any_req = required || others.iter().any(|&o| input_required(e, o));
            let any_checked =
                st(e, id) & state::CHECKED != 0 || others.iter().any(|&o| st(e, o) & state::CHECKED != 0);
            if any_req && !any_checked {
                b |= VALUE_MISSING;
            }
        }
        ty::FILE if required => b |= CHECK_FILES,
        ty::EMAIL if !v.is_empty() => {
            let ok = if has(e, id, atom::MULTIPLE) {
                types::is_valid_email_list(v)
            } else {
                types::is_valid_email(v)
            };
            if !ok {
                b |= TYPE_MISMATCH;
            }
        }
        ty::URL if !v.is_empty() => b |= CHECK_URL,
        _ => {}
    }
    if !v.is_empty() && types::length_pattern_applies(t) && has(e, id, atom::PATTERN) {
        b |= CHECK_PATTERN;
    }
    if types::is_numeric(t) {
        let (dmin, dmax) = types::default_min_max(t);
        let num = |a| attr(e, id, a).and_then(|s| types::to_number(t, s));
        let min = num(atom::MIN).or(dmin);
        let max = num(atom::MAX).or(dmax);
        if let Some(x) = types::to_number(t, v) {
            let reversed = t == ty::TIME && matches!((min, max), (Some(lo), Some(hi)) if hi < lo);
            if reversed {
                if let (Some(lo), Some(hi)) = (min, max) {
                    if x > hi && x < lo {
                        b |= RANGE_OVERFLOW | RANGE_UNDERFLOW;
                    }
                }
            } else {
                if max.is_some_and(|m| x > m) {
                    b |= RANGE_OVERFLOW;
                }
                if min.is_some_and(|m| x < m) {
                    b |= RANGE_UNDERFLOW;
                }
            }
            if let Some(step) = allowed_step(e, id, t) {
                let base = num(atom::MIN).or_else(|| num(atom::VALUE)).unwrap_or(if t == ty::WEEK {
                    -259_200_000.0
                } else {
                    0.0
                });
                let q = (x - base) / step;
                if (q - q.round()).abs() > 1e-9 * q.abs().max(1.0) {
                    b |= STEP_MISMATCH;
                }
            }
        }
    }
    b
}

/// Allowed value step (None = "any" / not applicable).
fn allowed_step(e: &Env, id: NodeId, t: u32) -> Option<f64> {
    if !types::is_numeric(t) {
        return None;
    }
    let (scale, dflt) = types::step_scale(t);
    match attr(e, id, atom::STEP) {
        None => Some(dflt * scale),
        Some(s) if s.eq_ignore_ascii_case("any") => None,
        Some(s) => match types::parse_float(s) {
            Some(v) if v > 0.0 => Some(v * scale),
            _ => Some(dflt * scale),
        },
    }
}

/// Validity bits (see [`vbits`]) of a form-associated element: what `validity` / `checkValidity()` report.
/// The ECMAScript parts (pattern, URL parsing, the FileList) come back as `CHECK_*` bits for the facade.
pub fn validity_bits(e: &Env, id: NodeId) -> u32 {
    use vbits::*;
    let r = e.rec(id);
    if r.meta & (meta::KIND_MASK | meta::NS_MASK) != kind::ELEMENT {
        return 0;
    }
    let mut b = match Atom(r.local) {
        atom::INPUT => input_validity(e, id),
        atom::TEXTAREA => {
            let mut v = String::new();
            e.value_into(id, &mut v);
            let mutable = !is_disabled(e, id) && !has(e, id, atom::READONLY);
            if has(e, id, atom::REQUIRED) && mutable && v.is_empty() { VALUE_MISSING } else { 0 }
        }
        atom::SELECT if has(e, id, atom::REQUIRED) => {
            let i = e.selected_index(id);
            let placeholder = !has(e, id, atom::MULTIPLE) && e.display_size(id) == 1 && {
                let opts = e.options_of(id);
                opts.first().is_some_and(|&o| {
                    let mut v = String::new();
                    e.option_value_into(o, &mut v);
                    v.is_empty() && !e.is_html_elem(e.rec(o).parent, atom::OPTGROUP)
                })
            };
            if i < 0 || (i == 0 && placeholder) { VALUE_MISSING } else { 0 }
        }
        _ => 0,
    };
    if form_state(e, id).is_some_and(|f: &FormState| !f.custom.is_empty()) {
        b |= CUSTOM_ERROR;
    }
    if is_candidate(e, id) {
        b |= CANDIDATE;
    }
    b
}

/// Failure bits of [`validity_bits`] (`validity.valid` is `validity & FAIL_MASK == 0` once the facade added its
/// `CHECK_*` parts).
pub const FAIL_MASK: u32 = vbits::VALUE_MISSING
    | vbits::TYPE_MISMATCH
    | vbits::PATTERN_MISMATCH
    | vbits::TOO_LONG
    | vbits::TOO_SHORT
    | vbits::RANGE_UNDERFLOW
    | vbits::RANGE_OVERFLOW
    | vbits::STEP_MISMATCH
    | vbits::BAD_INPUT
    | vbits::CUSTOM_ERROR;

/// dom-selector's `:in-range` / `:out-of-range` for an HTML `<input>` (`matchRangePseudoClass`): no `readonly`
/// or `disabled` attribute (the attributes alone, not a disabled fieldset), a raw `type` attribute (compared
/// case-sensitively) of date, datetime-local, month, time, week, number or range, then the range bits of
/// [`validity_bits`]: out of range when underflowing or overflowing, in range when neither and `min` or `max` is
/// set or the type is range.
pub fn matches_in_range(e: &Env, id: NodeId, out: bool) -> bool {
    if has(e, id, atom::READONLY) || has(e, id, atom::DISABLED) {
        return false;
    }
    let Some(t) = attr(e, id, atom::TYPE) else { return false };
    if !matches!(t, "date" | "datetime-local" | "month" | "time" | "week" | "number" | "range") {
        return false;
    }
    let range = t == "range";
    let flowed = validity_bits(e, id) & (vbits::RANGE_UNDERFLOW | vbits::RANGE_OVERFLOW) != 0;
    if out {
        return flowed;
    }
    !flowed && (has(e, id, atom::MIN) || has(e, id, atom::MAX) || range)
}

/// dom-selector's `:valid` / `:invalid` for one button / input / select / textarea
/// (`#matchValidityPseudoClass`): `validity.valid`, then for a non-negative `maxLength` the answer is
/// REPLACED by `maxLength >= value.length`, and a valid result is further checked against a
/// non-negative `minLength`. jsdom's `validity` never reports tooLong / tooShort (only user edits make a
/// control too long), so `:invalid` and `validity.valid` disagree there, in jsdom as here.
///
/// The `CHECK_*` parts of [`validity_bits`] need ECMAScript (Rust never calls into JS, CONTRIBUTING §7) and count
/// as passing here: `:invalid` misses patternMismatch and the URL typeMismatch (documented divergence).
pub fn matches_valid(e: &Env, id: NodeId) -> bool {
    let mut valid = validity_bits(e, id) & FAIL_MASK == 0;
    // `maxLength` / `minLength` are only reflected by input and textarea (undefined, i.e. never >= 0,
    // elsewhere).
    if e.is_html_elem(id, atom::INPUT) || e.is_html_elem(id, atom::TEXTAREA) {
        let (max, min) = (length_limit(e, id, atom::MAXLENGTH), length_limit(e, id, atom::MINLENGTH));
        if max.is_some() || min.is_some() {
            let len = e.value_len16(id);
            if let Some(max) = max {
                valid = max >= len;
            }
            if valid && let Some(min) = min {
                valid = min <= len;
            }
        }
    }
    valid
}

/// dom-selector's `:valid` / `:invalid` for `<form>` / `<fieldset>`: every descendant button / input /
/// select / textarea [`matches_valid`].
pub fn subtree_matches_valid(e: &Env, root: NodeId) -> bool {
    let mut n = e.next_in_subtree(root, root);
    while n != 0 {
        let r = e.rec(n);
        if r.meta & (meta::KIND_MASK | meta::NS_MASK) == kind::ELEMENT
            && matches!(Atom(r.local), atom::BUTTON | atom::INPUT | atom::SELECT | atom::TEXTAREA)
            && !matches_valid(e, n)
        {
            return false;
        }
        n = e.next_in_subtree(n, root);
    }
    true
}

natives! {
    /// jsdom isDisabled (own disabled attribute of form controls or a disabled fieldset ancestor).
    fn isDisabled(e, id: u32) -> bool {
        is_disabled(e, id)
    }
    /// Validity bits (forms::vbits).
    fn validity(e, id: u32) -> u32 {
        validity_bits(e, id)
    }
    /// button.type as an input type code (18 submit, 20 reset, 21 button).
    fn buttonType(e, id: u32) -> u32 {
        button_type(e, id)
    }
    /// HTML "submit button": input type submit / image, button type submit.
    fn isSubmitButton(e, id: u32) -> bool {
        is_submit_button(e, id)
    }
    /// HTML "summary for its parent details" (tabIndex default, focusability, activation).
    fn isSummaryForDetails(e, id: u32) -> bool {
        is_summary_for_parent_details(e, id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::DocKind;

    fn setup(html: &str) -> Env {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        e.main_doc = doc;
        let body = e.rec(e.rec(doc).last).last;
        e.set_inner_html(body, html).unwrap();
        e
    }

    fn id(e: &Env, name: &str) -> NodeId {
        let a = e.atoms.get(name).unwrap_or_else(|| panic!("no element #{name}"));
        let n = e.get_element_by_id(e.main_doc, a);
        assert_ne!(n, 0, "no element #{name}");
        n
    }

    #[test]
    fn input_types_follow_the_attribute() {
        let mut e = setup(
            "<input id=a type=CheckBox><input id=b type=nonsense><input id=c><input id=d type=datetime-local>",
        );
        assert_eq!(input_type(&e, id(&e, "a")), ty::CHECKBOX);
        assert_eq!(input_type_name(&e, id(&e, "b")), "text");
        assert_eq!(input_type_name(&e, id(&e, "c")), "text");
        assert_eq!(input_type_name(&e, id(&e, "d")), "datetime-local");
        let c = id(&e, "c");
        e.set_attr(c, atom::TYPE, "RADIO").unwrap();
        assert_eq!(input_type(&e, c), ty::RADIO);
        let doc = e.main_doc;
        let dup = e.clone_node(c, doc, false).unwrap();
        assert_eq!(input_type(&e, dup), ty::RADIO);
    }

    #[test]
    fn type_names_match_codes() {
        for (i, n) in types::TYPE_NAMES.iter().enumerate() {
            assert_eq!(types::parse_type(Some(n)), i as u32, "{n}");
            assert_eq!(types::parse_type(Some(&n.to_ascii_uppercase())), i as u32, "{n}");
        }
        assert_eq!(types::TYPE_NAMES[ty::DATETIME_LOCAL as usize], "datetime-local");
        assert_eq!(types::TYPE_NAMES[ty::BUTTON as usize], "button");
    }

    #[test]
    fn disabled_fieldset_and_legend() {
        let e = setup(
            "<fieldset id=f disabled><legend id=l><input id=in-legend></legend><legend><input id=in-second></legend>\
             <input id=plain><select id=s><optgroup id=g disabled><option id=og>x</optgroup><option id=o>y</select>\
             <a id=link href=#>a</a></fieldset><fieldset id=nested-ok><input id=free></fieldset>\
             <select><optgroup disabled><option id=solo-og>z</optgroup><option id=solo disabled>w</select>",
        );
        let d = |n| is_disabled(&e, id(&e, n));
        let m = |n| matches_disabled(&e, id(&e, n));
        // jsdom isDisabled: the fieldset rule applies to every element, own disabled only to the four controls
        assert!(!d("in-legend"));
        assert!(d("in-second"));
        assert!(d("plain") && d("s") && d("o") && d("link"));
        assert!(!d("f"), "fieldset's own disabled is not isDisabled");
        assert!(!d("free"));
        assert!(!d("solo"), "option's own disabled is not isDisabled");
        // dom-selector :disabled: options follow their optgroup only, fieldsets their own attribute too
        assert!(!m("in-legend"));
        assert!(m("in-second") && m("plain") && m("s") && m("f"));
        assert!(!m("o"), "option in a disabled fieldset is :enabled");
        assert!(m("og") && m("g") && m("solo") && m("solo-og"));
        assert!(!m("link") && !is_disableable(&e, id(&e, "link")));
    }

    #[test]
    fn submit_buttons() {
        let e = setup(
            "<input id=s type=SUBMIT><input id=i type=image><input id=r type=reset><input id=t>\
             <button id=b>b</button><button id=br type=Reset>r</button><button id=bb type=button>x</button>\
             <button id=bx type=bogus>x</button>",
        );
        let sb = |n| is_submit_button(&e, id(&e, n));
        assert!(sb("s") && sb("i") && sb("b") && sb("bx"));
        assert!(!sb("r") && !sb("t") && !sb("br") && !sb("bb"));
        assert!(is_button(&e, id(&e, "r")) && is_button(&e, id(&e, "bb")) && !is_button(&e, id(&e, "t")));
        assert_eq!(button_type(&e, id(&e, "br")), ty::RESET);
        // :default compares the raw type case-sensitively
        let dc = |n| is_default_button_candidate(&e, id(&e, n));
        assert!(!dc("s"), "type=SUBMIT is not a :default candidate");
        assert!(dc("i") && dc("b") && dc("br") && dc("bx"));
        assert!(!dc("bb") && !dc("r"));
    }

    #[test]
    fn summary_for_parent_details() {
        let mut e = setup(
            "<details id=d><summary id=a>a</summary><summary id=b>b</summary></details><summary id=c>c</summary>",
        );
        assert!(is_summary_for_parent_details(&e, id(&e, "a")));
        assert!(!is_summary_for_parent_details(&e, id(&e, "b")));
        assert!(!is_summary_for_parent_details(&e, id(&e, "c")));
        // a non-HTML <summary> before it does not count (firstChildWithLocalName is HTML-only)
        let d = id(&e, "d");
        let doc = e.main_doc;
        let x = e.create_element(doc, atom::SUMMARY, crate::node::Ns::Svg);
        let a = id(&e, "a");
        e.pre_insert(x, d, a).unwrap();
        assert!(is_summary_for_parent_details(&e, a));
    }

    #[test]
    fn non_negative_integers() {
        let p = parse_non_negative_integer;
        assert_eq!(p("0"), Some(0));
        assert_eq!(p("  \t\n+42abc"), Some(42));
        assert_eq!(p("-0"), Some(0));
        assert_eq!(p("-000"), Some(0));
        assert_eq!(p("-1"), None);
        assert_eq!(p(""), None);
        assert_eq!(p("+"), None);
        assert_eq!(p("+-1"), None);
        assert_eq!(p("\u{a0}1"), None, "only ASCII whitespace is skipped");
        assert_eq!(p("4294967296"), Some(u32::MAX));
        assert_eq!(p("99999999999999999999999999"), Some(u32::MAX));
    }

    #[test]
    fn validity_vs_selector_validity() {
        let e = setup(
            "<input id=req required><input id=long maxlength=1 value=ab><input id=zero maxlength=-0 value=a>\
             <input id=huge maxlength=2147483648 value=abc><textarea id=short minlength=3>ab</textarea>\
             <input id=num type=number min=5 value=3><datalist><input id=dl required></datalist>\
             <form id=f><input id=ok></form><fieldset id=fs><input maxlength=0 value=x></fieldset>",
        );
        let v = |n| validity_bits(&e, id(&e, n));
        let sel = |n| matches_valid(&e, id(&e, n));
        assert_ne!(v("req") & vbits::VALUE_MISSING, 0);
        assert!(!sel("req"));
        // validity never reports tooLong / tooShort; :valid applies the length limits
        assert_eq!(v("long") & FAIL_MASK, 0);
        assert!(!sel("long"));
        assert!(!sel("zero"), "maxlength=-0 is 0");
        assert!(sel("huge"), "maxlength beyond a long reflects as -1");
        assert_eq!(v("short") & FAIL_MASK, 0);
        assert!(!sel("short"));
        assert_ne!(v("num") & vbits::RANGE_UNDERFLOW, 0);
        assert_eq!(v("dl") & vbits::CANDIDATE, 0, "datalist descendants are barred");
        assert!(has_datalist_ancestor(&e, id(&e, "dl")));
        assert_ne!(v("ok") & vbits::CANDIDATE, 0);
        assert!(subtree_matches_valid(&e, id(&e, "f")));
        assert!(!subtree_matches_valid(&e, id(&e, "fs")));
    }
}
