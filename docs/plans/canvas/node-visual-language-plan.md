# Node Visual Language — Implementation Plan

**Status:** Delivered — PRs #58–#62 and #69 (2026-06-13 → 06-17): left-edge
color cascade, shared `resolveNodeEdgeColor`, wizard preview parity, and the
Live/Calm static intensity axis all shipped and owner-verified. *(Status
corrected 2026-07-28 — the line below had never been updated past Step 1.)*
**Original status:** In progress (Step 1) — 2026-06-13
**Drives:** B1 wizard-redesign landing (external beta blocker)
**Amends:** ADR-014 (Glass Material System) — see its "Amendment (2026-06-13)" section.

## Why these three things are one effort

The New Project Wizard's purpose is to let people **preview their at-a-glance visual language before entering a project**. So the wizard renders nodes. If we land the wizard while the node language is mid-change, we build a preview of a language we're about to replace — guaranteed rework. Same "touch it once" logic as the Action Tokens bundle. Therefore the node language, the wizard, and the Live/Calm intensity axis ship as one coordinated set, in dependency order.

## The settled design (see memory `design_node_visual_language.md`)

- **Color renders on the LEFT edge only** (was top/bottom). Cleaner, minimal, reads at low zoom.
- **LED stays the health/status channel** (top-right). Separate axis. Untouched.
- **No animation — static only.** Settled perf decision (Konva.Animation LED pulse stole the canvas frame budget at scale). Color/state carries the signal.
- **Color cascade** (per node, highest first):
  1. ad-hoc `piece.color` override (sticky; reset = explicit) — set via the node actions pill
  2. inherited parent/group color (`group.color` via `buildGroupColorByPieceId`)
  3. ungrouped default (`nodeUngroupedEdgeColor` project setting, chosen in the wizard)
- **Editability principle:** wizard sets initial defaults; node + folder colors stay editable forever.
- **One shared resolver** (`resolveNodeEdgeColor`) used by canvas AND wizard preview → preview can't drift from reality.
- **Live / Calm** = static intensity presets (Live vivid / Calm low-stimulus). No motion.

## Steps

### Step 1 — Node left-edge language (foundation) — *this PR*
- Add `resolveNodeEdgeColor(piece, groupColorByPieceId, ungroupedDefault)` pure helper (the cascade) + unit tests.
- `WorkspaceStage`: resolve `edgeColor` via the helper, passing the ungrouped-default theme token.
- `PuzzlePiece`: render the resolved color as a **left-edge** vertical accent (was top + bottom bars).
- `nodeUngroupedEdgeColor` token read with a safe default (null = no edge until the wizard sets it).
- Ships on the live canvas immediately, independent of the wizard.

### Step 2 — Wizard landing (B1 blocker)
- Promote `updatedprojectwizard/` into the app.
- Choice-preview renders nodes through the **same** `resolveNodeEdgeColor`.
- Surface the folder-group-color + ungrouped-color settings; they write the project config the cascade reads.

### Step 3 — Live / Calm
- Two static token presets layered on the settled token system. A toggle selects the active preset.
- Accessibility / sensory comfort / VR-endpoint driven.

## Out of scope / non-goals
- LED behavior, connection lines, group nesting — unchanged.
- No animation is introduced anywhere (static-only is a hard constraint).
- Per-node/folder recolor UI already exists (`setPieceColor` / group color swatches) — we re-channel where it renders and re-enable inheritance, not rebuild the editor.
