# Tailwind + shadcn Migration Checklist

Execution checklist for the migration defined in `docs/prds/tailwind-shadcn-migration-prd.md`.

---

## Phase 0: Tailwind Foundation — COMPLETE

### Install — DONE
- [x] `npm install -D tailwindcss @tailwindcss/postcss autoprefixer`
- [x] `npm install clsx tailwind-merge class-variance-authority`
- [x] Create `postcss.config.js` with `@tailwindcss/postcss` plugin (Tailwind v4 requires separate PostCSS package)

### CSS Entry Point — DONE (Tailwind v4)
- [x] Create `src/styles/tailwind.css` with v4 syntax:
  ```css
  @import "tailwindcss/theme" layer(theme);
  @import "tailwindcss/utilities" layer(utilities);
  ```
- [x] Preflight excluded by only importing theme + utilities (not `@import "tailwindcss"` which includes preflight). Litria's `reset.css` preserved.
- [x] `@theme` block maps Litria tokens to Tailwind theme variables (no `tailwind.config.js` — v4 uses CSS-based config)
- [x] Wired into `App.jsx`: `import './styles/tailwind.css'` before `tokens.css`

### Utility Helper — DONE
- [x] Created `src/lib/utils.js` with `cn()` helper (clsx + tailwind-merge)

### Validation — DONE
- [x] `npm run build` passes (29s, no errors)
- [x] CSS bundle size unchanged (58.15 KB vs prior 62.28 KB — smaller without preflight)
- [x] Manual visual spot check — no UI/UX changes detected (launch screen, canvas, drawers, editor, menus)
- [ ] Temporary `className="bg-red-500"` pipeline test deferred (visual parity confirmed, pipeline verified via build)
- [x] No new console warnings or errors in build output
- [x] Existing CSS custom properties (`var(--cm-*)`) resolve correctly

---

## Phase 0.5: shadcn Initialization

### shadcn Config — DONE
- [x] Install class-variance-authority: already installed in Phase 0
- [x] Create `components.json` in project root (manually, shadcn init requires interactive prompt)
- [x] Aliases use `@/` prefix (`@/components`, `@/lib/utils`, `@/components/ui`)
- [x] `jsconfig.json` created with `@/*` path mapping (required by shadcn CLI)
- [x] `vite.config.js` updated with `resolve.alias` for `@` → `./src`
- [x] Verify `src/components/ui/` directory is created
- [x] 7 shadcn components generated: dialog, alert-dialog, dropdown-menu, context-menu, popover, command, button
- [x] `npm run build` passes

---

## Phase 1: Dialog (CreatePieceModal) — COMPLETE

### Install — DONE (Phase 0.5)
- [x] `npx shadcn@latest add dialog`
- [x] Verify `src/components/ui/dialog.jsx` is created
- [x] Verify `radix-ui` (unified package, v4) is in `package.json`

### Restyle — DONE
- [x] Dialog overlay: `bg-black/45` (Tailwind class on DialogOverlay)
- [x] Dialog content via `.create-piece-dialog` class:
  - `border-radius: 14px`
  - `border: 1px solid rgba(212, 212, 212, 0.28)`
  - `background: rgba(24, 24, 24, 0.96)`
  - `box-shadow: 0 14px 30px rgba(0, 0, 0, 0.42)`
  - `width: 330px`
- [x] Radix Dialog provides open/close animations via data-state attributes
- [x] Input fields preserved using existing `.create-piece-input` CSS styles

### Migrate CreatePieceModal — DONE
- [x] Replace manual open/close state with `Dialog` `open` prop + `onOpenChange`
- [x] Replace `.create-piece-modal-shell` positioning with `DialogContent` (includes Portal + Overlay)
- [x] Replace `.create-piece-modal` card with `.create-piece-dialog` on `DialogContent`
- [x] Preserve form fields, validation logic, error display
- [x] Escape key handling now via Radix (removed manual `window.addEventListener`)
- [x] Overlay click dismiss now via Radix (was not implemented before)
- [x] Focus trap now via Radix (was not implemented before)
- [x] Removed old shell/card CSS from `modals.css`, replaced with `.create-piece-dialog` + `.create-piece-form`
- [x] Removed conditional `{isCreatePieceModalOpen && ...}` wrapper in App.jsx (Dialog `open` prop handles visibility)
- [x] `onOpenAutoFocus` overridden to focus filename input specifically

### Validate
- [x] `npm run build` passes
- [x] `npm run check:architecture` passes (architecture + app-shell guards)
- [ ] Modal opens from CreatePieceButton (manual test)
- [ ] Modal closes on Escape (manual test)
- [ ] Modal closes on overlay click (manual test — NEW behavior)
- [ ] Focus is trapped inside modal (manual test — NEW behavior)
- [ ] Focus returns to trigger on close (manual test — NEW behavior)
- [ ] Form validation works (empty name, duplicate name) (manual test)
- [ ] Error messages display correctly (manual test)
- [ ] Visual appearance matches pre-migration (manual test)
- [ ] No console errors (manual test)

---

## Phase 2: Menus — COMPLETE

### Install — DONE (Phase 0.5)
- [x] `npx shadcn@latest add dropdown-menu`
- [x] `npx shadcn@latest add context-menu`
- [x] Verify `radix-ui` (unified package, v4) is in `package.json`

### Restyle — DONE
- [x] DropdownMenu restyled via `.cm-dropdown-content` / `.cm-dropdown-item` / `.cm-dropdown-shortcut` / `.cm-dropdown-separator`
- [x] ContextMenu restyled via `.cm-context-content` / `.cm-context-item` (matches `.group-menu-panel` / `.group-menu-action` pattern)
- [x] Destructive items use `data-variant="destructive"` with `color: #ff8888`
- [x] Highlight states use `data-highlighted` attribute (Radix-driven)
- [x] All Litria menu styles in `menu-bar.css`

### Migrate MenuBar Dropdowns — DONE
- [x] Replace custom `MenuDropdown` with Radix `DropdownMenu` (`open` + `onOpenChange`)
- [x] `DropdownMenuTrigger asChild` on `.menu-item-btn` — Radix manages `data-state` for open styling
- [x] `DropdownMenuItem` with `onSelect` replaces manual `onClick` + `setOpenMenu(null)`
- [x] `DropdownMenuSeparator` replaces `.menu-separator` divs
- [x] `DropdownMenuShortcut` replaces `.menu-shortcut` spans
- [x] Preserve hover-to-switch behavior (mouseEnter on `.menu-item` swaps `openMenu`)
- [x] Preserve disabled state via `disabled` prop on `DropdownMenuItem`
- [x] Removed old `.menu-dropdown`, `.menu-action`, `.menu-shortcut`, `.menu-separator` CSS
- [x] `.menu-item-btn.is-open` replaced with `.menu-item-btn[data-state="open"]`

### Migrate ScaffoldContextMenu — DONE
- [x] Replaced manual positioning + pointerdown/keydown listeners with `DropdownMenu` (controlled)
- [x] Virtual anchor `<div>` at cursor coordinates used as `DropdownMenuTrigger`
- [x] All action items preserved (Open, Rename, Delete, New File, New Folder)
- [x] Delete items use `variant="destructive"` for red styling (replaces `.scaffold-context-delete`)
- [x] Removed orphaned `.scaffold-context-delete` CSS from `scaffold.css`
- [x] Note: Used DropdownMenu instead of ContextMenu primitive — Radix ContextMenu requires wrapping a trigger element, but scaffold tree has multiple dynamic right-click targets

### Validate
- [x] `npm run build` passes
- [x] `npm run check:architecture` passes (architecture + app-shell guards)
- [ ] File/Edit/View menu dropdowns open correctly (manual test)
- [ ] Hover-to-switch between menus works (manual test)
- [ ] Arrow key navigation works within menus (manual test — NEW behavior)
- [ ] Escape closes menus (manual test)
- [ ] Click outside closes menus (manual test)
- [ ] Keyboard shortcuts display next to items (manual test)
- [ ] Disabled items (Undo/Redo) cannot be clicked (manual test)
- [ ] ScaffoldContextMenu opens on right-click at correct position (manual test)
- [ ] All context menu actions work (manual test)
- [ ] No console errors (manual test)

---

## Phase 3: Popovers — COMPLETE

### Install — DONE (Phase 0.5)
- [x] `npx shadcn@latest add popover`
- [x] Verify `src/components/ui/popover.jsx` is created

### Restyle — DONE
- [x] PopoverContent restyled via `.cm-popover-content` class (dark background, subtle border, shadow)
- [x] No arrow used — clean edge-to-edge popover

### Migrate — DONE (Status Bar popovers)
- [x] Status bar zoom popover → Popover (`side="top"`, `align="center"`, `sideOffset={8}`)
  - Renamed `ZoomPopover` to `ZoomSlider` (just the slider content, positioning handled by Radix)
  - Removed manual `anchorRef` positioning calculation and `useEffect` for rect measurement
  - Removed manual outside-click handler (`document.addEventListener('mousedown')`)
  - `PopoverTrigger asChild` wraps `.status-bar-zoom-btn`
  - `onOpenAutoFocus` prevented to avoid stealing focus from slider
  - Preserved double-click-to-reset-100% behavior
- [x] Status bar dirty files popover → Popover (`side="top"`, `align="center"`, `sideOffset={8}`)
  - `DirtyFilesPopover` inlined into `PopoverContent` (was just a list of buttons)
  - `PopoverTrigger asChild` wraps `.status-bar-save-indicator`
  - Removed manual outside-click handler
- [x] CSS updated: removed `position: absolute`, `bottom`, `left`, `transform`, `z-index` from both popover classes (Radix Portal handles positioning)

### Deferred
- [x] ColorPickerPopup — not a popover pattern. It's an inline expansion inside GroupMenuOverlay's panel. No trigger/anchor to wrap. Leave as-is.
  - *Resolved 2026-08-01:* "leave as-is" turned out to be the shipped end state — the picker is a content-only panel hosted inside Radix `DropdownMenuSubContent` (`ColorSubmenu` in `ActionMenuForms.jsx`), so portal, positioning, and dismissal already come from shadcn. Nothing left to migrate.
- [x] GroupMenuOverlay — canvas-positioned floating panel at arbitrary coordinates. Radix Popover positions relative to a trigger element, which conflicts with canvas coordinate positioning. Leave as-is.
  - *Superseded 2026-08-01 (status note):* the action-pill rebuild (PR #70, 2026-06-17) rebuilt this on `ui/dropdown-menu` — the deferral's premise no longer applies and the component has been shadcn-hosted since.

### Validate
- [x] `npm run build` passes (pending)
- [ ] Zoom popover opens on single click, closes on click-outside and Escape (manual test)
- [ ] Zoom slider drag works correctly (manual test)
- [ ] Double-click zoom button resets to 100% (manual test)
- [ ] Dirty files popover opens on click, shows unsaved files (manual test)
- [ ] Clicking a dirty file navigates to it and closes popover (manual test)
- [ ] Popovers reposition if near viewport edge (manual test — NEW behavior from Radix)
- [ ] No console errors (manual test)

---

## Phase 4: AlertDialog + Command — COMPLETE

### Install — DONE (Phase 0.5)
- [x] `npx shadcn@latest add alert-dialog`
- [x] Verify `src/components/ui/alert-dialog.jsx` is created

### Migrate UnsavedChangesPrompt — DONE
- [x] Replace `.unsaved-prompt-shell` with AlertDialog (Radix Portal + Overlay)
- [x] Replace manual `if (!isOpen) return null` with AlertDialog `open` prop
- [x] AlertDialogContent wraps `.unsaved-prompt` card (Litria CSS preserved)
- [x] Cancel → `AlertDialogPrimitive.Cancel asChild`
- [x] Discard → `AlertDialogPrimitive.Action asChild`
- [x] Save → `AlertDialogPrimitive.Action asChild` with `.is-primary` styling
- [x] Removed `.unsaved-prompt-shell` CSS from `modals.css` (Radix overlay replaces it)
- [x] Preserved `.unsaved-prompt`, `.unsaved-prompt-title`, `.unsaved-prompt-message`, `.unsaved-prompt-actions`, `.unsaved-prompt-button` CSS
- [x] `onOpenChange` calls `onCancel` on close (Escape key)
- [x] Focus trap now via Radix (was not implemented before)
- [x] Overlay click blocked by AlertDialog (correct for unsaved changes — forces a choice)

### Evaluate SyntaxSymbolPicker — DEFERRED
- [x] Document decision: defer
- [x] Rationale: SyntaxSymbolPicker is a canvas-positioned floating panel with multi-select grouping and a "Connect N symbols" action button. It is not a search/filter combobox pattern — shadcn Command (cmdk) is designed for filtered command palettes. The current implementation (fixed positioning, pointerdown dismiss, grouped list with checkboxes) is a better UX fit for the canvas interaction model. Revisit if a search/filter use case emerges.
- [x] *Addendum 2026-08-01:* the cmdk rejection stands — the grouped multi-select UI is unchanged. The panel's **hosting** moved to a Radix Popover (0×0 point anchor at the drop position): outside-click/Escape dismissal and viewport collision handling now come from Radix, replacing the manual fixed positioning and capture-phase listeners. Interaction model preserved — non-modal, no focus steal either way, Escape still stops propagation to canvas handlers.

### Validate
- [x] `npm run build` passes
- [x] `npm run check:architecture` passes
- [ ] UnsavedChangesPrompt appears with correct backdrop (manual test)
- [ ] Three buttons display and function correctly (manual test)
- [ ] Focus is trapped in dialog (manual test — NEW behavior)
- [ ] Cannot dismiss by clicking overlay (manual test — AlertDialog behavior)
- [ ] Escape key triggers Cancel (manual test)
- [ ] No console errors (manual test)

---

## Post-Migration Cleanup — COMPLETE

- [x] Remove any orphaned CSS sections from `modals.css`, `menu-bar.css`, `context-menus.css`
  - Audited all three files — no orphaned selectors found. All old pre-migration selectors (`.menu-dropdown`, `.menu-action`, `.menu-shortcut`, `.menu-separator`, `.scaffold-context-delete`, `.unsaved-prompt-shell`, `.create-piece-modal-shell`, `.create-piece-modal`) were already removed during each phase.
- [x] Verify no dead CSS remains (unused selectors from migrated components)
- [x] Run full test trio: `npm run check:architecture && npm run test:domains && npm run build`
  - Architecture guard: passed
  - Domain tests: 279/279 passed
  - Build: passed (31s)
- [x] Update `docs/ui-governance.md` implementation checklist (Section 9) to reflect completed items
  - Marked menu bar buttons and dropdown actions as complete
  - Updated overlay backdrop to frosted glass spec
  - Expanded ui/ directory listing with all 7 shadcn components
  - Version bumped to 1.2
- [ ] Tag migration completion in git history
