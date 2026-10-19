//! DOMException codes returned by mutators (DESIGN §3.1). The facade maps them to
//! `new DOMException(MSG[c], NAME[c])` in the test realm (see packages/rsdom/lib/dom.cjs `ERR_NAMES`).

/// A DOM error. `repr(u32)` values are the wire codes (0 = success).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum DomError {
    /// HierarchyRequestError
    HierarchyRequest = 1,
    /// NotFoundError
    NotFound = 2,
    /// InvalidCharacterError
    InvalidCharacter = 3,
    /// SyntaxError
    Syntax = 4,
    /// IndexSizeError
    IndexSize = 5,
    /// InvalidStateError
    InvalidState = 6,
    /// NotSupportedError
    NotSupported = 7,
    /// WrongDocumentError
    WrongDocument = 8,
    /// NamespaceError
    Namespace = 9,
    /// NoModificationAllowedError
    NoModificationAllowed = 10,
    /// TypeError (thrown as a plain TypeError by the facade, e.g. a non-node argument)
    Type = 11,
}

/// Result of a DOM operation.
pub type DomResult<T = ()> = Result<T, DomError>;

/// Wire code for a native's return value (0 = ok).
pub type Code = u32;

/// `Ok(()) -> 0`, `Err(e) -> e as u32`.
#[inline(always)]
pub fn code(r: DomResult) -> Code {
    match r {
        Ok(()) => 0,
        Err(e) => e as u32,
    }
}
