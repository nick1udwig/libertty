//! Validated selected-file snapshots shared by successive plugin reads.
use crate::{
    files::{self, Error, Result},
    filesystem::FileSystem,
    reading::MAX_READING_BYTES,
};
use libertty_engine::utf16_len;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::VecDeque, os::unix::fs::MetadataExt, sync::Arc};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Cache {
    entries: VecDeque<(String, String, Snapshot)>,
}
#[derive(Clone)]
pub struct Snapshot {
    pub etag: String,
    pub value: Arc<Value>,
}
const REMOTE: &str = r#"import os,sys,json,hashlib,stat
try:
 p=sys.argv[1]; info=os.stat(p)
 if not stat.S_ISREG(info.st_mode): raise ValueError('This path is not a regular file.')
 if info.st_size>20971520: print(json.dumps({'error':'This file is too large for Reading Mode (20 MB limit).','status':413})); sys.exit()
 with open(p,'rb') as f: data=f.read(20971521)
 if len(data)>20971520: print(json.dumps({'error':'This file is too large for Reading Mode (20 MB limit).','status':413})); sys.exit()
 text=data.decode('utf-8')
 if '\0' in text: raise ValueError('This plugin can read only UTF-8 text files.')
 etag=hashlib.sha256(data).hexdigest()
 if etag==sys.argv[2]: print(json.dumps({'etag':etag,'unchanged':True})); sys.exit()
 units=text.encode('utf-16-le'); tail=units[-524288:].decode('utf-16-le','replace')
 print(json.dumps({'etag':etag,'value':{'path':p,'text':tail,'truncated':len(units)>524288,'version':etag}},ensure_ascii=False))
except FileNotFoundError: print(json.dumps({'error':'File not found.','status':404}))
except PermissionError: print(json.dumps({'error':'Permission denied for this file.','status':403}))
except (UnicodeError,ValueError,OSError): print(json.dumps({'error':'This plugin can read only UTF-8 text files.','status':400}))
"#;
fn stamp(info: &std::fs::Metadata) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}",
        info.dev(),
        info.ino(),
        info.len(),
        info.mode(),
        info.mtime(),
        info.mtime_nsec(),
        info.ctime(),
        info.ctime_nsec()
    )
}
impl Cache {
    pub async fn read(
        &mut self,
        fs: &FileSystem,
        cwd: &str,
        home: &str,
        input: &str,
        known: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Snapshot> {
        if input.is_empty()
            || utf16_len(input) > 4096
            || input.chars().any(|c| c < '\x20' || c == '\x7f')
        {
            return Err(Error::new("Enter a file path.", 400));
        }
        if cancel.is_cancelled() {
            return Err(Error::new("The operation was aborted", 400));
        }
        let path = files::file_path(cwd, home, input)?;
        if let Some(remote) = &fs.remote {
            let command = format!(
                "python3 -I -c {} {} {}",
                libertty_engine::repair::shell_quote(REMOTE),
                libertty_engine::repair::shell_quote(&path),
                libertty_engine::repair::shell_quote(known.unwrap_or(""))
            );
            // Older hosts without Python retain the SFTP implementation.
            let probe = async {
                let stream = remote
                    .open_stream(&command, cancel)
                    .await
                    .ok()?
                    .into_stream();
                let mut bytes = vec![];
                stream
                    .take(2 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .ok()?;
                if bytes.len() > 2 * 1024 * 1024 {
                    return None;
                }
                serde_json::from_slice::<Value>(&bytes).ok()
            };
            let reply = tokio::select! { biased; _=cancel.cancelled()=>return Err(Error::new("The operation was aborted",400)), reply=tokio::time::timeout(std::time::Duration::from_secs(10),probe)=>reply };
            if let Ok(Some(reply)) = reply {
                if let Some(error) = reply["error"].as_str() {
                    return Err(Error::new(
                        error,
                        reply["status"].as_u64().unwrap_or(400) as u16,
                    ));
                }
                if let Some(etag) = reply["etag"].as_str().filter(|etag| {
                    etag.len() == 64 && etag.bytes().all(|byte| byte.is_ascii_hexdigit())
                }) {
                    if reply["unchanged"] == true && known == Some(etag) {
                        return Ok(Snapshot {
                            etag: etag.into(),
                            value: Arc::new(Value::Null),
                        });
                    }
                    if reply["value"]["text"].is_string()
                        && reply["value"]["path"] == path
                        && reply["value"]["version"] == etag
                        && reply["value"]["truncated"].is_boolean()
                    {
                        let snapshot = Snapshot {
                            etag: etag.into(),
                            value: Arc::new(reply["value"].clone()),
                        };
                        self.remember(&path, String::new(), snapshot.clone());
                        return Ok(snapshot);
                    }
                }
            }
        }
        if cancel.is_cancelled() {
            return Err(Error::new("The operation was aborted", 400));
        }
        let info = fs.metadata(&path, true).await?;
        if !info.is_file() {
            return Err(Error::new("This path is not a regular file.", 400));
        }
        if info.len() > MAX_READING_BYTES as u64 {
            return Err(Error::new(
                "This file is too large for Reading Mode (20 MB limit).",
                413,
            ));
        }
        let version = if fs.remote.is_none() {
            stamp(&tokio::fs::metadata(&path).await?)
        } else {
            String::new()
        };
        if !version.is_empty()
            && let Some((_, _, snapshot)) = self
                .entries
                .iter()
                .rev()
                .find(|(file, old, _)| file == &path && old == &version)
        {
            return Ok(snapshot.clone());
        }
        let handle = fs.open_read(&path).await?;
        let mut bytes = vec![];
        handle
            .take(MAX_READING_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > MAX_READING_BYTES {
            return Err(Error::new(
                "This file is too large for Reading Mode (20 MB limit).",
                413,
            ));
        }
        let text = std::str::from_utf8(&bytes)
            .ok()
            .filter(|text| !text.contains('\0'))
            .ok_or_else(|| Error::new("This plugin can read only UTF-8 text files.", 400))?;
        let units: Vec<_> = text.encode_utf16().collect();
        let tail = String::from_utf16_lossy(&units[units.len().saturating_sub(256 * 1024)..]);
        let etag = format!("{:x}", Sha256::digest(&bytes));
        let snapshot = Snapshot {
            etag: etag.clone(),
            value: Arc::new(
                json!({"path":path,"text":tail,"truncated":units.len()>256*1024,"version":etag}),
            ),
        };
        let stable = fs.remote.is_none()
            && tokio::fs::metadata(&path)
                .await
                .is_ok_and(|info| stamp(&info) == version);
        self.remember(
            &path,
            if stable { version } else { String::new() },
            snapshot.clone(),
        );
        Ok(snapshot)
    }
    fn remember(&mut self, path: &str, stamp: String, snapshot: Snapshot) {
        self.entries.push_back((path.into(), stamp, snapshot));
        while self.entries.len() > 8
            || self
                .entries
                .iter()
                .map(|(_, _, snapshot)| snapshot.value["text"].as_str().map_or(0, str::len))
                .sum::<usize>()
                > 2 * 1024 * 1024
        {
            self.entries.pop_front();
        }
    }
    pub fn delta(&self, known: &str, snapshot: &Snapshot) -> Option<Value> {
        let old = self
            .entries
            .iter()
            .find(|(_, _, old)| old.etag == known && old.value["path"] == snapshot.value["path"])?;
        if old.2.value["truncated"] != false || snapshot.value["truncated"] != false {
            return None;
        }
        let suffix = snapshot.value["text"]
            .as_str()?
            .strip_prefix(old.2.value["text"].as_str()?)?;
        if suffix.len() * 2 >= snapshot.value["text"].as_str()?.len() {
            return None;
        }
        Some(
            json!({"path":snapshot.value["path"],"version":snapshot.etag,"truncated":false,"baseVersion":known,"append":suffix}),
        )
    }
}
