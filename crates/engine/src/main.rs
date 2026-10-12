use std::io::{self, BufRead, Write};
const LIMIT: usize = termai_engine::INPUT_LIMIT;
fn frame(input: &mut impl BufRead) -> io::Result<Option<Result<Vec<u8>, ()>>> {
    let mut bytes = Vec::new();
    let mut exceeded = false;
    loop {
        let chunk = input.fill_buf()?;
        if chunk.is_empty() {
            return Ok(if bytes.is_empty() && !exceeded {
                None
            } else if exceeded {
                Some(Err(()))
            } else {
                Some(Ok(bytes))
            });
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(chunk.len(), |at| at + 1);
        if !exceeded {
            if bytes.len() + count > LIMIT + 1 {
                bytes.clear();
                exceeded = true;
            } else {
                bytes.extend_from_slice(&chunk[..count]);
            }
        }
        input.consume(count);
        if newline.is_some() {
            if exceeded {
                return Ok(Some(Err(())));
            }
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return Ok(Some(if bytes.len() > LIMIT {
                Err(())
            } else {
                Ok(bytes)
            }));
        }
    }
}
fn main() -> io::Result<()> {
    let mut output = io::BufWriter::new(io::stdout().lock());
    let mut input = io::BufReader::new(io::stdin().lock());
    let asynchronous = std::env::args().any(|argument| argument == "--runtime");
    let mut runtime = termai_engine::runtime::Runtime::default();
    while let Some(line) = frame(&mut input)? {
        let response = match line {
            Ok(bytes) if asynchronous => {
                let message: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
                if message
                    .get("cancel")
                    .and_then(serde_json::Value::as_u64)
                    .is_some()
                {
                    if let Some(id) = message["cancel"]
                        .as_u64()
                        .and_then(|id| u32::try_from(id).ok())
                    {
                        runtime.cancel(id);
                    }
                    continue;
                }
                if message.get("reset").and_then(serde_json::Value::as_bool) == Some(true) {
                    runtime.reset();
                    continue;
                }
                serde_json::to_vec(&termai_engine::runtime::message(
                    &mut runtime,
                    &bytes,
                    message.get("replies").is_some(),
                ))
                .expect("runtime step")
            }
            Ok(bytes) => termai_engine::exchange(&bytes),
            Err(()) => br#"{"ok":false,"error":"Engine request exceeds 64 MiB."}"#.to_vec(),
        };
        output.write_all(&response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}
