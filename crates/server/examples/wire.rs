use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use termai_server::wire::{self, Mode};
fn main() {
    let mut output = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let mode = match request["mode"].as_str().unwrap() {
            "json" => Mode::Json,
            "binary" => Mode::Binary,
            "gzip" => Mode::Gzip,
            "gzip-fast" => Mode::GzipFast,
            "json-gzip" => Mode::JsonGzip,
            _ => panic!("mode"),
        };
        let start = std::time::Instant::now();
        let encoded = wire::encode(&request["value"], mode);
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        writeln!(output,"{}",json!({"binary":encoded.binary,"bytes":STANDARD.encode(&encoded.bytes),"length":encoded.bytes.len(),"encodeMs":elapsed})).unwrap();
        output.flush().unwrap();
    }
}
