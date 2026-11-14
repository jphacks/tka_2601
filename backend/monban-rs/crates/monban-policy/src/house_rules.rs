//! Port of `monban_backend/core/house_rules.py`.

use crate::pyre::{char_len, prefix, py_strip};

/// The resident's operating mode sent in the relay start message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Mode {
    #[default]
    Normal,
    Omakase,
    Away,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "normal" => Some(Self::Normal),
            "omakase" => Some(Self::Omakase),
            "away" => Some(Self::Away),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Omakase => "omakase",
            Self::Away => "away",
        }
    }
}

pub const RULES_HEAD: &str =
    "あなたは住宅のインターホンで来客に応答する受付係です。次を必ず守ってください。";
pub const RULE_PRIVACY: &str = concat!(
    "1. 住人の名前、在宅か不在か、帰宅時間、家族構成を言わない。「留守」「誰もいない」と言わない。",
    "名前を聞かれても肯定も否定もしない。"
);
pub const DELIVERY_HOME: &str = concat!(
    "2. 宅配なら「玄関の前に置いていただけますか」と頼む。",
    "クール便、代引き、着払い、サインが必要などで置けないと言われたら、不在票を入れるよう頼む。"
);
pub const DELIVERY_AWAY: &str = "2. 宅配なら、ただいま玄関に出られないため不在票を入れるよう頼む。";
pub const DELIVERY_AWAY_LEAVE_AT_DOOR: &str = concat!(
    "2. 宅配なら、ただいま玄関に出られないため、置き配の指定があればその場所に置き、",
    "なければ不在票を入れるよう願う。",
    "クール便、代引き、着払い、サインが必要などで置けないと言われたら、不在票を入れるよう願う。"
);
pub const RULES_TAIL: [&str; 6] = [
    "3. 営業や勧誘は丁寧に断り、資料があればポストに入れるよう頼む。",
    "4. 点検や工事を名乗る人には、その場で日時を約束せず、改めて連絡するよう頼む。",
    "5. 鍵やドアを開ける、玄関に出る、といった約束をしない。",
    "6. 警察や消防、火事など緊急の用件なら「ただいま家の者に連絡します」と伝える。",
    "7. 1回の返答は2文以内とし、ゆっくり丁寧な敬語で話す。",
    "8. 用件が済んだら、最後に必ず「失礼いたします」と言う。",
];
pub const EXTRA_HEAD: &str = "住人からの追加の指示（1〜8 とぶつかるときは 1〜8 を守る）:";

/// Resident settings read from Supabase once per conversation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HouseSettings {
    pub away_leave_at_door: bool,
    pub extra_instructions: String,
}

pub fn base_rules(mode: Mode, away_leave_at_door: bool) -> String {
    let delivery = if mode == Mode::Away {
        if away_leave_at_door {
            DELIVERY_AWAY_LEAVE_AT_DOOR
        } else {
            DELIVERY_AWAY
        }
    } else {
        DELIVERY_HOME
    };
    let mut parts = vec![RULES_HEAD, RULE_PRIVACY, delivery];
    parts.extend(RULES_TAIL);
    parts.join("\n")
}

/// Compose the spec 5.6 rules for the mode and append the resident's extra instructions.
///
/// `max_chars` counts code points, as Python's `len(str)` does.
pub fn build_house_rules(mode: Mode, house: Option<&HouseSettings>, max_chars: usize) -> String {
    let default = HouseSettings::default();
    let house = house.unwrap_or(&default);
    let rules = base_rules(mode, house.away_leave_at_door);
    let extra = py_strip(&house.extra_instructions);
    if extra.is_empty() {
        return rules;
    }
    let head = format!("{rules}\n{EXTRA_HEAD}\n");
    let room = max_chars as i64 - char_len(&head) as i64;
    if room <= 0 {
        return rules;
    }
    head + &prefix(extra, room as usize)
}

/// Characters left for extra instructions in the longest mode (may be negative).
pub fn extra_instructions_capacity(max_chars: usize) -> i64 {
    let longest = [
        base_rules(Mode::Normal, false),
        base_rules(Mode::Away, true),
        base_rules(Mode::Away, false),
    ]
    .iter()
    .map(|rules| char_len(rules))
    .max()
    .unwrap_or(0);
    max_chars as i64 - longest as i64 - char_len(EXTRA_HEAD) as i64 - 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn away_mode_uses_the_leave_at_door_permission() {
        assert!(base_rules(Mode::Away, true).contains("置き配の指定があれば"));
        assert!(!base_rules(Mode::Normal, true).contains("置き配の指定があれば"));
    }

    #[test]
    fn extra_instructions_are_cut_to_the_limit() {
        let house = HouseSettings {
            away_leave_at_door: false,
            extra_instructions: "  犬がいます。".repeat(100),
        };
        let rules = build_house_rules(Mode::Normal, Some(&house), 800);
        assert_eq!(char_len(&rules), 800);
        assert!(rules.contains(EXTRA_HEAD));
        assert_eq!(
            build_house_rules(Mode::Normal, Some(&house), 10),
            base_rules(Mode::Normal, false)
        );
    }
}
