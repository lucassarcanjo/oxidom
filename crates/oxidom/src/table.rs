//! The shared node table (DESIGN §2.2): one 64-byte record per node, exported zero-copy to JS as a single
//! external ArrayBuffer and read there as a `Uint32Array` with stride 16.
//!
//! Rust is the only writer. JS reads the view by contract and could still write into it, so every id Rust
//! reads back from a record is treated as untrusted and bounds-checked (`get`, never unchecked indexing).
//!
//! Storage is reserved with an anonymous `mmap` (`MAP_NORESERVE`), so pages are committed lazily as
//! records are touched: a 2^18-record reservation (16 MiB virtual) costs ~nothing in RSS until used.

use std::ptr::NonNull;

/// A node id: index into the table. 0 = null; ids stay below [`MAX_CAP`] = 2^27, so the facade's record
/// offset `id << 4` stays a non-negative int32.
pub type NodeId = u32;

/// One node record. Field order is the wire layout read by the facade (`T[(id << 4) + k]`).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct NodeRec {
    /// 0: parent node id
    pub parent: u32,
    /// 1: first child
    pub first: u32,
    /// 2: last child
    pub last: u32,
    /// 3: previous sibling
    pub prev: u32,
    /// 4: next sibling
    pub next: u32,
    /// 5: KIND(4b) | NS(2b)<<4 | flag bits (see `crate::node::meta`)
    pub meta: u32,
    /// 6: localName atom (elements), target atom (PIs); 0 otherwise
    pub local: u32,
    /// 7: bumped on any child-list change of THIS node (live childNodes/children validation)
    pub child_ver: u32,
    /// 8: ownerDocument node id (a document's own id for documents)
    pub owner: u32,
    /// 9: number of children
    pub child_len: u32,
    /// 10: CHECKED | SELECTED | INDETERMINATE | DIRTY_* | INPUT_TYPE(5b)<<8 | FOCUSED<<16 (forms/focus)
    pub state: u32,
    /// 11: elements: bumped on any attribute change; character data: data version (`DATA_VER`), set to
    /// the new `EP[TEXT]` on every data change (facade data memo key); documents: the document version,
    /// incremented on child-list and attribute changes of connected nodes (hooks.rs `bump_doc_version`)
    pub attr_ver: u32,
    /// 12: bumped on value/checked/selected/selection change (forms value memo)
    pub form_ver: u32,
    /// 13: index into Env.elems / chars / docs / doctypes (Rust-private meaning)
    pub payload: u32,
    /// 14-15: reserved (shadow host, attribute bloom in P2)
    pub res: [u32; 2],
}

const _: () = assert!(size_of::<NodeRec>() == 64);
const _: () = assert!(align_of::<NodeRec>() == 4);

/// u32 words per record.
pub const STRIDE: usize = 16;
/// Default reserved capacity (records).
pub const INITIAL_CAP: u32 = 1 << 18;
/// Hard limit: `id << 4` (the facade's record offset) must not overflow int32, so ids stay below 2^27
/// (an 8 GiB table).
pub const MAX_CAP: u32 = 1 << 27;
const _: () = assert!(((MAX_CAP as u64) << 4) <= i32::MAX as u64 + 1);

/// Lazily committed, page-aligned zeroed memory for `cap` records.
struct Block {
    ptr: NonNull<NodeRec>,
    cap: u32,
}

impl Block {
    fn bytes(cap: u32) -> usize {
        cap as usize * size_of::<NodeRec>()
    }

    #[cfg(unix)]
    fn alloc(cap: u32) -> Block {
        let len = Self::bytes(cap);
        // SAFETY: anonymous private mapping; no file descriptor or address hint. The kernel hands out
        // zero-filled pages on first touch, which is the lazy commit we want.
        let p = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANONYMOUS | libc::MAP_NORESERVE,
                -1,
                0,
            )
        };
        assert!(p != libc::MAP_FAILED, "oxidom: node table mmap of {len} bytes failed");
        Block { ptr: NonNull::new(p.cast()).expect("mmap returned null"), cap }
    }

    #[cfg(not(unix))]
    fn alloc(cap: u32) -> Block {
        use std::alloc::GlobalAlloc;
        let layout = std::alloc::Layout::from_size_align(Self::bytes(cap), 64).unwrap();
        // SAFETY: non-zero size layout.
        let p = unsafe { std::alloc::System.alloc_zeroed(layout) };
        Block { ptr: NonNull::new(p.cast()).expect("node table allocation failed"), cap }
    }
}

impl Drop for Block {
    #[cfg(unix)]
    fn drop(&mut self) {
        // SAFETY: ptr/len are exactly what mmap returned; nothing references the block after drop (the
        // owning Env detaches the JS ArrayBuffer before dropping the table).
        unsafe { libc::munmap(self.ptr.as_ptr().cast(), Self::bytes(self.cap)) };
    }

    #[cfg(not(unix))]
    fn drop(&mut self) {
        use std::alloc::GlobalAlloc;
        let layout = std::alloc::Layout::from_size_align(Self::bytes(self.cap), 64).unwrap();
        // SAFETY: allocated in `alloc` with the same layout.
        unsafe { std::alloc::System.dealloc(self.ptr.as_ptr().cast(), layout) };
    }
}

/// A table block retired by growth (see [`NodeTable::retire`]); unmapped on drop.
pub struct RetiredTable {
    _block: Block,
}

/// The node table. Record 0 is the all-zero null record.
pub struct NodeTable {
    block: Block,
    /// Next free id (= high-water mark; ids `1..len` are allocated).
    len: u32,
}

impl NodeTable {
    /// Reserves `cap` records (at least 2).
    pub fn with_capacity(cap: u32) -> Self {
        let cap = cap.clamp(2, MAX_CAP);
        NodeTable { block: Block::alloc(cap), len: 1 }
    }

    /// Next id to be allocated (high-water mark).
    #[inline(always)]
    pub fn len(&self) -> u32 {
        self.len
    }

    /// True when no node has been allocated.
    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.len <= 1
    }

    /// Reserved capacity in records.
    #[inline(always)]
    pub fn capacity(&self) -> u32 {
        self.block.cap
    }

    /// True if `id` names an allocated node.
    #[inline(always)]
    pub fn contains(&self, id: NodeId) -> bool {
        id != 0 && id < self.len
    }

    /// Bounds-checked shared access.
    #[inline(always)]
    pub fn get(&self, id: NodeId) -> Option<&NodeRec> {
        if self.contains(id) {
            // SAFETY: id < len <= cap, so the record lies inside the live mapping; JS cannot run while
            // this borrow is alive (single-threaded env, Rust never calls into JS).
            Some(unsafe { &*self.block.ptr.as_ptr().add(id as usize) })
        } else {
            None
        }
    }

    /// Bounds-checked mutable access.
    #[inline(always)]
    pub fn get_mut(&mut self, id: NodeId) -> Option<&mut NodeRec> {
        if self.contains(id) {
            // SAFETY: as in `get`; `&mut self` guarantees exclusivity on the Rust side.
            Some(unsafe { &mut *self.block.ptr.as_ptr().add(id as usize) })
        } else {
            None
        }
    }

    /// Appends a record if there is room; `None` means the caller must grow first.
    #[inline]
    pub fn try_push(&mut self, rec: NodeRec) -> Option<NodeId> {
        if self.len >= self.block.cap {
            return None;
        }
        let id = self.len;
        // SAFETY: id < cap, inside the mapping.
        unsafe { self.block.ptr.as_ptr().add(id as usize).write(rec) };
        self.len += 1;
        Some(id)
    }

    /// A new table with twice the capacity and the same contents.
    pub fn grown(&self) -> NodeTable {
        let cap = self
            .block
            .cap
            .checked_mul(2)
            .filter(|&c| c <= MAX_CAP)
            .expect("oxidom: node table limit (2^27 nodes)");
        let next = NodeTable::with_capacity(cap);
        // SAFETY: both blocks are valid for `len` records and do not overlap (distinct mappings).
        unsafe {
            std::ptr::copy_nonoverlapping(
                self.block.ptr.as_ptr(),
                next.block.ptr.as_ptr(),
                self.len as usize,
            );
        }
        NodeTable { block: next.block, len: self.len }
    }

    /// Retires a table replaced by growth: its pages are released (`MADV_DONTNEED`) and made inaccessible
    /// (`PROT_NONE`) but the address range stays reserved until the returned value is dropped (with the
    /// Env). A JS view that escaped the detach (e.g. `buffer.transfer()` on facade internals) then faults
    /// deterministically instead of reading memory that was reused for something else.
    pub fn retire(self) -> RetiredTable {
        #[cfg(unix)]
        {
            let len = Block::bytes(self.block.cap);
            // SAFETY: ptr/len are exactly the live mapping owned by `self.block`; nothing in Rust references
            // it any more (the caller replaced the table) and the JS ArrayBuffer over it was detached.
            unsafe {
                libc::madvise(self.block.ptr.as_ptr().cast(), len, libc::MADV_DONTNEED);
                libc::mprotect(self.block.ptr.as_ptr().cast(), len, libc::PROT_NONE);
            }
        }
        RetiredTable { _block: self.block }
    }

    /// Raw base pointer and byte length of the whole reservation (for the external ArrayBuffer).
    pub fn raw_parts(&self) -> (*mut u8, usize) {
        (self.block.ptr.as_ptr().cast(), Block::bytes(self.block.cap))
    }

    /// Copies record `id` as 16 words (fallback-mode reads); zeros for invalid ids.
    pub fn words(&self, id: NodeId) -> [u32; STRIDE] {
        let r = self.get(id).copied().unwrap_or_default();
        [
            r.parent,
            r.first,
            r.last,
            r.prev,
            r.next,
            r.meta,
            r.local,
            r.child_ver,
            r.owner,
            r.child_len,
            r.state,
            r.attr_ver,
            r.form_ver,
            r.payload,
            r.res[0],
            r.res[1],
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_get_grow() {
        let mut t = NodeTable::with_capacity(4);
        assert!(t.get(0).is_none());
        let a = t.try_push(NodeRec { meta: 1, ..Default::default() }).unwrap();
        let b = t.try_push(NodeRec { meta: 3, ..Default::default() }).unwrap();
        assert_eq!((a, b), (1, 2));
        t.try_push(NodeRec::default()).unwrap();
        assert!(t.try_push(NodeRec::default()).is_none());
        let g = t.grown();
        assert_eq!(g.capacity(), 8);
        assert_eq!(g.get(2).unwrap().meta, 3);
        assert!(g.get(4).is_none());
        assert!(t.get(99).is_none());
    }
}
