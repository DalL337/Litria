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

impl ScaffoldWrapper {
    /// Registry id (`src/scaffold/recipes.json` wrapper key).
    pub(crate) fn id(&self) -> &'static str {
        match self {
            ScaffoldWrapper::Tauri => "tauri",
            ScaffoldWrapper::Electron => "electron",
            ScaffoldWrapper::Web => "web",
        }
    }
}

impl ScaffoldFramework {
    pub(crate) fn id(&self) -> &'static str {
        match self {
            ScaffoldFramework::React => "react",
            ScaffoldFramework::Svelte => "svelte",
            ScaffoldFramework::Vue => "vue",
            ScaffoldFramework::Angular => "angular",
            ScaffoldFramework::Solid => "solid",
        }
    }
}

impl ScaffoldLanguage {
    pub(crate) fn id(&self) -> &'static str {
        match self {
            ScaffoldLanguage::TypeScript => "ts",
            ScaffoldLanguage::JavaScript => "js",
        }
    }
}

impl PackageManager {
    pub(crate) fn id(&self) -> &'static str {
        match self {
            PackageManager::Npm => "npm",
            PackageManager::Pnpm => "pnpm",
            PackageManager::Yarn => "yarn",
        }
    }
}

/// The plan the wizard previewed and is asking the runner to execute
/// (ADR-028 §2). The runner re-derives every field from the recipe
/// registry and refuses the request when any of them differ, so the webview
/// can describe the plan but never choose it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScaffoldPlanPayload {
    pub schema_version: u32,
    /// `initializer` (`<pm> create <name>`) or `exec` (run a named package).
    pub route_kind: String,
    /// Registry tool name (`create-vite`).
    pub package: String,
    pub version: String,
    pub template: String,
    /// Everything after the manager executable, as the preview showed it.
    pub argv: Vec<String>,
    /// The platform the wizard evaluated coverage for.
    pub platform: String,
    /// Post-scaffold steps as previewed (ADR-028 §4): Electron framework
    /// wiring, add-ons in prerequisite order, backend. Raw JSON; the runner
    /// re-derives the same list from the registry and refuses a mismatch.
    #[serde(default)]
    pub steps: Vec<serde_json::Value>,
    /// Subprocess limits per step kind as previewed (ADR-028 §8); the runner
    /// compares them with the registry like every other plan field.
    #[serde(default)]
    pub limits: Option<crate::scaffold_recipes::Limits>,
}

impl ScaffoldBackend {
    pub(crate) fn id(&self) -> &'static str {
        match self {
            ScaffoldBackend::Express => "express",
            ScaffoldBackend::Fastify => "fastify",
            ScaffoldBackend::Axum => "axum",
        }
    }
}

impl ScaffoldAddon {
    pub(crate) fn id(&self) -> &'static str {
        match self {
            ScaffoldAddon::Tailwind => "tailwind",
            ScaffoldAddon::ShadCN => "shadcn",
            ScaffoldAddon::Router => "router",
        }
    }
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
    /// The previewed plan; validated against the registry before anything
    /// executes (ADR-028 §2). Pins live in `src/scaffold/recipes.json` only.
    pub plan: ScaffoldPlanPayload,
    /// The wizard's handle on this run — `cancel_scaffold(runId)` reaches
    /// the live subprocess through it (ADR-028 §8).
    #[serde(default)]
    pub run_id: Option<String>,
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
        // Mirrors what buildScaffoldPlan sends (ADR-028 §2): the selection
        // plus the derived `plan` block the runner re-checks.
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
            "plan": {
                "schemaVersion": 1,
                "routeKind": "initializer",
                "package": "create-tauri-app",
                "version": "4.6.2",
                "template": "react-ts",
                "argv": ["create", "--yes", "tauri-app@4.6.2", "my-app", "--", "--yes", "--template", "react-ts", "--manager", "npm"],
                "platform": "windows"
            }
        }"#;
        let config: ScaffoldConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.project_name, "my-app");
        assert_eq!(config.plan.route_kind, "initializer");
        assert_eq!(config.plan.package, "create-tauri-app");
        assert_eq!(config.plan.template, "react-ts");
        assert_eq!(config.plan.argv.len(), 10);
        assert_eq!(config.plan.platform, "windows");
        assert!(matches!(config.wrapper, ScaffoldWrapper::Tauri));
        assert!(matches!(config.framework, ScaffoldFramework::React));
        assert!(matches!(config.language, ScaffoldLanguage::TypeScript));
        assert!(config.backend.is_none());
        assert_eq!(config.addons.len(), 2);
        assert!(matches!(config.manager, PackageManager::Npm));
    }

    #[test]
    fn scaffold_config_requires_a_plan() {
        // The pre-ADR-028 shape (createCliSpec chosen by the webview) is no
        // longer accepted: without a plan there is nothing to validate.
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
        assert!(serde_json::from_str::<ScaffoldConfig>(json).is_err());
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
            "plan": {
                "schemaVersion": 1,
                "routeKind": "initializer",
                "package": "create-vite",
                "version": "9.1.1",
                "template": "vue",
                "argv": ["create", "vite@9.1.1", "web-app", "--template", "vue"],
                "platform": "linux"
            }
        }"#;
        let config: ScaffoldConfig = serde_json::from_str(json).unwrap();
        assert!(matches!(config.wrapper, ScaffoldWrapper::Web));
        assert!(matches!(config.backend, Some(ScaffoldBackend::Express)));
        assert!(matches!(config.manager, PackageManager::Pnpm));
        assert_eq!(config.wrapper.id(), "web");
        assert_eq!(config.framework.id(), "vue");
        assert_eq!(config.language.id(), "js");
        assert_eq!(config.manager.id(), "pnpm");
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
