use crate::blank_project;
use crate::build_log;
use crate::crash;
use crate::errors::{CommandError, CommandResult};
use crate::lsp::session as lsp_session;
use crate::lsp::types::{LspPrerequisitesPayload, LspSessionEndedPayload, LspSessionStartedPayload};
use crate::project_ops;
use crate::project_types::ProjectTreeEntry;
use crate::python_probe;
use crate::python_scaffold;
use crate::scaffold_runner;
use crate::scaffold_types::{
    PackageManager, PrerequisiteResult, ScaffoldConfig, ScaffoldEvent, ScaffoldResult,
    ScaffoldWrapper,
};
use crate::terminal_ipc_bridge;
use crate::terminal_session_manager;
use crate::terminal_pty::TerminalEvent;
use crate::terminal_types::{TerminalSessionEndedPayload, TerminalSessionStartedPayload};
use tauri::ipc::Channel;
use serde_json::Value;

#[tauri::command]
pub(crate) fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
pub(crate) fn read_project_file(root_path: &str, relative_path: &str) -> CommandResult<String> {
    project_ops::read_project_file(root_path, relative_path)
}

/// Opened-file payload (ADR-022): the path the OS picker returned plus its
/// contents.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenedFile {
    pub path: String,
    pub contents: String,
}

/// Open the OS file picker and return the picked file's contents (ADR-022,
/// audit #1). Rust owns the dialog, so a consented path never round-trips
/// through JS and there is no command that reads an arbitrary frontend-supplied
/// path. Returns `None` when the user cancels.
#[tauri::command]
pub(crate) async fn open_file_dialog(app: tauri::AppHandle) -> CommandResult<Option<OpenedFile>> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        // `blocking_pick_file` must run off the main thread (it deadlocks on
        // it); `spawn_blocking` satisfies that and the plugin marshals the
        // native dialog to the main thread internally.
        let Some(picked) = app.dialog().file().blocking_pick_file() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| {
            CommandError::invalid_path(
                "external_file.resolve",
                format!("Unable to resolve the picked file: {e}"),
            )
        })?;
        let contents = std::fs::read_to_string(&path).map_err(|error| {
            CommandError::from_io("external_file.read", &error, "Unable to read file")
        })?;
        Ok(Some(OpenedFile {
            path: path.to_string_lossy().into_owned(),
            contents,
        }))
    })
    .await
    .map_err(|e| CommandError::internal("external_file.thread_error", e.to_string()))?
}

#[tauri::command]
pub(crate) fn write_project_file(root_path: &str, relative_path: &str, contents: &str) -> CommandResult<()> {
    project_ops::write_project_file(root_path, relative_path, contents)
}

#[tauri::command]
pub(crate) fn list_project_tree(root_path: &str) -> CommandResult<Vec<ProjectTreeEntry>> {
    project_ops::list_project_tree(root_path)
}

#[tauri::command]
pub(crate) fn move_project_path(root_path: &str, from_relative: &str, to_relative: &str) -> CommandResult<()> {
    project_ops::move_project_path(root_path, from_relative, to_relative)
}

#[tauri::command]
pub(crate) fn create_project_directory(root_path: &str, relative_path: &str) -> CommandResult<()> {
    project_ops::create_project_directory(root_path, relative_path)
}

#[tauri::command]
pub(crate) fn delete_project_path(root_path: &str, relative_path: &str) -> CommandResult<()> {
    project_ops::delete_project_path(root_path, relative_path)
}

#[tauri::command]
pub(crate) fn remove_empty_directory(root_path: &str, relative_path: &str) -> CommandResult<()> {
    project_ops::remove_empty_directory(root_path, relative_path)
}

/// Legacy metadata-only session start (no PTY process).
#[tauri::command]
pub(crate) fn terminal_session_start(
    app: tauri::AppHandle,
    project_id: &str,
    project_root: &str,
    executable: Option<String>,
) -> CommandResult<TerminalSessionStartedPayload> {
    let result = terminal_session_manager::start_session(project_id, project_root, executable.as_deref());
    match result {
        Ok(payload) => {
            let _ = terminal_ipc_bridge::emit_session_started(&app, &payload);
            Ok(payload)
        }
        Err(error) => {
            let _ = terminal_ipc_bridge::emit_terminal_error(&app, project_id, None, &error);
            Err(error)
        }
    }
}

/// Spawn a PTY-backed terminal session. Output streams via the provided Channel.
#[tauri::command]
pub(crate) fn terminal_spawn(
    app: tauri::AppHandle,
    project_id: &str,
    project_root: &str,
    executable: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> CommandResult<TerminalSessionStartedPayload> {
    let result = terminal_session_manager::start_pty_session(
        project_id,
        project_root,
        executable.as_deref(),
        cols,
        rows,
        on_event,
    );
    match result {
        Ok(payload) => {
            let _ = terminal_ipc_bridge::emit_session_started(&app, &payload);
            Ok(payload)
        }
        Err(error) => {
            let _ = terminal_ipc_bridge::emit_terminal_error(&app, project_id, None, &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn terminal_input(
    app: tauri::AppHandle,
    project_id: &str,
    session_id: &str,
    input: &str,
) -> CommandResult<()> {
    let result = terminal_session_manager::write_input(project_id, session_id, input.as_bytes());
    if let Err(ref error) = result {
        let _ = terminal_ipc_bridge::emit_terminal_error(&app, project_id, Some(session_id), error);
    }
    result
}

#[tauri::command]
pub(crate) fn terminal_resize(
    app: tauri::AppHandle,
    project_id: &str,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> CommandResult<()> {
    if cols == 0 || rows == 0 {
        let error = crate::errors::CommandError::invalid_path(
            "terminal.invalid_request",
            "Terminal cols and rows must be greater than zero.",
        );
        let _ = terminal_ipc_bridge::emit_terminal_error(&app, project_id, Some(session_id), &error);
        return Err(error);
    }
    let result = terminal_session_manager::resize_pty(project_id, session_id, cols, rows);
    if let Err(ref error) = result {
        let _ = terminal_ipc_bridge::emit_terminal_error(&app, project_id, Some(session_id), error);
    }
    result
}

#[tauri::command]
pub(crate) fn terminal_session_end(
    app: tauri::AppHandle,
    project_id: &str,
) -> CommandResult<TerminalSessionEndedPayload> {
    let result = terminal_session_manager::end_session(project_id);
    match result {
        Ok((payload, exit_code)) => {
            let _ = terminal_ipc_bridge::emit_session_ended(&app, &payload);
            let severity = if exit_code == Some(0) { "success" } else { "warning" };
            let _ = terminal_ipc_bridge::emit_process_complete(
                &app,
                &payload.project_id,
                "Terminal session ended.",
                severity,
                exit_code,
            );
            Ok(payload)
        }
        Err(error) => {
            let _ = terminal_ipc_bridge::emit_terminal_error(&app, project_id, None, &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn terminal_pause(project_id: &str) -> CommandResult<()> {
    terminal_session_manager::pause_output(project_id)
}

#[tauri::command]
pub(crate) fn terminal_resume(project_id: &str) -> CommandResult<()> {
    terminal_session_manager::resume_output(project_id)
}

#[tauri::command]
pub(crate) fn terminal_teardown_all() -> CommandResult<usize> {
    terminal_session_manager::teardown_all_sessions()
}

// ---------------------------------------------------------------------------
// Scaffold commands (New Project wizard)
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn check_scaffold_prerequisites(
    app: tauri::AppHandle,
    wrapper: ScaffoldWrapper,
    manager: PackageManager,
) -> CommandResult<PrerequisiteResult> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(scaffold_runner::check_prerequisites(&wrapper, &manager, &app))
    })
    .await
    .map_err(|e| CommandError::internal("scaffold.prereq.thread_error", e.to_string()))?
}

#[tauri::command]
pub(crate) async fn scaffold_project(
    app: tauri::AppHandle,
    config: ScaffoldConfig,
    on_event: Channel<ScaffoldEvent>,
) -> CommandResult<ScaffoldResult> {
    tauri::async_runtime::spawn_blocking(move || {
        scaffold_runner::run_scaffold(config, &app, &on_event)
    })
    .await
    .map_err(|e| CommandError::internal("scaffold.thread_error", e.to_string()))?
}

/// Create a Python project from an offline blueprint (ADR-020 Slice 3).
/// Writes every file itself; the only subprocess is local env creation
/// (stdlib venv / uv venv), streamed over the same channel as npm scaffolds.
/// Env failure is non-fatal — the project opens files-only.
#[tauri::command]
pub(crate) async fn scaffold_python_project(
    config: python_scaffold::PythonScaffoldConfig,
    on_event: Channel<ScaffoldEvent>,
) -> CommandResult<python_scaffold::PythonScaffoldResult> {
    tauri::async_runtime::spawn_blocking(move || {
        python_scaffold::run_python_scaffold(config, &on_event)
    })
    .await
    .map_err(|e| CommandError::internal("python_scaffold.thread_error", e.to_string()))?
}

/// Enumerate every Python interpreter on this machine (ADR-020 Slice 1).
/// Structured probes: uv JSON, PEP 514 registry, py launcher, PATH — merged,
/// deduplicated, sorted best-first. Empty result = none found (not an error);
/// the Windows Store alias stub is reported under `excluded`, never offered.
#[tauri::command]
pub(crate) async fn detect_python_interpreters() -> CommandResult<python_probe::PythonProbeReport> {
    tauri::async_runtime::spawn_blocking(python_probe::detect_python_interpreters)
        .await
        .map_err(|e| CommandError::internal("python_probe.thread_error", e.to_string()))
}

/// Blank template: no CLI scaffold, no prerequisites — writes the
/// stack-agnostic substrate (README + quote, .gitignore, .editorconfig)
/// into <location>/<name>. Fast, local-only, always available.
#[tauri::command]
pub(crate) fn create_blank_project(
    project_name: String,
    project_location: String,
) -> CommandResult<blank_project::BlankProjectResult> {
    blank_project::create_blank_project(&project_name, &project_location)
}

// ---------------------------------------------------------------------------
// Crash-log system (B5) — all commands are best-effort observers; none of
// them can fail the frontend (they swallow errors and return unit/empty).
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn crash_startup_scan() -> Vec<crash::scan::CrashNotice> {
    crash::scan::startup_scan()
}

#[tauri::command]
pub(crate) fn crash_write_js_record(record: serde_json::Value) -> Option<String> {
    // Size guard: a runaway record (giant stack, huge crumb ring) is refused
    // rather than filling the disk; the local layer caps content upstream.
    let serialized = serde_json::to_string(&record).ok()?;
    if serialized.len() > 1_048_576 {
        return None;
    }
    let layer = record
        .get("layer")
        .and_then(|v| v.as_str())
        .unwrap_or("js")
        .to_string();
    let safe_layer: String = layer
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(24)
        .collect();
    let layer = if safe_layer.is_empty() { "js".to_string() } else { safe_layer };
    // Budgeted writer (audit #19): this is the one crash-record path a caller
    // can drive in a loop, and `prune` runs at startup only by design.
    crash::record::write_js_value(&layer, &record).map(|p| p.to_string_lossy().into_owned())
}

/// Replace this session's breadcrumb mirror with the renderer's current
/// ring (small JSONL, debounced frontend-side; event-driven — idle = no calls).
#[tauri::command]
pub(crate) fn crash_append_breadcrumbs(lines: String) {
    if lines.len() > 65_536 {
        return;
    }
    // After the clean transition, refuse late flushes — they would recreate
    // the mirror mark_clean just removed and orphan it.
    if crash::marker::is_cleaned() {
        return;
    }
    if let Some(env) = crash::env() {
        let _ = crash::replace_file(&env.breadcrumbs_path, &lines);
    }
}

/// Home directory for report-time path scrubbing (usernames must not leak
/// into public GitHub issues; local logs keep full fidelity by design).
#[tauri::command]
pub(crate) fn crash_home_dir() -> Option<String> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok()
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok()
    }
}

#[tauri::command]
pub(crate) fn crash_mark_phase(phase: String) {
    let safe: String = phase
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(32)
        .collect();
    crash::marker::mark_phase(&safe);
}

#[tauri::command]
pub(crate) fn crash_mark_clean() {
    crash::marker::mark_clean();
}

#[tauri::command]
pub(crate) fn crash_mark_seen(file_names: Vec<String>) {
    crash::scan::mark_seen(file_names);
}

#[tauri::command]
pub(crate) fn crash_open_logs_dir(app: tauri::AppHandle) {
    use tauri_plugin_opener::OpenerExt;
    if let Some(env) = crash::env() {
        let _ = app
            .opener()
            .open_path(env.crashes_dir.to_string_lossy(), None::<&str>);
    }
}

/// Open the pre-filled GitHub issue URL. Locked to the Litria repo so this
/// command can't be used as a generic open-anything primitive.
#[tauri::command]
pub(crate) fn crash_open_report_url(app: tauri::AppHandle, url: String) {
    use tauri_plugin_opener::OpenerExt;
    if url.starts_with("https://github.com/DalL337/litria/issues/new") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

/// Manual test hook for the panic path — dev builds only.
#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn crash_test_panic() {
    panic!("crash_test_panic: intentional dev-only panic to exercise the crash hook");
}

// ---------------------------------------------------------------------------
// Generic LSP commands (language-agnostic)
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn lsp_install_server(
    app: tauri::AppHandle,
    language_id: String,
    custom_url: Option<String>,
) -> CommandResult<crate::lsp::download::InstallResultPayload> {
    // Synchronous staged pipeline (ureq — tokio-free by design, ADR-005 §2)
    // on a blocking thread; progress streams via lsp:download-progress.
    tauri::async_runtime::spawn_blocking(move || {
        crate::lsp::download::install_server(&app, &language_id, custom_url)
    })
    .await
    .map_err(|e| CommandError::internal("lsp.install.thread_error", e.to_string()))?
}

#[tauri::command]
pub(crate) fn lsp_cancel_install(server_id: String) {
    crate::lsp::download::cancel_install(&server_id);
}

#[tauri::command]
pub(crate) fn lsp_get_registry() -> CommandResult<crate::lsp::registry::RegistryPayload> {
    // Baked-in data + compile-time platform key — synchronous by nature
    // (ADR-005 §4: zero network in v1 registry reads).
    crate::lsp::registry::registry_payload()
}

#[tauri::command]
pub(crate) async fn lsp_server_inventory(
    app: tauri::AppHandle,
) -> CommandResult<crate::lsp::download::ServerInventoryPayload> {
    // Walks the managed dirs for sizes and runs resolver probes — blocking IO.
    tauri::async_runtime::spawn_blocking(move || crate::lsp::download::server_inventory(&app))
        .await
        .map_err(|e| CommandError::internal("lsp.inventory.thread_error", e.to_string()))?
}

#[tauri::command]
pub(crate) async fn lsp_uninstall_server(
    app: tauri::AppHandle,
    language_id: String,
) -> CommandResult<crate::lsp::download::UninstallResultPayload> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::lsp::download::uninstall_server(&app, &language_id)
    })
    .await
    .map_err(|e| CommandError::internal("lsp.uninstall.thread_error", e.to_string()))?
}

#[tauri::command]
pub(crate) async fn lsp_reverify_server(
    language_id: String,
) -> CommandResult<crate::lsp::download::ReverifyResultPayload> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::lsp::download::reverify_server(&language_id)
    })
    .await
    .map_err(|e| CommandError::internal("lsp.reverify.thread_error", e.to_string()))?
}

#[tauri::command]
pub(crate) async fn lsp_detect_prerequisites(
    app: tauri::AppHandle,
    language_id: String,
) -> CommandResult<LspPrerequisitesPayload> {
    tauri::async_runtime::spawn_blocking(move || {
        lsp_session::detect_prerequisites(&language_id, Some(&app))
    })
    .await
    .map_err(|e| CommandError::internal("lsp.detect.thread_error", e.to_string()))?
}

#[tauri::command]
pub(crate) async fn lsp_start_session(
    app: tauri::AppHandle,
    language_id: String,
    project_id: String,
    project_root: String,
) -> CommandResult<LspSessionStartedPayload> {
    let app2 = app.clone();
    let lid = language_id.clone();
    let pid = project_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = lsp_session::start_session(&app2, &lid, &pid, &project_root);
        if let Err(ref error) = result {
            crate::lsp::ipc_bridge::emit_lsp_error(&app2, &pid, &lid, None, error, None);
        }
        result
    })
    .await
    .map_err(|e| CommandError::internal("lsp.start.thread_error", e.to_string()))?
}

#[tauri::command]
pub(crate) async fn lsp_stop_session(
    app: tauri::AppHandle,
    language_id: String,
    project_id: String,
    session_id: Option<String>,
) -> CommandResult<LspSessionEndedPayload> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = lsp_session::stop_session(
            &app,
            &language_id,
            &project_id,
            session_id.as_deref(),
        );
        if let Err(ref error) = result {
            crate::lsp::ipc_bridge::emit_lsp_error(
                &app,
                &project_id,
                &language_id,
                session_id.as_deref(),
                error,
                None,
            );
        }
        result
    })
    .await
    .map_err(|e| CommandError::internal("lsp.stop.thread_error", e.to_string()))?
}

#[tauri::command]
pub(crate) async fn lsp_request(
    language_id: String,
    project_id: String,
    method: String,
    params: Value,
    timeout_ms: Option<u64>,
) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        lsp_session::session_request(
            &language_id,
            &project_id,
            &method,
            params,
            timeout_ms.unwrap_or(5_000),
        )
    })
    .await
    .map_err(|e| CommandError::internal("lsp.request.thread_error", e.to_string()))?
}

#[tauri::command]
pub(crate) async fn lsp_notify(
    language_id: String,
    project_id: String,
    method: String,
    params: Value,
) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        lsp_session::session_notify(&language_id, &project_id, &method, params)
    })
    .await
    .map_err(|e| CommandError::internal("lsp.notify.thread_error", e.to_string()))?
}

// ---------------------------------------------------------------------------
// Build logs — the diagnostic trail for scaffold/build runs.
//
// Deliberately separate from the crash system: a scaffold failure leaves the
// app healthy, so the crash machinery never fires and its trace previously
// had nowhere to go. Like the crash commands these are best-effort observers
// — none of them can fail a scaffold.
// ---------------------------------------------------------------------------

/// Persist one run's JSONL body. `slug` is a project name; it is sanitized
/// into the file name. Returns the written path, or None if refused.
#[tauri::command]
pub(crate) fn build_log_write(slug: String, body: String) -> Option<String> {
    build_log::write_run(&slug, &body).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn build_log_list() -> Vec<build_log::BuildLogEntry> {
    build_log::list()
}

/// Read one stored run. `name` is validated as a bare build-log file name
/// inside build_log::read — a separator or parent segment is refused there.
#[tauri::command]
pub(crate) fn build_log_read(name: String) -> Option<String> {
    build_log::read(&name)
}

/// Absolute path of the builds directory, for the viewer's "reveal" affordance.
#[tauri::command]
pub(crate) fn build_log_dir() -> Option<String> {
    build_log::builds_dir().map(|p| p.to_string_lossy().into_owned())
}

/// True only for a bare `crash-*.json` name — the same read boundary the
/// build logs apply, since `name` crosses from the webview.
fn is_crash_record_name(name: &str) -> bool {
    !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name.starts_with("crash-")
        && name.ends_with(".json")
}

/// List stored crash records (newest first) so the log viewer can show them
/// beside build runs. `crash::scan` owns interpretation; this is raw listing.
#[tauri::command]
pub(crate) fn crash_log_list() -> Vec<String> {
    let Some(env) = crash::env() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&env.crashes_dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .filter(|n| is_crash_record_name(n))
        .collect();
    // Names embed epoch ms at a fixed offset, so a reverse sort is
    // newest-first (same reasoning as crash::record::prune).
    names.sort();
    names.reverse();
    names
}

#[tauri::command]
pub(crate) fn crash_log_read(name: String) -> Option<String> {
    if !is_crash_record_name(&name) {
        return None;
    }
    let env = crash::env()?;
    std::fs::read_to_string(env.crashes_dir.join(name)).ok()
}

/// Write text to the system clipboard from the Rust side.
///
/// The webview is intentionally NOT granted clipboard IPC (see
/// capabilities/default.json and capabilityScope.test.mjs); this command is
/// the whole surface, mirroring how the opener plugin is used server-side.
#[tauri::command]
pub(crate) fn copy_to_clipboard(app: tauri::AppHandle, text: String) -> CommandResult<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|e| CommandError::internal("clipboard.write_failed", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_record_names_reject_traversal() {
        assert!(is_crash_record_name("crash-1785468653176-59306-js.json"));
        assert!(!is_crash_record_name("../crash-1-a.json"));
        assert!(!is_crash_record_name("crash-1-a.json/../../etc/passwd"));
        assert!(!is_crash_record_name("build-1-a.jsonl"));
    }

    #[test]
    fn terminal_teardown_all_returns_zero_when_empty() {
        let result = terminal_teardown_all().expect("teardown should succeed");
        assert_eq!(result, 0);
    }
}
