use std::io::Read;

// The external Herdr test driver uses the production Rust normalizer.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let raw = serde_json::from_str(&input)?;
    println!("{}", termai_server::herdr::normalize(&raw)?);
    Ok(())
}
