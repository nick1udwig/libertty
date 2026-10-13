use crate::{
    command_policy::*, command_speech::command_speech_shared, speech::expand_symbols, types::*,
    util::*,
};
use std::{
    cell::RefCell,
    collections::{BTreeSet, HashMap, HashSet},
    rc::Rc,
    sync::{Arc, Mutex, OnceLock},
};

thread_local! { static TOKENS: RefCell<TextMemo<SharedList<Token>>> = RefCell::new(TextMemo::default()); }
pub fn tokens(input: &str) -> SharedList<Token> {
    memo(&TOKENS, input, 0, || parsed_tokens(input))
}
fn parsed_tokens(input: &str) -> SharedList<Token> {
    if let Some(spans) = crate::shell_structure::word_spans(input) {
        let parsed: Option<Vec<_>> = spans
            .iter()
            .map(|span| {
                let text = &input[span.clone()];
                let words = crate::validation::simple_words(text)?;
                if words.len() != 1 {
                    return None;
                }
                Some(Token {
                    value: words[0].value.clone(),
                    quoted: text.starts_with(['\'', '"']),
                })
            })
            .collect();
        if let Some(parsed) = parsed {
            return parsed.into();
        }
    }
    quoted_words(input)
        .into_iter()
        .map(|text| {
            let quoted = text.starts_with(['\'', '"']);
            Token {
                value: if quoted && text.chars().count() > 1 {
                    text[1..text.len() - text.chars().last().unwrap().len_utf8()].into()
                } else if quoted {
                    String::new()
                } else {
                    text.into()
                },
                quoted,
            }
        })
        .collect()
}
pub fn shell_quote(value: &str) -> String {
    if let Some(rest) = value.strip_prefix("~/") {
        return format!("~/{}", shell_quote(rest));
    }
    if test("^[a-zA-Z0-9_@%+=:,./~-]+$", value) {
        value.into()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}
pub fn command_names(input: &str, catalog: &Catalog) -> Vec<String> {
    let words = tokens(input);
    let first = words.first().map(|word| word.value.as_str());
    let helpers: HashSet<&str> = catalog
        .functions
        .iter()
        .flatten()
        .filter(|name| name.starts_with('_'))
        .map(String::as_str)
        .collect();
    catalog
        .commands
        .iter()
        .filter(|name| !helpers.contains(name.as_str()) || first == Some(name.as_str()))
        .cloned()
        .collect()
}
pub(crate) fn command_available(input: &str, catalog: &Catalog, command: &str) -> bool {
    if !catalog.commands.iter().any(|name| name == command) {
        return false;
    }
    if !command.starts_with('_')
        || !catalog
            .functions
            .iter()
            .flatten()
            .any(|name| name == command)
    {
        return true;
    }
    tokens(input)
        .first()
        .is_some_and(|word| word.value == command)
}
fn filtered_commands(input: &str, catalog: &Catalog) -> SharedList<String> {
    if catalog
        .functions
        .iter()
        .flatten()
        .any(|name| name.starts_with('_'))
    {
        command_names(input, catalog).into()
    } else {
        catalog.commands.clone()
    }
}
fn command_tokens(input: &str, catalog: &Catalog) -> SharedList<Token> {
    let mut words = tokens(input);
    let Some(first) = words.first() else {
        return words;
    };
    let index = match_index(&catalog.commands, Some(&catalog.commands));
    if first.quoted || index.lower.contains_key(&first.value.to_lowercase()) {
        return words;
    }
    let structural = replace("[\u{2010}-\u{2015}\u{2212}]", &first.value, "-");
    let folded = structural.to_lowercase();
    let mut prefixes: Vec<_> = folded
        .char_indices()
        .filter(|(_, c)| *c == '-')
        .flat_map(|(at, _)| index.lower.get(&folded[..at]).into_iter().flatten())
        .map(|at| &catalog.commands[*at])
        .filter(|name| utf16_len(&structural) > utf16_len(name) + 1)
        .collect();
    prefixes.sort_by(|a, b| {
        utf16_len(b)
            .cmp(&utf16_len(a))
            .then_with(|| locale_cmp(a, b))
    });
    if let Some(prefix) = prefixes.first() {
        let offset = first
            .value
            .char_indices()
            .nth(prefix.chars().count())
            .map_or(first.value.len(), |(at, _)| at);
        let original = first.value[..offset].to_owned();
        let structural_offset = structural
            .char_indices()
            .nth(prefix.chars().count())
            .map_or(structural.len(), |(at, _)| at);
        let suffix = structural[structural_offset..].to_owned();
        words.splice(
            0..1,
            [
                Token {
                    value: original,
                    quoted: false,
                },
                Token {
                    value: suffix,
                    quoted: false,
                },
            ],
        );
    }
    words
}
pub fn key(value: &str) -> String {
    let text = value.to_lowercase();
    let mut normalized = String::with_capacity(text.len());
    for word in text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
        let word = match word {
            "three" => "3",
            "two" => "2",
            "dot" | "dash" | "hyphen" | "underscore" => "",
            "pie" => "py",
            word => word,
        };
        normalized.extend(word.chars().filter(char::is_ascii_alphanumeric));
    }
    normalized
}
fn sounds(normalized: &str) -> String {
    let bytes = normalized.as_bytes();
    let mut result = String::with_capacity(bytes.len());
    let (mut at, mut previous) = (0, None);
    while at < bytes.len() {
        let (value, count) = match bytes.get(at..at + 2) {
            Some(b"ph") => (b'f', 2),
            Some(b"ck" | b"qu") => (b'k', 2),
            _ => (bytes[at], 1),
        };
        at += count;
        let value = match value {
            b'a' | b'e' | b'i' | b'o' | b'u' | b'y' => continue,
            b'c' | b'g' => b'k',
            b's' | b'z' => b's',
            value => value,
        };
        if previous != Some(value) {
            result.push(value as char);
            previous = Some(value);
        }
    }
    result
}
fn one_edit(a: &str, b: &str) -> bool {
    if a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() == b.len()
        && let Some(at) = a.iter().zip(b).position(|(a, b)| a != b)
        && at + 1 < a.len()
        && a[at] == b[at + 1]
        && a[at + 1] == b[at]
        && a[at + 2..] == b[at + 2..]
    {
        return true;
    }
    let (mut i, mut j, mut edits) = (0, 0, 0);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            i += 1;
            j += 1;
            continue;
        }
        edits += 1;
        if edits > 1 {
            return false;
        }
        if a.len() >= b.len() {
            i += 1;
        }
        if b.len() >= a.len() {
            j += 1;
        }
    }
    edits + (a.len() - i) + (b.len() - j) <= 1
}
fn short_voicing(a: &str, b: &str) -> bool {
    if a.len() != b.len() || ![2, 3].contains(&a.len()) {
        return false;
    }
    if a.len() == 3 && (a.as_bytes()[1] != b.as_bytes()[1] || !b"aeiou".contains(&a.as_bytes()[1]))
    {
        return false;
    }
    let unvoice = |text: &str| {
        text.chars()
            .map(|ch| match ch {
                'b' => 'p',
                'd' => 't',
                'g' => 'k',
                'v' => 'f',
                'z' => 's',
                _ => ch,
            })
            .collect::<String>()
    };
    a != b && unvoice(a) == unvoice(b)
}
struct Prepared {
    value: String,
    lower: String,
    normalized: String,
    phonetic: String,
}
impl Prepared {
    fn new(value: &str) -> Self {
        let normalized = key(value);
        let phonetic = sounds(&normalized);
        Self {
            value: value.into(),
            lower: value.to_lowercase(),
            normalized,
            phonetic,
        }
    }
}
struct MatchIndex {
    entries: Vec<Prepared>,
    lower: HashMap<String, Vec<usize>>,
    normalized: HashMap<String, Vec<usize>>,
    phonetic: HashMap<String, Vec<usize>>,
    lengths: HashMap<usize, Vec<usize>>,
}
fn match_index(candidates: &[String], shared: Option<&SharedList<String>>) -> Arc<MatchIndex> {
    static CACHE: OnceLock<Mutex<ArrayCache<MatchIndex>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let cached = {
        let mut cache = cache.lock().unwrap();
        match shared {
            Some(shared) => cache.get_shared(shared),
            None => cache.get(candidates),
        }
    };
    if let Some(index) = cached {
        return index;
    }
    let entries: Vec<_> = candidates
        .iter()
        .map(|value| Prepared::new(value))
        .collect();
    let mut index = MatchIndex {
        entries,
        lower: HashMap::with_capacity(candidates.len()),
        normalized: HashMap::with_capacity(candidates.len()),
        phonetic: HashMap::with_capacity(candidates.len()),
        lengths: HashMap::new(),
    };
    for (i, entry) in index.entries.iter().enumerate() {
        index.lower.entry(entry.lower.clone()).or_default().push(i);
        index
            .normalized
            .entry(entry.normalized.clone())
            .or_default()
            .push(i);
        index
            .phonetic
            .entry(entry.phonetic.clone())
            .or_default()
            .push(i);
        index
            .lengths
            .entry(entry.normalized.len())
            .or_default()
            .push(i);
    }
    let index = Arc::new(index);
    let mut cache = cache.lock().unwrap();
    if let Some(shared) = shared {
        cache.insert_shared(shared, index.clone());
    } else {
        cache.insert(candidates, index.clone());
    }
    index
}
fn score(spoken: &Prepared, exact: &Prepared) -> f64 {
    if spoken.value == exact.value {
        return 100.0;
    }
    if spoken.lower == exact.lower {
        return 98.0;
    }
    let a = &spoken.normalized;
    let b = &exact.normalized;
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 94.0;
    }
    if a.len() >= 4
        && b.len() >= 4
        && spoken.phonetic == exact.phonetic
        && a.len().abs_diff(b.len()) <= 2
    {
        return 66.0;
    }
    if a.len() >= 3 && b.len() >= 3 && one_edit(a, b) {
        return 64.0;
    }
    if short_voicing(a, b) {
        return 60.0;
    }
    0.0
}
pub fn similarity(spoken: &str, exact: &str) -> f64 {
    score(&Prepared::new(spoken), &Prepared::new(exact))
}
fn prepared_completion_score(spoken: &Prepared, exact: &Prepared) -> f64 {
    let a = &spoken.normalized;
    let b = &exact.normalized;
    if a.len() >= 3 && a.len() < b.len() && b.starts_with(a) {
        56.0
    } else {
        0.0
    }
}
pub fn completion_score(spoken: &str, exact: &str) -> f64 {
    prepared_completion_score(&Prepared::new(spoken), &Prepared::new(exact))
}
struct DirectoryIndex {
    entries: SharedList<DirectoryEntry>,
    directories: Vec<(usize, Prepared)>,
    files: Vec<(usize, Prepared)>,
}
#[cfg(test)]
mod directory_index_tests {
    use super::*;
    #[test]
    fn cached_names_follow_snapshot_identity_and_keep_unicode_and_type_filtering() {
        let original: SharedList<DirectoryEntry> = vec![
            DirectoryEntry {
                name: "Workspace".into(),
                directory: true,
                symlink: false,
            },
            DirectoryEntry {
                name: "Café".into(),
                directory: false,
                symlink: false,
            },
        ]
        .into();
        assert_eq!(
            directory_scores("work space", &original, true, false, true)[0].1,
            94.0
        );
        assert_eq!(
            directory_scores("CAFÉ", &original, false, false, false)[0].1,
            98.0
        );
        let mut changed = original.clone();
        changed[0].name = "Other".into();
        assert_eq!(
            directory_scores("work space", &changed, true, false, true)[0].1,
            0.0
        );
        assert_eq!(
            directory_scores("work space", &original, true, false, true)[0].1,
            94.0
        );
        assert_eq!(
            directory_scores("work", &original, true, true, true)[0].1,
            56.0
        );
    }
}
thread_local! { static DIRECTORIES: RefCell<std::collections::VecDeque<Arc<DirectoryIndex>>> = RefCell::new(Default::default()); }
pub(crate) fn directory_scores<'a>(
    spoken: &str,
    entries: &'a SharedList<DirectoryEntry>,
    directory: bool,
    complete: bool,
    spelling: bool,
) -> Vec<(&'a DirectoryEntry, f64)> {
    let cached = DIRECTORIES.with(|cache| {
        cache
            .borrow()
            .iter()
            .find(|index| index.entries.shares_storage(entries))
            .cloned()
    });
    let index = cached.unwrap_or_else(|| {
        let mut index = DirectoryIndex {
            entries: entries.clone(),
            directories: vec![],
            files: vec![],
        };
        for (at, entry) in entries.iter().enumerate() {
            if entry.directory || entry.symlink {
                index.directories.push((at, Prepared::new(&entry.name)));
            }
            if !entry.directory || entry.symlink {
                index.files.push((at, Prepared::new(&entry.name)));
            }
        }
        let index = Arc::new(index);
        if entries.len() <= 30000 {
            DIRECTORIES.with(|cache| {
                let mut cache = cache.borrow_mut();
                cache.push_back(index.clone());
                while cache.len() > 32
                    || cache.iter().map(|index| index.entries.len()).sum::<usize>() > 30000
                {
                    cache.pop_front();
                }
            });
        }
        index
    });
    let spoken = Prepared::new(spoken);
    let candidates = if directory {
        &index.directories
    } else {
        &index.files
    };
    let mut values: Vec<_> = candidates
        .iter()
        .map(|(at, name)| (*at, score(&spoken, name)))
        .collect();
    let completion = complete && values.iter().all(|(_, score)| *score == 0.0);
    let folded: Vec<_> = spoken.lower.encode_utf16().collect();
    for ((_, value), (_, name)) in values.iter_mut().zip(candidates) {
        if completion {
            *value = prepared_completion_score(&spoken, name);
        }
        if spelling
            && *value == 0.0
            && folded.len() >= 3
            && folded.len() == name.lower.encode_utf16().count()
            && folded
                .iter()
                .copied()
                .zip(name.lower.encode_utf16())
                .filter(|(a, b)| a != b)
                .count()
                == 1
        {
            *value = 62.0;
        }
    }
    values
        .into_iter()
        .map(|(at, score)| (&entries[at], score))
        .collect()
}
fn sort_matches(found: &mut [Match]) {
    found.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| locale_cmp(&a.value, &b.value))
    });
}
pub fn matches(
    words: &[Token],
    start: usize,
    candidates: &[String],
    max_words: usize,
    complete_final: bool,
) -> Vec<Match> {
    indexed_matches(words, start, candidates, max_words, complete_final, None)
}
fn indexed_matches(
    words: &[Token],
    start: usize,
    candidates: &[String],
    max_words: usize,
    complete_final: bool,
    shared: Option<&SharedList<String>>,
) -> Vec<Match> {
    if start >= words.len() {
        return vec![];
    }
    let mut found = Vec::new();
    let index = match_index(candidates, shared);
    for length in 1..=max_words.min(words.len() - start) {
        let span = &words[start..start + length];
        if span
            .iter()
            .any(|word| word.quoted || word.value.starts_with('-'))
        {
            break;
        }
        if test(
            "(?i)^(dash|hyphen|underscore|dot|hep)$",
            &span.last().unwrap().value,
        ) {
            continue;
        }
        let spoken = span
            .iter()
            .map(|word| word.value.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let spoken = Prepared::new(&spoken);
        let mut nearby = BTreeSet::new();
        for bucket in [
            index.lower.get(&spoken.lower),
            index.normalized.get(&spoken.normalized),
            index.phonetic.get(&spoken.phonetic),
        ] {
            nearby.extend(bucket.into_iter().flatten().copied());
        }
        for length in spoken.normalized.len().saturating_sub(1)..=spoken.normalized.len() + 1 {
            nearby.extend(index.lengths.get(&length).into_iter().flatten().copied());
        }
        for at in nearby {
            let candidate = &index.entries[at];
            let value = score(&spoken, candidate);
            if value > 0.0 {
                found.push(Match {
                    value: candidate.value.clone(),
                    consumed: length,
                    score: value + (length - 1) as f64 * 8.0,
                });
            }
        }
    }
    let tail = &words[start..];
    if complete_final
        && found.is_empty()
        && !tail.is_empty()
        && tail.len() <= max_words
        && !tail
            .iter()
            .any(|word| word.quoted || word.value.starts_with('-'))
        && !test(
            "(?i)^(dash|hyphen|underscore|dot|hep)$",
            &tail.last().unwrap().value,
        )
    {
        let spoken = tail
            .iter()
            .map(|word| word.value.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let spoken = Prepared::new(&spoken);
        for candidate in &index.entries {
            let score = prepared_completion_score(&spoken, candidate);
            if score > 0.0 {
                found.push(Match {
                    value: candidate.value.clone(),
                    consumed: tail.len(),
                    score: score + (tail.len() - 1) as f64 * 8.0,
                });
            }
        }
    }
    sort_matches(&mut found);
    found.truncate(4);
    found
}
fn command_matches(words: &[Token], candidates: &SharedList<String>) -> Vec<Match> {
    let index = match_index(candidates, Some(candidates));
    let exact = words
        .first()
        .is_some_and(|word| index.lower.contains_key(&word.value.to_lowercase()));
    let speech = command_speech_shared(words, candidates, Some(candidates))
        .into_iter()
        .filter(|item| !exact || item.score >= 94.0);
    let mut found: Vec<_> = indexed_matches(words, 0, candidates, 3, false, Some(candidates))
        .into_iter()
        .chain(speech)
        .collect();
    sort_matches(&mut found);
    let mut seen = HashSet::new();
    found.retain(|item| seen.insert((item.value.clone(), item.consumed)));
    found.truncate(4);
    found
}
struct Boundary {
    command: String,
    prefix: String,
    suffix: String,
    rest: String,
}
fn compact_boundaries(input: &str, catalog: &Catalog) -> Vec<Boundary> {
    let words = tokens(input);
    let Some(first) = words.first() else {
        return vec![];
    };
    let names = match_index(&catalog.commands, Some(&catalog.commands));
    if first.quoted
        || !test("^[a-zA-Z0-9]+$", &first.value)
        || names.lower.contains_key(&first.value.to_lowercase())
    {
        return vec![];
    }
    let mut result = Vec::new();
    for index in (1..first.value.len()).rev() {
        let prefix = &first.value[..index];
        if let Some(command) = names
            .lower
            .get(&prefix.to_lowercase())
            .and_then(|indices| indices.first())
            .map(|at| &catalog.commands[*at])
        {
            result.push(Boundary {
                command: command.clone(),
                prefix: prefix.into(),
                suffix: first.value[index..].into(),
                rest: input.trim_start()[first.value.len()..].into(),
            });
        }
    }
    result
}
pub fn discovery_target(input: &str, catalog: &Catalog) -> String {
    if crate::validation::simple_words(input).is_none() {
        return String::new();
    }
    let words = command_tokens(input, catalog);
    let command = command_matches(&words, &filtered_commands(input, catalog))
        .into_iter()
        .next();
    if let Some(command) = command {
        std::iter::once(shell_quote(&command.value))
            .chain(
                words
                    .iter()
                    .skip(command.consumed)
                    .map(|word| shell_quote(&word.value)),
            )
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        compact_boundaries(input, catalog)
            .first()
            .map_or(String::new(), |boundary| boundary.command.clone())
    }
}
pub fn discovery_targets(input: &str, catalog: &Catalog) -> Vec<String> {
    if crate::validation::simple_words(input).is_none() {
        return vec![];
    }
    let words = command_tokens(input, catalog);
    let names = filtered_commands(input, catalog);
    let index = match_index(&names, Some(&names));
    let exact: Vec<_> = words
        .first()
        .and_then(|word| index.lower.get(&word.value.to_lowercase()))
        .into_iter()
        .flatten()
        .map(|at| &names[*at])
        .collect();
    let roots = indexed_matches(&words, 0, &names, 1, false, Some(&names))
        .into_iter()
        .chain(command_matches(&words, &names))
        .filter(|item| {
            exact.is_empty()
                || exact.contains(&&item.value)
                || (item.consumed > 1 && item.score >= 94.0)
        });
    let mut unique: Vec<Match> = Vec::new();
    for item in roots {
        if let Some(previous) = unique
            .iter_mut()
            .find(|previous| previous.value == item.value)
        {
            if previous.score < item.score {
                *previous = item;
            }
        } else {
            unique.push(item);
        }
    }
    unique
        .into_iter()
        .take(3)
        .map(|item| {
            std::iter::once(shell_quote(&item.value))
                .chain(
                    words
                        .iter()
                        .skip(item.consumed)
                        .map(|word| shell_quote(&word.value)),
                )
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect()
}
pub(crate) fn argument_matches(words: &[Token], start: usize, values: &[String]) -> Vec<Match> {
    if values.contains(&words[start].value) {
        return vec![Match {
            value: words[start].value.clone(),
            consumed: 1,
            score: 100.0,
        }];
    }
    let mut found = matches(words, start, values, 16, false);
    for count in 1..=16.min(words.len() - start) {
        let span = &words[start..start + count];
        if span
            .iter()
            .any(|word| word.quoted || word.value.starts_with('-'))
        {
            break;
        }
        if test(
            "(?i)^(dash|hyphen|underscore|dot|hep)$",
            &span.last().unwrap().value,
        ) {
            continue;
        }
        let spelling = span
            .iter()
            .map(|word| word.value.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        for value in values {
            if completion_score(&spelling, value) > 0.0 {
                found.push(Match {
                    value: value.clone(),
                    consumed: count,
                    score: 72.0 + (count - 1) as f64 * 8.0,
                });
            }
        }
    }
    sort_matches(&mut found);
    let mut seen = HashSet::new();
    found.retain(|item| seen.insert(item.value.clone()));
    found.truncate(4);
    found
}
pub fn repair(
    input: &str,
    catalog: &Catalog,
    script_flags: Option<&[Flag]>,
    metadata: &CommandMetadata,
) -> Vec<Candidate> {
    let candidates = repair_candidates(input, catalog, script_flags, metadata);
    let literal = candidates.iter().find(|c| c.is_literal()).cloned();
    let mut selected: Vec<_> = candidates
        .into_iter()
        .filter(|c| !c.is_literal())
        .take(3)
        .collect();
    if let Some(literal) = literal {
        selected.push(literal);
    }
    selected
}

/// Keep the bounded search frontier separate from the user-visible choice limit.
pub(crate) fn repair_candidates(
    input: &str,
    catalog: &Catalog,
    script_flags: Option<&[Flag]>,
    metadata: &CommandMetadata,
) -> Vec<Candidate> {
    let mut catalog = catalog.clone();
    if catalog
        .functions
        .iter()
        .flatten()
        .any(|name| name.starts_with('_'))
    {
        catalog.commands = command_names(input, &catalog).into();
    }
    if let Some(sentence) = regex("^(.*[a-zA-Z])\\.$").captures(input) {
        let last = tokens(input)
            .last()
            .map_or(String::new(), |word| word.value.clone());
        if !catalog.paths.contains(&last) && !test(r#"["'|&;<>()`$\\]"#, input) {
            let clean: Vec<_> = repair_candidates(&sentence[1], &catalog, script_flags, metadata)
                .into_iter()
                .filter(|candidate| !candidate.is_literal())
                .collect();
            if clean.iter().any(|candidate| {
                let args = tokens(&candidate.command);
                args.len() == 2
                    && subcommands_for(&args[0].value, metadata).contains(&args[1].value)
            }) {
                let mut result: Vec<_> = clean
                    .into_iter()
                    .map(|mut candidate| {
                        candidate.changes.push(Change::SentencePunctuation);
                        candidate
                    })
                    .collect();
                result.push(Candidate::literal(input));
                return result;
            }
        }
    }
    let expanded = expand_symbols(input, false);
    let candidates = repair_normalized(&expanded, &catalog, script_flags, metadata);
    if expanded == input {
        return candidates;
    }
    let mut result: Vec<_> = candidates
        .into_iter()
        .filter(|candidate| !candidate.is_literal())
        .map(|mut candidate| {
            candidate.changes.insert(0, Change::Symbols);
            candidate
        })
        .collect();
    if test(r#"[|&;<>()`$\\*?"'!\[\]{}#^]"#, &expanded) {
        let words = tokens(&expanded);
        let first = words.first().map(|word| word.value.as_str()).unwrap_or("");
        let canonical = catalog
            .commands
            .iter()
            .find(|name| name.to_lowercase() == first.to_lowercase());
        return vec![
            Candidate {
                command: canonical.map_or(expanded.clone(), |name| {
                    format!("{name}{}", &expanded[first.len()..])
                }),
                score: 90.0,
                changes: vec![Change::Symbols],
                literal: None,
                evidence: Evidence::default(),
            },
            Candidate::literal(input),
        ];
    }
    result.truncate(16);
    result.push(Candidate::literal(input));
    result
}
fn repair_normalized(
    input: &str,
    catalog: &Catalog,
    script_flags: Option<&[Flag]>,
    metadata: &CommandMetadata,
) -> Vec<Candidate> {
    let initial = repair_one(input, catalog, script_flags, metadata);
    if input.trim().is_empty()
        || crate::validation::simple_words(input).is_none()
        || initial
            .iter()
            .any(|candidate| !candidate.is_literal() && candidate.score >= 90.0)
    {
        return initial;
    }
    let mut candidates: Vec<_> = initial
        .iter()
        .filter(|candidate| !candidate.is_literal())
        .cloned()
        .collect();
    for boundary in compact_boundaries(input, catalog) {
        let flags = flags_for(&boundary.command, metadata);
        let mut options = Vec::new();
        for flag in &flags {
            if flag.name.trim_start_matches('-').to_lowercase() == boundary.suffix.to_lowercase()
                && !options.contains(&flag.name)
            {
                options.push(flag.name.clone());
            }
        }
        for suffix in [&boundary.suffix, &boundary.suffix.to_lowercase()] {
            let option = format!("-{suffix}");
            if option_arity(&option, &flags).is_some() && !options.contains(&option) {
                options.push(option);
            }
        }
        for option in options {
            for mut candidate in repair_one(
                &format!("{} {option}{}", boundary.prefix, boundary.rest),
                catalog,
                script_flags,
                metadata,
            ) {
                if candidate.is_literal() {
                    continue;
                }
                let duplicate = boundary.command.chars().last().is_some_and(|ch| {
                    boundary.suffix.to_lowercase() == ch.to_lowercase().to_string()
                });
                let spelling = if duplicate {
                    initial.iter().find(|item| {
                        !item.is_literal()
                            && tokens(&item.command)
                                .first()
                                .is_some_and(|word| word.value == boundary.command)
                    })
                } else {
                    None
                };
                candidate.score = spelling.map_or(candidate.score - 8.0, |item| {
                    (candidate.score - 8.0).min(item.score - 6.0)
                });
                if let Some(spelling) = spelling {
                    candidate.evidence.confidence = candidate
                        .evidence
                        .confidence
                        .min((spelling.evidence.confidence - 6.0).max(0.0));
                }
                candidate.changes.insert(0, Change::Boundary);
                candidates.push(candidate);
            }
        }
    }
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut seen = HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.command.clone()));
    candidates.truncate(16);
    if candidates.len() < 16 {
        candidates.push(Candidate::literal(input));
    }
    candidates
}

#[derive(Clone)]
struct Trail<T: Clone>(Rc<TrailNode<T>>);
struct TrailNode<T: Clone> {
    parent: Option<Trail<T>>,
    value: T,
    len: usize,
}
impl<T: Clone> Trail<T> {
    fn new(value: T) -> Self {
        Self(Rc::new(TrailNode {
            parent: None,
            value,
            len: 1,
        }))
    }
    fn push(&mut self, value: T) {
        *self = Self(Rc::new(TrailNode {
            parent: Some(self.clone()),
            value,
            len: self.len() + 1,
        }));
    }
    fn len(&self) -> usize {
        self.0.len
    }
    fn first(&self) -> &T {
        let mut node = self;
        while let Some(parent) = &node.0.parent {
            node = parent;
        }
        &node.0.value
    }
    fn values(&self) -> Vec<&T> {
        let mut values = Vec::with_capacity(self.len());
        let mut node = Some(self);
        while let Some(current) = node {
            values.push(&current.0.value);
            node = current.0.parent.as_ref();
        }
        values.reverse();
        values
    }
}
#[derive(Clone)]
struct State<'a> {
    args: Trail<String>,
    scope: String,
    index: usize,
    score: f64,
    confidence: f64,
    unresolved: usize,
    changes: Option<Trail<Change>>,
    value_next: bool,
    value_remaining: usize,
    value_limit: Option<usize>,
    active_value: Option<Flag>,
    flags: &'a [Flag],
    literal_rest: bool,
    quoted: Vec<usize>,
    fold_flags: bool,
    repaired_flag: bool,
    script_scope: bool,
}
#[derive(Default)]
struct Push {
    consumed: usize,
    score: f64,
    confidence: Option<f64>,
    change: Option<Change>,
    flag: Option<Flag>,
    quoted: bool,
    subcommand: bool,
    value: bool,
    unresolved: bool,
}
fn push<'a>(
    next: &mut Vec<State<'a>>,
    state: &State<'a>,
    value: String,
    opts: Push,
    script_flags: Option<&'a [Flag]>,
    metadata: &'a CommandMetadata,
) {
    let mut new = state.clone();
    new.args.push(value.clone());
    if opts.subcommand {
        new.scope = format!("{} {value}", state.scope);
    }
    new.index += opts.consumed.max(1);
    new.score += opts.score;
    new.unresolved += usize::from(opts.unresolved);
    if let Some(confidence) = opts.confidence {
        new.confidence = new.confidence.min(confidence);
    }
    if let Some(change) = opts.change {
        if let Some(changes) = &mut new.changes {
            changes.push(change);
        } else {
            new.changes = Some(Trail::new(change));
        }
        new.repaired_flag |= opts.flag.is_some();
    }
    if let Some(flag) = &opts.flag {
        (new.value_remaining, new.value_limit) = flag.value_bounds();
        if flag.name.contains('=') {
            new.value_remaining = new.value_remaining.saturating_sub(1);
            new.value_limit = new.value_limit.map(|maximum| maximum.saturating_sub(1));
        }
        new.active_value = (new.value_limit != Some(0)).then(|| flag.clone());
    } else if opts.value {
        new.value_remaining = new.value_remaining.saturating_sub(1);
        new.value_limit = new.value_limit.map(|maximum| maximum.saturating_sub(1));
        if new.value_limit == Some(0) {
            new.active_value = None;
        }
    } else {
        new.value_remaining = 0;
        new.value_limit = Some(0);
        new.active_value = None;
    }
    new.value_next = new.value_remaining > 0;
    new.script_scope |= ["python", "python3"].contains(&new.args.first().as_str())
        && value.ends_with(".py")
        && script_operand(&new.args.values()) == Some(new.args.len() - 1);
    new.flags = if new.script_scope {
        script_flags.unwrap_or(state.flags)
    } else {
        flags_ref(&new.scope, metadata, state.flags)
    };
    if opts.quoted {
        new.quoted.push(new.args.len() - 1);
    }
    new.literal_rest |= value == "--";
    next.push(new);
}
fn repair_one(
    input: &str,
    catalog: &Catalog,
    script_flags: Option<&[Flag]>,
    metadata: &CommandMetadata,
) -> Vec<Candidate> {
    let literal = Candidate::literal(input);
    if input.trim().is_empty() {
        return vec![];
    }
    if crate::validation::simple_words(input).is_none()
        || !input.matches('\'').count().is_multiple_of(2)
        || !input.matches('"').count().is_multiple_of(2)
    {
        return vec![literal];
    }
    let words = command_tokens(input, catalog);
    if words.is_empty() || words.len() > 64 || utf16_len(input) > 2000 {
        return vec![literal];
    }
    let name_index = match_index(&catalog.commands, Some(&catalog.commands));
    let exact: Vec<_> = name_index
        .lower
        .get(&words[0].value.to_lowercase())
        .into_iter()
        .flatten()
        .map(|at| &catalog.commands[*at])
        .collect();
    let commands = command_matches(&words, &catalog.commands)
        .into_iter()
        .filter(|item| exact.is_empty() || item.consumed > 1 || exact.contains(&&item.value));
    let original = tokens(input);
    let mut states: Vec<_> = commands
        .map(|item| {
            let text = words[..item.consumed]
                .iter()
                .map(|word| word.value.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            State {
                args: Trail::new(item.value.clone()),
                scope: item.value.clone(),
                index: item.consumed,
                score: item.score,
                confidence: (item.score - item.consumed.saturating_sub(1) as f64 * 8.0)
                    .clamp(0.0, 100.0),
                unresolved: 0,
                changes: if item.value != text {
                    Some(Trail::new(Change::Command(item.value.clone())))
                } else {
                    None
                },
                value_next: false,
                value_remaining: 0,
                value_limit: Some(0),
                active_value: None,
                flags: flags_ref(&item.value, metadata, &[]),
                literal_rest: false,
                quoted: vec![],
                fold_flags: original[0].value != words[0].value
                    || (test("^[A-Z][A-Z0-9]+$", &words[0].value)
                        && words[0].value != item.value
                        && words[0].value.to_lowercase() == item.value.to_lowercase()),
                repaired_flag: false,
                script_scope: false,
            }
        })
        .collect();
    if states.is_empty() {
        return vec![literal];
    }
    for _step in 0..words.len() {
        if !states.iter().any(|state| state.index < words.len()) {
            break;
        }
        let mut next = Vec::new();
        for state in &states {
            if state.index >= words.len() {
                next.push(state.clone());
                continue;
            }
            let word = &words[state.index];
            if let Some(flag) = &state.active_value {
                let boundary = !word.quoted && option_arity(&word.value, state.flags).is_some();
                if !boundary {
                    if !word.quoted
                        && let Some(schema) = &flag.value
                    {
                        let choices = match schema.kind {
                            ValueKind::Choice => schema.choices.clone().unwrap_or_default(),
                            ValueKind::Path | ValueKind::Directory | ValueKind::InputFile => {
                                catalog.paths.to_vec()
                            }
                            _ => vec![],
                        };
                        for matched in argument_matches(&words, state.index, &choices) {
                            let spoken = words[state.index..state.index + matched.consumed]
                                .iter()
                                .map(|w| w.value.as_str())
                                .collect::<Vec<_>>()
                                .join(" ");
                            push(
                                &mut next,
                                state,
                                matched.value.clone(),
                                Push {
                                    consumed: matched.consumed,
                                    confidence: Some(
                                        matched.score
                                            - matched.consumed.saturating_sub(1) as f64 * 8.0,
                                    ),
                                    score: if matched.value == spoken {
                                        0.0
                                    } else {
                                        12.0 + matched.score / 10.0
                                    },
                                    change: (matched.value != spoken).then(|| {
                                        if schema.kind == ValueKind::Choice {
                                            Change::Completion(matched.value.clone())
                                        } else {
                                            Change::File(matched.value.clone())
                                        }
                                    }),
                                    value: true,
                                    ..Default::default()
                                },
                                script_flags,
                                metadata,
                            );
                        }
                    }
                    push(
                        &mut next,
                        state,
                        word.value.clone(),
                        Push {
                            quoted: word.quoted,
                            value: true,
                            ..Default::default()
                        },
                        script_flags,
                        metadata,
                    );
                }
                if state.value_next {
                    continue;
                }
            }
            if word.quoted || state.value_next || state.literal_rest {
                push(
                    &mut next,
                    state,
                    word.value.clone(),
                    Push {
                        quoted: word.quoted,
                        ..Default::default()
                    },
                    script_flags,
                    metadata,
                );
                continue;
            }
            let subs = subcommands_ref(&state.scope, metadata);
            if !subs.is_empty() {
                let exact = subs
                    .iter()
                    .find(|sub| sub.to_lowercase() == word.value.to_lowercase());
                let choices = exact.map_or_else(
                    || matches(&words, state.index, subs, 3, false),
                    |sub| {
                        vec![Match {
                            value: sub.clone(),
                            consumed: 1,
                            score: 100.0,
                        }]
                    },
                );
                for sub in choices {
                    let change =
                        (sub.value != word.value).then(|| Change::Subcommand(sub.value.clone()));
                    push(
                        &mut next,
                        state,
                        sub.value,
                        Push {
                            consumed: sub.consumed,
                            confidence: Some(
                                sub.score - sub.consumed.saturating_sub(1) as f64 * 8.0,
                            ),
                            score: if sub.score >= 94.0 { 40.0 } else { 24.0 },
                            change,
                            subcommand: true,
                            ..Default::default()
                        },
                        script_flags,
                        metadata,
                    );
                }
                if !test("^[-\u{2010}-\u{2015}\u{2212}]", &word.value) {
                    continue;
                }
            }
            if test("^[-\u{2010}-\u{2015}\u{2212}]", &word.value) {
                if word.value == "--" {
                    push(
                        &mut next,
                        state,
                        "--".into(),
                        Push::default(),
                        script_flags,
                        metadata,
                    );
                    continue;
                }
                let mut option = replace("[\u{2010}-\u{2015}\u{2212}]", &word.value, "-");
                let mut consumed = 1;
                if option == "-"
                    && words.get(state.index + 1).is_some_and(|word| {
                        !word.quoted && test("^[a-zA-Z][a-zA-Z0-9_-]*$", &word.value)
                    })
                {
                    option.push_str(&words[state.index + 1].value);
                    consumed = 2;
                }
                let mut alternatives = Vec::new();
                if option_arity(&option, state.flags).is_some() {
                    alternatives.push(option.clone());
                }
                let (name, suffix) = option
                    .split_once('=')
                    .map_or((option.as_str(), String::new()), |(name, value)| {
                        (name, format!("={value}"))
                    });
                for flag in state.flags {
                    if flag.name.to_lowercase() == name.to_lowercase() {
                        let value = format!("{}{suffix}", flag.name);
                        if !alternatives.contains(&value) {
                            alternatives.push(value);
                        }
                    }
                }
                for value in alternatives {
                    let Some(takes_value) = option_arity(&value, state.flags) else {
                        continue;
                    };
                    let flag_name = value.split('=').next().unwrap();
                    let preferred_case = state.fold_flags && flag_name == flag_name.to_lowercase();
                    let score = if !state.fold_flags && value == option {
                        24.0
                    } else if preferred_case {
                        12.0
                    } else if value == option {
                        10.0
                    } else {
                        8.0
                    };
                    let change =
                        (value != word.value || consumed > 1).then(|| Change::Flag(value.clone()));
                    push(
                        &mut next,
                        state,
                        value.clone(),
                        Push {
                            consumed,
                            confidence: Some(if value == word.value { 100.0 } else { 98.0 }),
                            score,
                            change,
                            flag: Some(Flag {
                                name: value.clone(),
                                takes_value,
                                optional_value: None,
                                value: state
                                    .flags
                                    .iter()
                                    .find(|flag| flag.name == flag_name)
                                    .and_then(|flag| flag.value.clone()),
                            }),
                            ..Default::default()
                        },
                        script_flags,
                        metadata,
                    );
                }
                continue;
            }
            let exact_path = catalog.paths.contains(&word.value) && test("[./_-]", &word.value);
            let file_matches = if !is_path_position(&state.args.values()) {
                vec![]
            } else if exact_path {
                vec![Match {
                    value: word.value.clone(),
                    consumed: 1,
                    score: 100.0,
                }]
            } else {
                indexed_matches(
                    &words,
                    state.index,
                    &catalog.paths,
                    6,
                    true,
                    Some(&catalog.paths),
                )
            };
            for file in &file_matches {
                let spoken = words[state.index..state.index + file.consumed]
                    .iter()
                    .map(|word| word.value.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                push(
                    &mut next,
                    state,
                    file.value.clone(),
                    Push {
                        consumed: file.consumed,
                        confidence: Some(file.score - file.consumed.saturating_sub(1) as f64 * 8.0),
                        score: file.score / 10.0,
                        change: (file.value != spoken).then(|| Change::File(file.value.clone())),
                        ..Default::default()
                    },
                    script_flags,
                    metadata,
                );
            }
            let mut matched_flag = false;
            for n in 1..=5.min(words.len() - state.index) {
                let span = &words[state.index..state.index + n];
                if span
                    .iter()
                    .any(|word| word.quoted || word.value.starts_with('-'))
                {
                    break;
                }
                let spoken = replace(
                    "(?i)^(?:dash[ -]*|hyphen[ -]*|hep[ -]*)+",
                    &span
                        .iter()
                        .map(|word| word.value.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                    "",
                );
                for flag in state.flags {
                    if !key(&spoken).is_empty() && key(&spoken) == key(&flag.name) {
                        matched_flag = true;
                        push(
                            &mut next,
                            state,
                            flag.name.clone(),
                            Push {
                                consumed: n,
                                confidence: Some(94.0),
                                score: 14.0 + n as f64,
                                change: Some(Change::Flag(flag.name.clone())),
                                flag: Some(flag.clone()),
                                ..Default::default()
                            },
                            script_flags,
                            metadata,
                        );
                    }
                }
            }
            if let Some(values) = metadata.argument_values.as_ref().and_then(|values| {
                values.get(&serde_json::to_string(&state.args.values()).unwrap())
            }) && !matched_flag
            {
                for matched in argument_matches(&words, state.index, values) {
                    let spoken = words[state.index..state.index + matched.consumed]
                        .iter()
                        .map(|word| word.value.as_str())
                        .collect::<Vec<_>>()
                        .join(" ");
                    let changed = matched.value != spoken;
                    let change = changed.then(|| Change::Completion(matched.value.clone()));
                    push(
                        &mut next,
                        state,
                        matched.value,
                        Push {
                            consumed: matched.consumed,
                            confidence: Some(
                                matched.score - matched.consumed.saturating_sub(1) as f64 * 8.0,
                            ),
                            score: if changed {
                                20.0 + matched.score / 10.0
                            } else {
                                0.0
                            },
                            change,
                            ..Default::default()
                        },
                        script_flags,
                        metadata,
                    );
                }
            }
            if !matched_flag || !file_matches.is_empty() {
                push(
                    &mut next,
                    state,
                    word.value.clone(),
                    Push {
                        unresolved: !["echo", "printf"].contains(&state.args.first().as_str())
                            && !file_matches.iter().any(|matched| {
                                matched.consumed == 1 && matched.value == word.value
                            }),
                        ..Default::default()
                    },
                    script_flags,
                    metadata,
                );
            }
        }
        next.sort_by(|a, b| b.score.total_cmp(&a.score));
        next.truncate(16);
        states = next;
    }
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for state in states
        .into_iter()
        .filter(|state| state.index == words.len() && !state.value_next)
    {
        let args = state.args.values();
        if state.repaired_flag
            && args.iter().enumerate().any(|(index, arg)| {
                test("(?i)^(dash|hep|hyphen)$", arg) && !state.quoted.contains(&index)
            })
        {
            continue;
        }
        let command = args
            .iter()
            .enumerate()
            .map(|(index, value)| {
                if state.quoted.contains(&index) {
                    format!("'{}'", value.replace('\'', "'\\''"))
                } else {
                    shell_quote(value)
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        let history_boost = crate::history::command_boost(&catalog.history, &command);
        if seen.insert(command.clone()) {
            unique.push(Candidate {
                command,
                evidence: Evidence {
                    resolved: state.unresolved == 0,
                    unresolved: state.unresolved,
                    ..Evidence::new(CandidateSource::Repair, state.confidence)
                },
                score: state.score + history_boost,
                changes: state
                    .changes
                    .map(|trail| trail.values().into_iter().cloned().collect())
                    .unwrap_or_default(),
                literal: None,
            });
        }
    }
    unique.sort_by(|a, b| b.score.total_cmp(&a.score));
    unique.truncate(16);
    if unique.len() < 16
        && !unique
            .iter()
            .any(|candidate| candidate.command == literal.command)
    {
        unique.push(literal);
    }
    unique
}
