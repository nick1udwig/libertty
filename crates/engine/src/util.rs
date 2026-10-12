use crate::types::SharedList;
use regex::Regex;
use std::{
    cmp::Ordering,
    collections::{HashMap, VecDeque},
    hash::{Hash, Hasher},
    sync::{Arc, Mutex, OnceLock},
};

/// Bounded memoization of deterministic parsing only, keyed by every input value.
pub struct ArrayCache<T> {
    entries: VecDeque<(u64, SharedList<String>, Arc<T>)>,
}
impl<T> Default for ArrayCache<T> {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
        }
    }
}
impl<T> ArrayCache<T> {
    pub fn latest(&self) -> Option<Arc<T>> {
        self.entries.back().map(|entry| entry.2.clone())
    }
    pub fn get(&mut self, values: &[String]) -> Option<Arc<T>> {
        let hash = array_hash(values);
        let at = self
            .entries
            .iter()
            .position(|(old, key, _)| *old == hash && key.as_slice() == values)?;
        let entry = self.entries.remove(at).unwrap();
        let result = entry.2.clone();
        self.entries.push_back(entry);
        Some(result)
    }
    pub fn insert(&mut self, values: &[String], value: Arc<T>) {
        self.insert_shared(&values.to_vec().into(), value);
    }
    pub fn get_shared(&mut self, values: &SharedList<String>) -> Option<Arc<T>> {
        let at = self
            .entries
            .iter()
            .position(|(_, key, _)| key.shares_storage(values))
            .or_else(|| {
                let hash = array_hash(values);
                self.entries
                    .iter()
                    .position(|(old, key, _)| *old == hash && key == values)
            })?;
        let mut entry = self.entries.remove(at).unwrap();
        entry.1 = values.clone();
        let result = entry.2.clone();
        self.entries.push_back(entry);
        Some(result)
    }
    pub fn insert_shared(&mut self, values: &SharedList<String>, value: Arc<T>) {
        if values.len() > 100000 || values.iter().map(String::len).sum::<usize>() > 32 * 1024 * 1024
        {
            return;
        }
        self.entries
            .push_back((array_hash(values), values.clone(), value));
        while self.entries.len() > 64
            || self
                .entries
                .iter()
                .map(|(_, key, _)| key.len())
                .sum::<usize>()
                > 100000
            || self
                .entries
                .iter()
                .flat_map(|(_, key, _)| key)
                .map(String::len)
                .sum::<usize>()
                > 32 * 1024 * 1024
        {
            self.entries.pop_front();
        }
    }
}
fn array_hash(values: &[String]) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    values.hash(&mut hash);
    hash.finish()
}

pub(crate) mod patterns {
    include!(concat!(env!("OUT_DIR"), "/patterns.rs"));
}
fn compile(pattern: &str) -> Regex {
    // Match ECMAScript expressions without the Unicode flag.
    let javascript = pattern
        .replace(r"\b", r"(?-u:\b)")
        .replace(r"\w", "[a-zA-Z0-9_]")
        .replace(r"\W", "[^a-zA-Z0-9_]")
        .replace(r"\s", r"[\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]");
    Regex::new(&javascript).expect("static engine regex")
}
#[inline]
pub fn regex(pattern: &str) -> Arc<Regex> {
    if let Some(regex) = patterns::compiled(pattern) {
        return regex.clone();
    }
    // Nonliteral patterns retain a bounded fallback cache.
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Regex>>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .expect("regex cache poisoned");
    if let Some(regex) = cache.get(pattern) {
        return regex.clone();
    }
    let regex = Arc::new(compile(pattern));
    if cache.len() >= 256 {
        let key = cache.keys().next().unwrap().clone();
        cache.remove(&key);
    }
    cache.insert(pattern.into(), regex.clone());
    regex
}
#[inline]
pub fn test(pattern: &str, text: &str) -> bool {
    regex(pattern).is_match(text)
}
#[inline]
pub fn replace(pattern: &str, text: &str, replacement: &str) -> String {
    regex(pattern).replace_all(text, replacement).into_owned()
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}
pub fn quoted_words(input: &str) -> Vec<&str> {
    let mut words = Vec::new();
    let mut at = 0;
    while at < input.len() {
        let tail = &input[at..];
        let first = tail.chars().next().unwrap();
        if js_whitespace(first) {
            at += first.len_utf8();
            continue;
        }
        let quoted_end = if first == '\'' || first == '"' {
            tail[1..]
                .char_indices()
                .take_while(|(_, c)| *c != '\n')
                .find(|(_, c)| *c == first)
                .map(|(end, _)| end + 2)
        } else {
            None
        };
        let length = quoted_end.unwrap_or_else(|| {
            tail.char_indices()
                .find(|(_, c)| js_whitespace(*c))
                .map_or(tail.len(), |(end, _)| end)
        });
        words.push(&input[at..at + length]);
        at += length;
    }
    words
}
pub fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub fn collapse(text: &str) -> String {
    let mut previous = None;
    text.chars()
        .filter(|ch| {
            if previous == Some(*ch) {
                false
            } else {
                previous = Some(*ch);
                true
            }
        })
        .collect()
}
pub fn locale_cmp(left: &str, right: &str) -> Ordering {
    static COLLATOR: OnceLock<icu_collator::CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            icu_collator::Collator::try_new(Default::default(), Default::default())
                .expect("compiled Unicode collation data")
        })
        .compare(left, right)
}

#[cfg(test)]
mod regex_tests {
    use super::*;
    #[test]
    fn literal_regexes_share_one_compilation_across_threads_and_keep_js_semantics() {
        let pattern = r"\bcat\b";
        let first = regex(pattern);
        let threads: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(move || {
                    let compiled = regex(pattern);
                    assert!(compiled.is_match("écaté"));
                    assert!(!compiled.is_match("scatter"));
                    compiled
                })
            })
            .collect();
        for thread in threads {
            assert!(Arc::ptr_eq(&first, &thread.join().unwrap()));
        }
        let first = regex("^[a-zA-Z0-9_@%+=:,./~-]+$");
        assert!(Arc::ptr_eq(
            &first,
            patterns::compiled("^[a-zA-Z0-9_@%+=:,./~-]+$").unwrap()
        ));
        assert!(test(r"^\s$", "\u{feff}"));
    }
}
