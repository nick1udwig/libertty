pub fn resolve(parts: &[&str]) -> String {
    let mut result = Vec::new();
    for part in parts {
        if part.starts_with('/') {
            result.clear();
        }
        for component in part.split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    result.pop();
                }
                _ => result.push(component),
            }
        }
    }
    format!("/{}", result.join("/"))
}
pub fn join(parts: &[&str]) -> String {
    resolve(&[&parts
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/")])
}
pub fn basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .into()
}
pub fn dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", _)) => "/".into(),
        Some((parent, _)) => parent.trim_end_matches('/').to_owned(),
        None => {
            if path.starts_with('/') {
                "/".into()
            } else {
                ".".into()
            }
        }
    }
}
