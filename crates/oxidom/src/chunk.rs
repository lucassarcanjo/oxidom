//! `ChunkVec<T>`: an append-only vector stored in fixed-size chunks that never move.
//!
//! Node payloads are append-only and indexed by `NodeRec.payload`. A plain `Vec` doubles by reallocating,
//! which copies everything and touches twice the memory; in VMs where first-touch page faults are
//! expensive (measured ~2 µs per 4 KiB page here) that dominated element creation. Chunks touch every byte
//! exactly once and keep indexing O(1) (shift + mask).

const SHIFT: usize = 10;
const CHUNK: usize = 1 << SHIFT;
const MASK: usize = CHUNK - 1;

/// Append-only chunked vector.
pub struct ChunkVec<T> {
    chunks: Vec<Vec<T>>,
    len: usize,
}

impl<T> Default for ChunkVec<T> {
    fn default() -> Self {
        ChunkVec { chunks: Vec::new(), len: 0 }
    }
}

impl<T> ChunkVec<T> {
    /// Empty vector.
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of elements.
    #[inline(always)]
    pub fn len(&self) -> usize {
        self.len
    }

    /// True if empty.
    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Appends `v`; returns its index.
    #[inline]
    pub fn push(&mut self, v: T) -> usize {
        let i = self.len;
        if i & MASK == 0 {
            self.chunks.push(Vec::with_capacity(CHUNK));
        }
        // The last chunk exists and has room: a new one was pushed when `len` crossed a chunk boundary.
        if let Some(c) = self.chunks.last_mut() {
            c.push(v);
        }
        self.len += 1;
        i
    }

    /// Bounds-checked access.
    #[inline(always)]
    pub fn get(&self, i: usize) -> Option<&T> {
        self.chunks.get(i >> SHIFT)?.get(i & MASK)
    }

    /// Bounds-checked mutable access.
    #[inline(always)]
    pub fn get_mut(&mut self, i: usize) -> Option<&mut T> {
        self.chunks.get_mut(i >> SHIFT)?.get_mut(i & MASK)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_get() {
        let mut v = ChunkVec::new();
        for i in 0..3000u32 {
            assert_eq!(v.push(i), i as usize);
        }
        assert_eq!(v.len(), 3000);
        assert_eq!(v.get(1023), Some(&1023));
        assert_eq!(v.get(1024), Some(&1024));
        assert_eq!(v.get(2999), Some(&2999));
        assert_eq!(v.get(3000), None);
        *v.get_mut(5).unwrap() = 9;
        assert_eq!(v.get(5), Some(&9));
    }
}
