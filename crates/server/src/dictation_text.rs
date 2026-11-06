/// Validate recognized text without choosing how a destination represents whitespace.
pub(crate) fn valid(text: &str) -> bool {
    !text.chars().any(|ch| {
        (ch < '\x20' && !matches!(ch, '\r' | '\n' | '\t')) || ('\x7f'..='\u{9f}').contains(&ch)
    })
}
/// Terminal dictation stays on one input line and cannot generate Enter or Tab keys.
pub(crate) fn terminal(text: String) -> String {
    if !text.contains(['\r', '\n', '\t']) {
        return text;
    }
    let mut result = String::with_capacity(text.len());
    let mut previous_break = false;
    for ch in text.chars() {
        let line_break = matches!(ch, '\r' | '\n' | '\t');
        if !line_break || !previous_break {
            result.push(if line_break { ' ' } else { ch });
        }
        previous_break = line_break;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_policy_preserves_unicode_and_spaces_but_never_sends_keys() {
        assert_eq!(
            terminal("café\r\n\t日本語\tword\n".into()),
            "café 日本語 word "
        );
        assert_eq!(terminal("a  \n\t b".into()), "a    b");
        let text = String::from("plain  text");
        let allocation = text.as_ptr();
        let result = terminal(text);
        assert_eq!(result, "plain  text");
        assert_eq!(result.as_ptr(), allocation);
    }
    #[test]
    fn validation_allows_layout_but_rejects_terminal_controls() {
        assert!(valid("hello\r\n\t世界"));
        for ch in ['\0', '\x07', '\x1b', '\x7f', '\u{85}', '\u{9b}'] {
            assert!(!valid(&format!("hello{ch}world")));
        }
    }
}
