//! Resumable uploads, which accumulate beside their destination until the last byte arrives.
use crate::{
    files::{Error, MAX_UPLOAD, Result, file_path, valid_name},
    filesystem::FileSystem,
};
use axum::body::Body;
use futures::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

/// An abandoned upload's partial file is removed after this long without an attempt.
const IDLE: Duration = Duration::from_secs(15 * 60);
const COMPLETED: Duration = Duration::from_secs(120);
const UPLOADS: usize = 64;

struct Upload {
    fs: FileSystem,
    partial: String,
    destination: String,
    name: String,
    size: u64,
    /// Bytes safely written to the partial file.
    received: Mutex<u64>,
    /// Serializes attempts and retains completion after the partial file is renamed.
    writer: tokio::sync::Mutex<bool>,
    /// Cancels the current attempt when a newer one takes over, because a dead link may hold a request open.
    current: Mutex<CancellationToken>,
    touched: Mutex<Instant>,
}
impl Upload {
    fn idle(&self, now: Instant) -> bool {
        self.writer.try_lock().is_ok_and(|complete| {
            now.duration_since(*self.touched.lock().unwrap())
                >= if *complete { COMPLETED } else { IDLE }
        })
    }
    fn received(&self) -> Value {
        json!({ "received": *self.received.lock().unwrap() })
    }
    fn completed(&self) -> Value {
        json!({ "name": self.name, "bytes": self.size })
    }
}
/// Where an upload goes and how long it is.
pub struct Destination<'a> {
    pub cwd: &'a str,
    pub home: &'a str,
    pub directory: &'a str,
    pub name: &'a str,
    pub size: u64,
}
#[derive(Default)]
pub struct Uploads(Mutex<HashMap<String, Arc<Upload>>>);
impl Uploads {
    fn open(&self, key: &str, create: impl FnOnce() -> Upload) -> Result<Arc<Upload>> {
        let mut uploads = self.0.lock().unwrap();
        let now = Instant::now();
        uploads.retain(|_, upload| {
            let idle = upload.idle(now);
            if idle {
                upload.fs.remove_on_drop(upload.partial.clone());
            }
            !idle
        });
        if let Some(upload) = uploads.get(key) {
            return Ok(upload.clone());
        }
        if uploads.len() >= UPLOADS {
            return Err(Error::new(
                "Too many uploads are in progress. Try again shortly.",
                429,
            ));
        }
        let upload = Arc::new(create());
        uploads.insert(key.to_owned(), upload.clone());
        Ok(upload)
    }
    /// Write an attempt's body at `offset`, reporting how many bytes have arrived until the file is complete.
    pub async fn receive(
        &self,
        scope: &str,
        id: &str,
        fs: &FileSystem,
        destination: Destination<'_>,
        offset: u64,
        body: Body,
    ) -> Result<Value> {
        let Destination {
            cwd,
            home,
            directory,
            name,
            size,
        } = destination;
        let key = &format!("{scope}/{id}");
        if !valid_name(name) {
            return Err(Error::new("Choose a valid file name.", 400));
        }
        if size > MAX_UPLOAD {
            return Err(Error::new("Uploads are limited to 1 GB per file.", 413));
        }
        let directory = file_path(cwd, home, directory)?;
        let destination = libertty_engine::path::join(&[&directory, name]);
        let partial = libertty_engine::path::join(&[&directory, &format!(".libertty-upload-{id}")]);
        let existing = self.0.lock().unwrap().get(key).cloned();
        let upload = match existing {
            Some(upload) => upload,
            None => {
                if !fs.metadata(&directory, true).await?.is_dir() {
                    return Err(Error::new("Upload destination is not a directory.", 400));
                }
                exclusive(fs, &destination).await?;
                // A partial file left by a backend restart restarts from its beginning.
                let _ = fs.remove(&partial, false).await;
                fs.create_new(&partial, 0o600).await?.shutdown().await?;
                self.open(key, || Upload {
                    fs: fs.clone(),
                    partial,
                    destination,
                    name: name.to_owned(),
                    size,
                    received: Mutex::new(0),
                    writer: Default::default(),
                    current: Default::default(),
                    touched: Mutex::new(Instant::now()),
                })?
            }
        };
        if upload.destination != libertty_engine::path::join(&[&directory, name])
            || upload.size != size
        {
            return Err(Error::new("This upload continues a different file.", 409));
        }
        let cancel = CancellationToken::new();
        std::mem::replace(&mut *upload.current.lock().unwrap(), cancel.clone()).cancel();
        let mut complete = upload.writer.lock().await;
        *upload.touched.lock().unwrap() = Instant::now();
        if *complete {
            return Ok(upload.completed());
        }
        if cancel.is_cancelled() || offset != *upload.received.lock().unwrap() {
            return Ok(upload.received());
        }
        let mut output = fs.open_write_at(&upload.partial, offset).await?;
        let mut input = body.into_data_stream();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30 * 60);
        let failure = loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => break None,
                _ = tokio::time::sleep_until(deadline) => break Some(Error::new("The operation was aborted due to timeout", 400)),
                chunk = input.next() => chunk,
            };
            let Some(chunk) = chunk else { break None };
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => break Some(Error::new(error.to_string(), 400)),
            };
            let received = *upload.received.lock().unwrap() + chunk.len() as u64;
            if received > size {
                self.0.lock().unwrap().remove(key);
                fs.remove_on_drop(upload.partial.clone());
                return Err(Error::new(
                    "The upload is longer than its declared size.",
                    400,
                ));
            }
            if let Err(error) = output.write_all(&chunk).await {
                break Some(error.into());
            }
            *upload.received.lock().unwrap() = received;
            *upload.touched.lock().unwrap() = Instant::now();
        };
        output.flush().await?;
        output.shutdown().await?;
        if let Some(error) = failure {
            return Err(error);
        }
        if *upload.received.lock().unwrap() < size {
            return Ok(upload.received());
        }
        exclusive(fs, &upload.destination).await?;
        fs.rename(&upload.partial, &upload.destination, false)
            .await?;
        *complete = true;
        Ok(upload.completed())
    }
}
/// Uploads never overwrite an existing file.
async fn exclusive(fs: &FileSystem, file: &str) -> Result<()> {
    match fs.metadata(file, false).await {
        Err(error) if error.status == 404 => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(Error::new(
            "A file with that name already exists. Rename your file before uploading.",
            409,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_uploads_have_a_bounded_retry_window_and_busy_writes_do_not_expire() {
        let now = Instant::now();
        let upload = Upload {
            fs: FileSystem::default(),
            partial: String::new(),
            destination: String::new(),
            name: "file".into(),
            size: 1,
            received: Mutex::new(1),
            writer: tokio::sync::Mutex::new(true),
            current: Default::default(),
            touched: Mutex::new(now),
        };
        assert!(!upload.idle(now + COMPLETED - Duration::from_secs(1)));
        assert!(upload.idle(now + COMPLETED));
        let mut complete = upload.writer.try_lock().unwrap();
        assert!(!upload.idle(now + IDLE));
        *complete = false;
        drop(complete);
        assert!(!upload.idle(now + COMPLETED));
        assert!(upload.idle(now + IDLE));
    }
}
