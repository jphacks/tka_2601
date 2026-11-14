//! Port of `monban_backend/reception/prefetch.py` (name and appointment-time extraction).

use std::sync::LazyLock;

use super::tool_schema::customer_name_is_self_identified;
use crate::py_regex;
use crate::pyre::{
    find_from, from, nfkc, prefix, py_int, rfind_before, slice, suffix, PyMatch, PyRegex,
};

macro_rules! name_token {
    () => {
        r"(?P<name>[㐀-䶿一-鿿々ぁ-んァ-ヶー]{1,8})"
    };
}
macro_rules! name_ending {
    () => {
        r"(?:さん|様)?(?:でございます|と申します|といいます|本人です|です|でした|でお願いします|ですが)"
    };
}

static NAME_PATTERNS: LazyLock<[PyRegex; 5]> = LazyLock::new(|| {
    [
        PyRegex::new(concat!(
            r"(?:予約者名|予約名|予約者|お名前|名前|氏名|名義)(?:は|が|:|：)?",
            name_token!(),
            name_ending!()
        )),
        PyRegex::new(concat!(
            r"(?:正しくは|正しく言うと|本当は|実際は)",
            name_token!(),
            name_ending!()
        )),
        PyRegex::new(concat!(
            r"(?:予約(?:を)?(?:お願いし(?:た|て)|取(?:った|りました)|入れ(?:た|ました)|",
            r"して(?:いた|いる|います|いました|ます)|した|をした)|来店した)(?:のは|者は)?",
            name_token!(),
            name_ending!()
        )),
        PyRegex::new(concat!(
            r"(?:私|わたし|僕|ぼく|本人)(?:は|が)",
            name_token!(),
            name_ending!()
        )),
        PyRegex::new(concat!(
            r"(?:^|[。．、,，\s])",
            name_token!(),
            name_ending!()
        )),
    ]
});

py_regex!(
    APPOINTMENT_TIME,
    r"(?<!\d)(?:[01]?\d|2[0-3])(?::[0-5]\d|時(?:半|[0-5]?\d分?)?)(?!\d)"
);
py_regex!(APPROXIMATE, r"(頃|ころ|くらい|ぐらい|前後)");
py_regex!(
    THIRD_PARTY_APPOINTMENT,
    r"(?:娘|息子|子ども|子供|母|父|妻|夫|姉|兄|妹|弟|友人|友達|同伴者|家族|お母さん|お父さん|お連れ様).{0,12}予約"
);
py_regex!(APPOINTMENT_TIME_RIGHT, r"^(?:に|の)?予約");
py_regex!(
    IMMEDIATE_ARRIVAL,
    r"^\s*(?:に)?(?:到着|着いた|来店|着きました|来ました)"
);
py_regex!(RESERVATION_WORD, "予約");
py_regex!(
    EXPLICIT_CHANGE,
    r"(?:訂正|修正|正しくは|ではなく|間違|変更|実際は|最終的には)"
);
py_regex!(
    CLOCK_FRAGMENT,
    r"(?<!\d)(?:[01]?\d|2[0-3])(?:で|手)\s*[0-9一二三四五六七八九十]+"
);

const SENTENCE_MARKS: [char; 7] = ['。', '．', '！', '？', '!', '?', '\n'];
const ARRIVAL_CUES: [&str; 7] = [
    "到着",
    "着いた",
    "着きました",
    "来店",
    "来た",
    "早く来",
    "早めに来",
];

/// `extract_self_identified_name`: the latest name the visitor gave as their own.
pub fn extract_self_identified_name(user_history: &str) -> Option<String> {
    let text = nfkc(user_history);
    let mut matches: Vec<(usize, String)> = Vec::new();
    for pattern in NAME_PATTERNS.iter() {
        for (start, caps) in pattern.captures_iter(&text) {
            let name = caps.name("name").expect("name group").as_str().to_string();
            matches.push((start, name));
        }
    }
    // Stable sort by start, latest first; equal starts keep pattern order (Python's
    // `sorted(..., reverse=True)` is stable as well).
    matches.sort_by(|a, b| b.0.cmp(&a.0));
    matches
        .into_iter()
        .map(|(_, name)| name)
        .find(|candidate| customer_name_is_self_identified(&text, candidate))
}

fn parse_clock(raw: &str) -> (u32, u32) {
    if let Some((hour, minute)) = raw.split_once(':') {
        return (py_int(hour), py_int(minute));
    }
    let (hour, rest) = raw.split_once('時').expect("clock has 時");
    let minute = if rest.starts_with('半') {
        30
    } else {
        let digits = rest.strip_suffix('分').unwrap_or(rest);
        if digits.is_empty() {
            0
        } else {
            py_int(digits)
        }
    };
    (py_int(hour), minute)
}

fn apply_meridiem(hour: u32, prefix_text: &str) -> u32 {
    if prefix_text.contains("午後") {
        if hour == 0 || hour == 12 {
            12
        } else {
            hour + 12
        }
    } else if prefix_text.contains("午前") && hour == 12 {
        0
    } else {
        hour
    }
}

fn format_clock(hour: u32, minute: u32) -> String {
    format!("{hour:02}:{minute:02}")
}

/// `extract_exact_appointment_time`: the last exact clock time as `HH:MM`.
pub fn extract_exact_appointment_time(user_history: &str) -> Option<String> {
    let text = nfkc(user_history);
    let matches = APPOINTMENT_TIME.find_iter(&text);
    let found = matches.last()?;
    let nearby = slice(&text, found.start.saturating_sub(4), found.start)
        + &slice(&text, found.end, found.end + 4);
    if APPROXIMATE.is_match(&nearby) {
        return None;
    }
    let (hour, minute) = parse_clock(&found.text);
    let hour = apply_meridiem(
        hour,
        &slice(&text, found.start.saturating_sub(5), found.start),
    );
    Some(format_clock(hour, minute))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimeKind {
    Arrival,
    Other,
    ThirdParty,
    Appointment,
}

fn rfind_str(haystack: &str, needle: &str) -> Option<usize> {
    let hay: Vec<char> = haystack.chars().collect();
    let needle: Vec<char> = needle.chars().collect();
    rfind_before(&hay, &needle, hay.len())
}

/// `extract_explicit_appointment_time`: a time explicitly tied to the visitor's own
/// reservation, if unambiguous.
pub fn extract_explicit_appointment_time(user_history: &str) -> Option<String> {
    let text = nfkc(user_history);
    let chars: Vec<char> = text.chars().collect();
    let matches: Vec<PyMatch> = APPOINTMENT_TIME.find_iter(&text);
    let mut candidates: Vec<(usize, String)> = Vec::new();
    let mut classified: Vec<Option<TimeKind>> = vec![None; matches.len()];
    for (index, found) in matches.iter().enumerate() {
        let sentence_start = SENTENCE_MARKS
            .iter()
            .map(|mark| rfind_before(&chars, &[*mark], found.start).map_or(-1, |p| p as i64))
            .max()
            .unwrap_or(-1)
            + 1;
        let sentence_start = sentence_start as usize;
        let sentence_end = SENTENCE_MARKS
            .iter()
            .filter_map(|mark| find_from(&chars, &[*mark], found.end))
            .min()
            .unwrap_or(chars.len());
        let sentence = slice(&text, sentence_start, sentence_end);
        let before = slice(&text, sentence_start, found.start);
        let after = slice(&text, found.end, sentence_end);
        let left_reservation = rfind_str(&before, "予約").map_or(-1, |p| p as i64);
        let left_arrival = ARRIVAL_CUES
            .iter()
            .map(|cue| rfind_str(&before, cue).map_or(-1, |p| p as i64))
            .max()
            .unwrap_or(-1);
        let immediate_arrival = IMMEDIATE_ARRIVAL.is_prefix_match(&after);
        let right_reservation = APPOINTMENT_TIME_RIGHT.is_match(&prefix(&after, 14));
        if immediate_arrival || left_arrival > left_reservation {
            classified[index] = Some(TimeKind::Arrival);
            continue;
        }
        if left_reservation < 0 && !right_reservation {
            classified[index] = Some(if left_arrival >= 0 {
                TimeKind::Arrival
            } else {
                TimeKind::Other
            });
            continue;
        }

        let match_start_in_sentence = (found.start - sentence_start) as i64;
        let reservation_positions: Vec<i64> = RESERVATION_WORD
            .find_iter(&sentence)
            .into_iter()
            .map(|m| m.start as i64)
            .filter(|position| (position - match_start_in_sentence).abs() <= 20)
            .collect();
        let reservation_subject = if reservation_positions.is_empty() {
            suffix(&before, 16) + "予約"
        } else {
            // `min` keeps the first of equally close positions.
            let mut best = reservation_positions[0];
            for &position in &reservation_positions[1..] {
                if (position - match_start_in_sentence).abs()
                    < (best - match_start_in_sentence).abs()
                {
                    best = position;
                }
            }
            let best = best as usize;
            slice(&sentence, best.saturating_sub(16), best) + "予約"
        };
        if THIRD_PARTY_APPOINTMENT.is_match(&reservation_subject) {
            classified[index] = Some(TimeKind::ThirdParty);
            continue;
        }

        let (hour, minute) = parse_clock(&found.text);
        let prefix_start = sentence_start.max(found.start.saturating_sub(5));
        let hour = apply_meridiem(hour, &slice(&text, prefix_start, found.start));
        candidates.push((index, format_clock(hour, minute)));
        classified[index] = Some(TimeKind::Appointment);
    }

    let (last_index, value) = candidates.last()?.clone();
    if classified[last_index + 1..].contains(&Some(TimeKind::Other)) {
        return None;
    }
    if candidates.len() > 1 {
        let (previous_index, previous_value) = &candidates[candidates.len() - 2];
        let previous_end = matches[*previous_index].end;
        let window = slice(&text, previous_end, matches[last_index].end + 16);
        let changed_explicitly = EXPLICIT_CHANGE.is_match(&window);
        if *previous_value != value && !changed_explicitly {
            return None;
        }
    }
    Some(value)
}

/// `has_unresolved_clock_fragment`: an ASR fragment such as "2で30" without a later
/// explicit correction.
pub fn has_unresolved_clock_fragment(user_message: &str) -> bool {
    let text = nfkc(user_message);
    let fragments = CLOCK_FRAGMENT.find_iter(&text);
    let Some(last) = fragments.last() else {
        return false;
    };
    extract_exact_appointment_time(&from(&text, last.end)).is_none()
}
