use crate::dictation::{Checkpoint, MAX_OPUS_BYTES, MAX_OPUS_FRAMES};
use crate::dictation_profile as profile;
use futures::StreamExt;
use libertty_engine::{repair::shell_quote_literal, utf16_len};
use serde_json::{Value, json};
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, time::Duration};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig},
};

pub(crate) type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
pub(crate) async fn recording(
    env: &BTreeMap<String, String>,
    session: &str,
) -> Result<Socket, String> {
    let (url, token) = configuration(env)
        .await
        .map_err(|_| "Voxtype is unavailable.")?;
    connect(&url, &token, Some(session), Duration::from_secs(3)).await
}
fn directory(env: &BTreeMap<String, String>) -> String {
    format!(
        "{}/voxtype-mobile",
        env.get("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| format!(
                "{}/.local/share",
                env.get("HOME").map(String::as_str).unwrap_or("")
            ))
    )
}
async fn configuration(env: &BTreeMap<String, String>) -> Result<(url::Url, String), String> {
    let file = env
        .get("LIBERTTY_VOXTYPE_TOKEN_FILE")
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| format!("{}/token", directory(env)));
    let info = tokio::fs::metadata(&file)
        .await
        .map_err(|e| e.to_string())?;
    if info.permissions().mode() & 0o077 != 0 {
        return Err("Voxtype token must be private (chmod 600).".into());
    }
    let raw = tokio::fs::read_to_string(file)
        .await
        .map_err(|e| e.to_string())?;
    let token = raw.trim();
    if utf16_len(token) < 32 || token.contains(['\r', '\n']) {
        return Err("Invalid Voxtype token.".into());
    }
    let url = url::Url::parse(
        env.get("LIBERTTY_VOXTYPE_URL")
            .filter(|v| !v.is_empty())
            .map(String::as_str)
            .unwrap_or("ws://127.0.0.1:8765/v1/dictate"),
    )
    .map_err(|e| e.to_string())?;
    if url.scheme() != "ws"
        || !["127.0.0.1", "[::1]", "localhost"].contains(&url.host_str().unwrap_or(""))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Voxtype must use a local WebSocket endpoint.".into());
    }
    Ok((url, token.into()))
}
pub fn compatible(value: &Value) -> bool {
    value["type"] == "capabilities"
        && value["protocol"].as_f64() == Some(profile::PROTOCOL as f64)
        && value["dictation"] == true
        && value["resume"] == true
        && value["sample_rate"].as_f64() == Some(profile::SAMPLE_RATE as f64)
        && value["channels"].as_f64() == Some(profile::CHANNELS as f64)
        && value["format"] == "opus"
        && value["framing"] == "sequence_opus_v1"
        && value["audio_encodings"]
            .as_array()
            .is_some_and(|a| a.contains(&json!("opus_v1")))
        && value["results"]
            .as_array()
            .is_some_and(|a| a.contains(&json!("final")))
}
async fn connect(
    url: &url::Url,
    token: &str,
    recording: Option<&str>,
    timeout: Duration,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| "Invalid Voxtype token.")?,
    );
    if let Some(session) = recording {
        for (name, value) in [
            ("X-Voxtype-Protocol", profile::PROTOCOL.to_string()),
            ("X-Voxtype-Audio", "opus_v1".to_owned()),
        ] {
            request.headers_mut().insert(name, value.parse().unwrap());
        }
        request.headers_mut().insert(
            "X-Voxtype-Session",
            session.parse().map_err(|_| "Invalid recording session.")?,
        );
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(if recording.is_some() { 65536 } else { 16384 }))
        .max_frame_size(Some(if recording.is_some() { 65536 } else { 16384 }));
    tokio::time::timeout(
        timeout,
        connect_async_with_config(request, Some(config), false),
    )
    .await
    .map_err(|_| "Could not connect to Voxtype.".to_owned())?
    .map(|(socket, _)| socket)
    .map_err(|_| "Could not connect to Voxtype.".into())
}
pub async fn detect(env: &BTreeMap<String, String>) -> Value {
    let file = env
        .get("LIBERTTY_VOXTYPE_TOKEN_FILE")
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| format!("{}/token", directory(env)));
    let installed = tokio::fs::metadata(file).await.is_ok()
        || tokio::fs::metadata(format!("{}/voxtype", directory(env)))
            .await
            .is_ok();
    let Ok((mut url, token)) = configuration(env).await else {
        return json!({"installed":installed,"available":false});
    };
    let pathname = url
        .path()
        .strip_suffix("/dictate")
        .map(|prefix| format!("{prefix}/capabilities"))
        .unwrap_or_else(|| url.path().to_owned());
    url.set_path(&pathname);
    let available = tokio::time::timeout(Duration::from_secs(2), async {
        let mut socket = connect(&url, &token, None, Duration::from_millis(1500))
            .await
            .ok()?;
        let event = socket.next().await?;
        let available = event
            .ok()
            .and_then(|message| serde_json::from_slice::<Value>(&message.into_data()).ok())
            .is_some_and(|value| compatible(&value));
        let _ = socket.close(None).await;
        Some(available)
    })
    .await
    .ok()
    .flatten()
    .unwrap_or(false);
    if available {
        json!({"installed":true,"available":true})
    } else {
        json!({"installed":true,"available":false,"reason":"Voxtype is installed but its dictation API is unavailable or needs updating."})
    }
}
pub async fn install_command(env: &BTreeMap<String, String>) -> Result<String, String> {
    let local = env
        .get("LIBERTTY_VOXTYPE_SOURCE")
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            format!(
                "{}/git/voxtype-mobile",
                env.get("HOME").map(String::as_str).unwrap_or("")
            )
        });
    let script = format!("{local}/scripts/install");
    if tokio::fs::metadata(&script).await.is_ok() {
        return Ok(format!("bash {}", shell_quote_literal(&script)));
    }
    let address=env.get("LIBERTTY_VOXTYPE_INSTALL_URL").filter(|v|!v.is_empty()).ok_or("Set LIBERTTY_VOXTYPE_INSTALL_URL to the published voxtype-mobile install script, or LIBERTTY_VOXTYPE_SOURCE to its checkout.")?;
    let url = url::Url::parse(address).map_err(|e| e.to_string())?;
    if url.scheme() != "https" {
        return Err("The installer URL must use HTTPS.".into());
    }
    let parts = url
        .path()
        .split('/')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>();
    let repository = env
        .get("LIBERTTY_VOXTYPE_REPO")
        .filter(|v| !v.is_empty())
        .cloned()
        .or_else(|| {
            if url.host_str() == Some("raw.githubusercontent.com") && parts.len() >= 4 {
                Some(format!("https://github.com/{}/{}.git", parts[0], parts[1]))
            } else {
                None
            }
        })
        .ok_or("Set LIBERTTY_VOXTYPE_REPO to the repository used by the downloaded installer.")?;
    Ok(format!(
        "(libertty_voxtype_installer=$(mktemp) && trap 'rm -f \"$libertty_voxtype_installer\"' EXIT && curl -fsSL {} -o \"$libertty_voxtype_installer\" && VOXTYPE_MOBILE_REPO={} bash \"$libertty_voxtype_installer\")",
        shell_quote_literal(url.as_str()),
        shell_quote_literal(&repository)
    ))
}

pub(crate) enum Event {
    Ready(Checkpoint),
    Final(String),
    Other,
}
pub(crate) fn event(bytes: &[u8]) -> Result<Event, String> {
    let event: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid Voxtype response.")?;
    match event["type"].as_str() {
        Some("ready") => {
            if event["protocol"].as_f64() != Some(profile::PROTOCOL as f64)
                || event["sample_rate"].as_f64() != Some(profile::SAMPLE_RATE as f64)
                || event["channels"].as_f64() != Some(profile::CHANNELS as f64)
                || event["format"] != "opus"
                || event["audio_encoding"] != "opus_v1"
                || event["framing"] != "sequence_opus_v1"
                || event["resume"] != true
            {
                return Err(
                    "Unsupported Voxtype audio format. Update libertty and Voxtype together."
                        .into(),
                );
            }
            let accepted_frames = crate::protocol::unsigned(&event["accepted_frames"])
                .filter(|frames| *frames <= MAX_OPUS_FRAMES)
                .ok_or("Invalid Voxtype audio checkpoint.")?;
            let finished = event["finished"]
                .as_bool()
                .ok_or("Invalid Voxtype audio checkpoint.")?;
            let max_samples = (event["max_seconds"]
                .as_f64()
                .filter(|n| *n != 0.0)
                .unwrap_or(profile::MAX_SECONDS as f64)
                .clamp(1.0, profile::MAX_SECONDS as f64)
                * profile::SAMPLE_RATE as f64) as u32;
            let max_encoded_bytes = event["max_encoded_bytes"]
                .as_f64()
                .filter(|n| *n != 0.0)
                .unwrap_or(MAX_OPUS_BYTES as f64)
                .clamp(17.0, MAX_OPUS_BYTES as f64) as usize;
            Ok(Event::Ready(Checkpoint {
                accepted_frames,
                finished,
                max_samples,
                max_encoded_bytes,
            }))
        }
        Some("final") => {
            let text = event["text"]
                .as_str()
                .filter(|s| utf16_len(s) <= crate::protocol::MAX_TEXT)
                .ok_or("Invalid Voxtype result.")?;
            Ok(Event::Final(text.to_owned()))
        }
        Some("error") => Err(if event["code"] == "busy" {
            "Voxtype is busy. Try again after the current dictation."
        } else {
            "Voxtype could not transcribe this recording."
        }
        .into()),
        _ => Ok(Event::Other),
    }
}
