use super::*;

fn doc(html: &str) -> (Env, NodeId) {
    let mut e = Env::new();
    let d = e.parse_document(html, false);
    (e, d)
}

fn ids_of(e: &mut Env, root: NodeId, s: &str) -> Vec<String> {
    let sel = e.compile_sel(s);
    assert_ne!(sel, 0, "selector {s:?} failed to compile");
    let n = e.sel_query(root, sel, false) as usize;
    let out: Vec<NodeId> = e.ids[..n].to_vec();
    out.iter()
        .map(|&id| {
            let d = e.elem(id).unwrap();
            if d.id.is_none() {
                e.atoms.name(Atom(e.rec(id).local)).to_string()
            } else {
                e.atoms.name(d.id).to_string()
            }
        })
        .collect()
}

#[test]
fn basic_queries() {
    let (mut e, d) =
        doc("<!DOCTYPE html><div id=a class='x y'><p id=b class=x>t</p><span id=c></span></div><p id=d></p>");
    assert_eq!(ids_of(&mut e, d, "p"), ["b", "d"]);
    assert_eq!(ids_of(&mut e, d, ".x"), ["a", "b"]);
    assert_eq!(ids_of(&mut e, d, ".x.y"), ["a"]);
    assert_eq!(ids_of(&mut e, d, "div > p, #d, span"), ["b", "c", "d"]);
    assert_eq!(ids_of(&mut e, d, "#b"), ["b"]);
    assert_eq!(ids_of(&mut e, d, "div :not(p)"), ["c"]);
    assert_eq!(ids_of(&mut e, d, "p + span"), ["c"]);
    assert_eq!(ids_of(&mut e, d, "div ~ p"), ["d"]);
    assert_eq!(ids_of(&mut e, d, ":is(span, #d)"), ["c", "d"]);
    assert_eq!(ids_of(&mut e, d, "div:has(> span)"), ["a"]);
    assert_eq!(ids_of(&mut e, d, "span:empty"), ["c"]);
    assert_eq!(ids_of(&mut e, d, "[class~=y]"), ["a"]);
    assert_eq!(ids_of(&mut e, d, "[id^=a], [id$=d]"), ["a", "d"]);
    assert_eq!(ids_of(&mut e, d, "body > :first-child"), ["a"]);
    assert_eq!(ids_of(&mut e, d, "DIV"), ["a"]);
}

#[test]
fn syntax_errors() {
    let (mut e, _) = doc("<p>");
    for bad in ["", " ", "a,", ">a", "a!b", ":nope", "::nope", "ns|a", "[x|y]", ":not()", "#1a", "div ~"] {
        assert_eq!(e.compile_sel(bad), 0, "{bad:?} should be a SyntaxError");
    }
    for ok in
        ["*|a", "|a", "::before", ":hover", ":lang(en)", ":dir(rtl)", ":nth-child(2n+1 of p)", "[a=b i]"]
    {
        assert_ne!(e.compile_sel(ok), 0, "{ok:?} should compile");
    }
}

#[test]
fn prefilter_metadata() {
    let (mut e, _) = doc("<p>");
    let s = e.compile_sel("input[type=\"text\"], textarea");
    let c = e.sel.get(s).unwrap();
    assert_eq!(c.tags.as_slice(), &[atom::INPUT.0, atom::TEXTAREA.0]);
    assert_eq!(c.flags & sel_flags::TAG_ONLY, 0);
    let s = e.compile_sel("a, button");
    let c = e.sel.get(s).unwrap();
    assert_ne!(c.flags & sel_flags::TAG_ONLY, 0);
    let s = e.compile_sel("a, [role=button]");
    assert!(e.sel.get(s).unwrap().tags.is_empty());
    let s = e.compile_sel("input:focus");
    assert_ne!(e.sel.get(s).unwrap().flags & sel_flags::FOCUS, 0);
    let s = e.compile_sel("#only");
    assert!(!e.sel.get(s).unwrap().id_only.is_none());
}

#[test]
fn closest_and_matches() {
    let (mut e, d) = doc("<ul class=l><li id=i><a id=a href=x>t</a></li></ul>");
    let a = e.get_element_by_id(d, e.atoms.get("a").unwrap());
    let li = e.compile_sel("li");
    assert_eq!(e.sel_closest(a, li), e.get_element_by_id(d, e.atoms.get("i").unwrap()));
    let link = e.compile_sel(":link:any-link");
    assert!(e.sel_matches(a, link));
    let scope = e.compile_sel(":scope");
    assert!(e.sel_matches(a, scope));
    let none = e.compile_sel("table");
    assert_eq!(e.sel_closest(a, none), 0);
}

#[test]
fn disabled_fieldset_and_legend() {
    let (mut e, d) = doc(
        "<fieldset disabled><legend><input id=l></legend><input id=x></fieldset><select><optgroup disabled><option id=o></option></optgroup></select><input id=y>",
    );
    assert_eq!(ids_of(&mut e, d, "input:disabled, option:disabled"), ["x", "o"]);
    assert_eq!(ids_of(&mut e, d, "input:enabled"), ["l", "y"]);
}

#[test]
fn by_tag_class_name() {
    let (mut e, d) = doc("<div class='a b'><p class=a name=n></p><svg><foreignObject/></svg></div>");
    let n = e.by_tag(d, "P") as usize;
    assert_eq!(n, 1);
    assert_eq!(e.by_tag(d, "*") as usize, 7); // html head body div p svg foreignObject
    assert_eq!(e.by_tag(d, "foreignObject"), 1);
    assert_eq!(e.by_tag(d, "foreignobject"), 0);
    assert_eq!(e.by_class(d, "a"), 2);
    assert_eq!(e.by_class(d, " b  a "), 1);
    assert_eq!(e.by_class(d, "zz"), 0);
    assert_eq!(e.by_class(d, "  "), 0);
    assert_eq!(e.by_name(d, "n"), 1);
}

#[test]
fn doc_named_filter() {
    let (mut e, d) =
        doc("<form name=f id=fi></form><img id=i><img id=j name=n><object id=o></object><div name=f></div>\
         <embed name=f><svg><form name=f/></svg><template><img name=f></template>");
    assert_eq!(e.doc_named(d, "f"), 2); // the form and the embed: not the div, the SVG form or template content
    assert_eq!(e.doc_named(d, "fi"), 0); // a form's id does not count
    assert_eq!(e.doc_named(d, "i"), 0); // an img's id counts only alongside a name
    assert_eq!(e.doc_named(d, "j"), 1);
    assert_eq!(e.doc_named(d, "o"), 1);
    assert_eq!(e.doc_named(d, ""), 0);
}

#[test]
fn id_map_fast_path_order() {
    let (mut e, d) = doc("<p id=x class=one></p><div><p id=x class=two></p></div>");
    let s = e.compile_sel("#x");
    let n = e.sel_query(d, s, false);
    assert_eq!(n, 2);
    let first = e.sel_query(d, s, true);
    assert!(e.elem(first).unwrap().classes.contains(&e.atoms.get("one").unwrap()));
}

#[test]
fn free_and_reuse() {
    let (mut e, _) = doc("<p>");
    let a = e.compile_sel("p");
    e.sel.remove(a);
    let b = e.compile_sel("div");
    assert_eq!(a, b);
    assert!(!e.sel_matches(1, 999));
}

/// `cargo test --release --lib timing_select -- --ignored --nocapture`
#[test]
#[ignore]
fn timing_select() {
    let mut html = String::from("<!DOCTYPE html><form><input id=email type=email><table><tbody>");
    for r in 0..300 {
        html.push_str(&format!(
            "<tr data-row={r} class='row {}'><td><input type=checkbox></td><td>{r}</td><td><button>b</button></td><td><a href='/x'>o</a></td></tr>",
            if r & 1 == 1 { "odd" } else { "even" }
        ));
    }
    html.push_str("</tbody></table></form>");
    let (mut e, d) = doc(&html);
    let email = e.get_element_by_id(d, e.atoms.get("email").unwrap());
    let s = e.compile_sel("input:not([list])[type=\"email\"]");
    let n = 1_000_000;
    let t = std::time::Instant::now();
    let mut k = 0;
    for _ in 0..n {
        k += e.sel_matches(email, s) as u32;
    }
    println!("sel_matches hit: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
    let t = std::time::Instant::now();
    for _ in 0..n {
        let c = std::hint::black_box(selectors::context::SelectorCaches::default());
        drop(c);
    }
    println!("SelectorCaches default+drop: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
    let t = std::time::Instant::now();
    for _ in 0..n {
        k += std::hint::black_box(adapter::quirks_of(&e, email)) as u32;
    }
    println!("quirks_of: {:.1} ns", t.elapsed().as_nanos() as f64 / n as f64);
    for sel in ["td button", "[data-row=\"150\"]", ".row.odd a[href]"] {
        let s = e.compile_sel(sel);
        let n = 2000;
        let t = std::time::Instant::now();
        for _ in 0..n {
            k += e.sel_query(d, s, false);
        }
        println!("qsa {sel}: {:.1} us", t.elapsed().as_nanos() as f64 / n as f64 / 1000.0);
    }
    assert!(k > 0);
}

/// `Pre::decided` short-circuits `*`, lone lowercase type selectors and id / class compounds (ids and
/// classes only outside quirks mode); everything else still runs the full matcher.
#[test]
fn decided_selectors() {
    let (mut e, d) = doc(
        "<!DOCTYPE html><div id=a class='x y'><p id=b class='x z'>t</p><svg><foreignObject id=f class=x /></svg></div>",
    );
    let decides = |e: &mut Env, s: &str| {
        let list = parse_selector_list(e, s).unwrap();
        list.slice().iter().map(|sel| Pre::of(sel).decides).collect::<Vec<_>>()
    };
    assert_eq!(decides(&mut e, "*"), [1]);
    assert_eq!(decides(&mut e, "div, p"), [1, 1]);
    assert_eq!(decides(&mut e, "#a, .x, p.x.z, *.x"), [2, 2, 2, 2]);
    assert_eq!(decides(&mut e, "#a#b, .a.b.c.d.e, DIV, foreignObject, div p, [id], p:first-child"), [0; 7]);
    assert_eq!(ids_of(&mut e, d, "*"), ["html", "head", "body", "a", "b", "svg", "f"]);
    assert_eq!(ids_of(&mut e, d, ".x"), ["a", "b", "f"]);
    assert_eq!(ids_of(&mut e, d, "p.x.z, #a"), ["a", "b"]);
    assert_eq!(ids_of(&mut e, d, "#a#b"), Vec::<String>::new());
    assert_eq!(ids_of(&mut e, d, "foreignObject"), ["f"]);
    assert_eq!(ids_of(&mut e, d, "foreignobject"), Vec::<String>::new());
    let b = e.get_element_by_id(d, e.atoms.get("b").unwrap());
    let sel = e.compile_sel("div.x");
    assert_eq!(e.sel_closest(b, sel), e.get_element_by_id(d, e.atoms.get("a").unwrap()));
    // quirks mode: classes match ASCII-case-insensitively, so `.X` is not decided by the precheck
    let (mut q, qd) = doc("<div id=a class=x><p id=b class=x></p></div>");
    assert_eq!(ids_of(&mut q, qd, ".X"), ["a", "b"]);
    assert_eq!(ids_of(&mut q, qd, "#A"), ["a"]);
}
