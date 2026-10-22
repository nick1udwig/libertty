//! Negotiated transport encoding; logical session messages keep their contracts.
use crate::protocol::{ClientMessage, MAX_INPUT, MAX_SAFE_INTEGER};
use flate2::{Compression, write::GzEncoder};
use libertty_engine::utf16_len;
use std::io::Write;

pub const BINARY: &str = "libertty.binary.v1";
pub const GZIP: &str = "libertty.gzip.v1";
pub const GZIP_FAST: &str = "libertty.gzip-fast.v1";
pub const MAX_DECODED: usize = 2 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Binary,
    Gzip,
    GzipFast,
}
impl Mode {
    pub fn protocol(protocol: Option<&str>) -> Self {
        match protocol {
            Some(GZIP) => Self::Gzip,
            Some(GZIP_FAST) => Self::GzipFast,
            Some(BINARY) => Self::Binary,
            _ => Self::Binary,
        }
    }
}
pub fn gzip(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(bytes).ok()?;
    encoder.finish().ok()
}
/// The compact JSON length, counted without building the string.
pub fn json_len<T: serde::Serialize + ?Sized>(value: &T) -> usize {
    struct Count(usize);
    impl Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    serde_json::to_writer(&mut count, value).expect("wire message");
    count.0
}
/// Typed messages place terminal text and raw frame bytes directly in their envelope.
pub fn encode_server(message: &crate::protocol::ServerMessage, mode: Mode) -> Vec<u8> {
    use crate::protocol::ServerMessage;
    let mut bytes = vec![b'T', b'M', 1, 0];
    match message {
        ServerMessage::Output { seq, data } => {
            bytes[3] = 1;
            bytes.extend_from_slice(&(*seq as f64).to_le_bytes());
            bytes.extend_from_slice(data.as_bytes());
        }
        ServerMessage::HerdrFrame(frame) => {
            bytes[3] = 7;
            bytes.extend_from_slice(&(frame.seq.expect("acknowledged frame") as f64).to_le_bytes());
            bytes.extend_from_slice(&frame.width.to_le_bytes());
            bytes.extend_from_slice(&frame.height.to_le_bytes());
            bytes.push(u8::from(frame.full));
            bytes.extend_from_slice(&frame.bytes);
        }
        _ => return encode_json(message, mode),
    }
    compress(bytes, mode)
}
/// Any other message travels as JSON inside a compressible envelope.
pub fn encode_json<T: serde::Serialize + ?Sized>(message: &T, mode: Mode) -> Vec<u8> {
    let mut bytes = vec![b'T', b'M', 1, 0];
    serde_json::to_writer(&mut bytes, message).expect("wire message");
    compress(bytes, mode)
}
fn compress(mut bytes: Vec<u8>, mode: Mode) -> Vec<u8> {
    // Compress only negotiated bulk traffic; individual messages have no shared
    // dictionary, and incompressible payloads retain the simpler representation.
    let threshold = if mode == Mode::GzipFast {
        128 * 1024
    } else {
        2048
    };
    if mode != Mode::Binary
        && bytes.len() >= threshold
        && let Some(compressed) = gzip(&bytes[4..])
        && compressed.len() + 4 < bytes.len() * 7 / 8
    {
        bytes.truncate(4);
        bytes[3] |= 128;
        bytes.extend_from_slice(&compressed);
    }
    bytes
}
pub enum Incoming {
    Message(ClientMessage),
    Audio(Vec<u8>),
}
pub fn decode(bytes: &[u8]) -> Result<Incoming, String> {
    if bytes.len() > MAX_DECODED {
        return Err("Wire message exceeded its limit.".into());
    }
    if bytes.len() < 4 || bytes[..3] != [b'T', b'M', 1] {
        return Err("Invalid wire header.".into());
    }
    let payload = &bytes[4..];
    let text = |data: &[u8]| {
        std::str::from_utf8(data)
            .ok()
            .filter(|text| utf16_len(text) <= MAX_INPUT)
            .map(str::to_owned)
            .ok_or_else(|| "Invalid wire text.".to_owned())
    };
    let integer = |data: &[u8]| -> Result<u64, String> {
        let value = f64::from_le_bytes(data.try_into().map_err(|_| "Invalid wire integer.")?);
        if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= MAX_SAFE_INTEGER {
            Ok(value as u64)
        } else {
            Err("Invalid wire integer.".into())
        }
    };
    let size = |data: &[u8]| u16::from_le_bytes([data[0], data[1]]);
    Ok(Incoming::Message(match bytes[3] {
        0 => serde_json::from_slice(payload).map_err(|e| e.to_string())?,
        3 => ClientMessage::Input {
            data: text(payload)?,
            seq: None,
        },
        4 if payload.len() == 8 => ClientMessage::Ack {
            seq: integer(payload)?,
        },
        5 if payload.len() == 5 && payload[4] <= 2 => ClientMessage::Resize {
            cols: size(&payload[..2]),
            rows: size(&payload[2..4]),
            mobile: (payload[4] < 2).then_some(payload[4] == 1),
        },
        6 => return Ok(Incoming::Audio(payload.to_vec())),
        8 if payload.len() >= 8 => ClientMessage::Input {
            data: text(&payload[8..])?,
            seq: Some(integer(&payload[..8])?),
        },
        _ => return Err("Unsupported incoming wire message.".into()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{HerdrFrame, ServerMessage};
    use serde_json::Value;
    use std::io::Read;
    fn payload(wire: &[u8]) -> Vec<u8> {
        if wire[3] & 128 == 0 {
            return wire[4..].to_vec();
        }
        let mut payload = vec![];
        flate2::read::GzDecoder::new(&wire[4..])
            .read_to_end(&mut payload)
            .unwrap();
        payload
    }
    #[test]
    fn output_frames_and_compression_preserve_exact_bytes_and_sequence() {
        let data = "\u{1b}[32mhello 世界\r\n".repeat(1000);
        let output = ServerMessage::Output {
            seq: 9_007_199_254_740_991,
            data: data.as_str().into(),
        };
        for mode in [Mode::Binary, Mode::Gzip] {
            let wire = encode_server(&output, mode);
            let payload = payload(&wire);
            if wire[3] & 127 == 0 {
                assert_eq!(
                    serde_json::from_slice::<Value>(&payload).unwrap(),
                    output.value()
                );
            } else {
                assert_eq!(
                    f64::from_le_bytes(payload[..8].try_into().unwrap()),
                    9_007_199_254_740_991.0
                );
                assert_eq!(&payload[8..], data.as_bytes());
            }
        }
        let frame = ServerMessage::HerdrFrame(HerdrFrame {
            seq: Some(1),
            width: 40,
            height: 30,
            full: true,
            bytes: [0, 27, 128, 255].into(),
        });
        assert_eq!(
            encode_server(&frame, Mode::Binary),
            [
                b'T', b'M', 1, 7, 0, 0, 0, 0, 0, 0, 240, 63, 40, 0, 30, 0, 1, 0, 27, 128, 255
            ]
        );
    }
    #[test]
    fn json_envelopes_carry_the_logical_message_in_declaration_order() {
        let output = ServerMessage::Output {
            seq: 42,
            data: "\u{1b}[32mhello 世界\r\n".repeat(20000).into(),
        };
        assert_eq!(json_len(&output.value()), output.value().to_string().len());
        for message in [
            ServerMessage::Pong,
            ServerMessage::ReadingError {
                message: "日本語 ".repeat(1000),
            },
        ] {
            let value = message.value();
            assert_eq!(json_len(&value), value.to_string().len());
            for mode in [Mode::Binary, Mode::Gzip] {
                let envelope = encode_server(&message, mode);
                assert_eq!(envelope[3] & 127, 0);
                assert_eq!(
                    serde_json::from_slice::<Value>(&payload(&envelope)).unwrap(),
                    value
                );
            }
        }
    }
    #[test]
    fn acknowledged_frames_keep_the_sequence_in_the_compact_envelope() {
        let frame = ServerMessage::HerdrFrame(HerdrFrame {
            seq: Some(42),
            width: 40,
            height: 30,
            full: false,
            bytes: [27, 0, 255].into(),
        });
        let encoded = encode_server(&frame, Mode::Binary);
        assert_eq!(encoded[3], 7);
        assert_eq!(f64::from_le_bytes(encoded[4..12].try_into().unwrap()), 42.0);
        assert_eq!(&encoded[12..], &[40, 0, 30, 0, 0, 27, 0, 255]);
    }
    #[test]
    fn compact_inputs_keep_audio_separate_and_reject_invalid_messages() {
        let mut input = vec![b'T', b'M', 1, 3];
        input.extend_from_slice("世界\r".as_bytes());
        assert!(matches!(
            decode(&input).unwrap(),
            Incoming::Message(ClientMessage::Input { data, seq: None }) if data == "世界\r"
        ));
        assert!(
            matches!(decode(&[b'T',b'M',1,6,0,255]).unwrap(),Incoming::Audio(bytes) if bytes==[0,255])
        );
        let mut numbered = vec![b'T', b'M', 1, 8];
        numbered.extend_from_slice(&7.0f64.to_le_bytes());
        numbered.extend_from_slice("界".as_bytes());
        assert!(matches!(
            decode(&numbered).unwrap(),
            Incoming::Message(ClientMessage::Input { data, seq: Some(7) }) if data == "界"
        ));
        assert!(matches!(
            decode(&[b'T', b'M', 1, 5, 80, 0, 24, 0, 1]).unwrap(),
            Incoming::Message(ClientMessage::Resize {
                cols: 80,
                rows: 24,
                mobile: Some(true)
            })
        ));
        let mut oversized = vec![b'T', b'M', 1, 3];
        oversized.extend_from_slice("x".repeat(MAX_INPUT + 1).as_bytes());
        for invalid in [
            vec![],
            vec![b'T', b'M', 2, 3],
            vec![b'T', b'M', 1, 1],
            vec![b'T', b'M', 1, 4],
            vec![b'T', b'M', 1, 3, 255],
            vec![b'T', b'M', 1, 8, 0],
            oversized,
        ] {
            assert!(decode(&invalid).is_err());
        }
        let mut ack = vec![b'T', b'M', 1, 4];
        ack.extend_from_slice(&f64::NAN.to_le_bytes());
        assert!(decode(&ack).is_err());
    }
}
