# Brief: Glass Backdrop Sampling — Correctness + Sample Source

> **For:** Claude Code
> **Scope:** The glass material's backdrop-blur pipeline in `PuzzlePiece.jsx` and the canvas layer structure in `WorkspaceStage.jsx`. Fixes the sample-rect coordinate math, then changes *what* glass samples so wires/LEDs stop appearing inside unrelated pieces.
> **Stack:** React 19 + react-konva (Konva 9), Tauri v2.
> **Status:** Investigated 2026-07-17 (journal: `.research/2026-07-17-glass-refraction-and-cross-group-wires.md`). Slice 1 is a straight bug fix, ready to build. Slice 2 (background-only sampling) **ratified by owner 2026-07-17** ("go with your recommendation") — both slices ready to build.

---

## Context — the reported symptom

Owner report (2026-07-17): "glass refraction is really high — wires and LED
light will show up on other non-connected or adjacent pieces," creating false
connection cues.

Investigation found this is **not** a refraction-strength problem.
`glassRefractiveIndex` only drives the Snell corner-highlight alpha
(`PuzzlePiece.jsx`, Snell block) and displaces nothing. The bleed comes from
the backdrop-blur pipeline, via two independent causes.

## Cause A — the sample rect is computed wrong

The glass surface sceneFunc samples the shared layer canvas behind the piece
(`PuzzlePiece.jsx`, "Backdrop-blur" block):

```js
const abs = shape.getAbsolutePosition();
const scale = stage ? stage.scaleX() : 1;
const sx = Math.round(abs.x * scale);   // ← bug 1
const sw = Math.round(w * scale);
...
ctx.drawImage(layerCanvas, sx, sy, sw, sh, 0, 0, w, h);
```

1. **Double-applied zoom.** Konva's `getAbsolutePosition()` already includes
   every ancestor transform — and the `Stage` carries
   `scaleX/scaleY={viewportScale}` and `x/y={viewportOffset*}`
   (`WorkspaceStage.jsx`). So `abs` is already in screen (CSS-px) coordinates;
   multiplying by `stage.scaleX()` again makes the sample origin drift away
   from the piece at any zoom ≠ 1, proportionally to the piece's distance from
   the canvas origin. Pieces far from origin sample regions far from
   themselves — which is exactly how *another* piece's wires/LED end up inside
   a piece's glass.

2. **Missing pixelRatio.** `layer.getCanvas()._canvas` is the backing canvas,
   sized CSS-size × pixelRatio. `drawImage` source coords are in *device*
   pixels of that canvas, but `sx/sy/sw/sh` are CSS px. On Windows display
   scaling ≠ 100% (v. common: 125%/150% laptops) the sampled rect is offset
   toward the top-left and undersized — wrong-region content again, even at
   zoom 1.

3. **All-or-nothing bounds guard.** The guard
   (`sx >= 0 && sx + sw <= layerCanvas.width && …`) skips sampling entirely
   when the rect isn't fully inside the canvas — and it compares CSS-px coords
   against device-px canvas dimensions. Net effect: pieces near the viewport
   edge silently lose their glass, and the guard masks/exposes the coordinate
   bugs inconsistently across zoom/pan.

### Fix (Slice 1)

- Compute the sample rect once, correctly:
  `deviceRect = abs(CSS px, no extra scale) × layer.getCanvas().getPixelRatio()`,
  with size `w/h × totalAbsoluteScale × pixelRatio` (use the shape's absolute
  scale rather than assuming stage scale is the only scale — piece `scale` is
  a real attr).
- Replace the skip-guard with **clamping**: intersect the sample rect with the
  canvas, draw the intersected source region into the correspondingly
  intersected destination region. Edge pieces keep their glass.
- Named helper, unit-tested pure (rect math is trivially testable without
  Konva): input {absPos, absScale, pixelRatio, canvasW/H, w, h} → {src rect,
  dst rect} | null.

This alone should eliminate the "shows up on *non-adjacent* pieces" class of
the symptom, at every zoom and DPI.

## Cause B — glass samples semantic content by construction

`WorkspaceStage.jsx` renders everything in **one** Konva `Layer`, in order:
`CanvasGrid` → group outlines → `ConnectionLine` wires → collapsed-group
pills → pieces. The sceneFunc samples that same layer canvas mid-draw, so a
piece's backdrop includes everything drawn before it this frame: the grid
(intended), but also wires routed behind the piece, group fills, pills, and
earlier-drawn overlapping pieces including their corner LEDs. Physically
faithful glass — semantically a false-connection generator: a blurred wire
inside a piece reads as "this piece is connected."

### Fix (Slice 2 — ratified by owner 2026-07-17)

Split rendering into two Konva layers:

- **Background layer:** `CanvasGrid` only. This is what glass *samples*.
- **Content layer:** group outlines, wires, pills, pieces — everything
  semantic. `layerRef` for sampling points at the background layer; the
  pieces themselves live in the content layer.

Consequences:

- Wires/LEDs/neighbors can never appear inside glass, by construction. The
  glass aesthetic is preserved — the grid is what gives transparency
  something to refract against (original design intent, glass material
  design 2026-04-04).
- Sampling gets cheaper: the background layer repaints only on pan/zoom, so
  the sampled canvas is stable during drags.
- Cost: one extra canvas + composite. Konva multi-layer is a supported,
  normal pattern; memory cost is one screen-size canvas.
- Alternative considered — keep single-layer sampling but attenuate semantic
  content (sample before wires draw, or dim the sampled result): still leaves
  ambiguity, costs more bookkeeping, and the mid-frame sampling order becomes
  load-bearing. Not recommended.

Note for the bezier-wire brief (`brief-bezier-wire-refactor.md`): its Konva
note says "keep the wire in the existing single canvas layer — do not add a
new layer." That instruction was scoped to the wire refactor itself (don't
add a *wire* layer); this brief's background/content split is a deliberate
architecture change that supersedes the single-layer assumption. Wires stay
in the same layer as pieces, in the same relative order — only the grid moves
down a layer.

## Out of scope

- Any change to refraction visuals, Snell highlights, or material tokens
  (`glassBlurRadius`, `glassRefractiveIndex` behavior unchanged).
- Wire rendering, routing, or the cross-group wire work — separate brief
  (`brief-cross-group-wires.md`).
- Piece caching / perf work beyond what the layer split gives for free.

## Proposed slices

1. **S1 — sample-rect correctness** (own small PR): pure rect helper + tests,
   pixelRatio + no double scale + clamped partial overlap. No design input
   needed. Verify: zoom to 0.5/1.5 on a >100% DPI display, confirm glass
   shows the region directly behind each piece; edge-of-viewport pieces keep
   glass.
2. **S2 — background/content layer split** (own PR; ratified 2026-07-17):
   move grid to a background layer, point sampling at it. Verify: wire routed
   behind an unrelated piece no longer ghosts into it; drag perf unchanged or
   better.

## Acceptance (arc)

- At any zoom (0.25–1.5) and any Windows display scaling, a glass piece's
  backdrop shows exactly the region behind it.
- No wire, LED, pill, or neighboring piece content is visible inside a
  non-overlapping piece's glass.
- Grid refraction through glass still reads (the glass doesn't go inert).
- No domain-test changes; render-only diff (`npm run check:architecture`,
  `npm run test:domains` pass unchanged).
