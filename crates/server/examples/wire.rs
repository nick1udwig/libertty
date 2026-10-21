use base64::{Engine, engine::general_purpose::STANDARD};
use libertty_server::{
    protocol::{HerdrFrame, ServerMessage},
    wire::{self, Mode},
};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
/// Terminal output and Herdr frames use the server's typed encoding; other payloads are plain JSON messages.
fn message(value: &Value) -> Option<ServerMessage> {
    let seq = value["seq"].as_u64()?;
    match value["type"].as_str()? {
        "output" => Some(ServerMessage::Output {
            seq,
            data: value["data"].as_str()?.into(),
        }),
        "herdr-frame" => Some(ServerMessage::HerdrFrame(HerdrFrame {
            seq: Some(seq),
            width: value["width"].as_u64()? as u16,
            height: value["height"].as_u64()? as u16,
            full: value["full"].as_bool()?,
            bytes: STANDARD.decode(value["bytes"].as_str()?).ok()?.into(),
        })),
        _ => None,
    }
}
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
        let typed = message(&request["value"]);
        let start = std::time::Instant::now();
        let encoded = match &typed {
            Some(message) => wire::encode_server(message, mode),
            None => wire::encode_json(&request["value"], mode),
        };
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        writeln!(output,"{}",json!({"binary":encoded.binary,"bytes":STANDARD.encode(&encoded.bytes),"length":encoded.bytes.len(),"encodeMs":elapsed})).unwrap();
        output.flush().unwrap();
    }
}
