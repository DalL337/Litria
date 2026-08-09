# DevSight — Build Plan

## Status
- Planning (2026-03-26)
- PRD: `docs/prds/devsight-prd.md`

## Context

DevSight is a bottom-anchored diagnostics panel for users debugging their projects within Litria. It surfaces LSP diagnostics, terminal output, and build errors in a structured, filterable interface. Toggled with `Ctrl+Shift+I`.

This plan covers Phase 1 only (panel shell + Problems tab + status bar badge). Phases 2-5 will be planned separately as Phase 1 stabilizes.

---

## Architecture Overview

```
┌─────────────────────────────────────┐
│         App.jsx (root)              │
│  ┌──────────────────────────────┐   │
│  │    DevSightProvider          │   │ ← new context provider
│  │  ┌────────────────────────┐  │   │
│  │  │   Workspace area       │  │   │
│  │  │   (canvas + editor)    │  │   │
│  │  ├────────────────────────┤  │   │
│  │  │   DevSightShell        │  │   │ ← new panel shell
│  │  │  ┌──────────────────┐  │  │   │
│  │  │  │  Tab bar          │  │  │   │
│  │  │  ├──────────────────┤  │  │   │
│  │  │  │  ProblemsPanel    │  │  │   │ ← new tab content
│  │  │  └──────────────────┘  │  │   │
│  │  ├────────────────────────┤  │   │
│  │  │   StatusBar (+ badge)  │  │   │ ← existing, extended
│  │  └────────────────────────┘  │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

**Data flow for Phase 1:**
```
LSP server → ipc_bridge.rs (emit "lsp:diagnostics")
    → lspClient.js (listen)
    → EditorMonaco.jsx (Monaco markers — existing, unchanged)
    → devSightDomain.js (aggregate diagnostics — new)
        → ProblemsPanel.jsx (display — new)
        → StatusBar.jsx (badge counts — extended)
```

DevSight subscribes to the same `lsp:diagnostics` event that EditorMonaco already uses. No changes to the LSP pipeline.

---

## Affected Files

### New Files

| File | Role |
|---|---|
| `src/devsight/devSightDomain.js` | Domain: diagnostic state, counts, filters |
| `src/devsight/DevSightContext.jsx` | Context provider for panel state (open/closed, active tab, height) |
| `src/devsight/DevSightShell.jsx` | Panel shell: tab bar, resize handle, animation, content routing |
| `src/devsight/ProblemsPanel.jsx` | Problems tab: diagnostic list grouped by file |
| `src/devsight/ProblemRow.jsx` | Single diagnostic row (severity icon, location, message, code) |
| `src/devsight/ProblemFilters.jsx` | Filter bar (severity toggles, text search, source dropdown) |
| `src/styles/devsight.css` | Panel styling (glass theme, tabs, resize handle, problem rows) |

### Modified Files

| File | Change |
|---|---|
| `src/components/App.jsx` | Wrap with DevSightProvider, render DevSightShell, wire keyboard shortcut |
| `src/components/StatusBar.jsx` | Add error/warning badge in right zone |
| `src/lsp/lspClient.js` | No change — DevSight listens to same Tauri event independently |

---

## Slice 1: DevSight Domain + Context

**Goal**: Establish the data layer and panel state management.

### 1a. DevSight Domain
- Where: `src/devsight/devSightDomain.js`
- What: Create domain following existing domain pattern (like `terminalDomain.js`)
- State:
  - `diagnosticsByUri` — `Map<string, Diagnostic[]>` keyed by file URI
  - `errorCount` — number, aggregated across all files
  - `warningCount` — number, aggregated across all files
  - `filters` — `{ severities: Set, searchText: string, source: string | null }`
- Commands:
  - `handleDiagnostics(uri, languageId, diagnostics)` — replace diagnostics for a URI, recompute counts
  - `clearDiagnostics(uri?)` — clear one file or all
  - `setFilter(type, value)` — update severity/search/source filter
  - `getFilteredDiagnostics()` — return diagnostics after applying filters
- Selectors:
  - `getErrorCount()` / `getWarningCount()`
  - `getDiagnosticsByFile()` — grouped and sorted for display
  - `getActiveFilters()`

### 1b. DevSight Context
- Where: `src/devsight/DevSightContext.jsx`
- What: Context provider for UI panel state (follows TopDrawerContext pattern)
- State:
  - `isOpen` — boolean
  - `activeTab` — `'problems'` | `'console'` | `'output'` (only `'problems'` for Phase 1)
  - `panelHeight` — number (px), initialized from localStorage or default 200
- Commands:
  - `togglePanel()` — flip isOpen
  - `openTab(tabId)` — set activeTab + open if closed
  - `closePanel()` — set isOpen false (keep activeTab)
  - `setPanelHeight(height)` — update + persist to localStorage
- Provider: `DevSightProvider` wrapping children
- Hook: `useDevSight()` with context guard (throw if outside provider)

### 1c. Wire diagnostic events
- Where: `src/components/App.jsx` (or wherever `listenLspEvents` is called)
- What: Add a second listener callback that forwards diagnostics to devSightDomain
- The existing `onDiagnostics` callback in EditorMonaco continues unchanged
- DevSight domain gets its own independent subscription to `lsp:diagnostics`

---

## Slice 2: Panel Shell + Tab Bar

**Goal**: Render the bottom panel with open/close animation and tab navigation.

### 2a. DevSight Shell
- Where: `src/devsight/DevSightShell.jsx`
- What: Bottom-anchored panel with:
  - Resize handle (top edge, `cursor: row-resize`, drag to resize)
  - Tab bar (horizontal tabs with active indicator)
  - Content area (renders active tab component)
  - Close button (✕) at right end of tab bar
- Consumes `useDevSight()` for state
- Only renders when `isOpen` is true (or renders hidden for animation)
- Animation: `translateY(100%)` → `translateY(0)`, 280ms ease, matching drawer transitions

### 2b. Resize logic
- Where: `DevSightShell.jsx`
- What: `onMouseDown` on resize handle starts drag tracking
  - `mousemove` updates `panelHeight` via context
  - `mouseup` ends drag, persists height to localStorage
  - Clamp between 100px min and 60% viewport max
- Consider: `requestAnimationFrame` throttle during drag for smoothness

### 2c. Tab bar component
- Where: Inline in `DevSightShell.jsx` or extracted if complex
- What: Horizontal tab strip
  - Phase 1 tabs: Problems (active), Console (disabled/dimmed), Output (disabled/dimmed)
  - Active tab has bottom border accent (glass theme glow)
  - Badge on Problems tab: error count (red) + warning count (yellow)
  - Click active tab → close panel (VS Code behavior)
  - Click inactive tab → switch to it

### 2d. Keyboard shortcut
- Where: `src/components/App.jsx`
- What: Register `Ctrl+Shift+I` / `Cmd+Shift+I` keydown handler
  - Calls `devSightContext.togglePanel()`
  - Must not conflict with existing shortcuts
  - Also register `Ctrl+Shift+M` → `openTab('problems')` (VS Code convention)
  - `Escape` when DevSight has focus → close panel

---

## Slice 3: Problems Panel

**Goal**: Display LSP diagnostics in a grouped, filterable list.

### 3a. Problems Panel component
- Where: `src/devsight/ProblemsPanel.jsx`
- What: Main content for the Problems tab
  - Reads filtered diagnostics from devSightDomain
  - Renders filter bar at top
  - Renders diagnostic list grouped by file below
  - Shows empty state when no diagnostics match

### 3b. File group sections
- Where: `ProblemsPanel.jsx`
- What: Collapsible sections per file
  - Header: relative file path + diagnostic count for that file
  - Expand/collapse toggle (default: expanded)
  - Within group: sorted by severity (error first), then line number

### 3c. Problem Row component
- Where: `src/devsight/ProblemRow.jsx`
- What: Single diagnostic row
  - Severity icon: `✕` (red), `⚠` (yellow), `ℹ` (blue), `💡` (gray)
  - Location: `filename:line:col`
  - Message: diagnostic text (truncate with tooltip if long)
  - Code: rule code (e.g., `TS2304`)
  - Source: LSP server name
  - Click handler: signal editor to open file at position
  - Keyboard: focusable, Enter to navigate
  - Right-click: context menu with "Copy Message", "Copy Location"

### 3d. Filter bar component
- Where: `src/devsight/ProblemFilters.jsx`
- What: Filter controls above the diagnostic list
  - Severity toggles: four buttons (Error/Warning/Info/Hint) that toggle on/off
  - Text search: input field that filters across message + code + filename
  - Source dropdown: if multiple LSP servers active, dropdown to filter by source
  - Clear filters button

### 3e. Click-to-navigate
- Where: `ProblemRow.jsx` click handler → App.jsx or editor domain
- What: When user clicks a diagnostic row:
  - Open the file in the editor (if not already open as a tab)
  - Scroll to the diagnostic line
  - Place cursor at the diagnostic column
  - Flash/highlight the line briefly for visual feedback
- This requires a callback from DevSight up to the editor layer — prop drilling or a shared navigation command

---

## Slice 4: Status Bar Integration

**Goal**: Show error/warning counts in the status bar. Badge acts as secondary toggle.

### 4a. Diagnostic badge component
- Where: `src/components/StatusBar.jsx`
- What: New element in the right zone (before minimap toggle)
  - Reads `errorCount` and `warningCount` from devSightDomain
  - Renders: `✕ N` (red) and/or `⚠ M` (yellow)
  - Hidden when both counts are 0
  - `aria-live="polite"` for screen reader announcements

### 4b. Badge click behavior
- Where: `StatusBar.jsx`
- What: Click badge → `devSightContext.openTab('problems')`
  - Opens DevSight panel if closed
  - Switches to Problems tab if on different tab

---

## Slice 5: Styling

**Goal**: Glass-theme-consistent styling for all DevSight components.

### 5a. Panel shell styles
- Where: `src/styles/devsight.css`
- What:
  - `.devsight-root` — positioned at bottom, full width, `backdrop-filter: blur()`, glass border
  - `.devsight-resize-handle` — top edge, 4px hit area, `cursor: row-resize`, subtle hover highlight
  - `.devsight-tabs` — horizontal flex, tab items with padding and border-bottom
  - `.devsight-tab.is-active` — accent color bottom border, glass glow
  - `.devsight-tab.is-disabled` — dimmed opacity, cursor default
  - `.devsight-close` — positioned right end of tab bar
  - `.devsight-content` — flex-fill, overflow-y auto

### 5b. Problems-specific styles
- Where: `src/styles/devsight.css`
- What:
  - `.devsight-filters` — filter bar flex layout, compact height
  - `.devsight-file-group` — collapsible section with file path header
  - `.devsight-problem-row` — grid row (icon | location | message | code | source)
  - `.devsight-problem-row:hover` — subtle highlight
  - `.devsight-problem-row:focus-visible` — keyboard focus ring
  - `.devsight-severity-error` — red text/icon
  - `.devsight-severity-warning` — yellow text/icon
  - `.devsight-severity-info` — blue text/icon
  - `.devsight-severity-hint` — gray text/icon
  - `.devsight-empty` — centered empty state message
  - `.devsight-badge` — status bar badge styling

### 5c. Animation and transitions
- Where: `src/styles/devsight.css`
- What:
  - Panel open/close: `transform` + `opacity` transition, `var(--drawer-transition)` timing
  - Tab switch: content fade or instant swap (match drawer behavior)
  - Resize: no transition during drag (immediate), transition on release

---

## Slice 6: Integration + Polish

**Goal**: Wire everything into App.jsx and handle edge cases.

### 6a. App.jsx integration
- Where: `src/components/App.jsx`
- What:
  - Import and wrap with `DevSightProvider`
  - Render `DevSightShell` between workspace and status bar
  - Pass devSightDomain to StatusBar for badge counts
  - Wire keyboard shortcuts in the existing keydown handler
  - Initialize devSightDomain diagnostic listener alongside existing LSP setup

### 6b. Layout coordination
- Where: `App.jsx` + CSS
- What:
  - When DevSight is open, workspace area shrinks to accommodate panel height
  - Canvas viewport recalculates (Konva stage resize)
  - Editor drawer remains functional above DevSight
  - Top drawer (terminal) remains functional independently
  - Both DevSight and terminal can be open simultaneously

### 6c. Edge cases
- No project open → DevSight opens but Problems shows empty state
- No LSP servers active → Problems shows "No language servers active" hint
- File deleted while diagnostics exist → remove stale diagnostics on next publish
- Panel open during canvas drag → panel doesn't capture pointer events from canvas
- Multiple LSP servers for same file → merge diagnostics, tag with source

---

## Build Order Summary

| Slice | Deliverable | Depends On |
|---|---|---|
| 1 | Domain + Context (data layer) | — |
| 2 | Panel shell + tab bar + keyboard shortcut | Slice 1 |
| 3 | Problems panel (list, rows, filters, navigation) | Slice 1, 2 |
| 4 | Status bar badge | Slice 1 |
| 5 | Styling (glass theme) | Slice 2, 3, 4 |
| 6 | App.jsx integration + layout coordination + edge cases | All above |

Slices 3 and 4 can be built in parallel after Slice 2.

---

## Exit Criteria

- [ ] `Ctrl+Shift+I` toggles DevSight panel open/closed
- [ ] Panel renders at bottom with glass theme styling
- [ ] Panel height is draggable between 100px and 60% viewport
- [ ] Panel height persists across sessions
- [ ] Tab bar shows Problems (active), Console (disabled), Output (disabled)
- [ ] Problems tab displays LSP diagnostics grouped by file
- [ ] Diagnostics sorted: errors first, then warnings, then by line number
- [ ] Severity filter toggles work (error/warning/info/hint)
- [ ] Text search filters across message, code, and filename
- [ ] Click diagnostic row → editor opens file at line:col
- [ ] Right-click row → copy message/location
- [ ] Empty state renders when no diagnostics
- [ ] Status bar shows `✕ N ⚠ M` badge when diagnostics exist
- [ ] Status bar badge click opens DevSight → Problems tab
- [ ] Badge hidden when zero errors and zero warnings
- [ ] DevSight and terminal (top drawer) can be open simultaneously
- [ ] Canvas interaction unaffected when DevSight is closed
- [ ] Workspace area resizes correctly when DevSight opens/closes
- [ ] No regressions in existing LSP diagnostic display (Monaco markers, hover cards)

---

## Future Phases (Not In Scope)

- **Phase 2**: Console tab — requires terminal PTY stream tap architecture
- **Phase 3**: Output tab — requires channel system or task runner
- **Phase 4**: Network tab — requires error parser registry for HTTP log patterns
- **Phase 5**: Performance tab — requires Rust sysinfo child process monitoring
- **Error parser registry**: Separate plan doc when Console/Output phases begin
- **DAP debugger integration**: Entirely separate feature, not part of DevSight

---

## References

- PRD: `docs/prds/devsight-prd.md`
- LSP pipeline: `src-tauri/src/lsp/ipc_bridge.rs`, `src/lsp/lspClient.js`, `src/components/EditorMonaco.jsx`
- Terminal domain: `src/terminal/terminalDomain.js`, `src-tauri/src/terminal_pty.rs`
- Drawer context pattern: `src/drawers/DrawerContext.jsx`, `src/drawers/TopDrawerContext.jsx`
- Status bar: `src/components/StatusBar.jsx`
- Glass theme: `src/styles/drawers.css`, ADR-008
