use crate::types::SharedList;
use std::{
    cell::RefCell,
    cmp::Ordering,
    collections::VecDeque,
    hash::{Hash, Hasher},
    sync::{Arc, OnceLock},
};

/// Small deterministic input caches; never store host facts or full suggestions.
pub(crate) struct TextMemo<T>(VecDeque<((String, u8), T)>);
impl<T> Default for TextMemo<T> {
    fn default() -> Self {
        Self(VecDeque::new())
    }
}
impl<T: Clone> TextMemo<T> {
    pub fn get(&self, input: &str, mode: u8) -> Option<T> {
        self.0
            .iter()
            .rev()
            .find(|((text, kind), _)| text == input && *kind == mode)
            .map(|(_, value)| value.clone())
    }
    pub fn insert(&mut self, input: &str, mode: u8, value: T) {
        if input.len() > 8192 {
            return;
        }
        self.0.push_back(((input.into(), mode), value));
        if self.0.len() > 32 {
            self.0.pop_front();
        }
    }
}
pub(crate) fn memo<T: Clone>(
    cache: &'static std::thread::LocalKey<RefCell<TextMemo<T>>>,
    input: &str,
    mode: u8,
    compute: impl FnOnce() -> T,
) -> T {
    if let Some(value) = cache.with(|memo| memo.borrow().get(input, mode)) {
        return value;
    }
    let value = compute();
    cache.with(|memo| memo.borrow_mut().insert(input, mode, value.clone()));
    value
}

/// Bounded memoization of deterministic parsing only, keyed by every input value.
pub struct ArrayCache<T> {
    entries: VecDeque<(u64, SharedList<String>, Arc<T>, usize)>,
    items: usize,
    bytes: usize,
}
impl<T> Default for ArrayCache<T> {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
            items: 0,
            bytes: 0,
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
            .position(|(old, key, _, _)| *old == hash && key.as_slice() == values)?;
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
            .position(|(_, key, _, _)| key.shares_storage(values))
            .or_else(|| {
                let hash = array_hash(values);
                self.entries
                    .iter()
                    .position(|(old, key, _, _)| *old == hash && key == values)
            })?;
        let mut entry = self.entries.remove(at).unwrap();
        entry.1 = values.clone();
        let result = entry.2.clone();
        self.entries.push_back(entry);
        Some(result)
    }
    pub fn insert_shared(&mut self, values: &SharedList<String>, value: Arc<T>) {
        let bytes = values.iter().map(String::len).sum::<usize>();
        if values.len() > 100000 || bytes > 32 * 1024 * 1024 {
            return;
        }
        self.items += values.len();
        self.bytes += bytes;
        self.entries
            .push_back((array_hash(values), values.clone(), value, bytes));
        while self.entries.len() > 64 || self.items > 100000 || self.bytes > 32 * 1024 * 1024 {
            if let Some((_, key, _, bytes)) = self.entries.pop_front() {
                self.items -= key.len();
                self.bytes -= bytes;
            }
        }
    }
}
fn array_hash(values: &[String]) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    values.hash(&mut hash);
    hash.finish()
}

/// Each literal expression owns its compiled regex, with no runtime lookup.
#[macro_export]
macro_rules! regex {
    ($pattern:literal) => {{
        static REGEX: std::sync::LazyLock<::regex::Regex> = std::sync::LazyLock::new(|| {
            ::regex::Regex::new($pattern).expect("static engine regex")
        });
        &*REGEX
    }};
}
#[macro_export]
macro_rules! test {
    ($pattern:literal, $text:expr $(,)?) => {
        $crate::regex!($pattern).is_match($text)
    };
}
#[macro_export]
macro_rules! replace {
    ($pattern:literal, $text:expr, $replacement:expr $(,)?) => {
        $crate::regex!($pattern)
            .replace_all($text, $replacement)
            .into_owned()
    };
}

/// The longest command text a repair accepts, in UTF-16 code units.
pub const MAX_COMMAND: usize = 2000;
/// Count JavaScript UTF-16 code units rather than bytes or Unicode scalars.
#[inline]
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}
/// Return the longest scalar-aligned prefix within a JavaScript UTF-16 length limit.
pub fn truncate_utf16(text: &str, limit: usize) -> &str {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        units += character.len_utf16();
        if units > limit {
            return &text[..index];
        }
    }
    text
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
    #[test]
    fn native_patterns_preserve_ascii_boundaries_and_explicit_whitespace() {
        fn compiled() -> &'static regex::Regex {
            crate::regex!(r"(?-u:\b)cat(?-u:\b)")
        }
        let first = compiled();
        for thread in (0..8).map(|_| std::thread::spawn(compiled)) {
            assert!(std::ptr::eq(first, thread.join().unwrap()));
        }
        assert!(first.is_match("écaté"));
        assert!(!first.is_match("scatter"));
        assert!(crate::test!(r"^[\x09-\x0d \u{feff}]$", "\u{feff}"));
    }
}

#[cfg(test)]
mod text_tests {
    use super::{truncate_utf16, utf16_len};
    #[test]
    fn utf16_limits_preserve_scalars_and_count_combining_characters_separately() {
        let text = "a😀e\u{301}";
        assert_eq!(utf16_len(text), 5);
        for (limit, expected) in [
            (0, ""),
            (1, "a"),
            (2, "a"),
            (3, "a😀"),
            (4, "a😀e"),
            (5, text),
            (usize::MAX, text),
        ] {
            assert_eq!(truncate_utf16(text, limit), expected);
        }
        assert_eq!(truncate_utf16("😀x", 1), "");
        assert_eq!(truncate_utf16("", 0), "");
    }
}
