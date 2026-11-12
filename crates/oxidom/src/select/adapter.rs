//! `selectors` 0.41 adapter: the `SelectorImpl` (atoms are oxidom `Atom`s), the parser (pseudo-classes and
//! pseudo-elements oxidom understands) and the `Element` implementation over the arena (`ERef`).
//!
//! Names in selectors are interned into the env's atom table while parsing, so matching compares u32s
//! (`has_local_name`, `has_class`, `has_id`). `selectors` builds names through `From<&str>` without any
//! context, so [`with_interner`] moves the env's `Interner` into a thread-local for the duration of one
//! parse and moves it back afterwards (no `unsafe`, no shared mutable state across envs: a napi_env never
//! runs on two threads at once and the slot is empty outside a parse).

use std::borrow::Borrow;
use std::cell::RefCell;
use std::fmt;
use std::ptr::NonNull;

use cssparser::{CowRcStr, ParseError, Parser as CssParser, ToCss};
use precomputed_hash::PrecomputedHash;
use selectors::attr::{AttrSelectorOperation, CaseSensitivity, NamespaceConstraint};
use selectors::bloom::BloomFilter;
use selectors::context::{MatchingContext, QuirksMode};
use selectors::matching::ElementSelectorFlags;
use selectors::parser::{NonTSPseudoClass, PseudoElement, SelectorImpl, SelectorParseErrorKind};
use selectors::{Element, OpaqueElement};

use crate::atoms::{Atom, Interner, atom};
use crate::env::Env;
use crate::forms::element_state;
use crate::node::{Quirks, kind, meta, state};
use crate::table::NodeId;

// ------------------------------------------------------------------------------------- interning

thread_local! {
    /// The interner of the env whose selector is being parsed (only during [`with_interner`]).
    static INTERNER: RefCell<Option<Interner>> = const { RefCell::new(None) };
}

/// Runs `f` with `interner` installed as the thread's parse interner, restoring it afterwards (also when
/// `f` panics: the guard's `Drop` moves the interner back).
pub(crate) fn with_interner<R>(interner: &mut Interner, f: impl FnOnce() -> R) -> R {
    struct Guard<'a>(&'a mut Interner);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            if let Some(i) = INTERNER.with(|t| t.borrow_mut().take()) {
                *self.0 = i;
            }
        }
    }
    let taken = std::mem::take(interner);
    INTERNER.with(|t| *t.borrow_mut() = Some(taken));
    let _g = Guard(interner);
    f()
}

/// Interns `s` in the installed interner. Outside a parse (never expected) only static atoms resolve.
pub(crate) fn tls_intern(s: &str) -> Atom {
    INTERNER.with(|t| match t.borrow_mut().as_mut() {
        Some(i) => i.intern(s),
        None => Interner::new().get(s).unwrap_or(Atom::NONE),
    })
}

fn tls_name(a: Atom, dest: &mut impl fmt::Write) -> fmt::Result {
    INTERNER.with(|t| match t.borrow().as_ref() {
        Some(i) => cssparser::serialize_identifier(i.name(a), dest),
        None => {
            let s = Interner::new();
            let n = s.name(a);
            if n.is_empty() { write!(dest, "atom{}", a.0) } else { cssparser::serialize_identifier(n, dest) }
        }
    })
}

// ----------------------------------------------------------------------------------------- types

/// An atom as a selector name (local names, ids, classes, namespace URIs).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default, Debug)]
pub struct SAtom(pub Atom);

impl PrecomputedHash for SAtom {
    #[inline]
    fn precomputed_hash(&self) -> u32 {
        // Atom ids are dense small integers: spread them for the selectors bloom filter.
        self.0.0.wrapping_mul(0x9E37_79B9)
    }
}

impl<'a> From<&'a str> for SAtom {
    fn from(s: &'a str) -> Self {
        SAtom(tls_intern(s))
    }
}

impl ToCss for SAtom {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        tls_name(self.0, dest)
    }
}

/// An attribute value in a selector (never interned: values are arbitrary).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct SVal(pub Box<str>);

impl<'a> From<&'a str> for SVal {
    fn from(s: &'a str) -> Self {
        SVal(s.into())
    }
}

impl AsRef<str> for SVal {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl ToCss for SVal {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        cssparser::serialize_string(&self.0, dest)
    }
}

/// Non-tree-structural pseudo-classes oxidom understands (DESIGN §6.1). `Never*` variants are accepted
/// (jsdom accepts them too) and never match: no user interaction state, no layout, no media.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum PseudoClass {
    /// `:checked` (input checkedness / option selectedness: `NodeRec.state` bits, area B)
    Checked,
    /// `:disabled`
    Disabled,
    /// `:enabled`
    Enabled,
    /// `:focus` (`state::FOCUSED`, area B)
    Focus,
    /// `:focus-within`
    FocusWithin,
    /// `:focus-visible` (= `:focus`, DESIGN §6.1)
    FocusVisible,
    /// `:required`
    Required,
    /// `:optional`
    Optional,
    /// `:read-only`
    ReadOnly,
    /// `:read-write`
    ReadWrite,
    /// `:placeholder-shown`
    PlaceholderShown,
    /// `:indeterminate`
    Indeterminate,
    /// `:default`
    Default,
    /// `:link`
    Link,
    /// `:any-link`
    AnyLink,
    /// `:defined`
    Defined,
    /// `:open` (details / dialog with `open`)
    Open,
    /// `:in-range`
    InRange,
    /// `:out-of-range`
    OutOfRange,
    /// `:valid`
    Valid,
    /// `:invalid`
    Invalid,
    /// `:lang(...)`
    Lang(Box<[Box<str>]>),
    /// `:dir(ltr)` (Some(false)) / `:dir(rtl)` (Some(true)); any other identifier is valid and never
    /// matches (None, the identifier kept for serialization)
    Dir(Option<bool>, Box<str>),
    /// `:heading` (None) / `:heading(levels)`: HTML `h1`-`h6`, by the level in the name
    Heading(Option<Box<[i32]>>),
    /// a pseudo-class that never matches in oxidom (`:hover`, `:visited`, `:target`, ...); index into
    /// [`NEVER_MATCHING`]
    Never(u8),
}

/// Pseudo-classes that parse but never match (no interaction / media / navigation state).
pub const NEVER_MATCHING: &[&str] = &[
    "hover",
    "active",
    "visited",
    "target",
    "modal",
    "popover-open",
    "autofill",
    "-webkit-autofill",
    "user-invalid",
    "user-valid",
    "blank",
    "current",
    "past",
    "future",
    "playing",
    "paused",
    "fullscreen",
    "local-link",
    "muted",
    "picture-in-picture",
    "seeking",
    "stalled",
    "buffering",
    "volume-locked",
    "host",
    "target-current",
    "-moz-focusring",
];

impl ToCss for PseudoClass {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        let s = match self {
            PseudoClass::Checked => ":checked",
            PseudoClass::Disabled => ":disabled",
            PseudoClass::Enabled => ":enabled",
            PseudoClass::Focus => ":focus",
            PseudoClass::FocusWithin => ":focus-within",
            PseudoClass::FocusVisible => ":focus-visible",
            PseudoClass::Required => ":required",
            PseudoClass::Optional => ":optional",
            PseudoClass::ReadOnly => ":read-only",
            PseudoClass::ReadWrite => ":read-write",
            PseudoClass::PlaceholderShown => ":placeholder-shown",
            PseudoClass::Indeterminate => ":indeterminate",
            PseudoClass::Default => ":default",
            PseudoClass::Link => ":link",
            PseudoClass::AnyLink => ":any-link",
            PseudoClass::Defined => ":defined",
            PseudoClass::Open => ":open",
            PseudoClass::InRange => ":in-range",
            PseudoClass::OutOfRange => ":out-of-range",
            PseudoClass::Valid => ":valid",
            PseudoClass::Invalid => ":invalid",
            PseudoClass::Lang(l) => {
                dest.write_str(":lang(")?;
                for (i, x) in l.iter().enumerate() {
                    if i > 0 {
                        dest.write_str(", ")?;
                    }
                    cssparser::serialize_identifier(x, dest)?;
                }
                return dest.write_str(")");
            }
            PseudoClass::Dir(_, ident) => {
                dest.write_str(":dir(")?;
                cssparser::serialize_identifier(ident, dest)?;
                return dest.write_str(")");
            }
            PseudoClass::Heading(None) => ":heading",
            PseudoClass::Heading(Some(levels)) => {
                dest.write_str(":heading(")?;
                for (i, x) in levels.iter().enumerate() {
                    if i > 0 {
                        dest.write_str(", ")?;
                    }
                    write!(dest, "{x}")?;
                }
                return dest.write_str(")");
            }
            PseudoClass::Never(i) => {
                dest.write_str(":")?;
                return dest.write_str(NEVER_MATCHING.get(*i as usize).copied().unwrap_or("never"));
            }
        };
        dest.write_str(s)
    }
}

impl NonTSPseudoClass for PseudoClass {
    fn is_active_or_hover(&self) -> bool {
        matches!(self, PseudoClass::Never(i) if *i <= 1)
    }

    fn is_user_action_state(&self) -> bool {
        matches!(self, PseudoClass::Focus | PseudoClass::FocusWithin | PseudoClass::FocusVisible)
            || self.is_active_or_hover()
    }
}

impl PseudoClass {
    /// True if matching reads mutable non-attribute state (form state bits, focus, values): the qSA memo
    /// must then also validate against `EP[REC]` / `EP[FORM]`.
    pub fn uses_state(&self) -> bool {
        matches!(
            self,
            PseudoClass::Checked
                | PseudoClass::Focus
                | PseudoClass::FocusWithin
                | PseudoClass::FocusVisible
                | PseudoClass::PlaceholderShown
                | PseudoClass::Indeterminate
                | PseudoClass::InRange
                | PseudoClass::OutOfRange
                | PseudoClass::Valid
                | PseudoClass::Invalid
                | PseudoClass::Dir(..)
                | PseudoClass::Defined
        )
    }

    /// Attributes (no namespace; `:lang` also reads `xml:lang`) whose value this pseudo-class reads
    /// besides `type` (always a STYLE invalidation) and the tree. Author sheets add them to their
    /// invalidation set, so an attribute write invalidates the computed-style memo even when no state
    /// pseudo-class is in use (M9 review: `b.disabled = true` left `button:disabled` styles stale).
    pub fn attr_deps(&self) -> &'static [Atom] {
        match self {
            PseudoClass::Disabled | PseudoClass::Enabled => &[atom::DISABLED],
            PseudoClass::Required | PseudoClass::Optional => &[atom::REQUIRED],
            PseudoClass::ReadOnly | PseudoClass::ReadWrite => {
                &[atom::READONLY, atom::DISABLED, atom::CONTENTEDITABLE]
            }
            PseudoClass::PlaceholderShown => &[atom::PLACEHOLDER, atom::VALUE],
            PseudoClass::Indeterminate => &[atom::VALUE, atom::CHECKED, atom::NAME],
            PseudoClass::Default => &[atom::CHECKED, atom::SELECTED],
            PseudoClass::Link | PseudoClass::AnyLink => &[atom::HREF],
            PseudoClass::Lang(_) => &[atom::LANG],
            PseudoClass::Dir(..) => &[atom::DIR],
            PseudoClass::Heading(_) => &[atom::HEADINGOFFSET, atom::HEADINGRESET],
            _ => &[],
        }
    }

    /// True for the focus pseudo-classes (`:focus`, `:focus-within`, `:focus-visible`).
    pub fn uses_focus(&self) -> bool {
        matches!(self, PseudoClass::Focus | PseudoClass::FocusWithin | PseudoClass::FocusVisible)
    }
}

/// Pseudo-elements. They parse (qSA/matches then never match, and cascade rules with one are skipped).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PseudoEl(pub u8);

/// Known pseudo-elements; legacy single-colon forms are `before`, `after`, `first-line`, `first-letter`.
pub const PSEUDO_ELEMENTS: &[&str] = &[
    "before",
    "after",
    "backdrop",
    "placeholder",
    "marker",
    "selection",
    "first-line",
    "first-letter",
    "file-selector-button",
    "cue",
    "grammar-error",
    "spelling-error",
    "target-text",
    "-webkit-scrollbar",
    "-webkit-inner-spin-button",
    "-webkit-outer-spin-button",
    "-webkit-search-cancel-button",
    "-webkit-input-placeholder",
    "-moz-placeholder",
    "-moz-selection",
    "-moz-focus-inner",
];

impl ToCss for PseudoEl {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        dest.write_str("::")?;
        dest.write_str(PSEUDO_ELEMENTS.get(self.0 as usize).copied().unwrap_or("unknown"))
    }
}

impl PseudoElement for PseudoEl {
    fn accepts_state_pseudo_classes(&self) -> bool {
        true
    }

    fn is_before_or_after(&self) -> bool {
        self.0 <= 1
    }
}

/// The oxidom `SelectorImpl`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Impl;

impl SelectorImpl for Impl {
    type ExtraMatchingData<'a> = ();
    type AttrValue = SVal;
    type Identifier = SAtom;
    type LocalName = SAtom;
    type NamespaceUrl = SAtom;
    type NamespacePrefix = SAtom;
    type BorrowedNamespaceUrl = SAtom;
    type BorrowedLocalName = SAtom;
    type NonTSPseudoClass = PseudoClass;
    type PseudoElement = PseudoEl;
}

// ---------------------------------------------------------------------------------------- parser

fn unsupported() -> ParseError<SelectorParseErrorKind> {
    ParseError::custom(SelectorParseErrorKind::UnsupportedPseudoClassOrElement)
}

/// The selector parser (shared by querySelector & co and stylesheets).
pub struct SelParser;

impl<'i> selectors::Parser<'i> for SelParser {
    type Impl = Impl;
    type Error = SelectorParseErrorKind;

    fn parse_nth_child_of(&self) -> bool {
        true
    }

    /// `::slotted()` / `::part()` parse (jsdom accepts them) and never match: no shadow trees.
    fn parse_slotted(&self) -> bool {
        true
    }

    fn parse_part(&self) -> bool {
        true
    }

    fn parse_is_and_where(&self) -> bool {
        true
    }

    fn parse_has(&self) -> bool {
        true
    }

    fn parse_non_ts_pseudo_class(&self, name: CowRcStr<'i>) -> Result<PseudoClass, ParseError<Self::Error>> {
        let n = name.to_ascii_lowercase();
        let pc = match n.as_str() {
            "checked" => PseudoClass::Checked,
            "disabled" => PseudoClass::Disabled,
            "enabled" => PseudoClass::Enabled,
            "focus" => PseudoClass::Focus,
            "focus-within" => PseudoClass::FocusWithin,
            "focus-visible" => PseudoClass::FocusVisible,
            "required" => PseudoClass::Required,
            "optional" => PseudoClass::Optional,
            "read-only" => PseudoClass::ReadOnly,
            "read-write" => PseudoClass::ReadWrite,
            "placeholder-shown" => PseudoClass::PlaceholderShown,
            "indeterminate" => PseudoClass::Indeterminate,
            "default" => PseudoClass::Default,
            "link" => PseudoClass::Link,
            "any-link" => PseudoClass::AnyLink,
            "defined" => PseudoClass::Defined,
            "open" => PseudoClass::Open,
            "in-range" => PseudoClass::InRange,
            "out-of-range" => PseudoClass::OutOfRange,
            "valid" => PseudoClass::Valid,
            "invalid" => PseudoClass::Invalid,
            "heading" => PseudoClass::Heading(None),
            other => match NEVER_MATCHING.iter().position(|x| *x == other) {
                Some(i) => PseudoClass::Never(i as u8),
                None => return Err(unsupported()),
            },
        };
        Ok(pc)
    }

    fn parse_non_ts_functional_pseudo_class(
        &self,
        name: CowRcStr<'i>,
        parser: &mut CssParser<'i>,
        _after_part: bool,
    ) -> Result<PseudoClass, ParseError<Self::Error>> {
        let n = name.to_ascii_lowercase();
        match n.as_str() {
            "lang" => {
                let langs = parser.parse_comma_separated(|p| {
                    let t = p.expect_ident_or_string()?;
                    Ok(Box::<str>::from(t.as_ref()))
                })?;
                Ok(PseudoClass::Lang(langs.into_boxed_slice()))
            }
            "dir" => {
                let t = parser.expect_ident()?.clone();
                let d = if t.eq_ignore_ascii_case("rtl") {
                    Some(true)
                } else if t.eq_ignore_ascii_case("ltr") {
                    Some(false)
                } else {
                    None // Selectors 4: any identifier is valid; only ltr / rtl can match
                };
                Ok(PseudoClass::Dir(d, Box::from(t.as_ref())))
            }
            "heading" => {
                // Selectors 5: a comma-separated list of integers
                let levels = parser.parse_comma_separated(|p| Ok(p.expect_integer()?))?;
                Ok(PseudoClass::Heading(Some(levels.into_boxed_slice())))
            }
            "state" => {
                // Custom element states: no custom elements, never matches.
                parser.expect_ident()?;
                Ok(PseudoClass::Never(0))
            }
            _ => Err(unsupported()),
        }
    }

    fn parse_pseudo_element(&self, name: CowRcStr<'i>) -> Result<PseudoEl, ParseError<Self::Error>> {
        let n = name.to_ascii_lowercase();
        match PSEUDO_ELEMENTS.iter().position(|x| *x == n) {
            Some(i) => Ok(PseudoEl(i as u8)),
            None => Err(unsupported()),
        }
    }
}

/// HTML heading level of an `h1`-`h6` element (whatwg/html#11086): the name's level plus the `headingoffset`s of
/// its shadow-including inclusive ancestors (each a non-negative integer, negative ones count as 0) up to and
/// including the nearest one with `headingreset`, at most 9.
fn heading_level(e: &Env, el: NodeId, base: i32) -> i32 {
    let mut offset: i64 = 0;
    let mut n = el;
    while n != 0 {
        let r = e.rec(n);
        if r.meta & (meta::KIND_MASK | meta::SHADOW) == kind::FRAGMENT | meta::SHADOW {
            n = r.payload; // a shadow root continues at its host
            continue;
        }
        if r.meta & meta::KIND_MASK != kind::ELEMENT {
            break;
        }
        if let Some(v) = e.get_attr(n, atom::HEADINGOFFSET) {
            offset += parse_html_int(v.as_str()).map_or(0, |x| x.clamp(0, 9));
        }
        if e.get_attr(n, atom::HEADINGRESET).is_some() || offset >= 9 {
            break;
        }
        n = r.parent;
    }
    (i64::from(base) + offset).min(9) as i32
}

/// HTML "rules for parsing integers".
fn parse_html_int(s: &str) -> Option<i64> {
    let t = s.trim_start_matches([' ', '\t', '\n', '\x0c', '\r']);
    let (neg, t) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    if !t.bytes().next().is_some_and(|b| b.is_ascii_digit()) {
        return None;
    }
    // saturating: only whether the value exceeds the 0..=9 range matters
    let v = t
        .bytes()
        .take_while(u8::is_ascii_digit)
        .fold(0i64, |v, d| (v * 10 + i64::from(d - b'0')).min(1 << 40));
    Some(if neg { -v } else { v })
}

// --------------------------------------------------------------------------------------- matching

/// An element of the arena, as seen by `selectors`.
#[derive(Clone, Copy)]
pub struct ERef<'a> {
    /// The env.
    pub e: &'a Env,
    /// The element id (always an element).
    pub id: NodeId,
}

impl fmt::Debug for ERef<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ERef({})", self.id)
    }
}

impl<'a> ERef<'a> {
    #[inline(always)]
    fn elem_at(&self, id: NodeId) -> Option<Self> {
        if id != 0 && self.e.rec(id).meta & meta::KIND_MASK == kind::ELEMENT {
            Some(ERef { e: self.e, id })
        } else {
            None
        }
    }

    #[inline(always)]
    fn is_html_named(&self, a: Atom) -> bool {
        self.e.is_html_elem(self.id, a)
    }
}

/// The quirks mode of `id`'s node document, for a `MatchingContext`.
pub fn quirks_of(e: &Env, id: NodeId) -> QuirksMode {
    match e.doc_data(e.rec(id).owner).map(|d| d.quirks) {
        Some(Quirks::Quirks) => QuirksMode::Quirks,
        Some(Quirks::LimitedQuirks) => QuirksMode::LimitedQuirks,
        _ => QuirksMode::NoQuirks,
    }
}

fn atom_eq_ci(e: &Env, a: Atom, b: Atom) -> bool {
    a == b || e.atoms.name(a).eq_ignore_ascii_case(e.atoms.name(b))
}

impl<'a> Element for ERef<'a> {
    type Impl = Impl;

    fn opaque(&self) -> OpaqueElement {
        // Ids are >= 1, so the (provenance-free) pointer is non-null; it is only compared, never read.
        let p = NonNull::new(std::ptr::without_provenance_mut::<()>(self.id as usize))
            .unwrap_or(NonNull::dangling());
        OpaqueElement::from_non_null_ptr(p)
    }

    fn parent_element(&self) -> Option<Self> {
        self.elem_at(self.e.rec(self.id).parent)
    }

    fn parent_node_is_shadow_root(&self) -> bool {
        false
    }

    fn containing_shadow_host(&self) -> Option<Self> {
        None
    }

    fn is_pseudo_element(&self) -> bool {
        false
    }

    fn prev_sibling_element(&self) -> Option<Self> {
        let mut c = self.e.rec(self.id).prev;
        while c != 0 {
            if let Some(x) = self.elem_at(c) {
                return Some(x);
            }
            c = self.e.rec(c).prev;
        }
        None
    }

    fn next_sibling_element(&self) -> Option<Self> {
        let mut c = self.e.rec(self.id).next;
        while c != 0 {
            if let Some(x) = self.elem_at(c) {
                return Some(x);
            }
            c = self.e.rec(c).next;
        }
        None
    }

    fn first_element_child(&self) -> Option<Self> {
        let mut c = self.e.rec(self.id).first;
        while c != 0 {
            if let Some(x) = self.elem_at(c) {
                return Some(x);
            }
            c = self.e.rec(c).next;
        }
        None
    }

    #[inline]
    fn is_html_element_in_html_document(&self) -> bool {
        self.e.rec(self.id).meta & (meta::NS_MASK | meta::HTML_DOC) == meta::HTML_DOC
    }

    #[inline]
    fn has_local_name(&self, local_name: &SAtom) -> bool {
        self.e.rec(self.id).local == local_name.0.0
    }

    fn has_namespace(&self, ns: &SAtom) -> bool {
        self.e.elem(self.id).is_some_and(|d| d.ns == ns.0)
    }

    fn is_same_type(&self, other: &Self) -> bool {
        self.e.rec(self.id).local == other.e.rec(other.id).local
            && self.e.elem(self.id).map(|d| d.ns) == other.e.elem(other.id).map(|d| d.ns)
    }

    fn attr_matches(
        &self,
        ns: &NamespaceConstraint<&SAtom>,
        local_name: &SAtom,
        operation: &AttrSelectorOperation<&SVal>,
    ) -> bool {
        let Some(d) = self.e.elem(self.id) else { return false };
        d.attrs.iter().any(|a| {
            a.local == local_name.0
                && match ns {
                    NamespaceConstraint::Any => true,
                    NamespaceConstraint::Specific(n) => a.ns == n.0,
                }
                && operation.eval_str(a.value.as_str())
        })
    }

    fn match_non_ts_pseudo_class(&self, pc: &PseudoClass, _context: &mut MatchingContext<Impl>) -> bool {
        match_pseudo_class(self.e, self.id, pc)
    }

    fn match_pseudo_element(&self, _pe: &PseudoEl, _context: &mut MatchingContext<Impl>) -> bool {
        false
    }

    fn apply_selector_flags(&self, _flags: ElementSelectorFlags) {}

    fn is_link(&self) -> bool {
        (self.is_html_named(atom::A) || self.is_html_named(atom::AREA))
            && self.e.has_attr(self.id, atom::HREF)
    }

    fn is_html_slot_element(&self) -> bool {
        self.is_html_named(atom::SLOT)
    }

    fn has_id(&self, id: &SAtom, case_sensitivity: CaseSensitivity) -> bool {
        let Some(d) = self.e.elem(self.id) else { return false };
        if d.id.is_none() {
            return false;
        }
        match case_sensitivity {
            CaseSensitivity::CaseSensitive => d.id == id.0,
            CaseSensitivity::AsciiCaseInsensitive => atom_eq_ci(self.e, d.id, id.0),
        }
    }

    fn has_class(&self, name: &SAtom, case_sensitivity: CaseSensitivity) -> bool {
        let Some(d) = self.e.elem(self.id) else { return false };
        match case_sensitivity {
            CaseSensitivity::CaseSensitive => d.classes.contains(&name.0),
            CaseSensitivity::AsciiCaseInsensitive => d.classes.iter().any(|&c| atom_eq_ci(self.e, c, name.0)),
        }
    }

    fn has_custom_state(&self, _name: &SAtom) -> bool {
        false
    }

    fn imported_part(&self, _name: &SAtom) -> Option<SAtom> {
        None
    }

    fn is_part(&self, _name: &SAtom) -> bool {
        false
    }

    fn is_empty(&self) -> bool {
        let mut c = self.e.rec(self.id).first;
        while c != 0 {
            match self.e.kind(c) {
                kind::ELEMENT => return false,
                kind::TEXT | kind::CDATA if self.e.char_data(c).is_some_and(|s| !s.is_empty()) => {
                    return false;
                }
                _ => {}
            }
            c = self.e.rec(c).next;
        }
        true
    }

    fn is_root(&self) -> bool {
        let p = self.e.rec(self.id).parent;
        p != 0 && self.e.kind(p) == kind::DOCUMENT
    }

    fn add_element_unique_hashes(&self, _filter: &mut BloomFilter) -> bool {
        false
    }
}

impl Borrow<str> for SVal {
    fn borrow(&self) -> &str {
        &self.0
    }
}

// --------------------------------------------------------------------------- pseudo-class matching
//
// Semantics follow jsdom 30's selector engine (@asamuzakjp/dom-selector, the parity oracle), which in a
// few places reads the RAW `type` attribute (case-sensitive) rather than the normalized type.

/// dom-selector `INPUT_TEXT`.
const INPUT_TEXT: &[&str] = &["email", "password", "search", "tel", "text", "url"];
/// dom-selector `INPUT_EDIT` (date types, text types, number).
const INPUT_EDIT: &[&str] = &[
    "date",
    "datetime-local",
    "month",
    "time",
    "week",
    "email",
    "password",
    "search",
    "tel",
    "text",
    "url",
    "number",
];

/// The raw `type` attribute (None if absent).
fn raw_type(e: &Env, el: NodeId) -> Option<&str> {
    e.get_attr(el, atom::TYPE).map(|s| s.as_str())
}

/// Value emptiness of a text control, for `:placeholder-shown` (the control's current API value, area B).
pub fn control_value_is_empty(e: &Env, el: NodeId) -> bool {
    control_value_len(e, el) == 0
}

/// UTF-16 length of a control's current API value (`crate::forms`: dirty value, sanitized value,
/// textarea API value, ...).
#[inline]
pub fn control_value_len(e: &Env, el: NodeId) -> u32 {
    e.value_len16(el)
}

fn is_content_editable(e: &Env, el: NodeId) -> bool {
    let mut c = el;
    while c != 0 && e.is_element(c) {
        if let Some(v) = e.get_attr(c, atom::CONTENTEDITABLE) {
            let v = v.as_str();
            if v.is_empty() || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("plaintext-only") {
                return true;
            }
            if v.eq_ignore_ascii_case("false") {
                return false;
            }
        }
        c = e.rec(c).parent;
    }
    false
}

/// dom-selector `matchReadOnlyPseudoClass`: editable inputs / textarea are read-only when `readonly`
/// or their OWN `disabled` attribute is present; other inputs are read-only; other elements unless
/// contenteditable.
fn is_read_only(e: &Env, el: NodeId, l: Atom) -> bool {
    if l == atom::INPUT || l == atom::TEXTAREA {
        if l == atom::TEXTAREA || INPUT_EDIT.contains(&element_state::input_type_name(e, el)) {
            return e.has_attr(el, atom::READONLY) || e.rec(el).meta & meta::DISABLED_ATTR != 0;
        }
        return true;
    }
    !is_content_editable(e, el)
}

/// True if `f` is in the shadow tree of host `el` (a shadow-including descendant reached through its root). Like
/// jsdom (dom-selector follows `shadowRoot.activeElement`), the walk stops at a closed root.
fn host_of_focus(e: &Env, el: NodeId, f: NodeId) -> bool {
    let mut n = f;
    while n != 0 {
        let p = e.rec(n).parent;
        if p != 0 {
            n = p;
        } else if e.is_shadow_root(n) && e.shadow_mode(n) == crate::shadow::mode::OPEN {
            n = e.shadow_host(n);
            if n == el {
                return true;
            }
        } else {
            return false;
        }
    }
    false
}

/// True if `el` is a shadow-including inclusive ancestor of `f`, not crossing closed roots (as `host_of_focus`).
fn shadow_including_ancestor(e: &Env, el: NodeId, f: NodeId) -> bool {
    let mut n = f;
    while n != 0 {
        if n == el {
            return true;
        }
        let p = e.rec(n).parent;
        n = if p != 0 {
            p
        } else if e.is_shadow_root(n) && e.shadow_mode(n) == crate::shadow::mode::OPEN {
            e.shadow_host(n)
        } else {
            0
        };
    }
    false
}

fn focused_of(e: &Env, el: NodeId) -> NodeId {
    e.doc_data(e.rec(el).owner).map_or(0, |d| d.focused)
}

fn lang_of(e: &Env, el: NodeId) -> Option<&str> {
    let mut c = el;
    while c != 0 && e.is_element(c) {
        if let Some(d) = e.elem(c) {
            for a in &d.attrs {
                if a.local == atom::LANG && (a.ns.is_none() || a.ns == atom::NS_XML) {
                    return Some(a.value.as_str());
                }
            }
        }
        c = e.rec(c).parent;
    }
    None
}

fn lang_matches(lang: &str, range: &str) -> bool {
    if range == "*" {
        return !lang.is_empty();
    }
    if range.is_empty() {
        return lang.is_empty();
    }
    if range.split('-').any(|r| r == "*") {
        return lang_extended_match(lang, range);
    }
    // Byte comparison: `lang` is user data and may hold multi-byte characters at any offset.
    let (l, r) = (lang.as_bytes(), range.as_bytes());
    l.get(..r.len()).is_some_and(|p| p.eq_ignore_ascii_case(r)) && (l.len() == r.len() || l[r.len()] == b'-')
}

/// RFC 4647 extended filtering (a `*` subtag in the range matches any subtags; `:lang(\*-US)`).
fn lang_extended_match(lang: &str, range: &str) -> bool {
    let r: smallvec::SmallVec<[&str; 4]> = range.split('-').collect();
    let l: smallvec::SmallVec<[&str; 4]> = lang.split('-').collect();
    if !(r[0] == "*" || r[0].eq_ignore_ascii_case(l[0])) || l[0].is_empty() {
        return false;
    }
    let (mut i, mut j) = (1, 1);
    while i < r.len() {
        if r[i] == "*" {
            i += 1;
        } else if j >= l.len() {
            return false;
        } else if r[i].eq_ignore_ascii_case(l[j]) {
            i += 1;
            j += 1;
        } else if l[j].len() == 1 {
            return false; // singleton
        } else {
            j += 1;
        }
    }
    true
}

/// dom-selector `KEYS_DIR_AUTO`: input types whose value decides `dir=auto`.
const DIR_AUTO_INPUT: &[&str] =
    &["button", "reset", "submit", "email", "password", "search", "tel", "text", "url", "hidden"];
/// dom-selector `KEYS_DIR_LTR`: input types that are always ltr under `dir=auto`.
const DIR_LTR_INPUT: &[&str] = &["checkbox", "radio", "color", "date", "image", "number", "range", "time"];

/// Bidi class of `c` for the paragraph-level rule (UAX #9 P2/P3): Some(true) = R / AL, Some(false) =
/// L, None = weak or neutral. Strong RTL = the Hebrew / Arabic / Syriac / Thaana / NKo / ... blocks and
/// their presentation forms; strong LTR approximated as any other alphabetic character.
fn strong_class(c: char) -> Option<bool> {
    match c as u32 {
        0x200F => Some(true),
        0x200E => Some(false),
        0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF => {
            c.is_alphabetic().then_some(true)
        }
        _ if c.is_alphabetic() => Some(false),
        _ => None,
    }
}

/// Direction of a non-empty text: rtl iff its first strong character is R / AL.
fn text_is_rtl(s: &str) -> bool {
    s.chars().find_map(strong_class).unwrap_or(false)
}

/// Collects the text of `n` (a Text node, or an element's descendant Text nodes) into `out`.
fn subtree_text(e: &Env, n: NodeId, out: &mut String) {
    if e.is_text(n) {
        if let Some(s) = e.char_data(n) {
            out.push_str(s);
        }
        return;
    }
    let mut c = e.next_in_subtree(n, n);
    while c != 0 {
        if e.is_text(c) {
            if let Some(s) = e.char_data(c) {
                out.push_str(s);
            }
        }
        c = e.next_in_subtree(c, n);
    }
}

fn is_html_el(e: &Env, el: NodeId) -> bool {
    e.rec(el).meta & (meta::KIND_MASK | meta::NS_MASK) == kind::ELEMENT
}

/// The `dir` attribute's state on an HTML element: Some("ltr" | "rtl" | "auto") or None (absent / invalid).
fn dir_state(e: &Env, el: NodeId) -> Option<&'static str> {
    if !is_html_el(e, el) {
        return None;
    }
    let v = e.get_attr(el, atom::DIR)?.as_str();
    ["ltr", "rtl", "auto"].into_iter().find(|k| v.eq_ignore_ascii_case(k))
}

/// The element's directionality (dom-selector `getDirectionality`): `dir=ltr|rtl`, `dir=auto` (first
/// strong character of the text-control value or of the first child with text, else the parent's),
/// `<input type=tel>` (ltr), `<bdi>` (its text), otherwise the parent element's.
fn is_rtl(e: &Env, el: NodeId) -> bool {
    let mut c = el;
    while c != 0 && e.is_element(c) {
        let html = is_html_el(e, c);
        let l = e.local(c);
        match dir_state(e, c) {
            Some("ltr") => return false,
            Some("rtl") => return true,
            Some(_) => {
                let mut text = String::new();
                if html && l == atom::INPUT {
                    let t = element_state::input_type_name(e, c);
                    if DIR_AUTO_INPUT.contains(&t) {
                        e.value_into(c, &mut text);
                    } else if DIR_LTR_INPUT.contains(&t) {
                        return false;
                    }
                } else if html && l == atom::TEXTAREA {
                    e.value_into(c, &mut text);
                } else {
                    let mut k = e.rec(c).first;
                    while k != 0 {
                        let take = e.is_text(k)
                            || (e.is_element(k)
                                && !(is_html_el(e, k)
                                    && matches!(
                                        e.local(k),
                                        atom::BDI | atom::SCRIPT | atom::STYLE | atom::TEXTAREA
                                    ))
                                && !matches!(dir_state(e, k), Some("ltr" | "rtl")));
                        if take {
                            subtree_text(e, k, &mut text);
                            if !text.trim().is_empty() {
                                break;
                            }
                            text.clear();
                        }
                        k = e.rec(k).next;
                    }
                }
                let t = text.trim();
                if !t.is_empty() {
                    return text_is_rtl(t);
                }
            }
            None if html && l == atom::INPUT && element_state::input_type_name(e, c) == "tel" => {
                return false;
            }
            None if html && l == atom::BDI => {
                let mut text = String::new();
                subtree_text(e, c, &mut text);
                return text_is_rtl(text.trim());
            }
            None => {}
        }
        c = e.rec(c).parent;
    }
    false
}

/// The nearest ancestor `<form>`.
fn ancestor_form(e: &Env, el: NodeId) -> NodeId {
    let mut c = e.rec(el).parent;
    while c != 0 {
        if e.is_html_elem(c, atom::FORM) {
            return c;
        }
        c = e.rec(c).parent;
    }
    0
}

/// dom-selector `:indeterminate` for radios: no radio with the same (non-empty) name in the nearest
/// ancestor form (or the document element) is checked.
fn radio_group_unchecked(e: &Env, el: NodeId) -> bool {
    if e.rec(el).state & state::CHECKED != 0 || e.has_attr(el, atom::CHECKED) {
        return false;
    }
    let name = e.get_attr(el, atom::NAME).map(|s| s.as_str()).unwrap_or("");
    if name.is_empty() {
        return true;
    }
    let mut scope = ancestor_form(e, el);
    if scope == 0 {
        let doc = e.rec(el).owner;
        scope = e.doc_data(doc).map_or(0, |_| {
            let mut c = e.rec(doc).first;
            while c != 0 && !e.is_element(c) {
                c = e.rec(c).next;
            }
            c
        });
        if scope == 0 || !e.is_inclusive_ancestor(scope, el) {
            scope = e.root_of(el);
        }
    }
    let mut n = e.next_in_subtree(scope, scope);
    while n != 0 {
        if e.is_html_elem(n, atom::INPUT)
            && raw_type(e, n) == Some("radio")
            && e.get_attr(n, atom::NAME).is_some_and(|v| v.as_str() == name)
            && e.rec(n).state & state::CHECKED != 0
        {
            return false;
        }
        n = e.next_in_subtree(n, scope);
    }
    true
}

/// dom-selector `isFocusVisible` (editable inputs, textarea, contenteditable): oxidom does not track
/// keyboard modality, so `:focus-visible` = focused and one of these.
fn focus_visible_type(e: &Env, el: NodeId, l: Atom) -> bool {
    match l {
        atom::INPUT => INPUT_EDIT.contains(&element_state::input_type_name(e, el)),
        atom::TEXTAREA => true,
        _ => is_content_editable(e, el),
    }
}

/// Matches one non-tree-structural pseudo-class.
pub fn match_pseudo_class(e: &Env, el: NodeId, pc: &PseudoClass) -> bool {
    let r = e.rec(el);
    let html = r.meta & meta::NS_MASK == 0;
    let l = Atom(r.local);
    match pc {
        PseudoClass::Checked => {
            html && match l {
                atom::INPUT => {
                    r.state & state::CHECKED != 0 && matches!(raw_type(e, el), Some("checkbox" | "radio"))
                }
                atom::OPTION => r.state & state::SELECTED != 0,
                _ => false,
            }
        }
        PseudoClass::Disabled => element_state::matches_disabled(e, el),
        PseudoClass::Enabled => {
            element_state::is_disableable(e, el) && !element_state::matches_disabled(e, el)
        }
        // HTML: the focused element, and a shadow host whose shadow tree contains it (DESIGN §42)
        PseudoClass::Focus => {
            r.state & state::FOCUSED != 0
                || (r.meta & meta::SHADOW != 0 && host_of_focus(e, el, focused_of(e, el)))
        }
        PseudoClass::FocusVisible => r.state & state::FOCUSED != 0 && html && focus_visible_type(e, el, l),
        PseudoClass::FocusWithin => {
            let f = focused_of(e, el);
            f != 0
                && (e.is_inclusive_ancestor(el, f) || (e.shadow.any() && shadow_including_ancestor(e, el, f)))
        }
        PseudoClass::Required | PseudoClass::Optional => {
            let required = match l {
                _ if !html => return false,
                atom::SELECT | atom::TEXTAREA => e.has_attr(el, atom::REQUIRED),
                atom::INPUT => match raw_type(e, el) {
                    None => e.has_attr(el, atom::REQUIRED),
                    Some(t) => {
                        (matches!(t, "checkbox" | "radio" | "file") || INPUT_EDIT.contains(&t))
                            && e.has_attr(el, atom::REQUIRED)
                    }
                },
                _ => return false,
            };
            required == matches!(pc, PseudoClass::Required)
        }
        PseudoClass::ReadOnly => !html || is_read_only(e, el, l),
        PseudoClass::ReadWrite => html && !is_read_only(e, el, l),
        PseudoClass::PlaceholderShown => {
            let shown_type = match l {
                atom::TEXTAREA => true,
                atom::INPUT => match raw_type(e, el) {
                    None => true,
                    Some(t) => t == "number" || INPUT_TEXT.contains(&t),
                },
                _ => false,
            };
            html && shown_type
                && e.get_attr(el, atom::PLACEHOLDER).is_some_and(|p| !p.as_str().contains(['\r', '\n']))
                && control_value_is_empty(e, el)
        }
        PseudoClass::Indeterminate => {
            html && match l {
                atom::PROGRESS => !e.has_attr(el, atom::VALUE),
                atom::INPUT => match element_state::input_type_name(e, el) {
                    "checkbox" => r.state & state::INDETERMINATE != 0,
                    "radio" => radio_group_unchecked(e, el),
                    _ => false,
                },
                _ => false,
            }
        }
        PseudoClass::Default => {
            html && match l {
                atom::OPTION => e.has_attr(el, atom::SELECTED),
                atom::INPUT
                    if e.has_attr(el, atom::CHECKED)
                        && matches!(raw_type(e, el), Some("checkbox" | "radio")) =>
                {
                    true
                }
                atom::INPUT | atom::BUTTON if element_state::is_default_button_candidate(e, el) => {
                    let form = ancestor_form(e, el);
                    if form == 0 {
                        return false;
                    }
                    let mut n = e.next_in_subtree(form, form);
                    while n != 0 {
                        if e.is_element(n) && element_state::is_default_button_candidate(e, n) {
                            return n == el;
                        }
                        n = e.next_in_subtree(n, form);
                    }
                    false
                }
                _ => false,
            }
        }
        PseudoClass::Link | PseudoClass::AnyLink => {
            html && matches!(l, atom::A | atom::AREA) && e.has_attr(el, atom::HREF)
        }
        // custom element state "uncustomized" or "custom" (DESIGN §43: the other states set CE_UNDEFINED)
        PseudoClass::Defined => e.rec(el).meta & crate::ce::CE_UNDEFINED == 0,
        PseudoClass::Open => html && matches!(l, atom::DETAILS | atom::DIALOG) && e.has_attr(el, atom::OPEN),
        PseudoClass::InRange | PseudoClass::OutOfRange => {
            html && l == atom::INPUT
                && element_state::matches_in_range(e, el, matches!(pc, PseudoClass::OutOfRange))
        }
        PseudoClass::Valid | PseudoClass::Invalid => {
            let valid = match l {
                _ if !html => return false,
                atom::BUTTON | atom::INPUT | atom::SELECT | atom::TEXTAREA => {
                    element_state::matches_valid(e, el)
                }
                atom::FORM | atom::FIELDSET => element_state::subtree_matches_valid(e, el),
                _ => return false,
            };
            valid == matches!(pc, PseudoClass::Valid)
        }
        PseudoClass::Lang(ranges) => match lang_of(e, el) {
            Some(lang) => ranges.iter().any(|r| lang_matches(lang, r)),
            None => false,
        },
        PseudoClass::Dir(d, _) => d.is_some_and(|rtl| is_rtl(e, el) == rtl),
        PseudoClass::Heading(levels) => {
            html && (atom::H1.0..=atom::H6.0).contains(&l.0) && {
                let level = heading_level(e, el, (l.0 - atom::H1.0 + 1) as i32);
                levels.as_ref().is_none_or(|ls| ls.contains(&level))
            }
        }
        PseudoClass::Never(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lang_ranges() {
        assert!(lang_matches("en-US", "en"));
        assert!(lang_matches("en", "EN"));
        assert!(!lang_matches("eng", "en"));
        assert!(lang_matches("de", "*"));
    }

    #[test]
    fn interner_restored_after_panic() {
        let mut i = Interner::new();
        let a = i.intern("zzz-before");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_interner(&mut i, || {
                tls_intern("zzz-during");
                panic!("boom");
            })
        }));
        assert!(r.is_err());
        assert_eq!(i.get("zzz-before"), Some(a));
        assert!(i.get("zzz-during").is_some());
    }
}
