//! Bounded replay history and independent acknowledgement credit for the current viewer.
use std::{collections::VecDeque, sync::Arc};

const WINDOW: usize = 128 * 1024;
const BATCH: usize = 64 * 1024;
#[derive(Clone)]
pub(super) struct Output {
    pub seq: u64,
    pub data: Arc<str>,
    bytes: usize,
}
pub(super) struct Attachment {
    pub reset: bool,
    pub truncated: bool,
    pub first_seq: u64,
    pub last_seq: u64,
}
pub(super) struct Replay {
    outputs: VecDeque<Output>,
    bytes: usize,
    seq: u64,
    truncated: bool,
    pending: VecDeque<Output>,
    outstanding: VecDeque<(u64, usize)>,
    outstanding_bytes: usize,
    sent_seq: u64,
    max_bytes: usize,
    max_entries: usize,
}
impl Default for Replay {
    fn default() -> Self {
        Self::new(2 * 1024 * 1024, 16384)
    }
}
impl Replay {
    fn new(max_bytes: usize, max_entries: usize) -> Self {
        Self {
            outputs: Default::default(),
            bytes: 0,
            seq: 0,
            truncated: false,
            pending: Default::default(),
            outstanding: Default::default(),
            outstanding_bytes: 0,
            sent_seq: 0,
            max_bytes,
            max_entries,
        }
    }
    pub fn record(&mut self, data: Arc<str>, attached: bool) {
        self.seq += 1;
        let output = Output {
            seq: self.seq,
            bytes: data.len(),
            data,
        };
        self.bytes += output.bytes;
        self.outputs.push_back(output.clone());
        while self.outputs.len() > 1
            && (self.bytes > self.max_bytes || self.outputs.len() > self.max_entries)
        {
            self.bytes -= self.outputs.pop_front().unwrap().bytes;
            self.truncated = true;
        }
        if attached {
            self.pending.push_back(output);
        }
    }
    pub fn attach(&mut self, after: u64, changed: bool) -> Attachment {
        self.outstanding.clear();
        self.outstanding_bytes = 0;
        self.sent_seq = 0;
        let first = self.outputs.front().map_or(1, |output| output.seq);
        let gap = changed || after > self.seq || (after > 0 && after < first - 1);
        self.pending = self
            .outputs
            .iter()
            .filter(|output| output.seq > if gap { 0 } else { after })
            .cloned()
            .collect();
        Attachment {
            reset: after == 0 || gap,
            truncated: ((after == 0 || changed) && self.truncated) || (gap && !changed),
            first_seq: first,
            last_seq: self.seq,
        }
    }
    pub fn detach(&mut self) {
        self.pending.clear();
        self.outstanding.clear();
        self.outstanding_bytes = 0;
    }
    pub fn next(&mut self) -> Option<Output> {
        if self.outstanding_bytes >= WINDOW {
            return None;
        }
        let mut output = self.pending.pop_front()?;
        let limit = BATCH.min(WINDOW - self.outstanding_bytes);
        if self
            .pending
            .front()
            .is_some_and(|next| output.bytes + next.bytes <= limit)
        {
            let mut data = output.data.to_string();
            while self
                .pending
                .front()
                .is_some_and(|next| output.bytes + next.bytes <= limit)
            {
                let next = self.pending.pop_front().unwrap();
                data.push_str(&next.data);
                output.seq = next.seq;
                output.bytes += next.bytes;
            }
            output.data = data.into();
        }
        self.sent_seq = output.seq;
        self.outstanding.push_back((output.seq, output.bytes));
        self.outstanding_bytes += output.bytes;
        Some(output)
    }
    pub fn acknowledge(&mut self, seq: u64) -> bool {
        if seq > self.sent_seq {
            return false;
        }
        while self.outstanding.front().is_some_and(|(at, _)| *at <= seq) {
            self.outstanding_bytes -= self.outstanding.pop_front().unwrap().1;
        }
        true
    }
    pub fn paused(&self) -> bool {
        self.outstanding_bytes >= WINDOW || !self.pending.is_empty()
    }
    #[cfg(test)]
    pub fn outstanding_bytes(&self) -> usize {
        self.outstanding_bytes
    }
    #[cfg(test)]
    pub fn pending_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_delivery_survives_replay_eviction_and_future_acks_cannot_grant_credit() {
        let mut replay = Replay::new(8, 2);
        for _ in 0..40 {
            replay.record("x".repeat(4096).into(), true);
        }
        let mut sent = Vec::new();
        while let Some(output) = replay.next() {
            sent.push(output.seq);
        }
        assert_eq!(sent, vec![16, 32]);
        assert!(!replay.acknowledge(40));
        assert!(replay.next().is_none());
        assert!(replay.acknowledge(16));
        assert!(replay.acknowledge(16));
        while let Some(output) = replay.next() {
            sent.push(output.seq);
        }
        assert_eq!(sent, vec![16, 32, 40]);
        replay.detach();
        let hello = replay.attach(0, false);
        assert!(hello.reset && hello.truncated);
        assert_eq!(hello.first_seq, 40); // Keep a final oversized chunk whole.
        assert_eq!(replay.next().unwrap().seq, 40);
    }
    #[test]
    fn reconnect_distinguishes_contiguous_cursors_lost_history_and_new_streams() {
        let mut replay = Replay::new(100, 3);
        for _ in 0..6 {
            replay.record("界😀".into(), false);
        }
        for (after, changed, reset, truncated, first_output) in [
            (3, false, false, false, 4),
            (1, false, true, true, 4),
            (7, false, true, true, 4),
            (5, true, true, true, 4),
            (5, false, false, false, 6),
        ] {
            let hello = replay.attach(after, changed);
            assert_eq!(
                (
                    hello.reset,
                    hello.truncated,
                    hello.first_seq,
                    hello.last_seq
                ),
                (reset, truncated, 4, 6)
            );
            let output = replay.next().unwrap();
            assert_eq!(output.seq, 6);
            assert_eq!(&*output.data, "界😀".repeat((7 - first_output) as usize));
        }
    }
    #[test]
    fn batching_keeps_exact_bytes_and_final_cursors_across_reconnects() {
        let mut replay = Replay::default();
        let chunks: Vec<String> = (0..5000).map(|n| format!("{n}:界😀\r\n")).collect();
        for chunk in &chunks {
            replay.record(chunk.as_str().into(), false);
        }
        let attachment = replay.attach(0, false);
        assert_eq!(attachment.last_seq, 5000);
        let first = replay.next().unwrap();
        assert!(first.bytes <= BATCH);
        assert_eq!(&*first.data, chunks[..first.seq as usize].concat());
        let encoded = crate::wire::encode(
            &serde_json::json!({"type":"output","seq":first.seq,"data":first.data}),
            crate::wire::Mode::Gzip,
        );
        assert_ne!(
            encoded.bytes[3] & 128,
            0,
            "Small replay chunks should share one compressible message"
        );
        assert!(replay.acknowledge(first.seq - 1));
        assert_eq!(
            replay.outstanding_bytes(),
            first.bytes,
            "Only the final batch cursor releases its credit"
        );
        replay.attach(first.seq, false);
        let mut suffix = String::new();
        while let Some(output) = replay.next() {
            suffix.push_str(&output.data);
            assert!(replay.acknowledge(output.seq));
        }
        assert_eq!(suffix, chunks[first.seq as usize..].concat());
        assert!(replay.pending_empty());
    }
}
