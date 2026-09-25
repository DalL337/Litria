# Brief: React 19.2 → 19.3 upgrade (lockstep with react-konva)

> **For:** Claude Code
> **Scope:** Dependency bump only: `react`, `react-dom`, `react-konva` → 19.3.x, in **one commit**. No feature work, no refactors, no new React APIs.
> **Stack:** React 19 (JSX, not TypeScript), React-Konva, Tauri v2.
> **Status:** Single slice. Revised 2026-09-25 after review: security-policy load and package ages, untested-platform recording, 19.2 patch line, `engineCapabilities.js` touchpoint, and follow-up brief pointer.
> **Policies to load:** `Agents/docs/dependency-change-policy.md` and `Agents/docs/security-policy.md` (AGENTS.md §2 routes dependency changes to both), plus verification as usual.

---

## Motivation (owner, 2026-09-24)

React 19.3 (released 2026-09-09) ships stability fixes. Litria gets little direct
benefit, but staying current keeps the next jump small. This is maintenance, not
a feature.

## Ground truth (verified against `main` @ a5e19e9)

- `package.json` has `react` / `react-dom` at `^19.2.4` and `react-konva` at `^19.2.3`.
  The lockfile resolves them to 19.2.4 / 19.2.4 / 19.2.3.
- **react-konva pins its own reconciler exactly:** `react-reconciler@0.33.0` and
  `scheduler@0.27.0` (both built for React 19.2).
- `react-konva@19.3.0` exists. It requires React `^19.3.0` and ships
  `react-reconciler@0.34.0` + `scheduler@0.28.0`.
- **Package age (security-policy age gate):** `react` / `react-dom` 19.3.0
  were published 2026-09-09, and `react-konva` 19.3.0 on 2026-09-15 (npm
  registry `time` field, checked 2026-09-25). State the age on the day the
  bump runs; the owner rules on whether it clears the gate.
- **The 19.2 line kept moving:** `react` 19.2.5–19.2.8 and `react-konva`
  19.2.4–19.2.7 exist. The React changelog lists cycle protections (19.2.5),
  type hardening and performance (19.2.6), and a Server Actions fix (19.2.7,
  server-only). This bump goes straight to 19.3, so none of them is needed
  separately.
- **The trap:** old react-konva's peer range (`react ^19.2.0`) is *satisfied* by
  19.3, so bumping React alone produces **no npm warning**. The result would be a
  19.2 reconciler running the canvas under React 19.3, with two schedulers
  installed. That kind of mismatch shows up later as canvas weirdness, not as an
  install error.
- Litria does not use `startTransition`, `useTransition`, `useDeferredValue`, or
  `use()`, so 19.3's headline transition changes don't apply.
- Touchpoints that 19.3's fixes *could* affect:
  - The single `<Suspense>` around the lazy editor (`EditorDrawer.jsx`), which is
    affected by the Suspense context-propagation fixes.
  - `<React.StrictMode>` in `main.jsx` plus the existing double-run guards
    (`useCrashBoot`, `useWindowCloseGuard`, `languageSupportDomain` activate
    lock, `useScaffoldActions`), which are affected by the change to stop running
    effects on moved children in StrictMode. `src/editor/engineCapabilities.js`
    also documents StrictMode setup/cleanup safety. **Keep all guards as-is.**
  - `onUncaughtError` root option (`src/crash/errorCapture.js`).
- CI installs with `npm ci`, so the lockfile is authoritative. Commit it.

## Steps

1. Branch: `chore/react-19-3`.
2. `npm i react@^19.3.0 react-dom@^19.3.0 react-konva@^19.3.0`
3. **Dedup check (the gate):**
   `npm ls react react-dom react-reconciler scheduler`
   Expect exactly **one** of each: react/react-dom 19.3.x, react-reconciler
   0.34.x, scheduler 0.28.x. If a second copy appears, stop and report which
   package is pinning it. Do not force-resolve with `overrides` without asking.
4. Run the test trio: `npm run check:architecture`, `npm run test:domains`,
   `npm run build`.
5. `cargo` side is untouched; no Rust changes expected.

## Out of scope (do not do)

- No `<ViewTransition>`, `startTransition`, or any new 19.3 API adoption.
- No animation changes. ViewTransition adoption is its own brief,
  `brief-view-transitions.md` (this folder), blocked on this bump. The
  viewport-glide idea is parked separately in `idea-viewport-glide-off-react.md`
  (this folder).
- No removal of StrictMode guards, even if they now look redundant.
- No other dependency bumps in this commit.

## Manual smoke test (owner runs, `npm run tauri dev`)

Canvas (the reconciler swap matters most here):
- [ ] Drag a node, then a group via its header tab; Shift+drag lasso
- [ ] Hover a wire (chevron appears); click a wire (action menu)
- [ ] HUD pan wedges hold-to-glide, zoom arc, Fit, 1:1
- [ ] Minimap panning
- [ ] New Node spawn pop-in animation
- [ ] Navigate-to-piece glide and Home glide

Editor and shell:
- [ ] Open the editor drawer from a node (first load goes through the Suspense path)
- [ ] Split editor (`Ctrl+\`) and node → pane drag
- [ ] Save / Save All, dirty LEDs go blue → green
- [ ] Dev build: `crash_test_panic` plus a thrown render error, and confirm the relaunch banner

## Done when

- [ ] One commit: `package.json` and `package-lock.json` only
- [ ] `npm ls` shows single copies (paste the output in the PR)
- [ ] Test trio green; CI green
- [ ] Owner smoke test passes on Windows. macOS/Linux sanity run before the next release tag.
- [ ] The PR records, per dependency-change-policy Rules 4 and 6: the platform
      and date tested, the resolved versions (the `npm ls` output), and macOS
      and Linux as **not run** until they are. Never mark them passed on the
      strength of the Windows run.

## Rollback

Revert the single commit. There are no data or schema implications.
