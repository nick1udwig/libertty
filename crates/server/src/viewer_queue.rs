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
        let size = message.size();
        let mut bytes = self.bytes.load(Ordering::Acquire);
        loop {
            let Some(sum) = bytes.checked_add(size).filter(|sum| *sum <= MAX_BYTES) else {
                self.slow.cancel();
                return false;
            };
            match self
                .bytes
                .compare_exchange_weak(bytes, sum, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => break,
                Err(current) => bytes = current,
            }
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
    use crate::herdr::Metadata;
    #[test]
    fn concurrent_senders_preserve_the_byte_limit_and_release_reservations() {
        let (send, mut receive, slow) = channel();
        let message = Transport::Metadata(Metadata::Error {
            message: "x".repeat(32 * 1024),
        });
        let size = message.size();
        std::thread::scope(|scope| {
            for _ in 0..16 {
                let send = send.clone();
                let message = message.clone();
                scope.spawn(move || {
                    for _ in 0..32 {
                        if !send.send(message.clone()) {
                            break;
                        }
                    }
                });
            }
        });
        assert!(slow.is_cancelled());
        let reserved = send.bytes.load(Ordering::Acquire);
        assert!(reserved <= MAX_BYTES);
        assert!(reserved > MAX_BYTES - size);
        let mut received = 0;
        while let Ok(item) = receive.try_recv() {
            received += item.size();
        }
        assert_eq!(received, reserved);
        assert_eq!(send.bytes.load(Ordering::Acquire), 0);
    }
    #[tokio::test]
    async fn queued_and_in_flight_bytes_are_bounded_and_released() {
        let (send, mut receive, slow) = channel();
        let half = || {
            Transport::Metadata(Metadata::Error {
                message: "x".repeat(MAX_BYTES / 2),
            })
        };
        assert!(send.send(half()));
        let item = receive.recv().await.unwrap();
        assert!(item.size() > MAX_BYTES / 2);
        assert!(!send.send(half()));
        assert!(slow.is_cancelled());
        drop(item);
        assert_eq!(send.bytes.load(Ordering::Acquire), 0);
        let (send, mut receive, slow) = channel();
        for id in 0..100 {
            assert!(send.send(Transport::Metadata(Metadata::Error {
                message: id.to_string()
            })));
        }
        for id in 0..100 {
            let item = receive.recv().await.unwrap();
            match &item.message {
                Transport::Metadata(Metadata::Error { message }) => {
                    assert_eq!(*message, id.to_string())
                }
                _ => panic!(),
            }
        }
        assert!(!slow.is_cancelled());
        assert_eq!(send.bytes.load(Ordering::Acquire), 0);
    }
}
