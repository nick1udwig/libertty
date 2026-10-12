use crate::{markers::Event, storage};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub id: String,
    pub action: String,
    pub path: String,
    pub name: String,
}
struct Entry {
    request: Request,
    capture: bool,
    pending: bool,
    until: Instant,
}
pub struct Transfers {
    entries: VecDeque<Entry>,
    cleanup: Arc<dyn Fn(String) + Send + Sync>,
}
impl Default for Transfers {
    fn default() -> Self {
        Self::new(Arc::new(|path| {
            let _ = std::fs::remove_file(path);
        }))
    }
}
impl Transfers {
    pub fn new(cleanup: Arc<dyn Fn(String) + Send + Sync>) -> Self {
        Self {
            entries: VecDeque::new(),
            cleanup,
        }
    }
    fn cleanup(&self, entry: Entry) {
        if entry.capture {
            (self.cleanup)(entry.request.path);
        }
    }
    pub fn expire(&mut self) {
        let mut at = 0;
        while at < self.entries.len() {
            if self.entries[at].until < Instant::now() {
                let entry = self.entries.remove(at).unwrap();
                self.cleanup(entry);
            } else {
                at += 1
            }
        }
    }
    pub fn add(&mut self, event: Event, directory: &str) -> Request {
        self.expire();
        while self.entries.len() >= 16 {
            let entry = self.entries.pop_front().unwrap();
            self.cleanup(entry);
        }
        let (action, path, name, capture) = match event {
            Event::TransferUpload { path } => ("upload", path, None, false),
            Event::TransferDownload { path } => ("download", path, None, false),
            Event::TransferCapture { file, name } => (
                "download",
                termai_engine::path::join(&[directory, &file]),
                Some(name),
                true,
            ),
            _ => unreachable!("private transfer marker"),
        };
        let request = Request {
            id: storage::random_hex(16),
            action: action.into(),
            name: name.unwrap_or_else(|| termai_engine::path::basename(&path)),
            path,
        };
        self.entries.push_back(Entry {
            request: request.clone(),
            capture,
            pending: true,
            until: Instant::now() + Duration::from_secs(15 * 60),
        });
        request
    }
    pub fn get(&mut self, id: &str) -> Option<Request> {
        self.expire();
        self.entries
            .iter()
            .find(|e| e.request.id == id)
            .map(|e| e.request.clone())
    }
    pub fn acknowledge(&mut self, id: &str) {
        if let Some(e) = self.entries.iter_mut().find(|e| e.request.id == id) {
            e.pending = false
        }
    }
    pub fn pending(&mut self) -> Vec<Request> {
        self.expire();
        self.entries
            .iter()
            .filter(|e| e.pending)
            .map(|e| e.request.clone())
            .collect()
    }
    pub fn remove(&mut self, id: &str) {
        if let Some(at) = self.entries.iter().position(|e| e.request.id == id) {
            let entry = self.entries.remove(at).unwrap();
            self.cleanup(entry);
        }
    }
    pub fn clear(&mut self) {
        while let Some(entry) = self.entries.pop_front() {
            self.cleanup(entry);
        }
    }
}
impl Drop for Transfers {
    fn drop(&mut self) {
        self.clear()
    }
}
