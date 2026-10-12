use crate::session::Transport;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
#[derive(Clone)]
pub struct Sender {
    send: mpsc::Sender<Item>,
    bytes: Arc<AtomicUsize>,
    slow: CancellationToken,
}
pub struct Item {
    pub message: Transport,
    reservation: Reservation,
}
struct Reservation {
    bytes: Arc<AtomicUsize>,
    size: usize,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.bytes.fetch_sub(self.size, Ordering::AcqRel);
    }
}
pub fn channel() -> (Sender, mpsc::Receiver<Item>, CancellationToken) {
    let (send, receive) = mpsc::channel(1024);
    let slow = CancellationToken::new();
    (
        Sender {
            send,
            bytes: Arc::new(AtomicUsize::new(0)),
            slow: slow.clone(),
        },
        receive,
        slow,
    )
}
impl Sender {
    pub fn too_slow(&self) {
        self.slow.cancel();
    }
    pub fn send(&self, message: Transport) -> bool {
        if self.slow.is_cancelled() {
            return false;
        }
        let size = match &message {
            Transport::Message(value) => value.to_string().len(),
            Transport::Close(_, reason) => reason.len() + 2,
        };
        if self
            .bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |bytes| {
                bytes.checked_add(size).filter(|sum| *sum <= MAX_BYTES)
            })
            .is_err()
        {
            self.slow.cancel();
            return false;
        }
        let item = Item {
            message,
            reservation: Reservation {
                bytes: self.bytes.clone(),
                size,
            },
        };
        if self.send.try_send(item).is_err() {
            self.slow.cancel();
            return false;
        }
        true
    }
}
impl Item {
    pub fn size(&self) -> usize {
        self.reservation.size
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn queued_and_in_flight_bytes_are_bounded_and_released() {
        let (send, mut receive, slow) = channel();
        assert!(send.send(Transport::Message(
            serde_json::json!({"bytes":"x".repeat(MAX_BYTES / 2)})
        )));
        let item = receive.recv().await.unwrap();
        assert!(item.size() > MAX_BYTES / 2);
        assert!(!send.send(Transport::Message(
            serde_json::json!({"bytes":"x".repeat(MAX_BYTES / 2)})
        )));
        assert!(slow.is_cancelled());
        drop(item);
        assert_eq!(send.bytes.load(Ordering::Acquire), 0);
        let (send, mut receive, slow) = channel();
        for id in 0..100 {
            assert!(send.send(Transport::Message(serde_json::json!({"id":id}))));
        }
        for id in 0..100 {
            let item = receive.recv().await.unwrap();
            match &item.message {
                Transport::Message(value) => assert_eq!(value["id"], id),
                _ => panic!(),
            }
        }
        assert!(!slow.is_cancelled());
        assert_eq!(send.bytes.load(Ordering::Acquire), 0);
    }
}
