//! Port of `monban_backend/reception/business_visits.py`.

use crate::py_regex;
use crate::pyre::{casefold, from, nfkc};
use crate::PolicyError;

pub const STAFF_HANDOFF: &str = "staff_handoff";
pub const POLITE_DECLINE: &str = "polite_decline";
pub const BUSINESS_VISIT_POLICY_CHOICES: [&str; 2] = [STAFF_HANDOFF, POLITE_DECLINE];
pub const SALES_POLICY: &str = "sales_policy";
pub const FEE_COLLECTION_POLICY: &str = "fee_collection_policy";

/// Business-visit kinds returned by [`classify_business_visit`].
pub const SALES: &str = "sales";
pub const FEE_COLLECTION: &str = "fee_collection";

/// `BUSINESS_VISIT_REASON_CODES[kind]`.
pub fn business_visit_reason_code(kind: &str) -> Option<&'static str> {
    match kind {
        SALES => Some("営業訪問"),
        FEE_COLLECTION => Some("集金訪問"),
        _ => None,
    }
}

py_regex!(
    PURPOSE_CORRECTION,
    r"(?:ではなくて|ではなく|じゃなくて|じゃなく|ではありません|じゃありません|ではない(?:です)?)"
);
py_regex!(
    FEE_COLLECTION_RE,
    r"(?:nhk|日本放送協会).{0,16}(?:受信料|集金|契約|訪問|伺|来|参|案内|担当|者)",
    r"|(?:受信料|集金|料金徴収|受信契約).{0,16}(?:伺|訪問|来|参|案内|確認|です)"
);
py_regex!(
    HOURS_QUESTION,
    r"(?:営業時間|営業日|営業中|営業状況|営業状態|何時まで営業|何時から営業|",
    r"(?:こちら|お店|店舗|本日|今日)?営業して(?:いますか|ますか|る|おりますか))"
);
py_regex!(
    CLEAR_SALES,
    r"(?:勧誘|セールス|訪問販売|営業マン|新サービス|営業のご案内|",
    r"営業に(?:伺|参)|営業で(?:伺|参)|営業を行なっているもの|営業を行っているもの|",
    r"営業(?:です|で伺|に伺|に参|で参))"
);
py_regex!(
    SALES_CONTEXT,
    r"(?:この辺り|こちらに|サロンに|訪問|ご案内|提案|来ました|参りました)"
);

/// Per-store handling of sales and fee-collection visits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusinessVisitPolicies {
    pub sales_policy: String,
    pub fee_collection_policy: String,
}

impl Default for BusinessVisitPolicies {
    fn default() -> Self {
        Self {
            sales_policy: STAFF_HANDOFF.to_string(),
            fee_collection_policy: STAFF_HANDOFF.to_string(),
        }
    }
}

impl BusinessVisitPolicies {
    /// The policy that applies to a business-visit kind (`fee_collection` or anything else).
    pub fn for_kind(&self, kind: &str) -> &str {
        if kind == FEE_COLLECTION {
            &self.fee_collection_policy
        } else {
            &self.sales_policy
        }
    }
}

/// `normalize_business_visit_policies`: empty or missing values use the default.
pub fn normalize_business_visit_policies(
    sales_policy: Option<&str>,
    fee_collection_policy: Option<&str>,
) -> Result<BusinessVisitPolicies, PolicyError> {
    let pick = |value: Option<&str>| match value {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => STAFF_HANDOFF.to_string(),
    };
    let values = BusinessVisitPolicies {
        sales_policy: pick(sales_policy),
        fee_collection_policy: pick(fee_collection_policy),
    };
    for value in [&values.sales_policy, &values.fee_collection_policy] {
        if !BUSINESS_VISIT_POLICY_CHOICES.contains(&value.as_str()) {
            return Err(PolicyError("営業・集金の応対方針が不正です".into()));
        }
    }
    Ok(values)
}

/// `classify_business_visit`: `Some("fee_collection")`, `Some("sales")` or `None`.
pub fn classify_business_visit(text: &str) -> Option<&'static str> {
    let mut normalized = nfkc(text);
    if let Some(last) = PURPOSE_CORRECTION.find_iter(&normalized).last() {
        normalized = from(&normalized, last.end);
    }
    let folded = casefold(&normalized);
    if FEE_COLLECTION_RE.is_match(&folded) {
        return Some(FEE_COLLECTION);
    }
    let hours_question = HOURS_QUESTION.is_match(&normalized);
    if CLEAR_SALES.is_match(&normalized) {
        return Some(SALES);
    }
    if hours_question {
        return None;
    }
    if normalized.contains("営業") && SALES_CONTEXT.is_match(&normalized) {
        return Some(SALES);
    }
    None
}

pub fn business_visit_decline_reply(kind: &str) -> &'static str {
    if kind == FEE_COLLECTION {
        "恐れ入りますが、この店舗では集金には対応しておりません。ご了承ください。"
    } else {
        "恐れ入りますが、この店舗では営業のご案内をお受けしておりません。ご了承ください。"
    }
}
