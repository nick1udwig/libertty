use crate::test;
use crate::{
    types::{Match, SharedList, Token},
    util::{ArrayCache, collapse},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
const ALPHABET: &[&[&str]] = &[
    &["a", "ay"],
    &["bee", "be"],
    &["see", "sea"],
    &["dee"],
    &["ee"],
    &["ef", "eff"],
    &["jee", "gee"],
    &["aitch", "haitch"],
    &["eye"],
    &["jay"],
    &["kay"],
    &["el", "ell"],
    &["em"],
    &["en"],
    &["oh"],
    &["pee", "pea"],
    &["cue", "queue"],
    &["ar", "are"],
    &["ess", "es"],
    &["tee", "tea"],
    &["you"],
    &["vee"],
    &["double you", "double u"],
    &["ex"],
    &["why"],
    &["zee", "zed"],
];
fn letter(input: &str) -> Option<char> {
    for (i, names) in ALPHABET.iter().enumerate() {
        let ch = (b'a' + i as u8) as char;
        if input == ch.to_string() || names.contains(&input) {
            return Some(ch);
        }
    }
    None
}
fn sound_key(value: &str) -> String {
    let text = value
        .to_lowercase()
        .chars()
        .filter(char::is_ascii_lowercase)
        .collect::<String>()
        .replace("ph", "f")
        .replace("ck", "k")
        .replace("qu", "k");
    let chars: Vec<_> = text.chars().collect();
    let text: String = chars
        .iter()
        .enumerate()
        .map(|(i, ch)| match (*ch, chars.get(i + 1)) {
            ('c', Some(next)) if "eiy".contains(*next) => 's',
            ('g', Some(next)) if "eiy".contains(*next) => 'j',
            ('c', _) => 'k',
            ('z', _) => 's',
            _ => *ch,
        })
        .filter(|ch| !"aeiouy".contains(*ch))
        .collect();
    collapse(&text)
}
struct SpeechIndex {
    names: HashMap<String, Vec<String>>,
    sounds: HashMap<String, Vec<(String, usize)>>,
}
fn speech_index(commands: &[String], shared: Option<&SharedList<String>>) -> Arc<SpeechIndex> {
    static CACHE: OnceLock<Mutex<ArrayCache<SpeechIndex>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let cached = {
        let mut cache = cache.lock().unwrap();
        match shared {
            Some(shared) => cache.get_shared(shared),
            None => cache.get(commands),
        }
    };
    if let Some(index) = cached {
        return index;
    }
    let mut names: HashMap<String, Vec<String>> = HashMap::new();
    let mut sounds: HashMap<String, Vec<(String, usize)>> = HashMap::new();
    for command in commands {
        if !test!(r###"^[a-zA-Z]{2,12}$"###, command) {
            continue;
        }
        names
            .entry(command.to_lowercase())
            .or_default()
            .push(command.clone());
        if command.len() > 6 {
            continue;
        }
        let mut spellings = vec![String::new()];
        for ch in command.to_lowercase().bytes() {
            spellings = spellings
                .iter()
                .flat_map(|prefix| {
                    ALPHABET[(ch - b'a') as usize]
                        .iter()
                        .map(move |suffix| format!("{}{}", prefix, suffix.replace(' ', "")))
                })
                .collect();
        }
        for spelling in spellings {
            let key = sound_key(&spelling);
            if key.len() < 2 {
                continue;
            }
            let bucket = sounds.entry(key).or_default();
            let entry = (command.clone(), spelling.len());
            if !bucket.contains(&entry) {
                bucket.push(entry);
            }
        }
    }
    let index = Arc::new(SpeechIndex { names, sounds });
    let mut cache = cache.lock().unwrap();
    if let Some(shared) = shared {
        cache.insert_shared(shared, index.clone());
    } else {
        cache.insert(commands, index.clone());
    }
    index
}
pub fn command_speech(words: &[Token], commands: &[String]) -> Vec<Match> {
    command_speech_shared(words, commands, None)
}
pub(crate) fn command_speech_shared(
    words: &[Token],
    commands: &[String],
    shared: Option<&SharedList<String>>,
) -> Vec<Match> {
    let index = speech_index(commands, shared);
    let mut input = Vec::new();
    let mut found: Vec<Match> = Vec::new();
    for word in words.iter().take(12) {
        if word.quoted || !test!(r###"^[a-zA-Z]+\.?$"###, &word.value) {
            break;
        }
        input.push(word.value.to_lowercase().trim_end_matches('.').to_owned());
        let mut spelling = String::new();
        let mut valid = true;
        let mut at = 0;
        while at < input.len() {
            let pair = input
                .get(at + 1)
                .and_then(|next| letter(&format!("{} {next}", input[at])));
            let resolved = if let Some(ch) = pair {
                at += 1;
                Some(ch)
            } else {
                letter(&input[at])
            };
            if let Some(ch) = resolved {
                spelling.push(ch);
            } else {
                valid = false;
                break;
            }
            at += 1;
        }
        if valid {
            for value in index.names.get(&spelling).into_iter().flatten() {
                found.push(Match {
                    value: value.clone(),
                    consumed: input.len(),
                    score: 94.0 + (input.len() - 1) as f64 * 8.0,
                });
            }
        }
        if !valid
            && found.is_empty()
            && input.len() <= 6
            && test!(r###"[aeiouy]"###, &input.join(""))
        {
            for (command, length) in index
                .sounds
                .get(&sound_key(&input.join(" ")))
                .into_iter()
                .flatten()
            {
                let difference = input.join("").len().abs_diff(*length);
                if difference > 2.max(length / 5) {
                    continue;
                }
                let score = 80.0 - difference as f64 * 4.0;
                if let Some(previous) = found.iter_mut().find(|item| item.value == *command) {
                    previous.score = previous.score.max(score);
                } else {
                    found.push(Match {
                        value: command.clone(),
                        consumed: input.len(),
                        score,
                    });
                }
            }
        }
    }
    found
}
