# Product Requirements Document
## DevSight — Project Diagnostics Panel
**Project:** Litria
**Component:** DevSight
**Version:** 1.0
**Status:** Planning (2026-03-26)
**Relates to:** LSP Client (slices 1A-1D), Terminal Domain, Status Bar v1.0

---

## 1. Overview

DevSight is a bottom-anchored diagnostics panel that surfaces build errors, console output, and runtime information from the user's project. It is the Litria equivalent of Chrome DevTools or VS Code's Problems/Output panels — scoped to whatever project is open, toggled manually with `Ctrl+Shift+I`.

---

## 2. Goals

- Give users a single panel to see all project diagnostics (errors, warnings, console output)
- Surface LSP diagnostics in a filterable, navigable list (Problems tab)
- Provide structured read-only views of terminal output (Console, Output tabs)
- Enable click-to-navigate from any diagnostic to the source file and line in the editor
- Show error/warning counts in the status bar for ambient awareness
- Support future extensibility (Network, Performance tabs) without v1 coupling

---

## 3. Non-Goals

- DevSight does NOT debug Litria itself (this is for user projects only)
- DevSight does NOT auto-open on errors (always manual toggle)
- DevSight does NOT replace the terminal (terminal is interactive; DevSight is read-only)
- DevSight does NOT require a task runner or run-configuration system
- DevSight does NOT provide a JavaScript REPL or interactive debugger (DAP is a separate future feature)
- Network and Performance tabs are NOT part of v1

---

## 4. Tech Stack Constraints

| Layer | Technology |
|---|---|
| Frontend | React 19 |
| State management | Context + domain pattern (matches DrawerContext/TopDrawerContext) |
| Styling | Tailwind CSS + Glass theme system |
| Icons | Lucide |
| Desktop wrapper | Tauri v2 |
| Data source (diagnostics) | LSP `textDocument/publishDiagnostics` via `lsp:diagnostics` Tauri event |
| Data source (terminal) | PTY output stream via existing Terminal domain channel |
| Status bar integration | Existing `StatusBar.jsx` component |

---

## 5. User Workflow

The primary use case DevSight solves:

```
User is building a project in Litria (web app, Tauri app, Node service, etc.)
    │
    ▼
User runs build/dev command in Litria's terminal
    │
    ▼
Something breaks — build error, runtime exception, unexpected behavior
    │
    ▼
User presses Ctrl+Shift+I
    │
    ▼
DevSight panel slides up from bottom showing:
  - Problems tab: LSP errors/warnings sorted by file
  - Console tab: parsed terminal output with log levels
  - Output tab: raw build output by channel
    │
    ▼
User clicks an error → editor jumps to file:line
User copies error text → shares with AI or teammate for help
User fixes the issue → error disappears from Problems
```

---

## 6. Layout

DevSight is a bottom panel, separate from the top drawer system. It occupies the full width of the viewport below the canvas workspace.

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│              Litria Workspace (Canvas + Editor)                  │
│                                                             │
│                                                             │
├══════════════════╤══════════════════════════════════════╤════┤ ← draggable resize edge
│ Problems (3) ⚠ 1 │ Console │ Output │                  │ ✕  │ ← tab bar + close button
├──────────────────┴──────────────────────────────────────┴────┤
│                                                             │
│  ✕ src/app.tsx:42:5       Cannot find name 'foo'    TS2304  │
│  ✕ src/api.ts:15:10       Type 'string' not          TS2322 │
│                            assignable to 'number'           │
│  ⚠ src/utils.ts:8:3       'bar' is declared but      TS6133 │
│                            never used                       │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ [status bar]   X: 120  Y: 340  │ MyProject  All Saved │ E:2 W:1 │ ← error/warning badge
└─────────────────────────────────────────────────────────────┘
```

---

## 7. Panel Shell Specification

### 7.1 Visibility & Toggle

| Property | Value |
|---|---|
| Default state | Hidden (not rendered) |
| Toggle shortcut | `Ctrl+Shift+I` (Windows/Linux), `Cmd+Shift+I` (macOS) |
| Toggle behavior | Press to open, press again to close |
| Clicking active tab | Collapses panel (same as VS Code) |
| Status bar button | Error/warning badge acts as secondary toggle |
| Command palette | "DevSight: Toggle Panel", "DevSight: Show Problems", etc. |

### 7.2 Sizing & Resize

| Property | Value |
|---|---|
| Initial height | 200px |
| Min height | 100px |
| Max height | 60% of viewport |
| Resize | Draggable top edge (cursor: `row-resize`) |
| Height persistence | Remember height across sessions via localStorage |

### 7.3 Tab Bar

| Property | Value |
|---|---|
| Tab items | Problems, Console, Output (v1). Network, Performance (future) |
| Active indicator | Bottom border highlight (glass theme accent) |
| Badge counts | Problems tab shows error count (red) + warning count (yellow) |
| Close button | `✕` at right end of tab bar closes entire panel |
| Keyboard nav | `Ctrl+Shift+M` focuses Problems tab specifically (VS Code convention) |

### 7.4 Animation

| Property | Value |
|---|---|
| Open | `transform: translateY(100%)` → `translateY(0)` with `280ms ease` |
| Close | Reverse of open |
| Opacity | `0 → 1` on open |
| Backdrop | `backdrop-filter: blur()` matching glass theme system |

---

## 8. Tab Specifications

### 8.1 Problems Tab

**Data source:** LSP `textDocument/publishDiagnostics` events (already flowing via `lsp:diagnostics` Tauri event)

**Display:**

| Column | Content | Width |
|---|---|---|
| Severity icon | `✕` error (red), `⚠` warning (yellow), `ℹ` info (blue), `💡` hint (gray) | Fixed 24px |
| Location | `filename:line:col` (relative to project root) | Auto |
| Message | Diagnostic message text | Flex fill |
| Code | Rule code (e.g., `TS2304`, `F821`, `no-undef`) | Fixed 80px |
| Source | LSP server name (e.g., `typescript`, `pylsp`) | Fixed 80px |

**Grouping:** By file (collapsible sections). File header shows path + count.

**Sorting:** Within each file group: severity (error first), then line number.

**Filters:**
- Severity toggles: Error / Warning / Info / Hint (all on by default)
- Text search: Filter across message, code, and filename
- Source filter: Dropdown for multi-LSP projects (e.g., show only TypeScript or only Python)

**Interactions:**
- Click row → open file at line:col in editor, scroll into view, flash highlight
- Right-click → context menu: "Copy Message", "Copy Location", "Copy All"
- Double-click → open file and close DevSight
- Keyboard: arrow keys navigate rows, Enter opens file

**Empty state:** "No problems detected" with checkmark icon.

**Live updates:** Panel updates in real-time as LSP publishes new diagnostics. No polling — event-driven.

### 8.2 Console Tab

**Data source:** Terminal PTY output stream (passive tap — read-only secondary consumer)

**Display:**
- Timestamped log entries
- Color-coded by detected level: error (red), warn (yellow), info (default), debug (dim)
- Stack traces rendered as collapsible blocks with clickable file references
- Structured objects rendered as expandable tree (if JSON-parseable)

**Level detection heuristic:**
- Lines containing `ERROR`, `Error:`, `error:`, `FATAL`, `panic` → error
- Lines containing `WARN`, `Warning:`, `warn:` → warn
- Lines containing `DEBUG`, `debug:`, `TRACE` → debug
- Everything else → info

**Filters:**
- Level toggles: Error / Warn / Info / Debug
- Text search across all output
- Clear button (clears display buffer, not terminal)

**Interactions:**
- File paths in stack traces → click to open in editor
- "Copy All" / "Copy Selection" for sharing
- Auto-scroll with pin/lock toggle
- Scroll position preserved when pinned

**Buffer:** Rolling buffer of last 10,000 lines. Oldest entries pruned when limit reached.

### 8.3 Output Tab

**Data source:** Same terminal PTY stream as Console, but organized by channel.

**Channels:**
- Default channel: "Terminal" (all output)
- Future channels when task runner exists: "Build", "Dev Server", "Lint", "Test"
- Channel selector dropdown in tab header

**Display:**
- Raw output with ANSI color rendering (reuse xterm.js ANSI parser or lightweight alternative)
- Monospace font, preserves formatting
- No level parsing — this is the unprocessed stream

**Difference from Console:** Console parses and structures. Output is raw and faithful.

**Interactions:**
- Same copy/clear/auto-scroll as Console
- Channel switching via dropdown
- Word wrap toggle

---

## 9. Error Parser Registry

Pluggable system for extracting structured diagnostics from build tool output. Used by Problems tab (to surface build errors alongside LSP diagnostics) and Console tab (to make file references clickable).

### 9.1 Parser Interface

Each parser extracts: `{ file, line, col, severity, message, code, source }`

### 9.2 Initial Parsers

| Parser | Pattern | Example |
|---|---|---|
| TypeScript (tsc) | `file(line,col): error TScode: message` | `src/app.tsx(42,5): error TS2304: Cannot find name 'foo'` |
| Rust (rustc) | `error[code]: message --> file:line:col` | `error[E0425]: cannot find value 'foo' --> src/main.rs:42:5` |
| ESLint | `line:col  severity  message  rule` | `42:5  error  'foo' is not defined  no-undef` |
| Python traceback | `File "file", line N ... ErrorType: message` | `File "app.py", line 42 ... NameError: name 'foo' is not defined` |
| Generic stack trace | `at file:line:col` | `at Object.<anonymous> (/src/app.js:42:5)` |
| Vite | `[vite] error: message` | `[vite] Internal server error: Failed to resolve import` |

### 9.3 Extensibility

- Parsers registered as objects with `name`, `pattern` (regex), and `extract` (function)
- New parsers can be added without modifying existing code
- Long-term: user-configurable parsers or community plugin system

---

## 10. Status Bar Integration

The existing status bar gains an error/warning badge in the right zone.

### 10.1 Badge Specification

| State | Display | Behavior |
|---|---|---|
| No diagnostics | Hidden (no badge) | — |
| Warnings only | `⚠ N` (yellow) | Click opens DevSight → Problems tab |
| Errors only | `✕ N` (red) | Click opens DevSight → Problems tab |
| Both | `✕ N  ⚠ M` (red + yellow) | Click opens DevSight → Problems tab |

### 10.2 Count Source

Aggregate across ALL active LSP servers. Count only Error and Warning severities (Info/Hint excluded from badge to avoid noise).

---

## 11. State Management

### 11.1 DevSightContext

Follows the established DrawerContext/TopDrawerContext pattern.

**State:**
- `isOpen` — boolean, panel visible
- `activeTab` — string: `'problems'` | `'console'` | `'output'`
- `panelHeight` — number (persisted)

**Commands:**
- `togglePanel()` — open/close
- `openTab(tabId)` — open panel to specific tab
- `closePanel()` — close panel
- `setPanelHeight(px)` — resize

### 11.2 DevSight Domain

Manages diagnostic data, console buffer, and output channels.

**State:**
- `diagnosticsByUri` — `Map<string, Diagnostic[]>` from LSP events
- `errorCount` / `warningCount` — aggregated counts for status bar
- `consoleBuffer` — rolling array of parsed log entries
- `outputBuffer` — rolling array of raw output lines
- `filters` — current severity/text/source filter state

**Commands:**
- `handleDiagnostics(uri, diagnostics)` — process incoming LSP diagnostics
- `handleTerminalOutput(chunk)` — parse and buffer terminal output
- `clearConsole()` / `clearOutput()` — clear display buffers
- `setFilter(type, value)` — update filters
- `navigateToSource(file, line, col)` — signal editor to open file

---

## 12. Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+I` / `Cmd+Shift+I` | Toggle DevSight panel |
| `Ctrl+Shift+M` / `Cmd+Shift+M` | Focus Problems tab (VS Code convention) |
| `Escape` (when DevSight focused) | Close DevSight panel |
| `Ctrl+Shift+C` / `Cmd+Shift+C` | Focus Console tab |
| Arrow keys (in Problems) | Navigate diagnostic rows |
| `Enter` (in Problems) | Open selected diagnostic in editor |

---

## 13. Accessibility

- All tabs reachable via keyboard (Tab key cycles, Enter activates)
- Severity icons have `aria-label` (e.g., "Error", "Warning")
- Problems list is an ARIA `role="listbox"` with `role="option"` items
- Status bar badge has `aria-live="polite"` for screen reader updates
- High contrast mode: severity colors meet WCAG AA contrast ratios
- Focus trap within panel when open (Escape exits)

---

## 14. Phasing

| Phase | Scope | Dependencies | Effort |
|---|---|---|---|
| **1** | Panel shell + DevSightContext + Problems tab + status bar badge | LSP diagnostics (existing) | Medium |
| **2** | Console tab (terminal stream tap + log level parsing) | Terminal domain stream exposure | Medium |
| **3** | Output tab (channel system + ANSI rendering) | Phase 2 stream tap | Low-Medium |
| **4** | Network tab (parse terminal output for HTTP patterns) | Phase 2 stream tap + parser registry | Medium |
| **5** | Performance tab (child process monitoring) | Rust sysinfo integration | High |

Phase 1 is the priority. It delivers the highest-value feature (seeing errors) with the lowest effort (data already exists).

---

## 15. Exit Criteria

### Phase 1 (Minimum Viable DevSight)
- [ ] Bottom panel renders with glass theme styling
- [ ] `Ctrl+Shift+I` toggles panel open/closed
- [ ] Panel height is draggable and persisted
- [ ] Tab bar with Problems tab active
- [ ] Problems tab displays LSP diagnostics grouped by file
- [ ] Severity filters (error/warning/info/hint) work
- [ ] Text search filters across diagnostics
- [ ] Click diagnostic → editor opens file at line:col
- [ ] Status bar shows error/warning badge counts
- [ ] Status bar badge click opens DevSight → Problems
- [ ] Empty state shows "No problems detected"
- [ ] Panel does not interfere with top drawer (terminal) operation
- [ ] Panel does not interfere with canvas interaction when closed

---

## 16. References

- LSP diagnostic pipeline: `src-tauri/src/lsp/ipc_bridge.rs` (emit), `src/lsp/lspClient.js` (listen), `src/components/EditorMonaco.jsx` (consume)
- Terminal PTY architecture: `src-tauri/src/terminal_pty.rs`, `src/terminal/terminalDomain.js`, `src/components/TerminalRenderer.jsx`
- Drawer context pattern: `src/drawers/DrawerContext.jsx`, `src/drawers/TopDrawerContext.jsx`
- Status bar: `src/components/StatusBar.jsx`
- Glass theme system: `src/styles/drawers.css`, ADR-008
