use super::*;
use herdr_client_lib::{client::Stream, protocol::Terminal};

pub(super) fn ssh_line(record: &Terminal, parser: &vt100::Parser) -> bool {
    let screen = parser.screen();
    if !screen.bracketed_paste()
        || screen.alternate_screen()
        || !record
            .foreground
            .as_ref()
            .is_some_and(|fg| fg.name.rsplit('/').next() == Some("ssh"))
    {
        return false;
    }
    let (row, col) = screen.cursor_position();
    let mut start = row;
    while start > 0 && screen.row_wrapped(start - 1) {
        start -= 1;
    }
    let line = screen.contents_between(start, 0, row, col);
    ["$ ", "# ", "% ", "❯ ", "➜ "]
        .iter()
        .any(|marker| line.contains(marker))
}

pub(super) fn shell_line(record: &Terminal, parser: &vt100::Parser) -> bool {
    shell(record).is_some() || ssh_line(record, parser)
}

pub(super) struct Editable {
    pub text: String,
    context: String,
    screen: Option<(Vec<String>, (u16, u16))>,
}
impl Editable {
    pub fn new(text: String, record: &Terminal) -> Self {
        Self {
            text,
            context: context(record),
            screen: None,
        }
    }
    pub fn observe(&mut self, parser: &vt100::Parser) {
        let screen = parser.screen();
        let (row, col) = screen.cursor_position();
        let before = screen.contents_between(0, 0, row, col);
        if self.screen.is_none() && before.ends_with(&self.text) {
            self.screen = Some(Self::picture(parser));
        }
    }
    pub fn observed(&self) -> bool {
        self.screen.is_some()
    }
    fn picture(parser: &vt100::Parser) -> (Vec<String>, (u16, u16)) {
        let screen = parser.screen();
        (
            screen.rows(0, screen.size().1).collect(),
            screen.cursor_position(),
        )
    }
    pub async fn replace(
        &self,
        client: &Client,
        stream: &Stream,
        parser: &vt100::Parser,
        record: &Terminal,
        text: &str,
    ) -> Result<(), String> {
        if !crate::protocol::clean(text, crate::protocol::MAX_TEXT) {
            return Err("Replacement contains invalid terminal input.".into());
        }
        let current = client
            .terminal_get(&record.address, DEADLINE)
            .await
            .map_err(error)?;
        if !shell_line(&current, parser)
            || context(&current) != self.context
            || self.screen.as_ref() != Some(&Self::picture(parser))
        {
            return Err("Shell input changed; no replacement was sent.".into());
        }
        if text != self.text {
            stream
                .input(format!("{}{text}", "\x7f".repeat(self.text.chars().count())).into_bytes())
                .await
                .map_err(error)?;
        }
        Ok(())
    }
}

pub(super) struct Prepared {
    pub prompt: u64,
    pub revision: u64,
    pub reply: crate::protocol::RepairReply,
    pub cancel: CancellationToken,
}
pub(super) struct Pending {
    pub id: String,
    cancel: CancellationToken,
}
impl Pending {
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
}
pub(super) fn prepare(
    target: Target,
    terminal: String,
    request: crate::protocol::Repair,
    backend: bool,
    ssh_line: bool,
    lifetime: &CancellationToken,
    send: tokio::sync::mpsc::Sender<Prepared>,
) -> Pending {
    let cancel = lifetime.child_token();
    let lifetime = cancel.clone();
    let id = request.id.clone();
    tokio::spawn(async move {
        let mut reply = crate::protocol::RepairReply::new(
            request.id,
            request.text.clone(),
            request.prompt,
            request.revision,
            backend,
        );
        let services = crate::host::HostServices::new();
        let result = crate::input_coordinator::prepare(
            &request.text,
            &request.intent,
            &lifetime,
            DEADLINE,
            |text| {
                let (target, terminal, services, cancel) = (
                    target.clone(),
                    terminal.clone(),
                    services.clone(),
                    lifetime.clone(),
                );
                Box::pin(async move {
                    if ssh_line {
                        Ok(libertty_engine::repair::repair_without_host(&text))
                    } else {
                        target.suggest(&terminal, &text, services, &cancel).await
                    }
                })
            },
        )
        .await;
        match result {
            Ok(prepared) => reply.prepared = prepared,
            Err(error) => reply.error = Some(error),
        }
        let _ = send
            .send(Prepared {
                prompt: request.prompt,
                revision: request.revision,
                reply,
                cancel: lifetime,
            })
            .await;
    });
    Pending { id, cancel }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_shell_editing_follows_remote_terminal_modes() {
        let record = Terminal {
            foreground: Some(herdr_client_lib::protocol::Foreground {
                name: "ssh".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut parser = vt100::Parser::default();
        parser.process(b"Password: ");
        assert!(!shell_line(&record, &parser));
        parser.process(b"\r\n\x1b[?2004h>>> ");
        assert!(!shell_line(&record, &parser));
        parser.process(b"\r\nroot@abraham:~# ");
        assert!(shell_line(&record, &parser));
        parser.process(b"\x1b[?1049h");
        assert!(!shell_line(&record, &parser));
        parser.process(b"\x1b[?1049l\x1b[?2004l\r\n");
        assert!(!shell_line(&record, &parser));
    }

    #[test]
    fn wrapped_dictation_survives_duplicate_resize_but_rejects_edits() {
        let mut parser = vt100::Parser::new(5, 12, 0);
        let mut input = Editable::new("echo wrapped text".into(), &Terminal::default());
        parser.process(b"> echo wrapped text");
        input.observe(&parser);
        assert!(input.observed());
        let before = input.screen.clone();
        parser.screen_mut().set_size(5, 12);
        assert_eq!(before, Some(Editable::picture(&parser)));
        parser.process(b"X");
        assert_ne!(before, Some(Editable::picture(&parser)));
    }

    #[test]
    fn observation_waits_for_the_transcript_at_the_cursor() {
        let mut parser = vt100::Parser::new(5, 40, 0);
        let mut input = Editable::new("echo repeated  ".into(), &Terminal::default());
        parser.process(b"> echo repeated  \r\n> ");
        input.observe(&parser);
        assert!(!input.observed(), "History cannot stand in for new input");
        parser.process(b"echo repe");
        input.observe(&parser);
        assert!(!input.observed());
        parser.process(b"ated  ");
        input.observe(&parser);
        assert!(input.observed());
        let before = input.screen.clone();
        parser.process(b"\x1b[D");
        assert_ne!(before, Some(Editable::picture(&parser)));
    }
}
