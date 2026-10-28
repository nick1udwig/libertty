//! The current terminal picture of a native session, so a viewer can resume from it instead of raw output.
use std::fmt::Write as _;

/// Keep a larger archive without increasing the foreground reconnect snapshot.
const SCROLLBACK: usize = 5000;
const SNAPSHOT_ROWS: usize = 1000;
const ALTERNATE: [&str; 2] = ["\x1b[?1049h", "\x1b[?47h"];

pub(super) struct Screen {
    parser: vt100::Parser,
    /// The main screen as an application entered the alternate screen, which vt100 does not expose.
    main: Option<vt100::Screen>,
}
impl Screen {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, SCROLLBACK),
            main: None,
        }
    }
    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.screen_mut().set_size(rows, cols);
        if let Some(main) = &mut self.main {
            main.set_size(rows, cols);
        }
    }
    pub fn feed(&mut self, text: &str) {
        let mut rest = text;
        while let Some((at, entry)) = ALTERNATE
            .iter()
            .filter_map(|entry| rest.find(entry).map(|at| (at, entry.len())))
            .min()
        {
            self.parser.process(&rest.as_bytes()[..at]);
            if !self.parser.screen().alternate_screen() {
                self.main = Some(self.parser.screen().clone());
            }
            self.parser.process(&rest.as_bytes()[at..at + entry]);
            rest = &rest[at + entry..];
        }
        self.parser.process(rest.as_bytes());
        if !self.parser.screen().alternate_screen() {
            self.main = None;
        }
    }
    pub fn history(&mut self) -> String {
        let screen = self
            .main
            .as_mut()
            .unwrap_or_else(|| self.parser.screen_mut());
        let (rows, cols) = screen.size();
        screen.set_scrollback(usize::MAX);
        let mut offset = screen.scrollback();
        let mut text = String::new();
        loop {
            screen.set_scrollback(offset);
            let taken = if offset == 0 {
                usize::from(rows)
            } else {
                offset.min(usize::from(rows))
            };
            for (row, line) in screen.rows(0, cols).take(taken).enumerate() {
                text.push_str(&line);
                if !screen.row_wrapped(row as u16) {
                    text.push('\n');
                }
            }
            if offset == 0 {
                break;
            }
            offset -= taken;
        }
        let mut start = text.len().saturating_sub(512 * 1024);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text[start..].trim_end().to_owned()
    }
    /// ANSI that rebuilds this picture in a freshly reset terminal; lines reflow at the viewer's own width.
    pub fn snapshot(&mut self) -> String {
        let mut out = String::new();
        if self.parser.screen().alternate_screen() {
            if let Some(main) = &mut self.main {
                write_screen(&mut out, main, true);
            }
            // The viewer saves the main cursor as it enters its own alternate screen.
            out.push_str("\x1b[?1049h\x1b[H");
            write_screen(&mut out, self.parser.screen_mut(), false);
        } else {
            write_screen(&mut out, self.parser.screen_mut(), true);
        }
        let screen = self.parser.screen();
        out.push_str(&String::from_utf8_lossy(&screen.attributes_formatted()));
        out.push_str(&String::from_utf8_lossy(&screen.input_mode_formatted()));
        if screen.hide_cursor() {
            out.push_str("\x1b[?25l");
        }
        out
    }
}

/// Write scrollback and screen rows as lines, then restore the cursor saved within its row.
fn write_screen(out: &mut String, screen: &mut vt100::Screen, scrollback: bool) {
    let (rows, cols) = screen.size();
    let (cursor_row, cursor_col) = screen.cursor_position();
    if scrollback {
        screen.set_scrollback(SNAPSHOT_ROWS);
        let mut offset = screen.scrollback();
        while offset > 0 {
            screen.set_scrollback(offset);
            let taken = offset.min(usize::from(rows));
            for row in 0..taken as u16 {
                write_row(out, screen, row, cols, None);
                end_row(out, screen.row_wrapped(row));
            }
            offset -= taken;
        }
        screen.set_scrollback(0);
    }
    // Blank rows below the cursor would scroll a shorter viewer and move the saved cursor.
    let last = (0..rows)
        .rev()
        .find(|row| content_end(screen, *row, cols) > 0)
        .map_or(cursor_row, |row| row.max(cursor_row));
    for row in 0..=last {
        write_row(
            out,
            screen,
            row,
            cols,
            (row == cursor_row).then_some(cursor_col),
        );
        if row < last {
            end_row(out, screen.row_wrapped(row));
        }
    }
    out.push_str("\x1b8\x1b[0m");
}
fn end_row(out: &mut String, wrapped: bool) {
    // A soft-wrapped row continues on the next row, so the viewer can reflow the joined line.
    if !wrapped {
        out.push_str("\x1b[0m\r\n");
    }
}
fn content_end(screen: &vt100::Screen, row: u16, cols: u16) -> u16 {
    (0..cols)
        .rev()
        .find(|col| {
            screen.cell(row, *col).is_some_and(|cell| {
                cell.has_contents()
                    || cell.bgcolor() != vt100::Color::Default
                    || cell.inverse()
                    || cell.underline()
            })
        })
        .map_or(0, |col| col + 1)
}
fn write_row(out: &mut String, screen: &vt100::Screen, row: u16, cols: u16, cursor: Option<u16>) {
    // Trailing blanks matter only before a soft wrap, where they belong to the joined line.
    let end = if screen.row_wrapped(row) {
        cols
    } else {
        content_end(screen, row, cols)
    };
    let mut pen = Style::default();
    let mut col = 0;
    while col < end {
        let Some(cell) = screen.cell(row, col) else {
            break;
        };
        if cursor == Some(col) {
            out.push_str("\x1b7");
        }
        if cell.is_wide_continuation() {
            col += 1;
            continue;
        }
        let style = Style::of(cell);
        if style != pen {
            style.write(out);
            pen = style;
        }
        out.push_str(if cell.has_contents() {
            cell.contents()
        } else {
            " "
        });
        col += if cell.is_wide() { 2 } else { 1 };
    }
    if let Some(cursor) = cursor
        && cursor >= end
    {
        out.push_str("\x1b[0m");
        if cursor > end {
            let _ = write!(out, "\x1b[{}C", cursor - end);
        }
        out.push_str("\x1b7");
    }
}

#[derive(Clone, Copy, Default, PartialEq)]
struct Style {
    fg: vt100::Color,
    bg: vt100::Color,
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
    inverse: bool,
}
impl Style {
    fn of(cell: &vt100::Cell) -> Self {
        Self {
            fg: cell.fgcolor(),
            bg: cell.bgcolor(),
            bold: cell.bold(),
            dim: cell.dim(),
            italic: cell.italic(),
            underline: cell.underline(),
            inverse: cell.inverse(),
        }
    }
    fn write(&self, out: &mut String) {
        out.push_str("\x1b[0");
        for (enabled, code) in [
            (self.bold, 1),
            (self.dim, 2),
            (self.italic, 3),
            (self.underline, 4),
            (self.inverse, 7),
        ] {
            if enabled {
                let _ = write!(out, ";{code}");
            }
        }
        color(out, self.fg, 30);
        color(out, self.bg, 40);
        out.push('m');
    }
}
fn color(out: &mut String, color: vt100::Color, base: u8) {
    let _ = match color {
        vt100::Color::Default => Ok(()),
        vt100::Color::Idx(index) if index < 8 => write!(out, ";{}", base + index),
        vt100::Color::Idx(index) if index < 16 => write!(out, ";{}", base + 52 + index),
        vt100::Color::Idx(index) => write!(out, ";{};5;{index}", base + 8),
        vt100::Color::Rgb(red, green, blue) => {
            write!(out, ";{};2;{red};{green};{blue}", base + 8)
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_is_larger_than_snapshots_and_keeps_the_main_screen() {
        let mut screen = Screen::new(4, 40);
        for row in 0..6000 {
            screen.feed(&format!("row {row} 界😀\r\n"));
        }
        let history = screen.history();
        assert!(!history.contains("row 0 "));
        assert!(history.contains("row 2000 界😀"));
        assert!(history.contains("row 5999 界😀"));
        let snapshot = screen.snapshot();
        assert!(!snapshot.contains("row 2000 "));
        assert!(snapshot.contains("row 5999 "));
        screen.feed("\x1b[?1049happlication screen");
        assert_eq!(screen.history(), history);
        assert!(screen.snapshot().contains("application screen"));
    }
    /// Rebuild a snapshot in a fresh terminal of the same size.
    fn replay(screen: &mut Screen, rows: u16, cols: u16) -> vt100::Parser {
        let mut viewer = vt100::Parser::new(rows, cols, SCROLLBACK);
        viewer.process(screen.snapshot().as_bytes());
        viewer
    }
    fn cells(screen: &vt100::Screen) -> Vec<String> {
        let (rows, cols) = screen.size();
        (0..rows)
            .map(|row| {
                (0..cols)
                    .map(|col| {
                        let cell = screen.cell(row, col).unwrap();
                        // An unwritten cell and a written space look the same to a viewer.
                        format!(
                            "{}{:?}{:?}{}{}{}{}{}",
                            if cell.has_contents() {
                                cell.contents()
                            } else {
                                " "
                            },
                            cell.fgcolor(),
                            cell.bgcolor(),
                            cell.bold(),
                            cell.dim(),
                            cell.italic(),
                            cell.underline(),
                            cell.inverse()
                        )
                    })
                    .collect()
            })
            .collect()
    }
    fn assert_same(original: &mut Screen, rows: u16, cols: u16) {
        let viewer = replay(original, rows, cols);
        let (expected, actual) = (original.parser.screen(), viewer.screen());
        assert_eq!(cells(actual), cells(expected));
        assert_eq!(actual.cursor_position(), expected.cursor_position());
        assert_eq!(actual.alternate_screen(), expected.alternate_screen());
        assert_eq!(actual.bracketed_paste(), expected.bracketed_paste());
        assert_eq!(actual.hide_cursor(), expected.hide_cursor());
        assert_eq!(
            actual.attributes_formatted(),
            expected.attributes_formatted()
        );
    }
    #[test]
    fn styled_wide_and_wrapped_shell_output_round_trips_with_the_cursor_mid_line() {
        let mut screen = Screen::new(6, 20);
        screen.feed("\x1b[1;31mred\x1b[0m plain \x1b[38;5;200;48;2;1;2;3mrich\x1b[0m\r\n");
        screen.feed("界😀 wide\r\n");
        screen.feed(&format!("{}\r\n", "wrap ".repeat(7)));
        screen.feed("$ edit me\x1b[3D");
        assert_same(&mut screen, 6, 20);
    }
    #[test]
    fn scrollback_survives_as_lines_and_a_full_screen_is_exact() {
        let mut screen = Screen::new(5, 30);
        for line in 0..40 {
            screen.feed(&format!("\x1b[3{}mline {line}\x1b[0m\r\n", line % 8));
        }
        screen.feed("$ ");
        assert_same(&mut screen, 5, 30);
        let mut viewer = replay(&mut screen, 5, 30);
        viewer.screen_mut().set_scrollback(usize::MAX);
        assert_eq!(viewer.screen().scrollback(), 36);
        viewer.screen_mut().set_scrollback(36);
        assert!(viewer.screen().contents().starts_with("line 0\nline 1\n"));
    }
    #[test]
    fn alternate_screens_keep_the_main_screen_cursor_and_modes() {
        let mut screen = Screen::new(5, 20);
        screen.feed("$ vim notes\r\n\x1b[?2004h");
        screen.feed("\x1b[?1049h\x1b[H\x1b[2J\x1b[7m~ notes \x1b[0m\x1b[3;4Hx\x1b[?25l");
        assert_same(&mut screen, 5, 20);
        let mut viewer = replay(&mut screen, 5, 20);
        viewer.process(b"\x1b[?1049l");
        assert!(viewer.screen().contents().starts_with("$ vim notes"));
        assert_eq!(viewer.screen().cursor_position(), (1, 0));
        // Leaving and re-entering in one chunk saves the newer main screen.
        screen.feed("\x1b[?1049l$ less log\r\n\x1b[?1049hpager");
        let mut viewer = replay(&mut screen, 5, 20);
        viewer.process(b"\x1b[?1049l");
        assert!(viewer.screen().contents().contains("$ less log"));
    }
}
