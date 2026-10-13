#[derive(Default, Clone, Copy)]
enum State {
    #[default]
    Text,
    Escape,
    Csi,
    String,
    StringEscape,
}
#[derive(Default)]
pub struct PasteMode {
    pub enabled: bool,
    state: State,
    parameters: String,
}
impl PasteMode {
    pub fn feed(&mut self, data: &str) {
        for ch in data.chars() {
            match self.state {
                State::String | State::StringEscape => {
                    if ch == '\x07' || (matches!(self.state, State::StringEscape) && ch == '\\') {
                        self.state = State::Text;
                    } else {
                        self.state = if ch == '\x1b' {
                            State::StringEscape
                        } else {
                            State::String
                        };
                    }
                }
                _ if ch == '\x1b' => self.state = State::Escape,
                State::Escape => {
                    if ch == '[' {
                        self.state = State::Csi;
                        self.parameters.clear();
                    } else if "]PX^_".contains(ch) {
                        self.state = State::String;
                    } else {
                        if ch == 'c' {
                            self.enabled = false;
                        }
                        self.state = State::Text;
                    }
                }
                State::Csi => {
                    if ('@'..='~').contains(&ch) {
                        if let Some(parameters) = self.parameters.strip_prefix('?')
                            && parameters.split(';').all(|part| {
                                !part.is_empty() && part.bytes().all(|ch| ch.is_ascii_digit())
                            })
                            && parameters.split(';').any(|part| part == "2004")
                            && ['h', 'l'].contains(&ch)
                        {
                            self.enabled = ch == 'h';
                        }
                        self.state = State::Text;
                    } else if self.parameters.len() < 256 {
                        self.parameters.push(ch);
                    } else {
                        self.state = State::Text;
                    }
                }
                _ => {}
            }
        }
    }
    pub fn paste(&self, text: &str) -> String {
        if self.enabled {
            format!("\x1b[200~{text}\x1b[201~")
        } else {
            text.into()
        }
    }
}
