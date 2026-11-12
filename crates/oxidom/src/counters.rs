//! AREA C (bench build, DESIGN §12-§13 attribution rule 3): per-native call counts and cumulative time.
//!
//! Compiled only with the `counters` cargo feature (`npm run build:counters`, loaded by the Vitest
//! environment when `OXIDOM_COUNTERS=1`). Without the feature the `natives!` macro emits no timing code
//! and `Counters` is a zero-sized type, so the default build pays nothing.
//!
//! The time of a call spans argument reading, the body and the conversion of the result to a JS value
//! (everything between `napi_get_cb_info` and the return), measured with `Instant` (vDSO clock_gettime,
//! ~20 ns per pair of reads on this VM: the counters build is for counting and relative attribution,
//! not for absolute per-call latencies).

#[cfg(feature = "counters")]
use rustc_hash::FxHashMap;

/// Per-env counters (`Env.counters`).
#[derive(Default)]
pub struct Counters {
    #[cfg(feature = "counters")]
    map: FxHashMap<usize, Entry>,
}

#[cfg(feature = "counters")]
struct Entry {
    name: &'static str,
    calls: u64,
    ns: u64,
}

impl Counters {
    /// Records one call of native `name` that took `ns` nanoseconds (keyed by the name's address: the
    /// `natives!` macro passes a `'static` literal, so this is one pointer hash).
    #[cfg(feature = "counters")]
    #[inline]
    pub fn record(&mut self, name: &'static str, ns: u64) {
        let e = self.map.entry(name.as_ptr() as usize).or_insert(Entry { name, calls: 0, ns: 0 });
        e.calls += 1;
        e.ns += ns;
    }

    /// JSON: `{"enabled":bool,"calls":n,"ns":n,"fns":{"name":[calls,ns],...}}` (sorted by time, desc).
    pub fn json(&self) -> String {
        #[cfg(feature = "counters")]
        {
            use std::fmt::Write;
            let mut v: Vec<&Entry> = self.map.values().collect();
            v.sort_by(|a, b| b.ns.cmp(&a.ns).then(a.name.cmp(b.name)));
            let calls: u64 = v.iter().map(|e| e.calls).sum();
            let ns: u64 = v.iter().map(|e| e.ns).sum();
            let mut s = format!("{{\"enabled\":true,\"calls\":{calls},\"ns\":{ns},\"fns\":{{");
            for (i, e) in v.iter().enumerate() {
                let sep = if i == 0 { "" } else { "," };
                let _ = write!(s, "{sep}\"{}\":[{},{}]", e.name, e.calls, e.ns);
            }
            s.push_str("}}");
            s
        }
        #[cfg(not(feature = "counters"))]
        {
            String::from("{\"enabled\":false,\"calls\":0,\"ns\":0,\"fns\":{}}")
        }
    }

    /// Clears every counter.
    pub fn reset(&mut self) {
        #[cfg(feature = "counters")]
        self.map.clear();
    }
}

natives! {
    /// Bench build: clears the per-native counters (no-op without the `counters` feature).
    fn countersReset(e) -> () {
        e.counters.reset()
    }
    /// Whether this addon was built with the `counters` feature.
    fn countersEnabled(e) -> bool {
        cfg!(feature = "counters")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn json_shape() {
        let mut c = super::Counters::default();
        #[cfg(feature = "counters")]
        {
            c.record("a", 5);
            c.record("a", 7);
            c.record("b", 100);
            assert_eq!(c.json(), r#"{"enabled":true,"calls":3,"ns":112,"fns":{"b":[1,100],"a":[2,12]}}"#);
        }
        c.reset();
        assert!(c.json().contains("\"calls\":0"));
    }
}
