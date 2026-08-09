# Capture: Theme & Material System (materials as the unit of a theme)

> **Status**: Captured — design direction + scoped estimate. Not scheduled. Post-beta.
> **Date**: 2026-06-21
> **Origin**: Started while evaluating the claude.ai/design portal to build a second theme; the portal turned out to be the wrong medium (it builds DOM apps, not Litria's canvas token maps), so the work pivoted into first-principles material design. Interactive companion: [prototype-theme-materials.html](../../prototypes/prototype-theme-materials.html).
> **Dependencies / anchor**: ADR-014 (Glass Material System), [theme-glass-prd.md](../../prds/theme-glass-prd.md), [live-calm-theme-variants.md](live-calm-theme-variants.md), and the semantic/material token split already gestured at in `src/theme/themeDefaults.js`.

---

## The core idea

A Litria "theme" is **not** a recolor — it differs one level deeper, at the **material**. Borrowed from industrial design (the same chair in oak / steel / plastic) and 3D engines (the same mesh under a glossy / matte / glass shader): the *object* is constant, the *substance* changes.

This splits a theme into two layers:

- **Semantic layer (shared by every theme).** *What* each channel communicates — never changes between themes. Litria's three channels: **Identity** (surface + label), **Organization** (left-edge color, cascade-inherited), **Health** (corner LED). `themeDefaults.js` already comments these as "every theme must implement."
- **Material layer (swapped per theme).** *How* each channel is drawn — a bundle of render rules that all answer to one physical metaphor. Glass = frosted/blur/rim; Terminal = flat/scanline/phosphor; etc.

The discipline that comes with it: a material is only good if it's **internally coherent** — every token reinforces one substance story. Glass blur + monospace + scanlines isn't a theme, it's a material that doesn't know what it's made of.

---

## Material taxonomy — revised cut (2026-07-01)

**Two dispatched materials, four presets.** The v1 set collapses to two draw strategies
(option b material dispatch, confirmed below), each carrying two presets:

| Material | Draw strategy (dispatched) | Presets |
|---|---|---|
| **Glass** | *effect* — backdrop blur, refraction rim, Snell corner highlights | **Glass** (default, cool blue-slate) · **Obsidian** (dark smoked glass — same effects, near-black tint) |
| **Matte** | *flat* — opaque fill + solid border, **no light effects** | **Parchment** (warm light) · **Terminal** (flat green — *the idea* of a terminal, not phosphor) |

What changed from the original cut, and why:

- **Obsidian moved from Matte → Glass.** Obsidian *does something to light* — it's dark
  tinted glass, not a flat surface. Making it a Glass preset means it rides the renderer we
  already ship: near-zero new code.
- **Terminal moved from its own effect material → a Matte preset.** We are **not emulating
  phosphor** — no scanlines, no glow, no CRT curvature. Terminal is flat green-on-near-black
  that *reads as* a terminal (optionally a monospace label to reinforce the idea). This drops
  the entire expensive effect-material build (cached scanline pattern, `edgeGlow`, block LED)
  from v1. A true phosphor Terminal remains a *later* effect-material upgrade, not v1 scope.
- **Matte is a dispatched material, not a token preset of Glass.** It has trivial draw code
  (fill + border), but it earns its own dispatch branch so it can **fully suppress** Glass's
  light work. This is the clean fix for the Snell-floor gotcha (#2 below): a token-only flat
  Matte would still leak a faint corner glint at `refractiveIndex 1.0`; a real branch simply
  never calls the glass steps.

Net effect: **one genuinely new material to build (Matte)** — Glass already exists — plus
four authored presets. Terminal's hard part is deferred, not built.

---

## Moddability — and the deliberate Rung-2 ceiling

User-facing material modding has four rungs, increasing in power and risk:

1. **Recolor presets** — swap token colors (≈ Litria today)
2. **Retune a material** — adjust its knobs (fork a built-in, change values)
3. **Compose a stack** — assemble materials from engine primitives (no code, combinatorial)
4. **Programmatic** — ship draw code / shaders (needs an extension sandbox)

**Decision: expose users at Rung 2. It covers 90%+ of "make Litria mine."**

Why this is a clean line:
- **No Rung-3 engine, no Rung-4 sandbox** — the expensive, open-ended parts are cut.
- **Near-zero new public contract.** At Rung 2 users depend only on *the token set per material*, and tokens are already a versioned, normalized, fallback-safe, ignore-unknown contract (`GLASS_THEME_VERSION` + the migrate path). Opening Rung 2 rides the contract we already maintain; Rung 3 would have created a brand-new public API surface.
- **The engine stays option (b) internally.** Materials are dev-authored draw strategies dispatched on a `material` field — clean separation, coherence by construction — but that seam never becomes a public API, so it carries no moddability tax.
- **The product lever becomes curation, not infrastructure.** Expressive range = how many good built-in materials ship, not how powerful an editor is. Spend effort authoring Glass / Terminal / Matte (+ presets), not a composition engine.

Governance carry-over: the **only** near-reserved surface is the health-LED *semantics* — and
even that stays **editable, not locked** (see the editability stance below): the LED colors can be
retuned, but the warning channel keeps a readability *guard* (warn if error/success become
indistinguishable) rather than a hard lock. Everything else — every material knob, every color —
is the user's to change.

---

## Editability & the color ⊥ material contract (decided 2026-07-01)

**Stance: everything is editable. Nothing is locked away.** Every material and every preset is
forkable and tunable — the whole point is user control over how the app respects them. Rung 2 is
the *mechanism* (token forks); total editability is the *promise*. The lone exception is a
soft guard on diagnostic distinguishability, above — a warning, never a lock.

**The load-bearing rule — a material is a *finish* every color passes through.** Color and
material are orthogonal:
- **Color** = *what* (a hue the user picks: node surface, group color, per-node assigned edge, accent).
- **Material** = *how* that hue is rendered (the substance/finish: Matte flat-opaque, Glass frosted-rimmed).

So the same user-picked purple renders as **matte purple** under Matte+Parchment (flat opaque fill,
solid border, no gloss) and as **glass purple** under Glass (translucent tint, blur, refraction
rim). The hue stays faithful; the finish belongs to the active material. A user changing a node
background from parchment-white to purple gets purple *in the material's finish* — never a raw
purple that ignores it.

**Invariant (architecture-guard candidate):** no user color reaches the canvas except as an
*input* to a material draw strategy. There is no code path that paints a user hue as a raw
`fillStyle`. This is the exact property that guarantees "recolored → still matte." Concretely, the
existing token split already supports it: `nodeSurfaceTint` (the hue) is separate from the finish
tokens (`glassBlurRadius`/rim vs. Matte's opaque-fill/border); the material dispatch just picks
which finish consumes the hue. Alpha=1 + blur off = matte; alpha<1 + blur + rim = glass — same
tint, different substance.

**Not to be confused with Live/Calm.** That axis is an *optional* saturation/lightness transform
on the org-edge color (an energy knob), orthogonal to material finish. The material does not
recolor a hue to "fit" — it renders the hue faithfully in its own substance. Purple stays purple;
it just gets the matte (or glass) treatment.

---

## Glass presets — default & Obsidian

Same effect draw (blur/rim/Snell), two tints:
- **Glass** (default): cool blue-slate. Surface transparent-to-frosted, refraction rim on.
- **Obsidian**: dark smoked glass — near-black tint, keeps blur + rim so it still refracts.
  Purely a token retune of the Glass material, no new draw code.

## Matte — Parchment & Terminal

One dispatched flat material (opaque fill + solid border, **no light effects**), palette-swapped:
- **Parchment** — warm ochre/tannin, **color only — no texture**. Surface ~`#cdb98a`, deep-tannin
  text `#3b2a14`, tannin border `#8a6a3c`. Reads as an illuminated page on the dark canvas —
  "not flash-bang white, not dark." Source palette: yellow ochre → ochre → raw sienna → tannin →
  parchment → deep tannin. This is the first **light** material and the renderer already supports
  it: `getAutoContrastTextColor` in `PuzzlePiece.jsx` flips to dark text when surface luminance
  ≥ 0.45, so a warm tint gets readable dark-tannin text with zero new code.
- **Terminal** — flat green-on-near-black that *evokes* a terminal without emulating one. Surface
  ~`#12220f` opaque, green ink, dim-green border, hard corners. **No scanlines, no phosphor glow,
  no animation.** Optionally a monospace label (via a `fontFamily` token) to reinforce the idea —
  but that's the only net-new token, and it's deferrable. The health LED stays the standard enum
  (reserved diagnostic semantics); no block-LED work needed.

Both Matte presets share the same trivial draw branch; they differ only in token values —
which is exactly the Rung-2 recolor playground users inherit.

### Deferred: phosphor Terminal (later effect material)
The full CRT look — static scanlines, phosphor bloom (`edgeGlow`), monospace, block LED —
is a *later* upgrade that promotes Terminal into its own effect material alongside Glass.
Not v1. Captured here so the idea isn't lost, not so it blocks the flat-green ship.

---

## Rework estimate (from reading the renderer)

`PuzzlePiece.jsx` is already favorable: every value is token-driven with clamps/fallbacks, blur is guarded (`blurRadius > 0`), the LED already dispatches on an enum (`'arc' | 'dot'` → add `'block'`), edge desaturation already exists (`pastelizeColor`), and the surface `sceneFunc` is discrete draw steps with a comment anticipating future injection. `ConnectionLine.jsx` is a simple token-colored straight line.

Net-new work for the revised **Glass + Matte** cut (node-level, no phosphor):
- Material dispatch seam — thread `material`, split surface draw into `drawGlass()` / `drawMatte()` (option b) — ~0.5–1d
- Matte primitives — opaque fill, solid border, hard corners; branch simply omits blur/rim/Snell — ~0.5d
- Token split + built-in registry + `material` field + migration — ~1–2d
- Four presets authored (Glass, Obsidian, Parchment, Terminal token bags) — ~0.5d
- Per-material Live/Calm overrides — ~0.5d
- Tests + architecture guards — ~1d
- *(deferrable, Terminal polish)* `fontFamily` monospace token — ~0.25d

**≈ 3–4 days** for Glass + Matte at the node level — down from the ~1 week the effect-Terminal
cut required, because the scanline/phosphor/edge-glow/block-LED work is deferred out of v1.
The dispatch seam is the load-bearing piece; everything else is token authoring.

Gotchas from the renderer read (revised):
1. **Snell highlights never fully switch off** — at `refractiveIndex: 1.0`, `snellAlpha` floors at
   `0.1`. This is *why Matte is a dispatched material* rather than a flat token preset: the Matte
   branch never calls the Snell step, so the glint is gone for free.
2. **Corner radius clamps to a min of 2** — Matte wants harder corners; if 0px is desired, a
   one-line clamp change is needed. 2px is probably fine for v1.
3. **Font is hardcoded** — only relevant to the optional monospace Terminal label; introducing a
   `fontFamily` token is deferrable and doesn't block the flat-green ship.

---

## Open / later

- ~~Confirm dispatch granularity~~ **DECIDED (2026-07-01): (b) material strategy.** Glass and
  Matte are both dispatched draw strategies; Matte's own branch is what suppresses the Snell floor.
- ~~Final built-in set~~ **DECIDED: 2 materials / 4 presets** — Glass{Glass, Obsidian} +
  Matte{Parchment, Terminal}. Phosphor Terminal deferred to a later effect material.
- ~~Editable-vs-reserved material token list~~ **DECIDED (2026-07-01): everything editable.**
  No reserved token list; the only near-reservation is a soft readability *guard* on the health-LED
  warning channel (warn, don't lock). See "Editability & the color ⊥ material contract" above.
- **Guard candidate:** enforce the color⊥material invariant — no user hue rendered except through
  a material draw strategy (no raw `fillStyle` paths). Worth an architecture guard when Matte lands.
- App-shell scope: node-only for v1 (like Glass), or eventually restyle drawers/chrome.
- ~~Project-creation flow impact~~ **ANSWERED (2026-07-01): adds to the established flow, does
  not restructure it.** See section below.
- Curate the Matte preset library beyond Parchment/Terminal (cream/slate/…) — the Rung-2 long tail.
- Optional monospace `fontFamily` token for the Terminal preset — reinforces the idea, deferrable.

## Project-creation flow: adds, does not restructure (2026-07-01)

The shipped 4-page New Project Wizard (`src/components/NewProjectWizard.jsx`) already anticipates
this work. Page 2 ("Shape the workspace") **already has a Base Theme picker**, and its `THEMES`
list already carries all four names with three locked: **Glass** (available) · Obsidian · Terminal
· Paper (locked). The `theme` field is already collected, passed to `scaffold_project`, and
persisted per-project (appearance object). So the material system's creation-flow footprint is:

- **Unlock the three locked presets** — gated on the engine landing (Matte material + four preset
  bags must render first). Until then they stay locked exactly as today. **No new pages.**
- **Rename Paper → Parchment** in the `THEMES` list (naming reconcile).
- **Material stays internal.** The wizard keeps a *flat list of four presets*; the user never picks
  material-then-preset at creation. Preset→material is a fixed internal map the renderer dispatches
  on. Keeps first-run friction low.
- **Color pickers unchanged.** The existing group-color / single-piece-color pickers feed hues that
  the active material renders in its own finish (color ⊥ material). They're already material-agnostic
  inputs — the wizard doesn't need to know which material consumes them.
- **Persistence:** `theme` already stored per-project → likely **derive `material` from the preset
  id** (fixed map) rather than add a creation-time field.

Where "everything editable" actually lives: **the Settings panel, not the wizard.** The per-project
theme editor already has `createThemeFromBase` (that *is* Rung-2 forking) and stores appearance
tokens per project — that's the home for material-aware token editing. The wizard only *seeds* a
starting preset + colors. Global Live/Calm vs. per-project theme split already exists, untouched.

## Harvested palettes (from `litria_theme_poc.html`, now retired)

Candidate token values lifted from the disposable DOM POC. Not the real contract (that's
`GLASS_THEME_TOKEN_DEFAULTS`), just color reference for authoring the four preset bags:

| Preset | Material | Canvas | Surface | Ink | Accent / edge |
|---|---|---|---|---|---|
| Glass | Glass | `#1a1d2b` | `rgba(150,165,215,0.14)` | `#e8ecfb` | `#5b6bd8` / `#7f8fe0` |
| Obsidian | Glass | `#0e0d14` | `rgba(40,34,58,0.72)` | `#ded6f2` | `#7c5cd6` / `#9a78e0` |
| Parchment | Matte | `#f4e6c8` | `rgba(255,250,238,0.82)` | `#4a3a1c` | `#b07d2e` / `#a8722a` |
| Terminal | Matte | `#0a0f0a` | `rgba(20,45,22,0.70)` | `#8affa0` | `#1f9e3a` / `#3ecf5a` |

Note: the POC's Parchment canvas (`#f4e6c8`) is a lighter tuning than this doc's earlier
Parchment surface (`#cdb98a`); reconcile the two when authoring the preset. POC blur values are
mock artifacts — Matte presets (Parchment, Terminal) render blur **off**.

> **3D/VR forward-compat:** a material *is* a shader in the VR endpoint. Designing themes as coherent materials now — even in 2D — authors the exact mental model that maps onto PBR shaders later. The 2D material editor is the on-ramp to the 3D shader editor. Tethered to ADR-014; don't re-litigate as a net-new theme.
