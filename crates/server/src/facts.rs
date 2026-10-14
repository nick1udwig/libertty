use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use termai_engine::types::Catalog;

pub fn digest(value: &Value) -> String {
    Sha256::digest(serde_json::to_vec(value).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub fn context_key(
    prompt: u64,
    catalog: &Catalog,
    environment: &std::collections::BTreeMap<String, String>,
) -> String {
    digest(&json!([prompt, catalog.cwd, environment]))
}
