use libertty_server::probes::{ABORTED, ProbeOptions, ProbePool, SharedTask, probe};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn queued_cancelled_work_never_starts_and_the_pool_recovers() {
    let pool = ProbePool::new(1);
    let cancel = CancellationToken::new();
    let (release, ready) = tokio::sync::oneshot::channel();
    let started = AtomicBool::new(false);
    let queued_cancel = CancellationToken::new();
    let running = pool.run(&cancel, async {
        ready.await.unwrap();
        Ok(())
    });
    let queued = async {
        tokio::task::yield_now().await;
        pool.run(&queued_cancel, async {
            started.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await
    };
    let stop = async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        queued_cancel.cancel();
        tokio::task::yield_now().await;
        release.send(()).unwrap();
    };
    let (running, queued, _) = tokio::join!(running, queued, stop);
    running.unwrap();
    assert_eq!(queued.unwrap_err(), ABORTED);
    assert!(!started.load(Ordering::SeqCst));
    assert!(!pool.busy());
    assert_eq!(pool.run(&cancel, async { Ok(42) }).await.unwrap(), 42);
}

#[tokio::test]
async fn shared_work_survives_one_cancelled_subscriber_and_stops_after_the_last() {
    let task = SharedTask::new(|_| {
        Box::pin(async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            Ok(7)
        })
    });
    let first = CancellationToken::new();
    let second = CancellationToken::new();
    let stop = async {
        tokio::task::yield_now().await;
        first.cancel();
    };
    let (a, b, _) = tokio::join!(task.wait(&first), task.wait(&second), stop);
    assert_eq!(a.unwrap_err(), ABORTED);
    assert_eq!(b.unwrap(), 7);
    assert!(!task.aborted());
    let orphan = SharedTask::<()>::new(|cancel| {
        Box::pin(async move {
            cancel.cancelled().await;
            Err(ABORTED.into())
        })
    });
    let stop = async {
        tokio::task::yield_now().await;
        second.cancel();
    };
    let (pending, _) = tokio::join!(orphan.wait(&second), stop);
    assert_eq!(pending.unwrap_err(), ABORTED);
    assert!(orphan.aborted());
}

#[tokio::test]
async fn active_subprocess_cancellation_releases_the_process_and_pool() {
    let root = tempfile::tempdir().unwrap();
    let pool = ProbePool::new(1);
    let cancel = CancellationToken::new();
    let options = ProbeOptions {
        cwd: root.path().to_string_lossy().into_owned(),
        env: std::env::vars().collect(),
        timeout: Duration::from_secs(10),
        max_buffer: 1024,
    };
    let stop = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancel.cancel();
    };
    let arguments = ["-c".into(), "sleep 10".into()];
    let (result, _) = tokio::join!(probe(&pool, "/bin/sh", &arguments, &options, &cancel), stop);
    assert_eq!(result.err().unwrap(), ABORTED);
    assert!(!pool.busy());
}

#[tokio::test]
async fn work_abandoned_before_its_first_subscription_never_starts() {
    let started = Arc::new(AtomicBool::new(false));
    let observe = started.clone();
    let task = SharedTask::new(move |_| {
        Box::pin(async move {
            observe.store(true, Ordering::SeqCst);
            Ok(())
        })
    });
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(task.wait(&cancel).await.unwrap_err(), ABORTED);
    tokio::task::yield_now().await;
    assert!(!started.load(Ordering::SeqCst));
    assert!(task.aborted());
}
