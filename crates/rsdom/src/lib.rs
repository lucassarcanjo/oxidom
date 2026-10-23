//! rsdom: an experimental DOM implemented in Rust, exposed to Node.js through raw Node-API callbacks
//! (napi-rs v3 for registration only) and used as a Vitest environment. See docs/DESIGN.md.
//!
//! Layout:
//! - `ffi`        raw-callback edge: `natives!` macro, panic guard, primitive-only args, return conversions
//! - `env`        `Env` (one per napi_env), epoch page, OUT buffer, JS bindings of the node table
//! - `table`      zero-copy node table (64 B records, lazily committed)
//! - `atoms`, `string`, `node`, `error`  data model
//! - `dom`        accessors, traversal, creation, cloning
//! - `tree`       mutation algorithms;  `attrs` attributes;  `text` character data / textContent
//! - `parse`      html5ever TreeSink into the arena;  `serialize`  HTML serializer
//! - `hooks`      mutation hook fan-out to the area modules
//! - area modules (stubs owned by parallel work): `select`, `style`, `forms`, `focus`, `mo`

// No `#[global_allocator]`: the system allocator. mimalloc (v3 sources, the 0.1.52 default) segfaulted Node
// when a worker thread loaded the addon after an earlier worker had exited (Vitest `pool: threads`), and
// both mimalloc v2 and v3 measured slower here (3x the sys time from page purging/refaulting) than glibc.

#[macro_use]
pub mod ffi;

pub mod atom_hash;
pub mod atoms;
pub mod attrs;
pub mod ce;
pub mod chunk;
pub mod counters;
pub mod dom;
pub mod env;
pub mod error;
pub mod hooks;
pub mod node;
pub mod parse;
pub mod range;
pub mod script;
pub mod serialize;
pub mod shadow;
pub mod slots;
pub mod string;
pub mod table;
pub mod text;
pub mod traversal;
pub mod tree;

// Area modules (see CONTRIBUTING.md for ownership).
pub mod focus;
pub mod forms;
pub mod mo;
pub mod select;
pub mod style;

mod generated {
    include!(concat!(env!("OUT_DIR"), "/natives.rs"));
}

pub use env::Env;

/// Module entry: registers every native from the generated registry with a fresh per-env `Env`.
#[napi_derive::napi(module_exports)]
pub fn module_init(exports: napi::bindgen_prelude::Object, env: napi::Env) -> napi::Result<()> {
    use napi::JsValue;
    // SAFETY: called by napi-rs's module registration with the live env and exports object.
    unsafe { ffi::register(env.raw(), exports.raw()) }
}

#[cfg(test)]
mod registry_tests {
    #[test]
    fn registry_matches_generated_count() {
        let n: usize = crate::generated::REGISTRY.iter().map(|l| l.len()).sum();
        assert_eq!(
            n,
            crate::generated::NATIVE_COUNT,
            "build.rs header parsing and the natives! macro disagree"
        );
        let mut names: Vec<_> =
            crate::generated::REGISTRY.iter().flat_map(|l| l.iter().map(|n| n.name)).collect();
        names.sort();
        let len = names.len();
        names.dedup();
        assert_eq!(len, names.len(), "duplicate native names");
    }
}
