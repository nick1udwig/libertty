//! Negotiated transport encoding; logical session messages keep their contracts.
use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::{Compression, write::GzEncoder};
use serde_json::{Value, json};
use std::io::Write;

pub const BINARY: &str = "termai.binary.v1";
pub const GZIP: &str = "termai.gzip.v1";
pub const GZIP_FAST: &str = "termai.gzip-fast.v1";
pub const MAX_DECODED: usize = 2 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Json,
    Binary,
    Gzip,
    JsonGzip,
    GzipFast,
}
impl Mode {
    pub fn protocol(protocol: Option<&str>) -> Self {
        match protocol {
            Some(GZIP) => Self::Gzip,
            Some(GZIP_FAST) => Self::GzipFast,
            Some(BINARY) => Self::Binary,
            _ => Self::Json,
        }
    }
}
pub struct Encoded {
    pub binary: bool,
    pub bytes: Vec<u8>,
}
pub fn gzip(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(bytes).ok()?;
    encoder.finish().ok()
}
pub fn encode(value: &Value, mode: Mode) -> Encoded {
    if mode == Mode::Json {
        return Encoded {
            binary: false,
            bytes: serde_json::to_vec(value).expect("wire message"),
        };
    }
    let mut bytes = vec![b'T', b'M', 1, 0];
    match value["type"].as_str() {
        Some("output")
            if mode != Mode::JsonGzip
                && crate::protocol::unsigned(&value["seq"]).is_some()
                && value["data"].is_string() =>
        {
            bytes[3] = 1;
            bytes.extend_from_slice(
                &(crate::protocol::unsigned(&value["seq"]).unwrap() as f64).to_le_bytes(),
            );
            bytes.extend_from_slice(value["data"].as_str().unwrap().as_bytes());
        }
        Some("herdr-frame") if mode != Mode::JsonGzip => {
            let frame = crate::protocol::unsigned(&value["width"])
                .zip(crate::protocol::unsigned(&value["height"]))
                .filter(|(w, h)| *w <= u16::MAX as u64 && *h <= u16::MAX as u64)
                .zip(value["full"].as_bool())
                .zip(
                    value["bytes"]
                        .as_str()
                        .and_then(|bytes| STANDARD.decode(bytes).ok()),
                );
            if let Some((((width, height), full), data)) = frame {
                bytes[3] = 2;
                if let Some(seq) = crate::protocol::unsigned(&value["seq"]) {
                    bytes[3] = 7;
                    bytes.extend_from_slice(&(seq as f64).to_le_bytes());
                }
                bytes.extend_from_slice(&(width as u16).to_le_bytes());
                bytes.extend_from_slice(&(height as u16).to_le_bytes());
                bytes.push(u8::from(full));
                bytes.extend_from_slice(&data);
            } else {
                bytes.extend_from_slice(&serde_json::to_vec(value).expect("wire message"));
            }
        }
        _ => bytes.extend_from_slice(&serde_json::to_vec(value).expect("wire message")),
    }
    // Compress only negotiated bulk traffic; individual messages have no shared
    // dictionary, and incompressible payloads retain the simpler representation.
    if matches!(mode, Mode::Gzip | Mode::JsonGzip | Mode::GzipFast)
        && bytes.len()
            >= if mode == Mode::GzipFast {
                128 * 1024
            } else {
                2048
            }
    {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        if encoder.write_all(&bytes[4..]).is_ok()
            && let Ok(compressed) = encoder.finish()
            && compressed.len() + 4 < bytes.len() * 7 / 8
        {
            bytes.truncate(4);
            bytes[3] |= 128;
            bytes.extend_from_slice(&compressed);
        }
    }
    Encoded {
        binary: true,
        bytes,
    }
}
pub enum Incoming<T = Value> {
    Message(T),
    Audio(Vec<u8>),
}
pub fn decode(bytes: &[u8]) -> Result<Incoming, String> {
    decode_as(bytes)
}
pub fn decode_as<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<Incoming<T>, String> {
    if bytes.len() > MAX_DECODED {
        return Err("Wire message exceeded its limit.".into());
    }
    if bytes.len() < 4 || bytes[..3] != [b'T', b'M', 1] {
        return Err("Invalid wire header.".into());
    }
    let payload = &bytes[4..];
    let text = || std::str::from_utf8(payload).map_err(|_| "Invalid wire UTF-8.".to_owned());
    let integer = |data: &[u8]| -> Result<f64, String> {
        let value = f64::from_le_bytes(data.try_into().map_err(|_| "Invalid wire integer.")?);
        if value.is_finite()
            && value >= 0.0
            && value.fract() == 0.0
            && value <= 9_007_199_254_740_991.0
        {
            Ok(value)
        } else {
            Err("Invalid wire integer.".into())
        }
    };
    match bytes[3] {
        0 => Ok(Incoming::Message(
            serde_json::from_slice(payload).map_err(|e| e.to_string())?,
        )),
        3 => Ok(Incoming::Message(
            serde_json::from_value(json!({"type":"input","data":text()?}))
                .map_err(|error| error.to_string())?,
        )),
        4 if payload.len() == 8 => Ok(Incoming::Message(
            serde_json::from_value(json!({"type":"ack","seq":integer(payload)?}))
                .map_err(|error| error.to_string())?,
        )),
        5 if payload.len() == 5 && payload[4] <= 2 => {
            let mut message = json!({"type":"resize","cols":u16::from_le_bytes(payload[..2].try_into().unwrap()),"rows":u16::from_le_bytes(payload[2..4].try_into().unwrap())});
            if payload[4] < 2 {
                message["mobile"] = json!(payload[4] == 1);
            }
            Ok(Incoming::Message(
                serde_json::from_value(message).map_err(|error| error.to_string())?,
            ))
        }
        6 => Ok(Incoming::Audio(payload.to_vec())),
        _ => Err("Unsupported incoming wire message.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn output_frames_and_compression_preserve_exact_bytes_and_sequence() {
        let value = json!({"type":"output","seq":9_007_199_254_740_991u64,"data":"\u{1b}[32mhello 世界\r\n".repeat(1000)});
        for mode in [Mode::Json, Mode::Binary, Mode::Gzip, Mode::JsonGzip] {
            let wire = encode(&value, mode);
            if mode == Mode::Json {
                assert_eq!(serde_json::from_slice::<Value>(&wire.bytes).unwrap(), value);
                continue;
            }
            let mut payload = wire.bytes[4..].to_vec();
            if wire.bytes[3] & 128 != 0 {
                payload.clear();
                flate2::read::GzDecoder::new(&wire.bytes[4..])
                    .read_to_end(&mut payload)
                    .unwrap();
            }
            if wire.bytes[3] & 127 == 0 {
                assert_eq!(serde_json::from_slice::<Value>(&payload).unwrap(), value);
            } else {
                assert_eq!(
                    f64::from_le_bytes(payload[..8].try_into().unwrap()),
                    9_007_199_254_740_991.0
                );
                assert_eq!(&payload[8..], value["data"].as_str().unwrap().as_bytes());
            }
        }
        let frame = json!({"type":"herdr-frame","width":40,"height":30,"full":true,"bytes":STANDARD.encode([0,27,128,255])});
        assert_eq!(
            encode(&frame, Mode::Binary).bytes,
            [b'T', b'M', 1, 2, 40, 0, 30, 0, 1, 0, 27, 128, 255]
        );
    }
    #[test]
    fn acknowledged_frames_keep_the_sequence_in_the_compact_envelope() {
        let frame = json!({"type":"herdr-frame","seq":42,"width":40,"height":30,"full":false,"bytes":STANDARD.encode([27,0,255])});
        let encoded = encode(&frame, Mode::Binary);
        assert_eq!(encoded.bytes[3], 7);
        assert_eq!(
            f64::from_le_bytes(encoded.bytes[4..12].try_into().unwrap()),
            42.0
        );
        assert_eq!(&encoded.bytes[12..], &[40, 0, 30, 0, 0, 27, 0, 255]);
    }
    #[test]
    fn compact_inputs_keep_audio_separate_and_reject_invalid_messages() {
        let mut input = vec![b'T', b'M', 1, 3];
        input.extend_from_slice("世界\r".as_bytes());
        assert!(
            matches!(decode(&input).unwrap(),Incoming::Message(value) if value["data"]=="世界\r")
        );
        assert!(
            matches!(decode(&[b'T',b'M',1,6,0,255]).unwrap(),Incoming::Audio(bytes) if bytes==[0,255])
        );
        for invalid in [
            vec![],
            vec![b'T', b'M', 2, 3],
            vec![b'T', b'M', 1, 1],
            vec![b'T', b'M', 1, 4],
            vec![b'T', b'M', 1, 3, 255],
        ] {
            assert!(decode(&invalid).is_err());
        }
        let mut ack = vec![b'T', b'M', 1, 4];
        ack.extend_from_slice(&f64::NAN.to_le_bytes());
        assert!(decode(&ack).is_err());
    }
}
