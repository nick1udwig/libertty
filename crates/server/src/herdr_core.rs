//! herdr-core transport and workspace adapter for the shared Herdr interface.
mod actions;
mod input;
mod projection;
mod terminal;
use crate::herdr::{Metadata, Snapshot, Target};
pub use actions::{action, options};
use herdr_client_lib::{client::Client, sync::Session, transport::HcConfig};
use libertty_engine::repair::shell_quote;
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
pub async fn snapshot(target: &Target) -> Result<Snapshot, String> {
    let session = session(target).await?;
    let mut snapshot = projection::project(&session)?;
    projection::repositories(&session, &mut snapshot, &mut BTreeMap::new()).await;
    Ok(snapshot)
}
async fn metadata_connection(
    target: &Target,
    send: tokio::sync::mpsc::Sender<Metadata>,
    cancel: CancellationToken,
) {
    let work = async {
        let mut session = session(target).await?;
        let mut repositories = BTreeMap::new();
        let mut previous = None;
        loop {
            let mut snapshot = projection::project(&session)?;
            projection::repositories(&session, &mut snapshot, &mut repositories).await;
            if previous.as_ref() != Some(&snapshot) {
                previous = Some(snapshot.clone());
                if send
                    .send(Metadata::Snapshot {
                        snapshot: Arc::new(snapshot),
                    })
                    .await
                    .is_err()
                {
                    return Ok(());
                }
            }
            session.next().await.map_err(error)?;
            reconcile(&mut session).await?;
        }
    };
    tokio::select! {
        _ = cancel.cancelled() => (),
        result = work => if let Err(message) = result { let _ = send.send(Metadata::Error { message }).await; },
    }
}

pub async fn metadata(
    target: &Target,
    send: tokio::sync::mpsc::Sender<Metadata>,
    cancel: CancellationToken,
) {
    while !cancel.is_cancelled() && !send.is_closed() {
        metadata_connection(target, send.clone(), cancel.clone()).await;
        tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(2)) => () }
    }
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
    let session = session(target).await?;
    let snapshot = projection::project(&session)?;
    let terminal = snapshot
        .terminals
        .iter()
        .find(|t| t.pane_id == pane)
        .ok_or("This pane has closed.")?;
    let record = projection::record(&session, &terminal.terminal_id)?;
    let record = session
        .client
        .terminal_get(&record.address, DEADLINE)
        .await
        .map_err(error)?;
    Ok((shell(&record), context(&record)))
}
pub(crate) async fn preview(target: &Target, terminal: &str) -> Result<String, String> {
    let session = session(target).await?;
    let record = projection::record(&session, terminal)?;
    session
        .client
        .terminal_read(&record.address, 40, DEADLINE)
        .await
        .map(|r| r.text)
        .map_err(error)
}
