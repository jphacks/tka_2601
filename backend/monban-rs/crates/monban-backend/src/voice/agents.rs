//! The door and shop reception agents (port of `DoorAgent` and `ReceptionAgent` in
//! `voice/agent.py`).
//!
//! An agent decides each reply: `on_user_turn_completed` runs before the reply and may skip
//! it, `llm_node` returns the reply text (fixed, or from the model) or tool calls, and
//! `call_tool` runs a tool the model asked for. The session ([`super::session`]) drives them
//! the way livekit-agents' AgentSession does for one turn.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use chrono_tz::Asia::Tokyo;
use futures::stream::{self, BoxStream, StreamExt};
use rand::RngCore;
use serde_json::{json, Map, Value};

use monban_policy::agent_rules::{self, FailurePlan, TurnOutcomes};
use monban_policy::reception::business_visits::{
    business_visit_decline_reply, business_visit_reason_code, classify_business_visit,
    normalize_business_visit_policies, BusinessVisitPolicies, POLITE_DECLINE, STAFF_HANDOFF,
};
use monban_policy::reception::matching::Reservation;
use monban_policy::reception::policy::reception_prompt_v12;
use monban_policy::reception::prefetch::{
    extract_exact_appointment_time, extract_self_identified_name, has_unresolved_clock_fragment,
};
use monban_policy::reception::privacy::{third_party_disclosure_requested, untrusted_tool_result_requested};
use monban_policy::reception::reason_codes::staff_reason_label;
use monban_policy::reception::store_context::{compose_system_prompt, public_info_reply};
use monban_policy::reception::tool_schema::{
    customer_name_is_self_identified, normalize_staff_reason, search_is_applicable, staff_handoff_required,
};
use monban_policy::reception::tool_schema_v17::{
    available_tools_v17, tool_schema_v17, ToolAvailabilityV17, TOOL_NAMES_V17,
};
use monban_policy::visit_policy::VisitState;

use super::chat::{ChatContext, ChatItem};
use crate::persistence::device_api::ShopProfile;
use crate::reception::desk::ReceptionDesk;
use crate::services::py_json_dumps_ensure_ascii_false as dumps;

/// One piece of what `llm_node` produces.
#[derive(Debug, Clone, PartialEq)]
pub enum NodeEvent {
    Text(String),
    ToolCall { call_id: String, name: String, arguments: String },
}

pub type NodeStream = BoxStream<'static, anyhow::Result<NodeEvent>>;

/// The Chat Completions model behind `Agent.default.llm_node`.
#[async_trait::async_trait]
pub trait ChatModel: Send + Sync {
    async fn stream(
        &self,
        messages: Vec<Value>,
        tools: Vec<Value>,
        tool_choice: Option<&'static str>,
    ) -> anyhow::Result<NodeStream>;
}

/// `Agent.default.llm_node`: the context and the named tools, sent to the model.
pub async fn default_llm_node(
    model: &dyn ChatModel,
    context: &ChatContext,
    tools: &[&str],
    tool_choice: Option<&'static str>,
) -> anyhow::Result<NodeStream> {
    let schemas: Vec<Value> = tools
        .iter()
        .filter_map(|name| tool_schema_v17(name))
        .map(|function| json!({"type": "function", "function": function}))
        .collect();
    model.stream(context.to_openai(), schemas, tool_choice).await
}

fn once(text: String) -> NodeStream {
    stream::once(async move { Ok(NodeEvent::Text(text)) }).boxed()
}

fn empty() -> NodeStream {
    stream::empty().boxed()
}

/// How a tool call ended, as livekit records the output.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub output: String,
    pub is_error: bool,
}

#[async_trait::async_trait]
pub trait Agent: Send {
    fn instructions(&self) -> String;
    fn greeting(&self) -> String;
    /// Every registered tool, in the order livekit lists them (by name).
    fn tools(&self) -> Vec<&'static str>;
    /// False skips the reply (`StopResponse`); the user turn is then not kept.
    async fn on_user_turn_completed(&mut self, history: &ChatContext, text: &str) -> bool;
    async fn llm_node(
        &mut self,
        context: ChatContext,
        tool_choice: Option<&'static str>,
        model: &dyn ChatModel,
    ) -> anyhow::Result<NodeStream>;
    async fn call_tool(&mut self, name: &str, arguments: &Value) -> ToolResult;
    fn staff_requested(&self) -> bool {
        false
    }
}

// ---------------------------------------------------------------------------------------
// Door
// ---------------------------------------------------------------------------------------

pub struct DoorAgent {
    pub house_rules: String,
}

impl DoorAgent {
    pub fn new(house_rules: &str, max_chars: usize, default_rules: &str) -> Self {
        Self { house_rules: agent_rules::door_safe_rules(house_rules, max_chars, default_rules) }
    }

    fn state(&self, messages: &[(&'static str, String)]) -> VisitState {
        VisitState::from_messages(messages, &self.house_rules)
    }
}

#[async_trait::async_trait]
impl Agent for DoorAgent {
    fn instructions(&self) -> String {
        agent_rules::door_instructions(&self.house_rules)
    }

    fn greeting(&self) -> String {
        agent_rules::DOOR_GREETING.to_string()
    }

    fn tools(&self) -> Vec<&'static str> {
        Vec::new()
    }

    async fn on_user_turn_completed(&mut self, history: &ChatContext, text: &str) -> bool {
        let mut messages = history.messages();
        messages.push(("user", text.to_string()));
        !self.state(&messages).should_wait()
    }

    async fn llm_node(
        &mut self,
        context: ChatContext,
        tool_choice: Option<&'static str>,
        model: &dyn ChatModel,
    ) -> anyhow::Result<NodeStream> {
        let state = self.state(&context.messages());
        if state.should_wait() {
            return Ok(empty());
        }
        let context = context.with_state_instructions(&state.instructions());
        let mut reply = state.deterministic_reply();
        if state.closing {
            reply = Some(state.fallback());
        }
        let reply = match reply {
            Some(reply) => reply,
            None => {
                let mut chunks = String::new();
                let mut stream = default_llm_node(model, &context, &[], tool_choice).await?;
                while let Some(event) = stream.next().await {
                    if let NodeEvent::Text(text) = event? {
                        chunks.push_str(&text);
                    }
                }
                let reply = state.trim_after_farewell(chunks.trim());
                if state.validate(&reply) {
                    reply
                } else {
                    state.fallback()
                }
            }
        };
        Ok(if reply.is_empty() { empty() } else { once(reply) })
    }

    async fn call_tool(&mut self, name: &str, _arguments: &Value) -> ToolResult {
        ToolResult { output: format!("unknown tool `{name}`"), is_error: true }
    }
}

// ---------------------------------------------------------------------------------------
// Shop reception
// ---------------------------------------------------------------------------------------

const CHECKED_IN: [&str; 2] = ["checked_in", "already_arrived"];
const REQUESTED: [&str; 2] = ["requested", "already_requested"];
const RECORDED: [&str; 2] = ["recorded", "already_recorded"];

pub struct ReceptionAgent {
    pub desk: Arc<ReceptionDesk>,
    shop: Option<ShopProfile>,
    business_visit_kind: Option<&'static str>,
    business_visit_handled: HashSet<&'static str>,
    policies: BusinessVisitPolicies,
    public_context: BTreeMap<String, String>,
    instructions: String,
    pending_reservations: HashMap<String, Reservation>,
    arrivals: BTreeSet<String>,
    turn_arrivals: BTreeSet<String>,
    staff_recorded: BTreeSet<String>,
    search_attempted: bool,
    checkin_attempted: bool,
    staff_attempted: bool,
    request_staff_attempted: bool,
    request_staff_available: bool,
    staff_request_keys: HashSet<String>,
    turn_outcomes: TurnOutcomes,
    visitor_utterances: Vec<String>,
    prompted_name_answer: String,
    prefetch_attempted: bool,
    prefetch_cached_search: Option<(String, Option<String>, String)>,
}

fn status_of(payload: &Map<String, Value>) -> Option<&str> {
    payload.get("status").and_then(Value::as_str)
}

fn payload(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn token_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    hex::encode(buffer)
}

impl ReceptionAgent {
    pub fn new(desk: Arc<ReceptionDesk>, shop: Option<ShopProfile>) -> Self {
        let policies = normalize_business_visit_policies(None, None).expect("default policies are valid");
        let public_context: BTreeMap<String, String> = shop
            .as_ref()
            .map(|shop| shop.public_context(&chrono::Utc::now().with_timezone(&Tokyo)).into_iter().collect())
            .unwrap_or_default();
        let mut runtime_context = public_context.clone();
        runtime_context.insert("sales_policy".into(), policies.sales_policy.clone());
        runtime_context.insert("fee_collection_policy".into(), policies.fee_collection_policy.clone());
        let instructions = compose_system_prompt(&reception_prompt_v12(), Some(&runtime_context))
            .unwrap_or_else(|error| {
                tracing::warn!("store public context rejected; using the policy alone error={error}");
                reception_prompt_v12()
            });
        Self {
            desk,
            shop,
            business_visit_kind: None,
            business_visit_handled: HashSet::new(),
            policies,
            public_context,
            instructions,
            pending_reservations: HashMap::new(),
            arrivals: BTreeSet::new(),
            turn_arrivals: BTreeSet::new(),
            staff_recorded: BTreeSet::new(),
            search_attempted: false,
            checkin_attempted: false,
            staff_attempted: false,
            request_staff_attempted: false,
            request_staff_available: false,
            staff_request_keys: HashSet::new(),
            turn_outcomes: TurnOutcomes::new(),
            visitor_utterances: Vec::new(),
            prompted_name_answer: String::new(),
            prefetch_attempted: false,
            prefetch_cached_search: None,
        }
    }

    fn latest_user_message(&self) -> String {
        self.visitor_utterances.last().cloned().unwrap_or_default()
    }

    fn history(&self) -> String {
        self.visitor_utterances.join("\n")
    }

    fn policy_for_kind(&self, kind: &str) -> &str {
        if kind == "fee_collection" {
            &self.policies.fee_collection_policy
        } else {
            &self.policies.sales_policy
        }
    }

    fn record_tool_outcome(&mut self, operation: &str, payload: Map<String, Value>) {
        let status = payload.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
        let code = payload.get("code").and_then(|v| v.as_str()).unwrap_or("none");
        tracing::info!("reception_tool_outcome operation={operation} status={status} code={code}");
        self.turn_outcomes.insert(operation.to_string(), payload);
    }

    fn name_is_self_identified(&self, customer_name: &str) -> bool {
        if customer_name_is_self_identified(&self.history(), customer_name) {
            return true;
        }
        !self.prompted_name_answer.is_empty()
            && agent_rules::normalize_spoken_text(&self.prompted_name_answer)
                == agent_rules::normalize_spoken_text(customer_name)
    }

    async fn record_failure_handoff(&mut self, reason: &str) -> bool {
        let existing = self.turn_outcomes.get("request_staff").and_then(status_of);
        if existing.is_some_and(|status| REQUESTED.contains(&status)) {
            return true;
        }
        let result: Value = serde_json::from_str(&self.request_staff(reason).await).unwrap_or(Value::Null);
        result.get("status").and_then(Value::as_str).is_some_and(|status| REQUESTED.contains(&status))
    }

    /// `_deterministic_tool_failure_reply`.
    async fn tool_failure_reply(&mut self) -> Option<String> {
        match agent_rules::tool_failure_plan(&self.turn_outcomes)? {
            FailurePlan::Reply(text) => Some(text.to_string()),
            FailurePlan::Handoff { reason, requested, not_requested } => {
                Some(if self.record_failure_handoff(reason).await { requested } else { not_requested }.to_string())
            }
        }
    }

    // --- tools ----------------------------------------------------------------------

    pub async fn search_reservations(&mut self, customer_name: &str, time: Option<&str>) -> String {
        self.search_attempted = true;
        self.pending_reservations.clear();
        let invalid = |code: &str| payload(json!({"status": "invalid_request", "code": code}));
        if self.business_visit_kind.is_some() {
            let result = invalid("business_visit_is_not_a_reservation");
            self.record_tool_outcome("search", result.clone());
            return dumps(&Value::Object(result));
        }
        if !self.arrivals.is_empty() {
            return dumps(&Value::Object(invalid("arrival_already_recorded")));
        }
        let latest = self.latest_user_message();
        let failure = if customer_name.is_empty() {
            Some("customer_name_not_stated")
        } else if !self.name_is_self_identified(customer_name) {
            Some("customer_name_not_self_identified")
        } else if !search_is_applicable(&latest) {
            Some("search_not_applicable_to_service_question")
        } else if time.is_some_and(|time| !agent_rules::is_hh_mm(time)) {
            Some("appointment_time_must_be_hh_mm_or_null")
        } else if has_unresolved_clock_fragment(&latest) {
            Some("appointment_time_needs_clarification")
        } else {
            None
        };
        if let Some(code) = failure {
            let result = invalid(code);
            self.record_tool_outcome("search", result.clone());
            return dumps(&Value::Object(result));
        }
        if let Some((name, cached_time, output)) = self.prefetch_cached_search.clone() {
            if name == customer_name && cached_time.as_deref() == time {
                self.prefetch_cached_search = None;
                let result = payload(serde_json::from_str(&output).unwrap_or(Value::Null));
                let status = status_of(&result).map(str::to_string);
                self.record_tool_outcome("search", result);
                if !matches!(status.as_deref(), Some("matched" | "not_found" | "ambiguous")) {
                    self.request_staff_available = true;
                }
                return output;
            }
        }
        let result = self.desk.search_reservations(customer_name, time).await;
        let hh_mm = |reservation: &Reservation| reservation.start.with_timezone(&Tokyo).format("%H:%M").to_string();
        let result_payload = match result.status {
            "matched" => {
                let reservation = result.reservations[0].clone();
                let value = json!({
                    "status": "matched",
                    "reservation_id": reservation.event_id,
                    "customer_name": reservation.name,
                    "time": hh_mm(&reservation),
                });
                self.pending_reservations.insert(reservation.event_id.clone(), reservation);
                value
            }
            "ambiguous" => json!({
                "status": "ambiguous",
                "count": result.reservations.len(),
                "candidates": result.reservations.iter().map(|item| json!({
                    "reservation_id": item.event_id,
                    "customer_name": item.name,
                    "time": hh_mm(item),
                })).collect::<Vec<_>>(),
            }),
            other => json!({"status": other}),
        };
        let result_payload = payload(result_payload);
        if !matches!(status_of(&result_payload), Some("matched" | "not_found" | "ambiguous")) {
            self.request_staff_available = true;
        }
        self.record_tool_outcome("search", result_payload.clone());
        dumps(&Value::Object(result_payload))
    }

    pub async fn check_in(&mut self, reservation_id: &str) -> String {
        self.checkin_attempted = true;
        if self.business_visit_kind.is_some() {
            let result = payload(json!({"status": "error", "code": "business_visit_is_not_a_reservation"}));
            self.record_tool_outcome("check_in", result.clone());
            return dumps(&Value::Object(result));
        }
        let Some(candidate) = self.pending_reservations.remove(reservation_id) else {
            let result = payload(json!({"status": "error", "code": "reservation_not_confirmed"}));
            self.record_tool_outcome("check_in", result.clone());
            return dumps(&Value::Object(result));
        };
        let confirmation = self.desk.record_arrival(&candidate).await;
        if matches!(confirmation.status, "arrived" | "already_arrived") {
            self.arrivals.insert(reservation_id.to_string());
            self.turn_arrivals.insert(reservation_id.to_string());
        }
        let status = if confirmation.status == "arrived" { "checked_in" } else { confirmation.status };
        let result = payload(json!({"status": status, "reservation_id": reservation_id}));
        if !CHECKED_IN.contains(&status) {
            self.request_staff_available = true;
        }
        self.record_tool_outcome("check_in", result.clone());
        dumps(&Value::Object(result))
    }

    pub async fn notify_staff(&mut self, reservation_id: &str, reason: &str) -> String {
        self.staff_attempted = true;
        let result = if self.business_visit_kind.is_some() {
            json!({"status": "error", "code": "business_visit_is_not_a_reservation"})
        } else if reason != "予約客の来店" {
            json!({"status": "error", "code": "invalid_reason"})
        } else if reservation_id.is_empty() || !self.arrivals.contains(reservation_id) {
            json!({"status": "error", "code": "arrival_not_recorded"})
        } else {
            let result = self.desk.notify_staff_recorded(reservation_id, "予約客の来店");
            if result.get("status").and_then(Value::as_str).is_some_and(|s| RECORDED.contains(&s)) {
                self.staff_recorded.insert(reservation_id.to_string());
            }
            result
        };
        let result = payload(result);
        if !status_of(&result).is_some_and(|status| RECORDED.contains(&status)) {
            self.request_staff_available = true;
        }
        self.record_tool_outcome("notify_staff", result.clone());
        dumps(&Value::Object(result))
    }

    pub async fn request_staff(&mut self, reason: &str) -> String {
        let latest = self.latest_user_message();
        let history = self.history();
        let mut reason = reason.to_string();
        if let Some(kind) = self.business_visit_kind {
            if self.policy_for_kind(kind) != STAFF_HANDOFF {
                let result = payload(json!({"status": "error", "code": "business_visit_declined_by_store_policy"}));
                self.record_tool_outcome("request_staff", result.clone());
                return dumps(&Value::Object(result));
            }
            reason = business_visit_reason_code(kind).unwrap_or_default().to_string();
        }
        let search_status = self.turn_outcomes.get("search").and_then(status_of);
        if matches!(search_status, Some("not_found" | "ambiguous")) && !staff_handoff_required(&latest, &history) {
            return dumps(&json!({"status": "error", "code": "clarification_required"}));
        }
        if self.request_staff_attempted {
            let existing = self.turn_outcomes.get("request_staff").and_then(status_of);
            if existing.is_some_and(|status| REQUESTED.contains(&status)) {
                return dumps(&json!({"status": "already_requested"}));
            }
            let result = payload(json!({"status": "error", "code": "duplicate_request"}));
            self.record_tool_outcome("request_staff", result.clone());
            return dumps(&Value::Object(result));
        }
        self.request_staff_attempted = true;
        let Some(label) = staff_reason_label(&reason) else {
            let result = payload(json!({"status": "error", "code": "invalid_reason"}));
            self.record_tool_outcome("request_staff", result.clone());
            return dumps(&Value::Object(result));
        };
        let request_key = normalize_staff_reason(&reason);
        if !request_key.is_empty() && self.staff_request_keys.contains(&request_key) {
            let result = payload(json!({"status": "already_requested"}));
            self.record_tool_outcome("request_staff", result.clone());
            return dumps(&Value::Object(result));
        }
        self.desk.request_staff(label);
        if !request_key.is_empty() {
            self.staff_request_keys.insert(request_key);
        }
        let result = payload(json!({"status": "requested"}));
        self.record_tool_outcome("request_staff", result.clone());
        dumps(&Value::Object(result))
    }
}

#[async_trait::async_trait]
impl Agent for ReceptionAgent {
    fn instructions(&self) -> String {
        self.instructions.clone()
    }

    /// The shop's own greeting from Supabase, or the default reception line.
    fn greeting(&self) -> String {
        match self.shop.as_ref().map(|shop| shop.greeting.as_str()).filter(|g| !g.is_empty()) {
            Some(greeting) => greeting.chars().take(200).collect(),
            None => agent_rules::RECEPTION_GREETING.to_string(),
        }
    }

    fn tools(&self) -> Vec<&'static str> {
        let mut names = TOOL_NAMES_V17.to_vec();
        names.sort_unstable();
        names
    }

    async fn on_user_turn_completed(&mut self, history: &ChatContext, text: &str) -> bool {
        self.pending_reservations.clear();
        self.turn_arrivals.clear();
        self.search_attempted = false;
        self.checkin_attempted = false;
        self.staff_attempted = false;
        self.request_staff_attempted = false;
        self.turn_outcomes = TurnOutcomes::new();
        self.prefetch_attempted = false;
        self.prefetch_cached_search = None;
        let previous_assistant = history.last_assistant_text();
        if let Some(stated) = extract_self_identified_name(text) {
            self.prompted_name_answer = agent_rules::normalize_spoken_text(&stated);
        } else if agent_rules::assistant_asked_visitor_name(&previous_assistant) {
            self.prompted_name_answer = agent_rules::direct_name_answer(text);
        } else if agent_rules::corrects_previous_name(text, &previous_assistant) {
            self.prompted_name_answer.clear();
        }
        if !text.is_empty() {
            self.visitor_utterances.push(text.to_string());
        }
        let history_text = self.history();
        self.business_visit_kind = classify_business_visit(&history_text);
        self.request_staff_available = staff_handoff_required(text, &history_text)
            || self.business_visit_kind.is_some_and(|kind| self.policy_for_kind(kind) == STAFF_HANDOFF);
        true
    }

    async fn llm_node(
        &mut self,
        mut context: ChatContext,
        tool_choice: Option<&'static str>,
        model: &dyn ChatModel,
    ) -> anyhow::Result<NodeStream> {
        let latest = self.latest_user_message();
        if untrusted_tool_result_requested(&latest) {
            return Ok(once(agent_rules::UNTRUSTED_TOOL_RESULT_REPLY.into()));
        }
        if third_party_disclosure_requested(&latest) {
            return Ok(once(agent_rules::THIRD_PARTY_DISCLOSURE_REPLY.into()));
        }
        if agent_rules::RESERVATION_DETAILS_IN_PROGRESS.is_match(&latest) {
            return Ok(once(agent_rules::RESERVATION_DETAILS_IN_PROGRESS_REPLY.into()));
        }
        if let Some(reply) = agent_rules::wait_location_reply(&latest, &context.last_assistant_text()) {
            return Ok(once(reply));
        }
        if let Some(reply) = agent_rules::reservation_time_reply(&latest, &self.history()) {
            return Ok(once(reply));
        }
        if !self.arrivals.is_empty() && self.turn_arrivals.is_empty() && agent_rules::asks_arrival_confirmation(&latest) {
            return Ok(once(agent_rules::ARRIVAL_ALREADY_RECORDED_REPLY.into()));
        }
        if let Some(kind) = self.business_visit_kind {
            if self.business_visit_handled.contains(kind) {
                let reply = if extract_self_identified_name(&latest).is_some() {
                    agent_rules::BUSINESS_VISIT_NAME_FOLLOWUP_REPLY
                } else {
                    agent_rules::BUSINESS_VISIT_FOLLOWUP_REPLY
                };
                return Ok(once(reply.into()));
            }
            if self.policy_for_kind(kind) == POLITE_DECLINE {
                self.business_visit_handled.insert(kind);
                return Ok(once(business_visit_decline_reply(kind).into()));
            }
            let reason = business_visit_reason_code(kind).unwrap_or_default().to_string();
            let handoff: Value = serde_json::from_str(&self.request_staff(&reason).await).unwrap_or(json!({"status": "error"}));
            let reply = if handoff.get("status").and_then(Value::as_str).is_some_and(|s| REQUESTED.contains(&s)) {
                self.business_visit_handled.insert(kind);
                agent_rules::tool_completion_reply(&self.turn_outcomes)
                    .unwrap_or(agent_rules::BUSINESS_VISIT_HANDOFF_REPLY)
                    .to_string()
            } else {
                self.tool_failure_reply()
                    .await
                    .unwrap_or_else(|| agent_rules::BUSINESS_VISIT_HANDOFF_FAILED_REPLY.to_string())
            };
            return Ok(once(reply));
        }
        if let Some(reply) = public_info_reply(&latest, &self.public_context) {
            return Ok(once(reply));
        }
        if !self.prefetch_attempted && !self.search_attempted && self.arrivals.is_empty() {
            self.prefetch_attempted = true;
            let history = self.history();
            let name = extract_self_identified_name(&history);
            let appointment_time = extract_exact_appointment_time(&history);
            let fresh = extract_self_identified_name(&latest).is_some() || extract_exact_appointment_time(&latest).is_some();
            if let (Some(name), Some(appointment_time)) = (name, appointment_time) {
                if fresh
                    && !has_unresolved_clock_fragment(&latest)
                    && search_is_applicable(&latest)
                    && !staff_handoff_required(&latest, &history)
                {
                    let previous_handoff = self.request_staff_available;
                    let output = self.search_reservations(&name, Some(&appointment_time)).await;
                    let matched = serde_json::from_str::<Value>(&output)
                        .ok()
                        .and_then(|value| value.get("status").and_then(Value::as_str).map(|s| s == "matched"))
                        .unwrap_or(false);
                    if matched {
                        let call_id = format!("monban-prefetch-{}", token_hex(16));
                        let arguments = dumps(&json!({"customer_name": name, "time": appointment_time}));
                        context.items.push(ChatItem::FunctionCall {
                            group: call_id.clone(),
                            call_id: call_id.clone(),
                            name: "search_reservations".into(),
                            arguments,
                        });
                        context.items.push(ChatItem::FunctionCallOutput {
                            call_id,
                            name: "search_reservations".into(),
                            output,
                            is_error: false,
                        });
                    } else {
                        self.search_attempted = false;
                        self.pending_reservations.clear();
                        self.turn_outcomes.remove("search");
                        self.request_staff_available = previous_handoff;
                        self.prefetch_cached_search = Some((name, Some(appointment_time), output));
                    }
                }
            }
        }
        let check_in = self.turn_outcomes.get("check_in").cloned().unwrap_or_default();
        if status_of(&check_in).is_some_and(|status| CHECKED_IN.contains(&status)) && !self.staff_attempted {
            if let Some(reservation_id) = check_in.get("reservation_id").and_then(Value::as_str) {
                if self.turn_arrivals.contains(reservation_id) {
                    self.notify_staff(reservation_id, "予約客の来店").await;
                }
            }
        }
        if let Some(reply) = self.tool_failure_reply().await {
            return Ok(once(reply));
        }
        if let Some(reply) = agent_rules::tool_completion_reply(&self.turn_outcomes) {
            return Ok(once(reply.into()));
        }
        let tools = self.tools();
        let available = available_tools_v17(
            &tools,
            &ToolAvailabilityV17 {
                search_attempted: self.search_attempted,
                check_in_attempted: self.checkin_attempted,
                notify_staff_attempted: self.staff_attempted || !self.staff_recorded.is_empty(),
                request_staff_attempted: self.request_staff_attempted,
                confirmed_reservation: !self.pending_reservations.is_empty(),
                arrival_recorded: !self.arrivals.is_empty(),
                arrival_recorded_this_turn: !self.turn_arrivals.is_empty(),
                latest_user_message: &latest,
                request_staff_available: self.request_staff_available,
                business_visit: self.business_visit_kind.is_some(),
            },
        );
        default_llm_node(model, &context, &available, tool_choice).await
    }

    async fn call_tool(&mut self, name: &str, arguments: &Value) -> ToolResult {
        let text = |key: &str| arguments.get(key).and_then(Value::as_str).map(str::to_string);
        let missing = |key: &str| ToolResult {
            output: format!("Error parsing arguments for `{name}`: missing a required argument: '{key}'"),
            is_error: true,
        };
        let output = match name {
            "search_reservations" => {
                let Some(customer_name) = text("customer_name") else { return missing("customer_name") };
                let time = match arguments.get("time") {
                    Some(Value::Null) => None,
                    Some(Value::String(time)) => Some(time.clone()),
                    _ => return missing("time"),
                };
                self.search_reservations(&customer_name, time.as_deref()).await
            }
            "check_in" => {
                let Some(id) = text("reservation_id") else { return missing("reservation_id") };
                self.check_in(&id).await
            }
            "notify_staff" => {
                let Some(id) = text("reservation_id") else { return missing("reservation_id") };
                let Some(reason) = text("reason") else { return missing("reason") };
                self.notify_staff(&id, &reason).await
            }
            "request_staff" => {
                let Some(reason) = text("reason") else { return missing("reason") };
                self.request_staff(&reason).await
            }
            other => return ToolResult { output: format!("unknown tool `{other}`"), is_error: true },
        };
        ToolResult { output, is_error: false }
    }

    fn staff_requested(&self) -> bool {
        !self.desk.staff_requests().is_empty()
    }
}
