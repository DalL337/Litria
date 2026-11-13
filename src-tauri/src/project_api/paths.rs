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

/// A segment shaped like a Windows 8.3 short name: `BASE` or `BASE.EXT`, with
/// a base of at most eight characters that ends in `~` and digits, and an
/// extension of at most three.
///
/// Windows volumes give such a name to anything whose own name does not fit
/// that form (`.git` is also `GIT~1`, `.env` is `ENV~1`) and open it under
/// either. Resolved, the short name is judged as the file it names, so it
/// answered `denied` exactly when a withheld file was there, and an agent
/// could learn that the file exists. The shape is therefore refused outright,
/// whatever is on disk (owner ruling 2026-11-13). The price, accepted with
/// the ruling: a file whose own name has this shape (`REPORT~1.TXT`) cannot
/// be addressed through the API.
///
/// The shape is the one NTFS and FAT generate, including the hashed form
/// (`GI8F4E~1`). Aliases a file server may invent in another shape are not
/// covered.
fn is_short_name_shaped(segment: &str) -> bool {
    let (base, extension) = match segment.split_once('.') {
        Some((base, extension)) => (base, extension),
        None => (segment, ""),
    };
    if extension.contains('.') || extension.chars().count() > 3 || base.chars().count() > 8 {
        return false;
    }
    match base.rsplit_once('~') {
        Some((_, digits)) => !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()),
        None => false,
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
/// - Windows reserved device names;
/// - a segment shaped like a Windows 8.3 short name (`is_short_name_shaped`).
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
            && !is_short_name_shaped(segment)
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
            // A tilde that cannot be a short name: no digits after it, a
            // name too long for 8.3, an extension too long, two dots, or
            // nothing before the dot.
            "notes.txt~",
            "backup~",
            "~notes.md",
            "v~x",
            "long-file-name~1.ts",
            "a~1.jsonl",
            "x~1.tar.gz",
            ".git~1",
        ] {
            assert!(is_valid_api_path(path), "{path} should be accepted");
        }
    }

    /// A segment shaped like a Windows short name is refused whatever is on
    /// disk, so asking for one cannot show that a withheld file exists.
    #[test]
    fn rejects_every_segment_shaped_like_a_short_name() {
        for path in [
            "GIT~1",
            "git~1",
            "ENV~1",
            "ENV~9",
            "PRIVAT~1",
            "GI8F4E~1",
            "ABCDE~10",
            "REPORT~1.TXT",
            "ABCDEF~1.T",
            // A tilde of the name's own before the generated one.
            "A~B-LO~1.TXT",
            "~1",
            "GIT~1/hooks/pre-commit",
            "src/GIT~1",
            "src/PRIVAT~1/new.md",
        ] {
            assert!(!is_valid_api_path(path), "{path:?} should be rejected");
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
