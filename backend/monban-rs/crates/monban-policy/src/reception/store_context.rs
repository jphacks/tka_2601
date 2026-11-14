//! Port of `monban_backend/reception/store_context.py`.

use std::collections::BTreeMap;

use super::business_visits::{
    BUSINESS_VISIT_POLICY_CHOICES, FEE_COLLECTION_POLICY, SALES_POLICY, STAFF_HANDOFF,
};
use crate::py_regex;
use crate::pyre::{char_len, nfkc, py_strip, PyRegex};
use crate::PolicyError;

pub const BUSINESS_VISIT_POLICY_KEYS: [&str; 2] = [SALES_POLICY, FEE_COLLECTION_POLICY];

/// Public store fields, in the order of `_PUBLIC_INFO_PATTERNS`.
pub const PUBLIC_CONTEXT_KEYS: [&str; 7] = [
    "shop_name",
    "opening_time",
    "closing_time",
    "closed_day",
    "payment_methods",
    "address",
    "delivery_location",
];

macro_rules! opening_time_question {
    () => {
        concat!(
            r"(?:何時から.{0,8}(?:営業|開店)|",
            r"(?:営業時間).{0,12}(?:何時から|開店)|",
            r"(?:開店(?:時刻|時間)|営業開始(?:時刻|時間)?).{0,12}(?:何時|いつ|教えて|ですか|でしょうか))"
        )
    };
}

py_regex!(OPENING_TIME_QUESTION, opening_time_question!());
py_regex!(
    CLOSING_TIME_QUESTION,
    r"(?:閉店(?:時刻|時間)?|何時まで(?:営業|開いて|やっています|ですか)|",
    r"何時に閉ま(?:る|ります(?:か)?)?|営業終了(?:時刻|時間)?)"
);
py_regex!(
    SHOP_NAME_Q,
    r"(?:店名|店舗名|お店の名前|何という(?:お?店|店)|なんというお店)"
);
py_regex!(OPENING_TIME_Q, opening_time_question!());
py_regex!(
    CLOSING_TIME_Q,
    r"(?:営業時間|閉店(?:時刻|時間)?|何時まで(?:営業|開いて|やっています|ですか)|",
    r"何時に閉ま(?:る|ります(?:か)?)?)"
);
py_regex!(
    CLOSED_DAY_Q,
    r"(?:定休日|お休みの曜日|お休み(?:は|の日|いつ|ですか)|何曜日(?:が)?休み)"
);
py_regex!(
    PAYMENT_METHODS_Q,
    r"(?:支払(?:い|方法)|決済方法|使える決済|クレジットカード|カード使え|PayPay)"
);
py_regex!(
    ADDRESS_Q,
    r"(?:住所|所在地|アクセス|どこに(?:あります|ある)|場所(?:を|は).{0,8}(?:教|知))"
);
py_regex!(
    DELIVERY_LOCATION_Q,
    r"(?:荷物.{0,8}(?:どこ|置き場所|受取場所|受け渡し場所)|",
    r"(?:宅配|配達).{0,8}(?:受取場所|受け渡し場所|置き場所)|",
    r"受け取り場所|受取場所|受け渡し場所)"
);
py_regex!(
    STAFF_REQUEST,
    r"(?:スタッフ|担当者|店員|従業員).{0,12}(?:確認|聞|呼|伝|問い合わせ|相談)",
    r"|(?:確認|聞|呼|伝|問い合わせ).{0,12}(?:スタッフ|担当者|店員|従業員)"
);
py_regex!(
    OPEN_STATUS_QUESTION,
    r"(?:こちら|この店|お店|店舗|本日|今日)?(?:は|も)?営業して",
    r"(?:いますか|ますか|おりますか|いるんですか|るんですか|ますでしょうか)"
);
py_regex!(
    INDEPENDENT_INTENT,
    r"(?:予約|来店受付|チェックイン|キャンセル|変更|遅刻|遅れ|早く着|早めに来|",
    r"待機場所|待ち場所|施術|指名|予約を取り|予約の確認|受付して)"
);

fn public_info_patterns() -> [(&'static str, &'static PyRegex); 7] {
    [
        ("shop_name", &SHOP_NAME_Q),
        ("opening_time", &OPENING_TIME_Q),
        ("closing_time", &CLOSING_TIME_Q),
        ("closed_day", &CLOSED_DAY_Q),
        ("payment_methods", &PAYMENT_METHODS_Q),
        ("address", &ADDRESS_Q),
        ("delivery_location", &DELIVERY_LOCATION_Q),
    ]
}

/// `normalize_public_context`: reject unknown keys and values over 500 characters, strip
/// values and drop empty ones.
pub fn normalize_public_context(
    values: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, PolicyError> {
    if values
        .keys()
        .any(|key| !PUBLIC_CONTEXT_KEYS.contains(&key.as_str()))
    {
        return Err(PolicyError(
            "public store context contains unsupported fields".into(),
        ));
    }
    let mut normalized = BTreeMap::new();
    for (key, value) in values {
        let value = py_strip(value);
        if char_len(value) > 500 {
            return Err(PolicyError(
                "public setting values must be at most 500 characters".into(),
            ));
        }
        if !value.is_empty() {
            normalized.insert(key.clone(), value.to_string());
        }
    }
    Ok(normalized)
}

fn policy_instruction(value: &str) -> &'static str {
    if value == STAFF_HANDOFF {
        concat!(
            "スタッフへ一度だけ確認依頼する。request_staff(reason「その他スタッフ確認」)を使用し、",
            "予約検索・来店受付・受付一覧への来店記録はしない。依頼が記録された後も担当者の返答済みとは言わない。"
        )
    } else {
        "ツールを呼ばず、短く丁寧にお断りする。"
    }
}

/// `json.dumps(values, ensure_ascii=False, sort_keys=True)` for a string map.
fn python_json_dumps(values: &BTreeMap<&str, &str>) -> String {
    let items: Vec<String> = values
        .iter()
        .map(|(key, value)| {
            format!(
                "{}: {}",
                serde_json::to_string(key).expect("json key"),
                serde_json::to_string(value).expect("json value")
            )
        })
        .collect();
    format!("{{{}}}", items.join(", "))
}

/// `compose_system_prompt`. `store_context` holds public fields and/or business-visit
/// policies; `None` returns the policy unchanged.
pub fn compose_system_prompt(
    policy: &str,
    store_context: Option<&BTreeMap<String, String>>,
) -> Result<String, PolicyError> {
    let Some(store_context) = store_context else {
        return Ok(policy.to_string());
    };
    if store_context.keys().any(|key| {
        !PUBLIC_CONTEXT_KEYS.contains(&key.as_str())
            && !BUSINESS_VISIT_POLICY_KEYS.contains(&key.as_str())
    }) {
        return Err(PolicyError(
            "store_context must contain only supported public settings and business-visit policies"
                .into(),
        ));
    }
    let public_context: BTreeMap<&str, &str> = store_context
        .iter()
        .filter(|(key, _)| PUBLIC_CONTEXT_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    for value in public_context.values() {
        if py_strip(value).is_empty() || char_len(value) > 500 {
            return Err(PolicyError(
                "public setting values must be nonempty bounded strings".into(),
            ));
        }
    }
    let policy_of = |key: &str| store_context.get(key).map_or(STAFF_HANDOFF, String::as_str);
    let sales = policy_of(SALES_POLICY);
    let collection = policy_of(FEE_COLLECTION_POLICY);
    for value in [sales, collection] {
        if !BUSINESS_VISIT_POLICY_CHOICES.contains(&value) {
            return Err(PolicyError(
                "business-visit policies must be staff_handoff or polite_decline".into(),
            ));
        }
    }

    let mut parts = vec![policy.to_string()];
    if !public_context.is_empty() || store_context.is_empty() {
        parts.push(format!(
            "店舗の公開設定（未設定の項目は不明）:\n{}",
            python_json_dumps(&public_context)
        ));
    }
    if !public_context.is_empty() {
        parts.push(
            concat!(
                "設定された公開情報に質問の答えがある場合、予約照合やスタッフ確認の流れよりも、その公開情報への回答を優先します。",
                "予約確認の途中でも来訪者が別の質問をしたら、その質問に設定値で直接答えてから元の用件へ戻ります。",
                "設定値で回答できる質問にはrequest_staffなどのツールを使いません。",
                "質問と設定項目の対応は、shop_nameは店舗名、opening_timeは開店時刻・何時から営業するか、",
                "closing_timeは閉店時刻、closed_dayは定休日、",
                "payment_methodsは支払方法、addressは住所、delivery_locationは荷物の受渡し場所や置き場所です。",
                "この対応に一致した設定値をそのまま回答し、予約者名や予約時刻を催促しません。",
                "delivery_locationが設定されている場合、荷物の受渡し場所や置き場所はその値を案内し、荷物置き場の確認依頼を出しません。"
            )
            .to_string(),
        );
    }
    if BUSINESS_VISIT_POLICY_KEYS
        .iter()
        .any(|key| store_context.contains_key(*key))
    {
        parts.push(format!(
            concat!(
                "店舗別の営業・集金訪問設定（必ず従う）:\n",
                "営業訪問: {}\n",
                "NHK・受信料などの集金訪問: {}支払いの要否や契約状態を推測しない。\n",
                "どちらも予約客として扱わず、予約者名や予約時刻を尋ねない。",
                "会話中に氏名だけが伝えられても訪問目的を保持する。",
                "明確な目的訂正があった場合は、訂正後の用件に従う。"
            ),
            policy_instruction(sales),
            policy_instruction(collection),
        ));
    }
    Ok(parts.join("\n\n"))
}

const NOT_CONFIGURED: &str = "その情報はこの店舗に設定されていないため、こちらでは確認できません。";

/// `public_info_reply`: answer a single, explicit public-info question from store data.
pub fn public_info_reply(text: &str, public_context: &BTreeMap<String, String>) -> Option<String> {
    let normalized = nfkc(text);
    if normalized.is_empty()
        || STAFF_REQUEST.is_match(&normalized)
        || INDEPENDENT_INTENT.is_match(&normalized)
    {
        return None;
    }
    let get = |key: &str| public_context.get(key).map_or("", String::as_str);
    let opening_question = OPENING_TIME_QUESTION.is_match(&normalized);
    let closing_question = CLOSING_TIME_QUESTION.is_match(&normalized);
    if opening_question && closing_question {
        return None;
    }
    let explicit_time_question = if opening_question {
        Some("opening_time")
    } else if closing_question {
        Some("closing_time")
    } else {
        None
    };
    if let Some(key) = explicit_time_question {
        let other_matches = public_info_patterns().iter().any(|(name, pattern)| {
            !matches!(*name, "opening_time" | "closing_time") && pattern.is_match(&normalized)
        });
        if other_matches {
            return None;
        }
        let value = get(key);
        if value.is_empty() {
            return Some(NOT_CONFIGURED.to_string());
        }
        let label = if key == "opening_time" {
            "開店時刻"
        } else {
            "閉店時刻"
        };
        return Some(format!("{label}は{value}です。"));
    }
    if OPEN_STATUS_QUESTION.is_match(&normalized) {
        return Some("現在営業中かどうかは、こちらでは確認できません。".to_string());
    }
    let matches: Vec<&str> = public_info_patterns()
        .iter()
        .filter(|(_, pattern)| pattern.is_match(&normalized))
        .map(|(name, _)| *name)
        .collect();
    let [key] = matches.as_slice() else {
        return None;
    };
    let value = get(key);
    if value.is_empty() {
        return Some(NOT_CONFIGURED.to_string());
    }
    Some(match *key {
        "shop_name" => format!("こちらは{value}です。"),
        "opening_time" => format!("開店時刻は{value}です。"),
        "closing_time" => format!("閉店時刻は{value}です。"),
        "closed_day" => format!("定休日は{value}です。"),
        "payment_methods" => format!("お支払い方法は{value}です。"),
        "address" => format!("住所は{value}です。"),
        _ => format!("お荷物の受け渡し場所は{value}です。"),
    })
}
