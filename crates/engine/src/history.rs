use crate::{
    repair::{similarity, tokens},
    speech::expand_symbols,
    types::*,
    util::{ArrayCache, replace},
    validation::simple_words,
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
};

struct Entry {
    line: String,
    words: Vec<Word>,
}
#[derive(Default)]
struct HistoryIndex {
    lengths: BTreeMap<usize, Vec<Arc<Entry>>>,
    entries: HashMap<String, Arc<Entry>>,
    counts: HashMap<String, usize>,
}
fn history_index(history: &SharedList<String>) -> Arc<HistoryIndex> {
    static CACHE: OnceLock<Mutex<ArrayCache<HistoryIndex>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let previous = {
        let mut cache = cache.lock().unwrap();
        if let Some(index) = cache.get_shared(history) {
            return index;
        }
        cache.latest()
    };
    let mut seen = HashSet::with_capacity(history.len());
    let mut index = HistoryIndex {
        entries: HashMap::with_capacity(history.len()),
        ..HistoryIndex::default()
    };
    for line in history {
        *index.counts.entry(line.clone()).or_default() += 1;
        if !seen.insert(line) {
            continue;
        }
        let reused = previous
            .as_ref()
            .and_then(|index| index.entries.get(line))
            .cloned();
        let Some(words) = reused
            .as_ref()
            .map(|entry| entry.words.clone())
            .or_else(|| simple_words(line))
            .filter(|words| {
                !words.is_empty() && !["echo", "printf"].contains(&words[0].value.as_str())
            })
        else {
            continue;
        };
        let length = word_length(line);
        let entry = reused.unwrap_or_else(|| {
            Arc::new(Entry {
                line: line.clone(),
                words,
            })
        });
        index.lengths.entry(length).or_default().push(entry.clone());
        index.entries.insert(line.clone(), entry);
    }
    let index = Arc::new(index);
    cache.lock().unwrap().insert_shared(history, index.clone());
    index
}
pub(crate) fn command_boost(history: &SharedList<String>, command: &str) -> f64 {
    (history_index(history)
        .counts
        .get(command)
        .copied()
        .unwrap_or(0)
        * 3)
    .min(12) as f64
}
fn word_length(value: &str) -> usize {
    value
        .bytes()
        .filter(|b| b.is_ascii_alphanumeric() || *b == b'_')
        .count()
}

fn preserves_explicit_input(spoken: &[Token], words: &[Word]) -> bool {
    let flag = |value: &str| {
        value.starts_with('-') && value.as_bytes().get(1).is_some_and(|b| *b != b'\n')
    };
    for (i, word) in spoken.iter().enumerate() {
        if word.quoted && !words.iter().any(|candidate| candidate.value == word.value) {
            return false;
        }
        if !word.quoted && flag(&word.value) {
            let Some(at) = words
                .iter()
                .position(|candidate| candidate.value == word.value)
            else {
                return false;
            };
            if let Some(value) = spoken.get(i + 1)
                && !value.value.starts_with('-')
                && words.get(at + 1).map(|w| &w.value) != Some(&value.value)
            {
                return false;
            }
        }
    }
    words.iter().filter(|word| flag(&word.value)).all(|flag| {
        spoken.iter().any(|word| {
            word.value == flag.value
                || (!word.quoted
                    && word.value.to_lowercase()
                        == flag.value.trim_start_matches('-').to_lowercase())
        })
    })
}
pub fn history_candidates(input: &str, catalog: &Catalog) -> Vec<Candidate> {
    let spoken = replace("([a-zA-Z])\\.$", &expand_symbols(input, true), "$1");
    let input_words = tokens(input);
    static COMMANDS: OnceLock<Mutex<ArrayCache<HashSet<String>>>> = OnceLock::new();
    let allowed = {
        let mut cache = COMMANDS.get_or_init(Default::default).lock().unwrap();
        if let Some(names) = cache.get_shared(&catalog.commands) {
            names
        } else {
            let names = Arc::new(catalog.commands.iter().cloned().collect::<HashSet<_>>());
            cache.insert_shared(&catalog.commands, names.clone());
            names
        }
    };
    let helpers: HashSet<_> = catalog
        .functions
        .iter()
        .flatten()
        .filter(|name| name.starts_with('_'))
        .collect();
    let length = word_length(&spoken) as isize;
    let mut candidates = Vec::new();
    let index = history_index(&catalog.history);
    for delta in -2..=2 {
        if length + delta < 0 {
            continue;
        }
        for entry in index
            .lengths
            .get(&((length + delta) as usize))
            .into_iter()
            .flatten()
        {
            let line = &entry.line;
            let words = &entry.words;
            if !allowed.contains(&words[0].value)
                || (helpers.contains(&words[0].value)
                    && input_words.first().map(|w| &w.value) != Some(&words[0].value))
                || !preserves_explicit_input(&input_words, words)
            {
                continue;
            }
            let score = similarity(&spoken, line);
            if score < 64.0 {
                continue;
            }
            let cwd_boost = if catalog
                .history_cwds
                .as_ref()
                .and_then(|cwds| cwds.get(line))
                == Some(&catalog.cwd)
            {
                6.0
            } else {
                0.0
            };
            candidates.push(Candidate {
                command: line.clone(),
                score: score + 8.0 + cwd_boost,
                changes: vec!["Matches shell history".into()],
                literal: None,
            });
        }
    }
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    candidates.truncate(6);
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_frequency_boost_refreshes_without_changing_old_snapshots() {
        let first: SharedList<String> = vec!["git init".into(), "git init".into()].into();
        assert_eq!(command_boost(&first, "git init"), 6.0);
        let mut changed = first.clone();
        changed.extend(std::iter::repeat_n("git init".into(), 5));
        assert_eq!(command_boost(&changed, "git init"), 12.0);
        assert_eq!(command_boost(&first, "git init"), 6.0);
        changed.clear();
        assert_eq!(command_boost(&changed, "git init"), 0.0);
    }
    #[test]
    fn refresh_reuses_parsed_entries_while_adding_and_evicting_commands() {
        let first = history_index(&vec!["git init".into(), "git status".into()].into());
        let second = history_index(&vec!["git status".into(), "git add .".into()].into());
        assert!(Arc::ptr_eq(
            &first.entries["git status"],
            &second.entries["git status"]
        ));
        assert!(!second.entries.contains_key("git init"));
        assert_eq!(second.entries["git add ."].words[2].value, ".");
    }
}
