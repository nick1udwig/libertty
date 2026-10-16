use super::Input;
use libertty_engine::utf16_len;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::{OwnedSemaphorePermit, mpsc};

/// Ledgers kept for browser terminals that are not connected, so a reconnect can learn which keys arrived.
const RETAINED: usize = 256;

/// The numbered keys one browser terminal delivered, shared by its successive connections.
#[derive(Default)]
pub struct Ledger {
    /// Serializes deliveries, so a newer connection never races an older one's send.
    gate: tokio::sync::Mutex<()>,
    delivered: AtomicU64,
    /// Only the newest connection delivers; an older one drops what it still holds.
    generation: AtomicU64,
}
impl Ledger {
    /// Make a new connection the owner and report the keys earlier ones delivered.
    pub(super) fn connect(&self) -> (u64, u64) {
        (
            self.generation.fetch_add(1, Ordering::AcqRel) + 1,
            self.delivered.load(Ordering::Acquire),
        )
    }
    pub(super) fn delivered(&self) -> u64 {
        self.delivered.load(Ordering::Acquire)
    }
    /// Wait for earlier deliveries, then keep only keys never delivered; nothing remains for a superseded connection.
    pub(super) async fn claim(
        &self,
        generation: u64,
        input: &mut Input,
    ) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        let gate = self.gate.lock().await;
        if self.generation.load(Ordering::Acquire) != generation {
            return None;
        }
        let (mut highest, mut start) = (self.delivered(), 0);
        let (mut text, mut seqs) = (String::new(), Vec::new());
        for (seq, end) in std::mem::take(&mut input.seqs) {
            if seq > highest {
                text.push_str(&input.text[start..end]);
                seqs.push((seq, text.len()));
                highest = seq;
            }
            start = end;
        }
        (input.text, input.seqs) = (text, seqs);
        (!input.text.is_empty()).then_some(gate)
    }
    /// Record keys as delivered just before sending them, so an uncertain send is never repeated.
    pub(super) fn sending(&self, seq: u64) {
        self.delivered.fetch_max(seq, Ordering::AcqRel);
    }
}
#[derive(Default)]
pub struct Ledgers(Mutex<HashMap<String, (Arc<Ledger>, Instant)>>);
impl Ledgers {
    /// This browser terminal's ledger, and whether an earlier connection created it.
    pub fn open(&self, key: String) -> (Arc<Ledger>, bool) {
        let mut ledgers = self.0.lock().unwrap();
        let now = Instant::now();
        if let Some((ledger, opened)) = ledgers.get_mut(&key) {
            *opened = now;
            return (ledger.clone(), true);
        }
        while ledgers.len() >= RETAINED {
            let Some(oldest) = ledgers
                .iter()
                .filter(|(_, (ledger, _))| Arc::strong_count(ledger) == 1)
                .min_by_key(|(_, (_, opened))| *opened)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            ledgers.remove(&oldest);
        }
        let ledger = Arc::new(Ledger::default());
        ledgers.insert(key, (ledger.clone(), now));
        (ledger, false)
    }
}

fn plain(input: &Input) -> bool {
    !input.paste
        && input.guard.is_none()
        && input.command.is_none()
        && input.complete.is_none()
        && input.replacement.is_none()
        && !input.text.is_empty()
        && !input.text.chars().any(char::is_control)
}

/// Merge only immediately available typing while retaining admission credit until delivery.
pub(super) fn coalesce(
    input: &mut Input,
    receive: &mut mpsc::Receiver<Input>,
    deferred: &mut Option<Input>,
) -> Vec<OwnedSemaphorePermit> {
    let mut permits = Vec::new();
    if !plain(input) {
        return permits;
    }
    let mut units = utf16_len(&input.text);
    while let Ok(next) = receive.try_recv() {
        let next_units = utf16_len(&next.text);
        if !plain(&next) || units + next_units > 16000 {
            *deferred = Some(next);
            break;
        }
        let offset = input.text.len();
        input.text.push_str(&next.text);
        input
            .seqs
            .extend(next.seqs.iter().map(|(seq, end)| (*seq, offset + end)));
        units += next_units;
        permits.push(next._permit);
    }
    permits
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::Semaphore;
    fn key(text: &str, capacity: &Arc<Semaphore>) -> Input {
        Input {
            text: text.into(),
            paste: false,
            guard: None,
            command: None,
            complete: None,
            replacement: None,
            seqs: Vec::new(),
            _permit: capacity.clone().try_acquire_owned().unwrap(),
        }
    }
    #[test]
    fn utf16_limits_and_control_boundaries_keep_order_and_capacity() {
        let capacity = Arc::new(Semaphore::new(8));
        let (send, mut receive) = mpsc::channel(8);
        let mut first = key(&"😀".repeat(7999), &capacity);
        for text in ["界", "😀", "\x1b[D", "a", "b"] {
            assert!(send.try_send(key(text, &capacity)).is_ok());
        }
        let mut deferred = None;
        let permits = coalesce(&mut first, &mut receive, &mut deferred);
        assert_eq!(utf16_len(&first.text), 15999);
        assert_eq!(deferred.as_ref().unwrap().text, "😀");
        assert_eq!(
            capacity.available_permits(),
            2,
            "Coalescing must not bypass the admission limit"
        );
        drop(permits);
        assert_eq!(capacity.available_permits(), 3);
        let mut second = deferred.take().unwrap();
        assert!(coalesce(&mut second, &mut receive, &mut deferred).is_empty());
        assert_eq!(second.text, "😀");
        assert_eq!(deferred.as_ref().unwrap().text, "\x1b[D");
        let mut control = deferred.take().unwrap();
        assert!(coalesce(&mut control, &mut receive, &mut deferred).is_empty());
        assert_eq!(receive.len(), 2);
        let mut tail = receive.try_recv().unwrap();
        let permits = coalesce(&mut tail, &mut receive, &mut deferred);
        assert_eq!(tail.text, "ab");
        assert_eq!(permits.len(), 1);
    }
    #[tokio::test]
    async fn merged_keys_keep_their_numbers_and_claims_keep_only_undelivered_ones() {
        let capacity = Arc::new(Semaphore::new(8));
        let numbered = |text: &str, seq| Input {
            seqs: vec![(seq, text.len())],
            ..key(text, &capacity)
        };
        let (send, mut receive) = mpsc::channel(8);
        let mut input = numbered("界", 1);
        for (text, seq) in [("a", 2), ("a", 2), ("b", 3)] {
            assert!(send.try_send(numbered(text, seq)).is_ok());
        }
        let _permits = coalesce(&mut input, &mut receive, &mut None);
        assert_eq!(
            (input.text.as_str(), &input.seqs[..]),
            ("界aab", &[(1, 3), (2, 4), (2, 5), (3, 6)][..])
        );
        let ledger = Ledger::default();
        let (old, _) = ledger.connect();
        ledger.sending(1);
        let (new, delivered) = ledger.connect();
        assert_eq!(delivered, 1);
        assert!(ledger.claim(old, &mut numbered("x", 2)).await.is_none());
        assert!(ledger.claim(new, &mut input).await.is_some());
        assert_eq!(
            (input.text.as_str(), &input.seqs[..]),
            ("ab", &[(2, 1), (3, 2)][..])
        );
    }
    #[test]
    fn paste_command_guarded_and_completed_input_remain_separate() {
        let capacity = Arc::new(Semaphore::new(8));
        for barrier in 0..4 {
            let (send, mut receive) = mpsc::channel(8);
            let mut first = key("a", &capacity);
            let mut next = key("b", &capacity);
            match barrier {
                0 => next.paste = true,
                1 => next.command = Some("command".into()),
                2 => next.guard = Some((1, "recording".into())),
                _ => next.complete = Some(tokio::sync::oneshot::channel().0),
            }
            assert!(send.try_send(next).is_ok());
            assert!(send.try_send(key("c", &capacity)).is_ok());
            let mut deferred = None;
            assert!(coalesce(&mut first, &mut receive, &mut deferred).is_empty());
            assert_eq!(first.text, "a");
            let mut barrier = deferred.take().unwrap();
            assert!(coalesce(&mut barrier, &mut receive, &mut deferred).is_empty());
            assert_eq!(receive.try_recv().unwrap().text, "c");
        }
    }
}
