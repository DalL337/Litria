# Theme System PRD (Glass Default)

**Status: PHASE 1 COMPLETE** -- Glass theme is working, not final. Further refinement is low priority. Closed 2026-03-07.

## Overview
Litria will introduce a project-scoped theme system with a default theme named `Glass`.

`Glass` keeps current Litria base colors for the app shell and drawers, while making pieces the visual centerpiece:
- dark black base layer on each piece
- thin, unobtrusive colored highlight
- piece outline color matches highlight color
- default highlight palette starts with Litria-style accent colors (red, blue, yellow, green)

This document is planning-only. It defines orchestration-safe ownership and a stub workflow for later implementation.

## Goals
- Define a stable theme token model for `Glass`.
- Keep default Litria app colors as-is for non-piece surfaces in v1.
- Make piece appearance driven by theme tokens + piece accent color.
- Allow per-theme color editing later (without changing theme structure).
- Allow user-created themes saved per project.
- Keep all persistence orchestration-compliant with `docs/Orchestration.md`.

## Non-Goals (This Plan)
- No implementation in this phase.
- No global/user-wide theme registry yet.
- No marketplace/import/export flow yet.
- No Monaco/editor syntax theme redesign yet.

## Default Theme: `Glass`

### Visual intent
- Surface style: polished glass feeling on pieces.
- Piece base: dark black layer.
- Accent: slim color highlight.
- Outline: same color as accent.
- Overall: accent is visible but unobtrusive.

### Diagnostic channels (theme-bound)
`Glass` also defines visual feedback channels so warning/health states are part of theme behavior, not a separate UI system.

- `base` (internal integrity): file exists, core internal validity, severe internal faults.
- `gloss` (internal structure): aging code structure, legacy patterns, dependency age/health signals.
- `edgeBloom` (external connectivity): import/connection integrity, missing upstream/downstream targets, broken graph relationships.

### Initial token set (draft)
```json
{
  "id": "glass",
  "name": "Glass",
  "version": 1,
  "surfaces": {
    "app": "inherit-current-cm",
    "drawers": "inherit-current-cm",
    "artboard": "inherit-current-cm"
  },
  "piece": {
    "baseFill": "#090b10",
    "baseAlpha": 0.9,
    "highlightThicknessPx": 2,
    "highlightAlpha": 0.95,
    "outlineWidthPx": 1.5,
    "outlineUsesAccent": true,
    "highlightPalette": ["#ef5350", "#42a5f5", "#fbc02d", "#66bb6a"]
  }
}
```

Notes:
- `inherit-current-cm` means no shell color changes in first rollout.
- Palette values are defaults and can be edited later per project.

## Visual Warning Model (Planned)

### Canonical severity enum
- `ok`: healthy.
- `warn`: needs attention.
- `error`: broken/invalid/missing required dependency.
- `stale`: valid but old status/check age.
- `unknown`: not analyzed yet or partial data.

### Baseline severity color semantics
- `ok` = green
- `warn` = yellow
- `error` = red
- `stale` = low-intensity amber
- `unknown` = muted blue/gray

### Layer semantics
- `base` should react to internal file integrity and serious internal conditions.
- `gloss` should react to code quality/structure/dependency freshness.
- `edgeBloom` should react to graph/import/connection health.

### Aggregation rules
- Per-layer priority: `error > warn > ok > stale > unknown`.
- Piece-level summary priority: highest severity from any layer wins.
- Transition behavior: pulse/flash only on severity transitions, not continuous re-triggers.

### Motion and noise guardrails
- No JS per-frame loops for warning visuals; use CSS keyframes + class changes.
- Use cooldown/debounce so repeated checks do not flicker.
- Respect reduced-motion preferences.

## Theme Editability Model (Planned)
- Users can select a theme (`Glass` default).
- Users can edit a theme's color scheme without redefining behavior.
- Users can create a new theme from an existing one and save it in project manifest.
- Theme selection and edits are project-scoped.

## Color Customization Roadmap (Planned)

### Color format standard
- Canonical stored color format: `hex` (`#RRGGBB`, optional `#RRGGBBAA` when alpha is required).
- Rendering may derive `rgb/rgba` values from stored `hex`.
- `CMYK` is out of scope for in-app theming.

### Two palette classes
- `accentPalette` (user-editable): used for piece visual styling (highlight/outline and related theme accents).
- `diagnosticPalette` (system-reserved): used for warning/check semantics (`ok/warn/error`, plus `stale/unknown` if enabled).

Rules:
- In early phases, diagnostic colors remain locked to preserve warning clarity.
- User accents must not collapse into diagnostic semantics (avoid ambiguous matching).

### Phase A: Fixed swatch editor (initial)
- Provide 16 predefined accent colors for built-in and custom theme editing.
- Support assign/add/remove/reorder within 16-color constraints (exact UX TBD).
- Keep diagnostics palette reserved and non-editable.

Exit criteria:
- Users can edit theme accent palette using 16 swatches only.
- Theme edits persist per project in `litria.project.json`.
- Warning colors remain consistent and unchanged.

### Phase B: Advanced free-color editor
- Add free-color selection using a color wheel and a color scale.
- Color wheel and color scale are two render modes of the same picker model:
  - wheel = circular hue/saturation interaction
  - scale = linear interaction (same underlying color value model)
- Both render modes write to the same canonical `hex` token values.

Exit criteria:
- Users can switch between wheel/scale picker modes without data conversion loss.
- Stored color tokens remain canonical `hex`.
- Contrast and ambiguity checks enforce visibility and diagnostic separation.

## Persistence Shape (Project-Scoped)
Store theme data in `litria.project.json` under a new top-level `appearance` object.

Draft shape:
```json
{
  "appearance": {
    "activeThemeId": "glass",
    "themes": {
      "glass": {
        "id": "glass",
        "name": "Glass",
        "version": 1,
        "tokens": {}
      }
    },
    "customThemeOrder": []
  }
}
```

Design rules:
- Missing/invalid `appearance` falls back to built-in `Glass`.
- Unknown tokens are ignored (forward compatibility).
- Theme schema versioning is explicit (`version`).

## Orchestration and Domain Ownership
Aligned to `docs/Orchestration.md`:

### Ownership
- `ProjectDomain`
  - owns manifest IO for theme persistence (`appearance` read/write)
  - performs schema normalization/migration for stored theme payload
- `ThemeDomain` (new supporting domain, planned)
  - owns in-memory theme state, token resolution, active theme selection
  - maps `layer + severity` to render tokens/animation presets
  - exposes commands/selectors only
- `PieceDomain`
  - continues owning piece entity data (including piece accent/color field if retained)
  - source of `base` channel diagnostics for piece integrity signals
- `EditorDomain`
  - source of `gloss` channel diagnostics for code structure/dependency warnings
- `ConnectionDomain`
  - source of `edgeBloom` diagnostics for relationship/import connectivity signals
- `PresentationLayer`
  - reads resolved theme selectors and renders styles only

### Dependency constraints
- `PresentationLayer` reads theme selectors; no direct manifest/file writes.
- `ThemeDomain` does not import UI components.
- Theme persistence writes occur only through `ProjectDomain` commands.
- No cross-domain direct state mutation.
- Diagnostic producers publish through domain APIs/events; renderer consumes selectors only.

### Proposed API stub (planning contract)
```ts
interface ThemeDomainApi {
  commands: {
    initializeFromProject(input: { appearance: unknown }): void;
    setActiveTheme(input: { themeId: string }): void;
    updateThemeTokens(input: { themeId: string; patch: Record<string, unknown> }): void;
    createThemeFromBase(input: { baseThemeId: string; newThemeId: string; name: string }): void;
    deleteCustomTheme(input: { themeId: string }): void;
  };
  selectors: {
    getActiveThemeId(): string;
    getTheme(themeId: string): ThemeConfig | null;
    getResolvedPieceTokens(): ResolvedPieceTokens;
    getDiagnosticVisual(input: {
      layer: 'base' | 'gloss' | 'edgeBloom';
      severity: 'ok' | 'warn' | 'error' | 'stale' | 'unknown';
    }): DiagnosticVisualTokens;
    listThemes(): ThemeSummary[];
  };
}
```

Diagnostic signal payload (producer-side draft):
```ts
type DiagnosticLayer = 'base' | 'gloss' | 'edgeBloom';
type DiagnosticSeverity = 'ok' | 'warn' | 'error' | 'stale' | 'unknown';

interface PieceDiagnosticSignal {
  pieceId: number | string;
  layer: DiagnosticLayer;
  severity: DiagnosticSeverity;
  reasonCode: string; // e.g. missing_file, legacy_structure, broken_import_edge
  sourceDomain: 'PieceDomain' | 'EditorDomain' | 'ConnectionDomain';
  detectedAt: string; // ISO timestamp
}
```

## Planned Workflow Stub (Phased)

### Phase 0: Contract + schema
- Finalize token contract for `Glass`.
- Finalize manifest `appearance` schema and normalization rules.
- Add architecture guard notes for new domain dependency rules.

Exit criteria:
- Contract approved.
- Migration/fallback behavior documented.

### Phase 1: Read-only default theme wiring
- Introduce `ThemeDomain` with built-in `Glass` tokens.
- Wire presentation reads to resolved piece tokens.
- Keep settings UI minimal/read-only (show active theme only).

Exit criteria:
- App renders with `Glass` defaults and no regressions to core workflows.
- No direct persistence writes outside `ProjectDomain`.

### Phase 2: Editable palette for built-in theme
- Add settings controls to edit color scheme values (piece-related first, 16-swatch mode).
- Persist edits into `appearance.themes.glass`.
- Add reset-to-default action for `Glass`.

Exit criteria:
- Edits survive restart per project.
- Invalid values are clamped/normalized safely.

### Phase 3: Custom themes
- Add create/duplicate/rename/delete custom theme flow.
- Persist custom themes + active selection in `litria.project.json`.
- Add lightweight validation and conflict handling (duplicate IDs/names).

Exit criteria:
- Project-specific custom themes fully round-trip.
- Fallback to `Glass` if active custom theme is missing/corrupt.

### Phase 3.5: Advanced picker rollout
- Introduce wheel/scale free-color mode for accent palette editing.
- Keep diagnostics palette behavior guarded by reserved rules in baseline mode.
- Add token validation for contrast and reserved-color ambiguity.

Exit criteria:
- Free-color editing is stable and project-scoped.
- Wheel and scale picker modes are interchangeable views of one color model.
- Reserved diagnostics remain legible and semantically distinct.

### Phase 4: Theme-bound diagnostics wiring
- Wire `base/gloss/edgeBloom` diagnostic outputs from owning domains.
- Map severity to theme tokens using `ThemeDomain` selectors.
- Add transition-only animation policy (debounced/cooldown).

Exit criteria:
- Visual warning channels render consistently for `ok/warn/error/stale/unknown`.
- Piece summary severity matches aggregation rules.
- No direct cross-domain mutation introduced by diagnostics flow.

## Acceptance Criteria (Planning Baseline)
- `Glass` is the default active theme for new and old projects (fallback-safe).
- Piece base/highlight/outline are token-driven and consistent.
- Outline color equals piece highlight/accent color by rule.
- Theme config is project-scoped in `litria.project.json`.
- Theme persistence and loading flow only through `ProjectDomain`.
- Domain APIs remain command/query separated and testable.
- Diagnostic channels are semantically split: `base` internal, `gloss` structural, `edgeBloom` external.
- Severity mapping defaults to `green/yellow/red` with explicit `stale/unknown` handling.
- Visual pulses are transition-driven and rate-limited (no constant flicker).
- Initial theme editing supports a 16-swatch accent palette.
- Advanced editing supports wheel and linear scale picker modes on one shared color model.
- Theme color tokens are stored canonically as `hex`.

## Risks and Mitigations
- Risk: token sprawl and hard-coded CSS drift.
  - Mitigation: single token resolver in `ThemeDomain`, CSS variables generated from selectors.
- Risk: malformed manifest theme payloads.
  - Mitigation: strict normalization + fallback to built-in `Glass`.
- Risk: cross-domain leakage from UI event handlers.
  - Mitigation: enforce command APIs; add architecture checks with existing refactor guardrails.

## Open Questions
- Should piece accent assignment remain random at piece creation, or be theme-driven by deterministic sequence?
- Should custom themes be stored inline in `appearance.themes` only, or separated into `builtinThemes` + `userThemes`?
- Should `Glass` include optional blur/gloss intensity tokens now, or defer to a later visual pass?
- Should stale/unknown be user-toggleable in visibility, or always visible with low intensity?
- Should edgeBloom evaluate only explicit Litria graph edges, or also inferred import relationships from code analysis?
- Should diagnostics color overrides ever be allowed in an advanced mode, or remain permanently reserved?
