use crate::{
    host::{self, Host},
    path,
    repair::{completion_score, shell_quote, similarity},
    types::{Candidate, Catalog, DirectoryEntry},
    util::locale_cmp,
};
use crate::{
    speech::expand_symbols,
    util::{regex, replace, test, utf16_len},
};
use futures::future::join_all;
use serde::{Deserialize, Serialize};

#[derive(Clone)]
struct Branch {
    actual: String,
    rendered: String,
    score: f64,
}
fn components<'a>(
    spoken: &str,
    entries: &'a [DirectoryEntry],
    complete: bool,
) -> Vec<(&'a DirectoryEntry, f64)> {
    let entries: Vec<_> = entries
        .iter()
        .filter(|entry| entry.directory || entry.symlink)
        .collect();
    let scores: Vec<_> = entries
        .iter()
        .map(|entry| similarity(spoken, &entry.name))
        .collect();
    let completion = complete && scores.iter().all(|score| *score == 0.0);
    let folded: Vec<_> = spoken.to_lowercase().encode_utf16().collect();
    entries
        .into_iter()
        .zip(scores)
        .map(|(entry, score)| {
            let mut score = if completion {
                completion_score(spoken, &entry.name)
            } else {
                score
            };
            if score == 0.0 && folded.len() >= 3 {
                let name = entry.name.to_lowercase();
                if folded.len() == name.encode_utf16().count()
                    && folded
                        .iter()
                        .copied()
                        .zip(name.encode_utf16())
                        .filter(|(a, b)| a != b)
                        .count()
                        == 1
                {
                    score = 62.0;
                }
            }
            (entry, score)
        })
        .collect()
}
fn make_candidate(request: &DirectoryInput, branch: Branch) -> Candidate {
    let rendered = if branch.rendered == "/" {
        "/"
    } else {
        branch.rendered.trim_end_matches('/')
    };
    let rendered = if rendered.is_empty() { "." } else { rendered };
    let argument = if request.quoted {
        format!("'{}'", rendered.replace('\'', "'\\''"))
    } else {
        shell_quote(rendered)
    };
    Candidate {
        command: format!("{} {}{}", request.command, request.options, argument),
        score: 110.0 + branch.score / request.parts.len().max(1) as f64,
        changes: vec!["Path verified against existing directories".into()],
        literal: None,
    }
}
pub async fn repair_directory(
    input: &str,
    catalog: &Catalog,
    home: &str,
    host: &dyn Host,
) -> Result<Option<Vec<Candidate>>, String> {
    let Some(request) = directory_input(input) else {
        return Ok(None);
    };
    if !catalog.commands.contains(&request.command) || request.from_home && home.is_empty() {
        return Ok(None);
    }
    let start = if request.from_home {
        home
    } else if request.absolute {
        "/"
    } else {
        &catalog.cwd
    };
    let parts = &request.parts;
    let mut branches = vec![Branch {
        actual: start.into(),
        rendered: request.prefix.clone(),
        score: 0.0,
    }];
    if parts.len() > 1 && !parts.iter().any(|part| part == "." || part == "..") {
        let whole_path = path::join(&[start, &parts.join("/")]);
        let first_path = path::join(&[start, &parts[0]]);
        let (whole, first) = futures::join!(
            host::stat(host, &whole_path, true),
            host::lookup(host, &first_path)
        );
        let whole = whole?;
        first?;
        if let Some(whole) = whole {
            return Ok(Some(if whole.directory {
                let spelling: Vec<_> = whole
                    .spelling
                    .as_deref()
                    .map(|path| {
                        path.rsplit('/')
                            .take(parts.len())
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect()
                    })
                    .unwrap_or_else(|| parts.iter().map(String::as_str).collect());
                vec![make_candidate(
                    &request,
                    Branch {
                        actual: String::new(),
                        rendered: request.prefix.clone() + &spelling.join("/"),
                        score: 100.0 * parts.len() as f64,
                    },
                )]
            } else {
                vec![]
            }));
        }
    }
    let deadline = host.now_ms() + 1000.0;
    let reads = std::cell::Cell::new(0usize);
    for (index, part) in parts.iter().enumerate() {
        let groups = join_all(branches.iter().map(|branch| {
            let reads = &reads;
            let request = &request;
            async move {
                let read = reads.get();
                reads.set(read + 1);
                if host.now_ms() > deadline || read >= 48 {
                    return Ok(vec![]);
                }
                if part == "." || part == ".." {
                    return Ok(vec![Branch {
                        actual: path::resolve(&[&branch.actual, part]),
                        rendered: branch.rendered.clone() + part + "/",
                        score: branch.score + 100.0,
                    }]);
                }
                let actual = path::join(&[&branch.actual, part]);
                let lookup = host::lookup(host, &actual).await?;
                if let Some(info) = lookup.info {
                    let name = info
                        .spelling
                        .as_deref()
                        .and_then(|value| value.rsplit('/').next())
                        .filter(|value| !value.is_empty())
                        .unwrap_or(part);
                    return Ok(if info.directory {
                        vec![Branch {
                            actual: path::join(&[&branch.actual, name]),
                            rendered: branch.rendered.clone() + name + "/",
                            score: branch.score + 100.0,
                        }]
                    } else {
                        vec![]
                    });
                }
                let entries = lookup
                    .listing
                    .map(|listing| listing.entries)
                    .unwrap_or_default();
                let exact = entries.iter().find(|entry| entry.name == *part);
                let mut matches = if let Some(exact) = exact {
                    components(part, std::slice::from_ref(exact), false)
                } else if request.quoted {
                    vec![]
                } else {
                    components(part, &entries, index == parts.len() - 1)
                };
                matches.retain(|(_, score)| *score > 0.0);
                matches.sort_by(|(a, ascore), (b, bscore)| {
                    bscore
                        .total_cmp(ascore)
                        .then_with(|| locale_cmp(&a.name, &b.name))
                });
                matches.truncate(8);
                let found = join_all(matches.into_iter().map(|(entry, score)| async move {
                    let actual = path::join(&[&branch.actual, &entry.name]);
                    if !entry.directory
                        && !(entry.symlink
                            && host::stat(host, &actual, true)
                                .await?
                                .is_some_and(|info| info.directory))
                    {
                        return Ok(None);
                    }
                    Ok(Some(Branch {
                        actual,
                        rendered: branch.rendered.clone() + &entry.name + "/",
                        score: branch.score + score,
                    }))
                }))
                .await
                .into_iter()
                .collect::<Result<Vec<_>, String>>()?;
                Ok(found.into_iter().flatten().collect())
            }
        }))
        .await
        .into_iter()
        .collect::<Result<Vec<Vec<Branch>>, String>>()?;
        branches = groups.into_iter().flatten().collect();
        branches.sort_by(|a, b| b.score.total_cmp(&a.score));
        branches.truncate(4);
        if branches.is_empty() {
            break;
        }
    }
    if branches.is_empty()
        && request.from_home
        && !request.quoted
        && parts.len() == 1
        && parts[0]
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric())
            .count()
            >= 4
        && host.now_ms() < deadline
    {
        let requested = path::join(&[home, &parts[0]]);
        if host::stat(host, &requested, true).await?.is_some() {
            return Ok(Some(vec![]));
        }
        let root = host::lookup(host, &requested).await?;
        let mut parents = if let Some(listing) = root.listing {
            listing.entries
        } else {
            host::entries(host, home, 256).await?
        };
        parents.retain(|entry| !entry.name.starts_with('.') && (entry.directory || entry.symlink));
        parents.sort_by(|a, b| {
            b.symlink
                .cmp(&a.symlink)
                .then_with(|| utf16_len(&a.name).cmp(&utf16_len(&b.name)))
                .then_with(|| locale_cmp(&a.name, &b.name))
        });
        parents.truncate(16);
        let mut found = Vec::new();
        for group in parents.chunks(4) {
            if host.now_ms() >= deadline {
                break;
            }
            let groups = join_all(group.iter().map(|parent| async move {
                let parent_path = path::join(&[home, &parent.name]);
                let Ok(entries) = host::entries(host, &parent_path, 256).await else {
                    return Ok(vec![]);
                };
                let mut matches = components(&parts[0], &entries, false);
                matches.retain(|(_, score)| *score >= 64.0);
                matches.sort_by(|(_, a), (_, b)| b.total_cmp(a));
                matches.truncate(3);
                let valid = join_all(matches.into_iter().map(|(entry, score)| {
                    let parent_path = &parent_path;
                    async move {
                        let actual = path::join(&[parent_path, &entry.name]);
                        if !entry.directory
                            && !(entry.symlink
                                && host::stat(host, &actual, true)
                                    .await?
                                    .is_some_and(|info| info.directory))
                        {
                            return Ok(None);
                        }
                        Ok(Some(Branch {
                            actual,
                            rendered: format!("~/{}/{}", parent.name, entry.name),
                            score: score - 36.0,
                        }))
                    }
                }))
                .await
                .into_iter()
                .collect::<Result<Vec<_>, String>>()?;
                Ok(valid.into_iter().flatten().collect::<Vec<_>>())
            }))
            .await
            .into_iter()
            .collect::<Result<Vec<Vec<Branch>>, String>>()?;
            found.extend(groups.into_iter().flatten());
            if found.iter().any(|branch| branch.score >= 58.0) {
                break;
            }
        }
        found.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| utf16_len(&a.rendered).cmp(&utf16_len(&b.rendered)))
        });
        found.truncate(3);
        return Ok(Some(
            found
                .into_iter()
                .map(|branch| make_candidate(&request, branch))
                .collect(),
        ));
    }
    Ok(Some(
        branches
            .into_iter()
            .take(3)
            .map(|branch| make_candidate(&request, branch))
            .collect(),
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryInput {
    pub command: String,
    pub options: String,
    pub quoted: bool,
    pub from_home: bool,
    pub absolute: bool,
    pub prefix: String,
    pub parts: Vec<String>,
}
pub fn directory_input(input: &str) -> Option<DirectoryInput> {
    let expanded = expand_symbols(input, true);
    let expanded = expanded.trim();
    let matched = regex("(?i)^(cd|pushd|upload)\\s+(.*)$").captures(expanded)?;
    let mut target = matched[2].trim().to_owned();
    let mut options = String::new();
    if let Some(matched) = regex("^((?:(?:-[LPe]+|--)\\s+)+)(.+)$").captures(&target) {
        options = matched[1].into();
        target = matched[2].into();
    }
    if target.is_empty()
        || target == "-"
        || test(r"[|&;<>`$\\\n\r]", &target)
        || target.starts_with('-')
    {
        return None;
    }
    let quoted = test(r#"^("[^"]*"|'[^']*')$"#, &target);
    if target.contains(['\'', '"']) && !quoted {
        return None;
    }
    target = if quoted {
        target[1..target.len() - 1].into()
    } else {
        replace("\\s*/\\s*", &target, "/")
    };
    let from_home = !quoted && (target == "~" || target.starts_with("~/"));
    let absolute = target.starts_with('/');
    let prefix = if from_home {
        "~/"
    } else if absolute {
        "/"
    } else {
        ""
    }
    .to_owned();
    let path = if from_home {
        &target[1..]
    } else {
        target.as_str()
    };
    let parts: Vec<String> = path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    if parts.len() > 16 || utf16_len(&target) > 2000 {
        return None;
    }
    Some(DirectoryInput {
        command: matched[1].to_lowercase(),
        options,
        quoted,
        from_home,
        absolute,
        prefix,
        parts,
    })
}
