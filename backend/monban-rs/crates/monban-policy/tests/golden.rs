//! Differential test against values exported from the Python implementation.
//!
//! Regenerate the fixtures with `tools/golden/generate.py` (see its header).

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use chrono::DateTime;
use serde_json::{json, Value};

use monban_policy::agent_rules::{self, FailurePlan, TurnOutcomes};
use monban_policy::house_rules::{
    build_house_rules, extra_instructions_capacity, HouseSettings, Mode,
};
use monban_policy::reception::{
    business_visits, matching, policy, prefetch, privacy, reason_codes, store_context, tool_schema,
    tool_schema_v17,
};
use monban_policy::visit_policy::{self, VisitState};

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(format!("{name}.json"));
    serde_json::from_str(&fs::read_to_string(&path).expect("golden file")).expect("golden json")
}

fn s(value: &Value) -> &str {
    value.as_str().expect("string")
}

fn opt(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

/// Collects mismatches so one run reports every difference.
#[derive(Default)]
struct Diff {
    checked: usize,
    failures: Vec<String>,
}

impl Diff {
    fn eq<T: PartialEq + std::fmt::Debug>(
        &mut self,
        what: impl FnOnce() -> String,
        actual: T,
        expected: T,
    ) {
        self.checked += 1;
        if actual != expected && self.failures.len() < 40 {
            self.failures.push(format!(
                "{}\n  rust:   {actual:?}\n  python: {expected:?}",
                what()
            ));
        } else if actual != expected {
            self.failures.push(String::new());
        }
    }

    fn finish(self, name: &str) {
        eprintln!("{name}: {} checks", self.checked);
        assert!(
            self.failures.is_empty(),
            "{name}: {} of {} checks differ\n{}",
            self.failures.len(),
            self.checked,
            self.failures
                .iter()
                .filter(|f| !f.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}

fn state_values(state: &VisitState, replies: &[String], tail: &str) -> Vec<Value> {
    let instructions = state.instructions();
    let summary = instructions
        .strip_suffix(tail)
        .map(str::to_string)
        .unwrap_or(instructions);
    vec![
        json!(state.purpose.as_str()),
        json!(state.no_parcel),
        json!(state.placed),
        json!(state.photographed),
        json!(state.closing),
        json!(state.closing_said),
        json!(state.asked_purpose),
        json!(state.asked_delivery_placement),
        json!(state.asked_delivery_slip),
        json!(state.requested_delivery_location),
        json!(state.visitor_will_place),
        json!(state.latest_user_text),
        json!(state.pending_question.map(|q| q.as_str())),
        json!(state.name_confirmation),
        json!(state.presence_question),
        json!(state.mailbox_does_not_fit),
        json!(state.delivery_unavailable),
        json!(state.delivery_location_unavailable),
        json!(state.circular_board_placed),
        json!(state.circular_board_acknowledged),
        json!(state.repetition_complaint),
        json!(state.delivery_allowed()),
        json!(state.has_circular_board_rule()),
        json!(state.requests_delivery_slip()),
        json!(state.should_wait()),
        json!(state.deterministic_reply()),
        json!(state.fallback()),
        json!(summary),
        json!(replies
            .iter()
            .map(|reply| state.validate(reply))
            .collect::<Vec<_>>()),
        json!(replies
            .iter()
            .map(|reply| {
                let trimmed = state.trim_after_farewell(reply);
                (trimmed != *reply).then_some(trimmed)
            })
            .collect::<Vec<_>>()),
    ]
}

fn compare_state(
    diff: &mut Diff,
    fields: &[Value],
    label: &str,
    actual: Vec<Value>,
    expected: &Value,
) {
    for (index, (actual, expected)) in actual
        .iter()
        .zip(expected.as_array().expect("values"))
        .enumerate()
    {
        let field = s(&fields[index]);
        diff.eq(|| format!("{label} field={field}"), actual, expected);
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|v| s(v).to_string())
        .collect()
}

#[test]
fn visit_policy_matches_python() {
    let helpers = load("visit_policy_helpers");
    let tail = s(&helpers["instructions_tail"]).to_string();
    let mut diff = Diff::default();
    for record in helpers["records"].as_array().unwrap() {
        let text = s(&record["text"]);
        diff.eq(
            || format!("compact {text:?}"),
            visit_policy::compact(text),
            s(&record["compact"]).to_string(),
        );
        diff.eq(
            || format!("is_filler {text:?}"),
            visit_policy::is_filler(text),
            record["is_filler"].as_bool().unwrap(),
        );
        diff.eq(
            || format!("purpose {text:?}"),
            visit_policy::purpose_from_text(&visit_policy::compact(text)).as_str(),
            s(&record["purpose"]),
        );
    }
    let empty = VisitState::default();
    diff.eq(
        || "instructions tail".into(),
        empty.instructions().ends_with(&tail),
        true,
    );

    let single = load("visit_policy_single");
    let fields = single["fields"].as_array().unwrap().clone();
    let rules = strings(&single["house_rules"]);
    let replies = strings(&single["replies"]);
    for record in single["records"].as_array().unwrap() {
        let text = s(&record["text"]);
        let rule = &rules[record["rules"].as_u64().unwrap() as usize];
        let state = VisitState::from_messages(&[("user", text)], rule);
        compare_state(
            &mut diff,
            &fields,
            &format!("single {text:?} rules={}", record["rules"]),
            state_values(&state, &replies, &tail),
            &record["state"],
        );
    }

    let conversations = load("visit_policy_conversations");
    let rules = strings(&conversations["house_rules"]);
    for record in conversations["records"].as_array().unwrap() {
        let messages: Vec<(String, String)> = record["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| (s(&pair[0]).to_string(), s(&pair[1]).to_string()))
            .collect();
        let rule = &rules[record["rules"].as_u64().unwrap() as usize];
        let replies = strings(&record["replies"]);
        let state = VisitState::from_messages(&messages, rule);
        compare_state(
            &mut diff,
            &fields,
            &format!("conversation {messages:?} rules={}", record["rules"]),
            state_values(&state, &replies, &tail),
            &record["state"],
        );
    }
    diff.finish("visit_policy");
}

#[test]
fn reception_text_rules_match_python() {
    let golden = load("reception_text");
    let names = strings(&golden["names"]);
    let mut diff = Diff::default();
    for record in golden["records"].as_array().unwrap() {
        let text = s(&record["text"]);
        let history = s(&record["history"]);
        let label = |name: &str| format!("{name} text={text:?} history={history:?}");
        diff.eq(
            || label("extract_self_identified_name"),
            prefetch::extract_self_identified_name(text),
            opt(&record["extract_self_identified_name"]),
        );
        diff.eq(
            || label("extract_exact_appointment_time"),
            prefetch::extract_exact_appointment_time(text),
            opt(&record["extract_exact_appointment_time"]),
        );
        diff.eq(
            || label("extract_explicit_appointment_time"),
            prefetch::extract_explicit_appointment_time(text),
            opt(&record["extract_explicit_appointment_time"]),
        );
        diff.eq(
            || label("extract_explicit_appointment_time_joined"),
            prefetch::extract_explicit_appointment_time(&format!("{history}\n{text}")),
            opt(&record["extract_explicit_appointment_time_joined"]),
        );
        diff.eq(
            || label("has_unresolved_clock_fragment"),
            prefetch::has_unresolved_clock_fragment(text),
            record["has_unresolved_clock_fragment"].as_bool().unwrap(),
        );
        diff.eq(
            || label("third_party_disclosure_requested"),
            privacy::third_party_disclosure_requested(text),
            record["third_party_disclosure_requested"]
                .as_bool()
                .unwrap(),
        );
        diff.eq(
            || label("untrusted_tool_result_requested"),
            privacy::untrusted_tool_result_requested(text),
            record["untrusted_tool_result_requested"].as_bool().unwrap(),
        );
        diff.eq(
            || label("classify_business_visit"),
            business_visits::classify_business_visit(text).map(str::to_string),
            opt(&record["classify_business_visit"]),
        );
        diff.eq(
            || label("search_is_applicable"),
            tool_schema::search_is_applicable(text),
            record["search_is_applicable"].as_bool().unwrap(),
        );
        diff.eq(
            || label("is_reservation_menu_query"),
            tool_schema::is_reservation_menu_query(text, ""),
            record["is_reservation_menu_query"].as_bool().unwrap(),
        );
        diff.eq(
            || label("is_reservation_menu_query_history"),
            tool_schema::is_reservation_menu_query(text, history),
            record["is_reservation_menu_query_history"]
                .as_bool()
                .unwrap(),
        );
        diff.eq(
            || label("menu_query_needs_time"),
            tool_schema::menu_query_needs_time(text, ""),
            record["menu_query_needs_time"].as_bool().unwrap(),
        );
        diff.eq(
            || label("menu_query_needs_time_history"),
            tool_schema::menu_query_needs_time(text, history),
            record["menu_query_needs_time_history"].as_bool().unwrap(),
        );
        diff.eq(
            || label("staff_handoff_required"),
            tool_schema::staff_handoff_required(text, ""),
            record["staff_handoff_required"].as_bool().unwrap(),
        );
        diff.eq(
            || label("staff_handoff_required_history"),
            tool_schema::staff_handoff_required(text, history),
            record["staff_handoff_required_history"].as_bool().unwrap(),
        );
        diff.eq(
            || label("normalize_staff_reason"),
            tool_schema::normalize_staff_reason(text),
            s(&record["normalize_staff_reason"]).to_string(),
        );
        diff.eq(
            || label("normalize_name"),
            matching::normalize_name(text),
            s(&record["normalize_name"]).to_string(),
        );
        diff.eq(
            || label("direct_name_answer"),
            agent_rules::direct_name_answer(text),
            s(&record["direct_name_answer"]).to_string(),
        );
        for (index, name) in names.iter().enumerate() {
            diff.eq(
                || label(&format!("customer_name_is_self_identified name={name:?}")),
                tool_schema::customer_name_is_self_identified(text, name),
                record["self_identified"][index].as_bool().unwrap(),
            );
        }
        diff.eq(
            || label("wait_location_question"),
            agent_rules::WAIT_LOCATION_QUESTION.is_match(text),
            record["wait_location_question"].as_bool().unwrap(),
        );
        diff.eq(
            || label("reservation_time_question"),
            agent_rules::RESERVATION_TIME_QUESTION.is_match(text),
            record["reservation_time_question"].as_bool().unwrap(),
        );
        diff.eq(
            || label("reservation_details_in_progress"),
            agent_rules::RESERVATION_DETAILS_IN_PROGRESS.is_match(text),
            record["reservation_details_in_progress"].as_bool().unwrap(),
        );
    }
    for record in load("wait_location").as_array().unwrap() {
        let (question, prior) = (s(&record["question"]), s(&record["prior"]));
        diff.eq(
            || format!("wait_location_reply {question:?} {prior:?}"),
            agent_rules::wait_location_reply(question, prior),
            opt(&record["reply"]),
        );
    }
    diff.finish("reception_text");
}

fn string_map(value: &Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .expect("object")
        .iter()
        .map(|(key, value)| (key.clone(), s(value).to_string()))
        .collect()
}

#[test]
fn store_context_matches_python() {
    let golden = load("store_context");
    let mut diff = Diff::default();
    let contexts: Vec<BTreeMap<String, String>> = golden["contexts"]
        .as_array()
        .unwrap()
        .iter()
        .map(string_map)
        .collect();
    for record in golden["replies"].as_array().unwrap() {
        let text = s(&record["text"]);
        for (index, context) in contexts.iter().enumerate() {
            diff.eq(
                || format!("public_info_reply {text:?} context={index}"),
                store_context::public_info_reply(text, context),
                opt(&record["replies"][index]),
            );
        }
    }
    let prompt = policy::reception_prompt_v12();
    diff.eq(
        || "prompt_v12".into(),
        prompt.as_str(),
        s(&golden["prompt_v12"]),
    );
    for record in golden["compose"].as_array().unwrap() {
        let context = (!record["context"].is_null()).then(|| {
            record["context"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), s(value).to_string()))
                .collect::<BTreeMap<_, _>>()
        });
        let actual = store_context::compose_system_prompt(&prompt, context.as_ref());
        let expected = match record.get("ok") {
            Some(ok) => Ok(s(ok).to_string()),
            None => Err(s(&record["error"]).to_string()),
        };
        diff.eq(
            || format!("compose {:?}", record["context"]),
            actual.map_err(|e| e.0),
            expected,
        );
    }
    for record in golden["normalize"].as_array().unwrap() {
        let actual = store_context::normalize_public_context(&string_map(&record["values"]));
        let expected = match record.get("ok") {
            Some(ok) => Ok(string_map(ok)),
            None => Err(s(&record["error"]).to_string()),
        };
        diff.eq(
            || format!("normalize {:?}", record["values"]),
            actual.map_err(|e| e.0),
            expected,
        );
    }
    for record in golden["policies"].as_array().unwrap() {
        let actual = business_visits::normalize_business_visit_policies(
            record["sales"].as_str(),
            record["fee"].as_str(),
        )
        .map(|p| (p.sales_policy, p.fee_collection_policy));
        let expected = match record.get("ok") {
            Some(ok) => Ok((
                s(&ok["sales_policy"]).to_string(),
                s(&ok["fee_collection_policy"]).to_string(),
            )),
            None => Err(s(&record["error"]).to_string()),
        };
        diff.eq(
            || format!("policies {record}"),
            actual.map_err(|e| e.0),
            expected,
        );
    }
    for kind in ["sales", "fee_collection"] {
        diff.eq(
            || format!("decline {kind}"),
            business_visits::business_visit_decline_reply(kind),
            s(&golden["decline"][kind]),
        );
    }
    diff.finish("store_context");
}

#[test]
fn house_rules_match_python() {
    let golden = load("house_rules");
    let mut diff = Diff::default();
    for record in golden["records"].as_array().unwrap() {
        let mode = Mode::parse(s(&record["mode"])).unwrap();
        let house = (!record["house"].is_null()).then(|| HouseSettings {
            away_leave_at_door: record["house"][0].as_bool().unwrap(),
            extra_instructions: s(&record["house"][1]).to_string(),
        });
        let max_chars = record["max_chars"].as_u64().unwrap() as usize;
        diff.eq(
            || format!("build_house_rules {record}"),
            build_house_rules(mode, house.as_ref(), max_chars),
            s(&record["rules"]).to_string(),
        );
    }
    for (max_chars, expected) in golden["capacity"].as_object().unwrap() {
        diff.eq(
            || format!("capacity {max_chars}"),
            extra_instructions_capacity(max_chars.parse().unwrap()),
            expected.as_i64().unwrap(),
        );
    }
    let normal = build_house_rules(Mode::Normal, None, 10_000);
    diff.eq(
        || "door_instructions".into(),
        agent_rules::door_instructions(&normal),
        s(&golden["door_instructions"]).to_string(),
    );
    diff.eq(
        || "asr_prompt".into(),
        agent_rules::ASR_PROMPT,
        s(&golden["asr_prompt"]),
    );
    diff.finish("house_rules");
}

fn flag(state: &Value, name: &str) -> bool {
    state[name].as_bool().unwrap()
}

#[test]
fn tools_match_python() {
    let golden = load("tools");
    let mut diff = Diff::default();
    diff.eq(
        || "TOOLS_V17".into(),
        &*tool_schema_v17::TOOLS_V17,
        &golden["tools_v17"],
    );
    diff.eq(
        || "TOOLS".into(),
        &*tool_schema::TOOLS,
        &golden["tools_v16"],
    );
    for record in golden["available_v17"].as_array().unwrap() {
        let state = &record["state"];
        let message = s(&record["message"]);
        let availability = tool_schema_v17::ToolAvailabilityV17 {
            search_attempted: flag(state, "search_attempted"),
            check_in_attempted: flag(state, "check_in_attempted"),
            notify_staff_attempted: flag(state, "notify_staff_attempted"),
            request_staff_attempted: flag(state, "request_staff_attempted"),
            confirmed_reservation: flag(state, "confirmed_reservation"),
            arrival_recorded: flag(state, "arrival_recorded"),
            arrival_recorded_this_turn: flag(state, "arrival_recorded_this_turn"),
            latest_user_message: message,
            request_staff_available: flag(state, "request_staff_available"),
            business_visit: flag(state, "business_visit"),
        };
        diff.eq(
            || format!("available_tools_v17 {record}"),
            tool_schema_v17::available_tools_v17(&tool_schema_v17::TOOL_NAMES_V17, &availability),
            strings(&record["tools"])
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        );
    }
    let names16 = ["search_reservations", "complete_arrival", "request_staff"];
    for record in golden["available_v16"].as_array().unwrap() {
        let state = &record["state"];
        let availability = tool_schema::ToolAvailability {
            search_attempted: flag(state, "search_attempted"),
            arrival_attempted: flag(state, "arrival_attempted"),
            request_staff_attempted: flag(state, "request_staff_attempted"),
            confirmed_reservation: flag(state, "confirmed_reservation"),
            arrival_recorded: flag(state, "arrival_recorded"),
            latest_user_message: s(&record["message"]),
            request_staff_available: flag(state, "request_staff_available"),
        };
        diff.eq(
            || format!("available_tools {record}"),
            tool_schema::available_tools(&names16, &availability),
            strings(&record["tools"])
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        );
    }
    diff.eq(
        || "model choices".into(),
        reason_codes::MODEL_STAFF_REASON_CHOICES.to_vec(),
        strings(&golden["model_choices"])
            .iter()
            .map(String::as_str)
            .collect(),
    );
    let pairs = |value: &Value| -> Vec<(String, String)> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (s(&p[0]).to_string(), s(&p[1]).to_string()))
            .collect()
    };
    let own = |table: &[(&str, &str)]| -> Vec<(String, String)> {
        table
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    };
    diff.eq(
        || "labels".into(),
        own(&reason_codes::STAFF_REASON_LABELS),
        pairs(&golden["labels"]),
    );
    diff.eq(
        || "text_to_code".into(),
        own(&reason_codes::STAFF_REASON_TEXT_TO_CODE),
        pairs(&golden["text_to_code"]),
    );
    for record in golden["staff_reason_code"].as_array().unwrap() {
        let value = s(&record["value"]);
        let expected = match record.get("ok") {
            Some(ok) => Ok(s(ok).to_string()),
            None => Err(s(&record["error"]).to_string()),
        };
        diff.eq(
            || format!("staff_reason_code {value:?}"),
            reason_codes::staff_reason_code(value)
                .map(str::to_string)
                .map_err(|e| e.0),
            expected,
        );
    }
    diff.finish("tools");
}

#[test]
fn deterministic_tool_replies_match_python() {
    let mut diff = Diff::default();
    for record in load("outcomes").as_array().unwrap() {
        let outcomes: TurnOutcomes = record["outcomes"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.as_object().unwrap().clone()))
            .collect();
        let handoff_ok = record["handoff_ok"].as_bool().unwrap();
        // `_record_failure_handoff`: an existing successful request counts without a new call.
        let mut handoffs = Vec::new();
        let failure = agent_rules::tool_failure_plan(&outcomes).map(|plan| match plan {
            FailurePlan::Reply(reply) => reply.to_string(),
            FailurePlan::Handoff {
                reason,
                requested,
                not_requested,
            } => {
                let existing = outcomes
                    .get("request_staff")
                    .and_then(|p| p.get("status"))
                    .and_then(Value::as_str);
                let ok = if matches!(existing, Some("requested" | "already_requested")) {
                    true
                } else {
                    handoffs.push(reason.to_string());
                    handoff_ok
                };
                (if ok { requested } else { not_requested }).to_string()
            }
        });
        diff.eq(
            || format!("failure {record}"),
            failure,
            opt(&record["failure"]),
        );
        diff.eq(
            || format!("handoffs {record}"),
            handoffs,
            strings(&record["handoffs"]),
        );
        diff.eq(
            || format!("completion {record}"),
            agent_rules::tool_completion_reply(&outcomes).map(str::to_string),
            opt(&record["completion"]),
        );
    }
    diff.finish("outcomes");
}

#[test]
fn reservation_matching_matches_python() {
    let golden = load("matching");
    let reservations: Vec<matching::Reservation> = golden["reservations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| matching::Reservation {
            event_id: s(&row[0]).to_string(),
            start: DateTime::parse_from_rfc3339(s(&row[1])).unwrap(),
            name: s(&row[2]).to_string(),
            kana: s(&row[3]).to_string(),
            staff: String::new(),
            arrived: false,
        })
        .collect();
    let mut diff = Diff::default();
    for query in golden["queries"].as_array().unwrap() {
        let requested = DateTime::parse_from_rfc3339(s(&query["requested"])).unwrap();
        let matched: Vec<String> =
            matching::match_reservations(&reservations, s(&query["name"]), requested)
                .into_iter()
                .map(|item| item.event_id.clone())
                .collect();
        diff.eq(
            || format!("match {query}"),
            matched,
            strings(&query["matched"]),
        );
    }
    diff.finish("matching");
}
