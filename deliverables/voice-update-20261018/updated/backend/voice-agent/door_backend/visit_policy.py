from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


def _compact(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[\s、。,.!！?？ー]+", "", normalized)


def _is_filler(text: str) -> bool:
    return bool(re.fullmatch(r"(?:あのう?|えっと|ええと|えと|その|うんと|うん|ん|ええ|ああ|じゃあ|あ|え)+", _compact(text)))


_CLOSE_ACK = re.compile(
    r"^(?:はい|ええ|うん|そう|そうですね|そうですか|わかりました|分かりました|かしこまりました|"
    r"大丈夫です|大丈夫|ありがとうございます|ありがとう|どうも|お願いします|失礼します|失礼いたします|"
    r"じゃあ|では|それでは)+$"
)
_FAREWELL = re.compile(r"(?:失礼(?:いた)?します|さようなら|お気をつけて(?:お帰りください)?)")
_PLACEMENT_QUESTION = re.compile(
    r"(?:どう(?:すれば|やって)|どこに|ここに|置いて|置けば|置いておけば|入れて).{0,20}(?:大丈夫|いい|よい|良い|ですか|でしょう)"
    r"|(?:大丈夫|いい|よい|良い)ですか.{0,12}(?:置|玄関|荷物)"
)
_WILL_PLACE = re.compile(r"(?:置いていきます|置いておきます|置かせていただきます|置いていっても)")
_DELIVERY_ACK = re.compile(r"^(?:ありがとうございます|ありがとうございました|ありがとう|どうも|お願いします|よろしくお願いします)+$")
_PHOTO_QUESTION = re.compile(r"(?:写真|画像).{0,20}(?:どう|どこ|何|なに|送|渡|すれば|したら|いい|よい|良い)")
_CIRCULAR_BOARD = re.compile(r"回覧(?:板|版|物)|かいらんばん")
_PRESENCE_QUESTION = re.compile(r"(?:在宅|ご在宅|いらっしゃいますか|いらっしゃいます|お留守|いますか|いるんですか)")
_MAILBOX_NO_FIT = re.compile(
    r"(?:ポスト|郵便受け).{0,12}(?:入らない|入らなく|入れられない|入らなかった)|"
    r"(?:入らない|入らなく|入れられない).{0,12}(?:ポスト|郵便受け)"
)
_NAME_CONFIRMATION = re.compile(
    r"^(?:(?:はい|ええ|そうです|いや|違います)?[一-龯々ぁ-んァ-ヶー]{1,8}(?:さん|様)?(?:です|でした)|"
    r"(?:名前|お名前).{0,12}(?:です|でした))$"
)
_NAME_CORRECTION = re.compile(r".{1,12}(?:じゃなくて|ではなくて|というか).{1,8}(?:です|でした)$")
_UNRELATED_PURPOSE = re.compile(
    r"(?:郵便(?:です|で|物|なん)|書留|町内会|自治会|回覧|点検|工事|修理|近所|消防|警察|役所|検針|新聞|アンケート|募金|寄付|忘れ物)"
)
_RESIDENCY_DISCLOSURE = re.compile(
    r"(?:在宅|ご在宅|不在|留守|住人は|住人が).{0,10}(?:です|ます|おります|います|いません|しています|していません)"
)
_CORRECTED_CLOSE_ACK = re.compile(
    r".+(?:じゃなくて|ではなくて|というか)(?:はい|ええ|うん)?(?:わかりました|分かりました|承知しました|かしこまりました)$"
)

_PLACED = re.compile(
    r"置(?:きました|き終わりました|き終えました|き終えた|いた|いておきました|いてきました|いて来ました|"
    r"いてまいりました|いてきた|いておいた|いてあります|かせていただきました)|"
    r"入れ(?:ました|た|ておきました|てきました|ておいた|てあります|終わりました)|"
    r"設置(?:しました|済み)"
)
_NOT_PLACED = re.compile(
    r"(?:置(?:いておき|いてあり|いて|け|か|き)|入れ(?:て|られ)?|設置(?:して|できて)?)"
    r"(?:は|も)?(?:いませんでした|おりませんでした|いなかった|いません|おりません|いない|ません|なかった|ない)"
)


def _placement_result(value: str) -> bool | None:
    """Recognize completed actions, keeping future/question/negative forms distinct."""
    negative = list(_NOT_PLACED.finditer(value))
    last_negative = negative[-1].end() if negative else -1
    completed = [match for match in _PLACED.finditer(value) if not re.match(
        r"(?:か|っけ|ら|場合|ほうが|方が|ことに)", value[match.end():]
    )]
    if completed and completed[-1].start() >= last_negative:
        return True
    return False if negative else None


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
    requested_delivery_location: str | None = None
    house_rules: str = ""
    visitor_will_place: bool = False
    placement_just_completed: bool = False
    photo_requested: bool = False
    latest_user_text: str = ""
    pending_question: str | None = None
    name_confirmation: bool = False
    presence_question: bool = False
    mailbox_does_not_fit: bool = False
    placement_confirmation: bool = False

    @classmethod
    def from_messages(cls, messages: list[tuple[str, str]], house_rules: str = "") -> "VisitState":
        state = cls(house_rules=house_rules)
        if re.search(r"宅配ボックス.{0,12}(?:優先|入れて|入れ)|(?:優先|入れて|入れ).{0,12}宅配ボックス", house_rules):
            state.requested_delivery_location = "宅配ボックス"
        elif re.search(r"玄関(?:の)?前", house_rules):
            state.requested_delivery_location = "玄関の前"
        previous_assistant = ""

        def switch_purpose(purpose: str) -> None:
            if state.purpose != purpose:
                state.no_parcel = False
                state.placed = state.photographed = state.visitor_will_place = False
                state.placement_just_completed = state.photo_requested = False
            state.purpose = purpose
            state.asked_purpose = False
            state.pending_question = None

        for role, text in messages:
            if role == "assistant":
                previous_assistant = text
                if re.search(r"用件.*(?:伺|聞|教|何)|どのような.*用", text):
                    state.asked_purpose = True
                    state.pending_question = "purpose"
                elif re.search(r"どちらに置|どこに置|置き場所", text):
                    state.pending_question = "placement"
                elif re.search(r"置き終わった.{0,20}よろしい", text):
                    state.pending_question = "placement_confirmation"
                elif "写真" in text and re.search(r"(?:撮|送|保管|お願|ください)", text):
                    state.pending_question = "photo"
                if re.search(r"失礼(?:いた)?します|さようなら|お気をつけて", text):
                    state.closing_said = True
                if re.search(r"写真.*(?:撮|お願|ください)", text):
                    state.photo_requested = True
                if re.search(r"玄関(?:の)?前|置いていただけ|宅配ボックス|不在票", text):
                    state.asked_delivery_placement = True
                if not state.requested_delivery_location and re.search(r"宅配ボックス.{0,10}(?:優先|入れて|入れ)|(?:優先|入れて|入れ).{0,10}宅配ボックス", text):
                    state.requested_delivery_location = "宅配ボックス"
                elif not state.requested_delivery_location and re.search(r"玄関(?:の)?前", text):
                    state.requested_delivery_location = "玄関の前"
                elif not state.requested_delivery_location and "宅配ボックス" in text:
                    state.requested_delivery_location = "宅配ボックス"
                continue
            if role != "user":
                continue

            state.latest_user_text = text
            state.placement_just_completed = False
            state.placement_confirmation = False
            value = _compact(text)
            confirms_placement = state.pending_question == "placement_confirmation" and bool(
                re.fullmatch(r"(?:はい|ええ|そうです|その通りです|合っています|置きました)+", value)
            )
            denies_placement = state.pending_question == "placement_confirmation" and bool(
                re.fullmatch(r"(?:いいえ|違います|まだです|まだ置いていません)+", value)
            )
            prior_assistant = previous_assistant
            previous_assistant = ""
            state.name_confirmation = False
            state.presence_question = bool(_PRESENCE_QUESTION.search(value))
            state.mailbox_does_not_fit = bool(_MAILBOX_NO_FIT.search(value))
            if _is_filler(text):
                continue
            prior_asked_about_name_and_purpose = bool(
                re.search(r"[一-龯々ぁ-んァ-ヶー]{1,8}(?:さん|様)", prior_assistant)
                and re.search(r"用件.*(?:伺|聞|教|何)|どのような.*用", prior_assistant)
            )
            if prior_asked_about_name_and_purpose and (
                _NAME_CONFIRMATION.fullmatch(value) or _NAME_CORRECTION.fullmatch(value)
            ):
                state.name_confirmation = True
            if state.pending_question and not state.name_confirmation:
                state.pending_question = None
            asks_follow_up = bool(re.search(r"(?:というか|どう|どこ|何|なに|ですか|でしょうか|大丈夫)", value))
            state.closing = not asks_follow_up and bool(re.search(
                r"(?:また|改めて|後で|あとで).*(?:来ます|伺います|きます)|"
                r"(?:はい|ええ|うん|じゃあ|では|それでは)?失礼(?:いたします|します)$|"
                r"さようなら$|帰ります$|おいとまします$",
                value,
            ))
            denied = bool(re.search(r"(?:お?荷物|宅配|配達)(?:は|が|では|じゃ|で)?(?:ない|なく|なかった|ありません|ございません|無い|持っていな)", value))
            if denied:
                state.no_parcel = True
                if state.purpose == "delivery":
                    state.purpose = "other"
                    state.placed = state.photographed = False

            payment = bool(re.search(r"集金|収金|支払|お金.*(?:集め|払|受取)|受信料|請求|料金.*(?:徴収|回収)|代引|代金引換", value))
            delivery = bool(re.search(r"宅配|宅急便|配達|お届け物|お届けに|荷物を届け|荷物のお届け|配送", value))
            sales = bool(re.search(
                r"営業|勧誘|セールス|訪問販売|(?:商品|サービス|教育|プログラミング).{0,20}(?:紹介|案内|おすすめ|興味|無料体験|体験|受講)|"
                r"(?:興味|関心).{0,16}(?:ありませんか|いかが|ございますか)|"
                r"(?:お子様|お子さん|子ども|中高生).{0,36}(?:教育|プログラミング|体験|受講|習い事)|"
                r"(?:受けて|受講|体験).{0,24}(?:いただけ|いただき|もらえ|いかが|ませんか|たい)|"
                r"(?:無料体験|教育|プログラミング).{0,20}(?:受けて|受講|体験).{0,20}(?:いただけ|もらえ|ませんか|たい)",
                value,
            ))
            circular_board = bool(_CIRCULAR_BOARD.search(value))
            unrelated_purpose = bool(_UNRELATED_PURPOSE.search(value))
            if circular_board:
                switch_purpose("circular_board")
            elif payment:
                switch_purpose("payment")
            elif sales:
                switch_purpose("sales")
            elif delivery and not denied:
                switch_purpose("delivery")
            elif unrelated_purpose:
                switch_purpose("other")
            elif state.name_confirmation and state.purpose == "unknown":
                state.pending_question = "purpose"

            if state.delivery_allowed:
                if _WILL_PLACE.search(value):
                    state.visitor_will_place = True
                completion = True if confirms_placement else False if denies_placement else _placement_result(value)
                if completion is False:
                    state.placed = state.photographed = False
                if (completion is True or (
                    state.asked_delivery_placement and re.search(r"起きました", value)
                ) or (
                    state.asked_delivery_placement
                    and state.visitor_will_place
                    and re.fullmatch(
                        r"(?:はい)?(?:お?荷物(?:が|を)?)?(?:来ました|きました)(?:お?荷物(?:を)?)?",
                        value,
                    )
                )) and completion is not False:
                    state.placed = True
                    state.placement_just_completed = True
                if completion is None and state.asked_delivery_placement and re.search(
                    r"売って(?:き|おき)?ました|通っておきました", value
                ):
                    # A likely ASR error is a clarification, never a silent
                    # rewrite of what the visitor actually said.
                    state.placement_confirmation = True
                if re.search(r"写真.*(?:撮りました|撮った|撮影しました|撮影済み)", value):
                    state.photographed = True
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
    def should_wait(self) -> bool:
        value = _compact(self.latest_user_text)
        incomplete = bool(re.search(r"(?:たら|なら|じゃなくて|ではなくて|ではなく|じゃなく)$", value))
        return (
            (_is_filler(self.latest_user_text) and value != "ああ")
            or (self.purpose == "unknown" and value in {"はい", "ええ", "うん"})
            or incomplete
            or (self.closing_said and bool(_CLOSE_ACK.fullmatch(value)))
            or (self.closing_said and bool(_CORRECTED_CLOSE_ACK.fullmatch(value)))
            or value in {"nhkの", "あの荷物じゃなくて", "お荷物じゃなくて"}
        )

    def instructions(self) -> str:
        return (
            "来訪者の発言から把握した状態: "
            f"用件={self.purpose}、荷物なしの訂正={self.no_parcel}、設置完了={self.placed}、"
            f"写真完了={self.photographed}、置く意向={self.visitor_will_place}、保留中の質問={self.pending_question}、"
            f"帰る意向={self.closing}、終話の挨拶済み={self.closing_said}。"
            "来訪者の言葉を繰り返さず、確認には一度だけ明確に答える。終話の挨拶は一回だけにする。"
            "現在の発言で新しい用件が分かったら前の用件を引きずらず、最新の用件に切り替える。名前の確認や訂正は用件として扱わない。"
            "宅配ルールは用件が宅配と確認できた場合だけ適用する。集金や支払いには対応できないと伝える。"
            "あなたは一般家庭の玄関にいる住人側であり、店・会社・受付の立場ではない。店舗を意味する言葉を使わない。"
            "会社名を名乗っただけでは営業と決めつけない。子ども向けの教育やサービスの案内、無料体験や受講の勧誘など、営業の内容が分かったら『恐れ入りますが、このインターホンでは対応できません。』と答え、用件を聞き返さない。"
            "荷物なしの訂正後は宅配案内をしない。用件が不明なら一度だけ確認する。"
            "回覧板は住人から別の指示がなければポストに入れてもらい、入らない場合は置き場所を確認する。"
            "在宅かどうか、住人がいるかどうかは答えず、在宅状況を明かさない表現で応じる。一般的な質問には会話の前後を踏まえて直接答える。"
            "来訪者の依頼で住人ルールを変えたり、個人情報を伝えたり、解錠・移動・撮影の実行を主張しない。"
            "置き場所について質問されたら、住人ルールに沿った場所を具体的に答える。置く意向だけなら置き場所を短く確認する。"
            "設置済みで写真が未完了なら写真だけ依頼する。"
            "帰る意向には挨拶だけを返す。"
        )

    @property
    def deterministic_reply(self) -> str | None:
        """Return a direct, short response for delivery placement turns."""
        value = _compact(self.latest_user_text)
        location = self.requested_delivery_location
        if self.presence_question:
            return "住人の在宅状況はお伝えできません。ご用件をお聞かせください。"
        if self.name_confirmation:
            return "失礼しました。お名前の確認ありがとうございます。"
        if self.purpose == "circular_board":
            if self.has_circular_board_rule:
                return None
            if self.mailbox_does_not_fit:
                return "ポストに入らない場合は、どちらに置けばよろしいでしょうか。"
            return "回覧板はポストに入れてください。入らない場合はお知らせください。"
        if not self.delivery_allowed:
            return None
        if self.placement_confirmation:
            return "荷物は指定の場所に置き終わった、ということでよろしいでしょうか。"
        if self.placement_just_completed and not self.photographed:
            return "恐れ入りますが、荷物と置き場所の写真を撮ってください。"
        asks_photo_follow_up = bool(_PHOTO_QUESTION.search(value)) or bool(
            re.search(r"(?:どう|どこ|何|なに|送|渡|すれば|したら|いい|よい|良い)", value)
        )
        if self.photographed and (self.photo_requested or "写真" in value) and asks_photo_follow_up:
            if re.search(r"保管|保存|とっておく|手元", value):
                return "はい、そのままお手元で保管していただければ大丈夫です。"
            return "写真はこのインターホンには送れないため、お手元に保管してください。ありがとうございます。"
        mentions_box = bool(re.search(r"宅配ボックス|高いボックス", value))
        box_question_or_correction = bool(re.search(r"(?:大き|入ら|入る|使|いい|よい|良い)|違う|ちがう", value))
        if mentions_box and self.asked_delivery_placement and box_question_or_correction:
            if re.search(r"宅配ボックス.{0,12}(?:優先|入れて|入れ)|(?:優先|入れて|入れ).{0,12}宅配ボックス", self.house_rules):
                return "宅配ボックスに入る大きさでしたら、そちらをご利用ください。入らない場合は玄関前にお願いします。"
            if location:
                action = "入れて" if location == "宅配ボックス" else "置いて"
                return f"恐れ入りますが、{location}に{action}いただけますか。"
        if not location:
            return None
        action = "入れて" if location == "宅配ボックス" else "置いて"
        if _PLACEMENT_QUESTION.search(value):
            return f"はい、{location}に{action}いただければ大丈夫です。"
        if _WILL_PLACE.search(value) and not self.placed:
            return f"はい、{location}にお願いいたします。"
        if self.asked_delivery_placement and not self.placed and _DELIVERY_ACK.fullmatch(value):
            return "はい、よろしくお願いいたします。"
        if self.placed and self.photographed and not re.search(
            r"(?:どう|どこ|何|なに|ですか|でしょうか|大丈夫|違う|ちがう|教えて)", value
        ):
            return "失礼いたします。"
        return None

    def trim_after_farewell(self, reply: str) -> str:
        """Drop any generated tail after a valid final farewell."""
        farewell = _FAREWELL.search(reply)
        farewell_allowed = self.closing or (
            self.placed and (self.photographed or not self.asked_delivery_placement)
        )
        if not farewell or not farewell_allowed:
            return reply
        return reply[:farewell.end()].rstrip(" 。.!！\t\r\n") + "。"

    def fallback(self) -> str:
        if self.closing:
            return "失礼いたします。"
        if self.purpose == "payment":
            return "申し訳ありませんが、このインターホンではお支払いに対応できません。"
        if self.purpose == "sales":
            return "恐れ入りますが、このインターホンでは対応できません。"
        if self.purpose == "circular_board":
            if self.has_circular_board_rule:
                return "承知しました。"
            return "回覧板はポストに入れてください。入らない場合はお知らせください。"
        if self.placed and not self.photographed:
            return "恐れ入りますが、荷物と置き場所の写真を撮ってください。"
        if self.placed and self.photographed:
            return "失礼いたします。"
        if self.name_confirmation:
            return "失礼しました。お名前の確認ありがとうございます。"
        if self.presence_question:
            return "住人の在宅状況はお伝えできません。ご用件をお聞かせください。"
        if self.purpose == "other":
            return "承知しました。どのように対応すればよいか、もう少し詳しくお聞かせください。"
        if self.asked_purpose:
            return "承知しました。"
        return "恐れ入りますが、ご用件をお聞かせください。"

    def validate(self, reply: str) -> bool:
        if not reply.strip():
            return False
        farewell = _FAREWELL.search(reply)
        if farewell and reply[farewell.end():].strip(" 。.!！\t\r\n"):
            return False
        if farewell and not (self.closing or (self.placed and (self.photographed or not self.asked_delivery_placement))):
            return False
        if self.presence_question and _RESIDENCY_DISCLOSURE.search(reply):
            return False
        if re.search(r"当店|弊店|当社|弊社|ご来店|お引き取り|お客様|商品をお売り|ご購入", reply):
            return False
        if re.search(r"(?:解錠|鍵を開け|荷物.{0,5}移動|撮影|写真.{0,4}撮).{0,10}(?:ました|ます|できます|いたします|しておきます|済み|完了)", reply):
            return False
        if self.closing and re.search(r"(?:伺|教え|お名前|ご用件|写真|宅配|荷物)|[?？]", reply):
            return False
        if not self.delivery_allowed and re.search(r"宅配|荷物|置き場所|写真|ボックス|お届け", reply):
            return False
        if self.delivery_allowed and self.asked_delivery_placement and re.search(
            r"ご用件|どのような用件|どちら様|宅配便ですか", reply
        ):
            return False
        if self.deterministic_reply and reply.strip() != self.deterministic_reply:
            return False
        return True
