//! Reception prompts from `monban_backend/reception/policy.py` and `policy_v12.py`.
//!
//! The text files under `src/data/` were exported verbatim from the Python constants by
//! `tools/golden/generate.py`; the golden test checks them again.

pub const RECEPTION_INSTRUCTIONS: &str = include_str!("../data/reception_instructions.txt");
pub const RECEPTION_TOOL_POLICY_V9: &str = include_str!("../data/reception_tool_policy_v9.txt");
pub const RECEPTION_TOOL_POLICY_V10: &str = include_str!("../data/reception_tool_policy_v10.txt");
pub const RECEPTION_TOOL_POLICY_V11: &str = include_str!("../data/reception_tool_policy_v11.txt");

pub const RECEPTION_INSTRUCTIONS_V12: &str = include_str!("../data/reception_instructions_v12.txt");
pub const RECEPTION_TOOL_POLICY_V12: &str = include_str!("../data/reception_tool_policy_v12.txt");
pub const RECEPTION_SAFETY_POLICY_V1: &str = include_str!("../data/reception_safety_policy_v1.txt");

/// `RECEPTION_PROMPT_V12`: the system prompt of the v17 reception agent.
pub fn reception_prompt_v12() -> String {
    format!("{RECEPTION_INSTRUCTIONS_V12}\n\n{RECEPTION_TOOL_POLICY_V12}\n\n{RECEPTION_SAFETY_POLICY_V1}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v12_prompt_uses_split_check_in_and_notify_tools() {
        assert!(!reception_prompt_v12().contains("complete_arrival"));
    }
}
