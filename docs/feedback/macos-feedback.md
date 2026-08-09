# macOS Tester Feedback

Tester: PokkitNebula (RAVN)
Platform: macOS (details TBD — Intel vs Apple Silicon, macOS version)
Date started: 2026-03-23

---

## Feedback Log

### 1. Placeholder paths are Windows-specific
**Status**: Open
**Severity**: Low (cosmetic)
**Source**: Screenshot — "Open Existing Litria Project" modal

The path input placeholders are hardcoded Windows paths:
- `C:\Projects\python projects` (new project modal)
- `C:\Projects\my-cm-project` (open project modal)

**Location**: `src/components/LaunchScreen.jsx` lines 278 and 426

**Fix**: Detect platform and show appropriate placeholder:
- Windows: `C:\Projects\my-project`
- macOS: `~/Projects/my-project`
- Linux: `~/projects/my-project`

Tauri provides `os.platform()` via `@tauri-apps/api/os`, or use the
already-available Tauri environment info to branch at render time.

---

### 2. Freeze/crash on maximize (middle window control button)
**Status**: Open
**Severity**: High (crash)
**Source**: Bug Report #1

Clicking the maximize/restore button (middle custom titlebar control) freezes
or crashes the app on macOS.

**Location**: `src/components/MenuBar.jsx` line 36 — `getCurrentWindow().toggleMaximize()`

**Root cause (likely)**: Tauri v2 `toggleMaximize()` + `decorations: false` on
macOS. The custom titlebar means Litria uses an undecorated window. macOS window
management (zoom vs fullscreen vs maximize) behaves differently from Windows,
and WKWebView can enter a bad state during the resize of an undecorated window.

**Investigation needed**:
- Check Tauri GitHub issues for `toggleMaximize` + `decorations: false` on macOS
- Test whether `setFullscreen(!isFullscreen)` works better on macOS
- Consider platform-branching: `toggleMaximize()` on Windows,
  `setFullscreen()` on macOS, or skip the button entirely on macOS
  (native macOS apps use the green traffic light, not a custom maximize button)

---

### 3. No keyboard shortcut for save (Ctrl+S / Cmd+S)
**Status**: RESOLVED (commit `46a31b0`, 2026-06-13 — "Resolves macOS feedback #3").
Global capture-phase keydown listener in the always-mounted `EditorDrawer`:
`Cmd/Ctrl+S` saves the focused tab when dirty, `Cmd/Ctrl+Shift+S` saves all dirty
tabs. `isPrimaryModifier` maps it to Cmd on macOS / Ctrl elsewhere; capture phase +
preventDefault beats Monaco and the webview "save page" default. Works from canvas,
scaffold, or editor. (Canvas Save/Save All pill from PR #71 remains as the mouse
path.) This log entry was stale — the shortcut predates it.
**Severity**: Medium (UX / accessibility)
**Source**: Tester question

No global save shortcut exists. The only save triggers are the editor drawer
save button and the auto-save on app close.

**Notes**: This is not macOS-specific — it's missing on all platforms. But macOS
users in particular expect `Cmd+S` since it's universal across every Mac app.
This will be part of a broader keyboard shortcuts / accessibility pass.

**Scope**: Part of a future accessibility/shortcuts milestone, not a
platform-specific fix.

---

### 4. Terminal cursor appears one line below the prompt
**Status**: Open
**Severity**: Low (cosmetic)
**Source**: Screenshot — terminal showing `sh-3.2$` prompt

The terminal prompt (`sh-3.2$`) renders with the cursor appearing to be on
the line below it, which looks confusing.

**Root cause**: Litria's Unix shell allowlist defaults to `sh` (first entry in
`terminal_policy.rs` `ALLOWED_EXECUTABLES`). On macOS, `sh` is Bash 3.2
(Apple's ancient bundled version). Its default prompt and cursor positioning
look off in the xterm.js PTY — the sparse `PS1` and lack of modern shell
features makes the terminal feel broken even though it's working correctly.

**Note**: The terminal IS working — she ran `python main.py` successfully
multiple times. This is purely about the default shell choice.

**Fix options**:
- Detect the user's `$SHELL` env var and use that instead of hardcoded `sh`
  (macOS defaults to `zsh` since Catalina, which would give a normal prompt)
- Reorder the allowlist to prefer `zsh` > `bash` > `sh` on Unix
- Both: use `$SHELL` if it's in the allowlist, fall back to the ordered list

---

### 5. Canvas pan activates unintentionally (wants a lock/toggle)
**Status**: RESOLVED — the bug is fixed; the affordance is a WONTFIX by design
decision (2026-07-01). The underlying instability the tester hit was items #19
(right-drag moved the selected group) and #20 (stuck pan after drop), both now
fixed. Current pan gesture is right-mouse-drag + trackpad two-finger; plain mouse
wheel zooms; there is no left-drag pan — so pan no longer activates unintentionally.
The explicitly-requested pan lock/toggle affordance is intentionally NOT being
built: with the accidental-pan bugs gone, the current gesture model is fine and a
lock/toggle would add UI weight without a real problem to solve.
**Severity**: Medium (UX)
**Source**: Tester complaint — mouse movement triggers pan unexpectedly

The canvas pan function activates intermittently when the user doesn't intend
to pan, making interaction feel unreliable. Tester suggests a lock or toggle
for pan mode.

**Note**: This is a KNOWN cross-platform bug, not macOS-specific. The same
intermittent pan activation has been observed on Windows. Logging here because
the tester reported it, but the fix applies everywhere.

**Fix options**:
- Pan lock/toggle button on the canvas toolbar (click to enter pan mode,
  click again to exit)
- Require a modifier key for pan (e.g., Space+drag, matching Figma/Photoshop
  convention)
- Middle-mouse-button pan only (common in CAD/design tools)
- Combination: modifier key OR toggle button, user's choice

---

### 6. Canvas context menu overflows past viewport bottom
**Status**: RESOLVED (PR #70, 2026-06-17) — action pill rebuilt on the shadcn DropdownMenu with categorized Node/Group submenus + Radix collision-aware positioning and scroll, so it stays in the viewport.
**Severity**: Medium (UX — can't reach items)
**Source**: Screenshot — group actions popover on a piece near bottom of canvas

The actions menu (Deselect, Delete, Set Piece Color, Create Folder Group,
Collapse/Expand, Rename, Group Theme, Group Color) extends past the bottom
of the window chrome. Items below the fold are unreachable — no scroll,
no repositioning.

**Note**: Cross-platform issue, not macOS-specific. Reproducible on Windows
when a piece is positioned near the bottom of the canvas viewport.

**Fix options**:
- Collision-aware positioning: detect available space below the trigger and
  flip the popover upward when it would overflow (Radix Popover supports
  `collisionPadding` and `side="top"` fallback via `avoidCollisions`)
- Add `max-height` + `overflow-y: auto` to the menu container so it scrolls
  when content exceeds available space
- Tighten spacing/padding to reduce total menu height (mentioned by Dai)
- Best approach: collision-aware positioning + scroll fallback for edge cases

**Recommended menu structure** (from tester feedback + Dai):
Collapse grouping-related items into chevron submenus to shorten the top level.

```
Deselect
Delete
Set Piece Color
Group Actions        >  Create Folder Group
                        Collapse Folder Group
                        Expand Folder Group
                        Rename Group
Group Theme          >  Theme picker
                        Clear Group Theme
                        Group Color
```

Radix DropdownMenu `Sub` / `SubTrigger` / `SubContent` supports this natively.
shadcn dropdown-menu component wraps it — no new dependencies needed.

---

### 7. Canvas actions should also live in the menubar
**Status**: Open (feature request / UX principle)
**Severity**: Low (design)
**Source**: Tester suggestion — references Perforce as prior art

Every action available on the canvas (via right-click context menu) should
also be accessible from the top menubar (File, Edit, View, etc.). Examples:
- Edit > Group Actions > Create / Collapse / Expand / Rename
- Edit > Set Piece Color
- Edit > Delete

**Rationale**: Multiple access paths to the same action. Users should be able
to discover and trigger actions from either the canvas context menu or the
menubar. This also enables keyboard shortcuts (menubar items can display
accelerator hints) and improves accessibility (menubar supports keyboard
navigation via Alt+key and arrow keys).

**Prior art**: Perforce, VS Code, Figma — all mirror context menu actions
in the top-level menu system.

**Scope**: Part of a broader menubar buildout. Current menubar in
`src/components/MenuBar.jsx` has placeholder menus. This feedback defines
the expectation that canvas actions and menubar actions stay in sync.

---

### 8. Opening litria.project.json causes recursive scaffold loop
**Status**: Known issue (documented workaround)
**Severity**: Medium (footgun — no crash, but confusing behavior)
**Source**: Preemptive warning from Dai to tester

Opening `litria.project.json` or its `.bak` file inside Litria causes the scaffold
to recursively re-read and re-render the project structure in a loop. The
manifest is currently hidden from the scaffold tree to prevent this.

**Note**: Hiding the file prevents accidental discovery but doesn't protect
against manual path entry or drag-and-drop. If a user has to be warned not
to do something, the app should prevent it instead.

**Fix options**:
- Guard in the editor open path: refuse to open files matching
  `litria.project.json` or `*.litria.project.json.bak` with a toast/notification
  explaining why
- Filter at the Rust backend level: `read_file` / `open_file` commands
  reject manifest paths before content is returned
- Both: backend rejects + frontend toast for UX clarity

---

### 14. Canvas group desyncs from scaffold when folder is nested/moved
**Status**: RESOLVED (commit d6513d9, PR #25)
**Severity**: High (data desync)
**Source**: Before/after screenshots — moving Caboodle folder under Alaska

**Steps to reproduce**:
1. Create group "Caboodle" containing `main.py` and `example1.py`
2. Nest the Caboodle folder under Alaska folder in the scaffold
3. Scaffold correctly shows `Alaska > Caboodle > main.py, example1.py`
4. Canvas shows `main.py` and `example1.py` as ungrouped pieces — the
   Caboodle group outline is gone

**Expected**: Canvas group membership should survive folder moves. The pieces
should still be grouped as "Caboodle" in their new location.

**Root cause (likely)**: The fsManager move pipeline updates file paths in
pieces, but the group membership is tied to the old folder path. When the
parent folder changes (`Caboodle/` → `Alaska/Caboodle/`), the group's path
reference becomes stale and the canvas drops the group association.

**Investigation needed**: Check how group-folder reconciliation handles
parent directory moves in `filesystemWriteManager.js`. The group reconciliation
step in the move pipeline may only update the moved item's direct path, not
re-resolve group membership for children when a parent folder moves.

**Note**: Cross-platform — likely reproducible on Windows too.

---

### 15. New file created in scaffold doesn't appear as canvas piece
**Status**: RESOLVED — working as designed, two intentional flows (verified
2026-07-01). The "create a file that appears on the canvas" capability exists as
the scaffold's **New Node** pill: `usePieceUiActions.handleCreatePiece` writes the
file to disk, creates the SQLite row, and `addPiece`s it onto the canvas. The
right-click **New File** context action (`handleContextNewFile`) is a deliberately
separate, file-only flow — for files you want in the project tree but NOT as canvas
nodes (config, data, etc.). The tester's confusion was using the file-only path and
expecting the piece path; the capability was never missing. (Optional future
discoverability polish, not a gap: an "add to canvas" affordance on tree files that
have no piece yet.)
**Severity**: Medium (expectation mismatch)
**Source**: Screenshot — `example2.py` created in scaffold under Caboodle,
visible in scaffold tree but no corresponding piece on canvas

Creating a new file via the scaffold's "New File" context menu action creates
the file on disk and shows it in the scaffold tree, but does not create a
corresponding puzzle piece on the canvas.

**Current behavior**: Scaffold file creation and piece creation are separate
operations. Files exist on disk, pieces exist on the canvas — they're linked
but not auto-created together.

**Expected behavior (from user perspective)**: If I create a file in my
project, I expect to see it on my canvas.

**Fix options**:
- Auto-create a piece when a new file is created via scaffold (with default
  canvas position — e.g., near existing pieces in same group, or center of
  viewport)
- Prompt: "Also create a canvas piece?" after scaffold file creation
- Add a visual indicator in the scaffold for files that don't have pieces
  (e.g., dimmed or with an "add to canvas" button)

---

### 16. Merge Pieces drawer into Scaffold drawer
**Status**: RESOLVED (PR #75, verified 2026-07-01). The standalone Pieces drawer
was removed; the scaffold now carries "New Node" / "New Group" pills that fold in
the former Create Piece / Create Folder Group flows (`DrawerContentScaffold.jsx`,
`onCreateNode`). No separate drawer to switch to anymore.
**Severity**: Low (design)
**Source**: Tester suggestion — Pieces tab feels sparse and orphaned

The Pieces drawer currently contains only a "+ Create Piece" button and the
puzzle pieces list. Tester suggests this could be merged into the Scaffold
drawer since the scaffold already shows the full project structure.

**Rationale**: Two separate drawers for closely related concepts (files and
their canvas representations) is confusing. A unified drawer could show the
project tree with inline actions for both file operations and piece creation.

**Decision**: Merge. Move "+ Create Piece" and "+ Create Folder Group" into
the Scaffold drawer as buttons at the top. Remove the separate Pieces drawer.
Trim redundant header/label content from the scaffold to keep it tight.

The scaffold becomes the single hub for all project structure operations:
- **Top buttons**: Create Piece, Create Folder Group
- **Tree below**: Full project structure with context menu actions
- No more switching drawers to manage files vs pieces vs groups

---

---

### 9. Double menubar — native macOS chrome + custom titlebar both rendering
**Status**: Open
**Severity**: Medium (layout)
**Source**: Screenshot — full editor view on macOS

Both the native macOS menubar (`litria | File | Edit | View | Window | Help`)
and the custom Litria menubar (`File | Edit | View`) render simultaneously. The
native traffic lights (top-left) and custom window controls (minimize/maximize/close,
top-right) also both appear.

This pushes the entire app layout down, causing the editor drawer and other
content to appear offset/overlapping.

**Root cause**: Same as #2 — `decorations: false` is either not being applied
on macOS, or macOS is forcing native chrome regardless. The result is both
native and custom window management UI stacked together.

**Fix**: Same as #2 — on macOS, embrace native chrome:
- Use `titleBarStyle: "overlay"` to get native traffic lights over app content
- Hide the custom `WindowControls` component on macOS
- Keep only ONE menubar (either the native macOS one or the custom Litria one)
- Adjust top padding/offset so content doesn't sit under the native titlebar

**Related**: Feedback #2 (maximize crash)

---

### 10. Split editor view (horizontal and vertical)
**Status**: Open (feature request)
**Severity**: Low (enhancement)
**Source**: Tester request

Ability to split the editor drawer into at least two panes — left/right
(vertical split) and top/bottom (horizontal split) — to view two files
side by side.

**Note**: Standard feature in all major editors. Essential for comparing
files, referencing one file while editing another, or viewing a test
alongside its implementation.

**Scope**: This is a significant feature — it affects the editor drawer
layout, tab management, Monaco instance lifecycle (multiple editors sharing
the model registry), and the piece-to-tab relationship. Not a quick fix,
but a planned milestone item.

**Implementation considerations**:
- Multiple Monaco editor instances sharing the same model registry
- Resizable split with drag handle
- Tab management per pane (each pane has its own tab bar)
- The same file can be open in both panes (shared model, two views)
- Keyboard shortcut to split (`Cmd+\` / `Ctrl+\` matches VS Code convention)

---

### 11. "New File" fails in empty folders
**Status**: RESOLVED (commit d6513d9, PR #25)
**Severity**: Medium (broken feature)
**Source**: Tester report — "Alaska" folder in scaffold screenshot is empty,
New File doesn't work inside it

Creating a new file inside a folder that doesn't already contain a file
doesn't seem to work. The "Alaska" folder in the scaffold tree is empty
and the New File action fails or does nothing.

**Root cause found**: `DrawerContentScaffold.jsx` line 566:
```js
{child.children?.length && !collapsedDirs.has(child.path) ? (
```
`child.children?.length` is `0` for an empty folder (falsy), so the entire
children block — including the `InlineNameInput` for new file creation — never
renders. The context menu fires, `newItemTarget` is set, but the input has
nowhere to appear.

**Fix**: Change the condition to also render the children block when
`newItemTarget` is targeting that folder:
```js
{(child.children?.length || (newItemTarget?.parentPath === child.path))
  && !collapsedDirs.has(child.path) ? (
```

**Note**: Cross-platform — reproducible on Windows too.

---

### 12. `.DS_Store` visible in scaffold tree
**Status**: Open (macOS-specific)
**Severity**: Low (cosmetic)
**Source**: Screenshot — scaffold tree showing `.DS_Store` alongside `.env`,
`.gitignore`, etc.

macOS creates `.DS_Store` files in every directory the user browses in Finder.
These are showing up in the Litria scaffold tree. They should be filtered out.

**Fix**: Add `.DS_Store` to the scaffold's ignore/hidden file list, alongside
`litria.project.json`. Consider also filtering other OS-generated junk files:
- macOS: `.DS_Store`, `._*` (resource fork files), `.Spotlight-V100`, `.Trashes`
- Windows: `Thumbs.db`, `desktop.ini`
- Linux: `.directory` (KDE)

---

### 13. Group name label on canvas group outline
**Status**: RESOLVED (PR #72, 2026-06-17) — expanded group box gained a header tab carrying the group name (shipped alongside making the box selectable/draggable).
**Severity**: Low (enhancement)
**Source**: Tester suggestion — screenshot of Caboodle group on canvas

Groups on the canvas show an outline around their pieces but no label
indicating the group name. Tester wants to see the group name displayed
on or near the group outline.

**Recommended approach**: File folder tab at the top of the group outline.

A small tab element (like a physical manila folder tab) protruding from the
top edge of the group bounding box, containing the folder/group name.
- Immediately communicates "this is a folder" without explanation
- Minimal — doesn't compete with piece labels inside the group
- Inherits the group's theme color if one is set (name + color in one element)
- Scales with zoom level
- Only visible when the group is expanded (collapsed groups already have
  their own visual treatment)

---

**Recommended approach**: Guard + read-only manifest snapshot.

1. Guard the open path — refuse to open `litria.project.json` / `.bak` with a
   toast explaining why
2. Provide a "View Project Manifest" action (menubar or context menu) that
   generates a read-only snapshot of the current manifest as a **phantom tab**
   in the editor drawer:
   - Read-only Monaco tab (no edits allowed)
   - Plain text or JSON with a `.txt` extension / label so it can't trigger
     scaffold parsing
   - **No backing piece** — does not create a node in the canvas, does not
     write to the scaffold tree, does not add itself to the manifest
   - **No file on disk** — purely an in-memory Monaco model, like a preview
   - Labeled clearly as a snapshot (e.g., "litria.project.json (read-only snapshot)")
   - Refreshes on demand, not live-synced

   This gives power users transparency into the manifest structure without
   any risk of recursion, accidental piece creation, or manifest self-modification.

---

### 17. Canvas navigation: Home + fuzzy search to pan to pieces
**Status**: RESOLVED (merged 2026-03-29, verified 2026-07-01). `NodeSearchPanel`
provides fuzzy piece search with pan-to-piece and a persistent Home (0,0) option,
wired through `onNavigateToPiece` / `onNavigateHome` and a keyboard toggle
(`isNodeSearchOpen`) in App.jsx + StatusBar.
**Severity**: Medium (navigation / usability at scale)
**Source**: Dai — inspired by tester feedback on multiple access paths (#7)

Two complementary navigation features for finding and panning to pieces
on large canvases:

**A. Search bar (top of chrome, below menubar)**
- Always-visible search field in the app chrome
- Shows "Home" (0,0 origin) as a persistent option
- Type to fuzzy-search by filename or piece label
- Select a result → canvas pans to that piece
- Discoverable: new users see it immediately and understand canvas nav exists

**B. Compass long-press (status bar)**
- Click: pan to Home (0,0) — quick, predictable, always works
- Click + hold: opens a search popover (same fuzzy logic as the search bar)
- Power user shortcut: no mouse travel to top of screen, search from where
  you are

**C. Keyboard shortcut**
- `Cmd+K` / `Ctrl+K` (or `Cmd+P` / `Ctrl+P`) opens the search directly
- Third access path for keyboard-centric users

**Design principle**: Same data, same fuzzy logic, same results — three
access points for three user mindsets (discovery, efficiency, keyboard).
Mirrors the multiple-access-path principle from feedback #7.

**Implementation notes**:
- Fuzzy matching against piece filenames and labels (existing piece state)
- Results ranked by match quality
- Pan animation to center the selected piece in the viewport
- Home (0,0) is always the first/default result
- Every new project starts at 0,0 — this is the universal anchor point

---

## Post-SQLite-cutover testing session (2026-04-06)

The following items were found during the first dev-build test session
after the SQLite persistence cutover was completed. None are SQLite-related
— they're pre-existing canvas/interaction bugs that became more visible
once persistence stopped being a distraction. Cross-platform (Windows).

Architectural / internal root-cause notes for several of these items are
tracked in [`canvas-interaction-internals.md`](./canvas-interaction-internals.md).

### 18. Camera POV doesn't follow piece during drag
**Status**: RESOLVED — edge-scrolling (internals note 3, Option A) shipped as
`src/behaviors/useAutoPan.js`: a RAF loop pans the viewport when the cursor is
within 80px of a viewport edge during a drag. Originally gated only on piece
drags; now gated on `isDragActive`, so it also covers group-pill drags.
**Severity**: Medium (UX — forces multi-step workflow for any drag outside current viewport)
**Source**: Testing session 2026-04-06

When dragging a piece or folder group with LMB, the camera/POV stays
locked in world space. If the user wants to move a piece even slightly
outside the current viewport, they have to: pick up → drag to edge →
drop → manually pan → pick up again → drop at destination → manually pan
back. Multi-step instead of one fluid motion.

**Expected behavior**: Either edge-scroll (standard in Figma, Excalidraw,
Miro — when cursor nears viewport edge during drag, camera pans at a rate
proportional to distance from edge) OR literal camera-follow (piece stays
centered in viewport during drag).

**Investigation needed**: Unclear whether this is a regression of a
previously working feature or new territory. The user reports seeing the
behavior work before, but it may have been an artifact of a different bug
(stuck pan following cursor — see item 20) creating a similar visual
effect at the wrong time.

**Scope**: Drag handler for pieces + groups + scaffold drops. Viewport
offset updates need to happen during drag, not just after drop.

---

### 19. Right-click drag on empty canvas moves selected group
**Status**: RESOLVED (verified during PR #72, 2026-06-17) — `Konva.dragButtons=[0]` restricts node drag to the left button and `buildGroupBounds` respects collapsed state; right-drag inside an expanded group box neither pans nor moves the group. Root causes in internals notes #1 and #6, both now mitigated.
**Severity**: Medium (confusing interaction)
**Source**: Testing session 2026-04-06

With a collapsed folder group selected, right-click-drag anywhere on the
canvas — including well outside the visible group bounds — moves the
selected group instead of panning the camera. Right-click is the intended
pan gesture, but it's being hijacked.

**Root cause**: Two stacked issues:
1. `buildGroupBounds` for collapsed groups returns the bounds of the
   expanded piece positions, not the collapsed stub. The group's hit
   region is therefore enormous, extending well beyond the visible form.
2. Right-mouse-button drag is being interpreted as "drag selection" when
   something is selected, rather than "pan canvas".

Technical root cause details in `canvas-interaction-internals.md`.

**Visual evidence**: When the group actions menu is open, the selection
outline renders as a large dashed rectangle showing the expanded footprint
— this is the hit region made visible. Any click inside that dashed box
hits the group.

**Fix**: `buildGroupBounds` must respect `group.isCollapsed` and return
the collapsed stub's bounds. Separately, right-click-drag should either
always pan (regardless of selection), or only move the selection when
the initial click is directly on the collapsed stub.

---

### 20. Intermittent stuck pan — viewport follows cursor after drop
**Status**: RESOLVED. The original right-click-pan strand is guarded three ways
(`useViewport.startPan` registers a `window` `mouseup` once-listener that nulls
`panRef`, plus `endPan()` on stage mouseup, plus `handleStageMouseLeave`). A
second, newer strand hid behind the edge-scroll work: `useAutoPan` was gated on
`isDraggingPiece` (`dragStartRef.size > 0`), which an interrupted/off-window drop
left populated even after the reactive `isDragActive` flag was cleared — stranding
the auto-pan RAF loop ON so the viewport panned on every edge-adjacent mousemove
with no button pressed. Fixed by gating `useAutoPan` on `isDragActive` (reactive,
cleared by a `window` `pointerup`/`pointercancel`/`blur` failsafe) instead, and by
clearing `dragStartRef` in `handlePieceDragEnd`'s non-finite-coords early return.
**Severity**: High (blocks interaction until dismissed)
**Source**: Testing session 2026-04-06

After a drag-and-drop (piece, group, or scaffold folder), the viewport
sometimes "sticks" to the mouse cursor — subsequent mousemove events pan
the camera as if the user were holding a pan gesture, even though no
mouse button is pressed. Intermittent, not every drop triggers it.

**Workaround discovered during testing**: Ctrl+scroll-wheel (the zoom
gesture) clears the stuck state and restores normal behavior.

**Analysis**: The fact that Ctrl+scroll clears it rules out pointer
capture as the cause (releasing captured pointers requires a new
pointerdown, not a wheel event). Most likely a stale state flag in the
viewport/drag hook — either a `panStart` / `dragAnchor` slot that isn't
cleared on drop, or an effect with a stale closure that the wheel
handler happens to tear down and rebuild.

**Likely fix direction**: Move `pointerup` listeners to `window` (not
the dragged element) so they fire regardless of what the cursor is over
at release time. Ensure all drag-state refs are cleared in a single
cleanup function on dragend.

---

### 21. Folder spawn doesn't enforce 3x3 grid layout
**Status**: RESOLVED (commit `b8dc0ae`, 2026-04-10 — "Closes feedback #21").
The stacking cause was as suspected: folder spawn passed `x:0, y:0` for every
piece and `createPiecesBatch` called `getSpawnPosition()` once per item (same
viewport-center point). Fixed by `computeSpawnGridPositions` (3 cols, unlimited
rows) writing distinct x/y to both SQLite (`dbCreatePiecesBatch`) and in-memory
state, with new items pre-sorted alphabetically so the spawn grid lines up with
the tier expand layout. Regression tests added in `test/domains/pieceDomain.test.mjs`.
Verified 2026-07-01: expand/tier repositioning (`batchMovePieces` → `setPieces`)
also persists via the debounced position-write in `useProjectPersistence`, so
layout survives reload. (Feedback doc was stale — the fix predates this note.)
**Severity**: Low (cosmetic — pieces still spawn and work)
**Source**: Testing session 2026-04-06

When a folder is spawned from the scaffold drawer (drag to canvas), the
files inside are supposed to lay out in a 3x3 grid pattern within the
bounding box. Instead, pieces spawn at the same position (stacked behind
each other) until the user drags them apart.

**Root cause**: In `useScaffoldActions.js`, the new SQLite-first flow
passes `x: 0, y: 0` to `dbCreatePiecesBatch` for all pieces, and
`pieceDomain.createPiecesBatch` then calls `getSpawnPosition()` per
piece — which returns the same viewport-center point for each call
within a single batch.

**Fix**: Compute grid positions (row/col based on index) before the
batch create and pass them as x/y values. The old folder-spawn code
from the 2026-04-05 grid-layout work likely has the math; it was routed
around during the cutover.

---

### 22. Minimap auto-fit rescales during active drag
**Status**: RESOLVED — `Minimap` now takes an `isDragActive` prop and, while a
canvas drag is active, reuses a frozen map transform (mapScale + origin captured
just before the drag) instead of recomputing it from content bounds each render.
Pieces and the viewport rect still render live through the frozen transform; the
rescale reapplies on the first post-drop render. (Prior snapshot freeze only
covered minimap-internal pan gestures, not external canvas drags.)
**Severity**: Low (polish — confusing but not broken)
**Source**: Testing session 2026-04-06

When dragging a piece that moves far enough to expand the content bounds,
the minimap rescales/repositions its internal POV rectangle mid-drag to
include the new extent. This looks like "the camera moved even though I
didn't pan" because the POV indicator in the minimap shifts visually.

**Expected behavior**: Minimap should remain stable during an active drag
and apply any rescale/reposition once on drop.

**Fix**: Debounce or suppress minimap rescale while `isDragging` state
is true. Apply pending rescale on dragend.

---

### 23. Scaffold drawer hide button no longer hides files/folders
**Status**: RESOLVED — raw-vs-normalized path mismatch (internals note 4,
suspected cause #3). `handleToggleScaffoldVisibility` stored `normalizePath(path)`
into `hiddenScaffoldPaths`, but `DrawerContentScaffold` tested
`hiddenPaths.includes(child.path)` against the *raw* path. On Windows the raw path
carries backslashes / a leading slash, so the normalized state key never matched —
the click updated state but the `is-hidden` class and Eye/EyeOff icon couldn't see
it. Fixed by comparing on the normalized key (`hiddenPaths.includes(normalizePath(child.path))`).
The separate `setState`-purity smell in the same handler (note 4 primary) is
harmless (idempotent DB writes) and remains open as hygiene.
**Severity**: Medium (feature broken)
**Source**: Testing session 2026-04-06

Clicking the hide button on a file or folder in the scaffold drawer no
longer hides the item. The visual state doesn't update even though the
click is registered.

**Suspected causes** (not yet confirmed):
1. A prop-chain break between the click handler and the scaffold drawer's
   render-time filter that reads `hiddenScaffoldPaths`.
2. The `handleToggleScaffoldVisibility` function has a SQLite side effect
   inside a `setState` updater callback, which is a React antipattern.
   Harmless in StrictMode (just causes duplicate `dbAddHiddenPath` calls,
   which are idempotent) but worth cleaning up regardless.
3. The path format in `hiddenScaffoldPaths` state may not match the
   format used at render-time for the drawer's visibility check.

**Investigation needed**: Grep from click handler through to the render
filter; verify the state is actually updating and the drawer is reading it.

---

### 24. Once-observed: scaffold folder drag replaced previous folder
**Status**: Watch for repro
**Severity**: Unknown (only observed once, not reproducible)
**Source**: Testing session 2026-04-06

Dragging a folder from the scaffold drawer to the canvas caused a
previously-spawned folder to disappear entirely — not just visually, but
also absent from the minimap. Only seen once during a single test.

**Suspected causes**:
- State-stomp: `setState(replacement)` instead of `setState(prev => [...prev, new])`
- Group ID collision — `scaffold-folder-${Date.now()}-${counter}`: if
  two drags fire within the same millisecond and the counter resets or
  isn't incremented atomically, the second drop could overwrite the first
- Race condition in the SQLite write path — possible if parallel
  `dbCreateGroup` calls interact badly with `INSERT OR IGNORE`

**Action**: Not investigating until reproducible. Log any additional
occurrences with steps to this file for pattern-matching.

---

### 25. Group color not applied to parent group container
**Status**: RESOLVED (node visual language work, verified 2026-07-01). Both
container render paths now read `group.color` in `WorkspaceStage.jsx`: the
expanded group box stroke + fill and its header tab, and the collapsed stub's
rim (`pill.color`). Setting a group color now tints the container, not just the
child pieces.
**Severity**: Low (cosmetic — color propagates partially)
**Source**: Testing session 2026-04-06 (screenshots in session log)

Setting a group color via the group actions menu applies the color to
the child pieces' accent bars but not to the parent group's own outline,
label frame, or collapsed stub. The group visually "inherits" the color
in its children while the container stays default.

**Root cause (likely)**: The group container renderer (both expanded
outline and collapsed stub variants) doesn't read `group.color` at all,
or reads it but defers to theme defaults unconditionally.

**Fix**: Both render paths (expanded container + collapsed stub) need
to check `group.color` as an override that takes precedence over theme
defaults. Two places to update, single prop to thread.

---

### 26. Enhancement: color-coded selection outlines inherit group color
**Status**: RESOLVED — closed as superseded (2026-07-01, design decision). The
benefit this enhancement chased ("tell color-coded groups apart") is already
delivered two other ways: (1) #25 — a group's box, header tab, and collapsed stub
carry its color *persistently* (plus the #13 name tab), so identity is visible
without selecting; (2) the theme/material system + New Project Wizard now define a
purpose-built, contrast-tuned selection color per theme (`selectionGroupOutline`,
`nodeSelectedStroke`). Inheriting the group/piece color into the *selection ring*
would override those tuned colors, break the consistency of the "selected" signal,
and risk legibility (same-color ring on a same-color element — e.g. a red ring on
a red node reads as unselected). The sound pattern is what's shipped: persistent
identity color + a consistent, theme-tuned selection color doing separate jobs.
If a specific theme's selection color is ever hard to see against certain group
colors, the fix is to tune that theme's `selectionGroupOutline` token, not to
inherit the group color.
**Severity**: Low (enhancement)
**Source**: Testing session 2026-04-06 — user observation

When fixing item 25, also apply the group's color to the selection
bounding box outline when the group is selected. Figma does this with
components, Miro does it with frames — it makes it instantly obvious
which group you've grabbed on a canvas with many color-coded groups,
without needing to read labels.

**Scope**: Same component as item 25. Bundle the two fixes together.

---
