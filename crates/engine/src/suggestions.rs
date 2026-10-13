use crate::{
    command_policy::{
        child_scope, flags_for, is_path_position, option_arity, script_command, script_operand,
        vocabulary,
    },
    completion::complete_arguments,
    discovery::Discovery,
    file_repair::{repair_input_file, repair_option_paths},
    history::history_candidates,
    host::{self, Host},
    path,
    path_repair::repair_directory,
    repair::{discovery_target, discovery_targets, repair_candidates as repair, tokens},
    speech::{expand_symbols, symbol_alternatives},
    transfer_command::download_pipeline,
    types::{Candidate, CandidateSource, Catalog, Change, CommandMetadata, Evidence, Flag},
    util::{regex, test},
    validation::{Environment, candidate_valid, simple_words},
};
use futures::future::{LocalBoxFuture, join_all};
use std::cell::RefCell;

fn unique(candidates: impl IntoIterator<Item = Candidate>) -> Vec<Candidate> {
    let mut result: Vec<Candidate> = Vec::new();
    for candidate in candidates {
        if !result.iter().any(|old| old.command == candidate.command) {
            result.push(candidate);
        }
    }
    result
}
fn sort(candidates: &mut [Candidate]) {
    candidates.sort_by(|a, b| {
        b.evidence.resolved.cmp(&a.evidence.resolved).then_with(|| {
            b.evidence
                .confidence
                .total_cmp(&a.evidence.confidence)
                .then_with(|| b.score.total_cmp(&a.score))
        })
    });
}
fn covered(candidate: &Candidate, metadata: &CommandMetadata) -> bool {
    let Some(words) = simple_words(&candidate.command).filter(|words| !words.is_empty()) else {
        return false;
    };
    if script_command(&words[0].value)
        && script_operand(&words.iter().map(|w| &w.value).collect::<Vec<_>>()).is_some()
    {
        return false;
    }
    let mut scope = words[0].value.clone();
    let mut i = 1;
    while i < words.len() {
        let word = &words[i].value;
        if word.starts_with('-') {
            if option_arity(word, &flags_for(&scope, metadata)) == Some(true) {
                i += 1;
            }
        } else {
            scope = child_scope(&scope, word, metadata).unwrap_or(scope);
        }
        i += 1;
    }
    (metadata.flags.contains_key(&scope)
        && metadata
            .schemas
            .as_ref()
            .and_then(|schemas| schemas.get(&scope))
            != Some(&crate::types::SchemaState::Unavailable))
        || vocabulary().common_flags.contains_key(&scope)
        || (scope != words[0].value
            && vocabulary()
                .subcommands
                .get(&words[0].value)
                .is_some_and(|sub| sub.contains(&scope[words[0].value.len() + 1..].to_owned())))
}
async fn check(
    input: &str,
    candidates: Vec<Candidate>,
    catalog: &Catalog,
    env: &Environment,
    metadata: &CommandMetadata,
    host: &dyn Host,
    script_flags: Option<&[Flag]>,
) -> Result<Vec<Candidate>, String> {
    let mut candidates: Vec<_> = candidates.into_iter().filter(|c| !c.is_literal()).collect();
    sort(&mut candidates);
    let mut ranked = unique(candidates);
    ranked.truncate(16);
    let valid = join_all(
        ranked
            .iter()
            .map(|c| candidate_valid(input, c, catalog, env, metadata, host, script_flags)),
    )
    .await
    .into_iter()
    .map(|result| result.unwrap_or(false))
    .collect::<Vec<_>>();
    let mut valid: Vec<_> = ranked
        .into_iter()
        .zip(valid)
        .filter_map(|(mut c, valid)| {
            c.evidence.validated = valid;
            if valid
                && simple_words(&c.command)
                    .and_then(|words| {
                        words.first().map(|word| {
                            crate::command_policy::input_file_command(&word.value)
                                || crate::command_policy::directory_command(&word.value)
                        })
                    })
                    .unwrap_or(false)
            {
                c.evidence.resolved = true;
            }
            valid.then_some(c)
        })
        .collect();
    sort(&mut valid);
    let top = valid.first().map_or(0.0, |c| c.evidence.confidence);
    Ok(valid
        .into_iter()
        .filter(|c| c.evidence.confidence >= top - 18.0)
        .take(3)
        .collect())
}
async fn referenced_paths(
    input: &str,
    catalog: &Catalog,
    env: &Environment,
    host: &dyn Host,
) -> Result<Catalog, String> {
    let expanded = expand_symbols(input, true);
    let mut prefixes = Vec::new();
    for word in &tokens(&expanded) {
        if word.quoted || word.value.contains(['*', '?', '$']) {
            continue;
        }
        if let Some(matched) = regex(r"^([^\s]*/)").captures(&word.value) {
            let prefix = matched[1].to_owned();
            if !prefixes.contains(&prefix) {
                prefixes.push(prefix);
            }
        }
    }
    prefixes.truncate(4);
    let groups = join_all(prefixes.iter().map(|prefix| async move {
        let target = if let Some(relative) = prefix.strip_prefix("~/") {
            path::join(&[
                env.get("HOME")
                    .map(String::as_str)
                    .filter(|v| !v.is_empty())
                    .unwrap_or(&catalog.cwd),
                relative,
            ])
        } else {
            prefix.clone()
        };
        let dir = path::resolve(&[&catalog.cwd, &target]);
        Ok(host::entries(host, &dir, 1000)
            .await?
            .into_iter()
            .map(|e| format!("{prefix}{}{}", e.name, if e.directory { "/" } else { "" }))
            .collect::<Vec<_>>())
    }))
    .await
    .into_iter()
    .collect::<Result<Vec<Vec<String>>, String>>()?;
    let mut expanded = catalog.clone();
    for entry in groups.into_iter().flatten() {
        if !expanded.paths.contains(&entry) {
            expanded.paths.push(entry);
        }
    }
    Ok(expanded)
}
async fn nearby_file_paths(
    input: &str,
    catalog: &Catalog,
    host: &dyn Host,
    metadata: &CommandMetadata,
) -> Catalog {
    if !catalog.paths.is_empty() {
        return catalog.clone();
    }
    let expanded = expand_symbols(input, true);
    if test(r"[~/*?<>|&;$]", &expanded) {
        return catalog.clone();
    }
    let target = discovery_target(&expanded, catalog);
    let words = tokens(&target);
    let Some(command) = catalog.commands.iter().find(|name| {
        words
            .first()
            .is_some_and(|w| name.to_lowercase() == w.value.to_lowercase())
    }) else {
        return catalog.clone();
    };
    if words.len() < 2
        || !flags_for(command, metadata).iter().any(|flag| {
            flag.value.as_ref().is_some_and(|value| {
                matches!(
                    value.kind,
                    crate::types::ValueKind::Path
                        | crate::types::ValueKind::Directory
                        | crate::types::ValueKind::InputFile
                )
            })
        }) && !is_path_position(std::slice::from_ref(command))
            && !is_path_position(&[command.clone(), words[1].value.clone()])
        || !words[1..]
            .iter()
            .any(|w| !w.quoted && !w.value.starts_with('-'))
    {
        return catalog.clone();
    }
    let Ok(entries) = host::entries(host, &catalog.cwd, 1000).await else {
        return catalog.clone();
    };
    let mut expanded = catalog.clone();
    for entry in &entries {
        let name = format!("{}{}", entry.name, if entry.directory { "/" } else { "" });
        if !expanded.paths.contains(&name) {
            expanded.paths.push(name);
        }
    }
    expanded
}
fn part_choices<'a>(
    input: &'a str,
    catalog: &'a Catalog,
    env: &'a Environment,
    discovery: &'a Discovery,
    host: &'a dyn Host,
    stage: &'a RefCell<Option<String>>,
) -> LocalBoxFuture<'a, Result<Vec<Candidate>, String>> {
    Box::pin(async move {
        let mut candidates: Vec<_> = suggest(input, catalog, env, discovery, host, stage)
            .await?
            .into_iter()
            .filter(|c| !c.is_literal())
            .collect();
        if !candidates.iter().any(|c| c.command == input) {
            let literal = Candidate {
                command: input.into(),
                score: 110.0,
                changes: vec![],
                literal: None,
                evidence: Evidence::default(),
            };
            let metadata = discovery.cached(catalog, env, host.now_ms());
            if candidate_valid(input, &literal, catalog, env, &metadata, host, None).await? {
                candidates.insert(0, literal);
            }
        }
        Ok(unique(candidates).into_iter().take(3).collect())
    })
}

fn next_directory(command: &str, catalog: &Catalog, env: &Environment) -> Option<String> {
    let words = simple_words(command)?;
    if words.first()?.value != "cd" {
        return None;
    }
    let value = words.iter().skip(1).find(|w| !w.value.starts_with('-'));
    let target = value.map_or_else(
        || env.get("HOME").cloned(),
        |word| {
            Some(if word.home {
                path::join(&[
                    env.get("HOME")?.as_str(),
                    word.value.trim_start_matches('~'),
                ])
            } else {
                word.value.clone()
            })
        },
    )?;
    Some(path::resolve(&[&catalog.cwd, &target]))
}

fn suggest_text<'a>(
    input: &'a str,
    catalog: &'a Catalog,
    env: &'a Environment,
    discovery: &'a Discovery,
    host: &'a dyn Host,
    stage: &'a RefCell<Option<String>>,
    spoken: &'a str,
) -> LocalBoxFuture<'a, Result<Vec<Candidate>, String>> {
    Box::pin(async move {
        if let Some(pipeline) = catalog
            .commands
            .contains(&"download".into())
            .then(|| download_pipeline(input))
            .flatten()
        {
            return Ok(
                suggest(&pipeline.command, catalog, env, discovery, host, stage)
                    .await?
                    .into_iter()
                    .filter(|c| !c.is_literal())
                    .map(|mut c| {
                        c.command += &format!(" | {}", pipeline.tail);
                        c
                    })
                    .collect(),
            );
        }
        let expanded = expand_symbols(input, true);
        if let Some(list) = crate::shell_structure::command_list(&expanded) {
            use crate::shell_structure::Separator;
            let pipes = list.separators.iter().all(|s| *s == Separator::Pipe);
            let groups = if pipes {
                Some(
                    join_all(
                        list.commands
                            .iter()
                            .map(|part| part_choices(part, catalog, env, discovery, host, stage)),
                    )
                    .await
                    .into_iter()
                    .collect::<Result<Vec<_>, _>>()?,
                )
            } else {
                None
            };
            let mut combined = vec![(
                Candidate {
                    command: String::new(),
                    score: 110.0,
                    changes: vec![if pipes {
                        Change::Pipeline
                    } else {
                        Change::Separator
                    }],
                    literal: None,
                    evidence: Evidence::default(),
                },
                catalog.clone(),
            )];
            for (index, part) in list.commands.iter().enumerate() {
                let mut next = Vec::new();
                for (prefix, context) in &combined {
                    let choices = if let Some(groups) = &groups {
                        groups[index].clone()
                    } else {
                        if context.cwd == catalog.cwd {
                            part_choices(part, context, env, discovery, host, stage).await?
                        } else {
                            let scoped = crate::host::ScopedHost {
                                inner: host,
                                cwd: &context.cwd,
                            };
                            part_choices(part, context, env, discovery, &scoped, stage).await?
                        }
                    };
                    for candidate in choices {
                        let mut changes = prefix.changes.clone();
                        changes.extend(candidate.changes.clone());
                        let command = if index == 0 {
                            candidate.command.clone()
                        } else {
                            format!(
                                "{}{}{}",
                                prefix.command,
                                list.separators[index - 1].text(),
                                candidate.command
                            )
                        };
                        let mut context = context.clone();
                        if list
                            .separators
                            .get(index)
                            .is_some_and(|s| matches!(s, Separator::Sequence | Separator::And))
                            && let Some(cwd) = next_directory(&candidate.command, &context, env)
                        {
                            context.cwd = cwd;
                            context.paths.clear();
                        }
                        next.push((
                            Candidate {
                                command,
                                score: prefix.score.min(candidate.score),
                                evidence: Evidence::new(
                                    CandidateSource::Compound,
                                    prefix
                                        .evidence
                                        .confidence
                                        .min(candidate.evidence.confidence),
                                ),
                                changes,
                                literal: None,
                            },
                            context,
                        ));
                    }
                }
                next.sort_by(|a, b| {
                    b.0.evidence
                        .confidence
                        .total_cmp(&a.0.evidence.confidence)
                        .then_with(|| b.0.score.total_cmp(&a.0.score))
                });
                next.truncate(3);
                combined = next;
            }
            let mut valid = Vec::new();
            for (candidate, _) in combined {
                if host::syntax(host, &candidate.command).await? {
                    valid.push(candidate);
                }
            }
            return Ok(valid);
        }
        let metadata = discovery.cached(catalog, env, host.now_ms());
        if let Some(offset) = crate::shell_structure::nested_command(input, &metadata) {
            let prefix = &input[..offset];
            let wrapper = tokens(prefix).first().map(|w| w.value.to_lowercase());
            if wrapper
                .as_ref()
                .is_some_and(|w| w.contains('=') || catalog.commands.contains(w))
            {
                let nested =
                    suggest(&input[offset..], catalog, env, discovery, host, stage).await?;
                let mut result = Vec::new();
                for mut candidate in nested.into_iter().filter(|c| !c.is_literal()) {
                    candidate.command = format!("{prefix}{}", candidate.command);
                    if host::syntax(host, &candidate.command).await? {
                        result.push(candidate);
                    }
                }
                return Ok(result);
            }
        }
        if let Some(protected) = crate::shell_structure::protect(input) {
            let mut metadata = metadata;
            let cheap = repair(&protected.text, catalog, None, &metadata);
            if !cheap
                .iter()
                .any(|c| !c.is_literal() && covered(c, &metadata))
            {
                for target in discovery_targets(&protected.text, catalog) {
                    if let Ok(found) = discovery.discover(&target, catalog, env, host).await {
                        metadata.merge(found.metadata);
                    }
                }
            }
            let candidates = repair(&protected.text, catalog, None, &metadata)
                .into_iter()
                .filter(|c| !c.is_literal())
                .map(|mut c| {
                    c.command = protected.restore(&c.command);
                    c
                })
                .collect();
            return check(input, candidates, catalog, env, &metadata, host, None).await;
        }
        suggest_one(input, catalog, env, discovery, host, stage, spoken).await
    })
}

pub fn suggest<'a>(
    input: &'a str,
    catalog: &'a Catalog,
    env: &'a Environment,
    discovery: &'a Discovery,
    host: &'a dyn Host,
    stage: &'a RefCell<Option<String>>,
) -> LocalBoxFuture<'a, Result<Vec<Candidate>, String>> {
    Box::pin(async move {
        for _ in 0..2 {
            let (result, valid) = futures::join!(
                suggest_unchecked(input, catalog, env, discovery, host, stage),
                discovery.verify_versions(input, catalog, env, host)
            );
            if valid {
                return result;
            }
        }
        Ok(vec![Candidate::literal(input)])
    })
}

fn suggest_unchecked<'a>(
    input: &'a str,
    catalog: &'a Catalog,
    env: &'a Environment,
    discovery: &'a Discovery,
    host: &'a dyn Host,
    stage: &'a RefCell<Option<String>>,
) -> LocalBoxFuture<'a, Result<Vec<Candidate>, String>> {
    Box::pin(async move {
        let texts: Vec<_> = std::iter::once(input.to_owned())
            .chain(symbol_alternatives(input))
            .collect();
        let groups = join_all(
            texts
                .iter()
                .map(|text| suggest_text(text, catalog, env, discovery, host, stage, input)),
        )
        .await
        .into_iter()
        .enumerate()
        .filter_map(|(index, result)| result.ok().map(|group| (index, group)))
        .collect::<Vec<_>>();
        let mut candidates = Vec::new();
        for (index, group) in groups {
            for mut candidate in group.into_iter().filter(|c| !c.is_literal()) {
                if index > 0 {
                    candidate.score -= 12.0;
                    candidate.evidence.confidence = (candidate.evidence.confidence - 12.0).max(0.0);
                    candidate.changes.insert(0, Change::SymbolAlternative);
                }
                candidates.push(candidate);
            }
        }
        sort(&mut candidates);
        let mut candidates = unique(candidates);
        candidates.truncate(3);
        candidates.push(Candidate::literal(input));
        Ok(candidates)
    })
}

async fn suggest_one(
    input: &str,
    catalog: &Catalog,
    env: &Environment,
    discovery: &Discovery,
    host: &dyn Host,
    stage: &RefCell<Option<String>>,
    spoken_input: &str,
) -> Result<Vec<Candidate>, String> {
    let literal = Candidate::literal(input);
    let mut metadata = discovery.cached(catalog, env, host.now_ms());
    let home = env.get("HOME").map(String::as_str).unwrap_or_default();
    if let Some(mut files) =
        repair_input_file(input, catalog, home, host, spoken_input, &metadata).await?
    {
        *stage.borrow_mut() = Some("directory".into());
        files.push(literal);
        return Ok(files);
    }
    let historic = history_candidates(input, catalog);
    if let Some(directories) = repair_directory(input, catalog, home, host).await? {
        *stage.borrow_mut() = Some("directory".into());
        let mut valid = check(input, directories, catalog, env, &metadata, host, None).await?;
        valid.push(literal);
        return Ok(valid);
    }
    let catalog = nearby_file_paths(input, catalog, host, &metadata).await;
    let cheap: Vec<_> = repair(input, &catalog, None, &metadata)
        .into_iter()
        .filter(|c| !c.is_literal())
        .collect();
    if historic.iter().any(|c| c.score >= 102.0) {
        let mut from_history = check(
            input,
            historic
                .iter()
                .filter(|c| c.score >= 102.0)
                .cloned()
                .chain(cheap.iter().cloned())
                .collect(),
            &catalog,
            env,
            &metadata,
            host,
            None,
        )
        .await?;
        if !from_history.is_empty() {
            *stage.borrow_mut() = Some("history".into());
            from_history.push(literal);
            return Ok(from_history);
        }
    }
    let fast = check(
        input,
        cheap
            .iter()
            .filter(|c| c.score >= 100.0 && covered(c, &metadata))
            .cloned()
            .collect(),
        &catalog,
        env,
        &metadata,
        host,
        None,
    )
    .await?;
    let unresolved_dash = fast.iter().any(|c| {
        tokens(&c.command)
            .iter()
            .any(|w| !w.quoted && test("(?i)^(dash|hyphen|hep)$", &w.value))
    });
    if !fast.is_empty() && !unresolved_dash {
        let completed = complete_arguments(input, &catalog, &metadata, host, None).await?;
        *stage.borrow_mut() = Some(
            if metadata.flags.is_empty() {
                "schema"
            } else {
                "cache"
            }
            .into(),
        );
        let mut candidates = if completed.is_empty() {
            fast
        } else {
            check(
                input,
                completed.into_iter().chain(fast).collect(),
                &catalog,
                env,
                &metadata,
                host,
                None,
            )
            .await?
        };
        candidates.push(literal);
        return Ok(candidates);
    }
    let expanded_catalog = referenced_paths(input, &catalog, env, host).await?;
    let preliminary_repairs = if expanded_catalog.paths == catalog.paths {
        cheap
    } else {
        repair(input, &expanded_catalog, None, &metadata)
            .into_iter()
            .filter(|c| !c.is_literal())
            .collect()
    };
    let catalog = expanded_catalog;
    let mut preliminary: Vec<_> = preliminary_repairs
        .iter()
        .cloned()
        .chain(historic.iter().cloned())
        .collect();
    sort(&mut preliminary);
    let roots = discovery_targets(&expand_symbols(input, true), &catalog);
    let mut targets: Vec<_> = Vec::new();
    for target in preliminary
        .first()
        .map(|c| c.command.clone())
        .into_iter()
        .chain(roots)
    {
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    targets.truncate(3);
    if targets.is_empty() {
        targets.push(discovery_target(input, &catalog));
    }
    let discoveries = join_all(
        targets
            .iter()
            .map(|target| discovery.discover(target, &catalog, env, host)),
    )
    .await
    .into_iter()
    .filter_map(Result::ok)
    .collect::<Vec<_>>();
    let mut script_flags = None;
    for found in discoveries {
        metadata.merge(found.metadata);
        if script_flags.is_none() {
            script_flags = found.script_flags;
        }
    }
    *stage.borrow_mut() = Some("discovery".into());
    if let Some(files) =
        repair_input_file(input, &catalog, home, host, spoken_input, &metadata).await?
    {
        let mut candidates = check(
            input,
            files,
            &catalog,
            env,
            &metadata,
            host,
            script_flags.as_deref(),
        )
        .await?;
        candidates.push(literal);
        return Ok(candidates);
    }
    let catalog = nearby_file_paths(input, &catalog, host, &metadata).await;
    let catalog = referenced_paths(input, &catalog, env, host).await?;
    let repairs = repair(input, &catalog, script_flags.as_deref(), &metadata);
    let path_values = repair_option_paths(
        input,
        &catalog,
        home,
        host,
        &metadata,
        script_flags.as_deref(),
    )
    .await?;
    let completed =
        complete_arguments(input, &catalog, &metadata, host, script_flags.as_deref()).await?;
    let mut candidates = check(
        input,
        completed
            .into_iter()
            .chain(path_values)
            .chain(repairs)
            .chain(historic)
            .collect(),
        &catalog,
        env,
        &metadata,
        host,
        script_flags.as_deref(),
    )
    .await?;
    candidates.push(literal);
    Ok(candidates)
}
