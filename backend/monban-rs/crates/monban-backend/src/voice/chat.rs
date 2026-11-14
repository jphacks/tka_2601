//! Conversation history and its Chat Completions form (livekit-agents `ChatContext` and
//! `_provider_format/openai.py`, limited to what the Monban agents use).

use serde_json::{json, Value};

/// livekit's `DYNAMIC_INSTRUCTIONS_MESSAGE_ID`.
pub const DYNAMIC_INSTRUCTIONS_ID: &str = "lk.dynamic_instructions";
/// The id `update_instructions` gives the agent's system prompt.
pub const INSTRUCTIONS_ID: &str = "lk.agent_task.instructions";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChatItem {
    Message { id: String, role: Role, text: String },
    /// `group` ties calls (and the assistant text) of one generation step together.
    FunctionCall { group: String, call_id: String, name: String, arguments: String },
    FunctionCallOutput { call_id: String, name: String, output: String, is_error: bool },
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatContext {
    pub items: Vec<ChatItem>,
}

impl ChatContext {
    pub fn push_message(&mut self, id: impl Into<String>, role: Role, text: impl Into<String>) {
        self.items.push(ChatItem::Message { id: id.into(), role, text: text.into() });
    }

    /// `(role, text)` of every message, as the agents read the conversation.
    pub fn messages(&self) -> Vec<(&'static str, String)> {
        self.items
            .iter()
            .filter_map(|item| match item {
                ChatItem::Message { role, text, .. } => Some((role.as_str(), text.clone())),
                _ => None,
            })
            .collect()
    }

    /// The most recent assistant message text, or "".
    pub fn last_assistant_text(&self) -> String {
        self.items
            .iter()
            .rev()
            .find_map(|item| match item {
                ChatItem::Message { role: Role::Assistant, text, .. } => Some(text.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }

    /// `update_instructions(..., add_if_missing=True)`: the system prompt is the first item.
    pub fn set_instructions(&mut self, instructions: &str) {
        let existing = self.items.iter().position(
            |item| matches!(item, ChatItem::Message { id, .. } if id == INSTRUCTIONS_ID),
        );
        match existing {
            Some(index) => {
                if let ChatItem::Message { text, .. } = &mut self.items[index] {
                    *text = instructions.to_string();
                }
            }
            None => self.items.insert(
                0,
                ChatItem::Message {
                    id: INSTRUCTIONS_ID.into(),
                    role: Role::System,
                    text: instructions.into(),
                },
            ),
        }
    }

    /// `_context_with_state_instructions`: per-turn guidance right after the system prompt.
    pub fn with_state_instructions(&self, instructions: &str) -> ChatContext {
        let mut context = self.clone();
        context.items.retain(
            |item| !matches!(item, ChatItem::Message { id, .. } if id == DYNAMIC_INSTRUCTIONS_ID),
        );
        let index = context
            .items
            .iter()
            .position(|item| matches!(item, ChatItem::Message { role: Role::System, .. }))
            .map_or(0, |index| index + 1);
        context.items.insert(
            index,
            ChatItem::Message {
                id: DYNAMIC_INSTRUCTIONS_ID.into(),
                role: Role::System,
                text: instructions.into(),
            },
        );
        context
    }

    /// Chat Completions `messages` for this context.
    pub fn to_openai(&self) -> Vec<Value> {
        let items = merge_dynamic_instructions(&self.items);
        let mut groups: Vec<Group> = Vec::new();
        let mut outputs: Vec<&ChatItem> = Vec::new();
        for item in &items {
            match item {
                ChatItem::Message { id, role: Role::Assistant, .. } => {
                    let key = id.split('/').next().unwrap_or(id).to_string();
                    group_for(&mut groups, &key).message = Some(item.clone());
                }
                ChatItem::FunctionCall { group, .. } => {
                    group_for(&mut groups, group).calls.push(item.clone());
                }
                ChatItem::FunctionCallOutput { .. } => outputs.push(item),
                ChatItem::Message { id, .. } => {
                    groups.push(Group { key: format!("message:{id}:{}", groups.len()), ..Default::default() });
                    groups.last_mut().expect("pushed").message = Some(item.clone());
                }
            }
        }
        for output in outputs {
            let ChatItem::FunctionCallOutput { call_id, .. } = output else { continue };
            let target = groups.iter_mut().find(|group| {
                group.calls.iter().any(|call| matches!(call, ChatItem::FunctionCall { call_id: c, .. } if c == call_id))
            });
            match target {
                Some(group) => group.outputs.push(output.clone()),
                None => tracing::warn!("function output missing the corresponding function call, ignoring"),
            }
        }

        let mut messages = Vec::new();
        for mut group in groups {
            group.remove_invalid_tool_calls();
            if group.message.is_none() && group.calls.is_empty() && group.outputs.is_empty() {
                continue;
            }
            let mut message = match &group.message {
                Some(ChatItem::Message { role, text, .. }) => json!({"role": role.as_str(), "content": text}),
                _ => json!({"role": "assistant"}),
            };
            let calls: Vec<Value> = group
                .calls
                .iter()
                .filter_map(|call| match call {
                    ChatItem::FunctionCall { call_id, name, arguments, .. } => Some(json!({
                        "id": call_id,
                        "type": "function",
                        "function": {"name": name, "arguments": arguments},
                    })),
                    _ => None,
                })
                .collect();
            if !calls.is_empty() {
                message["tool_calls"] = Value::Array(calls);
            }
            messages.push(message);
            for output in &group.outputs {
                if let ChatItem::FunctionCallOutput { call_id, output, .. } = output {
                    messages.push(json!({"role": "tool", "tool_call_id": call_id, "content": output}));
                }
            }
        }
        messages
    }
}

#[derive(Default)]
struct Group {
    key: String,
    message: Option<ChatItem>,
    calls: Vec<ChatItem>,
    outputs: Vec<ChatItem>,
}

impl Group {
    /// Keep only calls that have an output and outputs that have a call.
    fn remove_invalid_tool_calls(&mut self) {
        let call_ids: Vec<String> = self
            .calls
            .iter()
            .filter_map(|c| match c {
                ChatItem::FunctionCall { call_id, .. } => Some(call_id.clone()),
                _ => None,
            })
            .collect();
        let output_ids: Vec<String> = self
            .outputs
            .iter()
            .filter_map(|o| match o {
                ChatItem::FunctionCallOutput { call_id, .. } => Some(call_id.clone()),
                _ => None,
            })
            .collect();
        self.calls.retain(|c| matches!(c, ChatItem::FunctionCall { call_id, .. } if output_ids.contains(call_id)));
        self.outputs
            .retain(|o| matches!(o, ChatItem::FunctionCallOutput { call_id, .. } if call_ids.contains(call_id)));
    }
}

fn group_for<'a>(groups: &'a mut Vec<Group>, key: &str) -> &'a mut Group {
    if let Some(index) = groups.iter().position(|group| group.key == key) {
        return &mut groups[index];
    }
    groups.push(Group { key: key.to_string(), ..Default::default() });
    groups.last_mut().expect("pushed")
}

/// Merge the dynamic-instructions message into the system prompt right before it, joining
/// the two texts with a newline (`merge_dynamic_instructions` + `_ordered_parts`).
fn merge_dynamic_instructions(items: &[ChatItem]) -> Vec<ChatItem> {
    // Only a system prompt that is the first item can take the dynamic instructions.
    let (Some(ChatItem::Message { role: Role::System, text, id }), Some(next)) = (items.first(), items.get(1)) else {
        return items.to_vec();
    };
    let ChatItem::Message { id: next_id, text: next_text, .. } = next else {
        return items.to_vec();
    };
    if next_id != DYNAMIC_INSTRUCTIONS_ID {
        return items.to_vec();
    }
    let joined = match (text.is_empty(), next_text.is_empty()) {
        (true, _) => next_text.clone(),
        (_, true) => text.clone(),
        _ => format!("{text}\n{next_text}"),
    };
    let mut merged = vec![ChatItem::Message { id: id.clone(), role: Role::System, text: joined }];
    merged.extend_from_slice(&items[2..]);
    merged
}

/// `json.dumps(value)` with Python's defaults (`ensure_ascii=True`, `", "` and `": "`).
/// livekit writes model tool-call arguments back in this canonical form.
pub fn py_json_dumps_ascii(value: &Value) -> String {
    let mut out = String::new();
    write_ascii(value, &mut out);
    out
}

fn write_ascii(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                write_ascii_string(key, out);
                out.push_str(": ");
                write_ascii(item, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                write_ascii(item, out);
            }
            out.push(']');
        }
        Value::String(text) => write_ascii_string(text, out),
        other => out.push_str(&other.to_string()),
    }
}

fn write_ascii_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7f => {
                let mut buffer = [0u16; 2];
                for unit in c.encode_utf16(&mut buffer) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_instructions_merge_into_the_system_prompt() {
        let mut ctx = ChatContext::default();
        ctx.set_instructions("BASE");
        ctx.push_message("a1", Role::Assistant, "はい、どちら様でしょうか。");
        ctx.push_message("u1", Role::User, "ガスの点検です。");
        let messages = ctx.with_state_instructions("STATE").to_openai();
        assert_eq!(
            messages,
            vec![
                json!({"role": "system", "content": "BASE\nSTATE"}),
                json!({"role": "assistant", "content": "はい、どちら様でしょうか。"}),
                json!({"role": "user", "content": "ガスの点検です。"}),
            ]
        );
    }

    #[test]
    fn tool_calls_group_with_their_outputs() {
        let mut ctx = ChatContext::default();
        ctx.set_instructions("BASE");
        ctx.push_message("u1", Role::User, "予約しています。");
        ctx.items.push(ChatItem::FunctionCall {
            group: "step-1".into(),
            call_id: "call_1".into(),
            name: "search_reservations".into(),
            arguments: "{}".into(),
        });
        ctx.items.push(ChatItem::FunctionCallOutput {
            call_id: "call_1".into(),
            name: "search_reservations".into(),
            output: "{\"status\": \"matched\"}".into(),
            is_error: false,
        });
        // A call without an output is dropped from the request.
        ctx.items.push(ChatItem::FunctionCall {
            group: "step-2".into(),
            call_id: "call_2".into(),
            name: "check_in".into(),
            arguments: "{}".into(),
        });
        let messages = ctx.to_openai();
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[2]["tool_calls"][0]["id"], "call_1");
        assert!(messages[2].get("content").is_none());
        assert_eq!(messages[3], json!({"role": "tool", "tool_call_id": "call_1", "content": "{\"status\": \"matched\"}"}));
    }

    #[test]
    fn python_ascii_json() {
        // Built from code points so no escape sequence appears in this source file.
        let escaped = |units: &[&str]| units.iter().map(|unit| format!("\\u{unit}")).collect::<String>();
        let value = json!({"customer_name": "山田太郎", "time": "15:00", "n": null});
        assert_eq!(
            py_json_dumps_ascii(&value),
            format!(
                "{{\"customer_name\": \"{}\", \"time\": \"15:00\", \"n\": null}}",
                escaped(&["5c71", "7530", "592a", "90ce"])
            )
        );
        assert_eq!(py_json_dumps_ascii(&json!("😀")), format!("\"{}\"", escaped(&["d83d", "de00"])));
        assert_eq!(py_json_dumps_ascii(&json!("a\u{7f}")), "\"a\u{7f}\"");
    }
}
