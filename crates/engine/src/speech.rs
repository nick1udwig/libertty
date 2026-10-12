use crate::{
    command_policy::vocabulary,
    util::{collapse, locale_cmp, utf16_len},
};

const DIRECT: &str = "tilde slash buc mic fas bas pam pat soq doq tic tis wut zap hax hep ket lac rac lit rit lob rob led ban lus stet slus shed dart dusk lark lush";
fn direct(name: &str) -> bool {
    DIRECT.split(' ').any(|word| word == name)
}
fn phonetic(word: &str) -> String {
    collapse(
        &word
            .replace("ph", "f")
            .replace("ck", "k")
            .replace("qu", "k")
            .replace('c', "k")
            .chars()
            .filter(|c| !"aeiouy".contains(*c))
            .collect::<String>(),
    )
}
#[derive(Clone)]
struct Unit {
    word: String,
    name: Option<String>,
    at: usize,
}
struct SymbolMatch {
    name: String,
    count: usize,
    distance: usize,
    alias: bool,
}

fn distance(a: &str, b: &str) -> usize {
    let a: Vec<_> = a.chars().collect();
    let b: Vec<_> = b.chars().collect();
    if a.len().abs_diff(b.len()) > 2 {
        return 3;
    }
    let mut rows = vec![vec![0; b.len() + 1]; a.len() + 1];
    for (i, row) in rows.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in rows[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            rows[i][j] = (rows[i - 1][j] + 1)
                .min(rows[i][j - 1] + 1)
                .min(rows[i - 1][j - 1] + usize::from(a[i - 1] != b[j - 1]));
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                rows[i][j] = rows[i][j].min(rows[i - 2][j - 2] + 1);
            }
        }
    }
    rows[a.len()][b.len()]
}
fn symbol_matches(words: &[String], at: usize, nearby: bool, general: bool) -> Vec<SymbolMatch> {
    let names = &vocabulary().symbol_names;
    let max_words = names
        .keys()
        .map(|name| name.split(' ').count())
        .max()
        .unwrap_or(1);
    let mut found = Vec::new();
    for count in (1..=max_words.min(words.len() - at)).rev() {
        let span = &words[at..at + count];
        if span
            .iter()
            .any(|word| word.is_empty() || !word.bytes().all(|b| b.is_ascii_alphabetic()))
        {
            continue;
        }
        let phrase = span.join(" ").to_lowercase();
        if phrase == "at" && at > 0 && words[at - 1].eq_ignore_ascii_case("look") {
            continue;
        }
        if at == 0 && count < words.len() {
            continue;
        }
        let next = words
            .get(at + count)
            .map(|word| word.to_lowercase())
            .unwrap_or_default();
        let alias = if nearby && ["told us lash", "tilt the flash"].contains(&phrase.as_str()) {
            Some("tilde slash")
        } else if nearby
            && (phrase == "told the"
                || phrase == "told a"
                    && (["slash", "slach", "fas"].contains(&next.as_str())
                        || (next == "forward"
                            && words
                                .get(at + count + 1)
                                .is_some_and(|word| word.eq_ignore_ascii_case("slash")))))
        {
            Some("tilde")
        } else {
            None
        };
        if let Some(name) = alias {
            return vec![SymbolMatch {
                name: name.into(),
                count,
                distance: 0,
                alias: true,
            }];
        }
        if nearby && phrase == "told" && next == "a" {
            continue;
        }
        if names.contains_key(&phrase) && (general || direct(&phrase)) {
            return vec![SymbolMatch {
                name: phrase,
                count,
                distance: 0,
                alias: false,
            }];
        }
        if !nearby || at == 0 {
            continue;
        }
        let key = span.join("").to_lowercase();
        if key.len() < 4 {
            continue;
        }
        for name in names.keys() {
            let name_key = name.replace(' ', "");
            if name.split(' ').count() != count
                || name_key.len() < 4
                || name_key.len().abs_diff(key.len()) > 2
            {
                continue;
            }
            let edits = distance(&key, &name_key);
            let budget = if key.len().min(name_key.len()) >= 7 {
                2
            } else {
                1
            };
            let sound = phonetic(&key);
            let same_sound = sound.len() >= 3 && sound == phonetic(&name_key);
            if edits > 0 && (edits <= budget || same_sound) {
                found.push(SymbolMatch {
                    name: name.clone(),
                    count,
                    distance: edits.min(2),
                    alias: false,
                });
            }
        }
    }
    found.sort_by(|a, b| {
        a.distance
            .cmp(&b.distance)
            .then(b.count.cmp(&a.count))
            .then_with(|| locale_cmp(&a.name, &b.name))
    });
    found.truncate(3);
    found
}
fn render(units: &[Unit]) -> String {
    let (mut output, mut join_next, mut quote) = (String::new(), false, String::new());
    for unit in units {
        let symbol = unit
            .name
            .as_ref()
            .and_then(|name| vocabulary().symbol_names.get(name));
        let Some(symbol) = symbol else {
            if !output.is_empty() && !join_next {
                output.push(' ');
            }
            output.push_str(&unit.word);
            join_next = false;
            continue;
        };
        let name = unit.name.as_deref().unwrap_or("");
        let (mut left, mut right) = (false, false);
        if ["'", "\"", "`"].contains(&symbol.as_str()) {
            left = name.starts_with("close ") || (!name.starts_with("open ") && quote == *symbol);
            right = !left;
            quote = if left { String::new() } else { symbol.clone() };
        } else if [
            "/", "\\", ".", "_", ":", ",", "@", "=", "==", "^", "->", "<-", "-<", "+>", "+<", "+",
            "++", "*", "**", "%",
        ]
        .contains(&symbol.as_str())
            || name == "hyphen"
        {
            left = true;
            right = true;
        } else if ["~", "~/", "$", "!", "#", "-", "--", "[", "(", "{"].contains(&symbol.as_str()) {
            right = true;
        } else if ["?", "]", ")", "}"].contains(&symbol.as_str()) {
            left = true;
        }
        if unit.at == 1 && units.first().is_none_or(|unit| unit.name.is_none()) {
            left = false;
        }
        if !output.is_empty() && !join_next && !left {
            output.push(' ');
        }
        output.push_str(symbol);
        join_next = right;
    }
    output
}
fn raw_words(input: &str) -> Vec<String> {
    crate::util::quoted_words(input)
        .into_iter()
        .map(str::to_owned)
        .collect()
}
pub fn expand_symbols(input: &str, general: bool) -> String {
    let words = raw_words(input);
    let mut units = Vec::new();
    let mut at = 0;
    while at < words.len() {
        let matched = symbol_matches(&words, at, false, general)
            .into_iter()
            .next();
        let count = matched.as_ref().map_or(1, |item| item.count);
        units.push(Unit {
            word: words[at].clone(),
            name: matched.map(|item| item.name),
            at,
        });
        at += count;
    }
    if units.iter().any(|unit| unit.name.is_some()) {
        render(&units)
    } else {
        input.into()
    }
}
pub fn symbol_alternatives(input: &str) -> Vec<String> {
    let words = raw_words(input);
    if words.len() > 64 || utf16_len(input) > 2000 || input.contains(['\n', '\r']) {
        return vec![];
    }
    #[derive(Clone)]
    struct State {
        units: Vec<Unit>,
        score: i32,
        changed: bool,
    }
    let mut states = vec![Vec::<State>::new(); words.len() + 1];
    states[0].push(State {
        units: vec![],
        score: 0,
        changed: false,
    });
    for at in 0..words.len() {
        let options = symbol_matches(&words, at, true, true);
        let exact = options.first().is_some_and(|item| item.distance == 0);
        states[at].sort_by_key(|state| std::cmp::Reverse(state.score));
        states[at].truncate(4);
        for state in states[at].clone() {
            let mut add = |name: Option<String>, count: usize, gain: i32, changed: bool| {
                let mut units = state.units.clone();
                units.push(Unit {
                    word: words[at].clone(),
                    name,
                    at,
                });
                let bucket = &mut states[at + count];
                bucket.push(State {
                    units,
                    score: state.score + gain,
                    changed: state.changed || changed,
                });
                bucket.sort_by_key(|state| std::cmp::Reverse(state.score));
                bucket.truncate(4);
            };
            if !exact {
                add(None, 1, 0, false);
            }
            for item in &options {
                add(
                    Some(item.name.clone()),
                    item.count,
                    if item.distance > 0 {
                        3 - item.distance as i32
                    } else {
                        0
                    },
                    item.alias || item.distance > 0 || !direct(&item.name),
                );
            }
        }
    }
    let exact = expand_symbols(input, false);
    let mut result = Vec::new();
    states[words.len()].sort_by_key(|state| std::cmp::Reverse(state.score));
    for state in &states[words.len()] {
        if !state.changed {
            continue;
        }
        let text = render(&state.units);
        if text != input && text != exact && !result.contains(&text) {
            result.push(text);
        }
    }
    result.truncate(3);
    result
}
