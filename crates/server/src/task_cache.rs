use crate::probes::SharedTask;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

struct Entry<K, S, T: Clone> {
    key: K,
    version: S,
    expires: Option<Instant>,
    task: SharedTask<T>,
}

pub(crate) struct TaskCache<K, S, T: Clone, const LIMIT: usize> {
    entries: VecDeque<Entry<K, S, T>>,
}

impl<K, S, T: Clone, const LIMIT: usize> Default for TaskCache<K, S, T, LIMIT> {
    fn default() -> Self {
        assert!(LIMIT > 0);
        Self {
            entries: VecDeque::new(),
        }
    }
}

impl<K: PartialEq, S: PartialEq, T: Clone + Send + Sync + 'static, const LIMIT: usize>
    TaskCache<K, S, T, LIMIT>
{
    pub fn get_or_insert_with(
        &mut self,
        key: K,
        version: S,
        ttl: Option<Duration>,
        create: impl FnOnce() -> SharedTask<T>,
    ) -> SharedTask<T> {
        let now = Instant::now();
        let reusable = |entry: &Entry<K, S, T>| {
            entry.expires.is_none_or(|expires| expires > now) && entry.task.reusable()
        };
        if let Some(entry) = self
            .entries
            .iter()
            .find(|entry| entry.key == key && entry.version == version && reusable(entry))
        {
            return entry.task.clone();
        }
        self.entries
            .retain(|entry| entry.key != key && reusable(entry));
        if self.entries.len() >= LIMIT {
            self.entries.pop_front();
        }
        let task = create();
        self.entries.push_back(Entry {
            key,
            version,
            expires: ttl.map(|ttl| now + ttl),
            task: task.clone(),
        });
        task
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn ready(value: u32) -> SharedTask<u32> {
        SharedTask::new(move |_| Box::pin(async move { Ok(value) }))
    }

    #[tokio::test]
    async fn hits_share_work_and_version_changes_replace_only_the_matching_key() {
        let mut cache = TaskCache::<_, _, _, 2>::default();
        let cancel = CancellationToken::new();
        let first = cache.get_or_insert_with("a", 1, None, || ready(1));
        let same = cache.get_or_insert_with("a", 1, None, || panic!("duplicate task"));
        assert_eq!(first.wait(&cancel).await, same.wait(&cancel).await);
        cache.get_or_insert_with("b", 1, None, || ready(2));
        let replacement = cache.get_or_insert_with("a", 2, None, || ready(3));
        assert_eq!(replacement.wait(&cancel).await, Ok(3));
        assert_eq!(first.wait(&cancel).await, Ok(1));
        assert_eq!(cache.entries.len(), 2);
        assert_eq!(
            cache
                .get_or_insert_with("b", 1, None, || panic!("unrelated key removed"))
                .wait(&cancel)
                .await,
            Ok(2)
        );
    }

    #[tokio::test]
    async fn expired_failed_and_cancelled_tasks_are_retried() {
        let mut cache = TaskCache::<_, _, _, 3>::default();
        let cancel = CancellationToken::new();
        cache.get_or_insert_with("ttl", (), Some(Duration::ZERO), || ready(1));
        assert_eq!(
            cache
                .get_or_insert_with("ttl", (), None, || ready(2))
                .wait(&cancel)
                .await,
            Ok(2)
        );
        let failed = cache.get_or_insert_with("error", (), None, || {
            SharedTask::new(|_| Box::pin(async { Err("failed".into()) }))
        });
        assert!(failed.wait(&cancel).await.is_err());
        assert_eq!(
            cache
                .get_or_insert_with("error", (), None, || ready(3))
                .wait(&cancel)
                .await,
            Ok(3)
        );
        let pending = cache.get_or_insert_with("cancel", (), None, || {
            SharedTask::new(|_| Box::pin(std::future::pending()))
        });
        let aborted = CancellationToken::new();
        aborted.cancel();
        assert!(pending.wait(&aborted).await.is_err());
        assert_eq!(
            cache
                .get_or_insert_with("cancel", (), None, || ready(4))
                .wait(&cancel)
                .await,
            Ok(4)
        );
    }

    #[tokio::test]
    async fn eviction_is_bounded_and_does_not_cancel_an_existing_consumer() {
        let mut cache = TaskCache::<_, _, _, 1>::default();
        let (send, receive) = tokio::sync::oneshot::channel();
        let old = cache.get_or_insert_with("old", (), None, || {
            SharedTask::new(|_| {
                Box::pin(async { receive.await.map_err(|error| error.to_string()) })
            })
        });
        let cancel = CancellationToken::new();
        let consumer = tokio::spawn(async move { old.wait(&cancel).await });
        cache.get_or_insert_with("new", (), None, || ready(2));
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.entries[0].key, "new");
        send.send(1).unwrap();
        assert_eq!(consumer.await.unwrap(), Ok(1));
    }
}
