//! The Node-API edge: raw `extern "C"` callbacks, the `natives!` declaration macro, the panic guard,
//! primitive-only argument readers and return-value conversions.
//!
//! This is the only module (with `table.rs` and `env.rs`'s JS-binding helpers) that contains `unsafe`.
//!
//! Invariants (DESIGN §0, §3.1):
//! - Rust never calls into JS: no `napi_call_function`, no `napi_coerce_*`, no property gets on user objects.
//!   That is what makes the `&mut Env` taken from the callback data pointer sound (no re-entrancy).
//! - Arguments are u32 / i32 / f64 / bool / already-coerced strings / ArrayBuffers (cold paths only).
//! - Return values are u32, i32, f64, bool, string, null or undefined. Rust never creates objects or arrays.
//! - A panic is caught at the boundary and rethrown as `Error('oxidom internal: ...')`.

use std::ffi::{CStr, c_void};
use std::mem::MaybeUninit;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

pub use napi::sys;

use crate::env::Env;
use crate::string::Str;

/// Raw Node-API callback signature.
pub type RawCb = unsafe extern "C" fn(sys::napi_env, sys::napi_callback_info) -> sys::napi_value;

/// One exported native function (produced by `natives!`, collected by the build-script registry).
pub struct Native {
    /// Exported property name.
    pub name: &'static CStr,
    /// The raw callback.
    pub cb: RawCb,
}

/// `concat!(stringify!(name), "\0")` -> `&CStr` at compile time.
pub const fn cstr(s: &'static str) -> &'static CStr {
    match CStr::from_bytes_with_nul(s.as_bytes()) {
        Ok(c) => c,
        Err(_) => panic!("native name must be NUL-terminated"),
    }
}

/// Declares raw native callbacks plus this module's `NATIVES` list.
///
/// ```ignore
/// natives! {
///     /// Doc comment (copied into packages/oxidom/lib/generated/native.d.ts).
///     fn setAttr(e, id: u32, name: u32, value: str) -> Code { code(e.set_attr(id, Atom(name), value)) }
/// }
/// ```
///
/// Rules (build.rs parses the header line, keep it on ONE line):
/// - first parameter is the `&mut Env` binding, optionally followed by `[env]` to also bind the raw
///   `napi_env` (cold infrastructure natives only); the others are `name: kind` with kind one of
///   `u32 i32 f64 bool str ostr buf any` (`ostr` = string or null/undefined -> `Option<&str>`,
///   `buf` = ArrayBuffer -> `(*mut u8, usize)`, `any` = raw `napi_value`, only for cold infra).
/// - the return type is a real Rust type implementing [`IntoJs`]: `u32 i32 f64 bool () Code NodeId Atom
///   &str &Str Option<&str> Option<&Str> Value TableBuf`.
/// - bodies are expressions: no `return` (it would return from the internal closure); use if/else or
///   call an `impl Env` method.
/// - the block closes with a `}` on its own line at column 0.
#[macro_export]
#[doc(hidden)]
macro_rules! natives {
    ($( $(#[doc = $doc:literal])* fn $name:ident($e:ident $([$nenv:ident])? $(, $arg:ident : $ty:ident)* $(,)?) -> $ret:ty $body:block )*) => {
        $(
            $(#[doc = $doc])*
            #[allow(non_snake_case, unused_mut, unused_variables, unused_unsafe, unreachable_code, clippy::unused_unit, clippy::diverging_sub_expression)]
            unsafe extern "C" fn $name(
                env: $crate::ffi::sys::napi_env,
                info: $crate::ffi::sys::napi_callback_info,
            ) -> $crate::ffi::sys::napi_value {
                const ARGC: usize = $crate::natives!(@count $($arg)*);
                let mut argv = [::core::ptr::null_mut(); ARGC];
                // SAFETY: `env`/`info` come straight from Node-API for this callback invocation, and `argv`
                // has exactly ARGC slots (napi fills missing arguments with `undefined`).
                let state = unsafe { $crate::ffi::cb_info(env, info, &mut argv) };
                let call = move || {
                    // SAFETY: `state` is the `Box<Env>` pointer registered as this function's data (see
                    // `register`), valid for the napi_env's lifetime. It is the only live reference to the
                    // Env: Rust never re-enters JS (checked by the debug re-entrancy counter in `enter`).
                    let $e: &mut $crate::env::Env = unsafe { &mut *state };
                    $( let $nenv = env; )?
                    #[cfg(feature = "counters")]
                    let t0 = ::std::time::Instant::now();
                    $e.enter();
                    let [$($arg),*] = argv;
                    $(
                        // SAFETY: `$arg` is a napi_value of this callback scope.
                        let mut $arg = unsafe { $crate::natives!(@read $ty, env, $arg) };
                        let $arg = $crate::natives!(@get $ty, $arg);
                    )*
                    let r: $ret = $body;
                    // SAFETY: `env` is the live napi_env of this callback.
                    let v = unsafe { $crate::ffi::IntoJs::into_js(r, env) };
                    // Bench build only (area C, src/counters.rs): per-native call count and time.
                    #[cfg(feature = "counters")]
                    $e.counters.record(stringify!($name), t0.elapsed().as_nanos() as u64);
                    $e.leave();
                    v
                };
                // SAFETY: live env; `state` is only touched by the guard after `call` has unwound.
                unsafe { $crate::ffi::guard(env, state, call) }
            }
        )*
        /// Native functions exported by this module (collected into the registry by build.rs).
        pub(crate) static NATIVES: &[$crate::ffi::Native] = &[
            $( $crate::ffi::Native { name: $crate::ffi::cstr(concat!(stringify!($name), "\0")), cb: $name }, )*
        ];
    };
    (@count) => { 0usize };
    (@count $h:ident $($t:ident)*) => { 1usize + $crate::natives!(@count $($t)*) };
    (@read u32, $env:ident, $v:ident) => { $crate::ffi::args::read_u32($env, $v) };
    (@read i32, $env:ident, $v:ident) => { $crate::ffi::args::read_i32($env, $v) };
    (@read f64, $env:ident, $v:ident) => { $crate::ffi::args::read_f64($env, $v) };
    (@read bool, $env:ident, $v:ident) => { $crate::ffi::args::read_bool($env, $v) };
    (@read str, $env:ident, $v:ident) => { $crate::ffi::args::StrArg::read($env, $v) };
    (@read ostr, $env:ident, $v:ident) => { $crate::ffi::args::OptStrArg::read($env, $v) };
    (@read buf, $env:ident, $v:ident) => { $crate::ffi::args::read_arraybuffer($env, $v) };
    (@read any, $env:ident, $v:ident) => { $v };
    (@get str, $h:ident) => { $h.as_str() };
    (@get ostr, $h:ident) => { $h.as_opt() };
    (@get $other:ident, $h:ident) => { $h };
}

/// Reads exactly `N` arguments plus the data pointer. Missing arguments are `undefined`, which the
/// primitive readers turn into 0 / false / "" (memory-safe: id 0 is the null node).
///
/// # Safety
/// `env` and `info` must be the values passed to the currently executing callback.
#[inline(always)]
pub unsafe fn cb_info<const N: usize>(
    env: sys::napi_env,
    info: sys::napi_callback_info,
    argv: &mut [sys::napi_value; N],
) -> *mut Env {
    let mut argc = N;
    let mut data: *mut c_void = ptr::null_mut();
    // SAFETY: argv has N writable slots and argc says so; the other out-pointers are valid or null.
    unsafe {
        sys::napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), ptr::null_mut(), &mut data);
    }
    data.cast()
}

/// Panic boundary. Zero-cost on the happy path; turns a Rust bug into a JS `Error` instead of aborting
/// the Vitest worker. Requires `panic = "unwind"`.
///
/// # Safety
/// `env` must be the live napi_env; `state` the registered Env pointer (only touched after `f` unwound).
#[inline(always)]
pub unsafe fn guard(
    env: sys::napi_env,
    state: *mut Env,
    f: impl FnOnce() -> sys::napi_value,
) -> sys::napi_value {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(v) => v,
        Err(payload) => {
            // SAFETY: the closure has fully unwound, so no reference into `*state` is alive anymore.
            if let Some(e) = unsafe { state.as_mut() } {
                e.after_panic();
            }
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            let full = format!("oxidom internal: {msg}\0");
            let c = CStr::from_bytes_until_nul(full.as_bytes()).unwrap_or(c"oxidom internal panic");
            // SAFETY: env is live; c is NUL-terminated and outlives the call (napi copies it).
            unsafe { sys::napi_throw_error(env, ptr::null(), c.as_ptr()) };
            ptr::null_mut()
        }
    }
}

/// Registers every native from the build-generated registry on `exports`, with one freshly allocated
/// `Env` as callback data. Called once per napi_env from the `module_exports` hook.
///
/// # Safety
/// `env`/`exports` must be the values handed to the module-exports hook.
pub unsafe fn register(env: sys::napi_env, exports: sys::napi_value) -> napi::Result<()> {
    let state = Box::into_raw(Box::new(Env::new()));
    for list in crate::generated::REGISTRY {
        for n in *list {
            let mut f = ptr::null_mut();
            // SAFETY: env/exports are live; name is NUL-terminated and 'static; `state` stays valid until
            // the env cleanup hook frees it, which happens after the last callback can run.
            let st = unsafe {
                sys::napi_create_function(
                    env,
                    n.name.as_ptr(),
                    usize::MAX as isize,
                    Some(n.cb),
                    state.cast(),
                    &mut f,
                )
            };
            if st != sys::Status::napi_ok {
                return Err(napi::Error::from_reason(format!(
                    "napi_create_function failed for {:?}",
                    n.name
                )));
            }
            // SAFETY: as above; `f` is the function just created.
            unsafe { sys::napi_set_named_property(env, exports, n.name.as_ptr(), f) };
        }
    }
    // SAFETY: registers a C callback that frees `state` when the env shuts down.
    unsafe { sys::napi_add_env_cleanup_hook(env, Some(free_env), state.cast()) };
    Ok(())
}

unsafe extern "C" fn free_env(arg: *mut c_void) {
    if !arg.is_null() {
        // SAFETY: `arg` is the pointer produced by `Box::into_raw` in `register`; this hook runs once.
        drop(unsafe { Box::from_raw(arg.cast::<Env>()) });
    }
}

// ------------------------------------------------------------------------------------------- arguments

/// Primitive-only argument readers. This is the only place that calls `napi_get_value_*`.
pub mod args {
    use super::*;

    /// u32 argument; non-numbers read as 0 (= null node / no atom).
    ///
    /// # Safety
    /// `env`/`v` must belong to the current callback scope.
    #[inline(always)]
    pub unsafe fn read_u32(env: sys::napi_env, v: sys::napi_value) -> u32 {
        let mut out = 0u32;
        // SAFETY: caller contract; on failure `out` stays 0.
        unsafe { sys::napi_get_value_uint32(env, v, &mut out) };
        out
    }

    /// i32 argument; non-numbers read as 0.
    ///
    /// # Safety
    /// `env`/`v` must belong to the current callback scope.
    #[inline(always)]
    pub unsafe fn read_i32(env: sys::napi_env, v: sys::napi_value) -> i32 {
        let mut out = 0i32;
        // SAFETY: caller contract; on failure `out` stays 0.
        unsafe { sys::napi_get_value_int32(env, v, &mut out) };
        out
    }

    /// f64 argument; non-numbers read as 0.0.
    ///
    /// # Safety
    /// `env`/`v` must belong to the current callback scope.
    #[inline(always)]
    pub unsafe fn read_f64(env: sys::napi_env, v: sys::napi_value) -> f64 {
        let mut out = 0f64;
        // SAFETY: caller contract; on failure `out` stays 0.
        unsafe { sys::napi_get_value_double(env, v, &mut out) };
        out
    }

    /// bool argument; non-booleans read as false (the facade passes `!!v`).
    ///
    /// # Safety
    /// `env`/`v` must belong to the current callback scope.
    #[inline(always)]
    pub unsafe fn read_bool(env: sys::napi_env, v: sys::napi_value) -> bool {
        let mut out = false;
        // SAFETY: caller contract; on failure `out` stays false.
        unsafe { sys::napi_get_value_bool(env, v, &mut out) };
        out
    }

    /// ArrayBuffer argument as `(data, byte_len)`; `(null, 0)` if `v` is not an ArrayBuffer.
    ///
    /// # Safety
    /// `env`/`v` must belong to the current callback scope.
    pub unsafe fn read_arraybuffer(env: sys::napi_env, v: sys::napi_value) -> (*mut u8, usize) {
        let mut data: *mut c_void = ptr::null_mut();
        let mut len = 0usize;
        // SAFETY: caller contract; on failure data stays null.
        let st = unsafe { sys::napi_get_arraybuffer_info(env, v, &mut data, &mut len) };
        if st != sys::Status::napi_ok { (ptr::null_mut(), 0) } else { (data.cast(), len) }
    }

    const STACK: usize = 512;

    /// A JS string read with one `napi_get_value_string_utf8` into a 512 B stack buffer, falling back to
    /// the heap for long strings. Non-strings read as "" (the facade coerces with `String(v)` first).
    pub struct StrArg {
        stack: [MaybeUninit<u8>; STACK],
        heap: Vec<u8>,
        len: usize,
        on_heap: bool,
    }

    impl StrArg {
        /// Reads `v`.
        ///
        /// # Safety
        /// `env`/`v` must belong to the current callback scope.
        #[inline(always)]
        pub unsafe fn read(env: sys::napi_env, v: sys::napi_value) -> Self {
            let mut s =
                StrArg { stack: [MaybeUninit::uninit(); STACK], heap: Vec::new(), len: 0, on_heap: false };
            let mut len = 0usize;
            // SAFETY: the buffer has STACK writable bytes; napi writes at most STACK-1 plus a NUL.
            let st = unsafe {
                sys::napi_get_value_string_utf8(env, v, s.stack.as_mut_ptr().cast(), STACK, &mut len)
            };
            if st != sys::Status::napi_ok {
                return s;
            }
            // V8 never splits a code point, so a result within 4 bytes of capacity may be truncated.
            if len + 4 < STACK {
                s.len = len;
                // SAFETY: as in `reread_if_lone`.
                return unsafe { s.reread_if_lone(env, v) };
            }
            // Long string: the UTF-16 length is O(1) to query (a null buffer returns `String::Length`)
            // and bounds the UTF-8 size (<= 3 bytes per unit), so ONE copy into an uninitialised buffer
            // suffices (no UTF-8 length scan, no zeroing).
            let mut len16 = 0usize;
            // SAFETY: a null buffer asks napi for the UTF-16 length only.
            unsafe { sys::napi_get_value_string_utf16(env, v, ptr::null_mut(), 0, &mut len16) };
            let cap = len16 * 3 + 1;
            s.heap = Vec::with_capacity(cap);
            let mut written = 0usize;
            // SAFETY: heap has `cap` writable (uninitialised) bytes; napi writes at most cap-1 plus a NUL
            // and reports the bytes written (without the NUL) in `written`.
            unsafe {
                sys::napi_get_value_string_utf8(env, v, s.heap.as_mut_ptr().cast(), cap, &mut written);
                s.heap.set_len(written.min(cap - 1));
            }
            s.len = s.heap.len();
            s.on_heap = true;
            // SAFETY: caller contract.
            unsafe { s.reread_if_lone(env, v) }
        }

        /// V8 wrote U+FFFD for every lone surrogate: if the UTF-8 holds U+FFFD at all, reads `v` again as
        /// UTF-16 and stores it with the lone surrogates escaped (DESIGN §44). Other strings pay one scan.
        ///
        /// # Safety
        /// `env`/`v` must belong to the current callback scope.
        #[cold]
        #[inline(never)]
        unsafe fn reread_slow(mut self, env: sys::napi_env, v: sys::napi_value) -> Self {
            let mut len16 = 0usize;
            // SAFETY: a null buffer asks napi for the UTF-16 length only.
            unsafe { sys::napi_get_value_string_utf16(env, v, ptr::null_mut(), 0, &mut len16) };
            let mut units = vec![0u16; len16 + 1];
            let mut written = 0usize;
            // SAFETY: `units` has len16 + 1 writable units (napi adds a NUL).
            unsafe { sys::napi_get_value_string_utf16(env, v, units.as_mut_ptr(), len16 + 1, &mut written) };
            self.heap = crate::string::from_utf16_escaped(&units[..written.min(len16)]).into_bytes();
            self.len = self.heap.len();
            self.on_heap = true;
            self
        }

        /// See [`reread_slow`](Self::reread_slow).
        ///
        /// # Safety
        /// `env`/`v` must belong to the current callback scope.
        #[inline(always)]
        unsafe fn reread_if_lone(self, env: sys::napi_env, v: sys::napi_value) -> Self {
            let b = self.as_str().as_bytes();
            if b.len() >= 3 && memchr::memmem::find(b, b"\xEF\xBF\xBD").is_some() {
                // SAFETY: caller contract.
                return unsafe { self.reread_slow(env, v) };
            }
            self
        }

        /// The string (UTF-8; lone surrogates escaped, DESIGN §44).
        #[inline(always)]
        pub fn as_str(&self) -> &str {
            let bytes: &[u8] = if self.on_heap {
                &self.heap[..self.len]
            } else {
                // SAFETY: napi initialized the first `len` bytes of `stack` (len < STACK).
                unsafe { std::slice::from_raw_parts(self.stack.as_ptr().cast::<u8>(), self.len) }
            };
            debug_assert!(std::str::from_utf8(bytes).is_ok(), "napi produced invalid UTF-8");
            // SAFETY: the bytes are either V8's UTF-8 encoding from `napi_get_value_string_utf8` (lone
            // surrogates replaced by U+FFFD; never splits a code point when it truncates) or, after
            // `reread_slow`, a `String` built by `from_utf16_escaped` from the zero-initialised UTF-16 buffer
            // (`written` clamped to it). Both are valid UTF-8. Skipping the re-validation saves ~0.6 ns/byte
            // on non-ASCII input.
            unsafe { std::str::from_utf8_unchecked(bytes) }
        }
    }

    /// `string | null | undefined` argument.
    pub struct OptStrArg(Option<StrArg>);

    impl OptStrArg {
        /// Reads `v`; null and undefined become `None`.
        ///
        /// # Safety
        /// `env`/`v` must belong to the current callback scope.
        #[inline(always)]
        pub unsafe fn read(env: sys::napi_env, v: sys::napi_value) -> Self {
            let mut t = sys::ValueType::napi_undefined;
            // SAFETY: caller contract.
            unsafe { sys::napi_typeof(env, v, &mut t) };
            if t == sys::ValueType::napi_null || t == sys::ValueType::napi_undefined {
                OptStrArg(None)
            } else {
                // SAFETY: caller contract.
                OptStrArg(Some(unsafe { StrArg::read(env, v) }))
            }
        }

        /// The string, or `None` for null/undefined.
        #[inline(always)]
        pub fn as_opt(&self) -> Option<&str> {
            self.0.as_ref().map(StrArg::as_str)
        }
    }
}

// ------------------------------------------------------------------------------------- return values

/// A raw JS value (cold infrastructure only, e.g. the node-table ArrayBuffer).
#[derive(Clone, Copy)]
pub struct Value(pub sys::napi_value);

/// `ArrayBuffer | null` (null in crossing-getter fallback mode).
#[derive(Clone, Copy)]
pub struct TableBuf(pub Option<sys::napi_value>);

/// Conversion of a native's Rust result into a JS value (primitives and strings only).
pub trait IntoJs {
    /// Converts `self`.
    ///
    /// # Safety
    /// `env` must be the live napi_env of the current callback.
    unsafe fn into_js(self, env: sys::napi_env) -> sys::napi_value;
}

impl IntoJs for u32 {
    #[inline(always)]
    unsafe fn into_js(self, env: sys::napi_env) -> sys::napi_value {
        let mut out = ptr::null_mut();
        // SAFETY: caller contract.
        unsafe { sys::napi_create_uint32(env, self, &mut out) };
        out
    }
}

impl IntoJs for i32 {
    #[inline(always)]
    unsafe fn into_js(self, env: sys::napi_env) -> sys::napi_value {
        let mut out = ptr::null_mut();
        // SAFETY: caller contract.
        unsafe { sys::napi_create_int32(env, self, &mut out) };
        out
    }
}

impl IntoJs for f64 {
    #[inline(always)]
    unsafe fn into_js(self, env: sys::napi_env) -> sys::napi_value {
        let mut out = ptr::null_mut();
        // SAFETY: caller contract.
        unsafe { sys::napi_create_double(env, self, &mut out) };
        out
    }
}

impl IntoJs for bool {
    #[inline(always)]
    unsafe fn into_js(self, env: sys::napi_env) -> sys::napi_value {
        let mut out = ptr::null_mut();
        // SAFETY: caller contract; returns a cached singleton.
        unsafe { sys::napi_get_boolean(env, self, &mut out) };
        out
    }
}

impl IntoJs for () {
    #[inline(always)]
    unsafe fn into_js(self, _env: sys::napi_env) -> sys::napi_value {
        ptr::null_mut() // undefined
    }
}

impl IntoJs for Value {
    #[inline(always)]
    unsafe fn into_js(self, _env: sys::napi_env) -> sys::napi_value {
        self.0
    }
}

impl IntoJs for TableBuf {
    unsafe fn into_js(self, env: sys::napi_env) -> sys::napi_value {
        match self.0 {
            Some(v) => v,
            // SAFETY: caller contract.
            None => unsafe { null(env) },
        }
    }
}

/// JS `null`.
///
/// # Safety
/// `env` must be live.
#[inline(always)]
pub unsafe fn null(env: sys::napi_env) -> sys::napi_value {
    let mut out = ptr::null_mut();
    // SAFETY: caller contract.
    unsafe { sys::napi_get_null(env, &mut out) };
    out
}

/// Creates a JS string without V8's (slow) UTF-8 decoder:
/// - ASCII: one-byte copy (`napi_create_string_latin1`);
/// - Latin-1 (every code point <= U+00FF): transcoded to one byte per character, then latin1;
/// - otherwise: transcoded to UTF-16 (`napi_create_string_utf16`).
///
/// Throws `RangeError: Invalid string length` (and returns null) when V8 refuses the string, instead of
/// silently returning `undefined`.
///
/// # Safety
/// `env` must be live.
#[inline]
pub unsafe fn js_string(env: sys::napi_env, s: &str, ascii: bool, latin1: bool) -> sys::napi_value {
    let mut out = ptr::null_mut();
    let st = if ascii {
        // SAFETY: caller contract; ptr/len describe `s`.
        unsafe { sys::napi_create_string_latin1(env, s.as_ptr().cast(), s.len() as isize, &mut out) }
    } else if latin1 {
        let buf = to_latin1(s);
        // SAFETY: as above, for `buf`.
        unsafe { sys::napi_create_string_latin1(env, buf.as_ptr().cast(), buf.len() as isize, &mut out) }
    } else {
        let buf = to_utf16(s);
        // SAFETY: as above, for `buf` (UTF-16 code units).
        unsafe { sys::napi_create_string_utf16(env, buf.as_ptr(), buf.len() as isize, &mut out) }
    };
    if st != sys::Status::napi_ok {
        // SAFETY: env is live; the message is NUL-terminated.
        unsafe { sys::napi_throw_range_error(env, ptr::null(), c"Invalid string length".as_ptr()) };
        return ptr::null_mut();
    }
    out
}

/// UTF-8 whose code points are all <= U+00FF -> one byte per code point. Branchless: every byte is
/// written at `j`; a continuation byte steps back and folds itself into the lead byte's slot.
fn to_latin1(s: &str) -> smallvec::SmallVec<[u8; 512]> {
    let b = s.as_bytes();
    let mut out: smallvec::SmallVec<[u8; 512]> = smallvec::smallvec![0; b.len()];
    let mut j = 0usize;
    for &x in b {
        let cont = ((x & 0xC0) == 0x80) as usize;
        j -= cont.min(j); // never underflows (valid UTF-8 starts with a lead byte)
        let prev = out[j];
        out[j] = if cont == 1 { ((prev & 0x03) << 6) | (x & 0x3F) } else { x };
        j += 1;
    }
    out.truncate(j);
    out
}

/// UTF-8 -> UTF-16 code units (straight-line decoder writing into a preallocated buffer; input is valid
/// UTF-8, so `b.len()` units always suffice).
fn to_utf16(s: &str) -> smallvec::SmallVec<[u16; 512]> {
    let b = s.as_bytes();
    let n = b.len();
    let mut out: smallvec::SmallVec<[u16; 512]> = smallvec::smallvec![0; n];
    let mut i = 0;
    let mut j = 0;
    while i < n {
        let x = b[i] as u32;
        if x < 0x80 {
            out[j] = x as u16;
            i += 1;
        } else if x < 0xE0 && i + 1 < n {
            out[j] = (((x & 0x1F) << 6) | (b[i + 1] as u32 & 0x3F)) as u16;
            i += 2;
        } else if x < 0xF0 && i + 2 < n {
            out[j] = (((x & 0x0F) << 12) | ((b[i + 1] as u32 & 0x3F) << 6) | (b[i + 2] as u32 & 0x3F)) as u16;
            i += 3;
        } else if i + 3 < n {
            let c = ((x & 0x07) << 18)
                | ((b[i + 1] as u32 & 0x3F) << 12)
                | ((b[i + 2] as u32 & 0x3F) << 6)
                | (b[i + 3] as u32 & 0x3F);
            if c >= crate::string::ESC_BASE {
                // a lone surrogate's escape (DESIGN §44)
                out[j] = (c - crate::string::ESC_BASE + 0xD800) as u16;
            } else {
                let c = c - 0x10000;
                out[j] = (0xD800 | (c >> 10)) as u16;
                j += 1;
                out[j] = (0xDC00 | (c & 0x3FF)) as u16;
            }
            i += 4;
        } else {
            out[j] = 0xFFFD; // unreachable for valid UTF-8
            i = n;
        }
        j += 1;
    }
    out.truncate(j);
    out
}

impl IntoJs for &str {
    #[inline(always)]
    unsafe fn into_js(self, env: sys::napi_env) -> sys::napi_value {
        let (ascii, latin1) =
            if self.is_ascii() { (true, true) } else { (false, crate::string::scan(self).2) };
        // SAFETY: caller contract.
        unsafe { js_string(env, self, ascii, latin1) }
    }
}

impl IntoJs for &Str {
    #[inline(always)]
    unsafe fn into_js(self, env: sys::napi_env) -> sys::napi_value {
        // SAFETY: caller contract.
        unsafe { js_string(env, self.as_str(), self.is_ascii(), self.is_latin1()) }
    }
}

impl<T: IntoJs> IntoJs for Option<T> {
    #[inline(always)]
    unsafe fn into_js(self, env: sys::napi_env) -> sys::napi_value {
        match self {
            // SAFETY: caller contract.
            Some(v) => unsafe { v.into_js(env) },
            // SAFETY: caller contract.
            None => unsafe { null(env) },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcoders() {
        // U+10F7FF is the last code point below the lone-surrogate escapes (DESIGN §44)
        for s in ["", "abc", "Grüße aus München", "ÿ\u{a0}é", "a😀b€", "\u{10F7FF}x\u{800}\u{7FF}"] {
            let want: Vec<u16> = s.encode_utf16().collect();
            assert_eq!(to_utf16(s).as_slice(), want.as_slice(), "{s:?}");
            if crate::string::scan(s).2 {
                let want: Vec<u8> = s.chars().map(|c| c as u32 as u8).collect();
                assert_eq!(to_latin1(s).as_slice(), want.as_slice(), "{s:?}");
            }
        }
        // escapes egress as their lone surrogates
        let esc = format!("a{}{}", crate::string::escape_unit(0xDC00), crate::string::escape_unit(0xDBFF));
        assert_eq!(to_utf16(&esc).as_slice(), &[0x61, 0xDC00, 0xDBFF]);
    }
}
