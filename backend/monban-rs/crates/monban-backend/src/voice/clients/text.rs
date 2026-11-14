//! TTS text helpers.
//!
//! * [`MarkdownFilter`] / [`filter_emoji`] / [`TtsTextFilter`]: livekit-agents'
//!   `filter_markdown` and `filter_emoji` (`voice/transcription/filters.py`), the default
//!   `tts_text_transforms`, applied in that order to the streamed LLM text.
//! * [`split_sentences`] and [`trim_delayed_audio_tail`]: `speech_tts.py`'s
//!   `_split_sentences` and `_trim_delayed_audio_tail`.
//!
//! Python's `re` classes are spelled out so the patterns match the same characters:
//! `\w` is exactly `[\p{L}\p{N}_]` and `\s` is `str.isspace()`, which adds U+001C..U+001F
//! to Unicode `White_Space` (checked against CPython 3.12 / Unicode 15.0).

use std::sync::LazyLock;

use fancy_regex::Regex;

/// Python `\s`.
const PY_S: &str = r"[\s\x1c-\x1f]";
/// Python `\S`.
const PY_NOT_S: &str = r"[^\s\x1c-\x1f]";
/// Python `\w`.
const PY_W: &str = r"[\p{L}\p{N}_]";
/// Scripts whose emphasis delimiters sit flush against a word character.
const FLUSH_EMPHASIS_SCRIPTS: &str = concat!(
    r"\x{0e00}-\x{0e7f}",
    r"\x{1100}-\x{11ff}",
    r"\x{3040}-\x{30ff}",
    r"\x{3130}-\x{318f}",
    r"\x{3400}-\x{4dbf}",
    r"\x{4e00}-\x{9fff}",
    r"\x{ac00}-\x{d7af}",
    r"\x{f900}-\x{faff}",
    r"\x{ff66}-\x{ff9d}",
);

fn intraword() -> String {
    // Python: [^\W<scripts>] — a word character outside the flush scripts.
    format!(r"[\p{{L}}\p{{N}}_&&[^{FLUSH_EMPHASIS_SCRIPTS}]]")
}

fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|error| panic!("invalid pattern {pattern}: {error}"))
}

static ASTERISK_EMPHASIS: LazyLock<Regex> = LazyLock::new(|| {
    let iw = intraword();
    compile(&format!(
        r"(?<!{iw})(?<!\*)(\*{{1,3}})(?!{PY_S})([^*\n]+?)(?<!{PY_S})\1(?!{iw})(?!\*)"
    ))
});
static UNDERSCORE_EMPHASIS: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(r"(?<!{PY_W})(_{{1,3}})(?!{PY_S})([^_\n]+?)(?<!{PY_S})\1(?!{PY_W})"))
});
static LINE_PATTERNS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        compile(&format!(r"(?m)^#{{1,6}}{PY_S}+")),
        compile(&format!(r"(?m)^{PY_S}*[-+*]{PY_S}+")),
        compile(&format!(r"(?m)^{PY_S}*>{PY_S}+")),
    ]
});
static FULL_LINE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    compile(r"(?m)^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$")
});
static IMAGE: LazyLock<Regex> = LazyLock::new(|| compile(r"!\[([^\]]*)\]\([^)]*\)"));
static LINK: LazyLock<Regex> = LazyLock::new(|| compile(r"\[([^\]]*)\]\([^)]*\)"));
static CODE_FENCE: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r"`{{3,4}}{PY_NOT_S}*")));
static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| compile(r"`([^`]+?)`"));
static STRIKETHROUGH: LazyLock<Regex> =
    LazyLock::new(|| compile(&format!(r"~~(?!{PY_S})[^~]*?(?<!{PY_S})~~")));
static ASTERISK_OPENER: LazyLock<Regex> = LazyLock::new(|| {
    let iw = intraword();
    compile(&format!(r"(?<!{iw})(?<!\*)\*{{1,3}}(?![\s\x1c-\x1f*])"))
});
static UNDERSCORE_OPENER: LazyLock<Regex> =
    LazyLock::new(|| compile(&format!(r"(?<!{PY_W})_{{1,3}}(?![\s\x1c-\x1f_])")));
/// Python's non-multiline `$` matches at the end or before a final newline.
static PENDING_LINK: LazyLock<Regex> = LazyLock::new(|| compile(r"\[[^\]]*(?:\]|\]\([^)]*)?(?=\n?\z)"));

const INLINE_SPLIT_TOKENS: &[char] = &[' ', ',', '.', '?', '!', ';', '，', '。', '？', '！', '；'];
const INLINE_MARKERS: &[char] = &['*', '_', '`', '~', '['];
const INCOMPLETE_ENDINGS: &[char] = &['#', '-', '+', '*', '_', '>', '!', '`', '~', ' '];

/// `re.sub(pattern, replacement, text)`. A pattern that exceeds fancy-regex's backtracking
/// limit leaves the text unchanged instead of panicking.
fn sub(pattern: &Regex, replacement: &str, text: &str) -> String {
    match pattern.try_replacen(text, 0, replacement) {
        Ok(result) => result.into_owned(),
        Err(error) => {
            tracing::warn!("markdown filter pattern failed: {error}");
            text.to_string()
        }
    }
}

fn search(pattern: &Regex, text: &str) -> bool {
    pattern.is_match(text).unwrap_or(false)
}

fn strip_emphasis(text: &str) -> String {
    let text = sub(&ASTERISK_EMPHASIS, "${2}", text);
    let text = sub(&UNDERSCORE_EMPHASIS, "${2}", &text);
    sub(&ASTERISK_EMPHASIS, "${2}", &text)
}

fn pending_emphasis(buffer: &str) -> bool {
    let buffer = strip_emphasis(buffer);
    search(&ASTERISK_OPENER, &buffer) || search(&UNDERSCORE_OPENER, &buffer)
}

fn has_incomplete_pattern(buffer: &str) -> bool {
    if buffer.ends_with(INCOMPLETE_ENDINGS) {
        return true;
    }
    if pending_emphasis(buffer) {
        return true;
    }
    if buffer.matches('`').count() % 2 == 1 || buffer.matches("~~").count() % 2 == 1 {
        return true;
    }
    search(&PENDING_LINK, buffer)
}

fn process_complete_text(text: &str, is_newline: bool, is_line_end: bool) -> String {
    let mut text = text.to_string();
    if is_newline {
        if is_line_end {
            text = sub(&FULL_LINE_PATTERN, "", &text);
        }
        for pattern in LINE_PATTERNS.iter() {
            text = sub(pattern, "", &text);
        }
    }
    if !text.contains(INLINE_MARKERS) {
        return text;
    }
    text = sub(&IMAGE, "${1}", &text);
    text = sub(&LINK, "${1}", &text);
    text = strip_emphasis(&text);
    text = sub(&CODE_FENCE, "", &text);
    text = sub(&INLINE_CODE, "${1}", &text);
    sub(&STRIKETHROUGH, "", &text)
}

/// livekit-agents' streaming `filter_markdown`: feed the LLM text chunk by chunk with
/// [`push`](Self::push), then call [`finish`](Self::finish). The outputs are the chunks the
/// Python async generator yields, empty ones included.
#[derive(Debug, Clone)]
pub struct MarkdownFilter {
    buffer: String,
    buffer_is_newline: bool,
}

impl Default for MarkdownFilter {
    fn default() -> Self {
        Self { buffer: String::new(), buffer_is_newline: true }
    }
}

impl MarkdownFilter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        let mut out = Vec::new();
        if self.buffer.contains('\n') {
            let buffer = std::mem::take(&mut self.buffer);
            let mut lines: Vec<&str> = buffer.split('\n').collect();
            let last = lines.pop().unwrap_or_default();
            for (index, line) in lines.into_iter().enumerate() {
                let is_newline = if index == 0 { self.buffer_is_newline } else { true };
                let mut processed = process_complete_text(line, is_newline, true);
                processed.push('\n');
                out.push(processed);
            }
            self.buffer = last.to_string();
            self.buffer_is_newline = true;
            return out;
        }
        // Python: max(map(buffer.rfind, INLINE_SPLIT_TOKENS)) >= 1. Byte offsets order the
        // same way as code point offsets, and offset 0 is the same in both.
        let last_split = INLINE_SPLIT_TOKENS.iter().filter_map(|token| self.buffer.rfind(*token)).max();
        if let Some(position) = last_split.filter(|position| *position >= 1) {
            let processable = &self.buffer[..position];
            if !has_incomplete_pattern(processable) {
                out.push(process_complete_text(processable, self.buffer_is_newline, false));
                self.buffer = self.buffer[position..].to_string();
                self.buffer_is_newline = false;
            }
        }
        out
    }

    /// The final output once the LLM stream has ended.
    pub fn finish(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            return None;
        }
        let buffer = std::mem::take(&mut self.buffer);
        Some(process_complete_text(&buffer, self.buffer_is_newline, true))
    }
}

fn is_emoji(c: char) -> bool {
    matches!(
        c as u32,
        0x1F000..=0x1FBFF
            | 0x2600..=0x26FF
            | 0x2700..=0x27BF
            | 0x2B00..=0x2BFF
            | 0xFE00..=0xFE0F
            | 0x200D
            | 0x20E3
    )
}

/// livekit-agents' `filter_emoji` for one chunk (`EMOJI_PATTERN.sub("", chunk)`).
pub fn filter_emoji(text: &str) -> String {
    text.chars().filter(|c| !is_emoji(*c)).collect()
}

/// The default `tts_text_transforms` (`filter_markdown`, then `filter_emoji`) over a
/// streamed text.
#[derive(Debug, Clone, Default)]
pub struct TtsTextFilter {
    markdown: MarkdownFilter,
}

impl TtsTextFilter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.markdown.push(chunk).iter().map(|text| filter_emoji(text)).collect()
    }

    pub fn finish(&mut self) -> Option<String> {
        self.markdown.finish().map(|text| filter_emoji(&text))
    }
}

/// The TTS input for a reply streamed as `chunks` (all outputs of [`TtsTextFilter`] joined).
pub fn tts_text<'a>(chunks: impl IntoIterator<Item = &'a str>) -> String {
    let mut filter = TtsTextFilter::new();
    let mut out = String::new();
    for chunk in chunks {
        for piece in filter.push(chunk) {
            out.push_str(&piece);
        }
    }
    if let Some(piece) = filter.finish() {
        out.push_str(&piece);
    }
    out
}

/// Python `str.isspace()`.
pub(crate) fn py_isspace(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// Python `str.strip()`.
pub(crate) fn py_strip(text: &str) -> &str {
    text.trim_matches(py_isspace)
}

const SENTENCE_ENDINGS: &[char] = &['。', '！', '？', '!', '?'];
const SENTENCE_CLOSERS: &[char] = &['」', '』', '】', '）', '》', ')', ']', '}'];

/// `speech_tts._split_sentences`: split after each run of sentence endings (and the closing
/// brackets right after it), stripping each sentence and dropping empty ones.
pub fn split_sentences(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let slice = |start: usize, end: usize| chars[start..end].iter().collect::<String>();
    let mut sentences = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < chars.len() {
        if !SENTENCE_ENDINGS.contains(&chars[index]) {
            index += 1;
            continue;
        }
        let mut end = index + 1;
        while end < chars.len() && SENTENCE_ENDINGS.contains(&chars[end]) {
            end += 1;
        }
        while end < chars.len() && SENTENCE_CLOSERS.contains(&chars[end]) {
            end += 1;
        }
        let sentence = slice(start, end);
        let sentence = py_strip(&sentence);
        if !sentence.is_empty() {
            sentences.push(sentence.to_string());
        }
        start = end;
        index = end;
    }
    let remainder = slice(start, chars.len());
    let remainder = py_strip(&remainder);
    if !remainder.is_empty() {
        sentences.push(remainder.to_string());
    }
    sentences
}

/// `len(re.findall(r"[。！？!?]+", text))`.
fn sentence_ending_runs(text: &str) -> usize {
    let mut runs = 0;
    let mut in_run = false;
    for c in text.chars() {
        let ending = SENTENCE_ENDINGS.contains(&c);
        if ending && !in_run {
            runs += 1;
        }
        in_run = ending;
    }
    runs
}

/// `speech_tts._trim_delayed_audio_tail`: cut audio (mono s16le) that resumes after a pause
/// of at least 1 s, keeping 180 ms of the pause. Never trims a reply with more than one
/// sentence ending. The result is always a prefix of `pcm`.
pub fn trim_delayed_audio_tail<'a>(pcm: &'a [u8], sample_rate: u32, text: &str) -> &'a [u8] {
    if sentence_ending_runs(text) > 1 {
        return pcm;
    }
    let frame_samples = (sample_rate as usize / 50).max(1);
    let frame_bytes = frame_samples * 2;
    let complete_bytes = pcm.len() - pcm.len() % frame_bytes;
    if complete_bytes < frame_bytes * 4 {
        return pcm;
    }
    let levels: Vec<f64> = pcm[..complete_bytes]
        .chunks_exact(frame_bytes)
        .map(|frame| {
            let sum: i64 = frame
                .chunks_exact(2)
                .map(|sample| {
                    let value = i64::from(i16::from_le_bytes([sample[0], sample[1]]));
                    value * value
                })
                .sum();
            // Exact: the sum stays far below 2^53.
            (sum as f64 / frame_samples as f64).sqrt()
        })
        .collect();
    let loudest = levels.iter().copied().fold(0.0_f64, f64::max);
    let threshold = f64::max(32.0, loudest * 0.006);
    let active: Vec<bool> = levels.iter().map(|level| *level >= threshold).collect();
    let silence_frames = (1.0 * f64::from(sample_rate) / frame_samples as f64) as usize;
    let Some(last_active) = active.iter().rposition(|is_active| *is_active) else {
        return pcm;
    };

    let mut index = 0;
    while index < last_active {
        if active[index] {
            index += 1;
            continue;
        }
        let gap_start = index;
        while index <= last_active && !active[index] {
            index += 1;
        }
        if index - gap_start >= silence_frames {
            let keep_frames = (0.18 * f64::from(sample_rate) / frame_samples as f64) as usize;
            let cutoff = complete_bytes.min((gap_start + keep_frames) * frame_bytes);
            return &pcm[..cutoff - cutoff % 2];
        }
    }
    pcm
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_compile() {
        for pattern in [
            &*ASTERISK_EMPHASIS,
            &*UNDERSCORE_EMPHASIS,
            &*FULL_LINE_PATTERN,
            &*IMAGE,
            &*LINK,
            &*CODE_FENCE,
            &*INLINE_CODE,
            &*STRIKETHROUGH,
            &*ASTERISK_OPENER,
            &*UNDERSCORE_OPENER,
            &*PENDING_LINK,
        ] {
            assert!(pattern.is_match("").is_ok());
        }
        assert_eq!(LINE_PATTERNS.len(), 3);
    }

    #[test]
    fn intraword_excludes_flush_scripts() {
        let pattern = compile(&format!("^{}$", intraword()));
        assert!(pattern.is_match("a").unwrap());
        assert!(pattern.is_match("Ａ").unwrap());
        assert!(!pattern.is_match("あ").unwrap());
        assert!(!pattern.is_match("漢").unwrap());
        assert!(!pattern.is_match("*").unwrap());
    }

    #[test]
    fn markdown_emphasis_next_to_kana_is_removed() {
        assert_eq!(tts_text(["**重要**：荷物は*玄関前*に"]), "重要：荷物は玄関前に");
        assert_eq!(tts_text(["abc*def*ghi"]), "abc*def*ghi");
    }

    #[test]
    fn emoji_are_dropped() {
        assert_eq!(filter_emoji("絵文字😀と❤️です"), "絵文字とです");
    }

    #[test]
    fn sentences_split_after_endings_and_closers() {
        assert_eq!(
            split_sentences("「こんにちは。」と言いました。（はい！）続き"),
            vec!["「こんにちは。」", "と言いました。", "（はい！）", "続き"]
        );
        assert!(split_sentences(" \u{1c} ").is_empty());
    }

    #[test]
    fn trim_keeps_short_audio() {
        let pcm = vec![0u8; 100];
        assert_eq!(trim_delayed_audio_tail(&pcm, 16000, "").len(), 100);
    }
}
