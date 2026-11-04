//! herdr-core transport and workspace adapter for the shared Herdr interface.
mod actions;
mod hub;
mod input;
mod projection;
mod terminal;
use crate::herdr::{Metadata, Snapshot, Target};
pub use actions::options;
use herdr_client_lib::{client::Client, sync::Session, transport::HcConfig};
pub use hub::metadata;
use libertty_engine::repair::shell_quote;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
pub use terminal::terminal;
use tokio_util::sync::CancellationToken;

pub const DEADLINE: Duration = Duration::from_secs(10);
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub async fn connect(target: &Target) -> Result<Client, String> {
    let session = if target.session.is_empty() {
        "default"
    } else {
        &target.session
    };
    if let Some(remote) = &target.remote {
        let command = format!("env HC_SESSION={} hc connect", shell_quote(session));
        let channel = remote
            .open_stream(&command, &CancellationToken::new())
            .await?;
        Client::connect(channel.into_stream(), DEADLINE)
            .await
            .map_err(error)
    } else {
        HcConfig {
            binary: target
                .env
                .get("LIBERTTY_HC_BINARY")
                .map(String::as_str)
                .unwrap_or("hc")
                .into(),
            session: session.into(),
            environment: target
                .env
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        }
        .connect(DEADLINE)
        .await
        .map_err(error)
    }
}
async fn session(target: &Target) -> Result<Session, String> {
    let client = connect(target).await?;
    let mut machines = vec![String::new()];
    if client.supports("machine.list") {
        machines.extend(
            client
                .machine_list(DEADLINE)
                .await
                .map_err(error)?
                .machines
                .into_iter()
                .filter(|m| m.connected())
                .map(|m| m.name),
        );
    }
    let mut session = Session::connect(client, machines, DEADLINE)
        .await
        .map_err(error)?;
    reconcile(&mut session).await?;
    Ok(session)
}
async fn reconcile(session: &mut Session) -> Result<(), String> {
    for machine in session.documents.keys().cloned().collect::<Vec<_>>() {
        if let Some(herdr_client_lib::sync::WriteOutcome::Unavailable(message)) =
            session.reconcile_finished(&machine).await.map_err(error)?
        {
            return Err(message);
        }
    }
    Ok(())
}
pub async fn snapshot(target: &Target) -> Result<Arc<Snapshot>, String> {
    Ok(hub::live(target).await?.snapshot.clone())
}

pub(crate) async fn validate_terminal(
    target: &Target,
    terminal: &crate::herdr::Terminal,
) -> Result<(), String> {
    snapshot(target)
        .await?
        .terminal(&terminal.terminal_id)
        .filter(|t| t.pane_id == terminal.pane_id)
        .map(|_| ())
        .ok_or("This terminal ended or moved.".into())
}
/// Runs an action on its own session, then waits until the shared session includes its result.
pub async fn action(target: &Target, input: crate::herdr::action::Action) -> Result<Value, String> {
    let result = actions::action(target, input).await;
    hub::refresh(target).await?;
    result
}

pub(crate) fn shell(
    record: &herdr_client_lib::protocol::Terminal,
) -> Option<crate::herdr::ShellInput> {
    if record.address.contains('/') {
        return None;
    }
    let foreground = record.foreground.as_ref()?;
    let pid = record.pid?;
    if foreground.pid != pid as i32
        || !matches!(
            foreground.name.as_str(),
            "bash" | "zsh" | "fish" | "sh" | "dash" | "ksh"
        )
        || !foreground.cwd.starts_with('/')
    {
        return None;
    }
    Some(crate::herdr::ShellInput {
        pid: u64::from(pid),
        cwd: foreground.cwd.clone(),
    })
}
pub(crate) fn context(record: &herdr_client_lib::protocol::Terminal) -> String {
    serde_json::json!([
        record.identity,
        record.pid,
        record.foreground.as_ref().map(|f| f.pid)
    ])
    .to_string()
}
pub(crate) async fn input_state(
    target: &Target,
    pane: &str,
) -> Result<(Option<crate::herdr::ShellInput>, String), String> {
    let live = hub::live(target).await?;
    let terminal = live
        .snapshot
        .terminals
        .iter()
        .find(|t| t.pane_id == pane)
        .ok_or("This pane has closed.")?;
    let record = live
        .client
        .terminal_get(&live.record(&terminal.terminal_id)?.address, DEADLINE)
        .await
        .map_err(error)?;
    Ok((shell(&record), context(&record)))
}
pub(crate) async fn preview(target: &Target, terminal: &str) -> Result<String, String> {
    let live = hub::live(target).await?;
    live.client
        .terminal_read(&live.record(terminal)?.address, 40, DEADLINE)
        .await
        .map(|r| r.text)
        .map_err(error)
}
