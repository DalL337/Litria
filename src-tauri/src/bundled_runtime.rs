//! First-run extraction for bundled Node.js runtime.
//!
//! On macOS/Linux, the Tauri app bundle is code-signed and read-only.
//! On Windows, resources are in a read-only Program Files directory.
//! The bundled Node.js binary must be extracted to a writable app-data
//! location and (on Unix) marked executable before use.
//!
//! Extraction is idempotent — a `.node-version` marker tracks which
//! version is extracted.  On CM upgrade (new bundled Node), extraction
//! re-runs automatically.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::lsp::packs::versions;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Where extracted bundled runtimes live.
///
/// Platform-specific:
///   Windows: `%LOCALAPPDATA%/com.litria.app/runtimes/node/`
///   macOS:   `~/Library/Application Support/com.litria.app/runtimes/node/`
///   Linux:   `~/.local/share/com.litria.app/runtimes/node/`
pub(crate) fn extracted_node_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|p| p.join("runtimes").join("node"))
}

/// Path to the extracted node binary.
pub(crate) fn extracted_node_binary(app: &AppHandle) -> Option<PathBuf> {
    let dir = extracted_node_dir(app)?;
    let binary = if cfg!(windows) { "node.exe" } else { "bin/node" };
    Some(dir.join(binary))
}

/// Path to the extracted npm CLI script.
pub(crate) fn extracted_npm_cli(app: &AppHandle) -> Option<PathBuf> {
    let dir = extracted_node_dir(app)?;
    if cfg!(windows) {
        Some(dir.join("node_modules").join("npm").join("bin").join("npm-cli.js"))
    } else {
        Some(dir.join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"))
    }
}

/// Ensure the bundled Node.js binary is extracted and ready.
///
/// Idempotent: skips extraction if the correct version is already present.
///
/// Returns the path to the node binary on success, or an error string.
pub(crate) fn ensure_node_extracted(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?;

    // Tauri places array-style resources under a `resources/` subdirectory.
    let source_dir = resource_dir.join("resources").join("node");
    if !source_dir.exists() {
        return Err(format!(
            "Bundled Node.js not found in resources (looked at {})",
            source_dir.display()
        ));
    }

    let dest_dir = extracted_node_dir(app)
        .ok_or("Cannot determine app data directory")?;

    let version_marker = dest_dir.join(".node-version");
    let expected_version = versions::NODE_VERSION;

    // Check if already extracted at the correct version.
    if version_marker.exists() {
        let installed = fs::read_to_string(&version_marker).unwrap_or_default();
        if installed.trim() == expected_version {
            if let Some(binary) = extracted_node_binary(app) {
                if binary.exists() {
                    return Ok(binary);
                }
            }
        }
        // Wrong version or missing binary — re-extract below.
    }

    eprintln!(
        "[bundled_runtime] extracting Node.js {} to {}",
        expected_version,
        dest_dir.display()
    );

    // Clean previous extraction.
    if dest_dir.exists() {
        fs::remove_dir_all(&dest_dir)
            .map_err(|e| format!("cleanup {}: {e}", dest_dir.display()))?;
    }

    // Copy tree from resources to app-data.
    copy_dir_recursive(&source_dir, &dest_dir)?;

    // Set executable permission on Unix.
    #[cfg(unix)]
    set_unix_executable(&dest_dir)?;

    // Write version marker.
    fs::write(&version_marker, expected_version)
        .map_err(|e| format!("write version marker: {e}"))?;

    extracted_node_binary(app)
        .ok_or_else(|| "Cannot determine node binary path after extraction".into())
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("mkdir {}: {e}", dst.display()))?;

    let entries = fs::read_dir(src)
        .map_err(|e| format!("readdir {}: {e}", src.display()))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!("copy {} → {}: {e}", src_path.display(), dst_path.display())
            })?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_unix_executable(node_dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    // Set +x on the node binary and any bin/* scripts.
    let bin_dir = node_dir.join("bin");
    if bin_dir.exists() {
        for entry in fs::read_dir(&bin_dir)
            .map_err(|e| format!("readdir bin: {e}"))?
        {
            let entry = entry.map_err(|e| format!("entry: {e}"))?;
            let path = entry.path();
            if path.is_file() {
                let mut perms = fs::metadata(&path)
                    .map_err(|e| format!("metadata {}: {e}", path.display()))?
                    .permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&path, perms)
                    .map_err(|e| format!("chmod {}: {e}", path.display()))?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_dir_recursive_copies_nested_structure() {
        let tmp = std::env::temp_dir().join("cm_bundled_runtime_test");
        let src = tmp.join("src");
        let dst = tmp.join("dst");

        // Clean up from previous runs.
        let _ = fs::remove_dir_all(&tmp);

        // Create a nested source structure.
        fs::create_dir_all(src.join("a/b")).unwrap();
        fs::write(src.join("top.txt"), "hello").unwrap();
        fs::write(src.join("a/mid.txt"), "world").unwrap();
        fs::write(src.join("a/b/deep.txt"), "nested").unwrap();

        copy_dir_recursive(&src, &dst).unwrap();

        assert_eq!(fs::read_to_string(dst.join("top.txt")).unwrap(), "hello");
        assert_eq!(fs::read_to_string(dst.join("a/mid.txt")).unwrap(), "world");
        assert_eq!(fs::read_to_string(dst.join("a/b/deep.txt")).unwrap(), "nested");

        // Clean up.
        let _ = fs::remove_dir_all(&tmp);
    }
}
