# Preserved implementation artifacts

This directory retains source artifacts from the two pre-consolidation Fibonacci worktrees when they are superseded by, but not identical to, the active implementation.

- `runner-pre-streaming.rs` is the older Rust runner snapshot formerly stored as `runner 2.rs`. It is intentionally excluded from the Cargo module tree and kept for historical comparison only.

Active Rust code lives in `../crates/fibonacci-core/src/`.
