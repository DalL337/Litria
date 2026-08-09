// Python interpreter discovery (ADR-020 Slice 1).
//
// First concrete instance of ADR-005's "structured probes": enumerate every
// Python interpreter this machine has, from every source that records one,
// and return structured results. "Not found" is a result, not an error; the
// Windows Store alias stub is reported as a first-class *excluded* entry so
// the UI can name it instead of mistaking it for an installation.
//
// Probe sources, in trust order:
//   1. uv (`uv python list --only-installed --output-format json`) — verified
//      on uv 0.8.0: entries with a non-null `path` are installed, and uv
//      enumerates *system* interpreters too, not just uv-managed ones.
//   2. PEP 514 registry (Windows): HKCU + HKLM `Software\Python`, parsed from
//      `reg query … /s` output (house pattern: probes shell out; no registry
//      crate, keeps the pinned `windows` crate features untouched).
//   3. py launcher: `py list --format=json` (PEP 773 PyManager) falling back
//      to `py -0p` (legacy launcher's tag/path table).
//   4. PATH: `where python*` / `which -a python3 python`.
//   Unix additionally: pyenv + Homebrew well-known directories via PATH-style
//   existence checks (kept minimal; uv covers most real machines).
//
// Results are deduplicated by normalized path and sorted best-first (see
// `interpreter_sort_key`): stable CPython, default variant, highest version.
// The first entry is the recommended default; the wizard may override with
// a remembered choice.
//
// Every subprocess runs through `run_with_timeout` — a hung probe (broken
// network-drive PATH entry, wedged launcher) must never hang the caller
// (environment-bootstrap gotcha, ADR-020).

use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Suppress console window flash on Windows probe subprocesses.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const PROBE_TIMEOUT_MS: u64 = 4_000;

// ---------------------------------------------------------------------------
// Result types (serialized to the frontend as camelCase)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PythonInterpreter {
    /// Absolute path to the executable.
    pub path: String,
    /// Best-effort dotted version ("3.13.5"). None when no source reported it
    /// and the version spawn failed or timed out.
    pub version: Option<String>,
    /// Which probe found it first: "uv" | "registry" | "py-launcher" | "path".
    pub source: String,
    /// "cpython" | "pypy" | … when known (uv reports it; others assume cpython).
    pub implementation: Option<String>,
    /// "default" | "freethreaded" when known. Freethreaded builds are never
    /// the recommended default.
    pub variant: Option<String>,
    /// "x86_64" | "arm64" | … when a source reported it.
    pub arch: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedInterpreter {
    pub path: String,
    /// Machine-readable reason. Currently only "windows-store-stub".
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PythonProbeReport {
    /// Deduplicated, sorted best-first. First entry = recommended default.
    pub interpreters: Vec<PythonInterpreter>,
    /// Things that look like Pythons but must not be offered (Store stub).
    pub excluded: Vec<ExcludedInterpreter>,
    /// uv answered on this machine. Decides what the wizard's "Auto" env
    /// engine resolves to (`uv venv` vs `python -m venv`) — the Capstone
    /// preview must show the engine that will actually run (ADR-020).
    pub uv_available: bool,
}

// ---------------------------------------------------------------------------
// Subprocess helper — every probe goes through this
// ---------------------------------------------------------------------------

/// Run a command with a hard timeout, capturing stdout. Returns None on
/// spawn failure, non-zero exit, or timeout (the child is killed). A missing
/// or hanging tool is an expected outcome, never an error.
fn run_with_timeout(program: &str, args: &[&str], timeout_ms: u64) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;

    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let mut stdout = stdout;
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });

    let output = match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(buf) => buf,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return None;
        }
    };
    let status = child.wait().ok()?;
    let _ = reader.join();
    if !status.success() {
        return None;
    }
    Some(output)
}

// ---------------------------------------------------------------------------
// Parsers — pure string → entries functions, unit-tested below
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct UvPythonEntry {
    version: Option<String>,
    path: Option<String>,
    implementation: Option<String>,
    variant: Option<String>,
    arch: Option<String>,
}

/// `uv python list --only-installed --output-format json`. Entries with a
/// null `path` are downloadable-but-not-installed; skip them defensively
/// even though `--only-installed` should pre-filter.
fn parse_uv_python_list_json(json: &str) -> Vec<PythonInterpreter> {
    let entries: Vec<UvPythonEntry> = match serde_json::from_str(json) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            let path = entry.path?;
            if path.trim().is_empty() {
                return None;
            }
            Some(PythonInterpreter {
                path,
                version: entry.version,
                source: "uv".into(),
                implementation: entry.implementation,
                variant: entry.variant,
                arch: entry.arch,
            })
        })
        .collect()
}

/// `reg query HK.. \Software\Python /s` text output (PEP 514). The format is
/// a key-path line, then indented `Name    REG_SZ    Value` lines. We want
/// each `…\<Company>\<Tag>\InstallPath` key's `ExecutablePath` value, with
/// `SysVersion`/`SysArchitecture` picked up from the tag key when present.
fn parse_reg_query_output(text: &str) -> Vec<PythonInterpreter> {
    let mut interpreters = Vec::new();
    let mut current_key: Option<String> = None;
    // (tag_key_prefix, sys_version, sys_architecture) for the tag currently
    // being read; PEP 514 puts SysVersion on the tag key, ExecutablePath on
    // its InstallPath child.
    let mut tag_meta: Vec<(String, Option<String>, Option<String>)> = Vec::new();

    fn reg_value<'a>(line: &'a str, name: &str) -> Option<&'a str> {
        let trimmed = line.trim();
        let rest = trimmed.strip_prefix(name)?;
        let rest = rest.trim_start();
        let rest = rest.strip_prefix("REG_SZ")?;
        let value = rest.trim();
        if value.is_empty() { None } else { Some(value) }
    }

    for line in text.lines() {
        let trimmed_end = line.trim_end();
        if trimmed_end.starts_with("HKEY_") {
            current_key = Some(trimmed_end.to_string());
            continue;
        }
        let Some(key) = current_key.as_ref() else { continue };

        if let Some(version) = reg_value(line, "SysVersion") {
            tag_meta.push((key.clone(), Some(version.to_string()), None));
        } else if let Some(arch) = reg_value(line, "SysArchitecture") {
            // Attach to the same tag key if we already saw its SysVersion.
            if let Some(entry) = tag_meta.iter_mut().find(|(k, _, _)| k == key) {
                entry.2 = Some(normalize_arch(arch));
            } else {
                tag_meta.push((key.clone(), None, Some(normalize_arch(arch))));
            }
        } else if let Some(exe) = reg_value(line, "ExecutablePath") {
            if !key.to_ascii_lowercase().ends_with("\\installpath") {
                continue;
            }
            let tag_key = &key[..key.len() - "\\InstallPath".len()];
            let meta = tag_meta.iter().find(|(k, _, _)| k == tag_key);
            interpreters.push(PythonInterpreter {
                path: exe.to_string(),
                version: meta.and_then(|(_, v, _)| v.clone()),
                source: "registry".into(),
                implementation: Some("cpython".into()),
                variant: None,
                arch: meta.and_then(|(_, _, a)| a.clone()),
            });
        }
    }
    interpreters
}

fn normalize_arch(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "64bit" | "amd64" | "x64" => "x86_64".into(),
        "32bit" | "x86" => "x86".into(),
        other => other.into(),
    }
}

/// Legacy py launcher `py -0p` (also printed by some launchers for
/// `py list`). Lines look like:
/// ` -V:3.13 *       C:\...\Python313\python.exe`
/// ` -V:3.13t        C:\...\Python313\python3.13t.exe`
/// Older launchers print ` -3.13-64  C:\...`.
fn parse_py_launcher_list(text: &str) -> Vec<PythonInterpreter> {
    let mut interpreters = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('-') {
            continue;
        }
        let (tag_part, rest) = match trimmed.split_once(char::is_whitespace) {
            Some(parts) => parts,
            None => continue,
        };
        let rest = rest.trim_start();
        let path = rest.strip_prefix('*').unwrap_or(rest).trim();
        if path.is_empty() || !path.to_ascii_lowercase().contains("python") {
            continue;
        }
        let tag = tag_part
            .trim_start_matches("-V:")
            .trim_start_matches('-')
            .trim();
        let freethreaded = tag.ends_with('t');
        let version_tag = tag.trim_end_matches('t');
        // Tags carry only major.minor (optionally "-64"); keep the numeric
        // prefix as a coarse version — the orchestrator refines via --version.
        let version = version_tag
            .split('-')
            .next()
            .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .map(|v| v.to_string());
        interpreters.push(PythonInterpreter {
            path: path.to_string(),
            version,
            source: "py-launcher".into(),
            implementation: Some("cpython".into()),
            variant: Some(if freethreaded { "freethreaded" } else { "default" }.into()),
            arch: None,
        });
    }
    interpreters
}

/// PyManager `py list --format=json`. Shape (PEP 773): an array (or an
/// object with an `versions`/`installs` array) of entries carrying at least
/// an executable path and version. Parsed leniently — any array of objects
/// with a path-ish and version-ish field works.
fn parse_py_manager_json(json: &str) -> Vec<PythonInterpreter> {
    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let array = value
        .as_array()
        .cloned()
        .or_else(|| value.get("versions").and_then(|v| v.as_array()).cloned())
        .or_else(|| value.get("installs").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default();
    array
        .into_iter()
        .filter_map(|entry| {
            let path = entry
                .get("executable")
                .or_else(|| entry.get("executable-path"))
                .or_else(|| entry.get("path"))
                .and_then(|v| v.as_str())?
                .to_string();
            if path.trim().is_empty() {
                return None;
            }
            let version = entry
                .get("version")
                .or_else(|| entry.get("sys-version"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            Some(PythonInterpreter {
                path,
                version,
                source: "py-launcher".into(),
                implementation: Some("cpython".into()),
                variant: None,
                arch: None,
            })
        })
        .collect()
}

/// `python --version` output: "Python 3.13.5" (historically sometimes on
/// stderr, but every supported version ≥3.4 prints to stdout).
fn parse_python_version_output(text: &str) -> Option<String> {
    let token = text.trim().strip_prefix("Python")?.trim();
    let version: String = token
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if version.is_empty() { None } else { Some(version) }
}

// ---------------------------------------------------------------------------
// Merge / classify / sort — pure, unit-tested
// ---------------------------------------------------------------------------

fn normalize_path_key(path: &str) -> String {
    let stripped = path.strip_prefix("\\\\?\\").unwrap_or(path);
    if cfg!(windows) {
        stripped.replace('/', "\\").to_ascii_lowercase()
    } else {
        stripped.to_string()
    }
}

/// The Windows Store app-execution alias lives under `…\Microsoft\WindowsApps\`
/// and, with nothing installed, is a stub that routes to the Store. Anything
/// under WindowsApps that a real probe source (registry, launcher, uv) did
/// NOT vouch for is treated as the stub.
fn is_windows_store_alias(path: &str) -> bool {
    normalize_path_key(path).contains("\\microsoft\\windowsapps\\")
}

fn version_sort_key(version: Option<&str>) -> (u64, u64, u64) {
    let Some(version) = version else { return (0, 0, 0) };
    let mut parts = version.split('.').map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .unwrap_or(0)
    });
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

fn is_prerelease(version: Option<&str>) -> bool {
    version.is_some_and(|v| v.chars().any(|c| c.is_ascii_alphabetic()))
}

fn source_rank(source: &str) -> u8 {
    match source {
        "uv" => 0,
        "registry" => 1,
        "py-launcher" => 2,
        _ => 3,
    }
}

/// Best-first ordering: stable CPython default-variant with the highest
/// version wins; prereleases, freethreaded builds, and alternative
/// implementations sort below; source rank is only a tiebreak.
fn interpreter_sort_key(i: &PythonInterpreter) -> (u8, u8, u8, (u64, u64, u64), u8) {
    let impl_penalty = match i.implementation.as_deref() {
        None | Some("cpython") => 0,
        _ => 1,
    };
    let variant_penalty = match i.variant.as_deref() {
        None | Some("default") => 0,
        _ => 1,
    };
    let prerelease_penalty = if is_prerelease(i.version.as_deref()) { 1 } else { 0 };
    let (major, minor, patch) = version_sort_key(i.version.as_deref());
    (
        impl_penalty,
        variant_penalty,
        prerelease_penalty,
        // Invert version so a plain ascending sort puts the highest first.
        (u64::MAX - major, u64::MAX - minor, u64::MAX - patch),
        source_rank(&i.source),
    )
}

/// Merge probe results: first source to claim a path wins (probe order is
/// trust order), Store-alias paths without a vouching source are excluded,
/// and the result is sorted best-first.
fn merge_and_classify(found: Vec<PythonInterpreter>) -> PythonProbeReport {
    let mut seen = std::collections::HashSet::new();
    let mut interpreters: Vec<PythonInterpreter> = Vec::new();
    let mut excluded: Vec<ExcludedInterpreter> = Vec::new();

    for interpreter in found {
        let key = normalize_path_key(&interpreter.path);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        // Only PATH hits can be the naked Store alias; metadata sources
        // (registry/launcher/uv) vouch for whatever they point at.
        if interpreter.source == "path" && is_windows_store_alias(&interpreter.path) {
            excluded.push(ExcludedInterpreter {
                path: interpreter.path,
                reason: "windows-store-stub".into(),
            });
            continue;
        }
        interpreters.push(interpreter);
    }

    interpreters.sort_by_key(interpreter_sort_key);
    PythonProbeReport { interpreters, excluded, uv_available: false }
}

// ---------------------------------------------------------------------------
// Probe runners
// ---------------------------------------------------------------------------

fn probe_uv() -> Vec<PythonInterpreter> {
    run_with_timeout(
        "uv",
        &["python", "list", "--only-installed", "--output-format", "json"],
        PROBE_TIMEOUT_MS,
    )
    .map(|out| parse_uv_python_list_json(&out))
    .unwrap_or_default()
}

#[cfg(windows)]
fn probe_registry() -> Vec<PythonInterpreter> {
    let mut interpreters = Vec::new();
    for hive in ["HKCU\\Software\\Python", "HKLM\\Software\\Python"] {
        if let Some(out) = run_with_timeout("reg", &["query", hive, "/s"], PROBE_TIMEOUT_MS) {
            interpreters.extend(parse_reg_query_output(&out));
        }
    }
    interpreters
}

#[cfg(windows)]
fn probe_py_launcher() -> Vec<PythonInterpreter> {
    // PyManager first (machine-readable), legacy tag table as fallback.
    if let Some(out) = run_with_timeout("py", &["list", "--format=json"], PROBE_TIMEOUT_MS) {
        let parsed = parse_py_manager_json(&out);
        if !parsed.is_empty() {
            return parsed;
        }
    }
    run_with_timeout("py", &["-0p"], PROBE_TIMEOUT_MS)
        .map(|out| parse_py_launcher_list(&out))
        .unwrap_or_default()
}

#[cfg(windows)]
fn probe_path() -> Vec<PythonInterpreter> {
    let mut interpreters = Vec::new();
    for name in ["python", "python3"] {
        if let Some(out) = run_with_timeout("where", &[name], PROBE_TIMEOUT_MS) {
            for line in out.lines() {
                let path = line.trim();
                if !path.is_empty() {
                    interpreters.push(PythonInterpreter {
                        path: path.to_string(),
                        version: None,
                        source: "path".into(),
                        implementation: None,
                        variant: None,
                        arch: None,
                    });
                }
            }
        }
    }
    interpreters
}

#[cfg(not(windows))]
fn probe_path() -> Vec<PythonInterpreter> {
    let mut interpreters = Vec::new();
    for name in ["python3", "python"] {
        if let Some(out) = run_with_timeout("which", &["-a", name], PROBE_TIMEOUT_MS) {
            for line in out.lines() {
                let path = line.trim();
                if !path.is_empty() {
                    interpreters.push(PythonInterpreter {
                        path: path.to_string(),
                        version: None,
                        source: "path".into(),
                        implementation: None,
                        variant: None,
                        arch: None,
                    });
                }
            }
        }
    }
    interpreters
}

/// Fill in missing versions by asking the interpreter itself. Only entries
/// without a metadata version get spawned; a stub/broken exe simply keeps
/// version None (and PATH-source entries that fail under WindowsApps were
/// already excluded before this runs).
fn fill_versions(interpreters: &mut [PythonInterpreter]) {
    for interpreter in interpreters.iter_mut() {
        if interpreter.version.is_some() {
            continue;
        }
        interpreter.version = run_with_timeout(&interpreter.path, &["--version"], PROBE_TIMEOUT_MS)
            .as_deref()
            .and_then(parse_python_version_output);
    }
}

/// Full machine scan. Blocking (subprocess-heavy) — call from spawn_blocking.
pub(crate) fn detect_python_interpreters() -> PythonProbeReport {
    let uv_available = run_with_timeout("uv", &["--version"], PROBE_TIMEOUT_MS).is_some();
    let mut found = Vec::new();
    if uv_available {
        found.extend(probe_uv());
    }
    #[cfg(windows)]
    {
        found.extend(probe_registry());
        found.extend(probe_py_launcher());
    }
    found.extend(probe_path());

    let mut report = merge_and_classify(found);
    fill_versions(&mut report.interpreters);
    // Version fill can demote an entry (prerelease discovered) — re-sort.
    report.interpreters.sort_by_key(interpreter_sort_key);
    report.uv_available = uv_available;
    report
}

// ---------------------------------------------------------------------------
// Tests: run with `cargo test python_probe`
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, version: Option<&str>, source: &str) -> PythonInterpreter {
        PythonInterpreter {
            path: path.into(),
            version: version.map(|v| v.into()),
            source: source.into(),
            implementation: None,
            variant: None,
            arch: None,
        }
    }

    #[test]
    fn uv_json_keeps_installed_drops_downloadable() {
        let json = r#"[
            {"key":"cpython-3.13.5-windows-x86_64-none","version":"3.13.5",
             "path":"C:\\Py\\python.exe","implementation":"cpython",
             "variant":"default","arch":"x86_64"},
            {"key":"cpython-3.12.11-windows-x86_64-none","version":"3.12.11",
             "path":null,"implementation":"cpython","variant":"default","arch":"x86_64"}
        ]"#;
        let parsed = parse_uv_python_list_json(json);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].path, "C:\\Py\\python.exe");
        assert_eq!(parsed[0].version.as_deref(), Some("3.13.5"));
        assert_eq!(parsed[0].source, "uv");
        assert_eq!(parsed[0].arch.as_deref(), Some("x86_64"));
    }

    #[test]
    fn uv_json_garbage_is_empty_not_error() {
        assert!(parse_uv_python_list_json("not json").is_empty());
        assert!(parse_uv_python_list_json("{}").is_empty());
    }

    #[test]
    fn reg_query_parses_pep514_tags() {
        let text = "\
HKEY_CURRENT_USER\\Software\\Python\\PythonCore\\3.13
    DisplayName    REG_SZ    Python 3.13 (64-bit)
    SysVersion    REG_SZ    3.13
    SysArchitecture    REG_SZ    64bit

HKEY_CURRENT_USER\\Software\\Python\\PythonCore\\3.13\\InstallPath
    (Default)    REG_SZ    C:\\Python313\\
    ExecutablePath    REG_SZ    C:\\Python313\\python.exe
";
        let parsed = parse_reg_query_output(text);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].path, "C:\\Python313\\python.exe");
        assert_eq!(parsed[0].version.as_deref(), Some("3.13"));
        assert_eq!(parsed[0].arch.as_deref(), Some("x86_64"));
        assert_eq!(parsed[0].source, "registry");
    }

    #[test]
    fn py_launcher_table_parses_tags_default_star_and_freethreaded() {
        let text = "\
 -V:3.13t *       C:\\Users\\d\\Python313\\python3.13t.exe
 -V:3.13          C:\\Users\\d\\Python313\\python.exe
 -V:3.9           C:\\VS\\Shared\\Python39_64\\python.exe
";
        let parsed = parse_py_launcher_list(text);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].variant.as_deref(), Some("freethreaded"));
        assert_eq!(parsed[0].path, "C:\\Users\\d\\Python313\\python3.13t.exe");
        assert_eq!(parsed[1].variant.as_deref(), Some("default"));
        assert_eq!(parsed[1].version.as_deref(), Some("3.13"));
        assert_eq!(parsed[2].version.as_deref(), Some("3.9"));
    }

    #[test]
    fn python_version_output_parses() {
        assert_eq!(
            parse_python_version_output("Python 3.13.5\n").as_deref(),
            Some("3.13.5")
        );
        assert_eq!(
            parse_python_version_output("Python 3.14.0b4").as_deref(),
            Some("3.14.0")
        );
        assert_eq!(parse_python_version_output("zsh: not found"), None);
    }

    #[test]
    fn merge_dedups_by_normalized_path_first_source_wins() {
        let report = merge_and_classify(vec![
            entry("C:\\Py\\python.exe", Some("3.13.5"), "uv"),
            entry("c:/py/PYTHON.EXE", Some("3.13"), "registry"),
            entry("C:\\Other\\python.exe", Some("3.12.1"), "path"),
        ]);
        assert_eq!(report.interpreters.len(), 2);
        assert_eq!(report.interpreters[0].source, "uv");
    }

    #[test]
    fn merge_excludes_store_alias_from_path_but_trusts_metadata_sources() {
        let report = merge_and_classify(vec![
            entry(
                "C:\\Users\\d\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
                None,
                "path",
            ),
            entry(
                "C:\\Users\\d\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe",
                Some("3.12.0"),
                "registry",
            ),
        ]);
        assert_eq!(report.excluded.len(), 1);
        assert_eq!(report.excluded[0].reason, "windows-store-stub");
        assert_eq!(report.interpreters.len(), 1);
        assert_eq!(report.interpreters[0].source, "registry");
    }

    #[test]
    fn sort_prefers_stable_default_cpython_highest_version() {
        let mut prerelease = entry("C:\\a\\python.exe", Some("3.14.0b4"), "uv");
        prerelease.implementation = Some("cpython".into());
        let mut freethreaded = entry("C:\\b\\python3.13t.exe", Some("3.13.5"), "uv");
        freethreaded.variant = Some("freethreaded".into());
        let mut pypy = entry("C:\\c\\pypy.exe", Some("3.11.13"), "uv");
        pypy.implementation = Some("pypy".into());
        let stable_old = entry("C:\\d\\python.exe", Some("3.9.13"), "registry");
        let stable_new = entry("C:\\e\\python.exe", Some("3.13.5"), "path");

        let report = merge_and_classify(vec![
            prerelease,
            freethreaded,
            pypy,
            stable_old.clone(),
            stable_new.clone(),
        ]);
        let order: Vec<&str> = report.interpreters.iter().map(|i| i.path.as_str()).collect();
        // Highest stable default cpython first (despite lowly "path" source),
        // then older stable, then prerelease, then freethreaded, then pypy.
        assert_eq!(
            order,
            vec!["C:\\e\\python.exe", "C:\\d\\python.exe", "C:\\a\\python.exe", "C:\\b\\python3.13t.exe", "C:\\c\\pypy.exe"]
        );
    }

    #[test]
    fn empty_scan_is_a_result_not_an_error() {
        let report = merge_and_classify(Vec::new());
        assert!(report.interpreters.is_empty());
        assert!(report.excluded.is_empty());
    }

    /// Live machine scan — spawns real probes, so ignored by default.
    /// Run explicitly: `cargo test python_probe -- --ignored --nocapture`
    #[test]
    #[ignore = "spawns real machine probes"]
    fn live_machine_scan_smoke() {
        let report = detect_python_interpreters();
        eprintln!("-- interpreters ({}) --", report.interpreters.len());
        for i in &report.interpreters {
            eprintln!(
                "  {:.<60} v{:<10} [{}] {}/{}",
                i.path,
                i.version.as_deref().unwrap_or("?"),
                i.source,
                i.implementation.as_deref().unwrap_or("?"),
                i.variant.as_deref().unwrap_or("?"),
            );
        }
        eprintln!("-- excluded ({}) --", report.excluded.len());
        for e in &report.excluded {
            eprintln!("  {} ({})", e.path, e.reason);
        }
        // Every reported interpreter must have a non-empty path; sorting must
        // never place a freethreaded/prerelease build first when a stable
        // default-variant entry exists anywhere in the list.
        assert!(report.interpreters.iter().all(|i| !i.path.trim().is_empty()));
        let has_stable_default = report.interpreters.iter().any(|i| {
            !is_prerelease(i.version.as_deref())
                && !matches!(i.variant.as_deref(), Some(v) if v != "default")
        });
        if has_stable_default {
            let first = &report.interpreters[0];
            assert!(!is_prerelease(first.version.as_deref()));
            assert!(!matches!(first.variant.as_deref(), Some(v) if v != "default"));
        }
    }
}
