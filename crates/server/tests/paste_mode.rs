use termai_server::paste_mode::PasteMode;
#[test]
fn split_dec_sequences_resets_and_control_strings_preserve_paste_mode() {
    let sequence = "\x1b[?1004;2004h";
    for split in 0..=sequence.len() {
        let mut mode = PasteMode::default();
        assert_eq!(mode.paste("hello"), "hello");
        mode.feed(&sequence[..split]);
        mode.feed(&sequence[split..]);
        assert_eq!(mode.paste("hello"), "\x1b[200~hello\x1b[201~");
        mode.feed("\x1b[?2004l");
        assert!(!mode.enabled);
        for start in ["]", "P", "_"] {
            mode.feed(&format!("\x1b{start}title\x1b[?2004h\x1b\\"));
            assert!(!mode.enabled);
        }
        mode.feed("\x1b[?2004h\x1bc");
        assert!(!mode.enabled);
        mode.feed("\x1b[2004h");
        assert!(!mode.enabled);
    }
}
