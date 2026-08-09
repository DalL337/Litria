# ADR-016: Open-Any-Folder Project Bootstrapping

## Status
- Accepted — Implemented (`4d837a1`, PR #35/#36, 2026-04-06)

## Date
- 2026-04-05

## Context

Litria currently requires a `litria.project.json` file to recognize a directory as a valid project. Users cannot open existing codebases (e.g., a project created in VS Code, a cloned GitHub repository) without first running the New Project Wizard. The wizard creates the manifest file, which serves as both the project marker and the entire persistence layer.

This creates an onboarding wall:

**1. Existing projects are locked out.** A developer who wants to migrate from VS Code to Litria must either create a new project through the wizard (losing their existing directory structure) or manually place a `litria.project.json` in their project root.

**2. The marker check provides no real validation.** The current gate checks for the existence of `litria.project.json` but does not validate its structure. An empty file with the correct name passes the check. The gate provides friction without safety.

**3. The wizard conflates two use cases.** Creating a brand-new scaffolded project (Tauri + React + TypeScript from scratch) and opening an existing codebase are fundamentally different workflows. Both currently funnel through the same wizard, which makes neither experience clean.

With the move to SQLite persistence (ADR-015), the manifest file is being retired. This is the natural moment to replace the marker-file gate with an open-any-folder flow.

## Decision

Any directory on disk is a valid Litria project. Litria adapts to the project, not the other way around.

### Open folder flow

```
User selects a folder (Open Folder dialog or recent projects dropdown)
  │
  ├─ .litria/ exists?
  │    ├─ YES → Returning project. Open workspace.db, hydrate canvas state.
  │    └─ NO  → New to Litria. Bootstrap:
  │              1. Create .litria/ directory
  │              2. Create .litria/workspace.db with empty schema
  │              3. Create litria.toml with name derived from folder name
  │              4. Register in app-level litria.db (recent projects)
  │              5. Present empty canvas + full file tree in scaffold drawer
  │              6. User curates their workspace at their own pace
  │
  └─ Done. No wizard required.
```

### The wizard stays — for scaffolding only

The New Project Wizard remains available for users who want to create a brand-new project with framework scaffolding (Tauri, React, etc.). It is no longer the only path to creating a Litria project. The two flows are:

- **Open Folder**: "I have a project. Let me work with it in Litria." — No wizard, no scaffold, immediate canvas access.
- **New Project Wizard**: "I want to create a new project from scratch with scaffolding." — Full wizard flow, template picker, scaffold runner.

### Marker file: `litria.toml`

The `litria.toml` file (defined in ADR-015) replaces `litria.project.json` as the human-readable project identity marker. It is created automatically during bootstrapping and contains only metadata:

```toml
[project]
name = "myawesomeapp"
schema_version = 1
created_at = "2026-04-05T16:53:30Z"
```

Key properties:
- Created automatically on first open — never a gate, always a byproduct
- Human-readable and version-control friendly
- Contains no workspace state (that lives in `.litria/workspace.db`)
- User's choice to `.gitignore` or commit

### Detection precedence

On folder open, Litria checks in order:
1. `.litria/workspace.db` exists → full returning-project load
2. `litria.toml` exists but no `.litria/` → partial state, rebuild `.litria/` from marker metadata
3. Neither exists → fresh bootstrap

This handles edge cases like a user who committed `litria.toml` to git but `.litria/` is gitignored — Litria rebuilds the workspace database from scratch using the marker's metadata.

## Consequences

### Positive
- Zero-friction onboarding for existing projects — any folder works
- Consistent with VS Code (`.vscode/`), JetBrains (`.idea/`), and other editors that adapt to existing directories
- Clean separation: wizard is for scaffolding, open-folder is for everything else
- Removes a validation gate that provided no actual safety
- The scaffold drawer's hide/show toggles become the project curation tool — users pull files onto the canvas selectively rather than getting everything dumped at once

### Negative
- First open of a large existing project presents an empty canvas, which may feel underwhelming compared to the scaffolded experience — mitigated by the scaffold drawer showing the full file tree immediately
- Users may not immediately understand that they need to drag files from the drawer to the canvas — mitigated by onboarding hints or a "Quick Start" prompt

### Neutral
- The New Project Wizard is unchanged in functionality — it simply gains an alternative entry path
- Existing projects with `litria.project.json` will go through the ADR-015 migration converter, then subsequent opens use the new flow
- The project switcher dropdown (planned) works identically for bootstrapped and scaffolded projects — both are registered in the app-level database

## Alternatives Considered

### Keep the manifest as a required gate, add a separate "Import Project" flow
This preserves the current architecture and adds a new wizard page for importing. Rejected — it adds complexity to solve a problem created by unnecessary friction. The simpler solution is to remove the gate.

### Auto-scaffold detected frameworks on first open
Detect `package.json`, `Cargo.toml`, etc., and auto-populate the canvas with framework-appropriate file groupings. Rejected for MVP — it's a good future enhancement but adds detection complexity. The scaffold drawer already shows the file tree; letting users curate manually is sufficient and predictable.

### Use `litria.toml` as the sole detection marker (no `.litria/` directory check)
Simpler detection but conflates the marker with the workspace state directory. If `.litria/` is deleted but `litria.toml` remains, the behavior is ambiguous. The three-tier detection precedence handles this cleanly. Rejected as sole mechanism, retained as fallback tier.

## References
- Prerequisite: ADR-015 (SQLite Persistence Layer)
- Related: PRD-NP-001 (New Project Template Picker — wizard remains for scaffolding)
- Related: RFC `sqlite-persistence-migration.md`
