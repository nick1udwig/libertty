use crate::{
    command_policy::{
        child_scope, flags_for, is_path_position, option_arity, script_command, script_operand,
        vocabulary,
    },
    completion::complete_arguments,
    discovery::Discovery,
    file_repair::repair_input_file,
    history::history_candidates,
    host::{self, Host},
    path,
    path_repair::repair_directory,
    pipeline::pipeline_parts,
    repair::{discovery_target, discovery_targets, repair_candidates as repair, tokens},
    speech::{expand_symbols, symbol_alternatives},
    transfer_command::download_pipeline,
    types::{Candidate, Catalog, CommandMetadata, Flag},
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
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
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
    metadata.flags.contains_key(&scope)
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
    .collect::<Result<Vec<_>, String>>()?;
    let valid: Vec<_> = ranked
        .into_iter()
        .zip(valid)
        .filter_map(|(c, valid)| valid.then_some(c))
        .collect();
    let top = valid.first().map_or(0.0, |c| c.score);
    Ok(valid
        .into_iter()
        .filter(|c| c.score >= top - 18.0)
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
        if let Some(matched) = regex(r"^((?:~/|/|\.\.?/)[^\s]*/)").captures(&word.value) {
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
async fn nearby_file_paths(input: &str, catalog: &Catalog, host: &dyn Host) -> Catalog {
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
        || !is_path_position(&[command.clone()])
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
async fn compound_alternatives(
    input: &str,
    catalog: &Catalog,
    env: &Environment,
    discovery: &Discovery,
    host: &dyn Host,
) -> Result<Vec<Candidate>, String> {
    if !test(r"(?i)\b(?:semicolon|semi\s+colon|mic)\b|\s;\s", input) {
        return Ok(vec![]);
    }
    let expanded = expand_symbols(input, true);
    if !test(r"\s;\s", &expanded) || test(r#"["'`$\\|&<>()\[\]{}\n\r]"#, &expanded) {
        return Ok(vec![]);
    }
    let parts: Vec<_> = regex(r"\s*;\s*").split(&expanded).collect();
    if parts.len() != 2
        || parts
            .iter()
            .any(|p| p.is_empty() || simple_words(p).is_none_or(|ws| ws.is_empty()))
    {
        return Ok(vec![]);
    }
    let metadata = discovery.cached(catalog, env, host.now_ms());
    let choices = join_all(parts.iter().map(|part| {
        let metadata = &metadata;
        async move {
            let mut candidates: Vec<_> = repair(part, catalog, None, metadata)
                .into_iter()
                .filter(|c| !c.is_literal())
                .collect();
            candidates.push(Candidate {
                command: (*part).into(),
                score: 100.0,
                changes: vec![],
                literal: Some(true),
            });
            let checked = join_all(
                candidates
                    .iter()
                    .map(|c| candidate_valid(part, c, catalog, env, metadata, host, None)),
            )
            .await
            .into_iter()
            .collect::<Result<Vec<_>, String>>()?;
            let mut valid: Vec<_> = candidates
                .into_iter()
                .zip(checked)
                .filter_map(|(c, v)| v.then_some(c))
                .collect();
            let rank = |c: &Candidate| {
                c.score
                    - if !part.ends_with('/') && c.command.ends_with('/') {
                        15.0
                    } else {
                        0.0
                    }
                    + if c.command == *part { 10.0 } else { 0.0 }
            };
            valid.sort_by(|a, b| rank(b).total_cmp(&rank(a)));
            valid.truncate(2);
            Ok(valid)
        }
    }))
    .await
    .into_iter()
    .collect::<Result<Vec<Vec<Candidate>>, String>>()?;
    let mut combined = Vec::new();
    for first in &choices[0] {
        for second in &choices[1] {
            let command = format!("{}; {}", first.command, second.command);
            if command == input.trim() || combined.iter().any(|c: &Candidate| c.command == command)
            {
                continue;
            }
            let candidate = Candidate {
                command,
                score: first.score.min(second.score) + 12.0,
                changes: vec!["Spoken command separator".into()],
                literal: None,
            };
            if candidate_valid(input, &candidate, catalog, env, &metadata, host, None).await? {
                combined.push(candidate);
            }
        }
    }
    sort(&mut combined);
    combined.truncate(2);
    Ok(combined)
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
        if let Some(pipeline) = catalog
            .commands
            .contains(&"download".into())
            .then(|| download_pipeline(input))
            .flatten()
        {
            let upstream = suggest(&pipeline.command, catalog, env, discovery, host, stage).await?;
            let mut candidates: Vec<_> = upstream
                .into_iter()
                .filter(|c| !c.is_literal())
                .take(3)
                .map(|mut c| {
                    c.command += &format!(" | {}", pipeline.tail);
                    c
                })
                .collect();
            candidates.push(Candidate::literal(input));
            return Ok(candidates);
        }
        if let Some(parts) = pipeline_parts(input) {
            let metadata = discovery.cached(catalog, env, host.now_ms());
            let groups = join_all(parts.iter().map(|part| {
                let metadata = &metadata;
                async move {
                    let mut candidates: Vec<_> =
                        suggest(part, catalog, env, discovery, host, stage)
                            .await?
                            .into_iter()
                            .filter(|c| !c.is_literal())
                            .collect();
                    let literal = Candidate {
                        command: part.clone(),
                        score: 110.0,
                        changes: vec![],
                        literal: None,
                    };
                    if candidate_valid(part, &literal, catalog, env, metadata, host, None).await? {
                        candidates.insert(0, literal);
                    }
                    Ok(unique(candidates).into_iter().take(3).collect::<Vec<_>>())
                }
            }))
            .await
            .into_iter()
            .collect::<Result<Vec<Vec<Candidate>>, String>>()?;
            let mut combined = vec![Candidate {
                command: String::new(),
                score: 110.0,
                changes: vec!["Pipeline commands".into()],
                literal: None,
            }];
            for group in groups {
                let mut next = Vec::new();
                for prefix in &combined {
                    for candidate in &group {
                        let mut changes = prefix.changes.clone();
                        changes.extend(candidate.changes.clone());
                        next.push(Candidate {
                            command: if prefix.command.is_empty() {
                                candidate.command.clone()
                            } else {
                                format!("{} | {}", prefix.command, candidate.command)
                            },
                            score: prefix.score.min(candidate.score),
                            changes,
                            literal: None,
                        });
                    }
                }
                sort(&mut next);
                next.truncate(3);
                combined = next;
            }
            combined.push(Candidate::literal(input));
            return Ok(combined);
        }
        let mut compound = compound_alternatives(input, catalog, env, discovery, host).await?;
        if !compound.is_empty() {
            compound.push(Candidate::literal(input));
            return Ok(compound);
        }
        let alternatives = symbol_alternatives(input);
        if alternatives.is_empty() {
            return suggest_one(input, catalog, env, discovery, host, stage, input).await;
        }
        let texts: Vec<_> = std::iter::once(input.to_owned())
            .chain(alternatives)
            .collect();
        let groups = join_all(texts.iter().enumerate().map(|(index, text)| async move {
            if index > 0 && test(r#"[|&;<>()`$\\*?"'!\[\]{}#^]"#, text) {
                let words = tokens(text);
                let first = words.first();
                let canonical = catalog.commands.iter().find(|command| {
                    first.is_some_and(|word| command.to_lowercase() == word.value.to_lowercase())
                });
                let candidate = Candidate {
                    command: if let (Some(canonical), Some(first)) = (canonical, first) {
                        format!("{canonical}{}", &text[first.value.len()..])
                    } else {
                        text.clone()
                    },
                    score: 90.0,
                    changes: vec!["Spoken symbols".into()],
                    literal: None,
                };
                let metadata = discovery.cached(catalog, env, host.now_ms());
                return Ok(
                    if candidate_valid(input, &candidate, catalog, env, &metadata, host, None)
                        .await?
                    {
                        vec![candidate]
                    } else {
                        vec![]
                    },
                );
            }
            suggest_one(text, catalog, env, discovery, host, stage, input).await
        }))
        .await
        .into_iter()
        .collect::<Result<Vec<Vec<Candidate>>, String>>()?;
        let mut candidates = Vec::new();
        for (index, group) in groups.into_iter().enumerate() {
            for mut candidate in group {
                if candidate.is_literal() || candidate.command == input.trim() {
                    continue;
                }
                if index > 0 {
                    candidate.score -= 12.0;
                    candidate
                        .changes
                        .insert(0, "Spoken symbol alternative".into());
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
    if let Some(mut files) = repair_input_file(input, catalog, home, host, spoken_input).await? {
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
    let catalog = nearby_file_paths(input, catalog, host).await;
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
    let previous_metadata = metadata.clone();
    let discoveries = join_all(
        targets
            .iter()
            .map(|target| discovery.discover(target, &catalog, env, host)),
    )
    .await
    .into_iter()
    .collect::<Result<Vec<_>, String>>()?;
    let mut script_flags = None;
    for found in discoveries {
        metadata.merge(found.metadata);
        if script_flags.is_none() {
            script_flags = found.script_flags;
        }
    }
    *stage.borrow_mut() = Some("discovery".into());
    let repairs = if script_flags.is_none() && previous_metadata == metadata {
        preliminary_repairs
    } else {
        repair(input, &catalog, script_flags.as_deref(), &metadata)
    };
    let completed =
        complete_arguments(input, &catalog, &metadata, host, script_flags.as_deref()).await?;
    let mut candidates = check(
        input,
        completed
            .into_iter()
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
