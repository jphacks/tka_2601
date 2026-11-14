//! Port of `monban_backend/reception/matching.py`.

use chrono::{DateTime, FixedOffset, TimeDelta};

use crate::py_regex;
use crate::pyre::{nfkc, py_strip};

py_regex!(HONORIFIC_SUFFIX, r"(?:様|さん)$");
py_regex!(SPACES, r"\s+");

/// `normalize_name`: NFKC, no honorific or spaces, hiragana folded to katakana.
pub fn normalize_name(value: &str) -> String {
    let value = nfkc(value);
    let value = HONORIFIC_SUFFIX.sub("", py_strip(&value));
    let value = SPACES.sub("", &value);
    value
        .chars()
        .map(|c| {
            if ('ぁ'..='ゖ').contains(&c) {
                char::from_u32(c as u32 + 0x60).expect("katakana")
            } else {
                c
            }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reservation {
    pub event_id: String,
    pub start: DateTime<FixedOffset>,
    pub name: String,
    pub kana: String,
    pub staff: String,
    pub arrived: bool,
}

/// Reservations whose name or kana equals `name` and that start within 15 minutes of
/// `requested`.
pub fn match_reservations<'a>(
    reservations: &'a [Reservation],
    name: &str,
    requested: DateTime<FixedOffset>,
) -> Vec<&'a Reservation> {
    let normalized = normalize_name(name);
    if normalized.is_empty() {
        return Vec::new();
    }
    reservations
        .iter()
        .filter(|item| {
            (normalize_name(&item.name) == normalized || normalize_name(&item.kana) == normalized)
                && (item.start - requested).abs() <= TimeDelta::minutes(15)
        })
        .collect()
}
