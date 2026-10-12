// Exercised only with synthetic fixtures in an isolated temporary directory.
use serde_json::{Value, json};
use std::{fs, path::PathBuf};
use termai_server::{pairing::Pairings, vault::Vault};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Supply the synthetic state directory.")?,
    );
    let fixture: Value = serde_json::from_slice(&fs::read(directory.join("fixture.json"))?)?;
    if fixture["synthetic"] != true {
        return Err("Only synthetic fixtures are accepted.".into());
    }
    let vault = Vault::new(&directory);
    let mut checks = Vec::new();
    for case in fixture["vault"]["cases"]
        .as_array()
        .ok_or("Missing cases")?
    {
        let id = case["id"].as_str().ok_or("Missing id")?;
        let password = case["passphrase"].as_str().ok_or("Missing password")?;
        let raw = case["privateKey"].as_str().ok_or("Missing key")?;
        if *vault.unlock(id, password)? != raw.as_bytes() {
            return Err("Reference private key mismatch.".into());
        }
        let refreshed = vault.create("Rust refreshed fixture", password, Some(raw), Some(id))?;
        checks.push(json!({"id":refreshed.id,"passphrase":password,"privateKey":raw}));
    }
    let generated = vault.create(
        "Rust generated fixture",
        "synthetic-rust-password",
        None,
        None,
    )?;
    let bytes = vault.unlock(&generated.id, "synthetic-rust-password")?;
    checks.push(json!({"id":generated.id,"passphrase":"synthetic-rust-password","privateKey":std::str::from_utf8(&bytes)?}));
    let token = fixture["pairing"]["token"]
        .as_str()
        .ok_or("Missing token")?;
    let credential = fixture["pairing"]["credential"]
        .as_str()
        .ok_or("Missing credential")?;
    let mut pairings = Pairings::open(&directory, token)?;
    if !pairings.has(credential) {
        return Err("Reference pairing was not restored.".into());
    }
    let next = pairings.issue()?;
    fs::write(
        directory.join("rust-results.json"),
        serde_json::to_vec(&json!({"keys":checks,"credential":next}))?,
    )?;
    Ok(())
}
