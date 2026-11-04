use crate::protocol::HerdrFrame;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

const WINDOW: usize = 2;
const MAX_PENDING: usize = 512 * 1024;

#[derive(Default)]
pub(super) struct Frames {
    /// The next frame to send, shared with the stream until a viewer falls behind.
    pending: Option<HerdrFrame>,
    /// Ordered deltas that arrived after the pending frame, joined once when it is sent.
    merged: Vec<u8>,
    outstanding: VecDeque<(u64, Instant, usize)>,
    latency: Option<Duration>,
    rate: Option<f64>,
    sequence: u64,
    full_size: usize,
    awaiting_full: bool,
    requested_full: bool,
}
impl Frames {
    /// Merge unsent ANSI in order, or ask the producer for a current baseline.
    pub fn push(&mut self, frame: HerdrFrame) -> bool {
        if frame.full {
            self.full_size = frame.bytes.len().clamp(1, MAX_PENDING);
            self.awaiting_full = false;
            self.requested_full = false;
            self.pending = Some(frame);
            self.merged.clear();
            return false;
        }
        if self.awaiting_full {
            return false;
        }
        let limit = if self.full_size == 0 {
            MAX_PENDING
        } else {
            self.full_size
        };
        if let Some(pending) = &self.pending {
            if pending.width != frame.width
                || pending.height != frame.height
                || pending.bytes.len() + self.merged.len() + frame.bytes.len() > limit
            {
                return self.refresh();
            }
            self.merged.extend_from_slice(&frame.bytes);
        } else if frame.bytes.len() > limit {
            return self.refresh();
        } else {
            self.pending = Some(frame);
        }
        false
    }
    fn refresh(&mut self) -> bool {
        self.pending = None;
        self.merged.clear();
        self.awaiting_full = true;
        self.request_snapshot()
    }
    fn request_snapshot(&mut self) -> bool {
        if self.awaiting_full
            && !self.requested_full
            && self.outstanding.len() < self.window(Instant::now())
        {
            self.requested_full = true;
            true
        } else {
            false
        }
    }
    fn window(&self, now: Instant) -> usize {
        if self.background_delay_at(now).is_zero() {
            WINDOW
        } else {
            1
        }
    }
    pub fn background_delay(&self) -> Duration {
        self.background_delay_at(Instant::now())
    }
    fn background_delay_at(&self, now: Instant) -> Duration {
        let latency = self.latency.unwrap_or_default();
        let queued = self.outstanding.front().is_some_and(|(_, sent, _)| {
            now.saturating_duration_since(*sent) > Duration::from_millis(500)
        });
        let slow = latency > Duration::from_millis(100)
            && self.rate.is_some_and(|rate| rate < 64.0 * 1024.0);
        if latency > Duration::from_millis(250) || queued || slow {
            (latency * 2).clamp(Duration::from_millis(1000), Duration::from_secs(3))
        } else {
            Duration::ZERO
        }
    }
    pub fn next(&mut self) -> Option<HerdrFrame> {
        self.next_at(Instant::now())
    }
    fn next_at(&mut self, now: Instant) -> Option<HerdrFrame> {
        if self.outstanding.len() >= self.window(now) {
            return None;
        }
        let mut frame = self.pending.take()?;
        if !self.merged.is_empty() {
            frame.bytes = [&*frame.bytes, &self.merged].concat().into();
            self.merged.clear();
        }
        self.sequence += 1;
        self.outstanding
            .push_back((self.sequence, now, frame.bytes.len()));
        frame.seq = Some(self.sequence);
        Some(frame)
    }
    pub fn acknowledge(&mut self, sequence: u64) -> bool {
        self.acknowledge_at(sequence, Instant::now())
    }
    fn acknowledge_at(&mut self, sequence: u64, now: Instant) -> bool {
        if sequence > self.sequence {
            return false;
        }
        while self
            .outstanding
            .front()
            .is_some_and(|(seq, _, _)| *seq <= sequence)
        {
            let (_, sent, bytes) = self.outstanding.pop_front().unwrap();
            let elapsed = now
                .saturating_duration_since(sent)
                .max(Duration::from_millis(1));
            self.latency = Some(
                self.latency
                    .map_or(elapsed, |old| old.mul_f64(0.75) + elapsed.mul_f64(0.25)),
            );
            if bytes >= 4096 {
                let rate = bytes as f64 / elapsed.as_secs_f64();
                self.rate = Some(self.rate.map_or(rate, |old| old * 0.75 + rate * 0.25));
            }
        }
        self.request_snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(full: bool, bytes: &[u8]) -> HerdrFrame {
        HerdrFrame {
            seq: None,
            width: 40,
            height: 30,
            full,
            bytes: bytes.into(),
        }
    }
    #[test]
    fn measured_delivery_reduces_pressure_and_recovers_when_the_link_improves() {
        let mut frames = Frames::default();
        let mut now = Instant::now();
        frames.push(frame(true, &[b'x'; 8192]));
        frames.next_at(now);
        now += Duration::from_millis(600);
        frames.acknowledge_at(1, now);
        assert_eq!(frames.window(now), 1);
        assert!(frames.background_delay_at(now) >= Duration::from_secs(1));
        for _ in 0..12 {
            frames.push(frame(false, b"update"));
            let seq = frames.next_at(now).unwrap().seq.unwrap();
            frames.push(frame(false, b"pending"));
            if frames.window(now) == 1 {
                assert!(frames.next_at(now).is_none());
            }
            now += Duration::from_millis(10);
            frames.acknowledge_at(seq, now);
        }
        assert_eq!(frames.window(now), 2);
        assert!(frames.background_delay_at(now).is_zero());
        frames.next_at(now);
        assert_eq!(
            frames.window(now + Duration::from_secs(1)),
            1,
            "Queue age catches a new stall before acknowledgements arrive"
        );
    }
    #[test]
    fn delayed_viewers_receive_two_frames_then_one_ordered_merged_update() {
        let mut frames = Frames::default();
        frames.push(frame(true, &[b'x'; 1024]));
        assert_eq!(frames.next().unwrap().seq, Some(1));
        frames.push(frame(false, b"\x1b[2;1Hfirst"));
        assert_eq!(frames.next().unwrap().seq, Some(2));
        for _ in 0..30 {
            assert!(!frames.push(frame(false, b"\x1b[3;1Hnext")));
        }
        assert!(frames.next().is_none());
        frames.acknowledge(99);
        assert!(
            frames.next().is_none(),
            "Future acknowledgements cannot grant credit"
        );
        frames.acknowledge(1);
        let merged = frames.next().unwrap();
        assert_eq!(merged.seq, Some(3));
        assert_eq!(&*merged.bytes, b"\x1b[3;1Hnext".repeat(30));
        frames.acknowledge(1);
        frames.push(frame(false, b"last"));
        assert!(
            frames.next().is_none(),
            "Duplicate acknowledgements cannot grant credit"
        );
        frames.acknowledge(3);
        assert_eq!(frames.next().unwrap().seq, Some(4));
    }
    #[test]
    fn oversized_updates_wait_for_one_fresh_baseline_and_discard_stale_deltas() {
        let mut frames = Frames::default();
        frames.push(frame(true, b"baseline"));
        frames.next();
        frames.push(frame(false, b"one"));
        frames.next();
        assert!(!frames.push(frame(false, b"two")));
        assert!(!frames.push(frame(false, b"long update")));
        for _ in 0..10000 {
            assert!(!frames.push(frame(false, b"discard")));
        }
        assert!(
            frames.acknowledge(2),
            "Request the fresh screen only when credit is available"
        );
        assert!(frames.next().is_none());
        frames.push(frame(true, b"current screen"));
        let latest = frames.next().unwrap();
        assert!(latest.full);
        assert_eq!(&*latest.bytes, b"current screen");
        frames.push(frame(false, b"x"));
        let mut resized = frame(true, b"resized");
        resized.width = 50;
        frames.push(resized);
        assert_eq!(frames.next().unwrap().width, 50);
    }
}
