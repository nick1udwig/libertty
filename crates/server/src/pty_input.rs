use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

const BYTES: usize = 256 * 1024;
const MESSAGES: usize = 128;
pub(crate) const FULL: &str = "Terminal input is full. Reconnect and try again.";
pub(crate) const CLOSED: &str = "Terminal input closed. Reopen this terminal.";

pub(crate) struct Input {
    pub bytes: Vec<u8>,
    _reservation: OwnedSemaphorePermit,
}
pub(crate) struct Sender {
    send: mpsc::Sender<Input>,
    capacity: Arc<Semaphore>,
}
pub(crate) fn channel() -> (Sender, mpsc::Receiver<Input>) {
    let (send, receive) = mpsc::channel(MESSAGES);
    (
        Sender {
            send,
            capacity: Arc::new(Semaphore::new(BYTES)),
        },
        receive,
    )
}
impl Sender {
    pub fn write(&self, text: &str) -> Result<(), &'static str> {
        if self.send.is_closed() {
            return Err(CLOSED);
        }
        let size = u32::try_from(text.len()).map_err(|_| FULL)?;
        let reservation = self
            .capacity
            .clone()
            .try_acquire_many_owned(size)
            .map_err(|_| FULL)?;
        self.send
            .try_send(Input {
                bytes: text.as_bytes().to_vec(),
                _reservation: reservation,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => FULL,
                mpsc::error::TrySendError::Closed(_) => CLOSED,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn queued_and_in_flight_input_share_byte_credit_and_keep_order() {
        let (send, mut receive) = channel();
        let text = "界".repeat(BYTES / 3);
        send.write(&text).unwrap();
        let input = receive.recv().await.unwrap();
        assert_eq!(input.bytes, text.as_bytes());
        assert_eq!(send.write("xyz"), Err(FULL));
        drop(input);
        for text in ["a", "b", "c"] {
            send.write(text).unwrap();
        }
        for text in ["a", "b", "c"] {
            assert_eq!(receive.recv().await.unwrap().bytes, text.as_bytes());
        }
        assert_eq!(send.capacity.available_permits(), BYTES);
    }

    #[tokio::test]
    async fn message_limits_closed_writers_and_oversized_input_fail_without_leaking_credit() {
        let (send, receive) = channel();
        for _ in 0..MESSAGES {
            send.write("x").unwrap();
        }
        assert_eq!(send.write("x"), Err(FULL));
        assert_eq!(send.capacity.available_permits(), BYTES - MESSAGES);
        drop(receive);
        assert_eq!(send.capacity.available_permits(), BYTES);
        assert_eq!(send.write("x"), Err(CLOSED));
        let (send, _receive) = channel();
        assert_eq!(send.write(&"x".repeat(BYTES + 1)), Err(FULL));
        assert_eq!(send.capacity.available_permits(), BYTES);
    }
}
