//! The CSS property table (data/css/properties.tsv, generated from jsdom 30.1.3 by
//! scripts/gen-css-data.mjs). A property id is the data line index; the facade (packages/oxidom/lib/style.cjs) reads
//! the same file, so ids agree on both sides. Custom properties (`--x`) use `CUSTOM_BASE + atom`.
//!
//! The table is immutable process-wide data (`OnceLock`), parsed once on first use (~821 lines).

use std::sync::OnceLock;

use rustc_hash::FxHashMap;

/// Ids at or above this are custom properties (`CUSTOM_BASE + atom id of the name`).
pub const CUSTOM_BASE: u32 = 0x1_0000;

/// Value-type flags (scripts/gen-css-data.mjs `F`).
pub mod flag {
    /// Keyword values are case-sensitive.
    pub const CASE_SENSITIVE: u32 = 1;
    /// Accepts `<length>`.
    pub const LENGTH: u32 = 2;
    /// The length is non-negative.
    pub const LENGTH_NONNEG: u32 = 4;
    /// Accepts `<number>`.
    pub const NUMBER: u32 = 8;
    /// The number is non-negative.
    pub const NUMBER_NONNEG: u32 = 16;
    /// The number is >= 1.
    pub const NUMBER_MIN1: u32 = 32;
    /// Accepts `<percentage>`.
    pub const PERCENT: u32 = 64;
    /// The percentage is non-negative.
    pub const PERCENT_NONNEG: u32 = 128;
    /// Accepts another dimension (time, resolution, ...).
    pub const DIMENSION: u32 = 256;
    /// That dimension is non-negative.
    pub const DIMENSION_NONNEG: u32 = 512;
    /// Accepts `<color>`.
    pub const COLOR: u32 = 1024;
    /// Accepts `<image>`.
    pub const IMAGE: u32 = 2048;
    /// Accepts `<paint>` (SVG fill/stroke).
    pub const PAINT: u32 = 4096;
    /// Accepts `<angle>`.
    pub const ANGLE: u32 = 8192;
    /// Accepts `<ratio>`.
    pub const RATIO: u32 = 16384;
}

/// One property.
#[derive(Debug)]
pub struct PropInfo {
    /// Canonical (kebab-case) name.
    pub name: &'static str,
    /// Inherited property.
    pub inherited: bool,
    /// Initial value as listed by jsdom's definitions (spec text, may be empty).
    pub initial: &'static str,
    /// `flag::*`.
    pub flags: u32,
    /// Longhand ids as listed by jsdom (empty for longhands).
    pub longhands: Box<[u32]>,
    /// Value grammar (resolved once from the name).
    pub grammar: super::value::Grammar,
    /// For the shorthands oxidom stores as longhands: their longhands in serialization order.
    pub expanded: Box<[u32]>,
    /// The expanded shorthands containing this longhand, in cssText serialization preference order.
    pub shorthands: Box<[u32]>,
}

/// Ids of the properties the engine refers to directly.
#[derive(Debug, Default)]
#[allow(missing_docs)]
pub struct Ids {
    pub display: u32,
    pub visibility: u32,
    pub pointer_events: u32,
    pub opacity: u32,
    pub position: u32,
    pub color: u32,
    pub font_size: u32,
    pub font_weight: u32,
    pub font_style: u32,
    pub font_variant: u32,
    pub font_family: u32,
    pub line_height: u32,
    pub font: u32,
    pub margin: u32,
    pub padding: u32,
    pub border: u32,
    pub border_width: u32,
    pub border_style: u32,
    pub border_color: u32,
    /// `border-image`: the `border` shorthand resets it (jsdom stores it as one property)
    pub border_image: u32,
    /// border-top / right / bottom / left
    pub border_side: [u32; 4],
    /// border-<side>-width, indexed by side
    pub border_side_width: [u32; 4],
    /// border-<side>-style
    pub border_side_style: [u32; 4],
    /// border-<side>-color
    pub border_side_color: [u32; 4],
    pub flex: u32,
    pub flex_grow: u32,
    pub flex_shrink: u32,
    pub flex_basis: u32,
    pub background: u32,
    pub background_color: u32,
    pub background_image: u32,
    pub float: u32,
    pub overflow: u32,
    /// `BACKGROUND_LONGHANDS` ids.
    pub background_longhands: [u32; 8],
}

/// Longhands the `background` shorthand sets (serialization order) and their initial values.
pub const BACKGROUND_LONGHANDS: [&str; 8] = [
    "background-image",
    "background-position",
    "background-size",
    "background-repeat",
    "background-attachment",
    "background-origin",
    "background-clip",
    "background-color",
];
/// Initial values of `BACKGROUND_LONGHANDS`.
pub const BACKGROUND_INITIAL: [&str; 8] =
    ["none", "0% 0%", "auto", "repeat", "scroll", "padding-box", "border-box", "transparent"];

/// The table.
#[derive(Debug)]
pub struct Props {
    /// Properties by id.
    pub list: Vec<PropInfo>,
    by_name: FxHashMap<&'static str, u32>,
    /// Frequently used ids.
    pub ids: Ids,
}

static TSV: &str = include_str!("../../data/css/properties.tsv");
static PROPS: OnceLock<Props> = OnceLock::new();

/// The process-wide property table.
#[inline]
pub fn props() -> &'static Props {
    PROPS.get_or_init(build)
}

fn build() -> Props {
    let mut list = Vec::with_capacity(840);
    let mut longhand_names: Vec<&'static str> = Vec::new();
    let mut ranges = Vec::with_capacity(840);
    for line in TSV.lines().filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let mut f = line.split('\t');
        let name = f.next().unwrap_or("");
        let inherited = f.next() == Some("1");
        let initial = f.next().unwrap_or("");
        let flags = f.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        let start = longhand_names.len();
        if let Some(l) = f.next().filter(|l| !l.is_empty()) {
            longhand_names.extend(l.split(','));
        }
        ranges.push(start..longhand_names.len());
        list.push(PropInfo {
            name,
            inherited,
            initial,
            flags,
            longhands: Box::new([]),
            grammar: super::value::grammar_of(name),
            expanded: Box::new([]),
            shorthands: Box::new([]),
        });
    }
    let by_name: FxHashMap<&'static str, u32> =
        list.iter().enumerate().map(|(i, p)| (p.name, i as u32)).collect();
    for (p, r) in list.iter_mut().zip(ranges) {
        p.longhands = longhand_names[r].iter().filter_map(|n| by_name.get(n).copied()).collect();
    }
    let id = |n: &str| by_name.get(n).copied().unwrap_or(u32::MAX);
    let sides = ["top", "right", "bottom", "left"];
    let ids = Ids {
        display: id("display"),
        visibility: id("visibility"),
        pointer_events: id("pointer-events"),
        opacity: id("opacity"),
        position: id("position"),
        color: id("color"),
        font_size: id("font-size"),
        font_weight: id("font-weight"),
        font_style: id("font-style"),
        font_variant: id("font-variant"),
        font_family: id("font-family"),
        line_height: id("line-height"),
        font: id("font"),
        margin: id("margin"),
        padding: id("padding"),
        border: id("border"),
        border_width: id("border-width"),
        border_style: id("border-style"),
        border_color: id("border-color"),
        border_image: id("border-image"),
        border_side: sides.map(|s| id(&format!("border-{s}"))),
        border_side_width: sides.map(|s| id(&format!("border-{s}-width"))),
        border_side_style: sides.map(|s| id(&format!("border-{s}-style"))),
        border_side_color: sides.map(|s| id(&format!("border-{s}-color"))),
        flex: id("flex"),
        flex_grow: id("flex-grow"),
        flex_shrink: id("flex-shrink"),
        flex_basis: id("flex-basis"),
        background: id("background"),
        background_color: id("background-color"),
        background_image: id("background-image"),
        float: id("float"),
        overflow: id("overflow"),
        background_longhands: BACKGROUND_LONGHANDS.map(id),
    };
    // Shorthands stored as longhands (like jsdom), in cssText preference order, with their longhands
    // in serialization order.
    let mut expanded: Vec<(u32, Vec<u32>)> = Vec::new();
    let mut border = ids.border_side_width.to_vec();
    border.extend_from_slice(&ids.border_side_style);
    border.extend_from_slice(&ids.border_side_color);
    border.push(ids.border_image);
    expanded.push((ids.border, border));
    expanded.push((ids.border_width, ids.border_side_width.to_vec()));
    expanded.push((ids.border_style, ids.border_side_style.to_vec()));
    expanded.push((ids.border_color, ids.border_side_color.to_vec()));
    for i in 0..4 {
        expanded.push((
            ids.border_side[i],
            vec![ids.border_side_width[i], ids.border_side_style[i], ids.border_side_color[i]],
        ));
    }
    for sh in [ids.margin, ids.padding, ids.flex] {
        expanded.push((sh, list[sh as usize].longhands.to_vec()));
    }
    expanded.push((ids.background, ids.background_longhands.to_vec()));
    expanded.push((
        ids.font,
        vec![
            ids.font_style,
            ids.font_variant,
            ids.font_weight,
            ids.font_size,
            ids.line_height,
            ids.font_family,
        ],
    ));
    let mut shorthands: Vec<Vec<u32>> = vec![Vec::new(); list.len()];
    for (sh, longs) in &expanded {
        for &l in longs {
            shorthands[l as usize].push(*sh);
        }
    }
    for (sh, longs) in expanded {
        list[sh as usize].expanded = longs.into_boxed_slice();
    }
    for (p, s) in list.iter_mut().zip(shorthands) {
        p.shorthands = s.into_boxed_slice();
    }
    Props { list, by_name, ids }
}

impl Props {
    /// Id of a canonical property name (exact match; callers lowercase non-custom names).
    #[inline]
    pub fn id(&self, name: &str) -> Option<u32> {
        self.by_name.get(name).copied()
    }

    /// Info of a known (non-custom) property.
    #[inline]
    pub fn info(&self, p: u32) -> Option<&PropInfo> {
        self.list.get(p as usize)
    }

    /// Number of known properties.
    #[inline]
    pub fn len(&self) -> usize {
        self.list.len()
    }

    /// Always false.
    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_loads() {
        let p = props();
        assert!(p.len() > 800);
        let m = p.id("margin").unwrap();
        assert_eq!(p.info(m).unwrap().longhands.len(), 4);
        assert!(p.info(p.ids.color).unwrap().inherited);
        assert!(!p.info(p.ids.display).unwrap().inherited);
        assert_eq!(p.info(p.ids.display).unwrap().initial, "inline");
        assert_ne!(p.ids.border_side_color[3], u32::MAX);
        assert_ne!(p.ids.overflow, u32::MAX);
        assert!(p.ids.background_longhands.iter().all(|&x| x != u32::MAX));
        let top = p.ids.border_side_width[0];
        assert_eq!(
            &*p.info(top).unwrap().shorthands,
            &[p.ids.border, p.ids.border_width, p.ids.border_side[0]]
        );
        assert_eq!(p.info(p.ids.border).unwrap().expanded.len(), 13);
        assert!(p.info(p.ids.overflow).unwrap().expanded.is_empty());
    }
}
