//! Lossless machine-local app documents. Unknown fields remain untouched.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Document(Value);

impl<'de> Deserialize<'de> for Document {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::decode(Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Malformed(String),
    Missing(String),
    Duplicate(String),
    Unsupported(String),
    InvalidTarget,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(what) => write!(f, "malformed workspace document: {what}"),
            Self::Missing(id) => write!(f, "{id} is no longer in the workspace"),
            Self::Duplicate(id) => write!(f, "{id} already exists in the workspace"),
            Self::Unsupported(what) => write!(f, "unsupported workspace content: {what}"),
            Self::InvalidTarget => f.write_str("invalid target for this change"),
        }
    }
}
impl std::error::Error for Error {}

impl Default for Document {
    fn default() -> Self {
        Self(json!({"spaces":[]}))
    }
}
impl Document {
    pub fn decode(value: Value) -> Result<Self, Error> {
        let result = if value.is_null() {
            Self::default()
        } else {
            Self(value)
        };
        result.validate()?;
        Ok(result)
    }
    pub fn value(&self) -> &Value {
        &self.0
    }
    pub fn contains(&self, id: &str) -> bool {
        find(&self.0, id).is_some()
    }
    pub fn node(&self, id: &str) -> Option<&Value> {
        find(&self.0, id)
    }
    pub fn location(&self, id: &str) -> Option<(String, String)> {
        for space in self.0["spaces"].as_array()? {
            for tab in space["tabs"].as_array()? {
                if tab["id"] == id || find(&tab["root"], id).is_some() {
                    return Some((space["id"].as_str()?.into(), tab["id"].as_str()?.into()));
                }
            }
        }
        None
    }
    pub fn validate(&self) -> Result<(), Error> {
        let spaces = self
            .0
            .get("spaces")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::Malformed("spaces".into()))?;
        let mut ids = BTreeSet::new();
        for space in spaces {
            identity(space, &mut ids)?;
            for tab in space
                .get("tabs")
                .and_then(Value::as_array)
                .ok_or_else(|| Error::Malformed("tabs".into()))?
            {
                identity(tab, &mut ids)?;
                let root = tab
                    .get("root")
                    .ok_or_else(|| Error::Malformed("root".into()))?;
                validate_node(root, &mut ids, root["id"] == tab["id"])?;
            }
        }
        Ok(())
    }
    /// Mutations use a candidate copy; failures leave the accepted document intact.
    fn edit(&mut self, op: impl FnOnce(&mut Value) -> Result<(), Error>) -> Result<(), Error> {
        let mut next = self.clone();
        ensure_supported(&next.0)?;
        op(&mut next.0)?;
        next.validate()?;
        *self = next;
        Ok(())
    }
    pub fn rename(&mut self, id: &str, name: &str) -> Result<(), Error> {
        self.edit(|v| {
            target(v, id)?["name"] = json!(name);
            Ok(())
        })
    }
    pub fn create_space(&mut self, id: &str, name: &str, folder: &str) -> Result<(), Error> {
        self.edit(|v| {
            v["spaces"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":id,"name":name,"folder":folder,"tabs":[]}));
            Ok(())
        })
    }
    pub fn create_tab(
        &mut self,
        space: &str,
        id: &str,
        name: &str,
        pane: Value,
    ) -> Result<(), Error> {
        self.create_tab_after(space, None, id, name, pane)
    }
    /// Adds a tab after `after` (the viewer's selected tab), else at the end, as the app does.
    pub fn create_tab_after(
        &mut self,
        space: &str,
        after: Option<&str>,
        id: &str,
        name: &str,
        pane: Value,
    ) -> Result<(), Error> {
        self.edit(|v| {
            let tabs = target(v, space)?["tabs"]
                .as_array_mut()
                .ok_or(Error::InvalidTarget)?;
            let at = after
                .and_then(|a| tabs.iter().position(|t| t["id"] == a))
                .map_or(tabs.len(), |i| i + 1);
            tabs.insert(
                at,
                json!({"id":id,"name":name,"root":{"id":id,"type":"row","children":[pane]}}),
            );
            Ok(())
        })
    }
    /// Sets a node's weight. A pixel size stays as the app stored it.
    pub fn resize(&mut self, id: &str, weight: f64) -> Result<(), Error> {
        if !weight.is_finite() || weight <= 0.0 {
            return Err(Error::InvalidTarget);
        }
        self.edit(|v| {
            let n = target(v, id)?;
            if n.get("type").is_none() {
                return Err(Error::InvalidTarget);
            }
            if n["size"].get("px").is_some() {
                return Err(Error::Unsupported("pixel size".into()));
            }
            n["size"] = json!({"weight":weight});
            Ok(())
        })
    }
    /// Moves the divider between two neighbors: `a` takes `share` (0..1) of their
    /// combined weight and their sum stays, as the app's divider drag does.
    pub fn resize_between(&mut self, a: &str, b: &str, share: f64) -> Result<(), Error> {
        if !share.is_finite() || share <= 0.0 || share >= 1.0 {
            return Err(Error::InvalidTarget);
        }
        self.edit(|v| {
            let (space, tab) = locate(v, a).ok_or_else(|| Error::Missing(a.into()))?;
            let root = tab_root(v, &space, &tab)?;
            let parent = parent_of(root, a).ok_or(Error::InvalidTarget)?;
            if !matches!(parent["type"].as_str(), Some("row" | "column")) {
                return Err(Error::InvalidTarget);
            }
            let children = parent["children"].as_array_mut().unwrap();
            let ia = children.iter().position(|n| n["id"] == a);
            let ib = children.iter().position(|n| n["id"] == b);
            let (Some(ia), Some(ib)) = (ia, ib) else {
                return Err(Error::InvalidTarget);
            };
            if children[ia]["size"].get("px").is_some() || children[ib]["size"].get("px").is_some()
            {
                return Err(Error::Unsupported("pixel size".into()));
            }
            let sum = weight(&children[ia]).unwrap_or(1.0) + weight(&children[ib]).unwrap_or(1.0);
            children[ia]["size"] = json!({"weight":sum * share});
            children[ib]["size"] = json!({"weight":sum * (1.0 - share)});
            Ok(())
        })
    }
    /// Puts `pane` beside block `id` along `axis` (after it). Reuses the parent
    /// if it already runs along that axis, else wraps the target in `container`.
    pub fn split(
        &mut self,
        id: &str,
        container: &str,
        axis: Axis,
        pane: Value,
    ) -> Result<(), Error> {
        self.edit(|v| {
            if target(v, id)?["type"] != "block" {
                return Err(Error::InvalidTarget);
            }
            let (space, tab) = locate(v, id).ok_or_else(|| Error::Missing(id.into()))?;
            let root = tab_root(v, &space, &tab)?;
            let parent = parent_of(root, id).ok_or(Error::InvalidTarget)?;
            let same_axis = parent_axis(parent) == Some(axis.name());
            let children = parent["children"].as_array_mut().unwrap();
            let i = children.iter().position(|n| n["id"] == id).unwrap();
            if same_axis {
                // The new pane takes half of the target's share.
                let share = weight(&children[i]).unwrap_or(1.0);
                if children[i]["size"].get("px").is_none() {
                    children[i]["size"] = json!({"weight":share / 2.0});
                }
                let mut pane = pane;
                pane["size"] = json!({"weight":share / 2.0});
                children.insert(i + 1, pane);
                return Ok(());
            }
            let mut old = children[i].take();
            let size = old.as_object_mut().unwrap().remove("size");
            let mut wrapper = json!({"id":container,"type":axis.name(),"children":[old,pane]});
            if let Some(size) = size {
                wrapper["size"] = size;
            }
            children[i] = wrapper;
            Ok(())
        })
    }
    /// Removes a space, tab, or node. A tab closes with its last pane and a space with its last tab.
    pub fn remove(&mut self, id: &str) -> Result<Value, Error> {
        let mut removed = None;
        self.edit(|v| {
            removed = Some(remove_node(v, id)?);
            Ok(())
        })?;
        Ok(removed.unwrap())
    }
    pub fn reorder(&mut self, id: &str, index: usize) -> Result<(), Error> {
        self.edit(|v| reorder(v, id, index))
    }
    pub fn swap(&mut self, first: &str, second: &str) -> Result<(), Error> {
        if self.location(first).is_none() || self.location(first) != self.location(second) {
            return Err(Error::InvalidTarget);
        }
        if first == second {
            return Ok(());
        }
        self.edit(|v| {
            let mut a = target(v, first)?.clone();
            let mut b = target(v, second)?.clone();
            if a["type"] != "block" || b["type"] != "block" {
                return Err(Error::InvalidTarget);
            }
            let mut temporary = String::from("__swap");
            while find(v, &temporary).is_some() {
                temporary.push('_');
            }
            let size_a = a.as_object_mut().unwrap().remove("size");
            let size_b = b.as_object_mut().unwrap().remove("size");
            if let Some(size) = size_a {
                b["size"] = size;
            }
            if let Some(size) = size_b {
                a["size"] = size;
            }
            b["id"] = json!(temporary);
            *target(v, first)? = b;
            *target(v, second)? = a;
            target(v, &temporary)?["id"] = json!(second);
            Ok(())
        })
    }
    /// Moves a pane into a container or tab at `index`; it starts with an equal share there.
    pub fn move_pane(&mut self, id: &str, destination: &str, index: usize) -> Result<(), Error> {
        self.edit(|v| {
            if target(v, id)?["type"] != "block" {
                return Err(Error::InvalidTarget);
            }
            target(v, destination)?;
            let mut pane = remove_node(v, id)?;
            pane.as_object_mut().unwrap().remove("size");
            let destination = target(v, destination)?;
            let destination = if destination.get("root").is_some() {
                destination.get_mut("root").unwrap()
            } else {
                destination
            };
            let children = destination["children"]
                .as_array_mut()
                .ok_or(Error::InvalidTarget)?;
            if index > children.len() {
                return Err(Error::InvalidTarget);
            }
            children.insert(index, pane);
            Ok(())
        })
    }
}
#[derive(Clone, Copy, Debug)]
pub enum Axis {
    Row,
    Column,
}
impl Axis {
    fn name(self) -> &'static str {
        match self {
            Self::Row => "row",
            Self::Column => "column",
        }
    }
}
pub fn terminal_pane(id: &str, terminal: &str) -> Value {
    json!({"id":id,"type":"block","content":{"terminal":terminal}})
}
fn identity<'a>(v: &'a Value, ids: &mut BTreeSet<&'a str>) -> Result<(), Error> {
    let id = v["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Malformed("id".into()))?;
    if !ids.insert(id) {
        return Err(Error::Duplicate(id.into()));
    }
    Ok(())
}
fn validate_node<'a>(
    v: &'a Value,
    ids: &mut BTreeSet<&'a str>,
    root_alias: bool,
) -> Result<(), Error> {
    if !root_alias {
        identity(v, ids)?;
    }
    match v["type"].as_str() {
        Some("row" | "column" | "stack") => {
            let children = v["children"]
                .as_array()
                .ok_or_else(|| Error::Malformed("children".into()))?;
            for n in children {
                validate_node(n, ids, false)?;
            }
            if v["active"]
                .as_str()
                .is_some_and(|active| !children.iter().any(|n| n["id"] == active))
            {
                return Err(Error::InvalidTarget);
            }
        }
        Some("block") => {
            if !v["content"].is_object() {
                return Err(Error::Malformed("content".into()));
            }
        }
        Some(_) => (),
        None => return Err(Error::Malformed("type".into())),
    }
    // Blocks floating over this node: identities and content like blocks, no type.
    for float in v["floating"].as_array().into_iter().flatten() {
        identity(float, ids)?;
        if !float["content"].is_object() {
            return Err(Error::Malformed("content".into()));
        }
    }
    Ok(())
}
fn ensure_supported(v: &Value) -> Result<(), Error> {
    if let Some(kind) = v
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| !matches!(*kind, "row" | "column" | "stack" | "block"))
    {
        return Err(Error::Unsupported(kind.into()));
    }
    for key in ["spaces", "tabs", "children"] {
        if let Some(a) = v.get(key).and_then(Value::as_array) {
            for c in a {
                ensure_supported(c)?;
            }
        }
    }
    if let Some(root) = v.get("root") {
        ensure_supported(root)?;
    }
    Ok(())
}
/// Arrays that hold spaces, tabs, nodes, and floating blocks.
const NESTED: [&str; 4] = ["spaces", "tabs", "children", "floating"];
fn find<'a>(v: &'a Value, id: &str) -> Option<&'a Value> {
    if v.get("id").and_then(Value::as_str) == Some(id) {
        return Some(v);
    }
    for key in NESTED {
        if let Some(a) = v.get(key).and_then(Value::as_array) {
            for c in a {
                if let Some(n) = find(c, id) {
                    return Some(n);
                }
            }
        }
    }
    v.get("root").and_then(|r| find(r, id))
}
fn target<'a>(v: &'a mut Value, id: &str) -> Result<&'a mut Value, Error> {
    if v.get("id").and_then(Value::as_str) == Some(id) {
        return Ok(v);
    }
    let key = NESTED.into_iter().find(|k| {
        v.get(*k)
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|n| find(n, id).is_some()))
    });
    if let Some(k) = key {
        let n = v[k]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|n| find(n, id).is_some())
            .unwrap();
        return target(n, id);
    }
    if v.get("root").is_some_and(|r| find(r, id).is_some()) {
        return target(v.get_mut("root").unwrap(), id);
    }
    Err(Error::Missing(id.into()))
}
fn reorder(v: &mut Value, id: &str, index: usize) -> Result<(), Error> {
    for key in ["spaces", "tabs", "children"] {
        if let Some(a) = v.get_mut(key).and_then(Value::as_array_mut) {
            if let Some(i) = a.iter().position(|n| n["id"] == id) {
                if index >= a.len() {
                    return Err(Error::InvalidTarget);
                }
                let n = a.remove(i);
                a.insert(index, n);
                return Ok(());
            }
            for n in a {
                if find(n, id).is_some() {
                    return reorder(n, id, index);
                }
            }
        }
    }
    if let Some(r) = v.get_mut("root") {
        return reorder(r, id, index);
    }
    Err(Error::Missing(id.into()))
}
/// The space and tab holding a node; a tab's own id names its root.
fn locate(v: &Value, id: &str) -> Option<(String, String)> {
    for space in v["spaces"].as_array()? {
        for tab in space["tabs"].as_array()? {
            if tab["id"] == id || find(&tab["root"], id).is_some() {
                return Some((space["id"].as_str()?.into(), tab["id"].as_str()?.into()));
            }
        }
    }
    None
}
fn tab_root<'a>(v: &'a mut Value, space: &str, tab: &str) -> Result<&'a mut Value, Error> {
    v["spaces"]
        .as_array_mut()
        .and_then(|spaces| spaces.iter_mut().find(|s| s["id"] == space))
        .and_then(|s| s["tabs"].as_array_mut())
        .and_then(|tabs| tabs.iter_mut().find(|t| t["id"] == tab))
        .map(|t| &mut t["root"])
        .ok_or_else(|| Error::Missing(tab.into()))
}
/// The container directly holding `id` inside a tab root.
fn parent_of<'a>(node: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    let holds = node["children"].as_array()?.iter().any(|n| n["id"] == id);
    if holds {
        return Some(node);
    }
    let index = node["children"]
        .as_array()?
        .iter()
        .position(|n| find(n, id).is_some())?;
    parent_of(&mut node["children"][index], id)
}
fn parent_axis(node: &Value) -> Option<&str> {
    node["type"]
        .as_str()
        .filter(|t| matches!(*t, "row" | "column"))
}
/// A node's weight; pixel sizes have none, and no size counts as 1.
fn weight(node: &Value) -> Option<f64> {
    match node.get("size") {
        None | Some(Value::Null) => Some(1.0),
        Some(size) => size.get("weight").and_then(Value::as_f64),
    }
}
fn panes(node: &Value) -> usize {
    usize::from(node["type"] == "block")
        + node["children"]
            .as_array()
            .map_or(0, |c| c.iter().map(panes).sum())
}
/// Removes a space, a tab, or a node inside a tab, closing what it leaves empty.
fn remove_node(v: &mut Value, id: &str) -> Result<Value, Error> {
    let spaces = v["spaces"].as_array_mut().ok_or(Error::InvalidTarget)?;
    if let Some(i) = spaces.iter().position(|s| s["id"] == id) {
        return Ok(spaces.remove(i));
    }
    let (space, tab) = locate(v, id).ok_or_else(|| Error::Missing(id.into()))?;
    let mut removed = None;
    if tab != id {
        let root = tab_root(v, &space, &tab)?;
        removed = Some(remove_in(root, id).ok_or_else(|| Error::Missing(id.into()))?);
        collapse(root);
        if panes(root) > 0 {
            return Ok(removed.unwrap());
        }
    }
    let spaces = v["spaces"].as_array_mut().unwrap();
    let si = spaces.iter().position(|s| s["id"] == space).unwrap();
    let tabs = spaces[si]["tabs"].as_array_mut().unwrap();
    let ti = tabs.iter().position(|t| t["id"] == tab).unwrap();
    let closed = tabs.remove(ti);
    if tabs.is_empty() {
        spaces.remove(si);
    }
    Ok(removed.unwrap_or(closed))
}
/// Removes `id` below `node`. Its share goes back to the neighbor it was split
/// from (the one before it, else the next); a stack shows the one sliding in.
fn remove_in(node: &mut Value, id: &str) -> Option<Value> {
    if let Some(floats) = node.get_mut("floating").and_then(Value::as_array_mut)
        && let Some(i) = floats.iter().position(|f| f["id"] == id)
    {
        return Some(floats.remove(i));
    }
    let kind = node["type"].as_str().unwrap_or_default().to_owned();
    let children = node.get_mut("children")?.as_array_mut()?;
    if let Some(i) = children.iter().position(|n| n["id"] == id) {
        let removed = children.remove(i);
        if matches!(kind.as_str(), "row" | "column")
            && let Some(gone) = weight(&removed)
            && let Some(n) = children.get_mut(i.saturating_sub(1))
            && let Some(w) = weight(n)
        {
            n["size"] = json!({"weight":w + gone});
        }
        if kind == "stack" && node["active"] == id {
            let children = node["children"].as_array().unwrap();
            node["active"] = children
                .get(i)
                .or(children.last())
                .map_or(Value::Null, |n| n["id"].clone());
        }
        return Some(removed);
    }
    children.iter_mut().find_map(|n| remove_in(n, id))
}
/// Rows/columns emptied by removals vanish; ones left with one child give way
/// to it. A stack's children keep their identity even with one pane or none.
fn collapse(node: &mut Value) {
    let in_stack = node["type"] == "stack";
    let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) else {
        return;
    };
    for n in children.iter_mut() {
        collapse(n);
    }
    if in_stack {
        return;
    }
    let line = |n: &Value| matches!(n["type"].as_str(), Some("row" | "column"));
    children.retain(|n| !(line(n) && n["children"].as_array().is_some_and(Vec::is_empty)));
    for n in children.iter_mut() {
        if line(n) && n["children"].as_array().is_some_and(|c| c.len() == 1) {
            let size = n.get("size").cloned();
            let mut only = n["children"].as_array_mut().unwrap().remove(0);
            match size {
                Some(size) => only["size"] = size,
                None => {
                    only.as_object_mut().map(|o| o.remove("size"));
                }
            }
            *n = only;
        }
    }
}
