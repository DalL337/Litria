// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The MCP helper an agent starts (track T, T1a): only the relay runs. No
    // window, no crash marker, no database: this is checked before anything.
    if std::env::args_os().nth(1).is_some_and(|arg| arg == litria_lib::MCP_HELPER_FLAG) {
        std::process::exit(litria_lib::run_mcp_helper());
    }
    litria_lib::run()
}
