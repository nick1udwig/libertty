use crate::{
    host::{self, Host},
    path,
    repair::{directory_scores, shell_quote},
    speech::expand_symbols,
    types::{Candidate, Catalog},
    util::{regex, replace, test, utf16_len},
};
use futures::future::join_all;
use std::cell::Cell;

#[derive(Clone)]
struct Branch {
    actual: String,
    rendered: String,
    score: f64,
}

pub async fn repair_input_file(
    input: &str,
    catalog: &Catalog,
    home: &str,
    host: &dyn Host,
    spoken_input: &str,
) -> Result<Option<Vec<Candidate>>, String> {
    let expanded = expand_symbols(input, true);
    let expanded = expanded.trim();
    let Some(matched) = regex("(?i)^(download|cat)\\s+(.+)$").captures(expanded) else {
        return Ok(None);
    };
    let command = matched[1].to_lowercase();
    if !catalog.commands.contains(&command) {
        return Ok(None);
    }
    let mut operand = matched[2].to_owned();
    let mut options = String::new();
    if command == "download"
        && let Some(flags) = regex("^((?:(?:--file|--)\\s+)+)(.+)$").captures(&operand)
    {
        options = flags[1].into();
        operand = flags[2].into();
    }
    let quoted = test(r#"^("[^"]*"|'[^']*')$"#, &operand);
    if command == "cat"
        && (!operand.contains('/')
            || (test("\\s", &replace("\\s*/\\s*", &operand, "/"))
                && !quoted
                && !test("(?i)\\bslash\\b", spoken_input)))
    {
        return Ok(None);
    }
    if test(r"[|&;<>`$\\\n\r]", &operand)
        || (!options.contains("--") && operand.starts_with('-'))
        || (operand.contains(['\'', '"']) && !quoted)
    {
        return Ok(None);
    }
    operand = if quoted {
        operand[1..operand.len() - 1].into()
    } else {
        replace("\\s*/\\s*", &operand, "/")
    };
    let from_home = !quoted && (operand == "~" || operand.starts_with("~/"));
    let absolute = operand.starts_with('/');
    let prefix = if from_home {
        "~/"
    } else if absolute {
        "/"
    } else {
        ""
    };
    if from_home && home.is_empty() {
        return Ok(Some(vec![]));
    }
    let start = if from_home {
        home
    } else if absolute {
        "/"
    } else {
        &catalog.cwd
    };
    let parts: Vec<_> = (if from_home { &operand[1..] } else { &operand })
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() || parts.len() > 16 || utf16_len(&operand) > 2000 {
        return Ok(Some(vec![]));
    }
    let make = |rendered: &str, score: f64| Candidate {
        command: format!(
            "{command} {options}{}",
            if quoted {
                format!("'{}'", rendered.replace('\'', "'\\''"))
            } else {
                shell_quote(rendered)
            }
        ),
        score: 130.0 + score / parts.len() as f64,
        changes: vec!["File path verified against the filesystem".into()],
        literal: None,
    };
    let exact = host::stat(host, &path::join(&[start, &parts.join("/")]), true).await?;
    if let Some(exact) = &exact {
        if !exact.file {
            return Ok(Some(vec![]));
        }
        if exact.spelling.is_none() || !parts.iter().any(|part| [".", ".."].contains(part)) {
            let spelling = exact
                .spelling
                .as_deref()
                .map(|s| {
                    s.split('/')
                        .rev()
                        .take(parts.len())
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .unwrap_or_else(|| parts.join("/"));
            return Ok(Some(vec![make(
                &format!("{prefix}{spelling}"),
                100.0 * parts.len() as f64,
            )]));
        }
    }
    if quoted && exact.is_none() {
        return Ok(Some(vec![]));
    }
    let mut branches = vec![Branch {
        actual: start.into(),
        rendered: prefix.into(),
        score: 0.0,
    }];
    let reads = Cell::new(0usize);
    let until = host.now_ms() + 1500.0;
    for (i, part) in parts.iter().enumerate() {
        let last = i == parts.len() - 1;
        let groups = join_all(branches.iter().map(|branch| {
            let reads = &reads;
            async move {
                reads.set(reads.get() + 1);
                if reads.get() > 48 || host.now_ms() > until {
                    return Ok(vec![]);
                }
                let target = path::join(&[&branch.actual, part]);
                let lookup = host::lookup(host, &target).await?;
                let append = |name: &str, score: f64| Branch {
                    actual: path::join(&[&branch.actual, name]),
                    rendered: format!("{}{name}{}", branch.rendered, if last { "" } else { "/" }),
                    score: branch.score + score,
                };
                if let Some(info) = lookup.info {
                    let name = if [".", ".."].contains(part) {
                        part
                    } else {
                        info.spelling
                            .as_deref()
                            .and_then(|s| s.rsplit('/').next())
                            .filter(|s| !s.is_empty())
                            .unwrap_or(part)
                    };
                    return Ok(if if last { info.file } else { info.directory } {
                        vec![append(name, 100.0)]
                    } else {
                        vec![]
                    });
                }
                if quoted {
                    return Ok(vec![]);
                }
                let listing = lookup.listing.map(|l| l.entries).unwrap_or_default();
                let mut candidates: Vec<_> = directory_scores(part, &listing, !last, last, false)
                    .into_iter()
                    .map(|(entry, score)| (&entry.name, score))
                    .collect();
                candidates.retain(|(_, score)| *score >= 55.0);
                candidates.sort_by(|(_, a), (_, b)| b.total_cmp(a));
                candidates.truncate(4);
                let found = join_all(candidates.into_iter().map(|(name, score)| {
                    let append = &append;
                    async move {
                        let info =
                            host::stat(host, &path::join(&[&branch.actual, name]), true).await?;
                        Ok(info
                            .filter(|info| if last { info.file } else { info.directory })
                            .map(|_| append(name, score)))
                    }
                }))
                .await
                .into_iter()
                .collect::<Result<Vec<_>, String>>()?;
                Ok(found.into_iter().flatten().collect::<Vec<_>>())
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
    Ok(Some(
        branches
            .into_iter()
            .take(3)
            .map(|b| make(&b.rendered, b.score))
            .collect(),
    ))
}
