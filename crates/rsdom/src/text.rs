//! CharacterData (UTF-16 offsets), `textContent` get/set, `splitText`, `normalize`.

use crate::env::Env;
use crate::error::{Code, DomError, DomResult, code};
use crate::node::kind;
use crate::string::Str;
use crate::table::NodeId;
use crate::tree::Records;

impl Env {
    /// DOM "replace data" with UTF-16 offsets.
    pub fn replace_data(&mut self, id: NodeId, off16: u32, count16: u32, data: &str) -> DomResult {
        // The old value is only needed for a MutationObserver record: clone it only when one may be
        // interested, otherwise edit in place (appendData on a long text is O(appended)).
        let keep_old = crate::mo::active(self, id);
        let s = self.char_data_mut(id).ok_or(DomError::Type)?;
        if off16 > s.utf16_len() {
            return Err(DomError::IndexSize);
        }
        let count16 = count16.min(s.utf16_len() - off16);
        let old = if keep_old { s.clone() } else { Str::new() };
        s.replace_range16(off16, count16, data);
        self.hook_char_data_changed(id, &old);
        if !self.ranges.is_empty() {
            self.live_ranges_replace_data(id, off16, count16, crate::string::utf16_len(data));
        }
        Ok(())
    }

    /// Sets the whole data (`data =`, `nodeValue =`, `textContent =` on character data).
    pub fn set_data(&mut self, id: NodeId, data: &str) -> DomResult {
        let s = self.char_data_mut(id).ok_or(DomError::Type)?;
        let old = std::mem::replace(s, Str::from(data));
        self.hook_char_data_changed(id, &old);
        if !self.ranges.is_empty() {
            // DOM "replace data" with offset 0 and count = the old length
            self.live_ranges_replace_data(id, 0, old.utf16_len(), crate::string::utf16_len(data));
        }
        Ok(())
    }

    /// `Text.splitText(off16)`: returns the new node (inserted after `id` when it has a parent).
    pub fn split_text(&mut self, id: NodeId, off16: u32) -> DomResult<NodeId> {
        if !self.is_text(id) {
            return Err(DomError::Type);
        }
        let s = self.char_data(id).ok_or(DomError::Type)?;
        let len = s.utf16_len();
        if off16 > len {
            return Err(DomError::IndexSize);
        }
        // Spec: the new node is always a Text node (also when splitting a CDATASection).
        let tail = Str::from(s.substring16(off16, len - off16));
        let doc = self.node_doc(id);
        let new = self.create_chars_owned(doc, kind::TEXT, 0, tail);
        let parent = self.rec(id).parent;
        if parent != 0 {
            let next = self.rec(id).next;
            self.insert(new, parent, next, Records::Queue);
            if !self.ranges.is_empty() {
                self.live_ranges_split(id, new, off16, parent);
            }
        }
        self.replace_data(id, off16, len - off16, "")?;
        Ok(new)
    }

    /// `Node.normalize()`: removes empty Text nodes and merges runs of adjacent Text nodes.
    pub fn normalize(&mut self, root: NodeId) {
        let mut n = self.next_in_subtree(root, root);
        while n != 0 {
            if self.kind(n) != kind::TEXT {
                n = self.next_in_subtree(n, root);
                continue;
            }
            let len = self.char_data(n).map_or(0, |s| s.utf16_len());
            if len == 0 {
                let after = self.next_skipping_children(n, root);
                self.remove(n, Records::Queue);
                n = after;
                continue;
            }
            // Concatenate the data of contiguous following Text siblings.
            let mut data = String::new();
            let mut c = self.rec(n).next;
            while c != 0 && self.kind(c) == kind::TEXT {
                if let Some(s) = self.char_data(c) {
                    data.push_str(s);
                }
                c = self.rec(c).next;
            }
            // Unconditional (DOM "normalize" step 4): the replace-data step queues a characterData record
            // even when there is nothing to append.
            let _ = self.replace_data(n, len, 0, &data);
            if !self.ranges.is_empty() {
                // steps 6.5-6.9: boundary points in or before the merged siblings move into `n`
                let mut at = len;
                let mut c = self.rec(n).next;
                while c != 0 && self.kind(c) == kind::TEXT {
                    self.live_ranges_merge(n, c, at);
                    at += self.char_data(c).map_or(0, |s| s.utf16_len());
                    c = self.rec(c).next;
                }
            }
            let mut c = self.rec(n).next;
            while c != 0 && self.kind(c) == kind::TEXT {
                let nx = self.rec(c).next;
                self.remove(c, Records::Queue);
                c = nx;
            }
            n = self.next_in_subtree(n, root);
        }
    }

    /// `textContent` getter: `None` for documents and doctypes, own data for character data, otherwise
    /// the concatenation of Text/CDATA descendants (comments and PIs excluded).
    pub fn text_content(&mut self, id: NodeId) -> Option<&str> {
        match self.kind(id) {
            0 | kind::DOCUMENT | kind::DOCTYPE => None,
            kind::TEXT | kind::CDATA | kind::COMMENT | kind::PI => self.char_data(id).map(|s| s.as_str()),
            _ => {
                let mut out = std::mem::take(&mut self.scratch);
                out.clear();
                let mut n = self.next_in_subtree(id, id);
                while n != 0 {
                    if self.is_text(n) {
                        if let Some(s) = self.char_data(n) {
                            out.push_str(s);
                        }
                    }
                    n = self.next_in_subtree(n, id);
                }
                self.scratch = out;
                Some(&self.scratch)
            }
        }
    }

    /// `textContent` setter: string replace-all for elements/fragments (one record), replace data for
    /// character data, no-op for documents and doctypes.
    pub fn set_text_content(&mut self, id: NodeId, value: &str) -> DomResult {
        match self.kind(id) {
            0 => Err(DomError::Type),
            kind::DOCUMENT | kind::DOCTYPE => Ok(()),
            kind::TEXT | kind::CDATA | kind::COMMENT | kind::PI => self.set_data(id, value),
            _ => {
                let node = if value.is_empty() {
                    0
                } else {
                    let doc = self.node_doc(id);
                    self.create_text(doc, value)
                };
                self.replace_all(node, id);
                Ok(())
            }
        }
    }
}

natives! {
    /// CharacterData data (Text / Comment / CDATA / PI); "" for other nodes.
    fn dataGet(e, id: u32) -> &str {
        e.char_data(id).map_or("", |s| s.as_str())
    }
    /// Sets CharacterData data. Returns 0 or an error code.
    fn dataSet(e, id: u32, s: str) -> Code {
        code(e.set_data(id, s))
    }
    /// CharacterData length in UTF-16 code units.
    fn dataLen(e, id: u32) -> u32 {
        e.char_data(id).map_or(0, |s| s.utf16_len())
    }
    /// replaceData(off16, count16, s). Returns 0 or an error code (IndexSizeError).
    fn replaceData(e, id: u32, off16: u32, count16: u32, s: str) -> Code {
        code(e.replace_data(id, off16, count16, s))
    }
    /// splitText(off16): new node id, or 0 + EP[ERR].
    fn splitText(e, id: u32, off16: u32) -> u32 {
        let r = e.split_text(id, off16);
        e.id_or_fail(r)
    }
    /// normalize().
    fn normalize(e, id: u32) -> () {
        e.normalize(id)
    }
    /// textContent getter (null for documents and doctypes).
    fn textContentGet(e, id: u32) -> Option<&str> {
        e.text_content(id)
    }
    /// textContent setter (the facade maps null to ""). Returns 0 or an error code.
    fn textContentSet(e, id: u32, s: str) -> Code {
        code(e.set_text_content(id, s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atoms::atom;
    use crate::dom::DocKind;
    use crate::node::Ns;

    #[test]
    fn char_data_and_split() {
        let mut e = Env::new();
        let doc = e.create_document(DocKind::Html, None);
        let p = e.create_element(doc, atom::P, Ns::Html);
        let t = e.create_text(doc, "a😀b");
        e.append_child(p, t).unwrap();
        assert_eq!(e.replace_data(t, 9, 0, "x"), Err(DomError::IndexSize));
        let n = e.split_text(t, 3).unwrap();
        assert_eq!(e.char_data(t).unwrap().as_str(), "a😀");
        assert_eq!(e.char_data(n).unwrap().as_str(), "b");
        assert_eq!(e.rec(t).next, n);
        let c = e.create_comment(doc, "c");
        e.append_child(p, c).unwrap();
        assert_eq!(e.text_content(p), Some("a😀b"));
        e.normalize(p);
        assert_eq!(e.rec(p).child_len, 2);
        assert_eq!(e.char_data(t).unwrap().as_str(), "a😀b");
        e.set_text_content(p, "").unwrap();
        assert_eq!(e.rec(p).child_len, 0);
        e.set_text_content(p, "hi").unwrap();
        assert_eq!(e.rec(p).child_len, 1);
        assert_eq!(e.text_content(doc), None);
    }
}
