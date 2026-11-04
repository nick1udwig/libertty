use super::*;
use herdr_client_lib::{client::Stream, protocol::Terminal};

pub(super) struct Editable {
    pub text: String,
    context: String,
    screen: Option<(String, (u16, u16))>,
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
        let text = parser.screen().contents();
        if self.screen.is_none() && text.contains(&self.text) {
            self.screen = Some((text, parser.screen().cursor_position()));
        }
    }
    pub async fn replace(
        &self,
        client: &Client,
        stream: &Stream,
        parser: &vt100::Parser,
        record: &Terminal,
        text: &str,
    ) -> Result<(), String> {
        if libertty_engine::utf16_len(text) > crate::protocol::MAX_TEXT
            || crate::protocol::controls(text)
        {
            return Err("Replacement contains invalid terminal input.".into());
        }
        let current = client
            .terminal_get(&record.address, DEADLINE)
            .await
            .map_err(error)?;
        if shell(&current).is_none()
            || context(&current) != self.context
            || self.screen.as_ref()
                != Some(&(
                    parser.screen().contents(),
                    parser.screen().cursor_position(),
                ))
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
                Box::pin(async move { target.suggest(&terminal, &text, services, &cancel).await })
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
