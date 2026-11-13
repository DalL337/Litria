// Track T slice T2b-1: starting the person's own agent as a terminal session.
mod agent_launch;
mod blank_project;
mod build_log;
mod bundled_runtime;
mod commands;
// ADR-033 contract types and machinery; schema generation stays test-only.
// Agents reach them through mcp_connection (track T); since slice T2b-1
// release builds start agents, so nothing here is dead code there.
mod contracts;
mod crash;
mod db;
mod errors;
mod execution_policy;
mod lsp;
// Track T slice T1a: the agents' MCP connection. Sessions start when
// agent_launch starts an agent (slice T2b-1), in every build.
mod mcp_connection;
mod path_guard;
mod platform;
mod preferences;
// ADR-031 Project API service.
mod project_api;
mod project_ops;
mod project_tree;
mod project_types;
mod python_probe;
mod python_scaffold;
mod creation_ownership;
mod process_control;
mod quote_pool;
mod scaffold_recipes;
mod scaffold_runner;
mod scaffold_types;
mod terminal_policy;
mod terminal_pty;
mod terminal_session_manager;
mod terminal_types;
mod write_ops;

/// The flag that runs this binary as the MCP helper an agent starts (track T,
/// T1a). `main` checks it before anything else runs.
pub const MCP_HELPER_FLAG: &str = mcp_connection::helper::FLAG;

/// Run as the MCP helper; returns the process exit code.
pub fn run_mcp_helper() -> i32 {
    mcp_connection::helper::run()
}

#[cfg(debug_assertions)]
#[doc(hidden)]
pub use mcp_connection::test_support as mcp_test_support;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Crash system first: dirty marker (phase "boot") + panic hook must be
    // armed before anything that can fail — an early-startup crash then
    // self-identifies by phase instead of being unattributable.
    crash::init(env!("CARGO_PKG_VERSION"));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Clipboard is used ONLY server-side, through the copy_to_clipboard
        // command — the webview is deliberately not granted clipboard IPC,
        // same posture as opener (capabilities/default.json, enforced by
        // test/domains/capabilityScope.test.mjs).
        .plugin(tauri_plugin_clipboard_manager::init())
        // A page (re)load means the frontend that showed the terminals is
        // gone: the automatic reload after a renderer crash, the crash
        // screen's Reload, or a dev reload. Every reload lands on the
        // launcher with no project open, so every session ends, as on a
        // project close. Done here, before any script runs, so nothing the
        // new page starts can race it.
        .on_page_load(|_webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                terminal_session_manager::end_all_for_page_load();
                mcp_connection::end_all_for_page_load();
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Core project ops
            commands::read_project_file,
            commands::read_project_file_with_revision,
            commands::open_file_dialog,
            commands::write_project_file,
            commands::create_project_file,
            commands::save_project_file,
            commands::project_files_stamps,
            commands::project_tree_stamp,
            commands::list_project_tree,
            commands::move_project_path,
            commands::create_project_directory,
            commands::delete_project_path,
            commands::remove_empty_directory,
            // Terminal
            commands::terminal_spawn,
            commands::agent_detect,
            commands::agent_open_install_guide,
            commands::terminal_spawn_agent,
            commands::terminal_input,
            commands::terminal_resize,
            commands::terminal_session_end,
            commands::terminal_end_project,
            commands::terminal_pause,
            commands::terminal_resume,
            commands::terminal_teardown_all,
            commands::terminal_busy_sessions,
            commands::terminal_take_reload_report,
            // Generic LSP client
            commands::lsp_get_registry,
            commands::lsp_install_server,
            commands::lsp_cancel_install,
            commands::lsp_server_inventory,
            commands::lsp_uninstall_server,
            commands::lsp_reverify_server,
            commands::lsp_detect_prerequisites,
            commands::lsp_start_session,
            commands::lsp_stop_session,
            commands::lsp_request,
            commands::lsp_notify,
            // Scaffold (New Project wizard)
            commands::check_scaffold_prerequisites,
            commands::scaffold_project,
            commands::create_blank_project,
            // Python toolchain probe + offline scaffold (ADR-020)
            commands::detect_python_interpreters,
            commands::scaffold_python_project,
            commands::cancel_scaffold,
            // Platform
            platform::get_platform_config,
            // SQLite persistence (db module)
            db::commands::db_bootstrap_project,
            db::commands::db_check_project_path,
            db::commands::db_open_project,
            db::commands::db_close_project,
            db::commands::db_create_piece,
            db::commands::db_create_pieces_batch,
            db::commands::db_batch_move_pieces,
            db::commands::db_update_piece,
            db::commands::db_delete_piece,
            db::commands::db_create_group,
            db::commands::db_update_group,
            db::commands::db_delete_group,
            db::commands::db_add_piece_to_group,
            db::commands::db_remove_piece_from_group,
            db::commands::db_create_connection,
            db::commands::db_save_editor_state,
            db::commands::db_load_editor_state,
            db::commands::db_save_viewport,
            db::commands::db_save_workspace_grid,
            db::commands::db_add_hidden_path,
            db::commands::db_remove_hidden_path,
            db::commands::db_list_recent_projects,
            db::commands::db_register_project,
            db::commands::db_remove_project,
            db::commands::db_pin_project,
            db::commands::db_save_preference,
            db::commands::db_load_preferences,
            // Preferences store (ADR-019)
            preferences::prefs_load_global,
            preferences::prefs_save_global,
            preferences::prefs_load_project,
            preferences::prefs_save_project,
            preferences::prefs_clear_project,
            // Crash-log system (B5)
            commands::crash_startup_scan,
            commands::crash_write_js_record,
            commands::crash_append_breadcrumbs,
            commands::crash_mark_phase,
            commands::crash_mark_clean,
            commands::crash_mark_seen,
            commands::crash_open_logs_dir,
            commands::crash_open_report_url,
            commands::crash_home_dir,
            #[cfg(debug_assertions)]
            commands::crash_test_panic,
            // Project API: interrupted agent changes, reported on reopen (W4b)
            commands::project_api_interrupted_operations,
            // Project API — dev builds only, for live passes (agents reach the
            // API through mcp_connection, track T)
            #[cfg(debug_assertions)]
            commands::project_api_dev_call,
            #[cfg(debug_assertions)]
            commands::project_api_dev_review,
            #[cfg(debug_assertions)]
            commands::project_api_dev_agent_session_start,
            #[cfg(debug_assertions)]
            commands::project_api_dev_agent_session_end,
            // The owner bridge: agents' calls read editor state through it
            // (every build since track T slice T2b-1).
            commands::project_api_bridge_attach,
            commands::project_api_bridge_detach,
            commands::project_api_bridge_reply,
            // Build logs — scaffold/build diagnostics (not crashes)
            commands::build_log_write,
            commands::build_log_list,
            commands::build_log_read,
            commands::build_log_dir,
            commands::build_log_open_dir,
            commands::crash_log_list,
            commands::crash_log_read,
            commands::copy_to_clipboard,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(true);
                }
            }

            // Crash hook #4: watch for WebView2 process death from the
            // surviving Rust host (Windows; macOS relies on the marker).
            #[cfg(windows)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    crash::webview_watch::install(&window);
                    nudge_autohide_taskbar_frame(&window);
                }
            }

            // Project API owner bridge: requests go to the main window. Agents'
            // calls consume it in every build (track T slice T2b-1).
            project_api::install_bridge(app.handle().clone());

            // Initialize the app-level SQLite database (recent projects, preferences).
            if let Err(e) = db::app_db::open_app_db() {
                eprintln!("[setup] app database init failed: {e}");
            }

            // Extract bundled Node.js to app-data on a background thread.
            // Non-blocking — if an LSP session starts before extraction
            // completes, it falls back to global Node.js on PATH.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("bundled-node-extract".into())
                .spawn(move || {
                    match bundled_runtime::ensure_node_extracted(&handle) {
                        Ok(path) => {
                            eprintln!(
                                "[setup] bundled Node.js ready at {}",
                                path.display()
                            );
                        }
                        Err(e) => {
                            // Not fatal — global Node.js on PATH is the fallback.
                            eprintln!("[setup] bundled Node.js extraction skipped: {e}");
                        }
                    }
                })
                .ok();

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                // Agent connections first: fence new project calls before
                // anything they could reach goes away (brief §6). Runs once.
                mcp_connection::quit();
                // Bounded, runs once (the second event returns at once), and
                // waits for teardowns already running.
                terminal_session_manager::quit();
                let _ = lsp::session::teardown_all_sessions();
                #[cfg(all(debug_assertions, target_os = "windows"))]
                kill_dev_server();
            }
            _ => {}
        }
    });
}

/// Re-run the non-client frame calculation once the main window exists
/// (Windows only).
///
/// The window is created already-maximized and borderless (`maximized: true`
/// + `decorations: false`), and tao's WM_NCCALCSIZE handler — which clamps a
/// maximized borderless window to the monitor work area and reserves 1px on
/// any auto-hide-taskbar edge — runs during creation, before its
/// ABM_GETAUTOHIDEBAR query can succeed. Without that 1px the client area
/// covers every pixel of the monitor, the shell classifies the window as a
/// fullscreen app, and the auto-hide taskbar is demoted below it whenever
/// Litria has focus (hover-to-reveal goes dead; only the Win key works).
/// Forcing a frame recalc after startup re-runs the handler at a time the
/// query works. Flicker-free; no-op when nothing needs adjusting.
#[cfg(windows)]
fn nudge_autohide_taskbar_frame(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        let _ = SetWindowPos(
            HWND(hwnd.0),
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

/// Kill the Vite dev server on app exit (dev mode, Windows only).
///
/// `beforeDevCommand: "npm run dev"` spawns a chain of cmd.exe/npm shell
/// wrappers. Windows doesn't propagate kills through that chain, so Vite
/// (node.exe on port 1420) outlives the Tauri app and locks the VS Code
/// terminal. This finds and kills the process listening on that port.
#[cfg(all(debug_assertions, target_os = "windows"))]
fn kill_dev_server() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const DEV_PORT: &str = ":1420";
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = match Command::new("cmd")
        .args(["/C", "netstat -ano"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(o) => o,
        Err(_) => return,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // Format: TCP  0.0.0.0:1420  0.0.0.0:0  LISTENING  <PID>
        if tokens.len() >= 5
            && tokens[1].ends_with(DEV_PORT)
            && tokens[3] == "LISTENING"
        {
            if let Ok(pid) = tokens[4].parse::<u32>() {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
            }
        }
    }
}
