//! HTML fragment serialization (HTML §13.3 "serializing HTML fragments"), hand-written single pass over the
//! links into a reused `String`, iterative (no recursion, so deep trees cannot overflow the stack).
//!
//! Escaping matches jsdom 30 / parse5: text escapes `& NBSP < >`; attribute values escape `& NBSP "`
//! (not `<`/`>`). Children of raw-text elements (style, script, xmp, iframe, noembed, noframes, plaintext,
//! noscript with scripting enabled) are emitted verbatim.

use crate::atoms::{Atom, atom};
use crate::env::Env;
use crate::node::{Ns, kind};
use crate::table::NodeId;

fn is_void(local: Atom) -> bool {
    matches!(
        local,
        atom::AREA
            | atom::BASE
            | atom::BASEFONT
            | atom::BGSOUND
            | atom::BR
            | atom::COL
            | atom::EMBED
            | atom::FRAME
            | atom::HR
            | atom::IMG
            | atom::INPUT
            | atom::KEYGEN
            | atom::LINK
            | atom::META
            | atom::PARAM
            | atom::SOURCE
            | atom::TRACK
            | atom::WBR
    )
}

fn is_raw_text(local: Atom) -> bool {
    matches!(
        local,
        atom::STYLE
            | atom::SCRIPT
            | atom::XMP
            | atom::IFRAME
            | atom::NOEMBED
            | atom::NOFRAMES
            | atom::PLAINTEXT
            | atom::NOSCRIPT
    )
}

/// Next `&`/`<`/`>` (text) or `&`/`"` (attribute) at or after `from` (`b.len()` if none).
#[inline]
fn find_special(b: &[u8], from: usize, attr: bool) -> usize {
    let rest = &b[from..];
    let hit = if attr { memchr::memchr2(b'&', b'"', rest) } else { memchr::memchr3(b'&', b'<', b'>', rest) };
    hit.map_or(b.len(), |p| from + p)
}

/// Start of the next U+00A0 (UTF-8 `C2 A0`) at or after `from` (`b.len()` if none).
#[inline]
fn find_nbsp(b: &[u8], mut from: usize) -> usize {
    while let Some(p) = memchr::memchr(0xA0, &b[from..]) {
        let at = from + p;
        if at > 0 && b[at - 1] == 0xC2 {
            return at - 1;
        }
        from = at + 1;
    }
    b.len()
}

/// Appends `s` escaping `&`, U+00A0, and either `<`/`>` (text) or `"` (attribute values). memchr-driven:
/// runs between escapes are copied with one `push_str`; the NBSP search is skipped for ASCII strings.
fn escape(out: &mut String, s: &str, attr: bool, ascii: bool) {
    let b = s.as_bytes();
    let len = b.len();
    let mut start = 0;
    let mut special = find_special(b, 0, attr);
    let mut nbsp = if ascii { len } else { find_nbsp(b, 0) };
    loop {
        let p = special.min(nbsp);
        if p >= len {
            break;
        }
        out.push_str(&s[start..p]);
        if p == nbsp {
            out.push_str("&nbsp;");
            start = p + 2;
            nbsp = find_nbsp(b, start);
        } else {
            out.push_str(match b[p] {
                b'&' => "&amp;",
                b'<' => "&lt;",
                b'>' => "&gt;",
                _ => "&quot;",
            });
            start = p + 1;
            special = find_special(b, start, attr);
        }
    }
    out.push_str(&s[start..]);
}

impl Env {
    /// The node whose children are serialized for `n` (template contents for `<template>`).
    fn serialization_children_of(&self, n: NodeId) -> NodeId {
        if self.is_html_elem(n, atom::TEMPLATE) {
            return self.elem(n).map_or(0, |d| d.template);
        }
        n
    }

    fn qualified_tag(&self, el: NodeId, out: &mut String) {
        let d = self.elem(el);
        let local = self.local(el);
        if self.ns_of(el) == Ns::Other {
            if let Some(p) = d.map(|d| d.prefix).filter(|p| !p.is_none()) {
                out.push_str(self.atoms.name(p));
                out.push(':');
            }
        }
        out.push_str(self.atoms.name(local));
    }

    fn start_tag(&self, el: NodeId, out: &mut String) {
        out.push('<');
        self.qualified_tag(el, out);
        if let Some(d) = self.elem(el) {
            for a in &d.attrs {
                out.push(' ');
                match a.ns {
                    Atom::NONE => out.push_str(self.atoms.name(a.qname)),
                    atom::NS_XML => {
                        out.push_str("xml:");
                        out.push_str(self.atoms.name(a.local));
                    }
                    atom::NS_XMLNS => {
                        if a.local != atom::XMLNS {
                            out.push_str("xmlns:");
                        }
                        out.push_str(self.atoms.name(a.local));
                    }
                    atom::NS_XLINK => {
                        out.push_str("xlink:");
                        out.push_str(self.atoms.name(a.local));
                    }
                    _ => out.push_str(self.atoms.name(a.qname)),
                }
                out.push_str("=\"");
                escape(out, &a.value, true, a.value.is_ascii());
                out.push('"');
            }
        }
        out.push('>');
    }

    /// Serializes one non-element node (or an element's start tag); returns true if the node is an element
    /// whose children/end tag must follow.
    fn open_node(&self, n: NodeId, out: &mut String) -> bool {
        match self.kind(n) {
            kind::ELEMENT => {
                self.start_tag(n, out);
                !(self.ns_of(n) == Ns::Html && is_void(self.local(n)))
            }
            kind::TEXT | kind::CDATA => {
                let (s, ascii) = self.char_data(n).map_or(("", true), |s| (s.as_str(), s.is_ascii()));
                let p = self.rec(n).parent;
                if self.ns_of(p) == Ns::Html
                    && self.is_element(p)
                    && is_raw_text(self.local(p))
                    && (self.local(p) != atom::NOSCRIPT
                        || !self.doc_data(self.node_doc(p)).is_some_and(|d| d.no_scripting))
                {
                    out.push_str(s);
                } else {
                    escape(out, s, false, ascii);
                }
                false
            }
            kind::COMMENT => {
                out.push_str("<!--");
                out.push_str(self.char_data(n).map_or("", |s| s.as_str()));
                out.push_str("-->");
                false
            }
            kind::PI => {
                out.push_str("<?");
                out.push_str(self.atoms.name(Atom(self.rec(n).local)));
                out.push(' ');
                out.push_str(self.char_data(n).map_or("", |s| s.as_str()));
                out.push('>');
                false
            }
            kind::DOCTYPE => {
                out.push_str("<!DOCTYPE ");
                out.push_str(self.doctype(n).map_or("", |d| d.name.as_str()));
                out.push('>');
                false
            }
            _ => false,
        }
    }

    fn close_element(&self, el: NodeId, out: &mut String) {
        out.push_str("</");
        self.qualified_tag(el, out);
        out.push('>');
    }

    /// Serializes the children of `node` (innerHTML) into `out`.
    pub fn serialize_children(&self, node: NodeId, out: &mut String) {
        // "If the node serializes as void, return the empty string."
        if self.ns_of(node) == Ns::Html && self.is_element(node) && is_void(self.local(node)) {
            return;
        }
        let container = self.serialization_children_of(node);
        if container == 0 {
            return;
        }
        // Stack of (element, its serialization container) whose end tags are pending.
        let mut stack: Vec<(NodeId, NodeId)> = Vec::new();
        let mut n = self.rec(container).first;
        let mut parent_container = container;
        while n != 0 {
            if self.open_node(n, out) {
                let c = self.serialization_children_of(n);
                let first = if c == 0 { 0 } else { self.rec(c).first };
                if first != 0 {
                    stack.push((n, parent_container));
                    parent_container = c;
                    n = first;
                    continue;
                }
                self.close_element(n, out);
            }
            // Advance: next sibling, or close ancestors.
            loop {
                let next = self.rec(n).next;
                if next != 0 {
                    n = next;
                    break;
                }
                match stack.pop() {
                    Some((el, pc)) => {
                        self.close_element(el, out);
                        n = el;
                        parent_container = pc;
                    }
                    None => {
                        n = 0;
                        break;
                    }
                }
            }
        }
        let _ = parent_container;
    }

    /// Serializes `node` itself (outerHTML) into `out`.
    pub fn serialize_node(&self, node: NodeId, out: &mut String) {
        match self.kind(node) {
            kind::DOCUMENT | kind::FRAGMENT => self.serialize_children(node, out),
            kind::ELEMENT => {
                if self.open_node(node, out) {
                    self.serialize_children(node, out);
                    self.close_element(node, out);
                }
            }
            _ => {
                self.open_node(node, out);
            }
        }
    }

    /// innerHTML getter into the scratch buffer.
    pub fn inner_html(&mut self, node: NodeId) -> &str {
        let mut out = std::mem::take(&mut self.scratch);
        out.clear();
        self.serialize_children(node, &mut out);
        self.scratch = out;
        &self.scratch
    }

    /// outerHTML getter into the scratch buffer.
    pub fn outer_html(&mut self, node: NodeId) -> &str {
        let mut out = std::mem::take(&mut self.scratch);
        out.clear();
        self.serialize_node(node, &mut out);
        self.scratch = out;
        &self.scratch
    }
}

natives! {
    /// innerHTML getter (children of `id`; template contents for templates).
    fn innerHTMLGet(e, id: u32) -> &str {
        e.inner_html(id)
    }
    /// outerHTML getter.
    fn outerHTMLGet(e, id: u32) -> &str {
        e.outer_html(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::DocKind;
    use crate::node::Ns;

    fn roundtrip(e: &mut Env, html: &str) -> String {
        let doc = e.create_document(DocKind::Html, None);
        let div = e.create_element(doc, atom::DIV, Ns::Html);
        e.set_inner_html(div, html).unwrap();
        e.inner_html(div).to_string()
    }

    #[test]
    fn escaping() {
        let mut s = String::new();
        escape(&mut s, "<a&b> \u{a0}\"", false, false);
        assert_eq!(s, "&lt;a&amp;b&gt; &nbsp;\"");
        s.clear();
        escape(&mut s, "a\"b&<\u{a0}", true, false);
        assert_eq!(s, "a&quot;b&amp;<&nbsp;");
        // Latin-1 / other A0 continuation bytes are not NBSP; NBSP at both ends; ASCII fast path.
        for (input, want) in [
            ("\u{a0}x\u{a0}", "&nbsp;x&nbsp;"),
            ("\u{e0}\u{420}\u{a1}<", "\u{e0}\u{420}\u{a1}&lt;"),
            ("\u{c2}\u{a0}\u{a0}", "\u{c2}&nbsp;&nbsp;"),
            ("plain", "plain"),
            ("&&", "&amp;&amp;"),
        ] {
            s.clear();
            escape(&mut s, input, false, input.is_ascii());
            assert_eq!(s, want, "{input:?}");
        }
    }

    #[test]
    fn parse_serialize() {
        let mut e = Env::new();
        assert_eq!(
            roundtrip(&mut e, "<table><tr><td>x</table><br><img>"),
            "<table><tbody><tr><td>x</td></tr></tbody></table><br><img>"
        );
        assert_eq!(roundtrip(&mut e, "<p>a<b>b</p>c"), "<p>a<b>b</b></p><b>c</b>");
        assert_eq!(
            roundtrip(&mut e, "<!--c--><svg viewBox='0 0 1 1'><path d='M0'/></svg>"),
            "<!--c--><svg viewBox=\"0 0 1 1\"><path d=\"M0\"></path></svg>"
        );
        assert_eq!(roundtrip(&mut e, "<template><i>t</i></template>"), "<template><i>t</i></template>");
        assert_eq!(roundtrip(&mut e, "<style>a<b</style>&amp;&nbsp;"), "<style>a<b</style>&amp;&nbsp;");
        assert_eq!(roundtrip(&mut e, "ü😀"), "ü😀");
    }

    #[test]
    fn deep_tree_does_not_overflow() {
        let mut e = Env::new();
        let html = "<div>".repeat(5000);
        let out = roundtrip(&mut e, &html);
        assert!(out.starts_with("<div><div>"));
    }
}
