import re
import unicodedata
from . import tool_schema as reception_text_policy

_NAME_TOKEN = r"(?P<name>[\u3400-\u4DBF\u4E00-\u9FFF々ぁ-んァ-ヶー]{1,8})"
_NAME_ENDING = r"(?:さん|様)?(?:でございます|と申します|といいます|本人です|です|でした|でお願いします|ですが)"
_NAME_PATTERNS = [
    re.compile(r"(?:予約者名|予約名|予約者|お名前|名前|氏名|名義)(?:は|が|:|：)?" + _NAME_TOKEN + _NAME_ENDING),
    re.compile(r"(?:正しくは|正しく言うと|本当は|実際は)" + _NAME_TOKEN + _NAME_ENDING),
    re.compile(
        r"(?:予約(?:を)?(?:お願いし(?:た|て)|取(?:った|りました)|入れ(?:た|ました)|"
        r"して(?:いた|いる|います|いました|ます)|した|をした)|来店した)(?:のは|者は)?"
        + _NAME_TOKEN + _NAME_ENDING
    ),
    re.compile(r"(?:私|わたし|僕|ぼく|本人)(?:は|が)" + _NAME_TOKEN + _NAME_ENDING),
    re.compile(r"(?:^|[。．、,，\s])" + _NAME_TOKEN + _NAME_ENDING),
]
_APPOINTMENT_TIME = re.compile(
    r"(?<!\d)(?:[01]?\d|2[0-3])(?::[0-5]\d|時(?:半|[0-5]?\d分?)?)(?!\d)"
)


def extract_self_identified_name(user_history):
    text = unicodedata.normalize("NFKC", user_history or "")
    matches = [match for pattern in _NAME_PATTERNS for match in pattern.finditer(text)]
    for match in sorted(matches, key=lambda item: item.start(), reverse=True):
        candidate = match.group("name")
        if reception_text_policy.customer_name_is_self_identified(text, candidate):
            return candidate
    return None


def extract_exact_appointment_time(user_history):
    text = unicodedata.normalize("NFKC", user_history or "")
    matches = list(_APPOINTMENT_TIME.finditer(text))
    if not matches:
        return None
    match = matches[-1]
    nearby = text[max(0, match.start() - 4):match.start()] + text[match.end():match.end() + 4]
    if re.search(r"(頃|ころ|くらい|ぐらい|前後)", nearby):
        return None
    raw = match.group()
    if ":" in raw:
        hour_text, minute_text = raw.split(":", 1)
        hour, minute = int(hour_text), int(minute_text)
    else:
        hour_text, rest = raw.split("時", 1)
        hour = int(hour_text)
        if rest.startswith("半"):
            minute = 30
        else:
            minute = int(rest.removesuffix("分")) if rest.removesuffix("分") else 0
    prefix = text[max(0, match.start() - 5):match.start()]
    if "午後" in prefix:
        hour = 12 if hour in {0, 12} else hour + 12
    elif "午前" in prefix and hour == 12:
        hour = 0
    return f"{hour:02d}:{minute:02d}"


_THIRD_PARTY_APPOINTMENT = re.compile(
    r"(?:娘|息子|子ども|子供|母|父|妻|夫|姉|兄|妹|弟|友人|友達|同伴者|家族|お母さん|お父さん|お連れ様).{0,12}予約"
)
_ARRIVAL_TIME_CONTEXT = re.compile(r"(?:到着|着(?:い|き)まし|来店|来た|着いた|早く来|早めに来)")
_APPOINTMENT_TIME_LEFT = re.compile(r"予約.{0,14}$")
_APPOINTMENT_TIME_RIGHT = re.compile(r"^(?:に|の)?予約")


def extract_explicit_appointment_time(user_history):
    """Return a time explicitly tied to the visitor's own reservation, if unambiguous."""
    text = unicodedata.normalize("NFKC", user_history or "")
    matches = list(_APPOINTMENT_TIME.finditer(text))
    candidates = []
    classified = {}
    for index, match in enumerate(matches):
        sentence_start = max(
            (text.rfind(mark, 0, match.start()) for mark in "。．！？!?\n"),
            default=-1,
        ) + 1
        sentence_end_candidates = [
            position for mark in "。．！？!?\n"
            if (position := text.find(mark, match.end())) >= 0
        ]
        sentence_end = min(sentence_end_candidates, default=len(text))
        sentence = text[sentence_start:sentence_end]
        before = text[sentence_start:match.start()]
        after = text[match.end():sentence_end]
        left_reservation = before.rfind("予約")
        arrival_positions = [
            before.rfind(cue)
            for cue in ("到着", "着いた", "着きました", "来店", "来た", "早く来", "早めに来")
        ]
        left_arrival = max(arrival_positions, default=-1)
        immediate_arrival = bool(
            re.match(r"^\s*(?:に)?(?:到着|着いた|来店|着きました|来ました)", after)
        )
        right_reservation = bool(_APPOINTMENT_TIME_RIGHT.search(after[:14]))
        if immediate_arrival or left_arrival > left_reservation:
            classified[index] = "arrival"
            continue
        if left_reservation < 0 and not right_reservation:
            classified[index] = "arrival" if left_arrival >= 0 else "other"
            continue

        match_start_in_sentence = match.start() - sentence_start
        reservation_positions = [
            found.start() for found in re.finditer("予約", sentence)
            if abs(found.start() - match_start_in_sentence) <= 20
        ]
        if reservation_positions:
            reservation_pos = min(
                reservation_positions,
                key=lambda position: abs(position - match_start_in_sentence),
            )
            subject_prefix = sentence[max(0, reservation_pos - 16):reservation_pos]
            reservation_subject = subject_prefix + "予約"
        else:
            reservation_subject = before[-16:] + "予約"
        if _THIRD_PARTY_APPOINTMENT.search(reservation_subject):
            classified[index] = "third_party"
            continue

        raw = match.group()
        if ":" in raw:
            hour_text, minute_text = raw.split(":", 1)
            hour, minute = int(hour_text), int(minute_text)
        else:
            hour_text, rest = raw.split("時", 1)
            hour = int(hour_text)
            minute = 30 if rest.startswith("半") else int(rest.removesuffix("分")) if rest.removesuffix("分") else 0
        prefix = text[max(sentence_start, match.start() - 5):match.start()]
        if "午後" in prefix:
            hour = 12 if hour in {0, 12} else hour + 12
        elif "午前" in prefix and hour == 12:
            hour = 0
        candidates.append((index, f"{hour:02d}:{minute:02d}"))
        classified[index] = "appointment"

    if not candidates:
        return None
    last_index, value = candidates[-1]
    if any(classified.get(index) == "other" for index in range(last_index + 1, len(matches))):
        return None
    if len(candidates) > 1:
        previous_index = candidates[-2][0]
        previous_end = matches[previous_index].end()
        latest_start = matches[last_index].start()
        changed_explicitly = bool(
            re.search(r"(?:訂正|修正|正しくは|ではなく|間違|変更|実際は|最終的には)", text[previous_end:matches[last_index].end() + 16])
        )
        if candidates[-2][1] != value and not changed_explicitly:
            return None
    return value



def has_unresolved_clock_fragment(user_message):
    text = unicodedata.normalize("NFKC", user_message or "")
    fragments = list(re.finditer(r"(?<!\d)(?:[01]?\d|2[0-3])(?:で|手)\s*[0-9一二三四五六七八九十]+", text))
    if not fragments:
        return False
    # A later explicit correction supersedes the malformed fragment.
    return extract_exact_appointment_time(text[fragments[-1].end():]) is None
