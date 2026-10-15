use crate::protocol::HerdrFrame;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::collections::VecDeque;

const WINDOW: usize = 2;
const MAX_PENDING: usize = 512 * 1024;

struct Pending {
    width: u16,
    height: u16,
    full: bool,
    bytes: Vec<u8>,
}
#[derive(Default)]
pub(super) struct Frames {
    pending: Option<Pending>,
    outstanding: VecDeque<u64>,
    sequence: u64,
    full_size: usize,
    awaiting_full: bool,
    requested_full: bool,
}
impl Frames {
    /// Merge unsent ANSI in order, or ask the producer for a current baseline.
    pub fn push(&mut self, frame: HerdrFrame) -> bool {
        let Ok(bytes) = STANDARD.decode(frame.bytes.as_ref()) else {
            return self.refresh();
        };
        if frame.full {
            self.full_size = bytes.len().clamp(1, MAX_PENDING);
            self.awaiting_full = false;
            self.requested_full = false;
            self.pending = Some(Pending {
                width: frame.width,
                height: frame.height,
                full: true,
                bytes,
            });
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
        if let Some(pending) = &mut self.pending {
            if pending.width != frame.width
                || pending.height != frame.height
                || pending.bytes.len().saturating_add(bytes.len()) > limit
            {
                return self.refresh();
            }
            pending.bytes.extend_from_slice(&bytes);
        } else if bytes.len() > limit {
            return self.refresh();
        } else {
            self.pending = Some(Pending {
                width: frame.width,
                height: frame.height,
                full: false,
                bytes,
            });
        }
        false
    }
    fn refresh(&mut self) -> bool {
        self.pending = None;
        self.awaiting_full = true;
        self.request_snapshot()
    }
    fn request_snapshot(&mut self) -> bool {
        if self.awaiting_full && !self.requested_full && self.outstanding.len() < WINDOW {
            self.requested_full = true;
            true
        } else {
            false
        }
    }
    pub fn next(&mut self) -> Option<HerdrFrame> {
        if self.outstanding.len() >= WINDOW {
            return None;
        }
        let pending = self.pending.take()?;
        self.sequence += 1;
        self.outstanding.push_back(self.sequence);
        Some(HerdrFrame {
            seq: Some(self.sequence),
            width: pending.width,
            height: pending.height,
            full: pending.full,
            bytes: STANDARD.encode(pending.bytes).into(),
        })
    }
    pub fn acknowledge(&mut self, sequence: u64) -> bool {
        if sequence > self.sequence {
            return false;
        }
        while self.outstanding.front().is_some_and(|seq| *seq <= sequence) {
            self.outstanding.pop_front();
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
            bytes: STANDARD.encode(bytes).into(),
        }
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
        assert_eq!(
            STANDARD.decode(merged.bytes.as_ref()).unwrap(),
            b"\x1b[3;1Hnext".repeat(30)
        );
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
        assert_eq!(
            STANDARD.decode(latest.bytes.as_ref()).unwrap(),
            b"current screen"
        );
        frames.push(frame(false, b"x"));
        let mut resized = frame(true, b"resized");
        resized.width = 50;
        frames.push(resized);
        assert_eq!(frames.next().unwrap().width, 50);
    }
}
