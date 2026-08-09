# ADR-012: Declarative Widget Card System for Scaffold Command Generation

## Status
- Accepted — Implemented (New Project Wizard PR #35/#36; compatibility matrix PR #40)

## Date
- 2026-04-01

## Context

Litria's New Project modal needs to scaffold projects across three wrapper ecosystems — Tauri (`create-tauri-app`), Electron (`create-electron-app`), and Web Only (`create-vite`) — each with its own CLI tool, flag format, and template naming conventions. The current implementation uses `<select>` dropdowns and a toggle switch, with scaffold logic hardcoded in `scaffoldDomain.js`.

Two problems arise from the current approach:
1. Adding a new framework, language, or addon requires modifying both the UI rendering code and the scaffold assembly logic — they are coupled.
2. Each wrapper's CLI has different flag formats (`--template react-ts` vs `--template=vite-typescript`), but the UI has no way to express these differences declaratively.

## Decision

Adopt a **declarative widget card system** where each selectable card carries a `flagConfig` object defining its contribution to the scaffold command. The UI renders cards from data; the flag preview assembles commands from `flagConfig` objects; the Rust scaffold runner translates internal values to CLI-specific arguments.

**Card data shape:**
```json
{
  "flagConfig": {
    "tier": "wrapper | framework | lang | backend | addon",
    "emitKey": "--template",
    "emitValue": "react",
    "emitStyle": "flag | append | comment | none",
    "wrapperScope": ["tauri", "electron", "web"]
  }
}
```

**Emit styles:**
- `flag`: Emits as `--key value` (primary scaffold flags)
- `append`: Appends to previous value (language suffix like `-ts`)
- `comment`: Emits as `# +value` annotation (post-scaffold step)
- `none`: Silent (used for "None" default cards)

**Scaffold runner translation:** The Rust backend translates internal `flagConfig` values to the correct CLI arguments per wrapper. For example, the TypeScript card emits `-ts` as its internal value; the scaffold runner maps this to `-ts` for Tauri/Vite templates and `-typescript` for Electron Forge templates. Electron's framework choice is emitted as a `comment` annotation since Electron Forge templates are bundler-based (`vite`, `vite-typescript`), not framework-based.

**Canonical references:**
- Visual behavior: `docs/prototypes/cm_new_project_template_picker_v3.html`
- Data contract: `docs/prototypes/CM_Widget_API_Contract.md`

## Alternatives Considered

### Hardcoded command builders per wrapper
Separate JS functions that construct the CLI command string for each wrapper, with framework/language/addon logic baked in. Rejected: every new card requires modifying builder functions. The declarative approach lets contributors add cards by defining data, not writing assembly logic.

### Form-based input (dropdowns and text fields)
Keep the existing `<select>` pattern and add wrapper selection as another dropdown. Rejected: higher cognitive load, less visual, and poor discoverability. Card selection with visual feedback (icons, badges, color coding) is more engaging and makes the tier cascade self-documenting.

### External template registry (JSON files on disk)
Store card definitions as JSON files that the UI reads at runtime, enabling users to add custom templates by dropping files. Rejected for v1: premature flexibility. The card data lives in `scaffoldDomain.js` alongside the existing framework/addon registries. A file-based registry can be added later without changing the card rendering or flag assembly system.

## Consequences

### Positive
- Contributors add cards by defining data objects, not modifying UI or assembly logic
- The widget API contract (`CM_Widget_API_Contract.md`) provides clear validation rules for card PRs
- Flag preview shows real CLI commands — what you see is what runs
- `wrapperScope` filtering lets cards declare which wrappers they're valid for, preventing invalid combinations
- The same card data drives both the UI and the scaffold execution, eliminating sync drift

### Negative
- Emit style system adds indirection — contributors must understand `flag`, `append`, `comment`, and `none` semantics
- Scaffold runner must maintain a CLI translation layer per wrapper (Tauri vs Electron vs Vite flag formats)
- The `append` style (lang suffix) creates implicit coupling between the framework card's `emitValue` and the language card's suffix

### Neutral
- Existing `scaffoldDomain.js` functions (`getScaffoldLanguages`, `getScaffoldFrameworks`, `getScaffoldAddons`) continue to serve as data sources. The `flagConfig` metadata is added alongside existing fields, not replacing them
- The widget API contract is a design document, not a runtime schema validator. Runtime validation is the responsibility of code review and TypeScript types

## References
- PRD-NP-001: `docs/prds/new-project-template-picker-prd.md`
- RFC: `docs/rfcs/new-project-template-picker.md`
- Widget API Contract: `docs/prototypes/CM_Widget_API_Contract.md`
- Interactive Prototype: `docs/prototypes/cm_new_project_template_picker_v3.html`
- Existing scaffold system: `src/scaffold/scaffoldDomain.js`
- ADR-011: Runtime Platform Configuration (cross-platform path handling)
