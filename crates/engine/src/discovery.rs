use crate::test;
use crate::{
    command_policy::{option_arity, script_operand, vocabulary},
    host::{self, Host},
    repair::{matches, tokens},
    types::{Catalog, CommandMetadata, Flag, Help, SchemaState, SharedList},
    util::locale_cmp,
    validation::Environment,
};
use futures::future::join_all;
use serde::Serialize;
use std::{cell::RefCell, collections::VecDeque};

struct Snapshot {
    key: String,
    until: f64,
    metadata: CommandMetadata,
}
type DiscoveryContext = (
    String,
    Environment,
    SharedList<String>,
    Option<SharedList<String>>,
    String,
);
#[derive(Default)]
pub struct Discovery {
    snapshots: RefCell<VecDeque<Snapshot>>,
    warmed: RefCell<VecDeque<(String, f64)>>,
    context: RefCell<Option<DiscoveryContext>>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub metadata: CommandMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_flags: Option<Vec<Flag>>,
}
#[derive(Clone)]
struct Branch {
    route: Vec<String>,
    index: usize,
    score: f64,
}

fn context(catalog: &Catalog, env: &Environment) -> String {
    let mut stable: Vec<_> = env
        .iter()
        .filter(|(key, _)| {
            !test!(
                r###"^(?:_|PWD|OLDPWD|SHLVL|LINES|COLUMNS|LIBERTTY_.*)$"###,
                key
            )
        })
        .collect();
    stable.sort_by(|(a, _), (b, _)| locale_cmp(a, b));
    serde_json::to_string(&(&catalog.cwd, stable, &catalog.commands, &catalog.functions))
        .expect("metadata context")
}
fn merge(base: &[Flag], discovered: &[Flag]) -> Vec<Flag> {
    let mut result = base.to_vec();
    for flag in discovered {
        if let Some(old) = result.iter_mut().find(|old| old.name == flag.name) {
            *old = flag.clone();
        } else {
            result.push(flag.clone());
        }
    }
    result
}
fn record(
    metadata: &mut CommandMetadata,
    command: &str,
    route: &[String],
    help: &Help,
    inherited: &[Flag],
) {
    let scope = std::iter::once(command)
        .chain(route.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let flags = merge(
        &merge(
            inherited,
            vocabulary()
                .common_flags
                .get(&scope)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        ),
        &help.flags,
    );
    let state = if help.flags.is_empty() && help.subcommands.is_empty() && help.required.is_none() {
        SchemaState::Unavailable
    } else {
        SchemaState::Partial
    };
    metadata
        .schemas
        .get_or_insert_with(Default::default)
        .insert(scope.clone(), state);
    if route.is_empty()
        && let Some(version) = &help.version
    {
        metadata
            .versions
            .get_or_insert_with(Default::default)
            .insert(command.into(), version.clone());
    }
    metadata.flags.insert(scope.clone(), flags);
    let mut commands = vocabulary()
        .subcommands
        .get(&scope)
        .cloned()
        .unwrap_or_default();
    for child in &help.subcommands {
        if !commands.contains(child) {
            commands.push(child.clone());
        }
    }
    metadata.subcommands.insert(scope.clone(), commands);
    if let Some(required) = help.required {
        metadata
            .required_positionals
            .as_mut()
            .unwrap()
            .insert(scope, required);
    }
}
impl Discovery {
    fn context(&self, catalog: &Catalog, env: &Environment) -> String {
        let mut cached = self.context.borrow_mut();
        if let Some((cwd, environment, commands, functions, key)) = cached.as_ref()
            && *cwd == catalog.cwd
            && environment == env
            && commands == &catalog.commands
            && functions == &catalog.functions
        {
            return key.clone();
        }
        let key = context(catalog, env);
        *cached = Some((
            catalog.cwd.clone(),
            env.clone(),
            catalog.commands.clone(),
            catalog.functions.clone(),
            key.clone(),
        ));
        key
    }
    pub fn seed(&self, metadata: &CommandMetadata, catalog: &Catalog, env: &Environment, now: f64) {
        self.remember(metadata, catalog, env, now);
    }
    pub fn clear(&self) {
        self.snapshots.borrow_mut().clear();
        self.warmed.borrow_mut().clear();
        self.context.borrow_mut().take();
    }
    pub fn prewarm_targets(&self, catalog: &Catalog, env: &Environment, now: f64) -> Vec<String> {
        let common = [
            "git",
            "git init",
            "git add",
            "git commit",
            "git status",
            "ls",
        ];
        let mut recent = vec![];
        for line in catalog.history.iter().rev().take(200) {
            let words = tokens(line);
            if words.is_empty()
                || test!(r###"[|&;<>()\u{60}$\\]"###, line)
                || words[0].value.starts_with('_')
            {
                continue;
            }
            let target = words
                .iter()
                .take(4)
                .map(|w| w.value.as_str())
                .take_while(|w| test!(r###"^[a-zA-Z][a-zA-Z0-9_-]*$"###, w))
                .collect::<Vec<_>>()
                .join(" ");
            if !target.is_empty()
                && catalog.commands.contains(&words[0].value)
                && !recent.contains(&target)
            {
                recent.push(target)
            }
            if recent.len() == 10 {
                break;
            }
        }
        let key = self.context(catalog, env);
        let warmed = self.warmed.borrow();
        let mut targets = vec![];
        for target in std::iter::once(common[0].to_owned())
            .chain(recent)
            .chain(common[1..].iter().map(|s| s.to_string()))
        {
            let root = tokens(&target)
                .first()
                .map(|w| w.value.clone())
                .unwrap_or_default();
            if !catalog.commands.contains(&root)
                || targets.contains(&target)
                || warmed
                    .iter()
                    .any(|(entry, until)| *entry == format!("{key}{target}") && *until > now)
            {
                continue;
            }
            targets.push(target);
        }
        targets
    }
    pub fn mark_warmed(&self, target: &str, catalog: &Catalog, env: &Environment, now: f64) {
        let key = format!("{}{target}", self.context(catalog, env));
        let mut warmed = self.warmed.borrow_mut();
        if let Some((_, until)) = warmed.iter_mut().find(|(entry, _)| *entry == key) {
            *until = now + 600000.0;
            return;
        }
        warmed.push_back((key, now + 600000.0));
        if warmed.len() > 200 {
            warmed.pop_front();
        }
    }
    pub async fn verify_versions(
        &self,
        input: &str,
        catalog: &Catalog,
        env: &Environment,
        host: &dyn Host,
    ) -> bool {
        let protected = crate::shell_structure::protect(input);
        let text = protected.as_ref().map(|p| p.text.as_str()).unwrap_or(input);
        let metadata = self.cached(catalog, env, host.now_ms());
        let mut roots = Vec::new();
        for target in crate::repair::discovery_targets(text, catalog) {
            if let Some(word) = tokens(&target).first()
                && metadata
                    .versions
                    .as_ref()
                    .is_some_and(|versions| versions.contains_key(&word.value))
                && !roots.contains(&word.value)
            {
                roots.push(word.value.clone());
            }
        }
        let facts = join_all(roots.iter().map(|root| host::version(host, root))).await;
        let key = self.context(catalog, env);
        let mut changed = false;
        for (root, version) in roots.iter().zip(facts) {
            if version.ok().as_ref()
                == metadata
                    .versions
                    .as_ref()
                    .and_then(|versions| versions.get(root))
            {
                continue;
            }
            changed = true;
            if let Some(snapshot) = self
                .snapshots
                .borrow_mut()
                .iter_mut()
                .find(|entry| entry.key == key)
            {
                let keep =
                    |scope: &String| scope != root && !scope.starts_with(&format!("{root} "));
                snapshot.metadata.flags.retain(|scope, _| keep(scope));
                snapshot.metadata.subcommands.retain(|scope, _| keep(scope));
                if let Some(required) = &mut snapshot.metadata.required_positionals {
                    required.retain(|scope, _| keep(scope));
                }
                if let Some(schemas) = &mut snapshot.metadata.schemas {
                    schemas.retain(|scope, _| keep(scope));
                }
                if let Some(versions) = &mut snapshot.metadata.versions {
                    versions.remove(root);
                }
            }
        }
        !changed
    }
    pub fn cached(&self, catalog: &Catalog, env: &Environment, now: f64) -> CommandMetadata {
        let key = self.context(catalog, env);
        self.snapshots
            .borrow()
            .iter()
            .find(|entry| entry.key == key && entry.until >= now)
            .map(|entry| entry.metadata.clone())
            .unwrap_or_else(CommandMetadata::empty)
    }
    fn remember(&self, metadata: &CommandMetadata, catalog: &Catalog, env: &Environment, now: f64) {
        let key = self.context(catalog, env);
        let mut snapshots = self.snapshots.borrow_mut();
        if let Some(entry) = snapshots
            .iter_mut()
            .find(|entry| entry.key == key && entry.until >= now)
        {
            entry.metadata.merge(metadata.clone());
            return;
        }
        snapshots.retain(|entry| entry.key != key);
        if snapshots.len() >= 8 {
            snapshots.pop_front();
        }
        snapshots.push_back(Snapshot {
            key,
            until: now + 600000.0,
            metadata: metadata.clone(),
        });
    }
    pub async fn discover(
        &self,
        command_line: &str,
        catalog: &Catalog,
        env: &Environment,
        host: &dyn Host,
    ) -> Result<Discovered, String> {
        let deadline = (host.now_ms() + 2500.0).min(host.deadline_ms());
        let mut metadata = CommandMetadata::empty();
        if crate::validation::simple_words(command_line).is_none() {
            return Ok(Discovered {
                metadata,
                script_flags: None,
            });
        }
        let words = tokens(command_line);
        let Some(first) = words.first() else {
            return Ok(Discovered {
                metadata,
                script_flags: None,
            });
        };
        let command = &first.value;
        if ["python", "python3"].contains(&command.as_str())
            && script_operand(&words.iter().map(|w| &w.value).collect::<Vec<_>>())
                .is_some_and(|index| words[index].value.ends_with(".py"))
            && let Some(flags) = host::describe(host, command_line).await?
        {
            return Ok(Discovered {
                metadata,
                script_flags: Some(flags),
            });
        }
        let root = host::help(host, command, &[]).await?;
        record(&mut metadata, command, &[], &root, &[]);
        for (alias, target) in root.aliases.as_ref().into_iter().flatten() {
            if let Some(flags) = vocabulary().common_flags.get(&format!("git {target}")) {
                metadata.flags.insert(
                    format!("git {alias}"),
                    merge(
                        metadata
                            .flags
                            .get("git")
                            .map(Vec::as_slice)
                            .unwrap_or_default(),
                        flags,
                    ),
                );
            }
        }
        self.remember(&metadata, catalog, env, host.now_ms());
        let mut branches = vec![Branch {
            route: vec![],
            index: 1,
            score: 0.0,
        }];
        let mut probes = 1;
        for _ in 0..3 {
            if branches.is_empty() || probes >= 7 || host.now_ms() >= deadline {
                break;
            }
            let mut next = Vec::new();
            for branch in &branches {
                let scope = std::iter::once(command.as_str())
                    .chain(branch.route.iter().map(String::as_str))
                    .collect::<Vec<_>>()
                    .join(" ");
                let mut index = branch.index;
                while index < words.len() && words[index].value.starts_with('-') {
                    let takes = option_arity(
                        &words[index].value,
                        metadata
                            .flags
                            .get(&scope)
                            .map(Vec::as_slice)
                            .unwrap_or_default(),
                    );
                    if takes.is_none() || words[index].value == "--" {
                        break;
                    }
                    index += if takes == Some(true) { 2 } else { 1 };
                }
                let found = matches(
                    &words,
                    index,
                    metadata
                        .subcommands
                        .get(&scope)
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                    3,
                    false,
                );
                let top = found.first().map_or(0.0, |m| m.score);
                for matched in found.into_iter().filter(|m| m.score >= top - 18.0).take(2) {
                    let mut route = branch.route.clone();
                    route.push(matched.value);
                    if command == "git" {
                        let target = root
                            .aliases
                            .as_ref()
                            .and_then(|aliases| aliases.get(&route[0]))
                            .unwrap_or(&route[0]);
                        let safe = root
                            .safe_subcommands
                            .as_ref()
                            .or_else(|| vocabulary().subcommands.get("git"));
                        if safe.is_none_or(|safe| !safe.contains(target)) {
                            continue;
                        }
                    }
                    if branch.route.is_empty()
                        && root
                            .probe_subcommands
                            .as_ref()
                            .is_some_and(|safe| !safe.contains(&route[0]))
                    {
                        continue;
                    }
                    next.push(Branch {
                        route,
                        index: index + matched.consumed,
                        score: branch.score + matched.score,
                    });
                }
            }
            next.sort_by(|a, b| b.score.total_cmp(&a.score));
            next.truncate(2.min(7 - probes));
            branches = next;
            probes += branches.len();
            let children = join_all(branches.iter().map(|branch| {
                let mut route = branch.route.clone();
                if command == "git"
                    && let Some(target) = root
                        .aliases
                        .as_ref()
                        .and_then(|aliases| aliases.get(&route[0]))
                {
                    route[0] = target.clone();
                }
                async move { host::help(host, command, &route).await }
            }))
            .await
            .into_iter()
            .map(|result| result.unwrap_or_default())
            .collect::<Vec<_>>();
            for (branch, help) in branches.iter().zip(children) {
                let parent = std::iter::once(command.as_str())
                    .chain(
                        branch.route[..branch.route.len() - 1]
                            .iter()
                            .map(String::as_str),
                    )
                    .collect::<Vec<_>>()
                    .join(" ");
                let inherited = metadata.flags.get(&parent).cloned().unwrap_or_default();
                record(&mut metadata, command, &branch.route, &help, &inherited);
            }
            self.remember(&metadata, catalog, env, host.now_ms());
        }
        Ok(Discovered {
            metadata,
            script_flags: None,
        })
    }
}
