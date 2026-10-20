//! `Env`: all DOM state of one napi_env (one Vitest worker), plus the epoch page (EP), the OUT buffer and
//! the JS bindings of the shared node table (DESIGN §2.1, §2.4, §3.4).
//!
//! There are no mutable statics: `init` allocates one `Box<Env>` per napi_env and passes it as the data
//! pointer of every native function. Every document of the env shares one id space.

use std::ptr::{self, NonNull};

use crate::atoms::{Atom, Interner, STATIC_LEN};
use crate::chunk::ChunkVec;
use crate::ffi::{TableBuf, sys};
use crate::node::{DocData, DoctypeData, ElementData};
use crate::string::Str;
use crate::table::{INITIAL_CAP, NodeId, NodeRec, NodeTable, STRIDE};

/// Epoch-page indices (DESIGN §2.4). Rust writes, JS reads.
pub mod ep {
    /// node-table generation (growth)
    pub const GEN: usize = 0;
    /// any child-list change in the env
    pub const TREE: usize = 1;
    /// any attribute change
    pub const ATTR: usize = 2;
    /// change that can affect computed style (area A owns the fine-grained rules)
    pub const STYLE: usize = 3;
    /// any value/checked/selected change
    pub const FORM: usize = 4;
    /// post-mutation work pending (bit mask, checked by the facade's `mutated()`): bit 0 = MutationObserver
    /// records queued (area C), bit 1 = UA element tasks queued (area B: `<details>` toggle events)
    pub const MO_PENDING: usize = 5;
    /// focused node id of the main document (0 -> body)
    pub const FOCUS: usize = 6;
    /// dynamic atom count (JS syncs lazily via `atomsFrom`)
    pub const ATOM_LEN: usize = 7;
    /// high-water node id
    pub const NODE_LEN: usize = 8;
    /// words required when an OUT write overflowed
    pub const OUT_NEED: usize = 9;
    /// error code of the last id-returning call that returned 0
    pub const ERR: usize = 10;
    /// bumped on every node-record write (fallback-mode record cache validation)
    pub const REC: usize = 11;
    /// any character-data change (Text/Comment/PI data)
    pub const TEXT: usize = 12;
    /// number of slots
    pub const LEN: usize = 16;
}

/// The epoch page: a JS-allocated `ArrayBuffer(64)` pinned by a `napi_ref`, or an owned page before `init`.
pub struct EpochPage {
    own: Box<[u32; ep::LEN]>,
    ext: Option<NonNull<u32>>,
}

impl EpochPage {
    fn new() -> Self {
        EpochPage { own: Box::new([0; ep::LEN]), ext: None }
    }

    /// Reads slot `i`.
    #[inline(always)]
    pub fn get(&self, i: usize) -> u32 {
        match self.ext {
            // SAFETY: `ext` points at >= LEN u32s of a pinned JS ArrayBuffer (checked in `bind`); masking
            // keeps the index in range; JS does not run concurrently.
            Some(p) => unsafe { p.as_ptr().add(i & (ep::LEN - 1)).read() },
            None => self.own[i & (ep::LEN - 1)],
        }
    }

    /// Writes slot `i`.
    #[inline(always)]
    pub fn set(&mut self, i: usize, v: u32) {
        match self.ext {
            // SAFETY: as in `get`.
            Some(p) => unsafe { p.as_ptr().add(i & (ep::LEN - 1)).write(v) },
            None => self.own[i & (ep::LEN - 1)] = v,
        }
    }

    /// Increments slot `i` (wrapping, never 0) and returns the new value.
    #[inline(always)]
    pub fn bump(&mut self, i: usize) -> u32 {
        let v = match self.get(i).wrapping_add(1) {
            0 => 1,
            v => v,
        };
        self.set(i, v);
        v
    }

    fn bind(&mut self, p: NonNull<u32>) {
        let vals = *self.own;
        self.ext = Some(p);
        for (i, v) in vals.iter().enumerate() {
            self.set(i, *v);
        }
    }
}

/// The OUT buffer: JS-allocated resizable ArrayBuffer used as volatile scratch for multi-value results
/// and multi-id inputs. Rust never writes past the capacity it last read; an oversized result goes to
/// `pending`, `EP[OUT_NEED]` is set, and JS resizes + `bindOut` + `outRefill` (DESIGN §3.4).
pub struct OutBuf {
    ext: Option<(NonNull<u32>, usize)>,
    own: Vec<u32>,
    pending: Vec<u32>,
}

impl OutBuf {
    fn new(own_cap: usize) -> Self {
        OutBuf { ext: None, own: vec![0; own_cap], pending: Vec::new() }
    }

    /// Capacity in u32 words.
    #[inline(always)]
    pub fn cap(&self) -> usize {
        match self.ext {
            Some((_, n)) => n,
            None => self.own.len(),
        }
    }

    #[inline(always)]
    fn window(&mut self) -> &mut [u32] {
        match self.ext {
            // SAFETY: (ptr, n) were read from the pinned JS ArrayBuffer by `bindOut`; its data pointer is
            // stable across `resize()` and JS cannot run while this borrow is alive.
            Some((p, n)) => unsafe { std::slice::from_raw_parts_mut(p.as_ptr(), n) },
            None => &mut self.own,
        }
    }

    /// Writes a result; returns its length. Oversized results become pending (see type docs).
    pub fn write(&mut self, epoch: &mut EpochPage, data: &[u32]) -> u32 {
        let n = data.len();
        if n <= self.cap() {
            self.window()[..n].copy_from_slice(data);
            epoch.set(ep::OUT_NEED, 0);
        } else {
            self.pending.clear();
            self.pending.extend_from_slice(data);
            epoch.set(ep::OUT_NEED, n as u32);
        }
        n as u32
    }

    /// Copies a pending oversized result into OUT once it is large enough. Returns its length.
    pub fn refill(&mut self) -> u32 {
        let n = self.pending.len();
        if n <= self.cap() {
            let p = std::mem::take(&mut self.pending);
            self.window()[..n].copy_from_slice(&p);
        }
        n as u32
    }

    /// Reads input word `i` (written by JS before the call); 0 when out of range.
    #[inline]
    pub fn read(&mut self, i: usize) -> u32 {
        self.window().get(i).copied().unwrap_or(0)
    }

    /// Copies the first `n` input words (clamped to capacity).
    pub fn read_vec(&mut self, n: usize) -> Vec<u32> {
        let w = self.window();
        w[..n.min(w.len())].to_vec()
    }
}

/// NodeIterator pointer words (traversal.rs, DESIGN §16): a JS-owned resizable ArrayBuffer the facade reads
/// and writes between natives (zero-FFI traversals) and Rust adjusts during removals. Rust treats every word as
/// untrusted input. `own` stands in until `iterBind` (Rust tests).
#[derive(Default)]
pub struct IterWords {
    ext: Option<(NonNull<u32>, usize)>,
    own: Vec<u32>,
}

impl IterWords {
    /// The bound words (empty until bound, outside tests).
    #[inline]
    pub fn words(&mut self) -> &mut [u32] {
        match self.ext {
            // SAFETY: (ptr, n) were read from the pinned JS ArrayBuffer by `iterBind` (re-run after every
            // `resize()`, which keeps a resizable buffer's data pointer); JS cannot run while this borrow lives.
            Some((p, n)) => unsafe { std::slice::from_raw_parts_mut(p.as_ptr(), n) },
            None => &mut self.own,
        }
    }

    /// Rust-owned words of at least `n` (tests: no JS buffer is bound).
    #[cfg(test)]
    pub fn own_at_least(&mut self, n: usize) -> &mut [u32] {
        if self.own.len() < n {
            self.own.resize(n, 0);
        }
        &mut self.own
    }
}

/// napi references that keep the JS side of the bindings alive.
struct JsBinding {
    env: sys::napi_env,
    table_ref: sys::napi_ref,
    ep_ref: sys::napi_ref,
    out_ref: sys::napi_ref,
    iter_ref: sys::napi_ref,
    shared: bool,
}

impl Default for JsBinding {
    fn default() -> Self {
        JsBinding {
            env: ptr::null_mut(),
            table_ref: ptr::null_mut(),
            ep_ref: ptr::null_mut(),
            out_ref: ptr::null_mut(),
            iter_ref: ptr::null_mut(),
            shared: false,
        }
    }
}

unsafe extern "C" fn noop_finalize(
    _env: sys::napi_env,
    _data: *mut std::ffi::c_void,
    _hint: *mut std::ffi::c_void,
) {
}

impl JsBinding {
    /// Detaches and releases the exported table ArrayBuffer (stale JS views then read length 0).
    fn detach_table(&mut self) {
        if self.table_ref.is_null() || self.env.is_null() {
            return;
        }
        let mut ab = ptr::null_mut();
        // SAFETY: env is the live env that created `table_ref`; we are inside a callback (handle scope).
        unsafe {
            sys::napi_get_reference_value(self.env, self.table_ref, &mut ab);
            if !ab.is_null() {
                sys::napi_detach_arraybuffer(self.env, ab);
            }
            sys::napi_delete_reference(self.env, self.table_ref);
        }
        self.table_ref = ptr::null_mut();
    }

    fn release(&mut self) {
        self.detach_table();
        for r in [self.ep_ref, self.out_ref, self.iter_ref] {
            if !r.is_null() && !self.env.is_null() {
                // SAFETY: references created by this binding on the same env.
                unsafe { sys::napi_delete_reference(self.env, r) };
            }
        }
        self.ep_ref = ptr::null_mut();
        self.out_ref = ptr::null_mut();
        self.iter_ref = ptr::null_mut();
    }
}

/// All DOM state of one napi_env.
pub struct Env {
    /// Shared node records (Rust = only writer).
    pub table: NodeTable,
    /// Element payloads, indexed by `NodeRec.payload` of elements.
    pub elems: ChunkVec<ElementData>,
    /// Character data (Text / Comment / CDATA / PI data), indexed by payload.
    pub chars: ChunkVec<Str>,
    /// Document payloads, indexed by payload of documents.
    pub docs: Vec<DocData>,
    /// Doctype payloads.
    pub doctypes: Vec<DoctypeData>,
    /// Interned names.
    pub atoms: Interner,
    /// Epoch page.
    pub ep: EpochPage,
    /// OUT buffer.
    pub out: OutBuf,
    /// Reusable string buffer (serializer, textContent, atomsFrom).
    pub scratch: String,
    /// Reusable id buffer.
    pub ids: Vec<NodeId>,
    /// Area A: selector cache and query state (select/).
    pub sel: crate::select::SelectState,
    /// Area A: style engine state (style/).
    pub style: crate::style::StyleState,
    /// Area B: forms state (forms.rs).
    pub forms: crate::forms::FormsState,
    /// Area C: MutationObserver state (mo.rs).
    pub mo: crate::mo::MoState,
    /// Area B: focus state (focus.rs).
    pub focus: crate::focus::FocusState,
    /// Live NodeIterators (traversal.rs, DESIGN §16).
    pub traversal: crate::traversal::TraversalState,
    /// Their pointer words, shared with the facade (`iterBind`).
    pub iter_words: IterWords,
    /// Shadow roots (shadow.rs, DESIGN §22).
    pub shadow: crate::shadow::ShadowState,
    /// Area C: per-native call counters (bench build, `counters` feature; zero-sized otherwise).
    pub counters: crate::counters::Counters,
    /// html5ever atom -> rsdom atom cache (parse.rs).
    pub parse_cache: crate::parse::ParseCache,
    /// The main document (EP[FOCUS] mirrors its focus). 0 until the facade creates one.
    pub main_doc: NodeId,
    /// Tables replaced by growth, kept reserved but inaccessible until the Env is dropped (soundness
    /// hardening against escaped views; their pages are released).
    retired: Vec<crate::table::RetiredTable>,
    js: JsBinding,
    depth: u32,
}

impl Default for Env {
    fn default() -> Self {
        Env::with_capacity(INITIAL_CAP)
    }
}

impl Env {
    /// A fresh env with the default table reservation.
    pub fn new() -> Self {
        Self::default()
    }

    /// A fresh env reserving `cap` node records (tests use small values to force growth).
    pub fn with_capacity(cap: u32) -> Self {
        let mut e = Env {
            table: NodeTable::with_capacity(cap),
            elems: ChunkVec::new(),
            chars: ChunkVec::new(),
            docs: Vec::new(),
            doctypes: Vec::new(),
            atoms: Interner::new(),
            ep: EpochPage::new(),
            out: OutBuf::new(1 << 16),
            scratch: String::new(),
            ids: Vec::new(),
            sel: Default::default(),
            style: Default::default(),
            forms: Default::default(),
            mo: Default::default(),
            focus: Default::default(),
            traversal: Default::default(),
            iter_words: Default::default(),
            shadow: Default::default(),
            parse_cache: Default::default(),
            counters: Default::default(),
            main_doc: 0,
            retired: Vec::new(),
            js: JsBinding::default(),
            depth: 0,
        };
        e.reset_epochs();
        e
    }

    fn reset_epochs(&mut self) {
        for i in 0..ep::LEN {
            self.ep.set(i, 0);
        }
        self.ep.set(ep::GEN, 1);
        self.ep.set(ep::REC, 1);
        self.ep.set(ep::NODE_LEN, self.table.len());
        self.ep.set(ep::ATOM_LEN, self.atoms.len());
    }

    // ------------------------------------------------------------------ call bracketing (debug guard)

    /// Called at the start of every native. Debug builds panic on re-entrancy (DESIGN §14 risk 2).
    #[inline(always)]
    pub fn enter(&mut self) {
        if cfg!(debug_assertions) {
            assert!(self.depth == 0, "re-entrant native call (Rust must never call into JS)");
            self.depth += 1;
        }
    }

    /// Called at the end of every native.
    #[inline(always)]
    pub fn leave(&mut self) {
        if cfg!(debug_assertions) {
            self.depth -= 1;
        }
    }

    /// Called by the panic guard after a native unwound.
    pub fn after_panic(&mut self) {
        self.depth = 0;
    }

    // ------------------------------------------------------------------------------ node records

    /// Record of `id`, or the all-zero null record for invalid ids (never panics; ids may come from JS).
    #[inline(always)]
    pub fn rec(&self, id: NodeId) -> &NodeRec {
        static NULL: NodeRec = NodeRec {
            parent: 0,
            first: 0,
            last: 0,
            prev: 0,
            next: 0,
            meta: 0,
            local: 0,
            child_ver: 0,
            owner: 0,
            child_len: 0,
            state: 0,
            attr_ver: 0,
            form_ver: 0,
            payload: 0,
            res: [0; 2],
        };
        self.table.get(id).unwrap_or(&NULL)
    }

    /// Mutable record of an id already validated by the caller. Bumps `EP[REC]` (fallback-mode caches).
    ///
    /// # Panics
    /// On an invalid id (an internal bug: public entry points validate ids first).
    #[inline(always)]
    pub fn rec_mut(&mut self, id: NodeId) -> &mut NodeRec {
        self.ep.bump(ep::REC);
        match self.table.get_mut(id) {
            Some(r) => r,
            None => panic!("rsdom: invalid node id {id} in internal mutation"),
        }
    }

    /// Allocates a node record, growing the table if needed (only node-allocating natives call this,
    /// so `EP[GEN]` can only change inside those).
    pub fn alloc_node(&mut self, rec: NodeRec) -> NodeId {
        let id = match self.table.try_push(rec) {
            Some(id) => id,
            None => {
                self.grow_table();
                self.table.try_push(rec).expect("table has room after growth")
            }
        };
        self.ep.set(ep::NODE_LEN, self.table.len());
        id
    }

    /// Growth (rare): copy into a 2x block, detach the old ArrayBuffer *before* freeing the old block,
    /// bump `EP[GEN]`. The new ArrayBuffer is created lazily by `nodeTable()`.
    fn grow_table(&mut self) {
        let next = self.table.grown();
        self.js.detach_table();
        let old = std::mem::replace(&mut self.table, next);
        self.retired.push(old.retire());
        self.ep.bump(ep::GEN);
    }

    /// Interns `s`, keeping `EP[ATOM_LEN]` in sync for the JS atom mirror.
    #[inline]
    pub fn intern(&mut self, s: &str) -> Atom {
        let a = self.atoms.intern(s);
        if a.0 >= STATIC_LEN {
            self.ep.set(ep::ATOM_LEN, self.atoms.len());
        }
        a
    }

    /// Writes a multi-value result into OUT (overflow protocol); returns its length.
    #[inline]
    pub fn write_out(&mut self, data: &[u32]) -> u32 {
        self.out.write(&mut self.ep, data)
    }

    /// Writes `self.ids` into OUT; returns its length.
    #[inline]
    pub fn write_ids(&mut self) -> u32 {
        self.out.write(&mut self.ep, &self.ids)
    }

    /// Sets `EP[ERR]` and returns 0 (for id-returning natives).
    #[inline]
    pub fn fail(&mut self, e: crate::error::DomError) -> NodeId {
        self.ep.set(ep::ERR, e as u32);
        0
    }

    // ------------------------------------------------------------------------------ JS bindings

    /// `init`: (re)initialises this env in place and binds EP / OUT. Returns the node-table ArrayBuffer,
    /// or null in crossing-getter fallback mode (`shared == false` or external buffers disallowed).
    fn bind(
        &mut self,
        env: sys::napi_env,
        ep_ab: sys::napi_value,
        out_ab: sys::napi_value,
        cap: u32,
        shared: bool,
    ) -> TableBuf {
        self.js.env = env;
        self.js.release();
        self.replace_state(if cap == 0 { INITIAL_CAP } else { cap });
        self.js.env = env;
        self.js.shared = shared;
        // SAFETY: values of the current callback scope.
        let (ep_ptr, ep_len) = unsafe { crate::ffi::args::read_arraybuffer(env, ep_ab) };
        if let Some(p) = NonNull::new(ep_ptr.cast::<u32>()).filter(|_| ep_len >= ep::LEN * 4) {
            assert!(p.as_ptr().is_aligned(), "EP buffer must be 4-byte aligned");
            // SAFETY: pins the JS ArrayBuffer so its backing store outlives our pointer.
            unsafe { sys::napi_create_reference(env, ep_ab, 1, &mut self.js.ep_ref) };
            self.ep.bind(p);
        }
        self.bind_out(env, out_ab);
        self.reset_epochs();
        self.table_buffer()
    }

    /// Binds OUT to `out_ab` (init, and `bindOut` after a JS `resize()`). The buffer is (re)pinned by a
    /// fresh reference every time, so Rust never writes through the pointer of a buffer it does not keep
    /// alive (a different or unpinned ArrayBuffer passed to `bindOut` cannot become a use-after-free).
    /// A non-ArrayBuffer unbinds OUT (Rust falls back to its own scratch).
    fn bind_out(&mut self, env: sys::napi_env, out_ab: sys::napi_value) -> u32 {
        if !self.js.out_ref.is_null() {
            // SAFETY: reference created by this binding on the same env.
            unsafe { sys::napi_delete_reference(env, self.js.out_ref) };
            self.js.out_ref = ptr::null_mut();
        }
        // SAFETY: value of the current callback scope.
        let (p, len) = unsafe { crate::ffi::args::read_arraybuffer(env, out_ab) };
        self.out.ext =
            NonNull::new(p.cast::<u32>()).filter(|p| p.as_ptr().is_aligned()).map(|p| (p, len / 4));
        if self.out.ext.is_some() {
            // SAFETY: pins the ArrayBuffer whose data pointer we just cached.
            unsafe { sys::napi_create_reference(env, out_ab, 1, &mut self.js.out_ref) };
        }
        self.out.cap() as u32
    }

    /// Binds the NodeIterator pointer words to `ab` (the facade's resizable ArrayBuffer; again after every
    /// `resize()`), pinning it like OUT. A non-ArrayBuffer unbinds them. Returns the capacity in words.
    pub(crate) fn bind_iters(&mut self, env: sys::napi_env, ab: sys::napi_value) -> u32 {
        if !self.js.iter_ref.is_null() {
            // SAFETY: reference created by this binding on the same env.
            unsafe { sys::napi_delete_reference(env, self.js.iter_ref) };
            self.js.iter_ref = ptr::null_mut();
        }
        // SAFETY: value of the current callback scope.
        let (p, len) = unsafe { crate::ffi::args::read_arraybuffer(env, ab) };
        self.iter_words.ext =
            NonNull::new(p.cast::<u32>()).filter(|p| p.as_ptr().is_aligned()).map(|p| (p, len / 4));
        if self.iter_words.ext.is_some() {
            // SAFETY: pins the ArrayBuffer whose data pointer we just cached.
            unsafe { sys::napi_create_reference(env, ab, 1, &mut self.js.iter_ref) };
        }
        self.iter_words.words().len() as u32
    }

    /// The table as an external ArrayBuffer (one per allocation, cached by reference).
    fn table_buffer(&mut self) -> TableBuf {
        if !self.js.shared || self.js.env.is_null() {
            return TableBuf(None);
        }
        let env = self.js.env;
        let mut ab = ptr::null_mut();
        if !self.js.table_ref.is_null() {
            // SAFETY: live reference on the same env.
            unsafe { sys::napi_get_reference_value(env, self.js.table_ref, &mut ab) };
            return TableBuf(Some(ab));
        }
        let (p, len) = self.table.raw_parts();
        // SAFETY: Rust owns the block until it is replaced (growth / destroy), and both paths detach this
        // ArrayBuffer first; the finalizer is a no-op because Rust frees the memory.
        let st = unsafe {
            sys::napi_create_external_arraybuffer(
                env,
                p.cast(),
                len,
                Some(noop_finalize),
                ptr::null_mut(),
                &mut ab,
            )
        };
        if st != sys::Status::napi_ok {
            // napi_no_external_buffers_allowed (V8 sandbox): switch to the crossing-getter fallback.
            self.js.shared = false;
            return TableBuf(None);
        }
        // SAFETY: pins the AB so it can be detached on growth / destroy.
        unsafe { sys::napi_create_reference(env, ab, 1, &mut self.js.table_ref) };
        TableBuf(Some(ab))
    }

    /// Releases every JS binding and resets the env to a fresh state (`destroy`).
    fn destroy(&mut self) {
        self.js.release();
        self.js.shared = false;
        self.replace_state(2);
    }

    /// Drops all DOM state in place, keeping the call bracket depth and the (released) JS binding.
    fn replace_state(&mut self, cap: u32) {
        let depth = self.depth;
        let js = std::mem::take(&mut self.js);
        *self = Env::with_capacity(cap);
        self.depth = depth;
        self.js = js;
    }
}

/// Records-as-words view used by the fallback `rec` native.
pub fn record_words(e: &Env, id: NodeId) -> [u32; STRIDE] {
    e.table.words(id)
}

/// Intern kinds for the `intern` native.
pub mod intern_kind {
    /// no validation
    pub const ANY: u32 = 0;
    /// valid element local name (createElement)
    pub const ELEMENT: u32 = 1;
    /// valid attribute local name (setAttribute)
    pub const ATTRIBUTE: u32 = 2;
}

natives! {
    /// (Re)initialise the env: pins EP (ArrayBuffer(64)) and OUT (resizable ArrayBuffer); `cap` = initial table capacity (0 = default); `shared` = export the zero-copy table. Returns the table ArrayBuffer or null (fallback mode).
    fn init(e [env], ep_buf: any, out_buf: any, cap: u32, shared: bool) -> TableBuf {
        e.bind(env, ep_buf, out_buf, cap, shared)
    }
    /// Current node-table ArrayBuffer (call after EP[GEN] changed); null in fallback mode.
    fn nodeTable(e) -> TableBuf {
        e.table_buffer()
    }
    /// Re-read OUT's data pointer and length after a JS `resize()`; returns capacity in words.
    fn bindOut(e [env], out_buf: any) -> u32 {
        e.bind_out(env, out_buf)
    }
    /// Copy a pending oversized result into OUT (after the facade grew it). Returns its length.
    fn outRefill(e) -> u32 {
        e.out.refill()
    }
    /// Detach the table, drop all DOM state and leave a fresh, unbound env (call init again to reuse).
    fn destroy(e) -> () {
        e.destroy()
    }
    /// Intern `s`; `kind` 1 = validate as element local name, 2 = as attribute local name. 0 = invalid.
    fn intern(e, s: str, kind: u32) -> u32 {
        let ok = match kind {
            intern_kind::ELEMENT => crate::atoms::is_valid_element_local_name(s),
            intern_kind::ATTRIBUTE => crate::atoms::is_valid_attribute_local_name(s),
            _ => true,
        };
        if ok { e.intern(s).0 } else { 0 }
    }
    /// Names of dynamic atoms with id >= start, concatenated; OUT receives their UTF-16 lengths (count = EP[ATOM_LEN] - start, overflow protocol). Length-prefixed because names may contain NUL.
    fn atomsFrom(e, start: u32) -> &str {
        let mut s = std::mem::take(&mut e.scratch);
        let mut lens = std::mem::take(&mut e.ids);
        e.atoms.names_from(start, &mut s, &mut lens);
        e.write_out(&lens);
        e.ids = lens;
        e.scratch = s;
        e.scratch.as_str()
    }
    /// Fallback mode: copy record `id` (16 words) into OUT[0..16]. Returns false for invalid ids.
    fn rec(e, id: u32) -> bool {
        let w = record_words(e, id);
        e.write_out(&w);
        e.table.contains(id)
    }
    /// JSON of per-native call counts and ns (src/counters.rs; `enabled: false` without the `counters` feature).
    fn counters(e) -> &str {
        e.scratch = e.counters.json();
        e.scratch.as_str()
    }
    /// Bench provenance: "release" or "debug" (cfg!(debug_assertions)), plus "+counters" with that feature.
    fn __buildInfo(e) -> &str {
        e.scratch.clear();
        e.scratch.push_str(if cfg!(debug_assertions) { "debug" } else { "release" });
        if cfg!(feature = "counters") {
            e.scratch.push_str("+counters");
        }
        &e.scratch
    }
    /// Test/bench: raw u32 crossing.
    fn __echo(e, x: u32) -> u32 {
        x
    }
    /// Test: panics inside a native (must surface as a JS Error).
    fn __panic(e, msg: str) -> () {
        panic!("{}", msg)
    }
    /// Test: writes 1..=n into OUT using the overflow protocol; returns n (n is capped at 2^24 words so a
    /// bad argument cannot drive an aborting allocation).
    fn __outSeq(e, n: u32) -> u32 {
        let v: Vec<u32> = (1..=n.min(1 << 24)).collect();
        e.write_out(&v)
    }
    /// Test: returns the UTF-16 length Rust computed for `s` (string ingress check).
    fn __strLen16(e, s: str) -> u32 {
        Str::from(s).utf16_len()
    }
    /// Test: number of records the table can hold before growing.
    fn __tableCap(e) -> u32 {
        e.table.capacity()
    }
}
