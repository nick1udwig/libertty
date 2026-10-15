use super::Input;
use termai_engine::utf16_len;
use tokio::sync::{OwnedSemaphorePermit, mpsc};

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
        input.text.push_str(&next.text);
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
