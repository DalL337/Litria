//! Types for the New Project scaffold system.
//!
//! These types define the data contract between the React frontend (New Project
//! wizard) and the Rust scaffold runner.  Enums use serde renames so the JSON
//! values match the prototype's card `emitValue` strings exactly.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Inbound: frontend → Rust
// ---------------------------------------------------------------------------

/// Desktop/web wrapper selection from the stack picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ScaffoldWrapper {
    Tauri,
    Electron,
    Web,
}

/// Frontend framework selection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ScaffoldFramework {
    React,
    Svelte,
    Vue,
    Angular,
    Solid,
}

/// Programming language selection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) enum ScaffoldLanguage {
    #[serde(rename = "ts")]
    TypeScript,
    #[serde(rename = "js")]
    JavaScript,
}

/// Backend framework (Web Only wrapper, optional).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ScaffoldBackend {
    Express,
    Fastify,
    Axum,
}

/// Addon selections (multi-select).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) enum ScaffoldAddon {
    #[serde(rename = "tailwind")]
    Tailwind,
    #[serde(rename = "shadcn")]
    ShadCN,
    #[serde(rename = "router")]
    Router,
}

/// Package manager selection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
}

/// Full scaffold configuration from the New Project wizard.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScaffoldConfig {
    /// Project name (used as directory name and scaffold CLI arg).
    pub project_name: String,
    /// Parent directory where the project folder will be created.
    pub project_location: String,
    pub wrapper: ScaffoldWrapper,
    pub framework: ScaffoldFramework,
    pub language: ScaffoldLanguage,
    pub backend: Option<ScaffoldBackend>,
    pub addons: Vec<ScaffoldAddon>,
    pub manager: PackageManager,
    pub theme: String,
    /// Exact pinned spec (`name@X.Y.Z`) for the primary create CLI, supplied
    /// by the frontend pin registry (`src/scaffold/create-cli-versions.js`,
    /// ADR-021 §1). The runner refuses bare, ranged, or tagged specs.
    pub create_cli_spec: String,
    /// Exact pinned specs for addon CLIs executed at scaffold time, keyed by
    /// package name (e.g. `shadcn` → `shadcn@4.13.0`). Same exactness rule.
    #[serde(default)]
    pub addon_cli_specs: std::collections::HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Outbound: Rust → frontend
// ---------------------------------------------------------------------------

/// Result of a completed scaffold operation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScaffoldResult {
    pub success: bool,
    /// Full path to the created project directory.
    pub project_path: String,
    pub steps_completed: Vec<String>,
    pub errors: Vec<String>,
    /// True when dependency lifecycle scripts were skipped (npm path,
    /// ADR-021 §3) — drives the first-open consent pill.
    pub scripts_skipped: bool,
    /// Advisory audit outcome (ADR-021 §4):
    /// "skipped" | "clean" | "findings" | "unavailable".
    pub audit_status: String,
}

/// Progress events streamed to the frontend via `Channel` during scaffold.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ScaffoldEvent {
    /// A scaffold step is starting.
    #[serde(rename_all = "camelCase")]
    StepStarted { label: String, step: u32, total: u32 },
    /// A line of stdout/stderr output from the running process.
    #[serde(rename_all = "camelCase")]
    StepOutput { line: String },
    /// A scaffold step completed successfully.
    #[serde(rename_all = "camelCase")]
    StepCompleted { label: String, step: u32 },
    /// A scaffold step failed.
    #[serde(rename_all = "camelCase")]
    StepFailed { label: String, step: u32, error: String },
    /// Advisory warning surfaced in the progress feed (e.g. the ADR-021 §2
    /// age gate failing open when registry metadata is unreachable).
    #[serde(rename_all = "camelCase")]
    Warning { line: String },
    /// All steps finished.
    #[serde(rename_all = "camelCase")]
    Done { success: bool },
}

/// Tool availability status for a single prerequisite.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolStatus {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    /// How the tool was found: `"global"` (PATH) or `"bundled"` (shipped with CM).
    pub source: Option<String>,
}

/// Result of prerequisite checking.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrerequisiteResult {
    /// True if all required tools are available.
    pub ready: bool,
    pub tools: Vec<ToolStatus>,
    /// Human-readable message when not ready.
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_config_deserializes_from_json() {
        let json = r#"{
            "projectName": "my-app",
            "projectLocation": "/home/user/projects",
            "wrapper": "tauri",
            "framework": "react",
            "language": "ts",
            "backend": null,
            "addons": ["tailwind", "shadcn"],
            "manager": "npm",
            "theme": "glass",
            "createCliSpec": "tauri-app@4.6.2",
            "addonCliSpecs": { "shadcn": "shadcn@4.13.0" }
        }"#;
        let config: ScaffoldConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.project_name, "my-app");
        assert_eq!(config.create_cli_spec, "tauri-app@4.6.2");
        assert_eq!(
            config.addon_cli_specs.get("shadcn").map(String::as_str),
            Some("shadcn@4.13.0")
        );
        assert!(matches!(config.wrapper, ScaffoldWrapper::Tauri));
        assert!(matches!(config.framework, ScaffoldFramework::React));
        assert!(matches!(config.language, ScaffoldLanguage::TypeScript));
        assert!(config.backend.is_none());
        assert_eq!(config.addons.len(), 2);
        assert!(matches!(config.manager, PackageManager::Npm));
    }

    #[test]
    fn scaffold_config_with_backend() {
        let json = r#"{
            "projectName": "web-app",
            "projectLocation": "C:\\Projects",
            "wrapper": "web",
            "framework": "vue",
            "language": "js",
            "backend": "express",
            "addons": [],
            "manager": "pnpm",
            "theme": "glass",
            "createCliSpec": "vite@9.1.1"
        }"#;
        let config: ScaffoldConfig = serde_json::from_str(json).unwrap();
        assert!(matches!(config.wrapper, ScaffoldWrapper::Web));
        assert!(matches!(config.backend, Some(ScaffoldBackend::Express)));
        assert!(matches!(config.manager, PackageManager::Pnpm));
        // addonCliSpecs omitted → defaults to an empty map.
        assert!(config.addon_cli_specs.is_empty());
    }

    #[test]
    fn warning_event_serializes_with_tag() {
        let event = ScaffoldEvent::Warning {
            line: "Couldn't verify release age".into(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""kind":"warning""#));
        assert!(json.contains(r#""line":"Couldn't verify release age""#));
    }

    #[test]
    fn scaffold_event_serializes_with_tag() {
        let event = ScaffoldEvent::StepStarted {
            label: "Creating project".into(),
            step: 1,
            total: 3,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""kind":"stepStarted""#));
        assert!(json.contains(r#""label":"Creating project""#));
    }

    #[test]
    fn scaffold_result_serializes_gate_fields() {
        let result = ScaffoldResult {
            success: true,
            project_path: "/p".into(),
            steps_completed: vec![],
            errors: vec![],
            scripts_skipped: true,
            audit_status: "clean".into(),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""auditStatus":"clean""#));
        assert!(json.contains(r#""scriptsSkipped":true"#));
    }

    #[test]
    fn prerequisite_result_serializes() {
        let result = PrerequisiteResult {
            ready: false,
            tools: vec![ToolStatus {
                name: "Node.js".into(),
                available: true,
                version: Some("v22.0.0".into()),
                source: Some("global".into()),
            }],
            message: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""ready":false"#));
        assert!(json.contains(r#""available":true"#));
    }
}
