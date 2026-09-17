//! Scaffold recipe registry (ADR-028 §1) — the Rust read side of
//! `src/scaffold/recipes.json`, compiled in with `include_str!` so the runner
//! and the wizard can never disagree about a pin, a template, a manager verb,
//! an add-on step or a support claim: both derive from the same bytes.
//!
//! ADR-028 §2: the wizard sends the plan it previewed; `derive_primary` and
//! `derive_steps` here rebuild the primary argv and every post-scaffold step
//! from the registry and the runner refuses a payload that differs
//! (`scaffold.plan_mismatch`). The frontend therefore cannot choose which
//! version executes (F34), show a command that will not run (F14), or run an
//! add-on step it did not preview.
//!
//! ADR-028 §10: `coverage_status` / `addon_coverage_ok` answer whether a
//! combination has the execution evidence that makes it selectable on this
//! platform with this manager; the runner refuses the rest.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const REGISTRY_JSON: &str = include_str!("../../src/scaffold/recipes.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Registry {
    pub schema_version: u32,
    pub tools: HashMap<String, Tool>,
    pub managers: HashMap<String, Manager>,
    pub wrappers: HashMap<String, Wrapper>,
    pub addons: HashMap<String, Addon>,
    /// Explicit add-on order shared with the JS side (no ordered map here).
    pub addon_order: Vec<String>,
    pub backends: Backends,
    pub coverage: Coverage,
    pub addon_coverage: AddonCoverage,
    /// Subprocess limits per step kind (ADR-028 §8).
    pub limits: Limits,
    /// Generated-project package pins (`name → { version, … }`; the
    /// `$comment` key is a string). Read only to check evidence pins.
    #[serde(default)]
    pub packages: HashMap<String, Value>,
}

/// What a coverage entry's evidence was recorded against (ADR-028 §10,
/// dependency policy Rule 5). Other evidence fields are wizard/PR material.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvidencePins {
    #[serde(default)]
    pub pins: HashMap<String, String>,
}

/// The registry's current pin for a tool or generated-project package.
fn current_pin(reg: &Registry, name: &str) -> Option<String> {
    if let Some(tool) = reg.tools.get(name) {
        return Some(tool.version.clone());
    }
    reg.packages
        .get(name)
        .and_then(|v| v.get("version"))
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// Why an entry's evidence no longer applies, or None. Mirrors
/// `pinsOutOfDate` in recipeRegistry.js: evidence without recorded pins is
/// stale by definition; a pin that moved since names itself.
fn pins_out_of_date(reg: &Registry, evidence: Option<&EvidencePins>) -> Option<String> {
    let pins = evidence.map(|e| &e.pins).filter(|p| !p.is_empty());
    let Some(pins) = pins else {
        return Some("evidence predates pin tracking — re-run scripts/scaffold-recipe-evidence.mjs".into());
    };
    let mut names: Vec<&String> = pins.keys().collect();
    names.sort();
    for name in names {
        let recorded = &pins[name];
        if let Some(current) = current_pin(reg, name) {
            if &current != recorded {
                return Some(format!(
                    "evidence recorded against {name}@{recorded}; the registry now pins {name}@{current} — re-run scripts/scaffold-recipe-evidence.mjs"
                ));
            }
        }
    }
    None
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Limits {
    pub primary: LimitPair,
    pub command: LimitPair,
    pub env: LimitPair,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LimitPair {
    pub idle_seconds: u64,
    pub deadline_seconds: u64,
}

impl LimitPair {
    pub(crate) fn step_limits(&self) -> crate::process_control::StepLimits {
        crate::process_control::StepLimits::from_seconds(self.idle_seconds, self.deadline_seconds)
    }
}
// Registry fields the runner does not read (`recordedAt`, `frameworks`,
// `templateManifests`) are not declared: serde ignores them.

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
    pub install: Vec<String>,
    pub dev_flag: String,
    /// Lowest major the recipes are written for (ADR-028 §5): Yarn 2+ (dlx,
    /// add), pnpm 9+, npm 7+. The runner reads `<pm> --version` and refuses
    /// an older global before executing anything.
    #[serde(default)]
    pub min_major: Option<u32>,
    /// Steps that run right after the create CLI for this manager (Yarn
    /// Berry's empty `yarn.lock` project marker), before any add-on.
    #[serde(default)]
    pub post_create: Vec<Value>,
    /// Environment for every command this manager runs (Yarn's linker must
    /// reach the create CLI's own install, which precedes `postCreate`).
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Wrapper {
    pub kind: String,
    #[serde(default)]
    pub route: Option<Route>,
    /// Per-framework route overrides (ADR-028 §3: web + angular runs the
    /// Angular CLI through an `exec` route instead of create-vite).
    #[serde(default)]
    pub routes: HashMap<String, Route>,
    #[serde(default)]
    pub templates: HashMap<String, HashMap<String, String>>,
    #[serde(default)]
    pub unsupported: HashMap<String, String>,
    /// App entry file per framework/language — what add-ons patch.
    #[serde(default)]
    pub entries: HashMap<String, HashMap<String, String>>,
    /// Electron: framework wiring into the bundler-only Forge template.
    #[serde(default)]
    pub framework_recipes: HashMap<String, Vec<Recipe>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Route {
    pub kind: String,
    pub tool: String,
    pub args: Vec<String>,
    /// Nominal template id for override routes (exec routes have no
    /// template manifest; the id only names the recipe in the plan).
    #[serde(default)]
    pub template: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Addon {
    #[serde(default)]
    pub requires: Vec<String>,
    // `cli` (shadcn variant per framework) is consumed on the JS side when
    // recipes are authored; the runner only sees the resolved exec steps.
    #[serde(default)]
    pub recipes: Vec<Recipe>,
}

/// One recipe entry: applies when every selector in `when` matches, in
/// registry order. Steps stay raw JSON and are materialized per selection.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Recipe {
    #[serde(default)]
    pub when: HashMap<String, Vec<String>>,
    pub steps: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Backends {
    pub wrappers: Vec<String>,
    // `options` (the card list) is a wizard concern; the runner keys on `recipes`.
    #[serde(default)]
    pub recipes: HashMap<String, Vec<Recipe>>,
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
    #[serde(default)]
    pub evidence: Option<EvidencePins>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonCoverage {
    pub entries: Vec<AddonCoverageEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonCoverageEntry {
    pub wrapper: String,
    pub framework: String,
    pub language: String,
    pub manager: String,
    pub platform: String,
    pub status: String,
    #[serde(default)]
    pub addons: Vec<String>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub evidence: Option<EvidencePins>,
    /// Why a `failing` run failed — surfaced on the framework card when the
    /// primary combination has no entry of its own.
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

// ---------------------------------------------------------------------------
// Primary route
// ---------------------------------------------------------------------------

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
    let override_route = w.routes.get(framework);
    let route = override_route
        .or(w.route.as_ref())
        .ok_or_else(|| format!("wrapper '{wrapper}' has no primary route"))?;
    let template = match override_route {
        Some(r) => r.template.clone().unwrap_or_else(|| framework.to_string()),
        None => w
            .templates
            .get(framework)
            .and_then(|by_lang| by_lang.get(language))
            .cloned()
            .ok_or_else(|| {
                w.unsupported.get(framework).cloned().unwrap_or_else(|| {
                    format!("{framework} ({language}) has no template on the {wrapper} wrapper.")
                })
            })?,
    };
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

/// Exact spec for a pinned addon CLI (`shadcn-vue@2.8.2`), or None when the
/// registry does not pin it — the caller must then skip the step rather than
/// execute an unpinned CLI (ADR-021 §1).
pub(crate) fn addon_cli_spec(cli: &str) -> Option<String> {
    registry()
        .tools
        .get(cli)
        .filter(|t| t.kind == "addon-cli")
        .map(|t| format!("{cli}@{}", t.version))
}

// ---------------------------------------------------------------------------
// Post-scaffold steps (ADR-028 §4) — mirror of deriveScaffoldSteps in JS
// ---------------------------------------------------------------------------

struct StepContext<'a> {
    wrapper: &'a str,
    framework: &'a str,
    language: &'a str,
    manager: &'a str,
    entry: Option<String>,
    ext: &'a str,
    jsx: &'a str,
    name: &'a str,
}

impl StepContext<'_> {
    fn fill(&self, s: &str) -> String {
        s.replace("{entry}", self.entry.as_deref().unwrap_or("{entry}"))
            .replace("{ext}", self.ext)
            .replace("{jsx}", self.jsx)
            .replace("{name}", self.name)
    }

    fn fill_value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.fill(s)),
            Value::Array(items) => Value::Array(items.iter().map(|i| self.fill_value(i)).collect()),
            other => other.clone(),
        }
    }

    fn matches(&self, when: &HashMap<String, Vec<String>>) -> bool {
        when.iter().all(|(key, allowed)| {
            let value = match key.as_str() {
                "wrapper" => self.wrapper,
                "framework" => self.framework,
                "language" => self.language,
                "manager" => self.manager,
                _ => return false,
            };
            allowed.iter().any(|a| a == value)
        })
    }
}

/// Selected add-ons in execution order: every prerequisite before its
/// dependent, prerequisites pulled in even when not selected, sequence by
/// the registry's explicit `addonOrder` (F6).
pub(crate) fn order_addons(selected: &[String]) -> Vec<String> {
    let reg = registry();
    let mut wanted: Vec<String> = Vec::new();
    fn visit(id: &str, reg: &Registry, wanted: &mut Vec<String>) {
        let Some(addon) = reg.addons.get(id) else { return };
        if wanted.iter().any(|w| w == id) {
            return;
        }
        for dep in &addon.requires {
            visit(dep, reg, wanted);
        }
        wanted.push(id.to_string());
    }
    for id in selected {
        visit(id, reg, &mut wanted);
    }
    reg.addon_order
        .iter()
        .filter(|id| wanted.iter().any(|w| w == *id))
        .cloned()
        .collect()
}

fn str_field<'a>(step: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    step.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("recipes.json: step is missing '{key}'"))
}

/// One step, materialized with the same keys `materialize` produces in JS.
fn materialize(step: &Value, ctx: &StepContext, source: &str, manager: &Manager) -> Result<Value, String> {
    let obj = step
        .as_object()
        .ok_or_else(|| "recipes.json: step is not an object".to_string())?;
    let op = str_field(obj, "op")?;
    let mut out = Map::new();
    out.insert("source".into(), json!(source));
    out.insert("op".into(), json!(op));
    match op {
        "install" => {
            let dev = obj.get("dev").and_then(|v| v.as_bool()).unwrap_or(false);
            let packages: Vec<String> = obj
                .get("packages")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let mut argv = manager.install.clone();
            if dev {
                argv.push(manager.dev_flag.clone());
            }
            argv.extend(packages.iter().cloned());
            out.insert("dev".into(), json!(dev));
            out.insert("packages".into(), json!(packages));
            out.insert("argv".into(), json!(argv));
        }
        "exec" => {
            let cli = str_field(obj, "cli")?;
            let spec = addon_cli_spec(cli);
            let args = ctx.fill_value(obj.get("args").unwrap_or(&Value::Array(vec![])));
            let argv = spec.as_ref().map(|s| {
                let mut argv = manager.exec.clone();
                argv.push(s.clone());
                argv.extend(args.as_array().unwrap().iter().filter_map(|a| a.as_str().map(String::from)));
                json!(argv)
            });
            out.insert("cli".into(), json!(cli));
            out.insert("spec".into(), spec.map(Value::String).unwrap_or(Value::Null));
            out.insert("args".into(), args);
            out.insert("argv".into(), argv.unwrap_or(Value::Null));
        }
        "write" => {
            out.insert("path".into(), json!(ctx.fill(str_field(obj, "path")?)));
            out.insert("mode".into(), json!(obj.get("mode").and_then(|v| v.as_str()).unwrap_or("create")));
            out.insert("content".into(), json!(ctx.fill(str_field(obj, "content")?)));
        }
        "prepend" | "append" => {
            out.insert("path".into(), json!(ctx.fill(str_field(obj, "path")?)));
            out.insert("text".into(), json!(ctx.fill(str_field(obj, "text")?)));
        }
        "replace" => {
            out.insert("path".into(), json!(ctx.fill(str_field(obj, "path")?)));
            out.insert("find".into(), ctx.fill_value(obj.get("find").ok_or("recipes.json: replace without 'find'")?));
            out.insert("with".into(), json!(ctx.fill(str_field(obj, "with")?)));
        }
        "insertBefore" => {
            out.insert("path".into(), json!(ctx.fill(str_field(obj, "path")?)));
            out.insert("marker".into(), json!(ctx.fill(str_field(obj, "marker")?)));
            out.insert("text".into(), json!(ctx.fill(str_field(obj, "text")?)));
        }
        "mergeJson" => {
            out.insert("path".into(), json!(ctx.fill(str_field(obj, "path")?)));
            out.insert("value".into(), obj.get("value").cloned().unwrap_or(json!({})));
            out.insert("optional".into(), json!(obj.get("optional").and_then(|v| v.as_bool()).unwrap_or(false)));
            out.insert("create".into(), json!(obj.get("create").and_then(|v| v.as_bool()).unwrap_or(false)));
        }
        "delete" => {
            out.insert("path".into(), json!(ctx.fill(str_field(obj, "path")?)));
        }
        other => return Err(format!("recipes.json: unknown step op '{other}'")),
    }
    Ok(Value::Object(out))
}

/// Every post-scaffold step for a selection, in execution order: Electron
/// framework wiring → add-ons (prerequisites first) → backend. Identical to
/// `deriveScaffoldSteps` in src/scaffold/recipeRegistry.js; the shared
/// step-cases fixture holds both to it.
pub(crate) fn derive_steps(
    wrapper: &str,
    framework: &str,
    language: &str,
    manager: &str,
    addons: &[String],
    backend: Option<&str>,
    project_name: &str,
) -> Result<Vec<Value>, String> {
    let reg = registry();
    let Some(w) = reg.wrappers.get(wrapper) else { return Ok(vec![]) };
    if w.kind != "npm" {
        return Ok(vec![]);
    }
    let Some(m) = reg.managers.get(manager) else { return Ok(vec![]) };
    let ctx = StepContext {
        wrapper,
        framework,
        language,
        manager,
        entry: w.entries.get(framework).and_then(|by| by.get(language)).cloned(),
        ext: language,
        jsx: if language == "ts" { "tsx" } else { "jsx" },
        name: project_name,
    };
    let mut out = Vec::new();
    let post_create = Recipe { when: HashMap::new(), steps: m.post_create.clone() };
    let mut apply = |recipes: &[Recipe], source: &str| -> Result<(), String> {
        for recipe in recipes {
            if !ctx.matches(&recipe.when) {
                continue;
            }
            for step in &recipe.steps {
                out.push(materialize(step, &ctx, source, m)?);
            }
        }
        Ok(())
    };
    if !post_create.steps.is_empty() {
        apply(std::slice::from_ref(&post_create), &format!("manager:{manager}"))?;
    }
    if let Some(fw) = w.framework_recipes.get(framework) {
        apply(fw, &format!("framework:{framework}"))?;
    }
    for addon in order_addons(addons) {
        if let Some(a) = reg.addons.get(&addon) {
            apply(&a.recipes, &format!("addon:{addon}"))?;
        }
    }
    if let Some(b) = backend.filter(|b| *b != "none") {
        if reg.backends.wrappers.iter().any(|w| w == wrapper) {
            if let Some(r) = reg.backends.recipes.get(b) {
                apply(r, &format!("backend:{b}"))?;
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Coverage (ADR-028 §10)
// ---------------------------------------------------------------------------

/// Coverage status for one full combination on one platform; a missing entry
/// is `unverified` (brief §6: naming a gap is not permission to offer it).
pub(crate) fn coverage_status(
    wrapper: &str,
    framework: &str,
    language: &str,
    manager: &str,
    platform: &str,
) -> (String, Option<String>) {
    let reg = registry();
    reg.coverage
        .entries
        .iter()
        .find(|e| {
            e.wrapper == wrapper
                && e.framework == framework
                && e.language == language
                && e.manager == manager
                && e.platform == platform
        })
        .map(|e| {
            // Revalidation trigger: evidence recorded against other pins
            // does not carry over (same rule as recipeRegistry.js).
            if is_selectable_status(&e.status) {
                if let Some(stale) = pins_out_of_date(reg, e.evidence.as_ref()) {
                    return ("unverified".to_string(), Some(stale));
                }
            }
            (e.status.clone(), e.reason.clone())
        })
        .unwrap_or_else(|| {
            // No primary entry, but a failing add-on run of the same
            // combination exists: its cause is the honest answer (Yarn +
            // Angular read "not verified" while the registry knew why it
            // fails — owner live pass 2026-09-17). Mirrors recipeRegistry.js.
            failing_addon_reason(reg, wrapper, framework, language, manager, platform)
                .map(|reason| ("failing".to_string(), Some(reason)))
                .unwrap_or_else(|| ("unverified".to_string(), None))
        })
}

fn failing_addon_reason(
    reg: &Registry,
    wrapper: &str,
    framework: &str,
    language: &str,
    manager: &str,
    platform: &str,
) -> Option<String> {
    reg.addon_coverage
        .entries
        .iter()
        .find(|e| {
            e.wrapper == wrapper
                && e.framework == framework
                && e.language == language
                && e.manager == manager
                && e.platform == platform
                && e.status == "failing"
        })
        .and_then(|e| e.reason.clone())
}

pub(crate) fn is_selectable_status(status: &str) -> bool {
    matches!(status, "verified" | "covered-by-equivalence")
}

/// Add-on / backend evidence: a verified run of the same primary combination
/// whose recipe steps included the add-on (or backend). Returns the first
/// add-on or backend without evidence, if any.
pub(crate) fn unverified_addon(
    wrapper: &str,
    framework: &str,
    language: &str,
    manager: &str,
    platform: &str,
    addons: &[String],
    backend: Option<&str>,
) -> Option<String> {
    let reg = registry();
    let entries: Vec<&AddonCoverageEntry> = reg
        .addon_coverage
        .entries
        .iter()
        .filter(|e| {
            e.wrapper == wrapper
                && e.framework == framework
                && e.language == language
                && e.manager == manager
                && e.platform == platform
                && is_selectable_status(&e.status)
                && pins_out_of_date(reg, e.evidence.as_ref()).is_none()
        })
        .collect();
    for addon in addons {
        if !entries.iter().any(|e| e.addons.iter().any(|a| a == addon)) {
            return Some(addon.clone());
        }
    }
    if let Some(b) = backend.filter(|b| *b != "none") {
        if !entries.iter().any(|e| e.backend.as_deref() == Some(b)) {
            return Some(format!("backend {b}"));
        }
    }
    None
}

/// Environment the runner sets on every command of a manager.
pub(crate) fn manager_env(manager: &str) -> Vec<(String, String)> {
    registry()
        .managers
        .get(manager)
        .map(|m| m.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// The registry's floor for a manager's major version, if any.
pub(crate) fn manager_min_major(manager: &str) -> Option<u32> {
    registry().managers.get(manager).and_then(|m| m.min_major)
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
    const STEP_CASES_JSON: &str = include_str!("../../test/fixtures/scaffold-plans/step-cases.json");

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

    #[derive(Deserialize)]
    struct StepCaseFile {
        cases: Vec<StepCase>,
    }

    #[derive(Deserialize)]
    struct StepCase {
        name: String,
        input: StepInput,
        expect: Vec<Value>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StepInput {
        wrapper: String,
        framework: String,
        language: String,
        manager: String,
        #[serde(default)]
        addons: Vec<String>,
        #[serde(default)]
        backend: Option<String>,
        project_name: String,
    }

    #[test]
    fn registry_parses() {
        let reg = registry();
        assert_eq!(reg.schema_version, 1);
        assert!(reg.tools.contains_key("create-vite"));
        assert!(reg.managers.contains_key("npm"));
        assert_eq!(reg.wrappers["python"].kind, "blueprint");
        assert_eq!(reg.addon_order.len(), reg.addons.len());
        for id in &reg.addon_order {
            assert!(reg.addons.contains_key(id), "addonOrder names unknown addon {id}");
        }
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

    /// The projection the JS test uses: source, op, path, argv.
    fn project(step: &Value) -> Value {
        let mut out = Map::new();
        for key in ["source", "op", "path", "argv"] {
            if let Some(v) = step.get(key) {
                if !v.is_null() {
                    out.insert(key.into(), v.clone());
                }
            }
        }
        Value::Object(out)
    }

    #[test]
    fn shared_step_cases_derive_exactly_like_the_js_side() {
        let file: StepCaseFile = serde_json::from_str(STEP_CASES_JSON).expect("step-cases.json parses");
        assert!(file.cases.len() >= 5);
        for case in file.cases {
            let steps = derive_steps(
                &case.input.wrapper,
                &case.input.framework,
                &case.input.language,
                &case.input.manager,
                &case.input.addons,
                case.input.backend.as_deref(),
                &case.input.project_name,
            )
            .unwrap_or_else(|e| panic!("{}: {e}", case.name));
            let projected: Vec<Value> = steps.iter().map(project).collect();
            assert_eq!(projected, case.expect, "{}", case.name);
        }
    }

    #[test]
    fn addons_are_ordered_by_prerequisite_then_registry_order() {
        assert_eq!(order_addons(&["shadcn".into(), "tailwind".into()]), vec!["tailwind", "shadcn"]);
        assert_eq!(order_addons(&["router".into(), "shadcn".into()]), vec!["tailwind", "shadcn", "router"]);
        assert!(order_addons(&["nope".into()]).is_empty());
    }

    #[test]
    fn web_angular_routes_through_the_pinned_angular_cli() {
        // F1 closed (ADR-028 §3): no create-vite template lookup, an exec
        // route with the real package name, queried verbatim by the age gate.
        let d = derive_primary("web", "angular", "ts", "npm", "demo").unwrap();
        assert_eq!(d.route_kind, "exec");
        assert_eq!(d.package, "@angular/cli");
        assert_eq!(d.invoke, "@angular/cli");
        assert_eq!(d.argv[..3], ["exec".to_string(), "--yes".to_string(), "--".to_string()]);
        assert_eq!(d.argv[3], d.spec());
        assert_eq!(&d.argv[4..], ["new", "demo", "--defaults", "--skip-git", "--package-manager", "npm"]);
        // Electron still has no Angular route at all.
        assert!(derive_primary("electron", "angular", "ts", "npm", "demo").is_err());
    }

    #[test]
    fn every_route_template_is_in_the_pinned_tool_manifest() {
        // Mirror of the JS F1 regression test, on the Rust read side.
        let value: Value = serde_json::from_str(REGISTRY_JSON).unwrap();
        let manifests = value["templateManifests"].as_object().unwrap();
        for (id, w) in &registry().wrappers {
            let Some(route) = &w.route else { continue };
            // Override (exec) routes have no template manifest by design.
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
    fn evidence_recorded_against_other_pins_is_stale_by_name() {
        // ADR-028 §10 / dependency policy Rule 5: the revalidation trigger.
        let reg = registry();
        let vite = &reg.tools["create-vite"].version;
        let mut pins = HashMap::new();
        pins.insert("create-vite".to_string(), vite.clone());
        pins.insert("tailwindcss".to_string(), current_pin(reg, "tailwindcss").unwrap());
        let fresh = EvidencePins { pins: pins.clone() };
        assert_eq!(pins_out_of_date(reg, Some(&fresh)), None);
        pins.insert("create-vite".to_string(), "0.0.1".into());
        let stale = EvidencePins { pins };
        let reason = pins_out_of_date(reg, Some(&stale)).expect("stale");
        assert!(reason.contains("create-vite@0.0.1") && reason.contains(&format!("create-vite@{vite}")), "{reason}");
        assert!(pins_out_of_date(reg, None).unwrap().contains("predates pin tracking"));
        assert!(pins_out_of_date(reg, Some(&EvidencePins::default())).is_some(), "empty pins are stale");
        // A name the registry does not pin is not a trigger.
        let mut other = HashMap::new();
        other.insert("left-pad".to_string(), "1.0.0".to_string());
        assert_eq!(pins_out_of_date(reg, Some(&EvidencePins { pins: other })), None);
    }

    #[test]
    fn every_offered_coverage_entry_was_recorded_against_the_current_pins() {
        // The repo never ships a stale-but-selectable entry: a pin bump must
        // come with re-run evidence or a downgraded status.
        let reg = registry();
        for e in &reg.coverage.entries {
            if is_selectable_status(&e.status) {
                assert_eq!(
                    pins_out_of_date(reg, e.evidence.as_ref()),
                    None,
                    "{}/{}/{} {} {}",
                    e.wrapper, e.framework, e.language, e.manager, e.platform
                );
            }
        }
        for e in &reg.addon_coverage.entries {
            if is_selectable_status(&e.status) {
                assert_eq!(pins_out_of_date(reg, e.evidence.as_ref()), None, "{}/{}/{} {:?}", e.wrapper, e.framework, e.language, e.addons);
            }
        }
    }

    #[test]
    fn a_failing_addon_run_names_its_cause_when_the_primary_has_no_entry() {
        // Yarn + Angular: no primary entry, one failing add-on run (S4/S8).
        let (status, reason) = coverage_status("web", "angular", "ts", "yarn", "windows");
        assert_eq!(status, "failing");
        assert!(reason.as_deref().unwrap_or("").contains("Yarn Classic"), "{reason:?}");
        assert!(!is_selectable_status(&status));
    }

    #[test]
    fn coverage_defaults_to_unverified_and_is_not_selectable() {
        let (status, _) = coverage_status("web", "react", "ts", "yarn", "linux");
        assert_eq!(status, "unverified");
        assert!(!is_selectable_status(&status));
        assert!(is_selectable_status("verified"));
        assert!(is_selectable_status("covered-by-equivalence"));
        assert!(!is_selectable_status("failing"));
        // Add-ons need their own evidence.
        assert_eq!(
            unverified_addon("web", "react", "ts", "yarn", "linux", &["tailwind".into()], None).as_deref(),
            Some("tailwind")
        );
        assert_eq!(
            unverified_addon("web", "react", "ts", "yarn", "linux", &[], Some("express")).as_deref(),
            Some("backend express")
        );
        assert_eq!(unverified_addon("web", "react", "ts", "yarn", "linux", &[], Some("none")), None);
    }

    #[test]
    fn addon_cli_specs_come_from_the_registry() {
        let spec = addon_cli_spec("shadcn-vue").unwrap();
        assert!(spec.starts_with("shadcn-vue@"));
        assert_eq!(addon_cli_spec("create-vite"), None, "initializers are not addon CLIs");
    }
}
