# Litria polish pass — public language & site/README

Scope: user-facing copy and framing only.  
Out of scope: backend command prefixes, internal IPC names, deep refactors.

Goal: align README + website with what the product actually is — real files, real folders, real import wires — and remove residual “puzzle / pieces” metaphor that invites Scratch comparisons.

---

## 1. Metaphor & terminology (global)

### Prefer
- **files** / **nodes** (for canvas items that are source files)
- **folder groups** / **groups** (for real directories on disk)
- **wires** / **import wires** (for relationships drawn from code)
- **canvas** as the architecture view / spatial workspace

### Avoid / replace
- “puzzle pieces” / “puzzle-piece architecture”
- “pieces” as the primary noun for files on the canvas (hero, bullets, feature lists)
- Any framing that sounds like visual programming, blocks-as-code, or a diagramming toy

### Canonical short claim (use consistently)
> Files are nodes. Folders are real groups on disk. Imports are routed wires drawn from the code itself.

### Canonical thesis (already good — keep)
> Code is not just text. It is structure, behavior, and relationships. Litria exists to make that reality usable.

### Canonical differentiator (already good — keep)
> The canvas is not a picture of your project. It is your project.

---

## 2. README (`README.md`)

### Opening / tagline
- Keep the anti-positioning: not a no-code tool, not a diagram maker.
- Replace soft “puzzle” language with nodes / folder groups / routed wires.
- One tight value paragraph early:
  - Structure and relationships are first-class
  - Code stays ordinary, exportable source
  - Canvas is a living architecture view, not a side-panel graph

### “What’s working in this beta”
- Rewrite any “puzzle-piece architecture” bullet.
- Keep and emphasize:
  - Folder groups mirror real project structure (every group is a real folder)
  - Routed wires (obstacle avoidance, corridors, first-class — not decoration)
  - Monaco + LSP; mention managed language servers more clearly
- Add or clarify:
  - **Language support:** Python + TypeScript/JavaScript bundled; rust-analyzer and clangd installable via managed directory; Go via toolchain/PATH; global PATH servers take precedence
  - **Scaffold progressive disclosure:** hide nodes/groups while preserving connections via badges (if accurate to current product)
- Optional one-liner: layout/positions persist as project state (not cosmetic-only)

### Visuals
- Add 1–3 screenshots (or a short GIF) near the top:
  1. Canvas with folder groups + routed wires
  2. Node open in the editor
  3. Optional: scaffold drawer / hide+badge state
- A visual IDE README without product visuals undersells.

### Trust / honesty (keep)
- Sole dev; application code written by Claude; ideas/architecture are the dev’s
- Unsigned builds + platform caveats
- Windows = daily driver; macOS/Linux CI-green but not yet human-launched

### Do not add to README
- VR, multiplayer, ACP agents, clusters, planning mode, long roadmap vision

---

## 3. Website (Astro site)

### Homepage hero
- Headline can stay: **“Your code, on a canvas.”**
- Lede: replace “files are pieces” with nodes/files language, e.g.:
  - “A visual desktop IDE for people who think in systems — files are nodes, folders are groups, imports are wires drawn from the code itself.”
- Keep CTAs: Download 1.0.0 + Read the idea
- Keep chips: Public beta · MIT · platforms

### Homepage body
- Keep thesis block and “three things that are true” (Structural Mirror, etc.)
- Keep honesty on unsigned builds and platform status
- Consider shortening path-to-download: substrate metrics / deep trust material can stay, but must not bury the download CTA on first screen
- Optional homepage mentions (one line each if space):
  - Managed language servers (Rust, C/C++, plus PATH)
  - Progressive disclosure (hide/badge) for large projects

### Real product proof
- Add at least one **real Litria screenshot** (or loop) distinct from the stylized `CanvasHero` site-map
- Hero canvas metaphor is clever; product photography is still required for trust

### Capabilities page
- Keep sourcing from `docs/CAPABILITIES.md` (no hand-copied drift)
- Ensure capability names/descriptions don’t reintroduce puzzle/pieces metaphor

### Idea page
- Keep repo-sourced framing
- Reinforce: canvas derived from code and writes back; folders are groups; imports are wires; moving a node moves a file

### Global site copy pass
- Search/replace pass for: `puzzle`, `pieces` (when meaning canvas files), any toy/diagram-adjacent phrasing
- Preserve voice rules from the design spec:
  - Precise, unhyped, willing to state limits
  - No “revolutionary”, “reimagine”, “AI-powered”
  - Specific numbers and named tradeoffs OK

### Out of scope for site polish
- New pages for future vision (VR, agents, clusters, recipes)
- Backend/command namespace changes

---

## 4. Shared messaging checklist

Use this as a quick gate before merge:

- [x] No “puzzle piece(s)” in user-facing README or site copy — *README done. Only
      remaining hit is `PuzzlePiece.jsx` as a filename in CONTRIBUTING's protected-zone
      list, which §5.6 puts out of scope. **Site not verified — separate repo.***
- [x] Primary nouns are files/nodes, folder groups, wires, canvas — *README done
      (value paragraph, beta bullets, shortcut tables). Site pending.*
- [x] Explicit: not no-code, not a diagram tool; code is real source — *was already true*
- [x] Explicit: groups are real folders on disk — *was already true*
- [x] Explicit: wires come from real imports — *canonical short claim now in the value
      paragraph; wires bullet reworded to “drawn from your real imports”*
- [x] Language support mentioned beyond Python/TS only (managed + PATH) —
      *rust-analyzer + clangd named as managed, Go named as toolchain/PATH, PATH
      precedence stated. Verified against `src-tauri/src/lsp/packs/`.*
- [ ] **At least one real product visual on README and/or site — NOT DONE.** Needs a
      screenshot of the running app. `img/litria1.webp` is stylized branding, not
      product photography, so it does not satisfy this. Owner action.
- [x] Honesty block intact (beta, unsigned, platform caveats, sole dev) — *was already true*
- [x] Future vision not on homepage/README — *was already true*

### Status (2026-08-30)

README half executed. **Website half (§3) untouched and unverifiable from this repo** —
there is no Astro tree here; the site lives in a separate repo. §6 optional follow-ups
not done. Audit journal: `.research/2026-08-30-polish-pass-audit.md`.

---

## 5. Suggested agent workflow

1. Repo-wide user-facing string search for `puzzle`, `piece`, `pieces` (markdown, astro, html, visible UI strings only).
2. Patch README opening + feature bullets.
3. Patch site `index.astro` hero lede and any remaining soft metaphor copy.
4. Confirm capabilities/idea pages still match repo docs and terminology.
5. Add screenshot placeholders or real assets if available (`img/` or site `public/`).
6. Do not touch Tauri command names, `cm::` prefixes, or internal identifiers.

---

## 6. Optional follow-ups (lower priority)

- README: one bullet on scaffold hide + connection badges
- Site download page: same language-support clarity as README
- Consistent lockup everywhere: `Litria 1.0.0 · Public beta` (version and status separate, per design spec)