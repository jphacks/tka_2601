//! Python-compatible regular expressions and string helpers.
//!
//! The rules were written for Python's `re` on `str` patterns. [`PyRegex`] accepts the
//! Python pattern text unchanged and rewrites the few constructs whose meaning differs in
//! `fancy-regex`:
//!
//! * `$` (without MULTILINE) also matches before one trailing `\n` -> `(?=\n?\z)`.
//! * `\s` is `str.isspace()`, which adds U+001C..U+001F to Unicode `White_Space`.
//! * `\b` uses Python's `\w` (`str.isalnum()` or `_`), i.e. `[\p{L}\p{N}_]`.
//! * `\uXXXX` escapes become `\x{XXXX}`.
//!
//! All indices exposed by this module are code-point indices (Python `str` indices).

use std::sync::OnceLock;

use fancy_regex::{Captures, Regex};
use unicode_normalization::UnicodeNormalization;

const PY_SPACE_CLASS_BODY: &str = r"\s\x{1c}-\x{1f}";
const PY_WORD_CLASS: &str = r"[\p{L}\p{N}_]";

fn translate(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len() + 16);
    let mut in_class = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            let n = chars[i + 1];
            match n {
                's' => {
                    if in_class {
                        out.push_str(PY_SPACE_CLASS_BODY);
                    } else {
                        out.push('[');
                        out.push_str(PY_SPACE_CLASS_BODY);
                        out.push(']');
                    }
                    i += 2;
                }
                'b' if !in_class => {
                    out.push_str(&format!(
                        "(?:(?<!{w})(?={w})|(?<={w})(?!{w}))",
                        w = PY_WORD_CLASS
                    ));
                    i += 2;
                }
                'u' if i + 6 <= chars.len() => {
                    let hex: String = chars[i + 2..i + 6].iter().collect();
                    out.push_str(&format!("\\x{{{hex}}}"));
                    i += 6;
                }
                _ => {
                    out.push(c);
                    out.push(n);
                    i += 2;
                }
            }
            continue;
        }
        if in_class {
            match c {
                ']' => {
                    in_class = false;
                    out.push(c);
                }
                // Python treats these as literals inside a class; the regex crate reads
                // `[` as a nested class and `&&`, `--`, `~~` as set operations.
                '[' | '&' | '~' => {
                    out.push('\\');
                    out.push(c);
                }
                '-' if i + 1 < chars.len() && chars[i + 1] == '-' => out.push_str("\\-"),
                _ => out.push(c),
            }
            i += 1;
            continue;
        }
        match c {
            '[' => {
                in_class = true;
                out.push(c);
                i += 1;
                // A leading `^` and a leading `]` are literal parts of the class syntax.
                if i < chars.len() && chars[i] == '^' {
                    out.push('^');
                    i += 1;
                }
                if i < chars.len() && chars[i] == ']' {
                    out.push_str("\\]");
                    i += 1;
                }
            }
            '$' => {
                out.push_str("(?=\\n?\\z)");
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// A Python `re` pattern compiled lazily for `search`, `match` and `fullmatch`.
pub struct PyRegex {
    source: String,
    search: OnceLock<Regex>,
    prefix: OnceLock<Regex>,
    full: OnceLock<Regex>,
}

/// A match with code-point offsets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PyMatch {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

fn compile(source: &str) -> Regex {
    Regex::new(source).unwrap_or_else(|error| panic!("invalid pattern {source:?}: {error}"))
}

fn char_index(text: &str, byte: usize) -> usize {
    text[..byte].chars().count()
}

impl PyRegex {
    pub fn new(pattern: &str) -> Self {
        Self::with_flags(pattern, "")
    }

    /// `flags` is an inline flag group body such as `"i"` for `re.IGNORECASE`.
    pub fn with_flags(pattern: &str, flags: &str) -> Self {
        let translated = translate(pattern);
        let source = if flags.is_empty() {
            translated
        } else {
            format!("(?{flags}){translated}")
        };
        Self {
            source,
            search: OnceLock::new(),
            prefix: OnceLock::new(),
            full: OnceLock::new(),
        }
    }

    fn search_re(&self) -> &Regex {
        self.search.get_or_init(|| compile(&self.source))
    }

    fn prefix_re(&self) -> &Regex {
        self.prefix
            .get_or_init(|| compile(&format!("\\A(?:{})", self.source)))
    }

    fn full_re(&self) -> &Regex {
        self.full
            .get_or_init(|| compile(&format!("\\A(?:{})\\z", self.source)))
    }

    /// `re.search(...)` is not None.
    pub fn is_match(&self, text: &str) -> bool {
        self.search_re()
            .is_match(text)
            .expect("regex backtrack limit")
    }

    /// `re.search(...)`.
    pub fn search(&self, text: &str) -> Option<PyMatch> {
        self.search_re()
            .find(text)
            .expect("regex backtrack limit")
            .map(|m| to_match(text, m.start(), m.end()))
    }

    /// `re.match(...)` is not None.
    pub fn is_prefix_match(&self, text: &str) -> bool {
        self.prefix_re()
            .is_match(text)
            .expect("regex backtrack limit")
    }

    /// `re.fullmatch(...)` is not None.
    pub fn is_full_match(&self, text: &str) -> bool {
        self.full_re()
            .is_match(text)
            .expect("regex backtrack limit")
    }

    /// `re.finditer(...)` as code-point spans.
    pub fn find_iter(&self, text: &str) -> Vec<PyMatch> {
        self.search_re()
            .find_iter(text)
            .map(|m| {
                let m = m.expect("regex backtrack limit");
                to_match(text, m.start(), m.end())
            })
            .collect()
    }

    /// `re.search(...)` with captures; the closure receives the raw captures.
    pub fn captures<'t>(&self, text: &'t str) -> Option<Captures<'t>> {
        self.search_re()
            .captures(text)
            .expect("regex backtrack limit")
    }

    /// `re.finditer(...)` returning captures with code-point offsets of the whole match.
    pub fn captures_iter<'t>(&self, text: &'t str) -> Vec<(usize, Captures<'t>)> {
        self.search_re()
            .captures_iter(text)
            .map(|caps| {
                let caps = caps.expect("regex backtrack limit");
                let start = char_index(text, caps.get(0).expect("group 0").start());
                (start, caps)
            })
            .collect()
    }

    /// `re.sub(pattern, replacement, text)` with a literal replacement.
    pub fn sub(&self, replacement: &str, text: &str) -> String {
        self.search_re()
            .replace_all(text, fancy_regex::NoExpand(replacement))
            .into_owned()
    }
}

fn to_match(text: &str, start: usize, end: usize) -> PyMatch {
    PyMatch {
        start: char_index(text, start),
        end: char_index(text, end),
        text: text[start..end].to_string(),
    }
}

/// Declare a lazily compiled Python pattern: `py_regex!(NAME, r"..." [, r"..."]*)`.
#[macro_export]
#[doc(hidden)]
macro_rules! py_regex {
    ($vis:vis $name:ident, flags = $flags:expr, $($part:expr),+ $(,)?) => {
        $vis static $name: std::sync::LazyLock<$crate::pyre::PyRegex> =
            std::sync::LazyLock::new(|| $crate::pyre::PyRegex::with_flags(concat!($($part),+), $flags));
    };
    ($vis:vis $name:ident, $($part:expr),+ $(,)?) => {
        $vis static $name: std::sync::LazyLock<$crate::pyre::PyRegex> =
            std::sync::LazyLock::new(|| $crate::pyre::PyRegex::new(concat!($($part),+)));
    };
}

/// `str.isspace()` for one character.
pub fn py_isspace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | '\u{1c}'..='\u{20}'
            | '\u{85}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
    )
}

/// `str.strip()`.
pub fn py_strip(text: &str) -> &str {
    text.trim_matches(py_isspace)
}

/// `str.strip(chars)`.
pub fn py_strip_chars<'a>(text: &'a str, chars: &str) -> &'a str {
    text.trim_matches(|c| chars.contains(c))
}

/// `str.rstrip(chars)`.
pub fn py_rstrip_chars<'a>(text: &'a str, chars: &str) -> &'a str {
    text.trim_end_matches(|c| chars.contains(c))
}

/// `unicodedata.normalize("NFKC", text)`.
pub fn nfkc(text: &str) -> String {
    text.nfkc().collect()
}

/// `str.casefold()`.
pub fn casefold(text: &str) -> String {
    caseless::default_case_fold_str(text)
}

/// Number of code points (`len(str)`).
pub fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// `text[start:end]` with code-point indices clamped like Python slices (non-negative only).
pub fn slice(text: &str, start: usize, end: usize) -> String {
    if end <= start {
        return String::new();
    }
    text.chars().skip(start).take(end - start).collect()
}

/// `text[:n]`.
pub fn prefix(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// `text[-n:]`.
pub fn suffix(text: &str, n: usize) -> String {
    let len = char_len(text);
    slice(text, len.saturating_sub(n), len)
}

/// `text[start:]`.
pub fn from(text: &str, start: usize) -> String {
    text.chars().skip(start).collect()
}

/// `haystack.find(needle, start)` with code-point indices; `None` for -1.
pub fn find_from(haystack: &[char], needle: &[char], start: usize) -> Option<usize> {
    if needle.is_empty() {
        return (start <= haystack.len()).then_some(start);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    (start..=haystack.len() - needle.len()).find(|&i| haystack[i..i + needle.len()] == *needle)
}

/// `haystack.rfind(needle, 0, end)` with code-point indices; `None` for -1.
pub fn rfind_before(haystack: &[char], needle: &[char], end: usize) -> Option<usize> {
    let end = end.min(haystack.len());
    if needle.len() > end {
        return None;
    }
    (0..=end - needle.len())
        .rev()
        .find(|&i| haystack[i..i + needle.len()] == *needle)
}

const DECIMAL_ZEROS: [u32; 68] = [
    0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66,
    0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90,
    0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10,
    0x104a0, 0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650,
    0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50, 0x11da0, 0x11f50, 0x16a60, 0x16ac0,
    0x16b50, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e950,
    0x1fbf0,
];

/// `unicodedata.decimal(c)` (Unicode 15.0, as in the Python 3.12 runtime).
pub fn decimal_value(c: char) -> Option<u32> {
    let code = c as u32;
    DECIMAL_ZEROS
        .iter()
        .rev()
        .find(|&&zero| zero <= code)
        .and_then(|&zero| (code - zero < 10).then_some(code - zero))
}

/// `int(text)` for a string of decimal digits matched by `\d`.
pub fn py_int(text: &str) -> u32 {
    text.chars().fold(0, |value, c| {
        value * 10 + decimal_value(c).unwrap_or_else(|| panic!("not a decimal digit: {c:?}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dollar_matches_before_a_trailing_newline() {
        let re = PyRegex::new("さん$");
        assert!(re.is_match("山田さん"));
        assert!(re.is_match("山田さん\n"));
        assert!(!re.is_match("山田さん\n\n"));
        assert!(re.is_full_match("さん"));
    }

    #[test]
    fn python_space_includes_information_separators() {
        let re = PyRegex::new(r"a\sb");
        assert!(re.is_match("a\u{1f}b"));
        assert!(re.is_match("a\u{3000}b"));
        let class = PyRegex::new(r"a[\s、]b");
        assert!(class.is_match("a\u{1c}b"));
    }

    #[test]
    fn unicode_escapes_and_word_boundaries() {
        assert!(PyRegex::new(r"[㐀-䶿]").is_match("\u{3400}"));
        let re = PyRegex::with_flags(r"\btool\b", "i");
        assert!(re.is_match("a TOOL: x"));
        assert!(!re.is_match("atool"));
    }

    #[test]
    fn decimal_values_follow_python() {
        assert_eq!(py_int("12"), 12);
        assert_eq!(py_int("\u{0661}\u{0662}"), 12);
        assert_eq!(decimal_value('a'), None);
    }

    #[test]
    fn strip_matches_python() {
        assert_eq!(py_strip("\u{1f} 山田\u{3000}"), "山田");
        assert_eq!(py_rstrip_chars("失礼します。！", " 。.!！"), "失礼します");
    }
}
