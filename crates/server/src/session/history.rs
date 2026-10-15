use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};
use termai_engine::types::SharedList;

pub(super) struct History {
    lines: VecDeque<String>,
    snapshot: Option<SharedList<String>>,
    cwds: Arc<BTreeMap<String, String>>,
    cwd_order: VecDeque<String>,
    read_at: Option<Instant>,
    last: String,
}
impl History {
    pub fn new(lines: Vec<String>) -> Self {
        Self {
            lines: lines.into(),
            snapshot: None,
            cwds: Default::default(),
            cwd_order: Default::default(),
            read_at: None,
            last: String::new(),
        }
    }
    pub fn observe(&mut self, had_prompt: bool, history: String, cwd: String) {
        static PREFIX: LazyLock<regex::Regex> =
            LazyLock::new(|| regex::Regex::new(r"^\s*\d+\s+").unwrap());
        let line = PREFIX.replace(&history, "").trim_end().to_owned();
        if had_prompt
            && history != self.last
            && !line.is_empty()
            && !line.starts_with(char::is_whitespace)
        {
            self.lines.push_back(line.clone());
            self.snapshot = None;
            if self.lines.len() > 5000 {
                self.lines.pop_front();
            }
            if !self.cwds.contains_key(&line) {
                self.cwd_order.push_back(line.clone());
            }
            Arc::make_mut(&mut self.cwds).insert(line, cwd);
            if self.cwds.len() > 1000 {
                // Preserve JavaScript object-key eviction order for numeric commands.
                let numeric = self
                    .cwds
                    .keys()
                    .filter_map(|key| {
                        key.parse::<u32>()
                            .ok()
                            .filter(|n| *n != u32::MAX && n.to_string() == *key)
                            .map(|n| (n, key.clone()))
                    })
                    .min_by_key(|(n, _)| *n);
                let key = numeric
                    .map(|(_, key)| key)
                    .unwrap_or_else(|| self.cwd_order.front().unwrap().clone());
                Arc::make_mut(&mut self.cwds).remove(&key);
                self.cwd_order.retain(|old| *old != key);
            }
        }
        self.last = history;
    }
    pub fn reserve_refresh(&mut self, now: Instant) -> bool {
        if self
            .read_at
            .is_some_and(|at| now.duration_since(at) <= Duration::from_secs(10))
        {
            return false;
        }
        self.read_at = Some(now);
        true
    }
    pub fn merge(&mut self, mut external: Vec<String>) {
        external.extend(self.lines.iter().cloned());
        let mut seen = HashSet::new();
        let mut lines = external
            .into_iter()
            .rev()
            .filter(|line| seen.insert(line.clone()))
            .take(5000)
            .collect::<Vec<_>>();
        lines.reverse();
        self.lines = lines.into();
        self.snapshot = None;
    }
    pub fn snapshot(&mut self) -> SharedList<String> {
        self.snapshot
            .get_or_insert_with(|| self.lines.iter().cloned().collect())
            .clone()
    }
    pub fn cwds(&self) -> Arc<BTreeMap<String, String>> {
        self.cwds.clone()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_survive_updates_and_external_refresh_preserves_recent_local_order() {
        let mut history = History::new(vec!["old".into()]);
        let before = history.snapshot();
        history.observe(false, "1 ignored".into(), "/initial".into());
        history.observe(true, "2 echo local".into(), "/local".into());
        history.observe(true, "2 echo local".into(), "/elsewhere".into());
        let cwds = history.cwds();
        history.observe(true, "3 echo local".into(), "/changed".into());
        history.merge(vec!["external".into(), "old".into(), "echo local".into()]);
        assert_eq!(&**before, &["old"]);
        assert_eq!(&**history.snapshot(), &["external", "old", "echo local"]);
        assert_eq!(cwds["echo local"], "/local");
        assert_eq!(history.cwds()["echo local"], "/changed");
        let now = Instant::now();
        assert!(history.reserve_refresh(now));
        assert!(!history.reserve_refresh(now + Duration::from_secs(10)));
        assert!(history.reserve_refresh(now + Duration::from_secs(11)));
    }
    #[test]
    fn bounded_cwd_history_keeps_reference_numeric_key_eviction() {
        let mut history = History::new(vec![]);
        for index in 0..999 {
            history.observe(
                true,
                format!("{} command-{index}", index + 1),
                "/cwd".into(),
            );
        }
        history.observe(true, "1000 2".into(), "/two".into());
        history.observe(true, "1001 1".into(), "/one".into());
        assert_eq!(history.cwds().len(), 1000);
        assert!(!history.cwds().contains_key("1"));
        assert_eq!(history.cwds()["2"], "/two");
        assert!(history.cwds().contains_key("command-0"));
    }
}
