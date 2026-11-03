//! Independent workspace client for herdr-core.
#![forbid(unsafe_code)]
pub mod document;
pub mod model;
pub mod view;

pub mod client;
pub mod protocol;

pub mod transport;

pub mod commands;
pub mod sync;

pub mod worktrees;
