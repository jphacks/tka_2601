//! Pure conversation rules ported from the Python backend (Issue #77).
//!
//! Every function here matches the Python module it names, including Python `re`
//! semantics (see [`pyre`]) and code-point string indexing. `tests/golden.rs` compares the
//! outputs with values exported from the Python implementation.

pub mod agent_rules;
pub mod house_rules;
pub mod pyre;
pub mod reception;
pub mod visit_policy;

/// A `ValueError` raised by the Python implementation, with the same message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyError(pub String);

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PolicyError {}
