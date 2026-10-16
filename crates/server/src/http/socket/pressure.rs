use crate::wire;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

const SLOW_ACK: Duration = Duration::from_millis(100);
const HOLD: Duration = Duration::from_secs(10);
const MAX_TRACKED: usize = 256;

#[derive(Default)]
pub(super) struct Pressure {
    outstanding: VecDeque<(u64, Instant)>,
    latest: u64,
    until: Option<Instant>,
}
impl Pressure {
    fn slow(&mut self, now: Instant) {
        self.until = Some(now + HOLD);
    }
    pub fn mode(&mut self, negotiated: wire::Mode, queued: bool, now: Instant) -> wire::Mode {
        if negotiated != wire::Mode::GzipFast {
            return negotiated;
        }
        if queued
            || self
                .outstanding
                .front()
                .is_some_and(|(_, sent)| now.duration_since(*sent) >= SLOW_ACK)
        {
            self.slow(now);
        }
        if self.until.is_some_and(|until| now < until) {
            wire::Mode::Gzip
        } else {
            negotiated
        }
    }
    /// Records a sent message; only acknowledged output and frames carry a sequence.
    pub fn sent(&mut self, sequence: Option<u64>, started: Instant, now: Instant) {
        if now.duration_since(started) >= Duration::from_millis(50) {
            self.slow(now);
        }
        let Some(seq) = sequence else {
            return;
        };
        self.latest = seq;
        self.outstanding.push_back((seq, started));
        if self.outstanding.len() > MAX_TRACKED {
            self.outstanding.pop_front();
            self.slow(now);
        }
    }
    pub fn acknowledge(&mut self, seq: u64, now: Instant) {
        if seq > self.latest {
            return;
        }
        while self.outstanding.front().is_some_and(|(at, _)| *at <= seq) {
            let (_, sent) = self.outstanding.pop_front().unwrap();
            if now.duration_since(sent) >= SLOW_ACK {
                self.slow(now);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn queue_pressure_compresses_bulk_without_changing_negotiated_compatibility() {
        let mut pressure = Pressure::default();
        let now = Instant::now();
        let message = json!({"type":"output","seq":1,"data":"log line\r\n".repeat(700)});
        let fast = pressure.mode(wire::Mode::GzipFast, false, now);
        assert_eq!(wire::encode(&message, fast).bytes[3] & 128, 0);
        let slow = pressure.mode(wire::Mode::GzipFast, true, now);
        assert_eq!(slow, wire::Mode::Gzip);
        let encoded = wire::encode(&message, slow);
        assert_ne!(encoded.bytes[3] & 128, 0);
        use std::io::Read;
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(&encoded.bytes[4..])
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(f64::from_le_bytes(decoded[..8].try_into().unwrap()), 1.0);
        assert_eq!(&decoded[8..], message["data"].as_str().unwrap().as_bytes());
        for mode in [wire::Mode::Json, wire::Mode::Binary, wire::Mode::Gzip] {
            assert_eq!(pressure.mode(mode, true, now), mode);
        }
        assert_eq!(
            pressure.mode(wire::Mode::GzipFast, false, now + HOLD),
            wire::Mode::GzipFast
        );
    }
    #[test]
    fn delayed_acks_and_blocked_writes_adapt_after_connection_and_recover() {
        let mut pressure = Pressure::default();
        let now = Instant::now();
        pressure.sent(Some(1), now, now);
        pressure.acknowledge(99, now + SLOW_ACK);
        assert_eq!(pressure.outstanding.len(), 1);
        assert_eq!(
            pressure.mode(wire::Mode::GzipFast, false, now + SLOW_ACK),
            wire::Mode::Gzip
        );
        pressure.acknowledge(1, now + SLOW_ACK);
        pressure.acknowledge(1, now + HOLD);
        assert_eq!(
            pressure.mode(wire::Mode::GzipFast, false, now + SLOW_ACK + HOLD),
            wire::Mode::GzipFast
        );
        pressure.sent(None, now + HOLD, now + HOLD + SLOW_ACK);
        assert_eq!(
            pressure.mode(wire::Mode::GzipFast, false, now + HOLD + SLOW_ACK),
            wire::Mode::Gzip
        );
        let mut fast = Pressure::default();
        fast.sent(Some(1), now, now);
        fast.acknowledge(1, now + Duration::from_millis(5));
        assert_eq!(
            fast.mode(wire::Mode::GzipFast, false, now + SLOW_ACK),
            wire::Mode::GzipFast
        );
    }
}
