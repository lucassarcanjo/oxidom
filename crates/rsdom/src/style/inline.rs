//! `element.style`: the inline declaration block (DESIGN §8.1).
//!
//! The block lives in `ElementExt.style` and is authoritative once it exists. Elements whose `style`
//! attribute was set by the parser, by cloning or by `setAttribute` have no block until something reads
//! the style: it is parsed lazily from the attribute (`ensure_inline`). Every CSSOM mutation re-serializes
//! the block into the `style` attribute (only when the serialization changed, like jsdom), through the
//! normal attribute path so `attr_ver`, MutationObserver records and the STYLE epoch stay correct; the
//! `syncing` flag keeps that write from dropping the block again.

use cssparser::{
    AtRuleParser, CowRcStr, DeclarationParser, ParseError, Parser, ParserState, QualifiedRuleParser,
    RuleBodyItemParser, RuleBodyParser,
};
use smallvec::SmallVec;

use super::props::{CUSTOM_BASE, props};
use super::value::{self, Parsed};
use crate::atoms::{Atom, atom};
use crate::env::Env;
use crate::node::meta;
use crate::table::NodeId;

/// One declaration (longhand, non-expanded property, custom property, or a shorthand holding `var()`).
#[derive(Debug, Clone, PartialEq)]
pub struct Decl {
    /// Property id (`CUSTOM_BASE + atom` for custom properties).
    pub prop: u32,
    /// Normalised value.
    pub value: compact_str::CompactString,
    /// `!important`.
    pub important: bool,
}

/// A declaration block in insertion order (inline styles and stylesheet rules).
#[derive(Default, Debug, Clone)]
pub struct InlineStyle {
    /// Declarations.
    pub decls: SmallVec<[Decl; 4]>,
}

impl InlineStyle {
    /// Value of property `p` (longhand or stored property).
    pub fn get(&self, p: u32) -> Option<&Decl> {
        self.decls.iter().find(|d| d.prop == p)
    }

    /// Sets (or replaces in place) one declaration; true if the block changed.
    pub fn set(&mut self, p: u32, v: &str, important: bool) -> bool {
        match self.decls.iter_mut().find(|d| d.prop == p) {
            Some(d) if d.value == v && d.important == important => false,
            Some(d) => {
                d.value = v.into();
                d.important = important;
                true
            }
            None => {
                self.decls.push(Decl { prop: p, value: v.into(), important });
                true
            }
        }
    }

    /// Removes property `p` and, for an expanded shorthand, its longhands. True if anything was removed.
    pub fn remove(&mut self, p: u32) -> bool {
        let n = self.decls.len();
        if value::is_expanded_shorthand(p) {
            let longs = value::longhands(p);
            self.decls.retain(|d| d.prop != p && !longs.contains(&d.prop));
        } else {
            self.decls.retain(|d| d.prop != p);
        }
        self.decls.len() != n
    }

    /// Applies a parsed declaration; true if the block changed.
    pub fn apply(&mut self, p: u32, parsed: Parsed, important: bool) -> bool {
        let n = self.decls.len();
        match parsed {
            Parsed::One(v) => {
                if value::is_expanded_shorthand(p) {
                    // a shorthand holding var(): drop its longhands, keep the shorthand text
                    let longs = value::longhands(p);
                    self.decls.retain(|d| !longs.contains(&d.prop));
                }
                let changed = self.set(p, &v, important);
                changed || self.decls.len() != n
            }
            Parsed::Many(list) => {
                self.decls.retain(|d| d.prop != p);
                let mut changed = self.decls.len() != n;
                for (l, v) in list {
                    changed |= self.set(l, &v, important);
                }
                changed
            }
        }
    }

    /// `getPropertyValue(p)`: a stored value, or a shorthand serialized from its longhands (all present
    /// with the same importance).
    pub fn value_of(&self, p: u32) -> Option<String> {
        if let Some(d) = self.get(p) {
            return Some(d.value.to_string());
        }
        if !value::is_expanded_shorthand(p) {
            return None;
        }
        let longs = value::longhands(p);
        let imp = self.get(*longs.first()?)?.important;
        if longs.iter().any(|&l| self.get(l).is_none_or(|d| d.important != imp)) {
            return None;
        }
        value::serialize_shorthand(p, &|l| self.get(l).map(|d| d.value.as_str()))
    }

    /// `getPropertyPriority(p)`.
    pub fn important(&self, p: u32) -> bool {
        if let Some(d) = self.get(p) {
            return d.important;
        }
        if value::is_expanded_shorthand(p) {
            let longs = value::longhands(p);
            return longs.iter().all(|&l| self.get(l).is_some_and(|d| d.important));
        }
        false
    }

    /// CSSOM "serialize a CSS declaration block" (shorthands where all longhands are present).
    pub fn css_text(&self, e: &Env, out: &mut String) {
        out.clear();
        let pr = props();
        let mut done: SmallVec<[bool; 16]> = SmallVec::from_elem(false, self.decls.len());
        for (i, d) in self.decls.iter().enumerate() {
            if done[i] {
                continue;
            }
            let mut emitted = false;
            let shorthands =
                if d.prop < CUSTOM_BASE { pr.info(d.prop).map_or(&[][..], |x| &x.shorthands) } else { &[] };
            for &sh in shorthands {
                let longs = value::longhands(sh);
                let mut idx: SmallVec<[usize; 13]> = SmallVec::new();
                for &l in longs {
                    match self.decls.iter().position(|x| x.prop == l) {
                        Some(j) if !done[j] && self.decls[j].important == d.important => idx.push(j),
                        _ => break,
                    }
                }
                if idx.len() != longs.len() {
                    continue;
                }
                let vals: SmallVec<[&str; 13]> = idx.iter().map(|&j| self.decls[j].value.as_str()).collect();
                if let Some(v) = value::serialize_values(sh, &vals) {
                    push_decl(out, pr.info(sh).map_or("", |i| i.name), &v, d.important);
                    for j in idx {
                        done[j] = true;
                    }
                    emitted = true;
                    break;
                }
            }
            if !emitted {
                push_decl(out, prop_name(e, d.prop), &d.value, d.important);
                done[i] = true;
            }
        }
        if out.ends_with(' ') {
            out.pop();
        }
    }

    /// Parses a declaration list (`style` attribute / `cssText`), dropping invalid declarations.
    pub fn parse(e: &mut Env, text: &str) -> InlineStyle {
        let mut parser = Parser::new(text);
        let r = parse_block_with(&mut parser, &mut |n| e.intern(n));
        e.ep.set(crate::env::ep::ATOM_LEN, e.atoms.len());
        r
    }
}

/// Parses the declarations of `input` (a declaration list or a rule body); custom property names are
/// interned through `intern`.
pub(crate) fn parse_block_with(input: &mut Parser, intern: &mut dyn FnMut(&str) -> Atom) -> InlineStyle {
    let mut st = InlineStyle::default();
    let mut dp = DeclParser { intern, out: &mut st };
    let body = RuleBodyParser::new(input, &mut dp);
    for r in body {
        let _ = r;
    }
    st
}

fn push_decl(out: &mut String, name: &str, v: &str, important: bool) {
    out.push_str(name);
    out.push_str(": ");
    out.push_str(v);
    if important {
        out.push_str(" !important");
    }
    out.push_str("; ");
}

/// Property name of an id (custom properties: the interned name).
pub fn prop_name(e: &Env, p: u32) -> &str {
    if p >= CUSTOM_BASE {
        e.atoms.name(Atom(p - CUSTOM_BASE))
    } else {
        props().info(p).map_or("", |i| i.name)
    }
}

/// Property id of a name as the CSSOM sees it: custom properties (`--x`) case-sensitively (interned),
/// others ASCII-lowercased. None = unknown property.
pub fn prop_id(e: &mut Env, name: &str) -> Option<u32> {
    prop_id_with(name, &mut |n| e.intern(n))
}

/// [`prop_id`] with an explicit interner (stylesheet parsing runs with the env's interner moved out).
pub(crate) fn prop_id_with(name: &str, intern: &mut dyn FnMut(&str) -> Atom) -> Option<u32> {
    if name.starts_with("--") {
        if name.len() < 3 {
            return None;
        }
        return Some(CUSTOM_BASE + intern(name).0);
    }
    if name.bytes().any(|b| b.is_ascii_uppercase()) {
        props().id(&name.to_ascii_lowercase())
    } else {
        props().id(name)
    }
}

struct DeclParser<'a, 'b> {
    intern: &'a mut (dyn FnMut(&str) -> Atom + 'b),
    out: &'a mut InlineStyle,
}

impl<'i> DeclarationParser<'i> for DeclParser<'_, '_> {
    type Declaration = ();
    type Error = ();

    fn parse_value(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i>,
        _start: &ParserState,
    ) -> Result<(), ParseError<()>> {
        parse_declaration_into(&name, input, self.intern, self.out);
        Ok(())
    }
}

/// Parses the value of declaration `name` (the rest of `input`, `!important` included) into `out`,
/// dropping it when the property is unknown or the value invalid. Shared with the CSSOM rule bodies
/// (`cssom.rs`).
pub(crate) fn parse_declaration_into(
    name: &str,
    input: &mut Parser,
    intern: &mut dyn FnMut(&str) -> Atom,
    out: &mut InlineStyle,
) {
    let (text, important) = declaration_value(input);
    let Some(p) = prop_id_with(name, intern) else { return };
    if let Some(parsed) = value::parse_declaration(p, text) {
        out.apply(p, parsed, important);
    }
}

/// The value text of a declaration (consumes `input`) and whether it ends in `!important`.
pub(crate) fn declaration_value<'i>(input: &mut Parser<'i>) -> (&'i str, bool) {
    let start = input.position();
    let mut bang = None;
    loop {
        let pos = input.position();
        match input.next() {
            Err(_) => break,
            Ok(cssparser::Token::Delim('!')) => {
                let st = input.state();
                if input.expect_ident_matching("important").is_ok() && input.is_exhausted() {
                    bang = Some(pos);
                    break;
                }
                input.reset(&st);
            }
            Ok(_) => {}
        }
    }
    let important = bang.is_some();
    let end = bang.unwrap_or_else(|| input.position());
    (input.slice(start..end), important)
}

impl<'i> AtRuleParser<'i> for DeclParser<'_, '_> {
    type Prelude = ();
    type AtRule = ();
    type Error = ();
}

impl<'i> QualifiedRuleParser<'i> for DeclParser<'_, '_> {
    type Prelude = ();
    type QualifiedRule = ();
    type Error = ();
}

impl<'i> RuleBodyItemParser<'i, (), ()> for DeclParser<'_, '_> {
    fn parse_declarations(&self) -> bool {
        true
    }

    fn parse_qualified(&self) -> bool {
        false
    }
}

// ------------------------------------------------------------------------------------------ Env

impl Env {
    /// The element's inline block, parsing it from the `style` attribute on first use.
    pub fn ensure_inline(&mut self, el: NodeId) -> bool {
        let r = *self.rec(el);
        let Some(d) = self.elem(el) else { return false };
        if d.ext.as_ref().is_some_and(|x| x.style.is_some()) {
            return true;
        }
        let st = if r.meta & meta::HAS_STYLE != 0 {
            let text = d.get(atom::STYLE).map(|s| s.to_string()).unwrap_or_default();
            InlineStyle::parse(self, &text)
        } else {
            InlineStyle::default()
        };
        if let Some(d) = self.elem_mut(el) {
            d.ext_mut().style = Some(Box::new(st));
        }
        true
    }

    /// The parsed inline block (call `ensure_inline` first).
    #[inline]
    pub fn inline(&self, el: NodeId) -> Option<&InlineStyle> {
        self.elem(el)?.ext.as_ref()?.style.as_deref()
    }

    fn inline_mut(&mut self, el: NodeId) -> Option<&mut InlineStyle> {
        self.elem_mut(el)?.ext.as_mut()?.style.as_deref_mut()
    }

    /// Runs a CSSOM mutation on the inline block and writes the `style` attribute if the serialization
    /// changed (jsdom `_updateStyle`).
    fn mutate_inline(&mut self, el: NodeId, f: impl FnOnce(&mut Env, &mut InlineStyle) -> bool) {
        if !self.ensure_inline(el) {
            return;
        }
        let Some(mut st) = self.elem_mut(el).and_then(|d| d.ext.as_mut()).and_then(|x| x.style.take()) else {
            return;
        };
        // A changed declaration list always changes the serialization (every declaration is printed,
        // alone or inside a shorthand), so the mutation's own change report replaces jsdom's cssText
        // comparison.
        let changed = f(self, &mut st);
        let mut text = String::new();
        if changed {
            // `name: value; ` per declaration, sized once instead of grown piecewise
            text.reserve(st.decls.iter().map(|d| d.value.len() + 40).sum());
            st.css_text(self, &mut text);
        }
        if let Some(x) = self.elem_mut(el).and_then(|d| d.ext.as_mut()) {
            x.style = Some(st);
        }
        if changed {
            self.style.syncing = true;
            let _ = self.set_attr(el, atom::STYLE, &text);
            self.style.syncing = false;
        }
    }

    /// `style.getPropertyValue` by id ("" if unset).
    pub fn style_get(&mut self, el: NodeId, p: u32) -> &str {
        self.ensure_inline(el);
        let mut s = std::mem::take(&mut self.scratch);
        s.clear();
        if let Some(st) = self.inline(el) {
            match st.get(p) {
                Some(d) => s.push_str(&d.value),
                None => {
                    if let Some(v) = st.value_of(p) {
                        s.push_str(&v);
                    }
                }
            }
        }
        self.scratch = s;
        &self.scratch
    }

    /// `style.setProperty(p, value, important)`; an empty value removes the property.
    pub fn style_set(&mut self, el: NodeId, p: u32, v: &str, important: bool) {
        if v.trim().is_empty() {
            self.mutate_inline(el, |_, st| st.remove(p));
            return;
        }
        let Some(parsed) = value::parse_declaration(p, v) else { return };
        self.mutate_inline(el, |_, st| st.apply(p, parsed, important));
    }

    /// `style.removeProperty(p)`: returns the old value.
    pub fn style_remove(&mut self, el: NodeId, p: u32) -> &str {
        self.ensure_inline(el);
        let old = self.inline(el).and_then(|s| s.value_of(p)).unwrap_or_default();
        self.mutate_inline(el, |_, st| st.remove(p));
        self.scratch.clear();
        self.scratch.push_str(&old);
        &self.scratch
    }

    /// `style.cssText` getter.
    pub fn style_css_text(&mut self, el: NodeId) -> &str {
        self.ensure_inline(el);
        let mut s = std::mem::take(&mut self.scratch);
        match self.inline(el) {
            Some(st) => st.css_text(self, &mut s),
            None => s.clear(),
        }
        self.scratch = s;
        &self.scratch
    }

    /// `style.cssText` setter.
    pub fn style_css_text_set(&mut self, el: NodeId, text: &str) {
        let parsed = InlineStyle::parse(self, text);
        self.mutate_inline(el, |_, st| {
            let changed = st.decls != parsed.decls;
            *st = parsed;
            changed
        });
    }

    /// `style.length`.
    pub fn style_len(&mut self, el: NodeId) -> u32 {
        self.ensure_inline(el);
        self.inline(el).map_or(0, |s| s.decls.len() as u32)
    }

    /// `style.item(i)` ("" when out of range).
    pub fn style_item(&mut self, el: NodeId, i: u32) -> &str {
        self.ensure_inline(el);
        let p = self.inline(el).and_then(|s| s.decls.get(i as usize)).map(|d| d.prop);
        match p {
            Some(p) => prop_name(self, p),
            None => "",
        }
    }

    /// Drops the parsed block (the `style` attribute changed outside the CSSOM).
    pub(crate) fn drop_inline(&mut self, el: NodeId) {
        if let Some(x) = self.elem_mut(el).and_then(|d| d.ext.as_mut()) {
            x.style = None;
        }
    }

    #[allow(dead_code)]
    fn inline_mut_for_tests(&mut self, el: NodeId) -> Option<&mut InlineStyle> {
        self.inline_mut(el)
    }
}

natives! {
    /// Custom property id for a `--name` (interned; 0 = not a custom property name).
    fn cssProp(e, name: str) -> u32 {
        if name.starts_with("--") { prop_id(e, name).unwrap_or(0) } else { 0 }
    }
    /// element.style.getPropertyValue by property id.
    fn styleGet(e, id: u32, p: u32) -> &str {
        e.style_get(id, p)
    }
    /// element.style.setProperty by id (`important`: priority "important"); empty value removes.
    fn styleSet(e, id: u32, p: u32, v: str, important: bool) -> () {
        e.style_set(id, p, v, important)
    }
    /// element.style.removeProperty by id; returns the old value.
    fn styleRemove(e, id: u32, p: u32) -> &str {
        e.style_remove(id, p)
    }
    /// element.style.getPropertyPriority by id (true = "important").
    fn stylePriority(e, id: u32, p: u32) -> bool {
        e.ensure_inline(id);
        e.inline(id).is_some_and(|s| s.important(p))
    }
    /// element.style.cssText getter.
    fn styleCssText(e, id: u32) -> &str {
        e.style_css_text(id)
    }
    /// element.style.cssText setter.
    fn styleCssTextSet(e, id: u32, text: str) -> () {
        e.style_css_text_set(id, text)
    }
    /// element.style.length.
    fn styleLen(e, id: u32) -> u32 {
        e.style_len(id)
    }
    /// element.style.item(i) ("" out of range).
    fn styleItem(e, id: u32, i: u32) -> &str {
        e.style_item(id, i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::DocKind;
    use crate::node::Ns;

    fn div() -> (Env, NodeId) {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let d = e.create_element(doc, atom::DIV, Ns::Html);
        (e, d)
    }

    fn pid(n: &str) -> u32 {
        props().id(n).unwrap()
    }

    #[test]
    fn set_get_serialize() {
        let (mut e, d) = div();
        e.style_set(d, pid("color"), "red", false);
        assert_eq!(e.style_css_text(d), "color: red;");
        assert_eq!(e.get_attr(d, atom::STYLE).map(|s| s.as_str()), Some("color: red;"));
        e.style_set(d, pid("margin"), "1px 2px", false);
        assert_eq!(e.style_css_text(d), "color: red; margin: 1px 2px;");
        assert_eq!(e.style_get(d, pid("margin-left")), "2px");
        e.style_set(d, pid("margin-top"), "3px", false);
        assert_eq!(e.style_get(d, pid("margin")), "3px 2px 1px");
        assert_eq!(e.style_remove(d, pid("margin")), "3px 2px 1px");
        assert_eq!(e.style_css_text(d), "color: red;");
        e.style_set(d, pid("color"), "", false);
        assert_eq!(e.style_css_text(d), "");
        assert_eq!(e.get_attr(d, atom::STYLE).map(|s| s.as_str()), Some(""));
    }

    #[test]
    fn css_text_and_attribute() {
        let (mut e, d) = div();
        e.style_css_text_set(d, "color: red; COLOR: blue; width: 10px !important; bogus: 1; height: x");
        assert_eq!(e.style_css_text(d), "color: blue; width: 10px !important;");
        e.set_attr(d, atom::STYLE, "color: nope; width:1px;;").unwrap();
        assert_eq!(e.style_css_text(d), "width: 1px;");
        assert_eq!(e.get_attr(d, atom::STYLE).map(|s| s.as_str()), Some("color: nope; width:1px;;"));
        e.style_set(d, pid("border"), "1px solid red", false);
        assert_eq!(e.style_css_text(d), "width: 1px; border: 1px solid red;");
        let custom = prop_id(&mut e, "--Foo").unwrap();
        e.style_set(d, custom, " bar ", false);
        assert_eq!(e.style_get(d, custom), "bar");
        assert_eq!(e.style_len(d), 15);
    }

    /// `cargo test --release --lib timing_style -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn timing_style() {
        let (mut e, d) = div();
        let color = pid("color");
        let n = 200_000;
        let t = std::time::Instant::now();
        for i in 0..n {
            e.style_set(d, color, if i & 1 == 1 { "red" } else { "#00ff00" }, false);
        }
        println!("style_set color: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
        e.style_css_text_set(d, "margin: 1px 2px; color: red");
        let t = std::time::Instant::now();
        for i in 0..n {
            e.style_set(d, color, if i & 1 == 1 { "red" } else { "#00ff00" }, false);
        }
        println!("style_set color with margin: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
        let t = std::time::Instant::now();
        for i in 0..n {
            e.style_set(d, color, if i & 1 == 1 { "red" } else { "blue" }, false);
        }
        println!("style_set color named with margin: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
        let t = std::time::Instant::now();
        let mut k = 0;
        for i in 0..n {
            if let Some(super::value::Parsed::One(v)) =
                super::value::parse_declaration(color, if i & 1 == 1 { "red" } else { "#00ff00" })
            {
                k += v.len();
            }
        }
        println!("parse_declaration color: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
        let mut s = String::new();
        let t = std::time::Instant::now();
        for _ in 0..n {
            let st = e.inline(d).unwrap();
            st.css_text(&e, &mut s);
            k += s.len();
        }
        println!("css_text: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
        let t = std::time::Instant::now();
        for i in 0..n {
            e.set_attr(d, atom::TITLE, if i & 1 == 1 { "color: red;" } else { "color: blue;" }).unwrap();
        }
        println!("set_attr: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
        assert!(k > 0);
    }
}
