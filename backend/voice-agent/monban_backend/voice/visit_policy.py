from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


def _compact(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[\s、。,.!！?？]+", "", normalized)


def _is_filler(text: str) -> bool:
    return bool(
        re.fullmatch(
            r"(?:あのう?|えっと|ええと|えと|その|うんと|うん|ん|ええ|ああ|じゃあ|あ|え|えー|あー|んー)+",
            _compact(text),
        )
    )


# Short acknowledgements a visitor uses to end the call. Once the agent has already said its
# farewell, replying to these again would repeat the goodbye (spec 5.6 rule 8 says it once).
_CLOSE_ACK = re.compile(
    r"^(?:はい|ええ|うん|そう|そうですね|そうですか|わかりました|分かりました|かしこまりました|"
    r"大丈夫です|大丈夫|ありがとうございます|ありがとうございました|ありがとう|どうも|お願いします|失礼します|失礼いたします|"
    r"じゃあ|では|それでは)+$"
)
_FAREWELL = re.compile(r"(?:失礼(?:いた)?します|さようなら|お気をつけて(?:お帰りください)?)")
_PLACEMENT_QUESTION = re.compile(
    r"(?:どう(?:すれば|やって)|どこに|どちらに|ここ|そこ|このまま|玄関(?:の)?前|宅配ボックス|"
    r"置いて|置けば|置いておけば|入れて|入れれば).{0,24}(?:大丈夫|いい|よい|良い|ですか|でしょう)"
    r"|(?:大丈夫|いい|よい|良い)ですか.{0,12}(?:置|玄関|荷物|宅配ボックス)"
)
_WILL_PLACE = re.compile(
    r"(?:置いていきます|置いておきます|置かせていただきます|置いていっても|置きます|"
    r"入れていきます|入れておきます|入れます)"
)
_DELIVERY_ACK = re.compile(r"^(?:ありがとうございます|ありがとうございました|ありがとう|どうも|お願いします|よろしくお願いします)+$")
_CIRCULAR_BOARD = re.compile(r"回覧(?:板|版|物)")
_CIRCULAR_BOARD_PLACED = re.compile(
    r"(?:ポスト|郵便受け).{0,16}(?:入れておきました|入れました|入れてあります|入れた|投函(?:しました|済み))|"
    r"(?:入れておきました|入れました|入れてあります|入れた|投函(?:しました|済み))|"
    r"回覧板.{0,8}回しました"
)
_REPETITION_COMPLAINT = re.compile(
    r"(?:何回|何度).{0,16}(?:同じ|繰り返)|"
    r"(?:同じ(?:こと|お願い|案内|返事|説明)).{0,20}(?:何回|何度|また|繰り返|言って|言う)|"
    r"(?:さっき|もう|先ほど).{0,12}(?:言った|伝えた|説明した)|"
    r"(?:繰り返|同じ).{0,12}(?:言って|返して|出て|繰り返)"
)
_CIRCULAR_BOARD_ACK = re.compile(r"(?:ありがとうございます|承知しました|確認しました|かしこまりました)")
_PRESENCE_QUESTION = re.compile(r"(?:在宅|ご在宅|いらっしゃいますか|いらっしゃいます|お留守|いますか|いるんですか)")
_MAILBOX_NO_FIT = re.compile(r"(?:ポスト|郵便受け).{0,12}(?:入らない|入らなく|入れられない|入らなかった)|(?:入らない|入らなく|入れられない).{0,12}(?:ポスト|郵便受け)")
_PHOTO_FOLLOWUP = re.compile(r"写真.{0,16}(?:どう|どこ|送|渡|したら|すれば|いい|必要|いります|撮る)")
_NAME_CONFIRMATION = re.compile(r"^(?:(?:はい|ええ|そうです|いや|違います)?[一-龯々ぁ-んァ-ヶー]{1,8}(?:さん|様)?(?:です|でした)|(?:名前|お名前).{0,12}(?:です|でした))$")
_NAME_CORRECTION = re.compile(r".{1,12}(?:じゃなくて|ではなくて|というか).{1,8}(?:です|でした)$")
_UNRELATED_PURPOSE = re.compile(r"(?:郵便(?:です|で|物|なん)|書留|町内会|自治会|回覧|点検|工事|修理|近所|消防|警察|役所|検針|新聞|アンケート|募金|寄付|忘れ物)")
_DELIVERY = re.compile(
    r"(?:宅配|宅急便|配達|お届け|荷物(?:です|で|のお届け|を届け|をお届け|を持って|を配達)|"
    r"配送|ヤマト|佐川(?:急便)?|日本郵便|郵便局|ゆうパック|西濃|福山通運|amazon|アマゾン|"
    r"クール便|冷蔵便|冷凍便|代引|代金引換|着払い|受領印|サインが必要)"
)
_PAYMENT = re.compile(r"集金|収金|支払|お金.*(?:集め|払|受取)|受信料|請求|料金.*(?:徴収|回収)")
_SALES = re.compile(r"営業|勧誘|セールス|訪問販売")
_PURPOSE_CORRECTION = re.compile(
    r"(?:じゃなくて|ではなくて|ではなく|じゃなく|でなくて|でなく|ではありませんが|ではありません|じゃありませんが|じゃありません|ではないですが|じゃないですが)"
)
_DELIVERY_DENIED = re.compile(
    r"(?:お?荷物|宅配|配達|配送).{0,6}(?:ない|なく|なかった|ありません|ございません|無い|無く|持っていな)"
)
_DELIVERY_UNAVAILABLE = re.compile(
    r"クール|冷蔵|冷凍|代引|代金引換|着払い|受領印|署名|サイン.{0,4}必要|"
    r"(?:置けない|置き配できない|対面でのお渡し|直接手渡し)"
)
_DELIVERY_LOCATION_BLOCKED = re.compile(
    r"(?:宅配ボックス|ボックス|箱).{0,12}(?:いっぱい|満杯|空きがない|入らない|故障|使えない|壊れ)|"
    r"(?:いっぱい|満杯|空きがない|入らない|故障|使えない|壊れ).{0,12}(?:宅配ボックス|ボックス|箱)"
)

# Match an actual final turn, not a quoted farewell or a polite introduction.
# Present-tense thanks alone are an acknowledgement while the visit continues.
_DEPARTURE_TURN = re.compile(
    r"(?:(?:はい|ええ|うん|では|それでは|じゃあ|どうも|承知しました|承知いたしました|"
    r"わかりました|分かりました|かしこまりました|ありがとうございます|ありがとう))*"
    r"(?:失礼(?:いた)?します|さようなら|さよなら|帰ります|おいとまします|ありがとうございました)"
    r"(?:(?:ありがとうございました|ありがとうございます|ありがとう|どうも|失礼(?:いた)?します))*"
)
_FOLLOW_UP = re.compile(
    r"(?:どう(?!も)|どこ|何|なに|ですか|でしょうか|違う|ちがう|教えて|質問|確認したい)|"
    r"(?:あと|それと|それから|もう一つ|ついでに|まだ).+|"
    r"(?:サイン|署名|受領印|支払|印鑑).{0,16}(?:必要|お願|ください|いただ|もら|して)"
)
_PLACED = re.compile(
    r"置(?:きました|き終わりました|き終えました|いた|いておきました|いてきました|"
    r"いてあります|かせていただきました)|"
    r"入れ(?:ました|た|ておきました|てきました|てあります)|設置(?:しました|済み)"
)
_NOT_PLACED = re.compile(
    r"(?:置(?:いておき|いてあり|いて|け|か|き)|入れ(?:て|られ)?|設置(?:して|できて)?)"
    r"(?:は|も)?(?:いませんでした|おりませんでした|いなかった|いません|おりません|いない|ません|なかった|ない)|"
    r"(?:置いた|入れた|設置した)(?:わけ|こと|覚え|つもり|の)(?:では|じゃ|は|が|も)?(?:ありません|ない|なかった)"
)
_REPORTED_LANGUAGE = re.compile(r"引用|復唱|読み上げ|(?:と|って)(?:言|伝え|聞|書|話)")


def _has_follow_up(text: str) -> bool:
    return bool(re.search(r"[?？]", text) or _FOLLOW_UP.search(_compact(text)) or _REPORTED_LANGUAGE.search(text))


def _visitor_is_leaving(text: str) -> bool:
    if _has_follow_up(text):
        return False
    value = _compact(text)
    # ASR may supply punctuation between a completed task and the final goodbye.
    clauses = [part for part in re.split(r"[。.!！\n]+", text) if part.strip()]
    final_clause = _compact(clauses[-1]) if clauses else value
    return bool(
        _DEPARTURE_TURN.fullmatch(value)
        or _DEPARTURE_TURN.fullmatch(final_clause)
        or re.fullmatch(r"(?:また|改めて|後で|あとで).*(?:来ます|伺います|きます)", value)
    )


def _placement_result(text: str) -> bool | None:
    # A quoted/reporting expression is not the visitor reporting their own action.
    if _REPORTED_LANGUAGE.search(text):
        return None
    unquoted = re.sub(r'「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"', "", text)
    value = _compact(unquoted)
    negatives = list(_NOT_PLACED.finditer(value))
    last_negative = negatives[-1].end() if negatives else -1
    completed = [match for match in _PLACED.finditer(value) if not re.match(
        r"(?:か|っけ|ら|り|場合|こと|わけ|覚え|つもり|のでは|のじゃ|とは|と言|って|という|と書)", value[match.end():]
    )]
    if completed and completed[-1].start() >= last_negative:
        return True
    return False if negatives else None


def _positive_purpose(text: str) -> str:
    if _CIRCULAR_BOARD.search(text):
        return "circular_board"
    if _PAYMENT.search(text):
        return "payment"
    if _DELIVERY.search(text):
        return "delivery"
    if _SALES.search(text):
        return "sales"
    if _UNRELATED_PURPOSE.search(text):
        return "other"
    return "unknown"


def _purpose_from_text(text: str) -> str:
    """Let an explicit correction take precedence over the purpose it replaces."""
    for correction in reversed(list(_PURPOSE_CORRECTION.finditer(text))):
        corrected = _positive_purpose(text[correction.end() :])
        if corrected != "unknown":
            return corrected
    return _positive_purpose(text)


@dataclass(slots=True)
class VisitState:
    purpose: str = "unknown"
    no_parcel: bool = False
    placed: bool = False
    photographed: bool = False
    closing: bool = False
    closing_said: bool = False
    asked_purpose: bool = False
    asked_delivery_placement: bool = False
    asked_delivery_slip: bool = False
    requested_delivery_location: str | None = None
    house_rules: str = ""
    visitor_will_place: bool = False
    latest_user_text: str = ""
    pending_question: str | None = None
    name_confirmation: bool = False
    presence_question: bool = False
    mailbox_does_not_fit: bool = False
    delivery_unavailable: bool = False
    delivery_location_unavailable: bool = False
    circular_board_placed: bool = False
    circular_board_acknowledged: bool = False
    repetition_complaint: bool = False

    @classmethod
    def from_messages(
        cls, messages: list[tuple[str, str]], house_rules: str = ""
    ) -> "VisitState":
        state = cls(house_rules=house_rules)
        normalized_rules = _compact(house_rules)
        if re.search(
            r"宅配ボックス.{0,16}(?:優先|入れて|入れ|置|利用|希望|使)|"
            r"(?:優先|入れて|入れ|置|利用|希望|使).{0,16}宅配ボックス",
            normalized_rules,
        ):
            state.requested_delivery_location = "宅配ボックス"
        elif re.search(r"玄関(?:の)?前", normalized_rules):
            state.requested_delivery_location = "玄関の前"
        previous_assistant = ""
        for role, text in messages:
            if role == "assistant":
                previous_assistant = text
                if (
                    state.purpose == "circular_board"
                    and state.circular_board_placed
                    and _CIRCULAR_BOARD_ACK.search(text)
                ):
                    state.circular_board_acknowledged = True
                if re.search(r"用件.*(?:伺|聞|教)|どのような.*用", text):
                    state.asked_purpose = True
                    state.pending_question = "purpose"
                elif "写真" in text and re.search(r"(?:撮|送|保管|お願|ください)", text):
                    state.pending_question = "photo"
                elif re.search(r"どちらに置|どこに置|置き場所", text):
                    state.pending_question = "placement"
                if re.search(r"失礼(?:いた)?します|さようなら|お気をつけて", text):
                    state.closing_said = True
                if re.search(r"玄関(?:の)?前|置いていただけ|宅配ボックス|不在票", text):
                    state.asked_delivery_placement = True
                if "不在票" in text and re.search(r"(?:入れ|お願|ください)", text):
                    state.asked_delivery_slip = True
                if re.search(r"玄関(?:の)?前", text):
                    state.requested_delivery_location = "玄関の前"
                elif "宅配ボックス" in text:
                    state.requested_delivery_location = "宅配ボックス"
                continue
            if role != "user":
                continue

            state.latest_user_text = text
            value = _compact(text)
            state.repetition_complaint = bool(_REPETITION_COMPLAINT.search(value))
            state.name_confirmation = False
            state.presence_question = bool(_PRESENCE_QUESTION.search(value))
            state.mailbox_does_not_fit = bool(_MAILBOX_NO_FIT.search(value))
            state.delivery_unavailable = bool(_DELIVERY_UNAVAILABLE.search(value))
            state.delivery_location_unavailable = bool(_DELIVERY_LOCATION_BLOCKED.search(value))
            if _is_filler(text):
                continue
            answered_photo_question = state.pending_question == "photo"
            if state.pending_question:
                state.pending_question = None
            state.closing = _visitor_is_leaving(text)
            denied = bool(_DELIVERY_DENIED.search(value))
            if denied:
                state.no_parcel = True
                if state.purpose == "delivery":
                    state.purpose = "other"
                    state.placed = state.photographed = state.visitor_will_place = False

            topic = _purpose_from_text(value)
            placement_result = _placement_result(text)
            if (
                topic == "unknown" and state.purpose == "unknown" and not denied
                and placement_result is True and re.search(r"お?荷物|宅配|配達|配送", value)
            ):
                # An earlier introduction may have been mistranscribed. An explicit
                # parcel completion is sufficient evidence of the delivery topic.
                topic = "delivery"
            previous_asked_about_name_and_purpose = bool(
                re.search(r"[一-龯々ぁ-んァ-ヶー]{1,8}(?:さん|様)", previous_assistant)
                and re.search(r"用件.*(?:伺|聞|教)|どのような.*用", previous_assistant)
            )
            previous_assistant = ""
            if previous_asked_about_name_and_purpose and (
                _NAME_CONFIRMATION.fullmatch(value) or _NAME_CORRECTION.fullmatch(value)
            ):
                state.name_confirmation = True
            # A new named topic replaces the previous purpose for this visit. This is
            # especially important when a visitor corrects a payment/delivery assumption.
            if topic == "circular_board":
                state.purpose = "circular_board"
                state.no_parcel = False
                state.placed = state.photographed = state.visitor_will_place = False
                state.asked_purpose = False
            elif topic == "payment":
                state.purpose = "payment"
                state.no_parcel = False
                state.asked_purpose = False
            elif topic == "sales":
                state.purpose = "sales"
                state.no_parcel = False
                state.asked_purpose = False
            elif topic == "delivery" and not denied:
                state.purpose = "delivery"
                state.no_parcel = False
                state.asked_purpose = False
            elif topic == "delivery" and denied:
                state.purpose = "other"
                state.no_parcel = True
                state.placed = state.photographed = state.visitor_will_place = False
            elif topic == "other":
                state.purpose = "other"
                state.no_parcel = False
                state.placed = state.photographed = state.visitor_will_place = False
                state.asked_purpose = False
            elif state.name_confirmation:
                # The visitor supplied a name after we reflected it; that does not answer
                # the still-pending purpose question or create a new unsupported purpose.
                state.purpose = "unknown"

            if state.delivery_allowed:
                if (
                    state.delivery_location_unavailable
                    and state.requested_delivery_location == "宅配ボックス"
                    and re.search(r"玄関(?:の)?前", normalized_rules)
                ):
                    state.requested_delivery_location = "玄関の前"
                if _WILL_PLACE.search(value):
                    state.visitor_will_place = True
                if placement_result is not None:
                    state.placed = placement_result
                if re.search(r"写真.*(?:撮りました|撮った|撮影しました|撮影済み)", value) or (
                    answered_photo_question
                    and re.search(r"(?:撮りました|撮った|撮影しました|撮影済み|終わりました)", value)
                ):
                    state.photographed = True
            if state.purpose == "circular_board" and _CIRCULAR_BOARD_PLACED.search(value):
                state.circular_board_placed = True
        return state

    @property
    def delivery_allowed(self) -> bool:
        return self.purpose == "delivery" and not self.no_parcel

    @property
    def has_circular_board_rule(self) -> bool:
        return bool(
            re.search(
                r"(?:回覧板|回覧物).{0,40}(?:ポスト|郵便受け|玄関|宅配ボックス|置|入)|"
                r"(?:ポスト|郵便受け|玄関|宅配ボックス).{0,40}(?:回覧板|回覧物)",
                self.house_rules,
            )
        )

    @property
    def requests_delivery_slip(self) -> bool:
        rules = _compact(self.house_rules)
        return "不在票" in rules and self.requested_delivery_location is None

    @property
    def should_wait(self) -> bool:
        value = _compact(self.latest_user_text)
        incomplete = bool(re.search(r"(?:たら|なら|じゃなくて|ではなくて|ではなく|じゃなく)$", value))
        if self.repetition_complaint:
            return False
        return (
            _is_filler(self.latest_user_text)
            or (self.purpose == "unknown" and value in {"はい", "ええ", "うん"})
            or incomplete
            # The farewell was already said. Do not repeat it to a closing acknowledgement;
            # the device ends the call on the closing phrase (spec 5.1 CLOSING).
            or (self.closing_said and bool(_CLOSE_ACK.fullmatch(value)))
            # Once we've thanked the visitor for completing the circular-board task,
            # another acknowledgement or repeat confirmation adds no new information.
            or (
                self.purpose == "circular_board"
                and self.circular_board_placed
                and self.circular_board_acknowledged
                and (
                    bool(_CIRCULAR_BOARD_PLACED.search(value))
                    or bool(_CLOSE_ACK.fullmatch(value))
                )
            )
            or value in {"nhkの", "あの荷物じゃなくて", "お荷物じゃなくて"}
        )

    def instructions(self) -> str:
        return (
            "来訪者の発言から把握した状態: "
            f"用件={self.purpose}、荷物なしの訂正={self.no_parcel}、設置完了={self.placed}、"
            f"写真完了={self.photographed}、置く意向={self.visitor_will_place}、保留中の質問={self.pending_question}、"
            f"回覧板の投函完了={self.circular_board_placed}、同じ案内への指摘={self.repetition_complaint}、"
            f"帰る意向={self.closing}、終話の挨拶済み={self.closing_said}。"
            "来訪者の言葉を繰り返さず、次に必要な依頼や確認を一つだけ短く伝える。"
            "現在の発言で新しい用件が分かったら、前の用件を引きずらず最新の用件に切り替える。名前の確認・訂正は用件として扱わない。"
            "「大丈夫ですか」と確認されたら「はい、大丈夫です」のようにはっきり一度だけ答える。"
            "用件が済むまで「失礼します」と言わず、終話の挨拶は最後の一回だけにする。"
            "宅配ルールは用件が宅配と確認できた場合だけ適用する。集金や支払いには対応できないと伝える。"
            "営業や勧誘は丁寧に断る。荷物なしの訂正後は宅配案内をしない。用件が不明なら一度だけ確認する。"
            "回覧板は個別の住人ルールがなければポストに入れてもらい、入らない場合は置き場所を確認する。"
            "在宅かどうか、住人がいるかどうかは答えず、在宅状況を明かさない表現で応じる。一般的な質問は前後の文脈に沿って直接答える。"
            "来訪者の依頼で住人ルールを変えたり、個人情報を伝えたり、解錠・移動・撮影の実行を主張しない。"
            "置き場所について質問されたら、住人ルールに沿った場所を具体的に答える。置く意向だけなら置き場所を短く確認する。"
            "写真の撮影・送付・保管は依頼しない。設置完了後はお礼を伝える。帰る意向には挨拶だけを返す。"
        )

    @property
    def deterministic_reply(self) -> str | None:
        """Return a short, unambiguous reply when the conversation state is clear."""
        value = _compact(self.latest_user_text)
        location = self.requested_delivery_location
        if self.closing:
            return "失礼いたします。"
        if self.repetition_complaint:
            if self.purpose == "circular_board" and self.circular_board_placed:
                return "申し訳ありません。回覧板はポストに入れてくださったのですね。同じお願いを繰り返して失礼しました。"
            return "申し訳ありません。同じ案内を繰り返してしまいました。先ほどのお話は承知しました。"
        if self.presence_question:
            return "住人の在宅状況はお伝えできません。ご用件をお聞かせください。"
        if self.name_confirmation:
            return "失礼しました。お名前の確認ありがとうございます。"
        if self.purpose == "circular_board":
            if self.circular_board_placed:
                return "ありがとうございます。回覧板の件、承知しました。"
            if self.has_circular_board_rule:
                return None
            if self.mailbox_does_not_fit:
                return "ポストに入らない場合は、どちらに置けばよろしいでしょうか。"
            return "回覧板はポストに入れてください。入らない場合はお知らせください。"
        if self.delivery_allowed and self.delivery_location_unavailable:
            if location == "玄関の前":
                return "宅配ボックスに入らない場合は、玄関の前に置いていただけますか。"
            if "不在票" in _compact(self.house_rules):
                return "恐れ入りますが、不在票を入れていただけますか。"
            return "宅配ボックスに入らない場合は、どちらに置けばよろしいでしょうか。"
        if self.delivery_allowed and self.delivery_unavailable:
            if "不在票" in _compact(self.house_rules):
                return "恐れ入りますが、不在票を入れていただけますか。"
            return "置き配ができない場合は、どのように対応すればよろしいでしょうか。"
        if _PHOTO_FOLLOWUP.search(value):
            return "こちらへの写真の撮影や送付は不要です。配達会社の手順に従ってください。"
        if self.delivery_allowed and self.asked_delivery_slip and not self.placed and _CLOSE_ACK.fullmatch(value):
            return "ありがとうございます。失礼いたします。"
        if self.delivery_allowed and self.requests_delivery_slip:
            return "恐れ入りますが、不在票を入れていただけますか。"
        if not self.delivery_allowed:
            return None
        if self.placed:
            if not _has_follow_up(self.latest_user_text):
                return "失礼いたします。"
            return None
        if not location:
            rules = _compact(self.house_rules)
            if re.search(r"(?:宅配|配送|配達|お荷物|荷物).{0,40}(?:受付|カウンター|置|預|手渡|お持ち|届け)|(?:受付|カウンター).{0,25}(?:お預|持参|お持ち)", rules):
                return None
            return "恐れ入りますが、置き場所を指定できないため、不在票をお願いいたします。"
        action = "入れて" if location == "宅配ボックス" else "置いて"
        context_question = self.asked_delivery_placement and bool(
            re.fullmatch(
                r"(?:(?:これ|それ|ここ|そこ|このまま|この場所)(?:で|なら)?)?"
                r"(?:大丈夫|いい|よい|良い)(?:ですか|でしょうか)",
                value,
            )
        )
        if _PLACEMENT_QUESTION.search(value) or context_question:
            return f"はい、{location}に{action}いただければ大丈夫です。"
        if _WILL_PLACE.search(value) and not self.placed:
            return f"はい、{location}にお願いいたします。"
        if not self.asked_delivery_placement and not self.placed:
            return f"恐れ入りますが、{location}に{action}いただけますか。"
        if self.asked_delivery_placement and not self.placed and _DELIVERY_ACK.fullmatch(value):
            return "はい、よろしくお願いいたします。"
        return None

    def trim_after_farewell(self, reply: str) -> str:
        """Drop any generated tail after a valid final farewell."""
        farewell = _FAREWELL.search(reply)
        farewell_allowed = self.closing or self.placed
        if not farewell or not farewell_allowed:
            return reply
        return reply[:farewell.end()].rstrip(" 。.!！\t\r\n") + "。"

    def fallback(self) -> str:
        if self.closing:
            return "失礼いたします。"
        if self.purpose == "payment":
            return "申し訳ありませんが、このインターホンではお支払いに対応できません。"
        if self.purpose == "sales":
            return "申し訳ありませんが、営業や勧誘はお断りしています。"
        if self.purpose == "circular_board":
            if self.circular_board_placed:
                return "ありがとうございます。回覧板の件、承知しました。"
            if self.has_circular_board_rule:
                return "承知しました。"
            return "回覧板はポストに入れてください。入らない場合はお知らせください。"
        if self.placed and not _has_follow_up(self.latest_user_text):
            return "失礼いたします。"
        if self.placed and _has_follow_up(self.latest_user_text):
            return "恐れ入りますが、追加で必要な対応をお聞かせください。"
        if self.name_confirmation:
            return "失礼しました。お名前の確認ありがとうございます。"
        if self.presence_question:
            return "住人の在宅状況はお伝えできません。ご用件をお聞かせください。"
        if self.delivery_allowed:
            if self.deterministic_reply:
                return self.deterministic_reply
            if self.requested_delivery_location and not self.asked_delivery_placement:
                location = self.requested_delivery_location
                action = "入れて" if location == "宅配ボックス" else "置いて"
                return f"恐れ入りますが、{location}に{action}いただけますか。"
            if self.requests_delivery_slip:
                return "恐れ入りますが、不在票を入れていただけますか。"
            if not self.requested_delivery_location:
                return "恐れ入りますが、置き場所を指定できないため、不在票をお願いいたします。"
        if self.purpose == "other":
            return "承知しました。どのように対応すればよいか、もう少し詳しくお聞かせください。"
        if self.asked_purpose:
            return "恐れ入りますが、もう少し詳しくお聞かせください。"
        return "恐れ入りますが、ご用件をお聞かせください。"

    def validate(self, reply: str) -> bool:
        if not reply.strip():
            return False
        farewell = _FAREWELL.search(reply)
        if farewell and reply[farewell.end():].strip(" 。.!！\t\r\n"):
            return False
        if farewell and not (self.closing or self.placed):
            return False
        if farewell and not self.closing and _has_follow_up(self.latest_user_text):
            return False
        if re.search(r"(?:写真.{0,20}(?:撮って|撮影して|撮影を|送って|送信して|送付して|保管して|保存して)|(?:撮影|送付|保管|保存).{0,8}(?:してください|お願いします|お願いいたします))", reply):
            return False
        if self.presence_question and re.search(r"(?:在宅|ご在宅|いらっしゃる|いる|不在|留守).{0,8}(?:です|ます|おります|ています|いません|おります)", reply):
            return False
        if re.search(r"(?:解錠|鍵を開け|荷物.{0,5}移動|撮影|写真.{0,4}撮).{0,10}(?:ました|ます|できます|いたします|しておきます|済み|完了)", reply):
            return False
        if self.closing and re.search(r"(?:伺|教え|お名前|ご用件|写真|宅配|荷物)|[?？]", reply):
            return False
        if not self.delivery_allowed and re.search(r"宅配|荷物|置き場所|写真|ボックス|お届け", reply):
            return False
        if self.deterministic_reply and reply.strip() != self.deterministic_reply:
            return False
        return True
