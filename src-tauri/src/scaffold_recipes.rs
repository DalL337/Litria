//! Scaffold recipe registry (ADR-028 §1) — the Rust read side of
//! `src/scaffold/recipes.json`, compiled in with `include_str!` so the runner
//! and the wizard can never disagree about a pin, a template, a manager verb
//! or a support claim: both derive from the same bytes.
//!
//! ADR-028 §2: the wizard sends the plan it previewed; `derive_primary` here
//! rebuilds the primary argv from the registry and the runner refuses a
//! payload that differs (`scaffold.plan_mismatch`). The frontend therefore
//! cannot choose which version executes (F34) or show a command that will
//! not run (F14).
//!
//! ADR-028 §10: `coverage_status` answers whether a combination has the
//! execution evidence that makes it selectable on this platform with this
//! manager; the runner refuses the rest (`scaffold.recipe_unverified`).

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

const REGISTRY_JSON: &str = include_str!("../../src/scaffold/recipes.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Registry {
    pub schema_version: u32,
    pub tools: HashMap<String, Tool>,
    pub managers: HashMap<String, Manager>,
    pub wrappers: HashMap<String, Wrapper>,
    pub addons: HashMap<String, Addon>,
    pub coverage: Coverage,
}
// Registry fields the runner does not read yet (`recordedAt`, `frameworks`,
// `backends`, `templateManifests`, per-manager install verbs) are simply not
// declared here: serde ignores them, and each arrives with its consumer
// (S3 add-on ordering, S4 manager recipes) instead of as dead code.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tool {
    /// Short `npm create <invoke>` name for initializers (`vite` for
    /// create-vite). Absent for addon CLIs and exec-routed packages.
    #[serde(default)]
    pub invoke: Option<String>,
    pub version: String,
    pub kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manager {
    pub create: Vec<String>,
    #[serde(default)]
    pub forward_separator: Option<String>,
    pub exec: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Wrapper {
    pub kind: String,
    #[serde(default)]
    pub route: Option<Route>,
    #[serde(default)]
    pub templates: HashMap<String, HashMap<String, String>>,
    #[serde(default)]
    pub unsupported: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Route {
    pub kind: String,
    pub tool: String,
    pub args: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Addon {
    #[serde(default)]
    pub cli: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Coverage {
    pub entries: Vec<CoverageEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoverageEntry {
    pub wrapper: String,
    pub framework: String,
    pub language: String,
    pub manager: String,
    pub platform: String,
    pub status: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// The registry, parsed once. A malformed file is a build defect caught by
/// `registry_parses` below and by the JS suite, never a runtime state.
pub(crate) fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        serde_json::from_str(REGISTRY_JSON).expect("src/scaffold/recipes.json must parse (guarded by tests)")
    })
}

/// The primary route derived for one selection — what the runner executes
/// after the manager executable (and its bundled-npm prefix args).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DerivedPrimary {
    pub route_kind: String,
    /// Registry tool name (`create-vite`, `@angular/cli`).
    pub package: String,
    /// The name as invoked: the `npm create` short name for initializers,
    /// the package itself for exec routes.
    pub invoke: String,
    pub version: String,
    pub template: String,
    pub argv: Vec<String>,
}

impl DerivedPrimary {
    /// `name@X.Y.Z` as passed to the manager.
    pub(crate) fn spec(&self) -> String {
        format!("{}@{}", self.invoke, self.version)
    }
}

/// Assemble the primary argv exactly as `assemblePrimaryArgv` does in
/// src/scaffold/recipeRegistry.js. Errors name the reason a combination has
/// no route (an `unsupported` entry or a missing template).
pub(crate) fn derive_primary(
    wrapper: &str,
    framework: &str,
    language: &str,
    manager: &str,
    project_name: &str,
) -> Result<DerivedPrimary, String> {
    let reg = registry();
    let w = reg
        .wrappers
        .get(wrapper)
        .ok_or_else(|| format!("unknown wrapper '{wrapper}'"))?;
    if w.kind != "npm" {
        return Err(format!("wrapper '{wrapper}' has no npm route"));
    }
    let route = w
        .route
        .as_ref()
        .ok_or_else(|| format!("wrapper '{wrapper}' has no primary route"))?;
    let template = w
        .templates
        .get(framework)
        .and_then(|by_lang| by_lang.get(language))
        .cloned()
        .ok_or_else(|| {
            w.unsupported.get(framework).cloned().unwrap_or_else(|| {
                format!("{framework} ({language}) has no template on the {wrapper} wrapper.")
            })
        })?;
    let tool = reg
        .tools
        .get(&route.tool)
        .ok_or_else(|| format!("route tool '{}' is not pinned", route.tool))?;
    let m = reg
        .managers
        .get(manager)
        .ok_or_else(|| format!("unknown package manager '{manager}'"))?;

    let invoke = tool.invoke.clone().unwrap_or_else(|| route.tool.clone());
    let spec = format!("{invoke}@{}", tool.version);
    let substitute = |arg: &str| {
        arg.replace("{template}", &template)
            .replace("{manager}", manager)
            .replace("{name}", project_name)
    };
    let argv: Vec<String> = match route.kind.as_str() {
        "initializer" => {
            let mut argv = m.create.clone();
            argv.push(spec);
            argv.push(project_name.to_string());
            if let Some(sep) = &m.forward_separator {
                argv.push(sep.clone());
            }
            argv.extend(route.args.iter().map(|a| substitute(a)));
            argv
        }
        "exec" => {
            let mut argv = m.exec.clone();
            argv.push(spec);
            argv.extend(route.args.iter().map(|a| substitute(a)));
            argv
        }
        other => return Err(format!("unknown route kind '{other}'")),
    };

    Ok(DerivedPrimary {
        route_kind: route.kind.clone(),
        package: route.tool.clone(),
        invoke,
        version: tool.version.clone(),
        template,
        argv,
    })
}

/// Exact spec for a pinned addon CLI (`shadcn-vue@2.7.4`), or None when the
/// registry does not pin it — the caller must then skip the step rather than
/// execute an unpinned CLI (ADR-021 §1).
pub(crate) fn addon_cli_spec(cli: &str) -> Option<String> {
    registry()
        .tools
        .get(cli)
        .filter(|t| t.kind == "addon-cli")
        .map(|t| format!("{cli}@{}", t.version))
}

/// The shadcn variant CLI for a framework, from the registry's addon table.
pub(crate) fn shadcn_cli_for(framework: &str) -> Option<String> {
    registry()
        .addons
        .get("shadcn")
        .and_then(|a| a.cli.get(framework))
        .cloned()
}

/// Coverage status for one full combination on one platform; a missing entry
/// is `unverified` (brief §6: naming a gap is not permission to offer it).
pub(crate) fn coverage_status(
    wrapper: &str,
    framework: &str,
    language: &str,
    manager: &str,
    platform: &str,
) -> (String, Option<String>) {
    registry()
        .coverage
        .entries
        .iter()
        .find(|e| {
            e.wrapper == wrapper
                && e.framework == framework
                && e.language == language
                && e.manager == manager
                && e.platform == platform
        })
        .map(|e| (e.status.clone(), e.reason.clone()))
        .unwrap_or_else(|| ("unverified".to_string(), None))
}

pub(crate) fn is_selectable_status(status: &str) -> bool {
    matches!(status, "verified" | "covered-by-equivalence")
}

/// The platform id the coverage table uses for this build.
pub(crate) fn current_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES_JSON: &str = include_str!("../../test/fixtures/scaffold-plans/cases.json");

    #[derive(Deserialize)]
    struct CaseFile {
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        input: CaseInput,
        expect: CaseExpect,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CaseInput {
        wrapper: String,
        framework: String,
        language: String,
        manager: String,
        project_name: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CaseExpect {
        #[serde(default)]
        unsupported: bool,
        #[serde(default)]
        route_kind: String,
        #[serde(default)]
        package: String,
        #[serde(default)]
        version: String,
        #[serde(default)]
        template: String,
        #[serde(default)]
        argv: Vec<String>,
    }

    #[test]
    fn registry_parses() {
        let reg = registry();
        assert_eq!(reg.schema_version, 1);
        assert!(reg.tools.contains_key("create-vite"));
        assert!(reg.managers.contains_key("npm"));
        assert_eq!(reg.wrappers["python"].kind, "blueprint");
    }

    #[test]
    fn shared_plan_cases_derive_exactly_like_the_js_side() {
        let file: CaseFile = serde_json::from_str(CASES_JSON).expect("cases.json parses");
        assert!(file.cases.len() >= 10);
        for case in file.cases {
            let derived = derive_primary(
                &case.input.wrapper,
                &case.input.framework,
                &case.input.language,
                &case.input.manager,
                &case.input.project_name,
            );
            if case.expect.unsupported {
                assert!(derived.is_err(), "{}: expected unsupported", case.name);
                continue;
            }
            let derived = derived.unwrap_or_else(|e| panic!("{}: {e}", case.name));
            assert_eq!(derived.route_kind, case.expect.route_kind, "{}", case.name);
            assert_eq!(derived.package, case.expect.package, "{}", case.name);
            assert_eq!(derived.version, case.expect.version, "{}", case.name);
            assert_eq!(derived.template, case.expect.template, "{}", case.name);
            assert_eq!(derived.argv, case.expect.argv, "{}", case.name);
        }
    }

    #[test]
    fn web_angular_is_refused_with_the_angular_cli_reason() {
        let err = derive_primary("web", "angular", "ts", "npm", "demo").unwrap_err();
        assert!(err.contains("Angular CLI"), "{err}");
    }

    #[test]
    fn every_route_template_is_in_the_pinned_tool_manifest() {
        // Mirror of the JS F1 regression test, on the Rust read side.
        let value: serde_json::Value = serde_json::from_str(REGISTRY_JSON).unwrap();
        let manifests = value["templateManifests"].as_object().unwrap();
        for (id, w) in &registry().wrappers {
            let Some(route) = &w.route else { continue };
            let manifest = manifests[&route.tool].as_array().unwrap();
            for (framework, by_lang) in &w.templates {
                for (lang, template) in by_lang {
                    assert!(
                        manifest.iter().any(|t| t.as_str() == Some(template)),
                        "{id}/{framework}/{lang}: template {template} not shipped by {}",
                        route.tool
                    );
                }
            }
        }
    }

    #[test]
    fn coverage_defaults_to_unverified_and_is_not_selectable() {
        let (status, _) = coverage_status("web", "react", "ts", "yarn", "linux");
        assert_eq!(status, "unverified");
        assert!(!is_selectable_status(&status));
        assert!(is_selectable_status("verified"));
        assert!(is_selectable_status("covered-by-equivalence"));
        assert!(!is_selectable_status("failing"));
    }

    #[test]
    fn addon_cli_specs_come_from_the_registry() {
        assert_eq!(shadcn_cli_for("vue").as_deref(), Some("shadcn-vue"));
        assert_eq!(shadcn_cli_for("angular"), None);
        let spec = addon_cli_spec("shadcn-vue").unwrap();
        assert!(spec.starts_with("shadcn-vue@"));
        assert_eq!(addon_cli_spec("create-vite"), None, "initializers are not addon CLIs");
    }
}
