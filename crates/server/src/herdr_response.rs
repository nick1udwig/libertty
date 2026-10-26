use crate::{filesystem::FileSystem, herdr::Target};
use serde_json::Value;
use std::path::Path;
use tokio::io::AsyncReadExt;

const MAX_TRANSCRIPT_TAIL: u64 = 8 * 1024 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;

pub async fn latest(target: &Target, terminal: &str) -> Result<String, String> {
    let snapshot = target.snapshot().await?;
    let terminal = snapshot.terminal(terminal).ok_or("This agent has ended.")?;
    let pane = target
        .request("pane.get", serde_json::json!({"pane_id":terminal.pane_id}))
        .await?;
    if pane["pane"]["terminal_id"] != terminal.terminal_id {
        return Err("This agent ended or moved; reopen its tab.".into());
    }
    let session = &pane["pane"]["agent_session"];
    if session.is_null() {
        let agent = pane["pane"]["agent"].as_str().unwrap_or("");
        return Err(match agent {
            "codex" | "claude" | "claude-code" => format!(
                concat!(
                    "Herdr has no transcript reference for this agent. ",
                    "Run `herdr integration install {}` on the agent host, then restart or resume the agent."
                ),
                if agent == "codex" { "codex" } else { "claude" }
            ),
            _ => {
                "Copy response supports Codex and Claude agents with a Herdr transcript reference."
                    .into()
            }
        });
    }
    let agent = session["agent"].as_str().unwrap_or("");
    let home = target
        .env
        .get("HOME")
        .ok_or("The agent home directory is unavailable.")?;
    let (root, depth) = match agent {
        "codex" => (
            format!(
                "{}/sessions",
                target
                    .env
                    .get("CODEX_HOME")
                    .cloned()
                    .unwrap_or_else(|| format!("{home}/.codex"))
            ),
            3,
        ),
        "claude" | "claude-code" => (
            format!(
                "{}/projects",
                target
                    .env
                    .get("CLAUDE_CONFIG_DIR")
                    .cloned()
                    .unwrap_or_else(|| format!("{home}/.claude"))
            ),
            1,
        ),
        _ => {
            return Err(
                "Copy response requires a Codex or Claude transcript reported by Herdr.".into(),
            );
        }
    };
    let fs = FileSystem {
        remote: target.remote.clone(),
    };
    let reference = session["value"]
        .as_str()
        .ok_or("This agent has not reported its transcript.")?;
    let path = match session["kind"].as_str() {
        Some("path") if reference.starts_with('/') && reference.ends_with(".jsonl") => {
            reference.to_owned()
        }
        Some("id")
            if !reference.is_empty()
                && reference.len() <= 128
                && reference
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-') =>
        {
            find(&fs, &root, reference, depth).await?
        }
        _ => return Err("This agent has not reported a supported transcript reference.".into()),
    };
    let root = canonical(target, &root).await?;
    let path = canonical(target, &path).await?;
    if !Path::new(&path).starts_with(&root) || !path.ends_with(".jsonl") {
        return Err("The transcript is outside the agent session directory.".into());
    }
    let info = fs.metadata(&path, true).await.map_err(|e| e.message)?;
    if !info.is_file() {
        return Err("The transcript is not a regular file.".into());
    }
    let offset = info.len().saturating_sub(MAX_TRANSCRIPT_TAIL);
    let mut bytes = Vec::new();
    fs.open_read_at(&path, offset)
        .await
        .map_err(|e| e.message)?
        .take(MAX_TRANSCRIPT_TAIL + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_TRANSCRIPT_TAIL {
        return Err("The transcript changed; try copying again.".into());
    }
    let bytes = if offset > 0 {
        let start = bytes
            .iter()
            .position(|b| *b == b'\n')
            .ok_or("The latest response exceeds the transcript read limit.")?;
        &bytes[start + 1..]
    } else {
        &bytes[..]
    };
    let text = std::str::from_utf8(bytes).map_err(|_| "The transcript is not valid UTF-8.")?;
    let response = response(text, agent, offset > 0)?;
    let current = target
        .request("pane.get", serde_json::json!({"pane_id":terminal.pane_id}))
        .await?;
    if current["pane"]["terminal_id"] != terminal.terminal_id
        || current["pane"]["agent_session"] != *session
    {
        return Err("The agent conversation changed; try copying again.".into());
    }
    Ok(response)
}

async fn canonical(target: &Target, path: &str) -> Result<String, String> {
    if let Some(remote) = &target.remote {
        remote
            .files
            .canonicalize(path)
            .await
            .map_err(|e| e.to_string())
    } else {
        tokio::fs::canonicalize(path)
            .await
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    }
}

async fn find(fs: &FileSystem, root: &str, id: &str, depth: usize) -> Result<String, String> {
    let mut pending = vec![(root.to_owned(), depth)];
    let mut visited = 0;
    let mut entries_seen = 0;
    let mut found = None;
    while let Some((directory, depth)) = pending.pop() {
        visited += 1;
        if visited > 512 {
            return Err(
                "The transcript search limit was reached; configure Herdr to report its path."
                    .into(),
            );
        }
        let (entries, truncated) = fs.read_entries(&directory).await.map_err(|e| e.message)?;
        entries_seen += entries.len();
        if truncated || entries_seen > 20000 {
            return Err("The transcript directory exceeds the search limit.".into());
        }
        for entry in entries {
            if entry.symlink {
                continue;
            }
            let path = format!("{directory}/{}", entry.name);
            if entry.directory && depth > 0 {
                pending.push((path, depth - 1));
            } else if !entry.directory
                && (entry.name == format!("{id}.jsonl")
                    || entry.name.starts_with("rollout-")
                        && entry.name.ends_with(&format!("-{id}.jsonl")))
            {
                if found.is_some() {
                    return Err(
                        "More than one transcript matches this agent; report its path in Herdr."
                            .into(),
                    );
                }
                found = Some(path);
            }
        }
    }
    found.ok_or_else(|| "The agent transcript was not found in its session directory.".into())
}

fn response(transcript: &str, agent: &str, truncated: bool) -> Result<String, String> {
    let mut parts = Vec::new();
    let mut message_id: Option<String> = None;
    for line in transcript
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
    {
        let record: Value = serde_json::from_str(line).map_err(
            |_| "The transcript is still being written or is invalid; try copying again.",
        )?;
        let message = if agent == "codex" {
            if record["type"] != "response_item" {
                continue;
            }
            &record["payload"]
        } else {
            if !matches!(record["type"].as_str(), Some("assistant" | "user")) {
                continue;
            }
            &record["message"]
        };
        if message["role"] == "user" {
            if parts.is_empty() {
                continue;
            }
            return finish(parts);
        }
        if message["role"] != "assistant" {
            continue;
        }
        if let Some(id) = message_id.as_deref()
            && message["id"].as_str() != Some(id)
        {
            return finish(parts);
        }
        if message["phase"] == "commentary" || message["stop_reason"] == "tool_use" {
            if parts.is_empty() {
                continue;
            }
            return finish(parts);
        }
        let content = message["content"]
            .as_array()
            .ok_or("The assistant response format is unsupported.")?;
        let text = content
            .iter()
            .filter(|block| matches!(block["type"].as_str(), Some("text" | "output_text")))
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        if text.trim().is_empty() {
            continue;
        }
        if message_id.is_none() {
            message_id = message["id"].as_str().map(str::to_owned);
        }
        parts.push(text);
        if agent == "codex" || message_id.is_none() {
            return finish(parts);
        }
    }
    if parts.is_empty() {
        return Err(if truncated {
            "No complete response was found in the last 8 MB of the transcript."
        } else {
            "This conversation has no assistant response to copy yet."
        }
        .into());
    }
    if truncated {
        return Err("The latest response may exceed the transcript read limit.".into());
    }
    finish(parts)
}

fn finish(mut parts: Vec<String>) -> Result<String, String> {
    parts.reverse();
    let text = parts.join("\n\n");
    if text.len() > MAX_RESPONSE {
        return Err("The response exceeds the 2 MB copy limit.".into());
    }
    Ok(text)
}
