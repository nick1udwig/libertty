//! Event reduction and version-checked machine documents.
use crate::{
    client::{Client, Error, Notifications},
    document::Document,
    protocol::{Event, Notification, Snapshot, Terminal},
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{collections::BTreeMap, time::Duration};
#[derive(Clone, Debug)]
pub struct Slot {
    pub document: Option<Document>,
    pub version: u64,
    pub error: Option<String>,
}
#[derive(Debug)]
pub enum WriteOutcome {
    Written,
    Conflict,
    Unavailable(String),
}
pub struct Session {
    pub client: Client,
    pub documents: BTreeMap<String, Slot>,
    pub terminals: BTreeMap<crate::view::Identity, Terminal>,
    records: BTreeMap<String, Terminal>,
    machines: BTreeMap<String, String>,
    available_machines: std::collections::BTreeSet<String>,
    pub sequence: u64,
    events: Notifications,
    pending: Option<Notification>,
    pub deadline: Duration,
}
impl Session {
    pub async fn connect(
        client: Client,
        machines: impl IntoIterator<Item = String>,
        deadline: Duration,
    ) -> Result<Self, Error> {
        let (snapshot, events) = client.subscribe(deadline).await?;
        let mut session = Self {
            client,
            documents: BTreeMap::new(),
            terminals: BTreeMap::new(),
            records: BTreeMap::new(),
            machines: BTreeMap::new(),
            available_machines: std::collections::BTreeSet::new(),
            sequence: 0,
            events: Notifications::new(events),
            pending: None,
            deadline,
        };
        let machines = machines.into_iter().collect::<Vec<_>>();
        for machine in &machines {
            session.documents.insert(
                machine.clone(),
                Slot {
                    document: None,
                    version: 0,
                    error: None,
                },
            );
        }
        session.refresh_machines().await?;
        session.snapshot(&snapshot)?;
        for machine in machines {
            session.refresh(&machine).await;
        }
        Ok(session)
    }
    pub fn snapshot(&mut self, snapshot: &Snapshot) -> Result<(), Error> {
        let mut terminals = snapshot
            .terminals
            .iter()
            .map(|record| (record.address.clone(), record.clone()))
            .collect::<BTreeMap<_, _>>();
        for (machine, slot) in &mut self.documents {
            if machine.is_empty() {
                continue;
            }
            let available = self.available_machines.contains(machine);
            if !available {
                slot.document = None;
                slot.error = Some("remote snapshot unavailable".into());
                for (address, record) in &self.records {
                    if address.starts_with(&format!("{machine}/")) {
                        terminals
                            .entry(address.clone())
                            .or_insert_with(|| record.clone());
                    }
                }
            }
        }
        self.sequence = snapshot.seq;
        self.records = terminals;
        let core = self.client.core_id();
        if !core.is_empty() {
            self.machines.insert(String::new(), core.into());
        }
        for machine in &snapshot.machines {
            self.machines
                .insert(machine.name.clone(), machine.id.clone());
        }
        self.project();
        Ok(())
    }
    async fn refresh_machines(&mut self) -> Result<(), Error> {
        self.available_machines.clear();
        if !self.client.supports("machine.list") {
            return Ok(());
        }
        let mut identities_changed = false;
        for machine in self.client.machine_list(self.deadline).await?.machines {
            identities_changed |= self.machines.get(&machine.name) != Some(&machine.id);
            self.machines
                .insert(machine.name.clone(), machine.id.clone());
            if machine.connected() {
                self.available_machines.insert(machine.name);
            }
        }
        if identities_changed {
            self.project();
        }
        Ok(())
    }
    pub async fn poll_availability(&mut self) -> Result<bool, Error> {
        self.refresh_machines().await?;
        let mut changed = false;
        for name in self
            .documents
            .keys()
            .filter(|n| !n.is_empty())
            .cloned()
            .collect::<Vec<_>>()
        {
            if !self.available_machines.contains(&name) {
                let slot = self.documents.get_mut(&name).unwrap();
                changed |= slot.document.take().is_some();
                slot.error = Some("Remote machine unavailable".into());
            } else if self.documents[&name].document.is_none() {
                self.refresh(&name).await;
                changed = true;
            }
        }
        Ok(changed)
    }
    fn terminal_identity(&self, address: &str) -> Option<crate::view::Identity> {
        let (machine, local) = address.split_once('/').unwrap_or(("", address));
        self.machines
            .get(machine)
            .map(|core| crate::view::Identity {
                core: core.clone(),
                local: local.into(),
            })
    }
    fn project(&mut self) {
        self.terminals = self
            .records
            .iter()
            .filter_map(|(address, record)| {
                self.terminal_identity(address)
                    .map(|identity| (identity, record.clone()))
            })
            .collect();
    }
    fn project_terminal(&mut self, address: &str) {
        let Some(identity) = self.terminal_identity(address) else {
            return;
        };
        let record = self
            .machines
            .iter()
            .filter(|(_, core)| **core == identity.core)
            .filter_map(|(machine, _)| {
                let address = crate::commands::qualify(&identity.local, machine);
                self.records.get_key_value(&address)
            })
            .max_by_key(|(address, _)| *address)
            .map(|(_, record)| record);
        if let Some(record) = record {
            self.terminals.insert(identity, record.clone());
        } else {
            self.terminals.remove(&identity);
        }
    }
    pub async fn reconnect(&mut self, client: Client) -> Result<(), Error> {
        let machines = self.documents.keys().cloned().collect::<Vec<_>>();
        for slot in self.documents.values_mut() {
            slot.document = None;
            slot.error = Some("reconnecting".into());
        }
        let replacement = Self::connect(client, machines, self.deadline).await?;
        *self = replacement;
        Ok(())
    }
    pub async fn refresh(&mut self, machine: &str) {
        let result = self
            .client
            .doc_get(DOCUMENT, on(machine), self.deadline)
            .await;
        let slot = match result {
            Ok(v) => match Document::decode(v.value) {
                Ok(document) => Slot {
                    document: Some(document),
                    version: v.version,
                    error: None,
                },
                Err(_) => Slot {
                    document: None,
                    version: 0,
                    error: Some("undecodable document".into()),
                },
            },
            Err(e) => Slot {
                document: None,
                version: 0,
                error: Some(e.to_string()),
            },
        };
        self.documents.insert(machine.into(), slot);
    }
    pub async fn refresh_all(&mut self) {
        for machine in self.documents.keys().cloned().collect::<Vec<_>>() {
            self.refresh(&machine).await;
        }
    }
    pub async fn write(&mut self, machine: &str, document: Document) -> WriteOutcome {
        let Some(slot) = self.documents.get(machine).filter(|s| s.document.is_some()) else {
            return WriteOutcome::Unavailable("document unavailable".into());
        };
        let result = self
            .client
            .doc_set(
                DOCUMENT,
                on(machine),
                document.value(),
                slot.version,
                self.deadline,
            )
            .await;
        match result {
            Ok(version) => {
                self.documents.insert(
                    machine.into(),
                    Slot {
                        document: Some(document),
                        version,
                        error: None,
                    },
                );
                WriteOutcome::Written
            }
            Err(e) => {
                let conflict = e.kind() == Some("conflict");
                self.refresh(machine).await;
                if conflict {
                    WriteOutcome::Conflict
                } else {
                    WriteOutcome::Unavailable(e.to_string())
                }
            }
        }
    }
    /// The next notification, already applied to records and documents.
    pub async fn next(&mut self) -> Result<Notification, Error> {
        if self.pending.is_none() {
            let value = match self.events.next().await {
                Ok(Some(value)) => value,
                other => {
                    let error = match other {
                        Err(error) => error,
                        _ => Error::Disconnected,
                    };
                    self.invalidate_all(&error.to_string());
                    return Err(error);
                }
            };
            let notification = Notification::decode(value)?;
            match &notification {
                Notification::Missed(_) => self.invalidate_all("refresh required"),
                Notification::Event(event)
                    if event.document() == Some(DOCUMENT) && event.seq > self.sequence =>
                {
                    if let Some(slot) = self
                        .documents
                        .get_mut(event.machine.as_deref().unwrap_or(""))
                    {
                        slot.document = None;
                        slot.error = Some("refresh required".into());
                    }
                }
                _ => (),
            }
            self.pending = Some(notification);
        }
        let notification = self.pending.clone().unwrap();
        match &notification {
            Notification::Heartbeat { .. } => {
                self.poll_availability().await?;
            }
            Notification::Missed(snapshot) => {
                self.refresh_machines().await?;
                self.snapshot(snapshot)?;
                self.refresh_all().await;
            }
            Notification::Event(event) if event.seq > self.sequence => {
                if event.seq != self.sequence + 1 {
                    self.reconnect(self.client.clone()).await?;
                } else {
                    if event.document() == Some(DOCUMENT) {
                        self.refresh(event.machine.as_deref().unwrap_or("")).await;
                    } else {
                        reduce(&mut self.records, event);
                        if let Some(address) = event.terminal.as_deref() {
                            self.project_terminal(address);
                        }
                    }
                    self.sequence = event.seq;
                }
            }
            _ => (),
        }
        self.pending = None;
        Ok(notification)
    }
    fn invalidate_all(&mut self, reason: &str) {
        for slot in self.documents.values_mut() {
            slot.document = None;
            slot.error = Some(reason.into());
        }
    }
    /// Borrow the current document without copying its JSON tree.
    pub fn document_ref(&self, machine: &str) -> Result<&Document, Error> {
        self.documents
            .get(machine)
            .and_then(|s| s.document.as_ref())
            .ok_or_else(|| Error::Protocol("document unavailable".into()))
    }
    /// Copy the current document for an independent edit.
    pub fn document(&self, machine: &str) -> Result<Document, Error> {
        self.document_ref(machine).cloned()
    }
}
/// The app's shared workspace document name.
pub const DOCUMENT: &str = "herdr-app";
pub fn on(machine: &str) -> Option<&str> {
    (!machine.is_empty()).then_some(machine)
}
/// Applies one event to terminal records as core's event table describes.
pub fn reduce(terminals: &mut BTreeMap<String, Terminal>, event: &Event) {
    let Some(address) = event.terminal.as_deref() else {
        return;
    };
    let data = &event.data;
    fn field<T: DeserializeOwned + Default>(data: &Value, key: &str) -> T {
        serde_json::from_value(data[key].clone()).unwrap_or_default()
    }
    match event.kind.as_str() {
        "created" | "restarted" => {
            if let Ok(record) = serde_json::from_value(data.clone()) {
                terminals.insert(address.into(), record);
            }
        }
        "removed" => {
            terminals.remove(address);
        }
        "labels" if !terminals.contains_key(address) => {
            if let Ok(record) = serde_json::from_value(data["record"].clone()) {
                terminals.insert(address.into(), record);
            }
        }
        kind => {
            let Some(record) = terminals.get_mut(address) else {
                return;
            };
            match kind {
                "foreground" => record.foreground = serde_json::from_value(data.clone()).ok(),
                "status" => {
                    record.status = field(data, "status");
                    record.records = field(data, "records");
                    record.reported = field(data, "reported");
                }
                "turn" => record.turn = field(data, "turn"),
                "title" => record.title = field(data, "title"),
                "labels" => record.labels = field(data, "labels"),
                "keep" => record.keep = field(data, "keep"),
                "size" => {
                    record.cols = field(data, "cols");
                    record.rows = field(data, "rows");
                }
                "finished" | "lost" => {
                    record.reason = field(data, "reason");
                    record.exit_code = field(data, "exit_code");
                    record.signal = field(data, "signal");
                    record.finished_ms = field(data, "finished_ms");
                    record.foreground = None;
                    if kind == "finished" {
                        record.state = "finished".into();
                    } else {
                        record.pid = None;
                    }
                }
                _ => (),
            }
        }
    }
}
