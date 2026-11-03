//! Workspace operations with explicit partial outcomes; never blind side-effect retries.
use crate::{
    client::Error,
    document::{Axis, Document, terminal_pane},
    protocol::{ListParams, RunParams, Terminal},
    sync::{Session, WriteOutcome, on},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Launch {
    pub argv: Vec<String>,
    pub line: Option<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
}
#[derive(Clone, Debug)]
pub enum Placement {
    Space {
        id: String,
        name: String,
        tab: String,
        pane: String,
    },
    Tab {
        space: String,
        /// The viewer's selected tab; the new one goes after it, else at the end.
        after: Option<String>,
        id: String,
        name: String,
        pane: String,
    },
    Split {
        space: String,
        tab: String,
        target: String,
        container: String,
        pane: String,
        axis: Axis,
    },
}
impl Placement {
    fn ids(&self) -> (&str, &str, &str) {
        match self {
            Self::Space { id, tab, pane, .. } => (id, tab, pane),
            Self::Tab {
                space, id, pane, ..
            } => (space, id, pane),
            Self::Split {
                space, tab, pane, ..
            } => (space, tab, pane),
        }
    }
    pub fn apply(
        &self,
        d: &mut Document,
        address: &str,
        folder: &str,
    ) -> Result<(), crate::document::Error> {
        let mut candidate = d.clone();
        let result = match self {
            Self::Space {
                id,
                name,
                tab,
                pane,
            } => {
                candidate.create_space(id, name, folder)?;
                candidate.create_tab(id, tab, "", terminal_pane(pane, address))
            }
            Self::Tab {
                space,
                after,
                id,
                name,
                pane,
            } => candidate.create_tab_after(
                space,
                after.as_deref(),
                id,
                name,
                terminal_pane(pane, address),
            ),
            Self::Split {
                target,
                container,
                pane,
                axis,
                space,
                tab,
            } => {
                if candidate.location(target) != Some((space.clone(), tab.clone())) {
                    return Err(crate::document::Error::InvalidTarget);
                }
                candidate.split(target, container, *axis, terminal_pane(pane, address))
            }
        };
        result?;
        *d = candidate;
        Ok(())
    }
}
#[derive(Debug)]
pub struct Creation {
    pub correlation: String,
    pub terminal: Option<Terminal>,
    pub layout: WriteOutcome,
}
impl Session {
    pub async fn edit(
        &mut self,
        machine: &str,
        operation: impl FnOnce(&mut Document) -> Result<(), crate::document::Error>,
    ) -> Result<WriteOutcome, Error> {
        let mut document = self.document(machine)?;
        operation(&mut document)?;
        Ok(self.write(machine, document).await)
    }
    pub async fn create(
        &mut self,
        machine: &str,
        placement: Placement,
        launch: Launch,
        correlation: String,
    ) -> Result<Creation, Error> {
        if correlation.is_empty() {
            return Err(Error::Protocol("correlation required".into()));
        }
        let existing = self.find_operation(&correlation).await?;
        if !existing.is_empty() {
            return Ok(Creation {
                correlation,
                terminal: existing.into_iter().next(),
                layout: WriteOutcome::Unavailable(
                    "operation already exists; reconcile placement".into(),
                ),
            });
        }
        let mut candidate = self.document(machine)?;
        placement.apply(
            &mut candidate,
            "__pending",
            launch.cwd.as_deref().unwrap_or(""),
        )?;
        let (space, tab, _) = placement.ids();
        let params = RunParams {
            argv: launch.argv,
            line: launch.line,
            cwd: launch.cwd.clone(),
            on: on(machine).map(str::to_owned),
            env: launch.env,
            labels: BTreeMap::from([
                (SPACE_LABEL.into(), space.into()),
                (TAB_LABEL.into(), tab.into()),
                (OPERATION_LABEL.into(), correlation.clone()),
            ]),
            no_parent: true,
            keep: true,
            ..Default::default()
        };
        let result = self.client.terminal_run(&params, self.deadline).await;
        let terminal = match result {
            Ok(v) => v,
            Err(e) => {
                return Ok(Creation {
                    correlation,
                    terminal: None,
                    layout: WriteOutcome::Unavailable(format!(
                        "spawn outcome: {e}; reconcile correlation before another spawn"
                    )),
                });
            }
        };
        let prepared = (|| {
            let local = local_address(&terminal.address, machine)?;
            let mut document = self.document(machine)?;
            placement.apply(&mut document, local, launch.cwd.as_deref().unwrap_or(""))?;
            Ok::<_, Error>(document)
        })();
        let layout = match prepared {
            Ok(document) => self.write(machine, document).await,
            Err(error) => WriteOutcome::Unavailable(error.to_string()),
        };
        Ok(Creation {
            correlation,
            terminal: Some(terminal),
            layout,
        })
    }
    pub async fn find_operation(&self, correlation: &str) -> Result<Vec<Terminal>, Error> {
        let params = ListParams {
            all: true,
            labels: BTreeMap::from([(OPERATION_LABEL.into(), correlation.into())]),
        };
        Ok(self
            .client
            .terminal_list(&params, self.deadline)
            .await?
            .terminals
            .into_iter()
            .filter(|t| t.label(OPERATION_LABEL) == Some(correlation))
            .collect())
    }
    pub async fn adopt(
        &mut self,
        machine: &str,
        placement: Placement,
        address: &str,
    ) -> Result<ChangeOutcome, Error> {
        let local = local_address(address, machine)?;
        let mut document = self.document(machine)?;
        if terminal_addresses(document.value())
            .iter()
            .any(|a| a == local)
        {
            return Err(Error::Protocol("terminal already placed".into()));
        }
        placement.apply(&mut document, local, "")?;
        let (space, tab, _) = placement.ids();
        self.client.terminal_get(address, self.deadline).await?;
        Ok(self
            .change_terminal(
                machine,
                document,
                Some(address.to_owned()),
                Some(true),
                adoption_labels(space, tab),
            )
            .await)
    }
    pub async fn park(&mut self, machine: &str, pane: &str) -> Result<ChangeOutcome, Error> {
        let mut document = self.document(machine)?;
        let address = document
            .node(pane)
            .and_then(|n| n["content"]["terminal"].as_str())
            .ok_or_else(|| Error::Protocol("not a terminal pane".into()))?
            .to_owned();
        document.remove(pane)?;
        let address = qualify(&address, machine);
        Ok(self
            .change_terminal(
                machine,
                document,
                Some(address),
                Some(false),
                adoption_labels("", ""),
            )
            .await)
    }
}
/// The app's adoption labels: the space and tab a terminal belongs in.
pub const SPACE_LABEL: &str = "herdr.space";
pub const TAB_LABEL: &str = "herdr.tab";
/// Correlates a creation with its terminal after an uncertain outcome.
pub const OPERATION_LABEL: &str = "herdr.client.operation";
fn adoption_labels(space: &str, tab: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        (SPACE_LABEL.into(), space.into()),
        (TAB_LABEL.into(), tab.into()),
    ])
}
pub fn qualify(address: &str, machine: &str) -> String {
    if machine.is_empty() {
        address.into()
    } else {
        format!("{machine}/{address}")
    }
}
pub fn local_address<'a>(address: &'a str, machine: &str) -> Result<&'a str, Error> {
    if machine.is_empty() {
        if address.contains('/') {
            return Err(Error::Protocol("machine mismatch".into()));
        }
        Ok(address)
    } else {
        address
            .strip_prefix(machine)
            .and_then(|s| s.strip_prefix('/'))
            .filter(|s| !s.contains('/'))
            .ok_or_else(|| Error::Protocol("machine mismatch".into()))
    }
}
pub fn terminal_addresses(value: &Value) -> Vec<String> {
    let mut addresses = Vec::new();
    collect(value, &mut addresses);
    addresses
}
fn collect(value: &Value, addresses: &mut Vec<String>) {
    if let Some(address) = value["content"]["terminal"]
        .as_str()
        .filter(|_| value["type"] == "block")
    {
        addresses.push(address.into());
    }
    for key in ["spaces", "tabs", "children"] {
        if let Some(a) = value.get(key).and_then(Value::as_array) {
            for item in a {
                collect(item, addresses);
            }
        }
    }
    // Terminals floating over a node are shown too.
    for float in value["floating"].as_array().into_iter().flatten() {
        if let Some(address) = float["content"]["terminal"].as_str() {
            addresses.push(address.into());
        }
    }
    if let Some(root) = value.get("root") {
        collect(root, addresses);
    }
}
#[derive(Clone, Debug)]
pub struct CloseAssessment {
    pub machine: String,
    pub target: String,
    pub version: u64,
    pub terminals: Vec<Terminal>,
    pub protected: Vec<String>,
}
#[derive(Debug)]
pub struct CloseOutcome {
    pub observed: Vec<Terminal>,
    pub layout: WriteOutcome,
}
impl Session {
    pub async fn assess_close(
        &mut self,
        machine: &str,
        target: &str,
    ) -> Result<CloseAssessment, Error> {
        self.refresh(machine).await;
        let document = self.document_ref(machine)?;
        let node = document
            .node(target)
            .ok_or_else(|| Error::Protocol("close target missing".into()))?;
        let mut addresses = terminal_addresses(node)
            .into_iter()
            .map(|a| qualify(&a, machine))
            .collect::<Vec<_>>();
        let records = self
            .client
            .terminal_list(&ListParams::default(), self.deadline)
            .await?
            .terminals;
        let mut protected = Vec::new();
        let mut i = 0;
        while i < addresses.len() {
            for record in &records {
                if record.parent.as_deref() == Some(addresses[i].as_str()) {
                    let address = &record.address;
                    if record.label(SPACE_LABEL).is_some() {
                        if record.die_with_parent && !addresses.contains(address) {
                            protected.push(address.clone());
                        }
                    } else if !addresses.contains(address) {
                        addresses.push(address.clone());
                    }
                }
            }
            i += 1;
        }
        let terminals = records
            .into_iter()
            .filter(|r| addresses.contains(&r.address))
            .collect();
        Ok(CloseAssessment {
            machine: machine.into(),
            target: target.into(),
            version: self.documents[machine].version,
            terminals,
            protected,
        })
    }
    pub async fn close(&mut self, assessment: CloseAssessment) -> Result<CloseOutcome, Error> {
        let current = self
            .assess_close(&assessment.machine, &assessment.target)
            .await?;
        if current.version != assessment.version
            || !current.protected.is_empty()
            || close_facts(&current.terminals) != close_facts(&assessment.terminals)
        {
            return Ok(CloseOutcome {
                observed: Vec::new(),
                layout: WriteOutcome::Conflict,
            });
        }
        let mut document = self.document(&assessment.machine)?;
        document.remove(&assessment.target)?;
        let mut observed = Vec::new();
        for terminal in current.terminals.iter().rev() {
            match self
                .client
                .terminal_kill(&terminal.address, self.deadline)
                .await
            {
                Ok(result) => observed.push(result),
                Err(e) => {
                    return Ok(CloseOutcome {
                        observed,
                        layout: WriteOutcome::Unavailable(e.to_string()),
                    });
                }
            }
        }
        Ok(CloseOutcome {
            observed,
            layout: self.write(&assessment.machine, document).await,
        })
    }
}
type CloseFacts<'a> = (
    &'a str,
    Option<&'a str>,
    &'a BTreeMap<String, String>,
    &'a str,
    Option<u32>,
);
fn close_facts(records: &[Terminal]) -> Vec<CloseFacts<'_>> {
    records
        .iter()
        .map(|r| {
            (
                r.address.as_str(),
                r.parent.as_deref(),
                &r.labels,
                r.state.as_str(),
                r.pid,
            )
        })
        .collect()
}
impl Session {
    pub async fn reconcile_creation(
        &mut self,
        machine: &str,
        placement: Placement,
        correlation: &str,
    ) -> Result<Creation, Error> {
        self.refresh(machine).await;
        let matches = self.find_operation(correlation).await?;
        if matches.len() != 1 {
            return Ok(Creation {
                correlation: correlation.into(),
                terminal: None,
                layout: WriteOutcome::Unavailable(
                    "operation not uniquely observed; do not respawn".into(),
                ),
            });
        }
        let terminal = matches.into_iter().next().unwrap();
        let local = local_address(&terminal.address, machine)?;
        let mut document = self.document(machine)?;
        let layout = if terminal_addresses(document.value())
            .iter()
            .any(|a| a == local)
        {
            WriteOutcome::Written
        } else {
            let (space, tab, _) = placement.ids();
            if terminal.label(SPACE_LABEL) != Some(space) || terminal.label(TAB_LABEL) != Some(tab)
            {
                WriteOutcome::Conflict
            } else {
                match placement.apply(&mut document, local, &terminal.cwd) {
                    Ok(()) => self.write(machine, document).await,
                    Err(e) => WriteOutcome::Unavailable(e.to_string()),
                }
            }
        };
        Ok(Creation {
            correlation: correlation.into(),
            terminal: Some(terminal),
            layout,
        })
    }
}
impl Session {
    pub async fn move_pane(
        &mut self,
        machine: &str,
        pane: &str,
        destination: &str,
        index: usize,
    ) -> Result<ChangeOutcome, Error> {
        let mut document = self.document(machine)?;
        let address = document
            .node(pane)
            .and_then(|n| n["content"]["terminal"].as_str())
            .map(str::to_owned);
        let (space, tab) = document
            .location(destination)
            .ok_or_else(|| Error::Protocol("destination missing".into()))?;
        document.move_pane(pane, destination, index)?;
        Ok(self
            .change_terminal(
                machine,
                document,
                address.map(|a| qualify(&a, machine)),
                None,
                adoption_labels(&space, &tab),
            )
            .await)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectKind {
    Keep,
    Labels,
}
#[derive(Debug)]
pub struct Effect {
    pub kind: EffectKind,
    /// The terminal as core reported it after this step.
    pub result: Terminal,
}
#[derive(Debug)]
pub struct StepFailure {
    pub kind: EffectKind,
    pub error: Error,
}
#[derive(Debug)]
pub struct ChangeOutcome {
    pub terminal: Option<String>,
    pub effects: Vec<Effect>,
    pub failure: Option<StepFailure>,
    pub layout: Option<WriteOutcome>,
}
impl Session {
    async fn change_terminal(
        &mut self,
        machine: &str,
        document: Document,
        address: Option<String>,
        keep: Option<bool>,
        labels: BTreeMap<String, String>,
    ) -> ChangeOutcome {
        let mut outcome = ChangeOutcome {
            terminal: address.clone(),
            effects: Vec::new(),
            failure: None,
            layout: None,
        };
        if let Some(address) = address {
            let mut steps = Vec::new();
            if keep.is_some() {
                steps.push(EffectKind::Keep);
            }
            steps.push(EffectKind::Labels);
            for kind in steps {
                let result = match kind {
                    EffectKind::Keep => {
                        self.client
                            .terminal_keep(&address, keep.unwrap(), self.deadline)
                            .await
                    }
                    EffectKind::Labels => {
                        self.client
                            .terminal_label(&address, &labels, self.deadline)
                            .await
                    }
                };
                match result {
                    Ok(result) => outcome.effects.push(Effect { kind, result }),
                    Err(error) => {
                        outcome.failure = Some(StepFailure { kind, error });
                        return outcome;
                    }
                }
            }
        }
        outcome.layout = Some(self.write(machine, document).await);
        outcome
    }
}

#[derive(Debug)]
pub struct PlacementOutcome {
    pub terminal: String,
    pub result: Result<WriteOutcome, Error>,
}

impl Session {
    /// Remove panes for confirmed finished terminals in one version-checked edit.
    /// Missing records and lost live terminals are not evidence of an exit.
    /// Call after connecting and processing notifications; retry conflicts from the refreshed document.
    pub async fn reconcile_finished(
        &mut self,
        machine: &str,
    ) -> Result<Option<WriteOutcome>, Error> {
        let mut document = self.document(machine)?;
        let finished = self
            .terminals
            .values()
            .filter(|record| record.state == "finished")
            .map(|record| record.address.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let panes = crate::model::places(&document, machine)
            .into_iter()
            .filter(|(address, _)| finished.contains(address.as_str()))
            .map(|(_, place)| place.pane)
            .collect::<Vec<_>>();
        if panes.is_empty() {
            return Ok(None);
        }
        for pane in panes {
            document.remove(&pane)?;
        }
        Ok(Some(self.write(machine, document).await))
    }

    /// Recover labeled terminals independently without launching or terminating a process.
    pub async fn reconcile_placements(&mut self) -> Vec<PlacementOutcome> {
        let records = self.terminals.values().cloned().collect::<Vec<_>>();
        let mut outcomes = Vec::new();
        for record in records {
            let result = match self.reconcile_placement(&record).await {
                Ok(Some(outcome)) => Ok(outcome),
                Ok(None) => continue,
                Err(error) => Err(error),
            };
            outcomes.push(PlacementOutcome {
                terminal: record.address.clone(),
                result,
            });
        }
        outcomes
    }

    async fn reconcile_placement(
        &mut self,
        record: &Terminal,
    ) -> Result<Option<WriteOutcome>, Error> {
        if !record.is_live() {
            return Ok(None);
        }
        let address = record.address.as_str();
        let (machine, local) = address.split_once('/').unwrap_or(("", address));
        let Some(space) = record.label(SPACE_LABEL) else {
            return Ok(None);
        };
        let labeled_tab = record.label(TAB_LABEL);
        let Ok(mut document) = self.document(machine) else {
            return Ok(None);
        };
        if terminal_addresses(document.value())
            .iter()
            .any(|a| a == local)
        {
            return Ok(None);
        }
        let current = self.client.terminal_get(address, self.deadline).await?;
        if !current.is_live()
            || current.label(SPACE_LABEL) != Some(space)
            || current.label(TAB_LABEL) != labeled_tab
        {
            return Ok(None);
        }
        let generated_tab = fresh_recovery_id(&document, &format!("recovered-tab-{local}"));
        let tab = labeled_tab.unwrap_or(&generated_tab);
        let pane = fresh_recovery_id(&document, &format!("recovered-{local}"));
        let placement = if !document.contains(space) {
            Placement::Space {
                id: space.into(),
                name: String::new(),
                tab: tab.into(),
                pane,
            }
        } else if !document.contains(tab) {
            Placement::Tab {
                space: space.into(),
                after: None,
                id: tab.into(),
                name: String::new(),
                pane,
            }
        } else {
            let target = document
                .node(tab)
                .and_then(|t| last_block(&t["root"]))
                .ok_or_else(|| Error::Protocol("adoption tab has no supported pane".into()))?;
            Placement::Split {
                space: space.into(),
                tab: tab.into(),
                target: target.into(),
                container: fresh_recovery_id(&document, &format!("recovered-split-{local}")),
                pane,
                axis: Axis::Row,
            }
        };
        placement.apply(&mut document, local, current.folder().unwrap_or(""))?;
        if !current.keep {
            self.client
                .terminal_keep(address, true, self.deadline)
                .await?;
        }
        Ok(Some(self.write(machine, document).await))
    }
}

fn fresh_recovery_id(document: &Document, base: &str) -> String {
    let mut id = base.to_owned();
    while document.contains(&id) {
        id.push('_');
    }
    id
}

fn last_block(node: &Value) -> Option<&str> {
    if node["type"] == "block" {
        node["id"].as_str()
    } else {
        node["children"]
            .as_array()?
            .iter()
            .rev()
            .find_map(last_block)
    }
}

pub fn launch_source(
    document: &Document,
    placement: &Placement,
) -> (Option<String>, Option<String>) {
    match placement {
        Placement::Split { space, target, .. } => (
            Some(space.clone()),
            document
                .node(target)
                .and_then(|n| n["content"]["terminal"].as_str())
                .map(str::to_owned),
        ),
        Placement::Tab { space, .. } => (Some(space.clone()), None),
        Placement::Space { .. } => (None, None),
    }
}

impl Session {
    pub async fn launch_directory(
        &self,
        machine: &str,
        placement: &Placement,
        explicit: Option<&str>,
    ) -> Result<Option<String>, Error> {
        if let Some(path) = explicit {
            return Ok(Some(path.into()));
        }
        let document = self.document_ref(machine)?;
        let (space, terminal) = launch_source(document, placement);
        if let Some(terminal) = terminal {
            let record = self
                .client
                .terminal_get(&qualify(&terminal, machine), self.deadline)
                .await?;
            if let Some(path) = record.folder() {
                return Ok(Some(path.into()));
            }
        }
        Ok(space.and_then(|id| {
            document
                .node(&id)
                .and_then(|s| s["folder"].as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        }))
    }
}
