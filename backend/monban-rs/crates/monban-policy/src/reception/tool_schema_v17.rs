//! Port of `monban_backend/reception/tool_schema_v17.py` (the four-tool reception contract).

use std::sync::LazyLock;

use serde_json::Value;

use super::tool_schema::{function_by_name, search_is_applicable};

pub const SEARCH_RESERVATIONS: &str = "search_reservations";
pub const CHECK_IN: &str = "check_in";
pub const NOTIFY_STAFF: &str = "notify_staff";
pub const REQUEST_STAFF: &str = "request_staff";
pub const TOOL_NAMES_V17: [&str; 4] = [SEARCH_RESERVATIONS, CHECK_IN, NOTIFY_STAFF, REQUEST_STAFF];

/// `TOOLS_V17` in OpenAI tool format (`[{"type": "function", "function": {...}}]`).
pub static TOOLS_V17: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../data/tools_v17.json")).expect("valid tools_v17.json")
});

/// `TOOL_SCHEMAS_V17[name]`: the `function` object (name, description, parameters).
pub fn tool_schema_v17(name: &str) -> Option<&'static Value> {
    function_by_name(&TOOLS_V17, name)
}

/// Reception state that decides which v17 tools the model may call.
#[derive(Debug, Clone, Default)]
pub struct ToolAvailabilityV17<'a> {
    pub search_attempted: bool,
    pub check_in_attempted: bool,
    pub notify_staff_attempted: bool,
    pub request_staff_attempted: bool,
    pub confirmed_reservation: bool,
    pub arrival_recorded: bool,
    pub arrival_recorded_this_turn: bool,
    pub latest_user_message: &'a str,
    pub request_staff_available: bool,
    pub business_visit: bool,
}

/// `available_tools_v17`: keep only the tool names the confirmed reception state permits,
/// in their original order.
pub fn available_tools_v17<'n>(tools: &[&'n str], state: &ToolAvailabilityV17<'_>) -> Vec<&'n str> {
    let search_applicable = search_is_applicable(state.latest_user_message);
    let has_arrival = state.arrival_recorded || state.arrival_recorded_this_turn;
    tools
        .iter()
        .copied()
        .filter(|&name| {
            if name == SEARCH_RESERVATIONS
                && (state.search_attempted
                    || state.confirmed_reservation
                    || has_arrival
                    || !search_applicable)
            {
                return false;
            }
            if state.business_visit && [SEARCH_RESERVATIONS, CHECK_IN, NOTIFY_STAFF].contains(&name)
            {
                return false;
            }
            if name == CHECK_IN
                && (!state.confirmed_reservation || state.check_in_attempted || has_arrival)
            {
                return false;
            }
            if name == NOTIFY_STAFF
                && (!state.arrival_recorded_this_turn || state.notify_staff_attempted)
            {
                return false;
            }
            if name == REQUEST_STAFF
                && (state.request_staff_attempted || !state.request_staff_available)
            {
                return false;
            }
            true
        })
        .collect()
}
