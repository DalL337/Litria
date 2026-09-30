//! Path syntax accepted by the Project API (contract brief §6).
//!
//! Stricter than `path_guard::validate_relative_path` on purpose. A path that
//! fails here is answered as a per-item `invalidPath` outcome, never as a
//! request error: the request schema declares only the length, so the boundary
//! and the schema keep identical verdicts (ADR-033 decision 3).

/// Windows device names: the segment's stem up to the FIRST dot, trimmed,
/// compared without case. Mirrors `findReservedDeviceSegment` in
/// `src/utils/path.js`, so the frontend and the API agree on which names
/// are unusable on Windows.
fn is_reserved_device_stem(segment: &str) -> bool {
    let stem = segment.trim().split('.').next().unwrap_or("").trim();
    let lower = stem.to_ascii_lowercase();
    match lower.as_str() {
        "con" | "prn" | "aux" | "nul" => true,
        _ => {
            let bytes = lower.as_bytes();
            bytes.len() == 4
                && (lower.starts_with("com") || lower.starts_with("lpt"))
                && (b'1'..=b'9').contains(&bytes[3])
        }
    }
}

/// True when `path` is a forward-slash, project-relative path the API will
/// resolve. Rejects:
/// - backslashes (the canonical form is forward slashes only);
/// - absolute, drive and UNC forms (an empty first segment, or a `:`);
/// - any `:`, which also blocks NTFS alternate data streams (`a.txt:s`);
/// - control characters;
/// - empty, `.` and `..` segments;
/// - a segment ending in a dot or a space, which Windows would silently strip
///   (`.env.` would otherwise open `.env` past the disclosure policy);
/// - Windows reserved device names.
pub(crate) fn is_valid_api_path(path: &str) -> bool {
    if path.is_empty() || path.contains('\\') || path.contains(':') || path.chars().any(char::is_control) {
        return false;
    }
    path.split('/').all(|segment| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && !segment.ends_with('.')
            && !segment.ends_with(' ')
            && !is_reserved_device_stem(segment)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_relative_paths() {
        for path in [
            "README.md",
            "src/main.ts",
            "a/b/c/d.txt",
            ".gitignore",
            ".con",
            "console.log",
            "com10.txt",
            "lpt0.md",
            "dir with spaces/file name.txt",
            "unicode/😀.md",
            "a?b",
        ] {
            assert!(is_valid_api_path(path), "{path} should be accepted");
        }
    }

    #[test]
    fn rejects_everything_the_brief_lists() {
        for path in [
            "",
            "src\\main.ts",
            "/etc/passwd",
            "C:/Windows/win.ini",
            "C:relative",
            "//server/share/file",
            "a.txt:stream",
            "notes.md:$DATA",
            "a//b",
            "a/",
            "./a",
            "a/./b",
            "../outside",
            "a/../../b",
            "trailing.",
            ".env.",
            "trailing ",
            "dir./file",
            "con",
            "CON.txt",
            "src/nul.py",
            "Com1",
            "lpt9.log",
            " aux .js",
            "tab\there",
            "nul\u{0}byte",
            "line\nbreak",
            "del\u{7f}",
        ] {
            assert!(!is_valid_api_path(path), "{path:?} should be rejected");
        }
    }
}
