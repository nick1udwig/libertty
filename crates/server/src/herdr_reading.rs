use crate::{herdr::Target, reading::MAX_READING_BYTES};
use base64::{Engine, engine::general_purpose::STANDARD};
use libertty_engine::{repair::shell_quote, utf16_len};
use russh::ChannelMsg;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

const READER: &str = r#"
builtin unalias look 2>/dev/null || :
function look {
  if [[ "${1-}" != at ]]; then command look "$@"; return; fi
  shift
  local mode=auto target code=0
  case "${1-}" in
    --file) mode=file; shift ;;
    --command) mode=command; shift ;;
    --) shift ;;
  esac
  target="$(IFS=' '; printf '%s' "$*")"
  if (( $# )) && [[ "$mode" != command ]] && {
    [[ -e "$target" || "$mode" == file ]] || ! builtin type -t -- "$1" >/dev/null;
  }; then
    [[ "$target" == /* ]] || target="$PWD/$target"
    printf 'file:%s\n' "$(printf '%s' "$target" | command base64 | command tr -d '\n')"
    return
  fi
  if (( $# == 0 )); then target='Command output'; fi
  printf 'capture:%s\n' "$(printf '%s' "$target" | command base64 | command tr -d '\n')"
  if (( $# )); then
    if "$@" | command head -c 20971521; then
      code=${PIPESTATUS[0]}
    else
      code=${PIPESTATUS[0]}
    fi
  else
    if command head -c 20971521; then code=0; else code=$?; fi
  fi
  printf '%03d' "$code"
}
cd -- "$1" || exit
eval -- "$2"
"#;

pub enum Opened {
    File(String),
    Capture {
        name: String,
        data: Vec<u8>,
        exit_code: u8,
    },
}

pub async fn open(
    target: &Target,
    terminal: &str,
    command: &str,
    context: &str,
    cwd: &str,
    cancel: &CancellationToken,
) -> Result<Opened, String> {
    if utf16_len(command) > 16000
        || crate::protocol::controls(command)
        || matches!(
            crate::alternatives::Intent::detect(command, &serde_json::Value::Null),
            crate::alternatives::Intent::Shell
        )
    {
        return Err("Use a reading phrase with a file or command.".into());
    }
    let snapshot = target.snapshot().await?;
    let pane = snapshot
        .terminal(terminal)
        .ok_or("This terminal has ended.")?;
    target.validate_terminal(pane).await?;
    let (shell, current) = target.input_state(&pane.pane_id).await?;
    let shell = shell.ok_or("Return to the Herdr shell prompt before opening the reader.")?;
    if current != context || shell.cwd != cwd {
        return Err("The Herdr shell changed. Try opening the reader again.".into());
    }
    let args = [
        "-lc".into(),
        READER.into(),
        "libertty-reading".into(),
        shell.cwd,
        command.into(),
    ];
    let limit = MAX_READING_BYTES + 65536;
    let stdout = if let Some(remote) = &target.remote {
        remote
            .pool
            .run(cancel, async {
                let command = format!(
                    "bash {}",
                    args.iter()
                        .map(|arg| shell_quote(arg))
                        .collect::<Vec<_>>()
                        .join(" ")
                );
                let channel = remote.open_stream(&command, cancel).await?;
                let (mut receive, send) = channel.split();
                let _guard = crate::ssh::ChannelGuard(Arc::new(send));
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                tokio::time::timeout(Duration::from_secs(30), async {
                    while let Some(message) = receive.wait().await {
                        match message {
                            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                            ChannelMsg::ExtendedData { data, .. } => {
                                stderr.extend_from_slice(&data)
                            }
                            ChannelMsg::Close => break,
                            _ => {}
                        }
                        if stdout.len() > limit || stderr.len() > limit {
                            return Err("Reading Mode output exceeds the 20 MB limit.".into());
                        }
                    }
                    Ok(stdout)
                })
                .await
                .map_err(|_| "Reading command timed out.")?
            })
            .await?
    } else {
        crate::probes::probe(
            &crate::probes::ProbePool::default(),
            "bash",
            &args,
            &crate::probes::ProbeOptions {
                cwd: cwd.into(),
                env: target.env.clone(),
                timeout: Duration::from_secs(30),
                max_buffer: limit,
            },
            cancel,
        )
        .await?
        .stdout
    };
    let end = stdout
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or("The reading command did not produce a result.")?;
    let header = std::str::from_utf8(&stdout[..end]).map_err(|_| "Invalid reading result.")?;
    let (kind, encoded) = header.split_once(':').ok_or("Invalid reading result.")?;
    let name = String::from_utf8(
        STANDARD
            .decode(encoded)
            .map_err(|_| "Invalid reading result.")?,
    )
    .map_err(|_| "Invalid reading result.")?;
    match kind {
        "file"
            if name.starts_with('/')
                && utf16_len(&name) <= 4096
                && !crate::protocol::controls(&name) =>
        {
            Ok(Opened::File(name))
        }
        "capture" if stdout.len() >= end + 4 => {
            let trailer = stdout.len() - 3;
            let exit_code = std::str::from_utf8(&stdout[trailer..])
                .ok()
                .and_then(|value| value.parse::<u8>().ok())
                .ok_or("Invalid reading exit status.")?;
            Ok(Opened::Capture {
                name,
                data: stdout[end + 1..trailer].to_vec(),
                exit_code,
            })
        }
        _ => Err("Invalid reading result.".into()),
    }
}
