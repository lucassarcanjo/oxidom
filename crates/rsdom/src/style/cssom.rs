//! CSSOM rule objects (DESIGN §35): the rule tree behind `CSSStyleSheet`, `CSSRuleList` and the `CSSRule`
//! family, following jsdom 30 (refs/jsdom/lib/jsdom/living/css/helpers/css-parser.js).
//!
//! Every author sheet is parsed into a [`Tree`]: style rules keep their raw prelude (jsdom's `selectorText`), at-rules
//! the pieces of their prelude jsdom exposes, and declaration blocks are the same [`InlineStyle`] as `element.style`.
//! The cascade's flat rule list ([`Sheet`]) is derived from a tree (`flatten`: style rules, recursively inside
//! matching `@media`, as jsdom's `collectCandidateStyles`).
//!
//! A `<style>` element's tree is a temporary until script asks for its `sheet` (or `document.styleSheets`):
//! [`Env::om_sheet_of`] then parses it into an [`OmSheet`] (a sheet id for the facade) that stays the source of
//! that element's rules until its text changes or it disconnects, when the sheet is detached (jsdom creates a new
//! sheet then). CSSOM mutations (`insertRule`, `rule.style`, `selectorText`, media) edit the tree and drop the
//! element's flat sheet, which `sheet::prepare` re-derives from the tree on the next cascade. Constructed sheets
//! (`new CSSStyleSheet()`) have no owner and never apply (jsdom has no `adoptedStyleSheets`).
//!
//! Rules are addressed by (sheet id, rule handle): the handle is the rule's index in its sheet's tree plus one
//! (0 = the sheet itself). Removed rules stay in the tree, detached, since script may hold them.

use std::sync::Arc;

use cssparser::{
    AtRuleParser, CowRcStr, DeclarationParser, ParseError, Parser, ParserState,
    QualifiedRuleParser, RuleBodyItemParser, RuleBodyParser, StyleSheetParser, Token,
};
use rustc_hash::FxHashMap;
use selectors::parser::{ParseRelative, SelectorList};

use super::inline::{self, InlineStyle};
use super::sheet::{self, Sheet};
use super::value;
use crate::atoms::atom;
use crate::env::{Env, ep};
use crate::error::{Code, DomError, DomResult, code};
use crate::select::adapter::{self, Impl, SelParser};
use crate::table::NodeId;

/// Rule kinds (the facade's class table in lib/cssom.cjs uses the same numbers; below 20 they are `CSSRule.type`).
pub mod kind {
    /// CSSStyleRule
    pub const STYLE: u8 = 1;
    /// CSSImportRule
    pub const IMPORT: u8 = 3;
    /// CSSMediaRule
    pub const MEDIA: u8 = 4;
    /// CSSFontFaceRule
    pub const FONT_FACE: u8 = 5;
    /// CSSPageRule
    pub const PAGE: u8 = 6;
    /// CSSKeyframesRule
    pub const KEYFRAMES: u8 = 7;
    /// CSSKeyframeRule
    pub const KEYFRAME: u8 = 8;
    /// CSSNamespaceRule
    pub const NAMESPACE: u8 = 10;
    /// CSSCounterStyleRule
    pub const COUNTER_STYLE: u8 = 11;
    /// CSSSupportsRule
    pub const SUPPORTS: u8 = 12;
    /// CSSLayerBlockRule (`type` 0)
    pub const LAYER_BLOCK: u8 = 20;
    /// CSSLayerStatementRule (`type` 0)
    pub const LAYER_STATEMENT: u8 = 21;
    /// CSSContainerRule (`type` 0)
    pub const CONTAINER: u8 = 22;
    /// CSSScopeRule (`type` 0)
    pub const SCOPE: u8 = 23;
    /// CSSNestedDeclarations (`type` 0)
    pub const NESTED_DECLARATIONS: u8 = 24;
}

/// String fields of a rule (`omStr` / `omSetStr`), by kind:
/// - `A`: style/page `selectorText`, media/supports condition, keyframes/layer/counter-style/container name,
///   keyframe `keyText`, import `href`, namespace prefix, layer statement names (`", "`-joined)
/// - `B`: import media, namespace URI, container query
/// - `C`: import layer name, scope start (absent = `omHas` false)
/// - `D`: import `supports()` text, scope end
pub mod field {
    /// see module docs
    pub const A: u32 = 0;
    /// see module docs
    pub const B: u32 = 1;
    /// see module docs
    pub const C: u32 = 2;
    /// see module docs
    pub const D: u32 = 3;
    /// the sheet's own media text (rule handle 0)
    pub const MEDIA: u32 = 4;
}

/// One rule of a [`Tree`].
#[derive(Clone, Default)]
pub struct RuleData {
    /// `kind::*`
    pub kind: u8,
    /// Parent rule handle (index + 1; 0 = top level).
    pub parent: u32,
    /// In its parent's (or the sheet's) rule list; false once removed.
    pub attached: bool,
    /// Field `A`.
    pub a: String,
    /// Field `B`.
    pub b: String,
    /// Field `C`.
    pub c: Option<String>,
    /// Field `D`.
    pub d: Option<String>,
    /// Declarations (style, page, font-face, keyframe, nested declarations).
    pub decls: Option<Arc<InlineStyle>>,
    /// `@counter-style` descriptors as written (name, value).
    pub descs: Vec<(String, String)>,
    /// Child rules (indexes into the tree).
    pub children: Vec<u32>,
    /// The selector for matching (top-level style rules whose prelude rsdom's selector engine parses).
    pub sel: Option<SelectorList<Impl>>,
}

/// A parsed rule tree: all rules of a sheet, the top-level list in `top`.
#[derive(Clone, Default)]
pub struct Tree {
    /// Rules; children and parents refer to indexes here.
    pub rules: Vec<RuleData>,
    /// Top-level rule list.
    pub top: Vec<u32>,
}

impl Tree {
    fn push(&mut self, r: RuleData) -> u32 {
        self.rules.push(r);
        (self.rules.len() - 1) as u32
    }

    /// The list rule handle `r` owns (0: the top level).
    fn list(&self, r: u32) -> Option<&Vec<u32>> {
        if r == 0 { Some(&self.top) } else { self.rules.get(r as usize - 1).map(|x| &x.children) }
    }

    fn list_mut(&mut self, r: u32) -> Option<&mut Vec<u32>> {
        if r == 0 { Some(&mut self.top) } else { self.rules.get_mut(r as usize - 1).map(|x| &mut x.children) }
    }

    fn rule(&self, r: u32) -> Option<&RuleData> {
        if r == 0 { None } else { self.rules.get(r as usize - 1) }
    }

    fn rule_mut(&mut self, r: u32) -> Option<&mut RuleData> {
        if r == 0 { None } else { self.rules.get_mut(r as usize - 1) }
    }

    /// True when rule handle `r` is a style rule or inside one (CSS nesting context).
    fn in_style(&self, mut r: u32) -> bool {
        while let Some(x) = self.rule(r) {
            if x.kind == kind::STYLE {
                return true;
            }
            r = x.parent;
        }
        false
    }

    /// Moves every rule of `other` into this tree; returns the new indexes of `other.top`.
    fn adopt(&mut self, other: Tree, parent: u32) -> Vec<u32> {
        let base = self.rules.len() as u32;
        for mut r in other.rules {
            for c in &mut r.children {
                *c += base;
            }
            r.parent = if r.parent == 0 { parent } else { r.parent + base };
            self.rules.push(r);
        }
        other.top.into_iter().map(|i| i + base).collect()
    }

    /// Appends the rules of the cascade (jsdom `collectCandidateStylesFrom`: style rules, and the rules of
    /// matching `@media` rules) to `sheet`.
    fn flatten(&self, list: &[u32], sheet: &mut Sheet, order: &mut u32) {
        for &i in list {
            let Some(r) = self.rules.get(i as usize) else { continue };
            match r.kind {
                kind::STYLE => {
                    if let (Some(sel), Some(d)) = (&r.sel, &r.decls)
                        && !d.decls.is_empty()
                    {
                        for s in sel.slice() {
                            *order += 1;
                            sheet.push(s.clone(), d.clone(), *order);
                        }
                    }
                }
                kind::MEDIA if sheet::media_matches(&r.a) => self.flatten(&r.children, sheet, order),
                _ => {}
            }
        }
    }

    /// The cascade's view of this tree.
    pub fn to_sheet(&self) -> Sheet {
        let mut s = Sheet::default();
        let mut order = 0;
        self.flatten(&self.top, &mut s, &mut order);
        s
    }
}

// ------------------------------------------------------------------------------------------ parsing

/// Where a rule list or body is parsed.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ctx {
    /// A sheet's top level.
    Top,
    /// The body of a grouping at-rule outside any style rule.
    Group,
    /// Inside a style rule (a style rule's body, or a grouping rule nested in one).
    Nested,
    /// The body of `@keyframes`.
    Keyframes,
}

/// An at-rule prelude, by the rule it makes.
enum AtPre {
    Media(String),
    Supports(String),
    Import { href: String, media: String, layer: Option<String>, supports: Option<String> },
    Namespace { prefix: String, uri: String },
    FontFace,
    Keyframes(String),
    Page(String),
    LayerBlock(String),
    LayerStatement(String),
    Container { name: String, query: String },
    Scope { start: Option<String>, end: Option<String> },
    CounterStyle(String),
}

/// Result of one item of a rule body.
enum Item {
    Rule(u32),
    Decl,
}

struct TreeParser<'t> {
    tree: &'t mut Tree,
    /// Handle of the rule whose list is being parsed (0 = top level).
    parent: u32,
    ctx: Ctx,
    /// Declarations of the body being parsed (rule bodies in nesting context).
    pending: InlineStyle,
}

fn rest(input: &mut Parser) -> String {
    let start = input.position();
    while input.next_including_whitespace_and_comments().is_ok() {}
    input.slice_from(start).trim().to_owned()
}

/// jsdom `isValidLayerName`.
pub fn valid_layer_name(name: &str) -> bool {
    !name.is_empty()
        && !name.bytes().any(|b| b.is_ascii_whitespace() || b == b',')
        && name.split('.').all(|seg| {
            let s = seg.strip_prefix("--").map(|r| (true, r)).unwrap_or((false, seg));
            let body = if s.0 {
                s.1
            } else {
                let t = seg.strip_prefix('-').unwrap_or(seg);
                let mut cs = t.chars();
                match cs.next() {
                    Some(c) if c.is_ascii_alphabetic() || c == '_' || c as u32 >= 0x80 => {}
                    _ => return false,
                }
                cs.as_str()
            };
            body.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c as u32 >= 0x80)
        })
}

/// Parses a selector list for matching (the whole of `text`); None when rsdom's selector engine rejects it.
fn parse_selector(text: &str) -> Option<SelectorList<Impl>> {
    let mut p = Parser::new(text);
    let list = SelectorList::parse(&SelParser, &mut p, ParseRelative::No).ok()?;
    p.is_exhausted().then_some(list)
}

/// jsdom `normalizeNestedSelector` + its `&<letter>` check: None drops the rule.
fn normalize_nested(text: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    let (mut depth, mut start, mut quote) = (0i32, 0usize, None::<u8>);
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        match quote {
            Some(q) => {
                if c == b'\\' {
                    i += 1;
                } else if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'"' | b'\'' => quote = Some(c),
                b'\\' => i += 1,
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                b',' if depth == 0 => {
                    parts.push(&text[start..i]);
                    start = i + 1;
                }
                _ => {}
            },
        }
        i += 1;
    }
    parts.push(&text[start..]);
    let mut out = String::new();
    for (k, p) in parts.iter().enumerate() {
        let p = p.trim();
        if k > 0 {
            out.push_str(", ");
        }
        if p.starts_with(['>', '+', '~']) || !p.contains('&') {
            out.push_str("& ");
        }
        out.push_str(p);
    }
    let ob = out.as_bytes();
    if ob.windows(2).any(|w| w[0] == b'&' && w[1].is_ascii_alphabetic()) {
        return None;
    }
    Some(out)
}

/// jsdom `isValidScopeSelector` (rsdom's selector engine stands in for csstree's grammar).
fn valid_scope_selector(s: &Option<String>) -> bool {
    match s {
        None => true,
        Some(t) => !t.trim().is_empty() && parse_selector(t).is_some() && !t.contains("::"),
    }
}

fn parse_import<'i>(input: &mut Parser<'i>) -> Result<AtPre, ParseError<()>> {
    let href = match input.next()?.clone() {
        Token::UnquotedUrl(u) => u.to_string(),
        Token::QuotedString(s) => s.to_string(),
        Token::Function(f) if f.eq_ignore_ascii_case("url") => {
            input.parse_nested_block(|i| Ok(i.expect_string()?.to_string()))?
        }
        _ => return Err(ParseError::custom(())),
    };
    if href.is_empty() {
        return Err(ParseError::custom(()));
    }
    let mut layer = None;
    let mut layer_fn = None;
    let mut supports = None;
    let st = input.state();
    match input.next().cloned() {
        Ok(Token::Ident(i)) if i.eq_ignore_ascii_case("layer") => layer = Some(String::new()),
        Ok(Token::Function(f)) if f.eq_ignore_ascii_case("layer") => {
            let fs = input.position();
            let inner = input.parse_nested_block(|i| Ok::<_, ParseError<()>>(rest(i)))?;
            layer_fn = Some(input.slice_from(fs).to_owned());
            layer = Some(inner);
        }
        _ => input.reset(&st),
    }
    let st = input.state();
    match input.next().cloned() {
        Ok(Token::Function(f)) if f.eq_ignore_ascii_case("supports") => {
            let s = input.parse_nested_block(|i| {
                let start = i.position();
                while i.next_including_whitespace_and_comments().is_ok() {}
                Ok::<_, ParseError<()>>(i.slice_from(start).to_owned())
            })?;
            supports = Some(s);
        }
        _ => input.reset(&st),
    }
    let mut media = rest(input);
    // jsdom: an invalid `layer()` (empty, spaces, commas) is a `<general-enclosed>` media query
    if let (Some(name), Some(f)) = (&layer, &layer_fn)
        && !valid_layer_name(name)
    {
        let f = format!("layer{f}");
        media = if media.is_empty() { f } else { format!("{f} {media}") };
        layer = None;
        supports = None;
    }
    Ok(AtPre::Import { href, media, layer, supports })
}

fn parse_namespace<'i>(input: &mut Parser<'i>) -> Result<AtPre, ParseError<()>> {
    let mut prefix = String::new();
    let st = input.state();
    if let Ok(i) = input.expect_ident_cloned() {
        prefix = i.to_string();
    } else {
        input.reset(&st);
    }
    let uri = match input.next()?.clone() {
        Token::UnquotedUrl(u) => u.to_string(),
        Token::QuotedString(s) => s.to_string(),
        Token::Function(f) if f.eq_ignore_ascii_case("url") => {
            input.parse_nested_block(|i| Ok(i.expect_string()?.to_string()))?
        }
        _ => return Err(ParseError::custom(())),
    };
    input.expect_exhausted()?;
    Ok(AtPre::Namespace { prefix, uri })
}

fn parse_scope<'i>(input: &mut Parser<'i>) -> Result<AtPre, ParseError<()>> {
    let block = |input: &mut Parser<'i>| -> Result<String, ParseError<()>> {
        input.expect_parenthesis_block()?;
        input.parse_nested_block(|i| Ok::<_, ParseError<()>>(rest(i)))
    };
    let mut start = None;
    let mut end = None;
    let st = input.state();
    if let Ok(s) = block(input) {
        start = Some(s);
    } else {
        input.reset(&st);
    }
    if !input.is_exhausted() {
        input.expect_ident_matching("to")?;
        end = Some(block(input)?);
    }
    input.expect_exhausted()?;
    if !valid_scope_selector(&start) || !valid_scope_selector(&end) {
        return Err(ParseError::custom(()));
    }
    Ok(AtPre::Scope { start, end })
}

impl TreeParser<'_> {
    fn add(&mut self, mut r: RuleData) -> u32 {
        r.parent = self.parent;
        r.attached = true;
        self.tree.push(r)
    }

    /// Parses the body of the rule at index `idx` (handle `idx + 1`) in context `ctx`.
    fn body(&mut self, idx: u32, ctx: Ctx, input: &mut Parser) {
        let is_style = self.tree.rules[idx as usize].kind == kind::STYLE;
        let mut sub = TreeParser { tree: &mut *self.tree, parent: idx + 1, ctx, pending: InlineStyle::default() };
        let children = match ctx {
            Ctx::Nested => sub.nested_body(input, is_style, idx),
            _ => {
                let mut v = Vec::new();
                for r in StyleSheetParser::new(input, &mut sub) {
                    if let Ok(Item::Rule(i)) = r {
                        v.push(i);
                    }
                }
                v
            }
        };
        self.tree.rules[idx as usize].children = children;
    }

    /// A body in nesting context: declarations and nested rules. A style rule keeps its declarations before
    /// the first nested rule; every later run of declarations becomes a `CSSNestedDeclarations` (jsdom).
    fn nested_body(&mut self, input: &mut Parser, is_style: bool, idx: u32) -> Vec<u32> {
        let mut out = Vec::new();
        let mut seen_rule = !is_style;
        let mut body = RuleBodyParser::new(input, self);
        while let Some(r) = body.next() {
            if let Ok(Item::Rule(i)) = r {
                let run = std::mem::take(&mut body.parser.pending);
                body.parser.place(run, seen_rule, idx, &mut out);
                out.push(i);
                seen_rule = true;
            }
        }
        let run = std::mem::take(&mut self.pending);
        self.place(run, seen_rule, idx, &mut out);
        out
    }

    /// Places a run of declarations: the style rule's own block before any nested rule, else a
    /// `CSSNestedDeclarations`.
    fn place(&mut self, run: InlineStyle, seen_rule: bool, idx: u32, out: &mut Vec<u32>) {
        if run.decls.is_empty() {
            return;
        }
        if !seen_rule {
            self.tree.rules[idx as usize].decls = Some(Arc::new(run));
            return;
        }
        let i = self.add(RuleData { kind: kind::NESTED_DECLARATIONS, decls: Some(Arc::new(run)), ..Default::default() });
        out.push(i);
    }

    fn style_rule(&mut self, prelude: String, input: &mut Parser) -> Result<u32, ()> {
        let (text, sel) = if self.ctx == Ctx::Nested {
            (normalize_nested(&prelude).ok_or(())?, None)
        } else {
            let sel = if self.ctx == Ctx::Keyframes { None } else { parse_selector(&prelude) };
            (prelude, sel)
        };
        if self.ctx == Ctx::Keyframes {
            let mut decls = InlineStyle::default();
            let mut dp = DeclsOnly { out: &mut decls };
            for r in RuleBodyParser::new(input, &mut dp) {
                let _ = r;
            }
            return Ok(self.add(RuleData {
                kind: kind::KEYFRAME,
                a: text,
                decls: Some(Arc::new(decls)),
                ..Default::default()
            }));
        }
        let idx = self.add(RuleData {
            kind: kind::STYLE,
            a: text,
            decls: Some(Arc::new(InlineStyle::default())),
            sel,
            ..Default::default()
        });
        self.body(idx, Ctx::Nested, input);
        Ok(idx)
    }

    fn at_rule(&mut self, pre: AtPre, input: Option<&mut Parser>) -> Result<u32, ()> {
        let nested = self.ctx == Ctx::Nested;
        let group_ctx = if nested { Ctx::Nested } else { Ctx::Group };
        let decl_block = |input: Option<&mut Parser>| -> InlineStyle {
            let mut decls = InlineStyle::default();
            if let Some(input) = input {
                let mut dp = DeclsOnly { out: &mut decls };
                for r in RuleBodyParser::new(input, &mut dp) {
                    let _ = r;
                }
            }
            decls
        };
        let (rule, body) = match pre {
            AtPre::Media(a) => (RuleData { kind: kind::MEDIA, a, ..Default::default() }, Some(group_ctx)),
            AtPre::Supports(a) => (RuleData { kind: kind::SUPPORTS, a, ..Default::default() }, Some(group_ctx)),
            AtPre::Container { name, query } => {
                (RuleData { kind: kind::CONTAINER, a: name, b: query, ..Default::default() }, Some(group_ctx))
            }
            AtPre::Scope { start, end } => {
                (RuleData { kind: kind::SCOPE, c: start, d: end, ..Default::default() }, Some(group_ctx))
            }
            AtPre::LayerBlock(a) => (RuleData { kind: kind::LAYER_BLOCK, a, ..Default::default() }, Some(group_ctx)),
            AtPre::LayerStatement(a) => (RuleData { kind: kind::LAYER_STATEMENT, a, ..Default::default() }, None),
            AtPre::Import { href, media, layer, supports } => (
                RuleData { kind: kind::IMPORT, a: href, b: media, c: layer, d: supports, ..Default::default() },
                None,
            ),
            AtPre::Namespace { prefix, uri } => {
                (RuleData { kind: kind::NAMESPACE, a: prefix, b: uri, ..Default::default() }, None)
            }
            AtPre::FontFace => {
                let d = decl_block(input);
                return Ok(self.add(RuleData { kind: kind::FONT_FACE, decls: Some(Arc::new(d)), ..Default::default() }));
            }
            AtPre::Page(a) => {
                let d = decl_block(input);
                return Ok(self.add(RuleData { kind: kind::PAGE, a, decls: Some(Arc::new(d)), ..Default::default() }));
            }
            AtPre::CounterStyle(a) => {
                let mut descs = Vec::new();
                if let Some(input) = input {
                    let mut dp = RawDecls { out: &mut descs };
                    for r in RuleBodyParser::new(input, &mut dp) {
                        let _ = r;
                    }
                }
                return Ok(self.add(RuleData { kind: kind::COUNTER_STYLE, a, descs, ..Default::default() }));
            }
            AtPre::Keyframes(a) => (RuleData { kind: kind::KEYFRAMES, a, ..Default::default() }, Some(Ctx::Keyframes)),
        };
        let idx = self.add(rule);
        if let (Some(ctx), Some(input)) = (body, input) {
            self.body(idx, ctx, input);
        }
        Ok(idx)
    }
}

impl<'i> QualifiedRuleParser<'i> for TreeParser<'_> {
    type Prelude = String;
    type QualifiedRule = Item;
    type Error = ();

    fn parse_prelude(&mut self, input: &mut Parser<'i>) -> Result<String, ParseError<()>> {
        let p = rest(input);
        if p.is_empty() { Err(ParseError::custom(())) } else { Ok(p) }
    }

    fn parse_block(
        &mut self,
        prelude: String,
        _start: &ParserState,
        input: &mut Parser<'i>,
    ) -> Result<Item, ParseError<()>> {
        self.style_rule(prelude, input).map(Item::Rule).map_err(|_| ParseError::custom(()))
    }
}

impl<'i> AtRuleParser<'i> for TreeParser<'_> {
    type Prelude = AtPre;
    type AtRule = Item;
    type Error = ();

    fn parse_prelude(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i>,
    ) -> Result<AtPre, ParseError<()>> {
        let n = name.to_ascii_lowercase();
        let err = |_: &Parser<'i>| ParseError::custom(());
        if self.ctx == Ctx::Keyframes {
            return Err(err(input));
        }
        let top = self.ctx == Ctx::Top;
        Ok(match n.as_str() {
            "media" => AtPre::Media(rest(input)),
            "supports" => AtPre::Supports(rest(input)),
            "import" if top => parse_import(input)?,
            "namespace" if top => parse_namespace(input)?,
            "font-face" if self.ctx != Ctx::Nested => {
                rest(input);
                AtPre::FontFace
            }
            "keyframes" | "-webkit-keyframes" | "-moz-keyframes" => AtPre::Keyframes(rest(input)),
            "page" => AtPre::Page(rest(input)),
            "counter-style" => AtPre::CounterStyle(rest(input)),
            "layer" => {
                let p = rest(input);
                // the block / statement split happens in `parse_block` / `rule_without_block`
                AtPre::LayerStatement(p)
            }
            "container" => {
                let st = input.state();
                let name = match input.next().cloned() {
                    Ok(Token::Ident(i)) if !["not", "and", "or"].iter().any(|k| i.eq_ignore_ascii_case(k)) => {
                        i.to_string()
                    }
                    _ => {
                        input.reset(&st);
                        String::new()
                    }
                };
                AtPre::Container { name, query: rest(input) }
            }
            "scope" => parse_scope(input)?,
            _ => return Err(err(input)),
        })
    }

    fn rule_without_block(&mut self, prelude: AtPre, _start: &ParserState) -> Result<Item, ()> {
        match prelude {
            AtPre::Import { .. } | AtPre::Namespace { .. } => self.at_rule(prelude, None).map(Item::Rule),
            AtPre::LayerStatement(p) => {
                let names: Vec<&str> = p.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
                if names.is_empty() || !names.iter().all(|n| valid_layer_name(n)) {
                    return Err(());
                }
                self.at_rule(AtPre::LayerStatement(names.join(", ")), None).map(Item::Rule)
            }
            _ => Err(()),
        }
    }

    fn parse_block(
        &mut self,
        prelude: AtPre,
        _start: &ParserState,
        input: &mut Parser<'i>,
    ) -> Result<Item, ParseError<()>> {
        let pre = match prelude {
            AtPre::Import { .. } | AtPre::Namespace { .. } => return Err(ParseError::custom(())),
            AtPre::LayerStatement(p) => {
                if p.contains(',') || (!p.is_empty() && !valid_layer_name(&p)) {
                    return Err(ParseError::custom(()));
                }
                AtPre::LayerBlock(p)
            }
            p => p,
        };
        self.at_rule(pre, Some(input)).map(Item::Rule).map_err(|_| ParseError::custom(()))
    }
}

impl<'i> DeclarationParser<'i> for TreeParser<'_> {
    type Declaration = Item;
    type Error = ();

    fn parse_value(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i>,
        _start: &ParserState,
    ) -> Result<Item, ParseError<()>> {
        inline::parse_declaration_into(&name, input, &mut adapter::tls_intern, &mut self.pending);
        Ok(Item::Decl)
    }
}

impl<'i> RuleBodyItemParser<'i, Item, ()> for TreeParser<'_> {
    fn parse_declarations(&self) -> bool {
        self.ctx == Ctx::Nested
    }

    fn parse_qualified(&self) -> bool {
        true
    }
}

/// A declaration block without nested rules (`@font-face`, `@page`, keyframes).
struct DeclsOnly<'a> {
    out: &'a mut InlineStyle,
}

impl<'i> DeclarationParser<'i> for DeclsOnly<'_> {
    type Declaration = ();
    type Error = ();

    fn parse_value(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i>,
        _start: &ParserState,
    ) -> Result<(), ParseError<()>> {
        inline::parse_declaration_into(&name, input, &mut adapter::tls_intern, self.out);
        Ok(())
    }
}

impl<'i> AtRuleParser<'i> for DeclsOnly<'_> {
    type Prelude = ();
    type AtRule = ();
    type Error = ();
}

impl<'i> QualifiedRuleParser<'i> for DeclsOnly<'_> {
    type Prelude = ();
    type QualifiedRule = ();
    type Error = ();
}

impl<'i> RuleBodyItemParser<'i, (), ()> for DeclsOnly<'_> {
    fn parse_declarations(&self) -> bool {
        true
    }

    fn parse_qualified(&self) -> bool {
        false
    }
}

/// Descriptors kept as written (`@counter-style`).
struct RawDecls<'a> {
    out: &'a mut Vec<(String, String)>,
}

impl<'i> DeclarationParser<'i> for RawDecls<'_> {
    type Declaration = ();
    type Error = ();

    fn parse_value(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i>,
        _start: &ParserState,
    ) -> Result<(), ParseError<()>> {
        let (v, _) = inline::declaration_value(input);
        self.out.push((name.to_string(), v.trim().to_owned()));
        Ok(())
    }
}

impl<'i> AtRuleParser<'i> for RawDecls<'_> {
    type Prelude = ();
    type AtRule = ();
    type Error = ();
}

impl<'i> QualifiedRuleParser<'i> for RawDecls<'_> {
    type Prelude = ();
    type QualifiedRule = ();
    type Error = ();
}

impl<'i> RuleBodyItemParser<'i, (), ()> for RawDecls<'_> {
    fn parse_declarations(&self) -> bool {
        true
    }

    fn parse_qualified(&self) -> bool {
        false
    }
}

/// Parses a rule list (a sheet, or one rule's text for `insertRule`) into a new tree. Returns the tree and
/// the number of list items that failed to parse. Runs with an interner installed (`adapter::with_interner`).
pub fn parse_tree(text: &str) -> (Tree, usize) {
    let mut tree = Tree::default();
    let mut bad = 0;
    let mut input = Parser::new(text);
    let mut p = TreeParser { tree: &mut tree, parent: 0, ctx: Ctx::Top, pending: InlineStyle::default() };
    let mut top = Vec::new();
    for r in StyleSheetParser::new(&mut input, &mut p) {
        match r {
            Ok(Item::Rule(i)) => top.push(i),
            Ok(Item::Decl) => {}
            Err(_) => bad += 1,
        }
    }
    tree.top = top;
    (tree, bad)
}

/// Parses declarations as one `CSSNestedDeclarations` (jsdom `parseDeclarationsAsNestedRule`): None unless
/// the whole text is declarations and at least one is valid.
fn parse_nested_declarations(text: &str) -> Option<Tree> {
    let mut decls = InlineStyle::default();
    let mut input = Parser::new(text);
    let mut dp = DeclsOnly { out: &mut decls };
    for r in RuleBodyParser::new(&mut input, &mut dp) {
        r.ok()?;
    }
    if decls.decls.is_empty() {
        return None;
    }
    let mut tree = Tree::default();
    let i = tree.push(RuleData {
        kind: kind::NESTED_DECLARATIONS,
        attached: true,
        decls: Some(Arc::new(decls)),
        ..Default::default()
    });
    tree.top.push(i);
    Some(tree)
}

// ------------------------------------------------------------------------------------------ sheets

/// A sheet script can see (`CSSStyleSheet`).
#[derive(Default)]
pub struct OmSheet {
    /// The owner `<style>` element (0: constructed, or detached because its text changed or it disconnected).
    pub owner: NodeId,
    /// Rules.
    pub tree: Tree,
    /// The sheet's media text (`<style media>` at creation, or the constructor's `media` option).
    pub media: String,
    /// Made by `new CSSStyleSheet()`.
    pub constructed: bool,
    /// `disabled`: a disabled sheet takes no part in the cascade.
    pub disabled: bool,
}

/// CSSOM state of an env (`StyleState.om`).
#[derive(Default)]
pub struct Om {
    /// Sheets by id (index; 0 unused). Ids are never reused within an env.
    pub sheets: Vec<Option<OmSheet>>,
    /// The sheet of each `<style>` element that has one.
    pub by_owner: FxHashMap<NodeId, u32>,
}

impl Om {
    fn get(&self, sid: u32) -> Option<&OmSheet> {
        self.sheets.get(sid as usize)?.as_ref()
    }

    fn get_mut(&mut self, sid: u32) -> Option<&mut OmSheet> {
        self.sheets.get_mut(sid as usize)?.as_mut()
    }

    fn add(&mut self, s: OmSheet) -> u32 {
        if self.sheets.is_empty() {
            self.sheets.push(None);
        }
        self.sheets.push(Some(s));
        (self.sheets.len() - 1) as u32
    }
}

/// The cascade's sheet for `<style>` element `el`, from its CSSOM sheet when it has one (None: parse its text).
pub(crate) fn owned_sheet(e: &Env, el: NodeId) -> Option<Sheet> {
    let sid = *e.style.om.by_owner.get(&el)?;
    let s = e.style.om.get(sid)?;
    Some(if s.disabled { Sheet::default() } else { s.tree.to_sheet() })
}

/// `<style>` element `el` lost its sheet (text change, `type` change, disconnection): detach the CSSOM sheet.
pub(crate) fn detach_owner(e: &mut Env, el: NodeId) {
    if let Some(sid) = e.style.om.by_owner.remove(&el)
        && let Some(s) = e.style.om.get_mut(sid)
    {
        s.owner = 0;
    }
}

/// `<style>` element `el` creates a sheet (HTML "update a style block": a `type` of "" or "text/css").
fn has_css_type(e: &Env, el: NodeId) -> bool {
    e.get_attr(el, atom::TYPE).is_none_or(|t| t.is_empty() || t.as_str().eq_ignore_ascii_case("text/css"))
}

impl Env {
    fn om_parse(&mut self, text: &str) -> (Tree, usize) {
        let r = adapter::with_interner(&mut self.atoms, || parse_tree(text));
        self.ep.set(ep::ATOM_LEN, self.atoms.len());
        r
    }

    /// The CSSOM sheet of connected `<style>` element `el` (parsing it on first use); 0 when it has none.
    pub fn om_sheet_of(&mut self, el: NodeId) -> u32 {
        if let Some(&sid) = self.style.om.by_owner.get(&el) {
            return sid;
        }
        if !self.style.sheets.contains_key(&el) || !self.is_html_elem(el, atom::STYLE) || !has_css_type(self, el) {
            return 0;
        }
        let text = sheet::style_text(self, el);
        let (tree, _) = self.om_parse(&text);
        let media = self.get_attr(el, atom::MEDIA).map(|s| s.to_string()).unwrap_or_default();
        let sid = self.style.om.add(OmSheet { owner: el, tree, media, ..Default::default() });
        self.style.om.by_owner.insert(el, sid);
        sid
    }

    /// `document.styleSheets`: the sheets of `doc`'s `<style>` elements in tree order, into OUT.
    pub fn om_doc_sheets(&mut self, doc: NodeId) -> u32 {
        let list: Vec<NodeId> = self.doc_data(doc).map(|d| d.style.sheets.to_vec()).unwrap_or_default();
        let mut ids = Vec::with_capacity(list.len());
        for el in list {
            let sid = self.om_sheet_of(el);
            if sid != 0 {
                ids.push(sid);
            }
        }
        self.write_out(&ids)
    }

    /// `new CSSStyleSheet()` (`constructed`), or the empty sheet of an `@import` rule.
    pub fn om_create(&mut self, media: &str, disabled: bool, constructed: bool) -> u32 {
        self.style.om.add(OmSheet { media: media.to_owned(), constructed, disabled, ..Default::default() })
    }

    /// A CSSOM change to sheet `sid`: its owner's cascade sheet is re-derived from the tree.
    fn om_changed(&mut self, sid: u32) {
        let Some(owner) = self.style.om.get(sid).map(|s| s.owner) else { return };
        if owner == 0 {
            return;
        }
        if let Some(s) = self.style.sheets.get_mut(&owner) {
            *s = None;
        }
        let doc = self.rec(owner).owner;
        if let Some(dd) = self.doc_data_mut(doc) {
            dd.style.index = None;
        }
        self.ep.bump(ep::STYLE);
    }

    fn om_rule(&self, sid: u32, r: u32) -> Option<&RuleData> {
        self.style.om.get(sid)?.tree.rule(r)
    }

    /// The rule list of `r` (0: the sheet's) into OUT, as rule handles.
    pub fn om_rules(&mut self, sid: u32, r: u32) -> u32 {
        let v: Vec<u32> = self
            .style
            .om
            .get(sid)
            .and_then(|s| s.tree.list(r))
            .map(|l| l.iter().map(|i| i + 1).collect())
            .unwrap_or_default();
        self.write_out(&v)
    }

    /// Rule kind (0: no such rule).
    pub fn om_kind(&self, sid: u32, r: u32) -> u32 {
        self.om_rule(sid, r).map_or(0, |x| x.kind as u32)
    }

    /// Parent rule handle (0: none, or the rule is detached).
    pub fn om_parent(&self, sid: u32, r: u32) -> u32 {
        self.om_rule(sid, r).filter(|x| x.attached).map_or(0, |x| x.parent)
    }

    /// The rule is in a list (its `parentStyleSheet` is the sheet).
    pub fn om_attached(&self, sid: u32, r: u32) -> bool {
        self.om_rule(sid, r).is_some_and(|x| x.attached)
    }

    /// A string field (`field::*`) of rule `r`, or the sheet's media (`r` 0, `field::MEDIA`).
    pub fn om_str(&self, sid: u32, r: u32, f: u32) -> &str {
        if f == field::MEDIA {
            return self.style.om.get(sid).map_or("", |s| s.media.as_str());
        }
        let Some(x) = self.om_rule(sid, r) else { return "" };
        match f {
            field::A => &x.a,
            field::B => &x.b,
            field::C => x.c.as_deref().unwrap_or(""),
            field::D => x.d.as_deref().unwrap_or(""),
            _ => "",
        }
    }

    /// Whether optional field `f` (`C` / `D`) is present.
    pub fn om_has(&self, sid: u32, r: u32, f: u32) -> bool {
        self.om_rule(sid, r).is_some_and(|x| match f {
            field::C => x.c.is_some(),
            field::D => x.d.is_some(),
            _ => true,
        })
    }

    /// Sets a string field. Style rules re-parse their selector (`selectorText`: the facade has validated it);
    /// media texts take effect in the cascade.
    pub fn om_set_str(&mut self, sid: u32, r: u32, f: u32, v: &str) {
        if f == field::MEDIA {
            if let Some(s) = self.style.om.get_mut(sid) {
                s.media = v.to_owned();
            }
            return;
        }
        let nested = self.style.om.get(sid).is_some_and(|s| s.tree.rule(r).is_some_and(|x| s.tree.in_style(x.parent)));
        let sel = if f == field::A && self.om_kind(sid, r) == kind::STYLE as u32 && !nested {
            let text = v.to_owned();
            adapter::with_interner(&mut self.atoms, || parse_selector(&text))
        } else {
            None
        };
        self.ep.set(ep::ATOM_LEN, self.atoms.len());
        let Some(x) = self.style.om.get_mut(sid).and_then(|s| s.tree.rule_mut(r)) else { return };
        match f {
            field::A => {
                x.a = v.to_owned();
                if x.kind == kind::STYLE {
                    x.sel = sel;
                }
            }
            field::B => x.b = v.to_owned(),
            field::C => x.c = Some(v.to_owned()),
            field::D => x.d = Some(v.to_owned()),
            _ => return,
        }
        self.om_changed(sid);
    }

    /// Whether `text` is a selector list rsdom parses (`selectorText` setter; `nested`: relative to `&`).
    pub fn om_valid_selector(&mut self, text: &str, nested: bool) -> bool {
        let t = text.to_owned();
        let ok = adapter::with_interner(&mut self.atoms, || {
            let mut p = Parser::new(&t);
            let rel = if nested { ParseRelative::ForNesting } else { ParseRelative::No };
            SelectorList::parse(&SelParser, &mut p, rel).is_ok() && p.is_exhausted()
        });
        self.ep.set(ep::ATOM_LEN, self.atoms.len());
        ok
    }

    /// A `@counter-style` descriptor's value ("" if absent).
    pub fn om_desc(&self, sid: u32, r: u32, name: &str) -> &str {
        self.om_rule(sid, r)
            .and_then(|x| x.descs.iter().rev().find(|(n, _)| n.eq_ignore_ascii_case(name)))
            .map_or("", |(_, v)| v.as_str())
    }

    /// Sheet flags: 0 `disabled`, 1 `constructed`, 2 has an owner.
    pub fn om_flag(&self, sid: u32, f: u32) -> bool {
        self.style.om.get(sid).is_some_and(|s| match f {
            0 => s.disabled,
            1 => s.constructed,
            _ => s.owner != 0,
        })
    }

    /// `disabled` setter.
    pub fn om_set_disabled(&mut self, sid: u32, v: bool) {
        let Some(s) = self.style.om.get_mut(sid) else { return };
        if s.disabled != v {
            s.disabled = v;
            self.om_changed(sid);
        }
    }

    /// The owner `<style>` element (0: none).
    pub fn om_owner(&self, sid: u32) -> NodeId {
        self.style.om.get(sid).map_or(0, |s| s.owner)
    }

    /// `insertRule(text, index)` on the list of `r` (0: the sheet's; jsdom `CSSRuleList#_insert`).
    pub fn om_insert(&mut self, sid: u32, r: u32, text: &str, index: u32) -> DomResult {
        let (len, nesting, constructed) = {
            let s = self.style.om.get(sid).ok_or(DomError::InvalidState)?;
            let l = s.tree.list(r).ok_or(DomError::InvalidState)?;
            (l.len(), s.tree.in_style(r), s.constructed)
        };
        if index as usize > len {
            return Err(DomError::IndexSize);
        }
        let (tree, bad) = self.om_parse(text);
        let tree = if tree.top.len() == 1 && bad == 0 {
            tree
        } else if nesting {
            parse_nested_declarations(text).ok_or(DomError::Syntax)?
        } else {
            return Err(DomError::Syntax);
        };
        let new_kind = tree.rules[tree.top[0] as usize].kind;
        if new_kind == kind::IMPORT && constructed && r == 0 {
            return Err(DomError::Syntax);
        }
        let s = self.style.om.get(sid).ok_or(DomError::InvalidState)?;
        let list = s.tree.list(r).ok_or(DomError::InvalidState)?;
        let kind_at = |i: &u32| s.tree.rules[*i as usize].kind;
        if r != 0 {
            if new_kind == kind::IMPORT || new_kind == kind::NAMESPACE {
                return Err(DomError::HierarchyRequest);
            }
            if new_kind == kind::FONT_FACE && s.tree.in_style(r) {
                return Err(DomError::HierarchyRequest);
            }
        } else {
            let pre = |k: u8| k == kind::IMPORT || k == kind::NAMESPACE;
            if new_kind == kind::IMPORT
                && list[..index as usize].iter().any(|i| !matches!(kind_at(i), kind::IMPORT | kind::LAYER_STATEMENT))
            {
                return Err(DomError::HierarchyRequest);
            }
            if new_kind == kind::NAMESPACE
                && list.iter().any(|i| !matches!(kind_at(i), kind::IMPORT | kind::NAMESPACE | kind::LAYER_STATEMENT))
            {
                return Err(DomError::InvalidState);
            }
            if !pre(new_kind) && new_kind != kind::LAYER_STATEMENT && list[index as usize..].iter().any(|i| pre(kind_at(i)))
            {
                return Err(DomError::HierarchyRequest);
            }
            if new_kind == kind::STYLE {
                let declared: Vec<&str> = list
                    .iter()
                    .filter(|i| kind_at(i) == kind::NAMESPACE)
                    .map(|i| s.tree.rules[*i as usize].a.as_str())
                    .collect();
                if undeclared_prefix(&tree.rules[tree.top[0] as usize].a, &declared) {
                    return Err(DomError::Syntax);
                }
            }
        }
        let s = self.style.om.get_mut(sid).ok_or(DomError::InvalidState)?;
        let added = s.tree.adopt(tree, r);
        if r != 0 {
            // a rule inserted into a grouping rule is not matched by the cascade unless that is `@media` at the
            // top; nested style rules keep `sel` None (jsdom does not cascade nested rules either)
            if s.tree.in_style(r) {
                for &i in &added {
                    s.tree.rules[i as usize].sel = None;
                }
            }
        }
        let l = s.tree.list_mut(r).ok_or(DomError::InvalidState)?;
        l.splice(index as usize..index as usize, added);
        self.om_changed(sid);
        Ok(())
    }

    /// `deleteRule(index)` on the list of `r` (jsdom `CSSRuleList#_remove`).
    pub fn om_delete(&mut self, sid: u32, r: u32, index: u32) -> DomResult {
        let s = self.style.om.get_mut(sid).ok_or(DomError::InvalidState)?;
        let list = s.tree.list(r).ok_or(DomError::InvalidState)?;
        let Some(&old) = list.get(index as usize) else { return Err(DomError::IndexSize) };
        if r == 0 && s.tree.rules[old as usize].kind == kind::NAMESPACE {
            let other = list.iter().any(|i| {
                !matches!(s.tree.rules[*i as usize].kind, kind::IMPORT | kind::NAMESPACE | kind::LAYER_STATEMENT)
            });
            if other {
                return Err(DomError::InvalidState);
            }
        }
        if let Some(l) = s.tree.list_mut(r) {
            l.remove(index as usize);
        }
        let x = &mut s.tree.rules[old as usize];
        x.attached = false;
        x.parent = 0;
        self.om_changed(sid);
        Ok(())
    }

    /// `replaceSync(text)`: the sheet's rules become those of `text` (the old ones are detached).
    pub fn om_replace(&mut self, sid: u32, text: &str) {
        let (mut tree, _) = self.om_parse(text);
        // constructed sheets ignore @import (CSSOM "replace a stylesheet")
        tree.top.retain(|i| tree.rules[*i as usize].kind != kind::IMPORT);
        let Some(s) = self.style.om.get_mut(sid) else { return };
        for i in std::mem::take(&mut s.tree.top) {
            let x = &mut s.tree.rules[i as usize];
            x.attached = false;
            x.parent = 0;
        }
        let added = s.tree.adopt(tree, 0);
        s.tree.top = added;
        self.om_changed(sid);
    }

    /// `CSSKeyframesRule#appendRule(text)`: false when `text` is not exactly one keyframe rule.
    pub fn om_append_keyframe(&mut self, sid: u32, r: u32, text: &str) -> bool {
        if self.om_kind(sid, r) != kind::KEYFRAMES as u32 {
            return false;
        }
        let (tree, _) = self.om_parse(&format!("@keyframes _temp {{ {text} }}"));
        if tree.top.len() != 1 {
            return false;
        }
        let k = &tree.rules[tree.top[0] as usize];
        if k.kind != kind::KEYFRAMES || k.children.len() != 1 {
            return false;
        }
        let mut one = Tree::default();
        let child = tree.rules[k.children[0] as usize].clone();
        let i = one.push(RuleData { parent: 0, ..child });
        one.top.push(i);
        let Some(s) = self.style.om.get_mut(sid) else { return false };
        let added = s.tree.adopt(one, r);
        if let Some(l) = s.tree.list_mut(r) {
            l.extend(added);
        }
        self.om_changed(sid);
        true
    }

    // ---------------------------------------------------------------- rule declaration blocks (`rule.style`)

    fn om_decls(&self, sid: u32, r: u32) -> Option<&InlineStyle> {
        self.om_rule(sid, r)?.decls.as_deref()
    }

    fn om_mutate_decls(&mut self, sid: u32, r: u32, f: impl FnOnce(&mut InlineStyle) -> bool) {
        let Some(d) = self.style.om.get_mut(sid).and_then(|s| s.tree.rule_mut(r)).and_then(|x| x.decls.as_mut())
        else {
            return;
        };
        if f(Arc::make_mut(d)) {
            self.om_changed(sid);
        }
    }

    /// `rule.style.getPropertyValue` by id.
    pub fn om_style_get(&mut self, sid: u32, r: u32, p: u32) -> &str {
        let v = self.om_decls(sid, r).and_then(|st| match st.get(p) {
            Some(d) => Some(d.value.to_string()),
            None => st.value_of(p),
        });
        self.scratch.clear();
        if let Some(v) = v {
            self.scratch.push_str(&v);
        }
        &self.scratch
    }

    /// `rule.style.setProperty` by id; an empty value removes.
    pub fn om_style_set(&mut self, sid: u32, r: u32, p: u32, v: &str, important: bool) {
        if v.trim().is_empty() {
            self.om_mutate_decls(sid, r, |st| st.remove(p));
            return;
        }
        let Some(parsed) = value::parse_declaration(p, v) else { return };
        self.om_mutate_decls(sid, r, |st| st.apply(p, parsed, important));
    }

    /// `rule.style.removeProperty` by id; returns the old value.
    pub fn om_style_remove(&mut self, sid: u32, r: u32, p: u32) -> &str {
        let old = self.om_decls(sid, r).and_then(|s| s.value_of(p)).unwrap_or_default();
        self.om_mutate_decls(sid, r, |st| st.remove(p));
        self.scratch.clear();
        self.scratch.push_str(&old);
        &self.scratch
    }

    /// `rule.style.cssText`.
    pub fn om_style_css_text(&mut self, sid: u32, r: u32) -> &str {
        let mut s = std::mem::take(&mut self.scratch);
        match self.om_decls(sid, r) {
            Some(st) => st.css_text(self, &mut s),
            None => s.clear(),
        }
        self.scratch = s;
        &self.scratch
    }

    /// `rule.style.cssText = text`.
    pub fn om_style_css_text_set(&mut self, sid: u32, r: u32, text: &str) {
        let parsed = InlineStyle::parse(self, text);
        self.om_mutate_decls(sid, r, |st| {
            let changed = st.decls != parsed.decls;
            *st = parsed;
            changed
        });
    }
}

/// jsdom's namespace-prefix check for `insertRule` of a style rule: a `prefix|` not declared by `@namespace`.
fn undeclared_prefix(sel: &str, declared: &[&str]) -> bool {
    let b = sel.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let at_start = i == 0 || matches!(b[i - 1], b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b',' | b'>' | b'+' | b'~' | b'(');
        if at_start && (b[i].is_ascii_alphabetic() || b[i] == b'_') {
            let s = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'-') {
                i += 1;
            }
            if i < b.len() && b[i] == b'|' && !declared.contains(&&sel[s..i]) {
                return true;
            }
            continue;
        }
        i += 1;
    }
    false
}

natives! {
    /// `styleEl.sheet`: the CSSOM sheet id of a connected `<style>` element (parsed on first use); 0 = none.
    fn omSheetOf(e, el: u32) -> u32 {
        e.om_sheet_of(el)
    }
    /// `document.styleSheets`: sheet ids of the document's `<style>` elements, tree order, into OUT.
    fn omDocSheets(e, doc: u32) -> u32 {
        e.om_doc_sheets(doc)
    }
    /// `new CSSStyleSheet({ media, disabled })` (`constructed`; else an `@import` rule's empty sheet): a sheet id.
    fn omCreate(e, media: str, disabled: bool, constructed: bool) -> u32 {
        e.om_create(media, disabled, constructed)
    }
    /// `replaceSync(text)` / `replace(text)` of a constructed sheet.
    fn omReplace(e, sid: u32, text: str) -> () {
        e.om_replace(sid, text)
    }
    /// The rule list of rule `r` (0: the sheet's) as rule handles, into OUT.
    fn omRules(e, sid: u32, r: u32) -> u32 {
        e.om_rules(sid, r)
    }
    /// Kind of rule `r` (style/cssom.rs `kind`; 0 = none).
    fn omKind(e, sid: u32, r: u32) -> u32 {
        e.om_kind(sid, r)
    }
    /// Parent rule handle of `r` (0: none).
    fn omParent(e, sid: u32, r: u32) -> u32 {
        e.om_parent(sid, r)
    }
    /// Rule `r` is in its parent's list (parentStyleSheet is the sheet).
    fn omAttached(e, sid: u32, r: u32) -> bool {
        e.om_attached(sid, r)
    }
    /// String field `f` of rule `r` (style/cssom.rs `field`).
    fn omStr(e, sid: u32, r: u32, f: u32) -> &str {
        e.om_str(sid, r, f)
    }
    /// Optional field `f` of rule `r` is present.
    fn omHas(e, sid: u32, r: u32, f: u32) -> bool {
        e.om_has(sid, r, f)
    }
    /// Sets string field `f` of rule `r` (the facade validated it).
    fn omSetStr(e, sid: u32, r: u32, f: u32, v: str) -> () {
        e.om_set_str(sid, r, f, v)
    }
    /// `text` is a selector list rsdom's engine parses (`nested`: relative to `&`).
    fn omValidSelector(e, text: str, nested: bool) -> bool {
        e.om_valid_selector(text, nested)
    }
    /// A `@counter-style` descriptor value as written.
    fn omDesc(e, sid: u32, r: u32, name: str) -> &str {
        e.om_desc(sid, r, name)
    }
    /// Sheet flag `f` (0 disabled, 1 constructed, 2 has an owner).
    fn omFlag(e, sid: u32, f: u32) -> bool {
        e.om_flag(sid, f)
    }
    /// `sheet.disabled = v`.
    fn omSetDisabled(e, sid: u32, v: bool) -> () {
        e.om_set_disabled(sid, v)
    }
    /// The owner `<style>` element of a sheet (0: none).
    fn omOwner(e, sid: u32) -> NodeId {
        e.om_owner(sid)
    }
    /// `insertRule(text, index)` on the list of rule `r` (0: the sheet).
    fn omInsert(e, sid: u32, r: u32, text: str, index: u32) -> Code {
        code(e.om_insert(sid, r, text, index))
    }
    /// `deleteRule(index)` on the list of rule `r` (0: the sheet).
    fn omDelete(e, sid: u32, r: u32, index: u32) -> Code {
        code(e.om_delete(sid, r, index))
    }
    /// `CSSKeyframesRule#appendRule`: false if `text` is not one keyframe rule.
    fn omAppendKeyframe(e, sid: u32, r: u32, text: str) -> bool {
        e.om_append_keyframe(sid, r, text)
    }
    /// `rule.style.getPropertyValue` by property id.
    fn omStyleGet(e, sid: u32, r: u32, p: u32) -> &str {
        e.om_style_get(sid, r, p)
    }
    /// `rule.style.setProperty` by property id; empty value removes.
    fn omStyleSet(e, sid: u32, r: u32, p: u32, v: str, important: bool) -> () {
        e.om_style_set(sid, r, p, v, important)
    }
    /// `rule.style.removeProperty` by property id; returns the old value.
    fn omStyleRemove(e, sid: u32, r: u32, p: u32) -> &str {
        e.om_style_remove(sid, r, p)
    }
    /// `rule.style.getPropertyPriority` by property id.
    fn omStylePriority(e, sid: u32, r: u32, p: u32) -> bool {
        e.om_decls(sid, r).is_some_and(|s| s.important(p))
    }
    /// `rule.style.cssText`.
    fn omStyleCssText(e, sid: u32, r: u32) -> &str {
        e.om_style_css_text(sid, r)
    }
    /// `rule.style.cssText = text`.
    fn omStyleCssTextSet(e, sid: u32, r: u32, text: str) -> () {
        e.om_style_css_text_set(sid, r, text)
    }
    /// `rule.style.length`.
    fn omStyleLen(e, sid: u32, r: u32) -> u32 {
        e.om_decls(sid, r).map_or(0, |s| s.decls.len() as u32)
    }
    /// `rule.style.item(i)` ("" out of range).
    fn omStyleItem(e, sid: u32, r: u32, i: u32) -> &str {
        match e.om_decls(sid, r).and_then(|s| s.decls.get(i as usize)).map(|d| d.prop) {
            Some(p) => inline::prop_name(e, p),
            None => "",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atoms::Interner;

    fn tree(text: &str) -> Tree {
        let mut i = Interner::new();
        adapter::with_interner(&mut i, || parse_tree(text).0)
    }

    #[test]
    fn rule_kinds_and_fields() {
        let t = tree(
            "a  > b , c { color: red } @media screen { p { } } @import url(x.css) layer(l) screen; \
             @namespace svg url(http://x); @keyframes k { from { opacity: 0 } } @layer a, b; @layer c { }",
        );
        let kinds: Vec<u8> = t.top.iter().map(|i| t.rules[*i as usize].kind).collect();
        assert_eq!(
            kinds,
            [kind::STYLE, kind::MEDIA, kind::IMPORT, kind::NAMESPACE, kind::KEYFRAMES, kind::LAYER_STATEMENT, kind::LAYER_BLOCK]
        );
        let r = |k: usize| &t.rules[t.top[k] as usize];
        assert_eq!(r(0).a, "a  > b , c");
        assert!(r(0).sel.is_some());
        assert_eq!(r(1).a, "screen");
        assert_eq!(r(1).children.len(), 1);
        assert_eq!((r(2).a.as_str(), r(2).b.as_str(), r(2).c.as_deref()), ("x.css", "screen", Some("l")));
        assert_eq!((r(3).a.as_str(), r(3).b.as_str()), ("svg", "http://x"));
        assert_eq!(r(5).a, "a, b");
        assert_eq!(t.to_sheet().rules.len(), 2); // `a > b` and `c` (`p { }` declares nothing)
    }

    #[test]
    fn nesting() {
        let t = tree(".a { color: red; .b { color: blue } width: 1px; > .c { } }");
        let a = &t.rules[t.top[0] as usize];
        assert_eq!(a.decls.as_ref().unwrap().decls.len(), 1);
        let kinds: Vec<(u8, &str)> =
            a.children.iter().map(|i| (t.rules[*i as usize].kind, t.rules[*i as usize].a.as_str())).collect();
        assert_eq!(kinds, [(kind::STYLE, "& .b"), (kind::NESTED_DECLARATIONS, ""), (kind::STYLE, "& > .c")]);
    }

    #[test]
    fn prefixes() {
        assert!(undeclared_prefix("svg|a", &[]));
        assert!(!undeclared_prefix("svg|a", &["svg"]));
        assert!(!undeclared_prefix("*|a, |b", &[]));
        assert!(valid_layer_name("a.b-c"));
        assert!(!valid_layer_name("a b"));
        assert!(!valid_layer_name("1a"));
    }
}
