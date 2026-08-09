// Preferences store (ADR-019, Slice 1).
//
// All user preferences — global today, per-project in Slice 2 — live as
// human-readable toml files in a dedicated `preferences/` folder inside the
// app data dir. This file owns `global.litria.toml`.
//
// Boundaries this module enforces:
// - The repo's `litria.toml` is NOT a preferences store (project declarations
//   only); this module never touches project folders.
// - The app SQLite `preferences` table holds persisted UI state (HUD layout),
//   not preferences. The one-time migration below drains the two historical
//   preference keys (`appearance`, `energyLevel`) out of it; existence of
//   `global.litria.toml` means migration already happened.
// - Parse failures never clobber a hand-edited file: loads return an error
//   and saves refuse, so the user's toml survives for manual repair.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::errors::{CommandError, CommandResult};
use crate::write_ops;

const GLOBAL_FILE: &str = "global.litria.toml";
const SCHEMA_VERSION: i64 = 1;
const FILE_HEADER: &str =
    "# Litria global preferences — hand-editable.\n# Values here are how Litria behaves for you, across all projects.\n\n";

/// Legacy SQLite preference keys that migrate into the global toml exactly
/// once, when the file is first created.
// Consumed only by the migrated_keys_constant_matches_migration_behavior
// test — kept beside the migration as its written contract.
#[cfg_attr(not(test), allow(dead_code))]
const MIGRATED_KEYS: [&str; 2] = ["appearance", "energyLevel"];

pub(crate) fn preferences_dir() -> Result<PathBuf, String> {
    Ok(crate::db::app_db::app_data_dir()?.join("preferences"))
}

// ---------------------------------------------------------------------------
// JSON <-> toml value conversion
//
// The JS side speaks JSON; the file speaks toml. Conversion is total except
// for JSON null, which toml cannot represent — registry types avoid null, and
// "unset" is modeled as key absence.
// ---------------------------------------------------------------------------

fn json_to_toml(value: &serde_json::Value) -> Result<toml::Value, String> {
    match value {
        serde_json::Value::Null => Err("Preferences cannot store null; unset the key instead.".to_string()),
        serde_json::Value::Bool(b) => Ok(toml::Value::Boolean(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(toml::Value::Integer(i))
            } else if let Some(f) = n.as_f64() {
                Ok(toml::Value::Float(f))
            } else {
                Err(format!("Unsupported number in preference value: {n}"))
            }
        }
        serde_json::Value::String(s) => Ok(toml::Value::String(s.clone())),
        serde_json::Value::Array(items) => Ok(toml::Value::Array(
            items.iter().map(json_to_toml).collect::<Result<_, _>>()?,
        )),
        serde_json::Value::Object(map) => {
            let mut table = toml::Table::new();
            for (k, v) in map {
                table.insert(k.clone(), json_to_toml(v)?);
            }
            Ok(toml::Value::Table(table))
        }
    }
}

fn toml_to_json(value: &toml::Value) -> serde_json::Value {
    match value {
        toml::Value::Boolean(b) => serde_json::Value::Bool(*b),
        toml::Value::Integer(i) => serde_json::json!(i),
        toml::Value::Float(f) => serde_json::json!(f),
        toml::Value::String(s) => serde_json::Value::String(s.clone()),
        toml::Value::Datetime(dt) => serde_json::Value::String(dt.to_string()),
        toml::Value::Array(items) => serde_json::Value::Array(items.iter().map(toml_to_json).collect()),
        toml::Value::Table(table) => serde_json::Value::Object(
            table.iter().map(|(k, v)| (k.clone(), toml_to_json(v))).collect(),
        ),
    }
}

// ---------------------------------------------------------------------------
// File shape
// ---------------------------------------------------------------------------

fn serialize_doc(prefs: &toml::Table) -> Result<String, String> {
    let mut doc = toml::Table::new();
    let mut meta = toml::Table::new();
    meta.insert("schema".to_string(), toml::Value::Integer(SCHEMA_VERSION));
    doc.insert("meta".to_string(), toml::Value::Table(meta));
    doc.insert("preferences".to_string(), toml::Value::Table(prefs.clone()));
    let body = toml::to_string(&doc).map_err(|e| format!("Failed to serialize preferences: {e}"))?;
    Ok(format!("{FILE_HEADER}{body}"))
}

fn parse_doc(content: &str, label: &str) -> Result<toml::Table, String> {
    let doc: toml::Table = content
        .parse()
        .map_err(|e| format!("{label} is not valid toml (file left untouched): {e}"))?;
    match doc.get("preferences") {
        Some(toml::Value::Table(table)) => Ok(table.clone()),
        Some(_) => Err(format!("{label}: [preferences] is not a table (file left untouched).")),
        None => Ok(toml::Table::new()),
    }
}

// ---------------------------------------------------------------------------
// Core operations (dir + legacy injected for testability)
// ---------------------------------------------------------------------------

/// Build the initial [preferences] table from the legacy SQLite rows. Values
/// that fail to parse are skipped — a bad legacy row must not block boot.
fn migrated_prefs(legacy: &HashMap<String, String>) -> toml::Table {
    let mut prefs = toml::Table::new();
    if let Some(level) = legacy.get("energyLevel") {
        if level == "live" || level == "calm" {
            prefs.insert("energyLevel".to_string(), toml::Value::String(level.clone()));
        }
    }
    if let Some(raw) = legacy.get("appearance") {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Ok(value) = json_to_toml(&json) {
                prefs.insert("appearance".to_string(), value);
            }
        }
    }
    prefs
}

/// Load the global preferences as a JSON object. Creates the folder and file
/// on first call, migrating the historical keys out of the legacy SQLite map.
pub(crate) fn load_global(dir: &Path, legacy: &HashMap<String, String>) -> Result<serde_json::Value, String> {
    let path = dir.join(GLOBAL_FILE);
    if !path.exists() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create preferences directory: {e}"))?;
        let prefs = migrated_prefs(legacy);
        write_ops::atomic_write_string(&path, &serialize_doc(&prefs)?)?;
        return Ok(toml_to_json(&toml::Value::Table(prefs)));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read global preferences: {e}"))?;
    let prefs = parse_doc(&content, GLOBAL_FILE)?;
    Ok(toml_to_json(&toml::Value::Table(prefs)))
}

/// Persist one preference into the global file (read-modify-write, atomic).
/// Refuses to overwrite a file it cannot parse.
pub(crate) fn save_global(dir: &Path, key: &str, value: &serde_json::Value) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("Preference key must not be empty.".to_string());
    }
    let path = dir.join(GLOBAL_FILE);
    let mut prefs = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read global preferences: {e}"))?;
        parse_doc(&content, GLOBAL_FILE)?
    } else {
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create preferences directory: {e}"))?;
        toml::Table::new()
    };
    prefs.insert(key.to_string(), json_to_toml(value)?);
    write_ops::atomic_write_string(&path, &serialize_doc(&prefs)?)
}

// ---------------------------------------------------------------------------
// Per-project preferences (ADR-019 Slice 2)
//
// One file per project in the same folder: `<name>-<shorthash>.litria.toml`.
// The filename is readable, not authoritative — identity is minted once at
// creation and lives in the file's [meta] block (project path + name), so the
// app-DB mapping is a rebuildable index and a lost row only costs a folder
// scan. Files are never deleted here (recents-removal is not project
// deletion; cleanup is a later, explicit affordance).
// ---------------------------------------------------------------------------

const PROJECT_FILE_HEADER: &str =
    "# Litria project preferences — hand-editable.\n# Refinements for one project; anything unset here inherits the global file.\n\n";

fn sanitize_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 24 {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() { "project".to_string() } else { trimmed }
}

/// Minted once when the file is created and remembered via [meta] + the DB
/// mapping — a birth certificate, not a fingerprint. Renames and moves never
/// recompute it.
fn mint_project_filename(name: &str, project_path: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    project_path.hash(&mut hasher);
    format!("{}-{:06x}.litria.toml", sanitize_name(name), hasher.finish() & 0xff_ffff)
}

fn serialize_project_doc(project_path: &str, project_name: &str, prefs: &toml::Table) -> Result<String, String> {
    let mut doc = toml::Table::new();
    let mut meta = toml::Table::new();
    meta.insert("schema".to_string(), toml::Value::Integer(SCHEMA_VERSION));
    meta.insert("project_path".to_string(), toml::Value::String(project_path.to_string()));
    meta.insert("project_name".to_string(), toml::Value::String(project_name.to_string()));
    doc.insert("meta".to_string(), toml::Value::Table(meta));
    doc.insert("preferences".to_string(), toml::Value::Table(prefs.clone()));
    let body = toml::to_string(&doc).map_err(|e| format!("Failed to serialize preferences: {e}"))?;
    Ok(format!("{PROJECT_FILE_HEADER}{body}"))
}

fn meta_project_path(content: &str) -> Option<String> {
    let doc: toml::Table = content.parse().ok()?;
    doc.get("meta")?
        .get("project_path")?
        .as_str()
        .map(|s| s.to_string())
}

fn meta_project_name(content: &str) -> Option<String> {
    let doc: toml::Table = content.parse().ok()?;
    doc.get("meta")?
        .get("project_name")?
        .as_str()
        .map(|s| s.to_string())
}

/// Resolve (and lazily create) the preferences file for a project.
/// Returns the file path plus `Some(filename)` when the caller should persist
/// a new/re-linked DB mapping.
fn resolve_project_file(
    dir: &Path,
    project_path: &str,
    project_name: &str,
    mapped: Option<&str>,
) -> Result<(PathBuf, Option<String>), String> {
    // Fast path: the DB mapping points at an existing file.
    if let Some(file) = mapped {
        let path = dir.join(file);
        if path.exists() {
            return Ok((path, None));
        }
    }

    // Re-link: scan for a self-describing file whose [meta] claims this project
    // (survives DB resets and mapping loss).
    if dir.exists() {
        for entry in std::fs::read_dir(dir).map_err(|e| format!("Failed to scan preferences directory: {e}"))? {
            let entry = entry.map_err(|e| format!("Failed to scan preferences directory: {e}"))?;
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name == GLOBAL_FILE || !file_name.ends_with(".litria.toml") {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                if meta_project_path(&content).as_deref() == Some(project_path) {
                    return Ok((entry.path(), Some(file_name)));
                }
            }
        }
    }

    // Mint: first contact with this project (or a pre-ADR project).
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create preferences directory: {e}"))?;
    let file_name = mint_project_filename(project_name, project_path);
    let path = dir.join(&file_name);
    write_ops::atomic_write_string(&path, &serialize_project_doc(project_path, project_name, &toml::Table::new())?)?;
    Ok((path, Some(file_name)))
}

fn read_project_prefs(path: &Path) -> Result<toml::Table, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read project preferences: {e}"))?;
    parse_doc(&content, &path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
}

pub(crate) fn load_project(
    dir: &Path,
    project_path: &str,
    project_name: &str,
    mapped: Option<&str>,
) -> Result<(serde_json::Value, Option<String>), String> {
    let (path, new_mapping) = resolve_project_file(dir, project_path, project_name, mapped)?;
    let prefs = read_project_prefs(&path)?;
    Ok((toml_to_json(&toml::Value::Table(prefs)), new_mapping))
}

/// Write one project-layer preference. Preserves the file's existing [meta]
/// identity (name may have changed since minting — the file keeps its own).
fn write_project_prefs(path: &Path, project_path: &str, fallback_name: &str, prefs: &toml::Table) -> Result<(), String> {
    let name = std::fs::read_to_string(path)
        .ok()
        .and_then(|c| meta_project_name(&c))
        .unwrap_or_else(|| fallback_name.to_string());
    write_ops::atomic_write_string(path, &serialize_project_doc(project_path, &name, prefs)?)
}

pub(crate) fn save_project(
    dir: &Path,
    project_path: &str,
    project_name: &str,
    mapped: Option<&str>,
    key: &str,
    value: &serde_json::Value,
) -> Result<Option<String>, String> {
    if key.trim().is_empty() {
        return Err("Preference key must not be empty.".to_string());
    }
    let (path, new_mapping) = resolve_project_file(dir, project_path, project_name, mapped)?;
    let mut prefs = read_project_prefs(&path)?;
    prefs.insert(key.to_string(), json_to_toml(value)?);
    write_project_prefs(&path, project_path, project_name, &prefs)?;
    Ok(new_mapping)
}

/// Remove one project-layer override (reset to global).
pub(crate) fn clear_project(
    dir: &Path,
    project_path: &str,
    project_name: &str,
    mapped: Option<&str>,
    key: &str,
) -> Result<Option<String>, String> {
    let (path, new_mapping) = resolve_project_file(dir, project_path, project_name, mapped)?;
    let mut prefs = read_project_prefs(&path)?;
    if prefs.remove(key).is_some() {
        write_project_prefs(&path, project_path, project_name, &prefs)?;
    }
    Ok(new_mapping)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn prefs_load_global() -> CommandResult<serde_json::Value> {
    let dir = preferences_dir().map_err(CommandError::from_text)?;
    // Legacy rows feed the one-time migration; if the app DB is somehow not
    // open yet, an empty map only means the migration seeds an empty file.
    let legacy = crate::db::app_db::load_preferences().unwrap_or_default();
    load_global(&dir, &legacy).map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn prefs_save_global(key: String, value: serde_json::Value) -> CommandResult<()> {
    let dir = preferences_dir().map_err(CommandError::from_text)?;
    save_global(&dir, &key, &value).map_err(CommandError::from_text)
}

fn project_context(project_path: &str) -> Result<(PathBuf, String, Option<String>), String> {
    let dir = preferences_dir()?;
    let name = crate::db::app_db::get_project_name(project_path)
        .ok()
        .flatten()
        .unwrap_or_else(|| {
            Path::new(project_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "project".to_string())
        });
    let mapped = crate::db::app_db::get_project_prefs_file(project_path).ok().flatten();
    Ok((dir, name, mapped))
}

fn persist_mapping(project_path: &str, new_mapping: Option<String>) {
    if let Some(file) = new_mapping {
        // Mapping is a rebuildable index — failure to cache it is not fatal.
        let _ = crate::db::app_db::set_project_prefs_file(project_path, &file);
    }
}

#[tauri::command]
pub(crate) fn prefs_load_project(project_path: String) -> CommandResult<serde_json::Value> {
    let (dir, name, mapped) = project_context(&project_path).map_err(CommandError::from_text)?;
    let (values, new_mapping) =
        load_project(&dir, &project_path, &name, mapped.as_deref()).map_err(CommandError::from_text)?;
    persist_mapping(&project_path, new_mapping);
    Ok(values)
}

#[tauri::command]
pub(crate) fn prefs_save_project(project_path: String, key: String, value: serde_json::Value) -> CommandResult<()> {
    let (dir, name, mapped) = project_context(&project_path).map_err(CommandError::from_text)?;
    let new_mapping = save_project(&dir, &project_path, &name, mapped.as_deref(), &key, &value)
        .map_err(CommandError::from_text)?;
    persist_mapping(&project_path, new_mapping);
    Ok(())
}

#[tauri::command]
pub(crate) fn prefs_clear_project(project_path: String, key: String) -> CommandResult<()> {
    let (dir, name, mapped) = project_context(&project_path).map_err(CommandError::from_text)?;
    let new_mapping = clear_project(&dir, &project_path, &name, mapped.as_deref(), &key)
        .map_err(CommandError::from_text)?;
    persist_mapping(&project_path, new_mapping);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("litria-prefs-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn first_load_creates_file_and_migrates_legacy_keys() {
        let dir = temp_dir("migrate");
        let mut legacy = HashMap::new();
        legacy.insert("energyLevel".to_string(), "calm".to_string());
        legacy.insert(
            "appearance".to_string(),
            r#"{"activeThemeId":"obsidian","themes":{}}"#.to_string(),
        );
        legacy.insert("hudState".to_string(), "{\"x\":1}".to_string());

        let loaded = load_global(&dir, &legacy).expect("first load should succeed");
        assert_eq!(loaded["energyLevel"], "calm");
        assert_eq!(loaded["appearance"]["activeThemeId"], "obsidian");
        // UI state is not a preference — it must not migrate.
        assert!(loaded.get("hudState").is_none());
        assert!(dir.join(GLOBAL_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_skips_invalid_legacy_values() {
        let dir = temp_dir("bad-legacy");
        let mut legacy = HashMap::new();
        legacy.insert("energyLevel".to_string(), "chaotic".to_string());
        legacy.insert("appearance".to_string(), "not json".to_string());

        let loaded = load_global(&dir, &legacy).expect("load should succeed despite bad rows");
        assert_eq!(loaded, serde_json::json!({}));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_runs_once_not_on_every_load() {
        let dir = temp_dir("once");
        let mut legacy = HashMap::new();
        legacy.insert("energyLevel".to_string(), "calm".to_string());
        load_global(&dir, &legacy).expect("first load");

        // Legacy changes after migration must not leak into later loads.
        legacy.insert("energyLevel".to_string(), "live".to_string());
        let loaded = load_global(&dir, &legacy).expect("second load");
        assert_eq!(loaded["energyLevel"], "calm");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_roundtrips_nested_values() {
        let dir = temp_dir("roundtrip");
        load_global(&dir, &HashMap::new()).expect("seed file");
        let appearance = serde_json::json!({
            "activeThemeId": "glass",
            "themes": { "glass": { "name": "Glass", "tokens": { "nodeLedSize": 28 } } }
        });
        save_global(&dir, "appearance", &appearance).expect("save should succeed");
        save_global(&dir, "energyLevel", &serde_json::json!("calm")).expect("save should succeed");

        let loaded = load_global(&dir, &HashMap::new()).expect("load");
        assert_eq!(loaded["appearance"], appearance);
        assert_eq!(loaded["energyLevel"], "calm");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_errors_without_being_overwritten() {
        let dir = temp_dir("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(GLOBAL_FILE);
        std::fs::write(&path, "this is [not toml").unwrap();

        assert!(load_global(&dir, &HashMap::new()).is_err());
        assert!(save_global(&dir, "energyLevel", &serde_json::json!("calm")).is_err());
        // The broken file must survive for manual repair.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "this is [not toml");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn null_values_are_rejected() {
        let dir = temp_dir("null");
        load_global(&dir, &HashMap::new()).expect("seed file");
        assert!(save_global(&dir, "appearance", &serde_json::Value::Null).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_file_minted_with_meta_and_readable_name() {
        let dir = temp_dir("proj-mint");
        let (values, mapping) =
            load_project(&dir, r"C:\work\My App!", "My App!", None).expect("first load mints");
        assert_eq!(values, serde_json::json!({}));
        let file = mapping.expect("new mapping returned");
        assert!(file.starts_with("my-app-"), "sanitized name prefix, got {file}");
        assert!(file.ends_with(".litria.toml"));
        let content = std::fs::read_to_string(dir.join(&file)).unwrap();
        assert!(content.contains("project_path"));
        assert!(content.contains("My App!"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_save_clear_roundtrip() {
        let dir = temp_dir("proj-rt");
        let mapping = save_project(&dir, "/p/alpha", "alpha", None, "energyLevel", &serde_json::json!("calm"))
            .expect("save mints + writes");
        let file = mapping.expect("mapping");
        let (values, _) = load_project(&dir, "/p/alpha", "alpha", Some(&file)).expect("load");
        assert_eq!(values["energyLevel"], "calm");

        clear_project(&dir, "/p/alpha", "alpha", Some(&file), "energyLevel").expect("clear");
        let (values, _) = load_project(&dir, "/p/alpha", "alpha", Some(&file)).expect("reload");
        assert!(values.get("energyLevel").is_none(), "override removed = reset to global");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn relink_by_meta_survives_lost_mapping() {
        let dir = temp_dir("proj-relink");
        let file = save_project(&dir, "/p/beta", "beta", None, "energyLevel", &serde_json::json!("calm"))
            .expect("mint")
            .expect("mapping");
        // Mapping lost (DB reset): resolve must find the file by [meta] scan.
        let (values, remapped) = load_project(&dir, "/p/beta", "beta", None).expect("relink load");
        assert_eq!(values["energyLevel"], "calm");
        assert_eq!(remapped.as_deref(), Some(file.as_str()), "re-linked mapping returned for caching");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_name_different_paths_get_distinct_files() {
        let dir = temp_dir("proj-collide");
        let a = save_project(&dir, "/clientA/api", "api", None, "energyLevel", &serde_json::json!("calm"))
            .unwrap().unwrap();
        let b = save_project(&dir, "/clientB/api", "api", None, "energyLevel", &serde_json::json!("live"))
            .unwrap().unwrap();
        assert_ne!(a, b, "name collision must not share a file");
        let (va, _) = load_project(&dir, "/clientA/api", "api", None).unwrap();
        let (vb, _) = load_project(&dir, "/clientB/api", "api", None).unwrap();
        assert_eq!(va["energyLevel"], "calm");
        assert_eq!(vb["energyLevel"], "live");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_scan_never_matches_the_global_file() {
        let dir = temp_dir("proj-vs-global");
        load_global(&dir, &HashMap::new()).expect("seed global");
        let (_, mapping) = load_project(&dir, "/p/gamma", "gamma", None).expect("load project");
        assert!(mapping.is_some(), "must mint its own file, not adopt global");
        assert_ne!(mapping.unwrap(), GLOBAL_FILE);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrated_keys_constant_matches_migration_behavior() {
        // Guard against the constant and the code drifting apart.
        let mut legacy = HashMap::new();
        for key in MIGRATED_KEYS {
            legacy.insert(key.to_string(), "live".to_string());
        }
        let prefs = migrated_prefs(&legacy);
        assert!(prefs.contains_key("energyLevel"));
        // appearance was not valid JSON here, so it is skipped — only shape matters.
        assert!(!prefs.contains_key("appearance"));
    }
}
