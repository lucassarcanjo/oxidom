//! Node kinds, `NodeRec.meta`/`state` bit layout and the Rust-private per-node payloads.
//!
//! The bit layout is part of the JS contract (mirrored in packages/rsdom/lib/dom.cjs). Change both together.

use rustc_hash::FxHashMap;
use smallvec::SmallVec;

use crate::atoms::Atom;
use crate::string::Str;
use crate::table::NodeId;

/// `nodeType` values; stored in `meta & 0xF`.
pub mod kind {
    /// Element
    pub const ELEMENT: u32 = 1;
    /// Attr (never stored in the table; Attr wrappers live in JS)
    pub const ATTRIBUTE: u32 = 2;
    /// Text
    pub const TEXT: u32 = 3;
    /// CDATASection
    pub const CDATA: u32 = 4;
    /// ProcessingInstruction
    pub const PI: u32 = 7;
    /// Comment
    pub const COMMENT: u32 = 8;
    /// Document
    pub const DOCUMENT: u32 = 9;
    /// DocumentType
    pub const DOCTYPE: u32 = 10;
    /// DocumentFragment
    pub const FRAGMENT: u32 = 11;
}

/// `NodeRec.meta` bits.
pub mod meta {
    /// nodeType
    pub const KIND_MASK: u32 = 0xF;
    /// Namespace class shift (see [`super::Ns`]).
    pub const NS_SHIFT: u32 = 4;
    /// Namespace class mask.
    pub const NS_MASK: u32 = 3 << NS_SHIFT;
    /// The node's root is a Document.
    pub const CONNECTED: u32 = 1 << 6;
    /// A MutationObserver is registered on this node (area C, mo.rs).
    pub const OBSERVED: u32 = 1 << 7;
    /// ownerDocument is an HTML document (tagName uppercasing, attribute-name lowercasing).
    pub const HTML_DOC: u32 = 1 << 8;
    /// Node is (inside) template contents.
    pub const IN_TEMPLATE: u32 = 1 << 9;
    /// Element has an `id` attribute.
    pub const HAS_ID: u32 = 1 << 10;
    /// Element has a `class` attribute.
    pub const HAS_CLASS: u32 = 1 << 11;
    /// Element has a `style` attribute / inline declarations.
    pub const HAS_STYLE: u32 = 1 << 12;
    /// Element has a `disabled` attribute.
    pub const DISABLED_ATTR: u32 = 1 << 13;
    /// Element has a namespace prefix or an "other" namespace: JS asks `elemNames` once on materialize.
    pub const HAS_PREFIX: u32 = 1 << 14;
    /// Template contents fragment (DocumentFragment owned by a `<template>`).
    pub const TEMPLATE_CONTENT: u32 = 1 << 15;
    /// Bits 16..31 are free for area owners; claim them in this module (one line each) to avoid clashes.
    pub const FREE_SHIFT: u32 = 16;
    /// Shadow root (on a DocumentFragment) or shadow host (on an element); crate::shadow, DESIGN §22.
    pub const SHADOW: u32 = 1 << 20;
    /// Custom element state "custom"; crate::ce, DESIGN §43.
    pub const CE_CUSTOM: u32 = 1 << 21;
    /// Custom element state "undefined", "failed" or "precustomized" (not `:defined`); crate::ce, DESIGN §43.
    pub const CE_UNDEFINED: u32 = 1 << 22;
}

/// `NodeRec.state` bits (owned by forms.rs / focus.rs; layout fixed by DESIGN §2.2).
pub mod state {
    /// input checkedness
    pub const CHECKED: u32 = 1 << 0;
    /// option selectedness
    pub const SELECTED: u32 = 1 << 1;
    /// input indeterminate
    pub const INDETERMINATE: u32 = 1 << 2;
    /// dirty value flag
    pub const DIRTY_VALUE: u32 = 1 << 3;
    /// dirty checkedness flag
    pub const DIRTY_CHECKED: u32 = 1 << 4;
    /// dirty selectedness flag
    pub const DIRTY_SELECTED: u32 = 1 << 5;
    /// Normalized input type (5 bits) shift.
    pub const INPUT_TYPE_SHIFT: u32 = 8;
    /// Normalized input type mask.
    pub const INPUT_TYPE_MASK: u32 = 0x1F << INPUT_TYPE_SHIFT;
    /// Element is the focused element of its document.
    pub const FOCUSED: u32 = 1 << 16;
}

/// Namespace class stored in `meta` bits 4-5.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Ns {
    /// http://www.w3.org/1999/xhtml
    Html = 0,
    /// http://www.w3.org/2000/svg
    Svg = 1,
    /// http://www.w3.org/1998/Math/MathML
    MathMl = 2,
    /// any other namespace, including null (actual URI in `ElementData.ns`)
    Other = 3,
}

impl Ns {
    /// From the 2-bit wire value.
    pub fn from_bits(b: u32) -> Ns {
        match b & 3 {
            0 => Ns::Html,
            1 => Ns::Svg,
            2 => Ns::MathMl,
            _ => Ns::Other,
        }
    }

    /// The namespace URI atom.
    pub fn uri(self) -> Atom {
        use crate::atoms::atom;
        match self {
            Ns::Html => atom::NS_HTML,
            Ns::Svg => atom::NS_SVG,
            Ns::MathMl => atom::NS_MATHML,
            Ns::Other => Atom::NONE,
        }
    }

    /// Classifies a namespace URI atom.
    pub fn of_uri(a: Atom) -> Ns {
        use crate::atoms::atom;
        match a {
            atom::NS_HTML => Ns::Html,
            atom::NS_SVG => Ns::Svg,
            atom::NS_MATHML => Ns::MathMl,
            _ => Ns::Other,
        }
    }
}

/// One attribute. `qname` == `local` when there is no prefix.
#[derive(Clone, Debug, PartialEq)]
pub struct Attr {
    /// local name
    pub local: Atom,
    /// qualified name (`prefix:local` or `local`)
    pub qname: Atom,
    /// namespace URI (0 = null)
    pub ns: Atom,
    /// prefix (0 = null)
    pub prefix: Atom,
    /// value
    pub value: Str,
}

/// Per-element payload (`Env.elems[rec.payload]`). Kept small (fresh memory per element is the dominant
/// creation cost): rarely needed state lives behind `ext`.
#[derive(Default)]
pub struct ElementData {
    /// Attributes in insertion order (= NamedNodeMap order). One inline slot covers most elements.
    pub attrs: SmallVec<[Attr; 1]>,
    /// Cached `class` tokens.
    pub classes: SmallVec<[Atom; 2]>,
    /// Namespace URI atom (HTML/SVG/MathML elements carry it too).
    pub ns: Atom,
    /// Prefix atom (0 = none).
    pub prefix: Atom,
    /// Cached `id` attribute value as an atom (0 = none).
    pub id: Atom,
    /// `<template>` contents fragment (created lazily; 0 = none).
    pub template: NodeId,
    /// Lazily allocated extension state (style, form controls, computed-style memo); see [`ElementExt`].
    pub ext: Option<Box<ElementExt>>,
}

/// Per-element state only some elements need. Area owners add fields HERE (not to `ElementData`).
#[derive(Default)]
pub struct ElementExt {
    /// Inline style (area A, style/).
    pub style: Option<Box<crate::style::InlineStyle>>,
    /// Form-control state (area B, forms.rs).
    pub form: Option<Box<crate::forms::FormState>>,
    /// Computed-style memo (area A, style/).
    pub cs: crate::style::CsMemo,
    /// Shadow root of this host (crate::shadow; 0 = none).
    pub shadow: NodeId,
}

const _: () = assert!(size_of::<ElementData>() <= 112);

impl ElementData {
    /// The extension state, allocated on first use.
    #[inline]
    pub fn ext_mut(&mut self) -> &mut ElementExt {
        self.ext.get_or_insert_with(Default::default)
    }

    /// Index of the first attribute whose qualified name is `qname`.
    #[inline]
    pub fn find(&self, qname: Atom) -> Option<usize> {
        self.attrs.iter().position(|a| a.qname == qname)
    }

    /// Index of the attribute (namespace, local name).
    #[inline]
    pub fn find_ns(&self, ns: Atom, local: Atom) -> Option<usize> {
        self.attrs.iter().position(|a| a.ns == ns && a.local == local)
    }

    /// Value of the no-namespace attribute `local` (fast path for internal reads).
    #[inline]
    pub fn get(&self, qname: Atom) -> Option<&Str> {
        self.attrs.iter().find(|a| a.qname == qname).map(|a| &a.value)
    }
}

/// Quirks mode of a document.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Quirks {
    /// no-quirks
    #[default]
    NoQuirks,
    /// limited-quirks
    LimitedQuirks,
    /// quirks
    Quirks,
}

/// Per-document payload (`Env.docs[rec.payload]`).
#[derive(Default)]
pub struct DocData {
    /// The document node's id.
    pub id: NodeId,
    /// HTML document (vs. XML document).
    pub html: bool,
    /// Quirks mode.
    pub quirks: Quirks,
    /// Connected elements by `id` (duplicates kept; first in tree order wins on lookup).
    pub id_map: FxHashMap<Atom, SmallVec<[NodeId; 1]>>,
    /// Focused element (0 = none -> body). Mirrored into `EP[FOCUS]` for the main document.
    pub focused: NodeId,
    /// Registered MutationObservers targeting nodes of this document (0 => all MO bookkeeping skipped).
    pub observers: u32,
    /// Inert document owning template contents (created lazily; 0 = none / this is one).
    pub template_doc: NodeId,
    /// Scripting is disabled for this document (DOMParser documents, as in jsdom): `<noscript>` parses
    /// as normal markup and serializes its text escaped.
    pub no_scripting: bool,
    /// Area A: per-document style state (author sheets, ...).
    pub style: crate::style::DocStyle,
}

/// Per-doctype payload (`Env.doctypes[rec.payload]`).
#[derive(Default, Clone, Debug)]
pub struct DoctypeData {
    /// name
    pub name: Str,
    /// publicId
    pub public_id: Str,
    /// systemId
    pub system_id: Str,
}
