# Product Requirements Document
## Litria Status Bar
**Project:** Litria
**Component:** Status Bar
**Version:** 1.0
**Status:** Ready for Development

---

## 1. Overview

The Litria Status Bar is a fixed, persistent UI component docked to the bottom of the Tauri application window, outside and below the Konva canvas. It provides at-a-glance project state, canvas navigation, zoom control, minimap access, and save state feedback in a single, unobtrusive bar.

---

## 2. Goals

- Provide persistent, real-time canvas orientation data (coordinates + zoom)
- Surface project name and save state without requiring menu navigation
- Offer minimap visibility toggle without consuming canvas space
- Provide a one-click escape hatch for lost viewport recovery

---

## 3. Non-Goals

- This component does not handle voice input (deferred to StatusBar v1.1)
- This component does not replace the settings panel for keybind configuration
- This component does not render inside or on top of the Konva canvas

---

## 4. Tech Stack Constraints

| Layer | Technology |
|---|---|
| Frontend | React |
| Icons | Lucide |
| Desktop Wrapper | Tauri |
| Canvas | React Konva |
| Styling | Tailwind CSS |

---

## 5. Layout

The status bar is divided into three fixed zones rendered in a single horizontal row.

```
[ Left Zone ]--------------------[ Center Zone ]--------------------[ Right Zone ]
```

The bar does not reflow or collapse. It is always visible while the application is open.

| Property | Value |
|---|---|
| Height | 30px (matches MenuBar and ProjectBar) |
| Background | Litria dark surface color (`rgba(18, 18, 18, 0.92)`) |
| Border | 1px top border, subtle separator (matches existing bar patterns) |
| Font size | 11px for status bar text |
| Z-index | 50 (above canvas, below modals) |

---

## 6. Zone Specifications

### 6.1 Left Zone -- Canvas Navigation + Zoom

**Purpose:** Display live canvas coordinates, provide viewport reset, and control zoom level.

**Layout (left to right):**
```
[ Crosshair Icon ]  X: 0420  Y: -0130  |  125%
```

---

#### 6.1.1 Crosshair / Reset View Button

| Element | Detail |
|---|---|
| Icon | Lucide `Crosshair` |
| Click behavior | Two-tier reset (see below) |

**Reset behavior:**

| Condition | Action |
|---|---|
| Nodes exist on canvas | `fitToBounds` all pieces (adjusts pan and zoom to show everything) |
| No nodes on canvas | Reset to origin `(0,0)` at scale `1.0` |

This is an escape hatch for lost viewport recovery -- if the user drags to an empty area and can't find their work, this button brings everything back into view.

---

#### 6.1.2 Coordinates

| Property | Detail |
|---|---|
| Values shown | World-space viewport center point (X and Y) |
| Font | Monospace to prevent layout shift during updates |
| Format | Signed integers, zero-padded to 4 digits |

**Display format:**
```
X: 0420  Y: -0130
```

**Coordinate calculation:**
```
centerX = (containerWidth / 2 - offsetX) / scale
centerY = (containerHeight / 2 - offsetY) / scale
```

Where `offsetX`, `offsetY`, and `scale` come from `useViewport()`.

**Notes:**
- Coordinates reflect where the user is "looking at" on the canvas (viewport center in world space)
- Values are signed integers (negative for left/up of origin)
- Zero-padded to 4 digits for visual stability

**Performance requirement:** Coordinates update every frame during pan but must NOT trigger React re-renders of the rest of the status bar. Implementation must use an isolated `<ViewportCoords />` component that subscribes to viewport state via ref and updates DOM text nodes directly (`ref.current.textContent = ...`). The save indicator, zoom label, and minimap toggle remain static during pan.

---

#### 6.1.3 Zoom Level

| Property | Detail |
|---|---|
| Display | Percentage label (e.g. `125%`) |
| Source | `useViewport().scale` converted to percentage |
| Click | Opens zoom popover |
| Double-click | Resets zoom to 100% (shortcut, no popover) |

**Zoom popover:**

| Property | Detail |
|---|---|
| Trigger | Single click on zoom label |
| Dismiss | Click zoom label again, or click outside |
| Size | 180px wide, 35px tall |
| Position | Anchored directly above the zoom label |
| Style | Slight drop shadow, same visual language as other Litria popovers |
| Control | Stepped drag slider |

**Slider specification:**

| Property | Detail |
|---|---|
| Type | Stepped (discrete positions, not continuous) |
| Range | MIN_ZOOM (0.1) to MAX_ZOOM (3.0) |
| Steps | 10%, 25%, 50%, 75%, 100%, 125%, 150%, 200%, 250%, 300% |
| Behavior | Dragging snaps to nearest step |

**Note:** Zoom level is moved here from ProjectBar. ProjectBar retains the project name and project switcher.

---

### 6.2 Center Zone -- Project State

**Purpose:** Display the active project name and current save state.

**Elements:**

| Element | Detail |
|---|---|
| Project Name | String -- name of the currently open project (from `projectInstance.name`) |
| Save State Indicator | Single slot, two mutually exclusive states |

**Save State -- Two States (same position, swap in place):**

| State | Display | Color |
|---|---|---|
| Unsaved files present | `* N` where N = count of dirty editor tabs | Amber |
| All files saved | `check All Saved` | Muted green |

**Display format:**
```
My Project Name   * 3
My Project Name   check All Saved
```

**Dirty count definition:** A tab is dirty when `workingCode !== code` in the editor session. This counts only editor file tabs with unsaved text changes. Canvas layout changes (piece positions, groups) are not included as they auto-persist via the manifest queue.

**Data source:** `useEditorSession()` -- requires adding a `dirtyTabCount` derived value (currently only `hasDirtyTabs` boolean and per-tab `isTabDirty(tabId)` exist).

**Notes:**
- The save state indicator occupies one fixed-width slot
- No layout shift occurs when state transitions
- N reflects unsaved file count only

---

#### 6.2.1 Dirty File Popover

| Property | Detail |
|---|---|
| Trigger | Click on the save state indicator (when dirty files exist) |
| Dismiss | Click outside or click indicator again |
| Content | List of dirty filenames |
| Item click | Opens the editor drawer (if closed) and switches to the clicked file's tab |

**Behavior:**
- Only appears when `dirtyTabCount > 0`
- Each list item shows the filename of a dirty tab
- Clicking a filename calls `setActiveTabId(tabId)` and ensures the editor drawer is open
- Popover anchors above the save state indicator

---

### 6.3 Right Zone -- Minimap Toggle

**Purpose:** Provide a toggle to show/hide the canvas minimap.

**Layout:**
```
[ Map Icon ]
```

| Property | Detail |
|---|---|
| Icon | Lucide `Map` |
| Click behavior | Toggles minimap visibility (show/hide) |
| Active state | Icon highlighted when minimap is visible |

**Implementation notes:**
- The existing `Minimap.jsx` component stays parented inside CanvasArea in its current DOM position
- The status bar button is a remote control that toggles the minimap's visibility state
- No DOM reparenting, no dock/undock mechanics, no drag-snap behavior
- The minimap component already receives all data via props -- no architectural changes needed

---

## 7. Persistence

| Setting | Storage | Status |
|---|---|---|
| Minimap visibility | React session state (resets on app restart) | v1.0 |
| Zoom level | Already persisted in `litria.project.json` via viewport state | v1.0 |
| ~~Voice input mode (PTT vs Always Listening)~~ | ~~User profile~~ | Planned for v1.1 |
| ~~Minimap last undocked position~~ | ~~User profile~~ | N/A (dock/undock removed) |

**Note:** A `cm:user_settings` localStorage key for app-level user preferences is planned for a future release but is not required for StatusBar v1.0. All v1.0 state is either session-scoped or already persisted through existing mechanisms.

---

## 8. Behavior Summary

| Interaction | Result |
|---|---|
| Click crosshair icon (nodes exist) | Viewport fits all pieces into view |
| Click crosshair icon (no nodes) | Viewport resets to origin (0,0) at scale 1.0 |
| Pan canvas | X/Y coordinates update in real time (ref-driven, no re-renders) |
| Files become unsaved | Center indicator switches to `* N` in amber |
| All files saved | Center indicator switches to `check All Saved` in muted green |
| Click save indicator (dirty files) | Popover lists dirty filenames |
| Click filename in dirty popover | Editor opens and switches to that tab |
| Click zoom label | Zoom popover appears with stepped slider |
| Double-click zoom label | Zoom resets to 100% |
| Drag zoom slider | Zoom changes in stepped increments |
| Click Map icon | Toggles minimap visibility on/off |

---

## 9. Out of Scope for v1.0

- Voice input UI (toggle, mic icon, audio visualizer) -- deferred to StatusBar v1.1
- Voice transcription pipeline
- AI routing from voice input
- Keybind remapping UI (belongs in Settings)
- Additional status bar zones or controls
- Theming or color customization of the bar
- User profile / app-level preference persistence
- Minimap dock/undock/snap-back mechanics (replaced by simple toggle)

---

## 10. Future: StatusBar v1.1 -- Voice Input (Right Zone)

The Right Zone will be extended in v1.1 to include voice input controls using `whisper.rs` for on-device speech recognition. This enables users to speak commands to AI coding agents instead of typing.

**Planned elements:**
- Voice input mode toggle (Push-to-Talk vs Always Listening)
- Mic icon (state indicator)
- Audio visualizer (16-32 vertical bars, amplitude-reactive)

This will be specified in a separate PRD when voice infrastructure is ready.

---

## 11. Open Items

| # | Item | Owner |
|---|---|---|
| 1 | Add `dirtyTabCount` derived value to `EditorSessionContext` | Frontend |
| 2 | Expose viewport subscribe/ref pattern for `<ViewportCoords />` | Frontend |
| 3 | Remove zoom display from ProjectBar after StatusBar ships | Frontend |
| 4 | Confirm exact zoom step values during implementation | Frontend |
| 5 | Define zoom popover visual design (shadow, border, colors) | Design |

---

## 12. Integration Points

Reference for implementation -- existing codebase hooks and components.

| Need | Source | API |
|---|---|---|
| Viewport state | `src/behaviors/useViewport.js` | `scale`, `offsetX`, `offsetY`, `fitToBounds()` |
| Dirty tab state | `src/editor/EditorSessionContext.jsx` | `hasDirtyTabs`, `isTabDirty(tabId)`, `setActiveTabId()` |
| Project name | `src/App.jsx` | `projectInstance.name` (passed as prop) |
| Minimap toggle | `src/components/Minimap.jsx` | New visibility prop, controlled from status bar state |
| Stage dimensions | `src/App.jsx` | `deskWidth`, `deskHeight` (for coordinate calculation) |
| Zoom constants | `src/behaviors/useViewport.js` | `MIN_ZOOM` (0.1), `MAX_ZOOM` (3.0) |

**Insertion point:** Status bar renders as a sibling after the canvas area div in `App.jsx` (approximately line 1098), inside the `.App` flex column.
