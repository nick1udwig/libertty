//! Candidate ordering and presentation limits, independent of generation budgets.
use crate::types::Candidate;
use std::{cmp::Ordering, collections::HashSet};

pub(crate) const DISPLAY_LIMIT: usize = 3;
pub(crate) const SEARCH_FRONTIER: usize = 16;
pub(crate) const VALIDATION_LIMIT: usize = 16;
pub(crate) const COMPOUND_FRONTIER: usize = 3;
pub(crate) const DISCOVERY_TARGET_LIMIT: usize = 3;
pub(crate) const CONFIDENCE_WINDOW: f64 = 18.0;
pub(crate) const SYMBOL_PENALTY: f64 = 12.0;

pub(crate) fn compare(a: &Candidate, b: &Candidate) -> Ordering {
    b.evidence
        .resolved
        .cmp(&a.evidence.resolved)
        .then_with(|| a.evidence.unresolved.cmp(&b.evidence.unresolved))
        .then_with(|| b.evidence.confidence.total_cmp(&a.evidence.confidence))
        .then_with(|| b.score.total_cmp(&a.score))
}
pub(crate) fn sort(candidates: &mut [Candidate]) {
    candidates.sort_by(compare);
}
pub(crate) fn unique(candidates: impl IntoIterator<Item = Candidate>) -> Vec<Candidate> {
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.command.clone()))
        .collect()
}
pub(crate) fn choices(candidates: impl IntoIterator<Item = Candidate>) -> Vec<Candidate> {
    unique(
        candidates
            .into_iter()
            .filter(|candidate| !candidate.is_literal()),
    )
    .into_iter()
    .take(DISPLAY_LIMIT)
    .collect()
}
pub(crate) enum Original {
    Separate,
    IfMissing,
}
pub(crate) fn present(
    input: &str,
    candidates: Vec<Candidate>,
    original: Original,
) -> Vec<Candidate> {
    let mut candidates = choices(candidates);
    if matches!(original, Original::Separate)
        || candidates
            .iter()
            .all(|candidate| candidate.command != input)
    {
        candidates.push(Candidate::literal(input));
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(command: &str, score: f64, confidence: f64, unresolved: usize) -> Candidate {
        let mut candidate = Candidate::literal(command);
        candidate.literal = None;
        candidate.score = score;
        candidate.evidence.confidence = confidence;
        candidate.evidence.resolved = unresolved == 0;
        candidate.evidence.unresolved = unresolved;
        candidate
    }
    #[test]
    fn evidence_precedes_search_score_and_deduplication_keeps_the_best_evidence() {
        let mut candidates = vec![
            candidate("same", 200.0, 100.0, 1),
            candidate("same", 10.0, 80.0, 0),
            candidate("other", 100.0, 70.0, 0),
        ];
        sort(&mut candidates);
        let choices = choices(candidates);
        assert_eq!(choices.len(), 2);
        assert_eq!(choices[0].command, "same");
        assert_eq!(choices[0].score, 10.0);
    }
    #[test]
    fn presentation_limits_choices_without_spending_a_slot_on_the_original() {
        let candidates = (0..10)
            .map(|i| candidate(&format!("choice {i}"), 100.0, 100.0, 0))
            .collect();
        let result = present("original", candidates, Original::IfMissing);
        assert_eq!(result.len(), DISPLAY_LIMIT + 1);
        assert!(result.last().unwrap().is_literal());
        let result = present(
            "original",
            vec![candidate("original", 100.0, 100.0, 0)],
            Original::IfMissing,
        );
        assert_eq!(result.len(), 1);
        assert!(!result[0].is_literal());
    }
}
