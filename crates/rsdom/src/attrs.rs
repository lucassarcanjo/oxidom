//! Attributes: get/set/remove/toggle (qualified-name and namespaced variants), NamedNodeMap bulk egress,
//! and the cached id / class / flag state derived from attributes.
//!
//! Name lowercasing for HTML elements in HTML documents happens in the facade before the atom is chosen
//! (DESIGN §11 Interning); Rust matches qualified names exactly. Every change runs `hook_attr_changed`
//! (attr_ver / EP[ATTR] / MO / style / forms); a same-value set (spec: still a change) of an attribute
//! with derived state (`has_derived_state`) only queues the MO record and runs the forms attribute change
//! steps (`hook_attr_same_value`).

use crate::atoms::{Atom, atom};
use crate::env::Env;
use crate::error::{Code, DomError, DomResult, code};
use crate::node::{Attr, meta};
use crate::string::Str;
use crate::table::NodeId;

/// Attributes whose sets do expensive derived work (class tokens, the id map, the inline style block,
/// unconditional style invalidation): a same-value set of one of them takes `hook_attr_same_value`.
/// Other same-value sets take the normal path (comparing every value would cost every changing set a
/// few ns for no measurable gain).
#[inline]
fn has_derived_state(local: Atom, ns: Atom) -> bool {
    ns.is_none()
        && matches!(
            local,
            atom::CLASS | atom::ID | atom::STYLE | atom::TYPE | atom::HIDDEN | atom::OPEN | atom::POPOVER
        )
}

impl Env {
    /// `getAttribute(qname)`.
    #[inline]
    pub fn get_attr(&self, el: NodeId, qname: Atom) -> Option<&Str> {
        self.elem(el)?.get(qname)
    }

    /// `hasAttribute(qname)`.
    #[inline]
    pub fn has_attr(&self, el: NodeId, qname: Atom) -> bool {
        self.elem(el).is_some_and(|d| d.find(qname).is_some())
    }

    /// `setAttribute(qname, value)`: replaces the first attribute with that qualified name in place, or
    /// appends a new no-namespace attribute.
    #[inline]
    pub fn set_attr(&mut self, el: NodeId, qname: Atom, value: &str) -> DomResult {
        let d = self.elem_mut(el).ok_or(DomError::Type)?;
        match d.find(qname) {
            Some(i) => {
                let a = &mut d.attrs[i];
                let (local, ns) = (a.local, a.ns);
                if has_derived_state(local, ns) && a.value.as_str() == value {
                    self.hook_attr_same_value(el, local, ns);
                    return Ok(());
                }
                let old = std::mem::replace(&mut a.value, Str::from(value));
                self.after_attr_change(el, local, ns, Some(old));
            }
            None => {
                let value = Str::from(value);
                d.attrs.push(Attr { local: qname, qname, ns: Atom::NONE, prefix: Atom::NONE, value });
                self.after_attr_change(el, qname, Atom::NONE, None);
            }
        }
        Ok(())
    }

    /// `removeAttribute(qname)`; returns whether something was removed.
    pub fn remove_attr(&mut self, el: NodeId, qname: Atom) -> bool {
        let Some(d) = self.elem_mut(el) else { return false };
        let Some(i) = d.find(qname) else { return false };
        let a = d.attrs.remove(i);
        self.after_attr_change(el, a.local, a.ns, Some(a.value));
        true
    }

    /// `toggleAttribute(qname, force)`; `force`: 0 none, 1 false, 2 true. Returns the new presence.
    pub fn toggle_attr(&mut self, el: NodeId, qname: Atom, force: u32) -> DomResult<bool> {
        let present = self.elem(el).ok_or(DomError::Type)?.find(qname).is_some();
        match (present, force) {
            (false, 0 | 2) => {
                self.set_attr(el, qname, "")?;
                Ok(true)
            }
            (false, _) => Ok(false),
            (true, 0 | 1) => {
                self.remove_attr(el, qname);
                Ok(false)
            }
            (true, _) => Ok(true),
        }
    }

    /// `getAttributeNS(ns, local)`.
    pub fn get_attr_ns(&self, el: NodeId, ns: Option<&str>, local: &str) -> Option<&Str> {
        let d = self.elem(el)?;
        let ns = match ns.filter(|s| !s.is_empty()) {
            Some(s) => self.atoms.get(s)?,
            None => Atom::NONE,
        };
        let local = self.atoms.get(local)?;
        d.find_ns(ns, local).map(|i| &d.attrs[i].value)
    }

    /// `setAttributeNS(ns, qname, value)`.
    pub fn set_attr_ns(&mut self, el: NodeId, ns: Option<&str>, qname: &str, value: &str) -> DomResult {
        if self.elem(el).is_none() {
            return Err(DomError::Type);
        }
        let (ns, prefix, local) = self.validate_and_extract(ns, qname, false)?;
        let qn = if prefix.is_none() { local } else { self.intern(qname) };
        let d = self.elem_mut(el).ok_or(DomError::Type)?;
        match d.find_ns(ns, local) {
            Some(i) => {
                if has_derived_state(local, ns) && d.attrs[i].value.as_str() == value {
                    self.hook_attr_same_value(el, local, ns);
                    return Ok(());
                }
                let old = std::mem::replace(&mut d.attrs[i].value, Str::from(value));
                self.after_attr_change(el, local, ns, Some(old));
            }
            None => {
                d.attrs.push(Attr { local, qname: qn, ns, prefix, value: Str::from(value) });
                self.after_attr_change(el, local, ns, None);
            }
        }
        Ok(())
    }

    /// `removeAttributeNS(ns, local)`.
    pub fn remove_attr_ns(&mut self, el: NodeId, ns: Option<&str>, local: &str) -> bool {
        let ns = match ns.filter(|s| !s.is_empty()) {
            Some(s) => match self.atoms.get(s) {
                Some(a) => a,
                None => return false,
            },
            None => Atom::NONE,
        };
        let Some(local) = self.atoms.get(local) else { return false };
        let Some(d) = self.elem_mut(el) else { return false };
        let Some(i) = d.find_ns(ns, local) else { return false };
        let a = d.attrs.remove(i);
        self.after_attr_change(el, a.local, a.ns, Some(a.value));
        true
    }

    /// Derived-state maintenance + hooks after any attribute change.
    fn after_attr_change(&mut self, el: NodeId, local: Atom, ns: Atom, old: Option<Str>) {
        if ns.is_none() {
            match local {
                atom::ID => self.update_id_cache(el),
                atom::CLASS => {
                    // Tokenize the stored value in place (moved out and back: no clone of the value).
                    let taken = self.take_attr_value(el, atom::CLASS);
                    let classes = match &taken {
                        Some((_, v)) => self.split_classes(v),
                        None => Default::default(),
                    };
                    let has = taken.is_some();
                    if let Some(d) = self.elem_mut(el) {
                        if let Some((i, v)) = taken {
                            d.attrs[i].value = v;
                        }
                        d.classes = classes;
                    }
                    self.set_meta_flag(el, meta::HAS_CLASS, has);
                }
                atom::STYLE => {
                    let has = self.has_attr(el, atom::STYLE);
                    self.set_meta_flag(el, meta::HAS_STYLE, has);
                }
                atom::DISABLED => {
                    let has = self.has_attr(el, atom::DISABLED);
                    self.set_meta_flag(el, meta::DISABLED_ATTR, has);
                }
                _ => {}
            }
        }
        self.hook_attr_changed(el, local, ns, old.as_ref());
    }

    /// Moves the value of attribute `qname` out of the element (index, value); the caller puts it back.
    /// Lets derived-state code tokenize/intern a value while `&mut self` is needed, without cloning it.
    fn take_attr_value(&mut self, el: NodeId, qname: Atom) -> Option<(usize, Str)> {
        let d = self.elem_mut(el)?;
        let i = d.find(qname)?;
        Some((i, std::mem::take(&mut d.attrs[i].value)))
    }

    fn set_meta_flag(&mut self, el: NodeId, flag: u32, on: bool) {
        let r = self.rec_mut(el);
        if on {
            r.meta |= flag;
        } else {
            r.meta &= !flag;
        }
    }

    /// Re-derives the cached `id` atom and keeps the document id map in sync for connected elements.
    fn update_id_cache(&mut self, el: NodeId) {
        let taken = self.take_attr_value(el, atom::ID);
        let has = taken.is_some();
        let new = match &taken {
            Some((_, v)) if !v.is_empty() => self.intern(v),
            _ => Atom::NONE,
        };
        if let (Some((i, v)), Some(d)) = (taken, self.elem_mut(el)) {
            d.attrs[i].value = v;
        }
        let old = self.elem(el).map_or(Atom::NONE, |d| d.id);
        if old == new {
            self.set_meta_flag(el, meta::HAS_ID, has);
            return;
        }
        // the id map holds elements in a document tree only (shadow trees are connected but not in it)
        let connected = self.in_document_tree(el);
        if connected && !old.is_none() {
            self.id_map_remove_atom(el, old);
        }
        if let Some(d) = self.elem_mut(el) {
            d.id = new;
        }
        self.set_meta_flag(el, meta::HAS_ID, has);
        if connected {
            self.id_map_add(el);
        }
    }

    /// Value of the attribute (namespace atom, local atom).
    #[inline]
    pub fn get_attr_by_atoms(&self, el: NodeId, ns: Atom, local: Atom) -> Option<&Str> {
        let d = self.elem(el)?;
        d.find_ns(ns, local).map(|i| &d.attrs[i].value)
    }

    /// Sets the attribute (namespace atom, local atom), creating it with `prefix` if absent (Attr.value).
    pub fn set_attr_by_atoms(
        &mut self,
        el: NodeId,
        ns: Atom,
        local: Atom,
        prefix: Atom,
        value: &str,
    ) -> DomResult {
        if !self.atoms.is_valid(local) || (!ns.is_none() && !self.atoms.is_valid(ns)) {
            return Err(DomError::InvalidCharacter);
        }
        let qname = if prefix.is_none() {
            local
        } else {
            let q = format!("{}:{}", self.atoms.name(prefix), self.atoms.name(local));
            self.intern(&q)
        };
        let d = self.elem_mut(el).ok_or(DomError::Type)?;
        let new = Str::from(value);
        match d.find_ns(ns, local) {
            Some(i) => {
                let old = std::mem::replace(&mut d.attrs[i].value, new);
                self.after_attr_change(el, local, ns, Some(old));
            }
            None => {
                d.attrs.push(Attr { local, qname, ns, prefix, value: new });
                self.after_attr_change(el, local, ns, None);
            }
        }
        Ok(())
    }

    /// Writes `[qname, ns, prefix, local]` per attribute into OUT; returns the count.
    pub fn attr_names_out(&mut self, el: NodeId) -> u32 {
        let mut ids = std::mem::take(&mut self.ids);
        ids.clear();
        if let Some(d) = self.elem(el) {
            for a in &d.attrs {
                ids.extend_from_slice(&[a.qname.0, a.ns.0, a.prefix.0, a.local.0]);
            }
        }
        self.ids = ids;
        self.write_ids() / 4
    }

    /// All attribute values concatenated (returned as one string) and
    /// `OUT = [n, (qname, ns, prefix, local, start16, len16) x n]` (one crossing for NamedNodeMap).
    pub fn attrs_all(&mut self, el: NodeId) -> &str {
        let mut s = std::mem::take(&mut self.scratch);
        let mut ids = std::mem::take(&mut self.ids);
        s.clear();
        ids.clear();
        ids.push(0);
        let mut pos16 = 0u32;
        if let Some(d) = self.elem(el) {
            ids[0] = d.attrs.len() as u32;
            for a in &d.attrs {
                let len16 = a.value.utf16_len();
                ids.extend_from_slice(&[a.qname.0, a.ns.0, a.prefix.0, a.local.0, pos16, len16]);
                s.push_str(&a.value);
                pos16 += len16;
            }
        }
        self.ids = ids;
        self.write_ids();
        self.scratch = s;
        &self.scratch
    }

    /// Class tokens (atoms) into OUT; returns the count.
    pub fn class_tokens_out(&mut self, el: NodeId) -> u32 {
        let mut ids = std::mem::take(&mut self.ids);
        ids.clear();
        if let Some(d) = self.elem(el) {
            ids.extend(d.classes.iter().map(|a| a.0));
        }
        self.ids = ids;
        self.write_ids()
    }
}

natives! {
    /// getAttribute by qualified-name atom (null if absent).
    fn getAttr(e, id: u32, a: u32) -> Option<&Str> {
        e.get_attr(id, Atom(a))
    }
    /// hasAttribute by qualified-name atom.
    fn hasAttr(e, id: u32, a: u32) -> bool {
        e.has_attr(id, Atom(a))
    }
    /// setAttribute (name already validated + lowercased by the facade). Returns 0 or an error code.
    fn setAttr(e, id: u32, a: u32, value: str) -> Code {
        if !e.atoms.is_valid(Atom(a)) { DomError::InvalidCharacter as u32 } else { code(e.set_attr(id, Atom(a), value)) }
    }
    /// removeAttribute; true if an attribute was removed.
    fn removeAttr(e, id: u32, a: u32) -> bool {
        e.remove_attr(id, Atom(a))
    }
    /// toggleAttribute(name, force 0 none / 1 false / 2 true): 1 = present after, 0 = absent, >= 16 = error code + 16.
    fn toggleAttr(e, id: u32, a: u32, force: u32) -> u32 {
        if !e.atoms.is_valid(Atom(a)) { 16 + DomError::InvalidCharacter as u32 } else {
            match e.toggle_attr(id, Atom(a), force) { Ok(b) => b as u32, Err(err) => 16 + err as u32 }
        }
    }
    /// getAttributeNS.
    fn getAttrNS(e, id: u32, ns: ostr, local: str) -> Option<&Str> {
        e.get_attr_ns(id, ns, local)
    }
    /// hasAttributeNS.
    fn hasAttrNS(e, id: u32, ns: ostr, local: str) -> bool {
        e.get_attr_ns(id, ns, local).is_some()
    }
    /// setAttributeNS. Returns 0 or an error code.
    fn setAttrNS(e, id: u32, ns: ostr, qname: str, value: str) -> Code {
        code(e.set_attr_ns(id, ns, qname, value))
    }
    /// removeAttributeNS; true if removed.
    fn removeAttrNS(e, id: u32, ns: ostr, local: str) -> bool {
        e.remove_attr_ns(id, ns, local)
    }
    /// getAttributeNS by atoms (namespace atom 0 = null).
    fn getAttrNSA(e, id: u32, ns: u32, local: u32) -> Option<&Str> {
        e.get_attr_by_atoms(id, Atom(ns), Atom(local))
    }
    /// Set the attribute (namespace atom, local atom), creating it with `prefix` if absent. Returns 0 or an error code.
    fn setAttrNSA(e, id: u32, ns: u32, local: u32, prefix: u32, value: str) -> Code {
        code(e.set_attr_by_atoms(id, Atom(ns), Atom(local), Atom(prefix), value))
    }
    /// Number of attributes of `id` (0 for non-elements): hasAttributes() without an OUT write.
    fn attrCount(e, id: u32) -> u32 {
        e.elem(id).map_or(0, |d| d.attrs.len() as u32)
    }
    /// Attribute name atoms into OUT as (qname, ns, prefix, local) quads; returns the count.
    fn attrNames(e, id: u32) -> u32 {
        e.attr_names_out(id)
    }
    /// All values concatenated + OUT = [n, (qname, ns, prefix, local, start16, len16) x n].
    fn attrsAll(e, id: u32) -> &str {
        e.attrs_all(id)
    }
    /// Class token atoms into OUT; returns the count.
    fn classTokens(e, id: u32) -> u32 {
        e.class_tokens_out(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::DocKind;
    use crate::node::Ns;

    #[test]
    fn order_and_same_value() {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let d = e.create_element(doc, atom::DIV, Ns::Html);
        let b = e.intern("b");
        let a = e.intern("a");
        e.set_attr(d, b, "1").unwrap();
        e.set_attr(d, a, "2").unwrap();
        let v0 = e.rec(d).attr_ver;
        e.set_attr(d, b, "3").unwrap();
        assert!(e.rec(d).attr_ver != v0, "same-name set bumps attr_ver");
        let names: Vec<_> = e
            .elem(d)
            .unwrap()
            .attrs
            .iter()
            .map(|x| (e.atoms.name(x.qname).to_string(), x.value.to_string()))
            .collect();
        assert_eq!(names, vec![("b".into(), "3".into()), ("a".into(), "2".into())]);
        assert!(e.remove_attr(d, b));
        assert!(!e.remove_attr(d, b));
        assert_eq!(e.toggle_attr(d, atom::HIDDEN, 0), Ok(true));
        assert_eq!(e.get_attr(d, atom::HIDDEN).map(|s| s.as_str()), Some(""));
        assert_eq!(e.toggle_attr(d, atom::HIDDEN, 2), Ok(true));
        assert_eq!(e.toggle_attr(d, atom::HIDDEN, 0), Ok(false));
    }

    #[test]
    fn class_and_flags() {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let d = e.create_element(doc, atom::DIV, Ns::Html);
        e.set_attr(d, atom::CLASS, " a  b\tc ").unwrap();
        assert_eq!(e.elem(d).unwrap().classes.len(), 3);
        assert!(e.rec(d).meta & meta::HAS_CLASS != 0);
        e.remove_attr(d, atom::CLASS);
        assert!(e.rec(d).meta & meta::HAS_CLASS == 0);
        assert!(e.elem(d).unwrap().classes.is_empty());
    }

    #[test]
    fn namespaced() {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let d = e.create_element(doc, atom::SVG, Ns::Svg);
        e.set_attr_ns(d, Some("http://www.w3.org/1999/xlink"), "xlink:href", "#a").unwrap();
        assert_eq!(e.get_attr(d, atom::XLINK_HREF).map(|s| s.as_str()), Some("#a"));
        assert_eq!(
            e.get_attr_ns(d, Some("http://www.w3.org/1999/xlink"), "href").map(|s| s.as_str()),
            Some("#a")
        );
        assert_eq!(e.set_attr_ns(d, None, "x:y", "1"), Err(DomError::Namespace));
        assert_eq!(e.set_attr_ns(d, None, "a b", "1"), Err(DomError::InvalidCharacter));
        assert!(e.remove_attr_ns(d, Some("http://www.w3.org/1999/xlink"), "href"));
    }
}
