//! Port of `monban_backend/voice/visit_policy.py` (the door agent's visit state).

use crate::py_regex;
use crate::pyre::{from, nfkc, prefix, py_rstrip_chars, py_strip, py_strip_chars};

py_regex!(COMPACT_STRIP, r"[\s、。,.!！?？]+");
py_regex!(
    FILLER,
    r"(?:あのう?|えっと|ええと|えと|その|うんと|うん|ん|ええ|ああ|じゃあ|あ|え|えー|あー|んー)+"
);
py_regex!(
    CLOSE_ACK,
    r"^(?:はい|ええ|うん|そう|そうですね|そうですか|わかりました|分かりました|かしこまりました|",
    r"大丈夫です|大丈夫|ありがとうございます|ありがとうございました|ありがとう|どうも|お願いします|失礼します|失礼いたします|",
    r"じゃあ|では|それでは)+$"
);
py_regex!(
    FAREWELL,
    r"(?:失礼(?:いた)?します|さようなら|お気をつけて(?:お帰りください)?)"
);
py_regex!(
    PLACEMENT_QUESTION,
    r"(?:どう(?:すれば|やって)|どこに|どちらに|ここ|そこ|このまま|玄関(?:の)?前|宅配ボックス|",
    r"置いて|置けば|置いておけば|入れて|入れれば).{0,24}(?:大丈夫|いい|よい|良い|ですか|でしょう)",
    r"|(?:大丈夫|いい|よい|良い)ですか.{0,12}(?:置|玄関|荷物|宅配ボックス)"
);
py_regex!(
    WILL_PLACE,
    r"(?:置いていきます|置いておきます|置かせていただきます|置いていっても|置きます|",
    r"入れていきます|入れておきます|入れます)"
);
py_regex!(
    DELIVERY_ACK,
    r"^(?:ありがとうございます|ありがとうございました|ありがとう|どうも|お願いします|よろしくお願いします)+$"
);
py_regex!(CIRCULAR_BOARD, r"回覧(?:板|版|物)");
py_regex!(
    CIRCULAR_BOARD_PLACED,
    r"(?:ポスト|郵便受け).{0,16}(?:入れておきました|入れました|入れてあります|入れた|投函(?:しました|済み))|",
    r"(?:入れておきました|入れました|入れてあります|入れた|投函(?:しました|済み))|",
    r"回覧板.{0,8}回しました"
);
py_regex!(
    REPETITION_COMPLAINT,
    r"(?:何回|何度).{0,16}(?:同じ|繰り返)|",
    r"(?:同じ(?:こと|お願い|案内|返事|説明)).{0,20}(?:何回|何度|また|繰り返|言って|言う)|",
    r"(?:さっき|もう|先ほど).{0,12}(?:言った|伝えた|説明した)|",
    r"(?:繰り返|同じ).{0,12}(?:言って|返して|出て|繰り返)"
);
py_regex!(
    CIRCULAR_BOARD_ACK,
    r"(?:ありがとうございます|承知しました|確認しました|かしこまりました)"
);
py_regex!(
    PRESENCE_QUESTION,
    r"(?:在宅|ご在宅|いらっしゃいますか|いらっしゃいます|お留守|いますか|いるんですか)"
);
py_regex!(
    MAILBOX_NO_FIT,
    r"(?:ポスト|郵便受け).{0,12}(?:入らない|入らなく|入れられない|入らなかった)|(?:入らない|入らなく|入れられない).{0,12}(?:ポスト|郵便受け)"
);
py_regex!(
    PHOTO_FOLLOWUP,
    r"写真.{0,16}(?:どう|どこ|送|渡|したら|すれば|いい|必要|いります|撮る)"
);
py_regex!(
    NAME_CONFIRMATION,
    r"^(?:(?:はい|ええ|そうです|いや|違います)?[一-龯々ぁ-んァ-ヶー]{1,8}(?:さん|様)?(?:です|でした)|(?:名前|お名前).{0,12}(?:です|でした))$"
);
py_regex!(
    NAME_CORRECTION,
    r".{1,12}(?:じゃなくて|ではなくて|というか).{1,8}(?:です|でした)$"
);
py_regex!(
    UNRELATED_PURPOSE,
    r"(?:郵便(?:です|で|物|なん)|書留|町内会|自治会|回覧|点検|工事|修理|近所|消防|警察|役所|検針|新聞|アンケート|募金|寄付|忘れ物)"
);
py_regex!(
    DELIVERY,
    r"(?:宅配|宅急便|配達|お届け|荷物(?:です|で|のお届け|を届け|をお届け|を持って|を配達)|",
    r"配送|ヤマト|佐川(?:急便)?|日本郵便|郵便局|ゆうパック|西濃|福山通運|amazon|アマゾン|",
    r"クール便|冷蔵便|冷凍便|代引|代金引換|着払い|受領印|サインが必要)"
);
py_regex!(
    PAYMENT,
    r"集金|収金|支払|お金.*(?:集め|払|受取)|受信料|請求|料金.*(?:徴収|回収)"
);
py_regex!(SALES, r"営業|勧誘|セールス|訪問販売");
py_regex!(
    PURPOSE_CORRECTION,
    r"(?:じゃなくて|ではなくて|ではなく|じゃなく|でなくて|でなく|ではありませんが|ではありません|じゃありませんが|じゃありません|ではないですが|じゃないですが)"
);
py_regex!(
    DELIVERY_DENIED,
    r"(?:お?荷物|宅配|配達|配送).{0,6}(?:ない|なく|なかった|ありません|ございません|無い|無く|持っていな)"
);
py_regex!(
    DELIVERY_UNAVAILABLE,
    r"クール|冷蔵|冷凍|代引|代金引換|着払い|受領印|署名|サイン.{0,4}必要|",
    r"(?:置けない|置き配できない|対面でのお渡し|直接手渡し)"
);
py_regex!(
    DELIVERY_LOCATION_BLOCKED,
    r"(?:宅配ボックス|ボックス|箱).{0,12}(?:いっぱい|満杯|空きがない|入らない|故障|使えない|壊れ)|",
    r"(?:いっぱい|満杯|空きがない|入らない|故障|使えない|壊れ).{0,12}(?:宅配ボックス|ボックス|箱)"
);

py_regex!(
    RULE_PREFERS_BOX,
    r"宅配ボックス.{0,16}(?:優先|入れて|入れ|置|利用|希望|使)|",
    r"(?:優先|入れて|入れ|置|利用|希望|使).{0,16}宅配ボックス"
);
py_regex!(ENTRANCE_FRONT, r"玄関(?:の)?前");
py_regex!(ASKED_PURPOSE, r"用件.*(?:伺|聞|教)|どのような.*用");
py_regex!(PHOTO_REQUEST_WORDS, r"(?:撮|送|保管|お願|ください)");
py_regex!(PLACEMENT_ASKED, r"どちらに置|どこに置|置き場所");
py_regex!(
    FAREWELL_SAID,
    r"失礼(?:いた)?します|さようなら|お気をつけて"
);
py_regex!(
    PLACEMENT_REQUESTED,
    r"玄関(?:の)?前|置いていただけ|宅配ボックス|不在票"
);
py_regex!(SLIP_REQUEST_WORDS, r"(?:入れ|お願|ください)");
// Match an actual final turn, not a quoted farewell or a polite introduction.
// Present-tense thanks alone are an acknowledgement while the visit continues.
py_regex!(
    DEPARTURE_TURN,
    r"(?:(?:はい|ええ|うん|では|それでは|じゃあ|どうも|承知しました|承知いたしました|",
    r"わかりました|分かりました|かしこまりました|ありがとうございます|ありがとう))*",
    r"(?:失礼(?:いた)?します|さようなら|さよなら|帰ります|おいとまします|ありがとうございました)",
    r"(?:(?:ありがとうございました|ありがとうございます|ありがとう|どうも|失礼(?:いた)?します))*"
);
py_regex!(
    FOLLOW_UP,
    r"(?:どう(?!も)|どこ|何|なに|ですか|でしょうか|違う|ちがう|教えて|質問|確認したい)|",
    // 「あとで」 is a time (「あとでまた来ます」), not 「あと、…」 introducing another request.
    r"(?:あと(?!で)|それと|それから|もう一つ|ついでに|まだ).+|",
    r"(?:サイン|署名|受領印|支払|印鑑).{0,16}(?:必要|お願|ください|いただ|もら|して)"
);
py_regex!(
    PLACED_NOW,
    r"置(?:きました|き終わりました|き終えました|いた|いておきました|いてきました|",
    r"いてあります|かせていただきました)|",
    r"入れ(?:ました|た|ておきました|てきました|てあります)|設置(?:しました|済み)"
);
py_regex!(
    NOT_PLACED,
    r"(?:置(?:いておき|いてあり|いて|け|か|き)|入れ(?:て|られ)?|設置(?:して|できて)?)",
    r"(?:は|も)?(?:いませんでした|おりませんでした|いなかった|いません|おりません|いない|ません|なかった|ない)|",
    r"(?:置いた|入れた|設置した)(?:わけ|こと|覚え|つもり|の)(?:では|じゃ|は|が|も)?(?:ありません|ない|なかった)"
);
py_regex!(REVISIT, r"(?:また|改めて|後で|あとで).*(?:来ます|伺います|きます)");
py_regex!(REPORTED_LANGUAGE, r"引用|復唱|読み上げ|(?:と|って)(?:言|伝え|聞|書|話)");
py_regex!(QUESTION_MARK, r"[?？]");
py_regex!(QUOTED, r#"「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*""#);
py_regex!(
    NOT_A_REPORT_AFTER,
    r"(?:か|っけ|ら|り|場合|こと|わけ|覚え|つもり|のでは|のじゃ|とは|と言|って|という|と書)"
);
py_regex!(PARCEL_WORDS, r"お?荷物|宅配|配達|配送");
py_regex!(REFLECTED_NAME, r"[一-龯々ぁ-んァ-ヶー]{1,8}(?:さん|様)");
py_regex!(
    PHOTO_TAKEN,
    r"写真.*(?:撮りました|撮った|撮影しました|撮影済み)"
);
py_regex!(
    PHOTO_DONE,
    r"(?:撮りました|撮った|撮影しました|撮影済み|終わりました)"
);
py_regex!(
    CIRCULAR_BOARD_RULE,
    r"(?:回覧板|回覧物).{0,40}(?:ポスト|郵便受け|玄関|宅配ボックス|置|入)|",
    r"(?:ポスト|郵便受け|玄関|宅配ボックス).{0,40}(?:回覧板|回覧物)"
);
py_regex!(
    INCOMPLETE,
    r"(?:たら|なら|じゃなくて|ではなくて|ではなく|じゃなく)$"
);
py_regex!(
    STORE_DELIVERY_RULE,
    r"(?:宅配|配送|配達|お荷物|荷物).{0,40}(?:受付|カウンター|置|預|手渡|お持ち|届け)|(?:受付|カウンター).{0,25}(?:お預|持参|お持ち)"
);
py_regex!(
    CONTEXT_QUESTION,
    r"(?:(?:これ|それ|ここ|そこ|このまま|この場所)(?:で|なら)?)?",
    r"(?:大丈夫|いい|よい|良い)(?:ですか|でしょうか)"
);
py_regex!(
    PHOTO_INSTRUCTION,
    r"(?:写真.{0,20}(?:撮って|撮影して|撮影を|送って|送信して|送付して|保管して|保存して)|(?:撮影|送付|保管|保存).{0,8}(?:してください|お願いします|お願いいたします))"
);
py_regex!(
    PRESENCE_DISCLOSURE,
    r"(?:在宅|ご在宅|いらっしゃる|いる|不在|留守).{0,8}(?:です|ます|おります|ています|いません|おります)"
);
py_regex!(
    ACTION_CLAIM,
    r"(?:解錠|鍵を開け|荷物.{0,5}移動|撮影|写真.{0,4}撮).{0,10}(?:ました|ます|できます|いたします|しておきます|済み|完了)"
);
py_regex!(
    CLOSING_FORBIDDEN,
    r"(?:伺|教え|お名前|ご用件|写真|宅配|荷物)|[?？]"
);
py_regex!(DELIVERY_WORDS, r"宅配|荷物|置き場所|写真|ボックス|お届け");

const FAREWELL_STRIP: &str = " 。.!！\t\r\n";

/// `_compact`: NFKC, lower-case, and drop spaces and sentence punctuation.
pub fn compact(text: &str) -> String {
    let normalized = nfkc(text).to_lowercase();
    COMPACT_STRIP.sub("", &normalized)
}

/// `_has_follow_up`.
pub fn has_follow_up(text: &str) -> bool {
    QUESTION_MARK.is_match(text) || FOLLOW_UP.is_match(&compact(text)) || REPORTED_LANGUAGE.is_match(text)
}

/// `_visitor_is_leaving`.
pub fn visitor_is_leaving(text: &str) -> bool {
    if has_follow_up(text) {
        return false;
    }
    let value = compact(text);
    // ASR may supply punctuation between a completed task and the final goodbye.
    let final_clause = text
        .split(['。', '.', '!', '！', '\n'])
        .rfind(|part| !py_strip(part).is_empty())
        .map(compact)
        .unwrap_or_else(|| value.clone());
    DEPARTURE_TURN.is_full_match(&value)
        || DEPARTURE_TURN.is_full_match(&final_clause)
        || REVISIT.is_full_match(&value)
        || REVISIT.is_full_match(&final_clause)
}

/// `_placement_result`: Some(true) placed, Some(false) not placed, None unknown.
pub fn placement_result(text: &str) -> Option<bool> {
    // A quoted/reporting expression is not the visitor reporting their own action.
    if REPORTED_LANGUAGE.is_match(text) {
        return None;
    }
    let value = compact(&QUOTED.sub("", text));
    let negatives = NOT_PLACED.find_iter(&value);
    let last_negative = negatives.last().map(|m| m.end as i64).unwrap_or(-1);
    let completed: Vec<_> = PLACED_NOW
        .find_iter(&value)
        .into_iter()
        .filter(|m| !NOT_A_REPORT_AFTER.is_prefix_match(&from(&value, m.end)))
        .collect();
    if completed.last().is_some_and(|m| m.start as i64 >= last_negative) {
        return Some(true);
    }
    if negatives.is_empty() {
        None
    } else {
        Some(false)
    }
}

/// `_is_filler`.
pub fn is_filler(text: &str) -> bool {
    FILLER.is_full_match(&compact(text))
}

/// The visit purpose (`VisitState.purpose`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Purpose {
    Unknown,
    CircularBoard,
    Payment,
    Delivery,
    Sales,
    Other,
}

impl Purpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::CircularBoard => "circular_board",
            Self::Payment => "payment",
            Self::Delivery => "delivery",
            Self::Sales => "sales",
            Self::Other => "other",
        }
    }
}

fn positive_purpose(text: &str) -> Purpose {
    if CIRCULAR_BOARD.is_match(text) {
        Purpose::CircularBoard
    } else if PAYMENT.is_match(text) {
        Purpose::Payment
    } else if DELIVERY.is_match(text) {
        Purpose::Delivery
    } else if SALES.is_match(text) {
        Purpose::Sales
    } else if UNRELATED_PURPOSE.is_match(text) {
        Purpose::Other
    } else {
        Purpose::Unknown
    }
}

/// `_purpose_from_text`: an explicit correction takes precedence over the purpose it replaces.
pub fn purpose_from_text(text: &str) -> Purpose {
    for correction in PURPOSE_CORRECTION.find_iter(text).iter().rev() {
        let corrected = positive_purpose(&from(text, correction.end));
        if corrected != Purpose::Unknown {
            return corrected;
        }
    }
    positive_purpose(text)
}

/// A question still waiting for the visitor's answer (`VisitState.pending_question`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PendingQuestion {
    Purpose,
    Photo,
    Placement,
}

impl PendingQuestion {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Purpose => "purpose",
            Self::Photo => "photo",
            Self::Placement => "placement",
        }
    }
}

pub const LOCATION_BOX: &str = "宅配ボックス";
pub const LOCATION_FRONT: &str = "玄関の前";

/// Message role in the conversation passed to [`VisitState::from_messages`].
pub const ROLE_USER: &str = "user";
pub const ROLE_ASSISTANT: &str = "assistant";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisitState {
    pub purpose: Purpose,
    pub no_parcel: bool,
    pub placed: bool,
    pub photographed: bool,
    pub closing: bool,
    pub closing_said: bool,
    pub asked_purpose: bool,
    pub asked_delivery_placement: bool,
    pub asked_delivery_slip: bool,
    pub requested_delivery_location: Option<&'static str>,
    pub house_rules: String,
    pub visitor_will_place: bool,
    pub latest_user_text: String,
    pub pending_question: Option<PendingQuestion>,
    pub name_confirmation: bool,
    pub presence_question: bool,
    pub mailbox_does_not_fit: bool,
    pub delivery_unavailable: bool,
    pub delivery_location_unavailable: bool,
    pub circular_board_placed: bool,
    pub circular_board_acknowledged: bool,
    pub repetition_complaint: bool,
}

impl Default for VisitState {
    fn default() -> Self {
        Self {
            purpose: Purpose::Unknown,
            no_parcel: false,
            placed: false,
            photographed: false,
            closing: false,
            closing_said: false,
            asked_purpose: false,
            asked_delivery_placement: false,
            asked_delivery_slip: false,
            requested_delivery_location: None,
            house_rules: String::new(),
            visitor_will_place: false,
            latest_user_text: String::new(),
            pending_question: None,
            name_confirmation: false,
            presence_question: false,
            mailbox_does_not_fit: false,
            delivery_unavailable: false,
            delivery_location_unavailable: false,
            circular_board_placed: false,
            circular_board_acknowledged: false,
            repetition_complaint: false,
        }
    }
}

fn py_bool(value: bool) -> &'static str {
    if value {
        "True"
    } else {
        "False"
    }
}

impl VisitState {
    /// Build the state from `(role, text)` pairs; roles other than "user"/"assistant" are ignored.
    pub fn from_messages<R: AsRef<str>, T: AsRef<str>>(
        messages: &[(R, T)],
        house_rules: &str,
    ) -> Self {
        let mut state = Self {
            house_rules: house_rules.to_string(),
            ..Self::default()
        };
        let normalized_rules = compact(house_rules);
        if RULE_PREFERS_BOX.is_match(&normalized_rules) {
            state.requested_delivery_location = Some(LOCATION_BOX);
        } else if ENTRANCE_FRONT.is_match(&normalized_rules) {
            state.requested_delivery_location = Some(LOCATION_FRONT);
        }
        let mut previous_assistant = String::new();
        for (role, text) in messages {
            let (role, text) = (role.as_ref(), text.as_ref());
            if role == ROLE_ASSISTANT {
                previous_assistant = text.to_string();
                if state.purpose == Purpose::CircularBoard
                    && state.circular_board_placed
                    && CIRCULAR_BOARD_ACK.is_match(text)
                {
                    state.circular_board_acknowledged = true;
                }
                if ASKED_PURPOSE.is_match(text) {
                    state.asked_purpose = true;
                    state.pending_question = Some(PendingQuestion::Purpose);
                } else if text.contains("写真") && PHOTO_REQUEST_WORDS.is_match(text) {
                    state.pending_question = Some(PendingQuestion::Photo);
                } else if PLACEMENT_ASKED.is_match(text) {
                    state.pending_question = Some(PendingQuestion::Placement);
                }
                if FAREWELL_SAID.is_match(text) {
                    state.closing_said = true;
                }
                if PLACEMENT_REQUESTED.is_match(text) {
                    state.asked_delivery_placement = true;
                }
                if text.contains("不在票") && SLIP_REQUEST_WORDS.is_match(text) {
                    state.asked_delivery_slip = true;
                }
                if ENTRANCE_FRONT.is_match(text) {
                    state.requested_delivery_location = Some(LOCATION_FRONT);
                } else if text.contains(LOCATION_BOX) {
                    state.requested_delivery_location = Some(LOCATION_BOX);
                }
                continue;
            }
            if role != ROLE_USER {
                continue;
            }

            state.latest_user_text = text.to_string();
            let value = compact(text);
            state.repetition_complaint = REPETITION_COMPLAINT.is_match(&value);
            state.name_confirmation = false;
            state.presence_question = PRESENCE_QUESTION.is_match(&value);
            state.mailbox_does_not_fit = MAILBOX_NO_FIT.is_match(&value);
            state.delivery_unavailable = DELIVERY_UNAVAILABLE.is_match(&value);
            state.delivery_location_unavailable = DELIVERY_LOCATION_BLOCKED.is_match(&value);
            if is_filler(text) {
                continue;
            }
            let answered_photo_question = state.pending_question == Some(PendingQuestion::Photo);
            state.pending_question = None;
            state.closing = visitor_is_leaving(text);
            let denied = DELIVERY_DENIED.is_match(&value);
            if denied {
                state.no_parcel = true;
                if state.purpose == Purpose::Delivery {
                    state.purpose = Purpose::Other;
                    state.placed = false;
                    state.photographed = false;
                    state.visitor_will_place = false;
                }
            }

            let mut topic = purpose_from_text(&value);
            let placement = placement_result(text);
            if topic == Purpose::Unknown
                && state.purpose == Purpose::Unknown
                && !denied
                && placement == Some(true)
                && PARCEL_WORDS.is_match(&value)
            {
                // An earlier introduction may have been mistranscribed. An explicit
                // parcel completion is sufficient evidence of the delivery topic.
                topic = Purpose::Delivery;
            }
            let previous_asked_about_name_and_purpose = REFLECTED_NAME
                .is_match(&previous_assistant)
                && ASKED_PURPOSE.is_match(&previous_assistant);
            previous_assistant.clear();
            if previous_asked_about_name_and_purpose
                && (NAME_CONFIRMATION.is_full_match(&value)
                    || NAME_CORRECTION.is_full_match(&value))
            {
                state.name_confirmation = true;
            }
            match topic {
                Purpose::CircularBoard => {
                    state.purpose = Purpose::CircularBoard;
                    state.no_parcel = false;
                    state.placed = false;
                    state.photographed = false;
                    state.visitor_will_place = false;
                    state.asked_purpose = false;
                }
                Purpose::Payment => {
                    state.purpose = Purpose::Payment;
                    state.no_parcel = false;
                    state.asked_purpose = false;
                }
                Purpose::Sales => {
                    state.purpose = Purpose::Sales;
                    state.no_parcel = false;
                    state.asked_purpose = false;
                }
                Purpose::Delivery if !denied => {
                    state.purpose = Purpose::Delivery;
                    state.no_parcel = false;
                    state.asked_purpose = false;
                }
                Purpose::Delivery => {
                    state.purpose = Purpose::Other;
                    state.no_parcel = true;
                    state.placed = false;
                    state.photographed = false;
                    state.visitor_will_place = false;
                }
                Purpose::Other => {
                    state.purpose = Purpose::Other;
                    state.no_parcel = false;
                    state.placed = false;
                    state.photographed = false;
                    state.visitor_will_place = false;
                    state.asked_purpose = false;
                }
                Purpose::Unknown => {
                    if state.name_confirmation {
                        state.purpose = Purpose::Unknown;
                    }
                }
            }

            if state.delivery_allowed() {
                if state.delivery_location_unavailable
                    && state.requested_delivery_location == Some(LOCATION_BOX)
                    && ENTRANCE_FRONT.is_match(&normalized_rules)
                {
                    state.requested_delivery_location = Some(LOCATION_FRONT);
                }
                if WILL_PLACE.is_match(&value) {
                    state.visitor_will_place = true;
                }
                if let Some(placed) = placement {
                    state.placed = placed;
                }
                if PHOTO_TAKEN.is_match(&value)
                    || (answered_photo_question && PHOTO_DONE.is_match(&value))
                {
                    state.photographed = true;
                }
            }
            if state.purpose == Purpose::CircularBoard && CIRCULAR_BOARD_PLACED.is_match(&value) {
                state.circular_board_placed = true;
            }
        }
        state
    }

    pub fn delivery_allowed(&self) -> bool {
        self.purpose == Purpose::Delivery && !self.no_parcel
    }

    pub fn has_circular_board_rule(&self) -> bool {
        CIRCULAR_BOARD_RULE.is_match(&self.house_rules)
    }

    pub fn requests_delivery_slip(&self) -> bool {
        compact(&self.house_rules).contains("不在票") && self.requested_delivery_location.is_none()
    }

    pub fn should_wait(&self) -> bool {
        let value = compact(&self.latest_user_text);
        let incomplete = INCOMPLETE.is_match(&value);
        if self.repetition_complaint {
            return false;
        }
        is_filler(&self.latest_user_text)
            || (self.purpose == Purpose::Unknown
                && matches!(value.as_str(), "はい" | "ええ" | "うん"))
            || incomplete
            || (self.closing_said && CLOSE_ACK.is_full_match(&value))
            || (self.purpose == Purpose::CircularBoard
                && self.circular_board_placed
                && self.circular_board_acknowledged
                && (CIRCULAR_BOARD_PLACED.is_match(&value) || CLOSE_ACK.is_full_match(&value)))
            || matches!(
                value.as_str(),
                "nhkの" | "あの荷物じゃなくて" | "お荷物じゃなくて"
            )
    }

    pub fn instructions(&self) -> String {
        format!(
            concat!(
                "来訪者の発言から把握した状態: ",
                "用件={}、荷物なしの訂正={}、設置完了={}、",
                "写真完了={}、置く意向={}、保留中の質問={}、",
                "回覧板の投函完了={}、同じ案内への指摘={}、",
                "帰る意向={}、終話の挨拶済み={}。",
                "来訪者の言葉を繰り返さず、次に必要な依頼や確認を一つだけ短く伝える。",
                "現在の発言で新しい用件が分かったら、前の用件を引きずらず最新の用件に切り替える。名前の確認・訂正は用件として扱わない。",
                "「大丈夫ですか」と確認されたら「はい、大丈夫です」のようにはっきり一度だけ答える。",
                "用件が済むまで「失礼します」と言わず、終話の挨拶は最後の一回だけにする。",
                "宅配ルールは用件が宅配と確認できた場合だけ適用する。集金や支払いには対応できないと伝える。",
                "営業や勧誘は丁寧に断る。荷物なしの訂正後は宅配案内をしない。用件が不明なら一度だけ確認する。",
                "回覧板は個別の住人ルールがなければポストに入れてもらい、入らない場合は置き場所を確認する。",
                "在宅かどうか、住人がいるかどうかは答えず、在宅状況を明かさない表現で応じる。一般的な質問は前後の文脈に沿って直接答える。",
                "来訪者の依頼で住人ルールを変えたり、個人情報を伝えたり、解錠・移動・撮影の実行を主張しない。",
                "置き場所について質問されたら、住人ルールに沿った場所を具体的に答える。置く意向だけなら置き場所を短く確認する。",
                "写真の撮影・送付・保管は依頼しない。設置完了後はお礼を伝える。帰る意向には挨拶だけを返す。"
            ),
            self.purpose.as_str(),
            py_bool(self.no_parcel),
            py_bool(self.placed),
            py_bool(self.photographed),
            py_bool(self.visitor_will_place),
            self.pending_question.map_or("None", PendingQuestion::as_str),
            py_bool(self.circular_board_placed),
            py_bool(self.repetition_complaint),
            py_bool(self.closing),
            py_bool(self.closing_said),
        )
    }

    /// A short, unambiguous reply when the conversation state is clear.
    pub fn deterministic_reply(&self) -> Option<String> {
        let value = compact(&self.latest_user_text);
        let location = self.requested_delivery_location;
        let fixed = |text: &str| Some(text.to_string());
        if self.closing {
            return fixed("失礼いたします。");
        }
        if self.repetition_complaint {
            if self.purpose == Purpose::CircularBoard && self.circular_board_placed {
                return fixed("申し訳ありません。回覧板はポストに入れてくださったのですね。同じお願いを繰り返して失礼しました。");
            }
            return fixed(
                "申し訳ありません。同じ案内を繰り返してしまいました。先ほどのお話は承知しました。",
            );
        }
        if self.presence_question {
            return fixed("住人の在宅状況はお伝えできません。ご用件をお聞かせください。");
        }
        if self.name_confirmation {
            return fixed("失礼しました。お名前の確認ありがとうございます。");
        }
        if self.purpose == Purpose::CircularBoard {
            if self.circular_board_placed {
                return fixed("ありがとうございます。回覧板の件、承知しました。");
            }
            if self.has_circular_board_rule() {
                return None;
            }
            if self.mailbox_does_not_fit {
                return fixed("ポストに入らない場合は、どちらに置けばよろしいでしょうか。");
            }
            return fixed("回覧板はポストに入れてください。入らない場合はお知らせください。");
        }
        if self.delivery_allowed() && self.delivery_location_unavailable {
            if location == Some(LOCATION_FRONT) {
                return fixed("宅配ボックスに入らない場合は、玄関の前に置いていただけますか。");
            }
            if compact(&self.house_rules).contains("不在票") {
                return fixed("恐れ入りますが、不在票を入れていただけますか。");
            }
            return fixed("宅配ボックスに入らない場合は、どちらに置けばよろしいでしょうか。");
        }
        if self.delivery_allowed() && self.delivery_unavailable {
            if compact(&self.house_rules).contains("不在票") {
                return fixed("恐れ入りますが、不在票を入れていただけますか。");
            }
            return fixed("置き配ができない場合は、どのように対応すればよろしいでしょうか。");
        }
        if PHOTO_FOLLOWUP.is_match(&value) {
            return fixed("こちらへの写真の撮影や送付は不要です。配達会社の手順に従ってください。");
        }
        if self.delivery_allowed()
            && self.asked_delivery_slip
            && !self.placed
            && CLOSE_ACK.is_full_match(&value)
        {
            return fixed("ありがとうございます。失礼いたします。");
        }
        if self.delivery_allowed() && self.requests_delivery_slip() {
            return fixed("恐れ入りますが、不在票を入れていただけますか。");
        }
        if !self.delivery_allowed() {
            return None;
        }
        if self.placed {
            if !has_follow_up(&self.latest_user_text) {
                return fixed("失礼いたします。");
            }
            return None;
        }
        let Some(location) = location else {
            let rules = compact(&self.house_rules);
            if STORE_DELIVERY_RULE.is_match(&rules) {
                return None;
            }
            return fixed("恐れ入りますが、置き場所を指定できないため、不在票をお願いいたします。");
        };
        let action = if location == LOCATION_BOX {
            "入れて"
        } else {
            "置いて"
        };
        let context_question =
            self.asked_delivery_placement && CONTEXT_QUESTION.is_full_match(&value);
        if PLACEMENT_QUESTION.is_match(&value) || context_question {
            return Some(format!(
                "はい、{location}に{action}いただければ大丈夫です。"
            ));
        }
        if WILL_PLACE.is_match(&value) && !self.placed {
            return Some(format!("はい、{location}にお願いいたします。"));
        }
        if !self.asked_delivery_placement && !self.placed {
            return Some(format!(
                "恐れ入りますが、{location}に{action}いただけますか。"
            ));
        }
        if self.asked_delivery_placement && !self.placed && DELIVERY_ACK.is_full_match(&value) {
            return fixed("はい、よろしくお願いいたします。");
        }
        None
    }

    /// Drop any generated tail after a valid final farewell.
    pub fn trim_after_farewell(&self, reply: &str) -> String {
        let Some(farewell) = FAREWELL.search(reply) else {
            return reply.to_string();
        };
        if !(self.closing || self.placed) {
            return reply.to_string();
        }
        let head = prefix(reply, farewell.end);
        format!("{}。", py_rstrip_chars(&head, FAREWELL_STRIP))
    }

    pub fn fallback(&self) -> String {
        let fixed = |text: &str| text.to_string();
        if self.closing {
            return fixed("失礼いたします。");
        }
        match self.purpose {
            Purpose::Payment => {
                return fixed("申し訳ありませんが、このインターホンではお支払いに対応できません。")
            }
            Purpose::Sales => return fixed("申し訳ありませんが、営業や勧誘はお断りしています。"),
            Purpose::CircularBoard => {
                if self.circular_board_placed {
                    return fixed("ありがとうございます。回覧板の件、承知しました。");
                }
                if self.has_circular_board_rule() {
                    return fixed("承知しました。");
                }
                return fixed("回覧板はポストに入れてください。入らない場合はお知らせください。");
            }
            _ => {}
        }
        if self.placed && !has_follow_up(&self.latest_user_text) {
            return fixed("失礼いたします。");
        }
        if self.placed && has_follow_up(&self.latest_user_text) {
            return fixed("恐れ入りますが、追加で必要な対応をお聞かせください。");
        }
        if self.name_confirmation {
            return fixed("失礼しました。お名前の確認ありがとうございます。");
        }
        if self.presence_question {
            return fixed("住人の在宅状況はお伝えできません。ご用件をお聞かせください。");
        }
        if self.delivery_allowed() {
            if let Some(reply) = self.deterministic_reply().filter(|reply| !reply.is_empty()) {
                return reply;
            }
            if let Some(location) = self.requested_delivery_location {
                if !self.asked_delivery_placement {
                    let action = if location == LOCATION_BOX {
                        "入れて"
                    } else {
                        "置いて"
                    };
                    return format!("恐れ入りますが、{location}に{action}いただけますか。");
                }
            }
            if self.requests_delivery_slip() {
                return fixed("恐れ入りますが、不在票を入れていただけますか。");
            }
            if self.requested_delivery_location.is_none() {
                return fixed(
                    "恐れ入りますが、置き場所を指定できないため、不在票をお願いいたします。",
                );
            }
        }
        if self.purpose == Purpose::Other {
            return fixed(
                "承知しました。どのように対応すればよいか、もう少し詳しくお聞かせください。",
            );
        }
        if self.asked_purpose {
            return fixed("恐れ入りますが、もう少し詳しくお聞かせください。");
        }
        fixed("恐れ入りますが、ご用件をお聞かせください。")
    }

    pub fn validate(&self, reply: &str) -> bool {
        if py_strip(reply).is_empty() {
            return false;
        }
        let farewell = FAREWELL.search(reply);
        if let Some(farewell) = &farewell {
            if !py_strip_chars(&from(reply, farewell.end), FAREWELL_STRIP).is_empty() {
                return false;
            }
            if !(self.closing || self.placed) {
                return false;
            }
            if !self.closing && has_follow_up(&self.latest_user_text) {
                return false;
            }
        }
        if PHOTO_INSTRUCTION.is_match(reply) {
            return false;
        }
        if self.presence_question && PRESENCE_DISCLOSURE.is_match(reply) {
            return false;
        }
        if ACTION_CLAIM.is_match(reply) {
            return false;
        }
        if self.closing && CLOSING_FORBIDDEN.is_match(reply) {
            return false;
        }
        if !self.delivery_allowed() && DELIVERY_WORDS.is_match(reply) {
            return false;
        }
        if let Some(expected) = self.deterministic_reply().filter(|reply| !reply.is_empty()) {
            if py_strip(reply) != expected {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests;
