use crate::{speech::expand_symbols, util::utf16_len};
pub fn pipeline_parts(input: &str) -> Option<Vec<String>> {
    let expanded = expand_symbols(input, true);
    let text = expanded.trim();
    if utf16_len(text) > 2000 || text.contains(['\r', '\n']) {
        return None;
    }
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let (mut quote, mut depth, mut start, mut index) = (None, 0_i32, 0, 0);
    let mut parts = Vec::new();
    while index < chars.len() {
        let (offset, ch) = chars[index];
        index += 1;
        if ch == '\\' && quote != Some('\'') {
            index += 1;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            continue;
        }
        if "\'\"`".contains(ch) {
            quote = Some(ch);
            continue;
        }
        if "({".contains(ch) {
            depth += 1;
            continue;
        }
        if ")}".contains(ch) {
            depth -= 1;
            if depth < 0 {
                return None;
            }
            continue;
        }
        if depth != 0 {
            continue;
        }
        if ch == ';'
            || ch == '&'
            || (ch == '#' && (index == 1 || chars[index - 2].1.is_whitespace()))
        {
            return None;
        }
        if ch != '|' {
            continue;
        }
        if chars.get(index).is_some_and(|(_, ch)| "|&".contains(*ch)) {
            return None;
        }
        parts.push(text[start..offset].trim().to_owned());
        start = offset + 1;
    }
    if quote.is_some() || depth != 0 || parts.is_empty() {
        return None;
    }
    parts.push(text[start..].trim().to_owned());
    if parts.len() > 6 || parts.iter().any(String::is_empty) {
        None
    } else {
        Some(parts)
    }
}
