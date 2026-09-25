# Brief: React-owned enter, exit and move animations (`<ViewTransition>`)

> **For:** Claude Code
> **Scope:** DOM enter/exit/move animations for pill notifications, toasts, and New Project wizard pages, driven by React 19.3 `<ViewTransition>`. One throwaway spike, then three slices, each with its own branch and PR.
> **Stack:** React 19.3 (JSX, not TypeScript), Tauri v2: WebView2 (Windows), WKWebView (macOS), WebKitGTK (Linux).
> **Status:** Proposed (2026-09-25). **Blocked by `brief-react-19-3-upgrade.md`.** Nothing here starts until that bump is merged.
> **Absorbs:** the parked idea note `idea-viewtransition-exit-animations.md` (2026-09-24; deleted 2026-09-25 once this brief replaced it). Its open questions (engine support, the `startTransition` pattern, Live/Calm, reduced motion) are answered below.
> **Policies to load:** implementation · verification · documentation (S1 edits `docs/ui-governance.md`). No dependency change here: React 19.3 arrives with the bump.

---

## Motivation (owner, 2026-09-25)

Toasts and pills slide in but vanish on the way out. When a pill in the middle
of the stack leaves, the ones below it jump up. The owner wants React to own
enter, exit and move animations on all three platforms, with small hand-rolled
fixes wherever a platform needs one.

## Mental model

React decides **when**: a `<ViewTransition>` boundary mounts, unmounts, moves,
or has its content swapped inside a Transition. CSS still decides **how**: the
keyframes move off the element and onto `::view-transition-old/new/group(...)`
selectors, keyed by the class names passed to the boundary.

Left exactly as they are:

- **Hover, focus, color and glow transitions.** Plain CSS (`docs/ui-governance.md` §3).
- **The Konva canvas.** To the browser it's one `<canvas>`, so View Transitions can't see nodes.
- **shadcn overlays** in `src/components/ui/` (dialog, alert-dialog, dropdown-menu, popover). Radix already animates their open and close. Wrapping them would animate twice.
- **Monaco.**

## Ground truth (verified 2026-09-25 against `main` @ a5e19e9)

### Code

- `src/components/Toast.jsx`: a module-level store read with
  `useSyncExternalStore` (:66). `dismissToast` filters the list and emits, so a
  toast unmounts instantly. Enter animation: `toast-slide-in`, 0.2s ease-out,
  `translateY(6px)` (`toast.css:31`, `:77`). Stack sits bottom-right.
- `src/components/PillNotification.jsx`:
  `pillDomain.subscribe((next) => setPills(next))` (:30) is the one place pill
  state enters React. Enter animation: `pill-slide-in`, 0.2s ease-out,
  `translateY(-6px)` (`pill-notification.css:27`, `:199`). Stack sits top-right.
- Both components return `null` when their list is empty.
- `src/components/NewProjectWizard.jsx`: `goToPage` (:487) is the only
  navigation mover (`setDirection` + `setPage`). Pages are keyed divs
  (`key="page0"` … `"page3"`) with direction-aware CSS enter fades
  (`new-project-wizard.css:195-211`, 0.3s). The outgoing page vanishes. The
  modal clips its content (`overflow: hidden`).
- Toasts and pills are glass: `backdrop-filter: blur(8px)` (`toast.css:25`,
  `pill-notification.css:22`).
- `PillNotification.jsx` and `pill-notification.css` are ADR-008 protected
  files (`PROTECTED_FILES` in `scripts/protected-zone-guard.mjs`).
  `ViewTransition` comes from `react`, not `components/ui`, so the guard is
  unaffected. Don't reach for shadcn or Tailwind animation helpers there.
- Stylesheets are imported in `App.jsx` (:134-151). The app-shell guard checks
  domain imports only, so adding a stylesheet import doesn't touch the shell
  manifest.
- `prefers-reduced-motion` is honored in exactly one file
  (`persistence-pill.css:123`), although ui-governance §7 already requires it
  (no translate micro-motion; keep color changes).

### React 19.3.0

Read from the published `react` / `react-dom` package source (`npm pack`,
2026-09-25):

- `react` exports `ViewTransition` and `addTransitionType`.
- Boundary props: `name`, `default`, `enter`, `exit`, `update`, `share`, plus
  `onEnter` / `onExit` / `onUpdate` / `onShare`. Class props take a string or
  an object keyed by transition type.
- React calls `document.startViewTransition({ update, types })` (the
  options-object form). It sets `view-transition-name` and
  `view-transition-class` on the boundary's DOM node.
- Only updates inside a Transition (`startTransition`), a Suspense reveal, or a
  deferred value animate. A plain `setState` does not.
- **Built-in fallback.** The browser call is wrapped in try/catch. If the
  engine lacks the API or rejects the options form, React applies the update
  instantly, which is today's behavior. No crash, and no polyfill needed. A
  JavaScript polyfill couldn't take the required pixel snapshots anyway;
  existing ones just skip the animation, which React already does.

### Platform support

From external sources, 2026-09-25. Links are at the end.

| Platform | Engine | React's call shape works? | Evidence |
|---|---|---|---|
| Windows | WebView2 (evergreen Chromium) | Yes | caniuse: View Transitions in Chrome 111; options form in Chrome 125 |
| macOS 15.2+ | System WebKit | Yes | caniuse: View Transitions in Safari 18.0; options form in Safari 18.2 |
| macOS 13 / 14 | System WebKit, updated along with Safari | Yes, if Safari ≥ 18.2 is installed | *Inferred; S0 confirms* |
| macOS ≤ 12 | WebKit older than Safari 18 | No; instant fallback | caniuse |
| Ubuntu 22.04 (.deb) | WebKitGTK 2.50.4 (jammy-updates) | Yes | packages.ubuntu.com; enabled in WebKitGTK 2.46, improved in 2.48 |
| Fedora | Current WebKitGTK | Yes | Fedora tracks upstream |
| AppImage | WebKitGTK bundled from the ubuntu-22.04 release runner | Yes | Tauri AppImages bundle the build host's libraries |

Litria sets no `macOS.minimumSystemVersion`, so older Macs install fine and
simply get no animation.

## Known risks (why S0 exists)

1. **Clicks are blocked during a transition.** By default the
   `::view-transition` overlay covers the page and swallows pointer events
   while the animation runs. A toast leaving while you drag a node would eat
   the drag. Fix: `::view-transition { pointer-events: none; }`.
2. **Every transition snapshots the whole page.** `:root` carries
   `view-transition-name: root` by default, so every transition captures and
   cross-fades the entire app, canvas and Monaco included. Fix:
   `:root { view-transition-name: none; }`, so only named boundaries take part.
3. **Glass may go flat mid-animation.** A named element becomes its own
   stacking context, and snapshots can't capture `backdrop-filter` because
   there's nothing behind the element to blur (CSSWG discussion; Chromium issue
   40175472). Pills and toasts are glass, so expect the blur to drop for the
   ~200ms of the animation. Not yet verified on our three webviews.
4. **Snapshots ignore ancestor clipping.** Transition snapshots render in a
   layer above the page, so the wizard modal's `overflow: hidden` doesn't clip
   a sliding page. Keep slide distances small (today's 16px), and check the
   modal edges in S3.
5. **Toasts can't transition as written.** React's documentation says a
   `useSyncExternalStore` update inside a non-blocking Transition falls back
   to a blocking update, so no view transition fires. Not re-verified for
   19.3. S2 removes the question by changing the binding.
6. **Rendering pauses briefly.** The browser holds rendering between capturing
   the old state and running React's update, roughly one frame. It should be
   invisible, but the canvas is where to watch for it.

## S0: Spike (throwaway branch, never merged)

**Goal:** turn the inferred table row and risks 1–3 into evidence before any
real slice starts.

**Tasks:**

1. Branch `spike/view-transitions` off `main`, after the React 19.3 bump has
   merged.
2. In the dev build's devtools console on each platform, record:
   - `typeof document.startViewTransition`
   - `CSS.supports('view-transition-class', 'x')`
   - `navigator.userAgent` (engine version)
3. Roughly wrap the pills in the S1 shape, add the two global rules from risks
   1–2, and raise pills through any existing path. A temporary dev-only
   trigger button is fine; this branch never merges.
4. Check four things:
   - the exit animates;
   - the stack below slides up;
   - how the glass looks during the animation (risk 3);
   - whether dragging a node while a pill leaves still works (risk 1).

**Outcomes:**

- **Everything holds:** go to S1.
- **Glass visibly flattens:** try `backdrop-filter` on the pills'
  `::view-transition-group(...)` pseudo-elements. The group sits over the live
  page, so it may be able to blur it. If that fails, the owner rules (see
  Decisions, item 3).
- **A platform lacks the API where the table says it has it:** record it. That
  platform gets the instant fallback, with no workaround.

Record the results (platform, engine version, each check) in this brief as a
dated addendum before S1 starts.

## S1: Global rules + pills

**Goal:** pills animate in, out, and shift when a neighbour leaves, and the app
stays clickable throughout.

**Tasks:**

1. Add a new `src/styles/view-transitions.css`, imported in `App.jsx` next to
   the other stylesheets. It holds only the global rules:
   - `:root { view-transition-name: none; }`
   - `::view-transition { pointer-events: none; }`
   - under `@media (prefers-reduced-motion: reduce)`: view-transition slides
     become opacity-only fades (ui-governance §7).
2. In `pill-notification.css` (each surface owns its own motion):
   - Keyframes for `::view-transition-new(.pill-enter)`,
     `::view-transition-old(.pill-exit)` and `::view-transition-group(.pill-move)`.
   - Enter matches today's `pill-slide-in`. Exit is shorter (~150ms ease-in).
     Reuse existing tokens (`--cm-transition-fast`) where they fit.
   - Guard against a double animation: inside
     `@supports (view-transition-class: a)`, set `.pill-notification`'s own
     `animation` to `none`. Engines without View Transitions keep today's CSS
     slide-in. That `@supports` block is the hand-rolled fallback for older
     Macs.
3. In `PillNotification.jsx`:
   - Change the subscriber to
     `pillDomain.subscribe((next) => startTransition(() => setPills(next)))`.
     The initial synchronous `setPills(getPills())` stays as is.
   - Wrap each pill in
     `<ViewTransition key={pill.id} enter="pill-enter" exit="pill-exit" update="pill-move">`
     (the key moves from the div to the boundary).
4. In `docs/ui-governance.md`:
   - Add a §3 row for mount/unmount/move via ViewTransition, pointing at
     `view-transitions.css`.
   - Add a §7 line saying reduced motion covers view transitions.
   - Use pointers only; don't restate the keyframes.

**Tests:** no new automated tests. The node suite has no DOM, and this behavior
is visual. Run the standard checks (see Verification).

**Acceptance (owner, `npm run tauri dev`):**

- [ ] A pill enters. Dismiss one with ×, let a success pill auto-dismiss (8s), click an action pill, click a callback pill.
- [ ] Raise three pills and dismiss the middle one: it animates out and the lower one slides up.
- [ ] The last pill leaving still animates (the container renders `null` once empty).
- [ ] While a pill leaves, drag a node and pan the canvas: no dropped input and no visible canvas hitch.
- [ ] Caret menu open: the pill still doesn't auto-dismiss (existing behavior).
- [ ] OS reduced motion on: fade only, no slide.
- [ ] Glass during the animation matches the S0 ruling.
- [ ] macOS and Linux: same list, or recorded in the PR as not yet run.

## S2: Toasts

**Goal:** toasts animate out and the stack shifts, same as pills.

**Tasks:**

1. In `ToastViewport`, replace `useSyncExternalStore` with the pill pattern:
   - `useState(getSnapshot)` plus a `useEffect` that subscribes, with a
     listener that sets state inside `startTransition`.
   - Read the snapshot once right after subscribing, so a toast fired between
     render and effect isn't missed. That gap is the one
     `useSyncExternalStore` covered.
   - The store API (`showToast`, `dismissToast`) and all its callers stay
     unchanged.
2. Wrap each toast in
   `<ViewTransition key={t.id} enter="toast-enter" exit="toast-exit" update="toast-move">`.
3. Put the keyframes in `toast.css`. Enter matches today's `toast-slide-in`,
   and the same `@supports` guard as S1 applies.

**Acceptance:**

- [ ] Fire several toasts, e.g. "Already imported".
- [ ] Dismiss one with × and let one time out (4s).
- [ ] The middle one leaving makes the rest shift; the last one leaving still animates.
- [ ] Canvas drag during an exit still works.
- [ ] Reduced motion gives a fade only.
- [ ] Platforms: same rule as S1.

## S3: Wizard pages

**Goal:** the outgoing page slides out while the new one slides in, in the
direction of navigation.

**Tasks:**

1. In `goToPage`:
   - Wrap the page-change state updates in `startTransition`.
   - Inside it, call
     `addTransitionType(target > page ? 'forward' : 'backward')`.
   - Leave urgent state (e.g. error resets) outside the transition if it reads
     better that way.
2. Wrap the page element in one `<ViewTransition>`:
   - key it by page;
   - pass `enter` and `exit` as objects keyed by transition type;
   - put the keyframes in `new-project-wizard.css`.
3. Keep the `direction` state and the `.backward` class. They now serve only
   the `@supports` fallback.

**Acceptance:**

- [ ] Next, Back and stepper jumps work in both directions.
- [ ] A rapid double Next lands on the right page.
- [ ] Running / held / opening states still freeze navigation.
- [ ] Nothing draws outside the modal edges during the slide (risk 4).
- [ ] Reduced motion gives a fade only.
- [ ] Platforms: same rule as S1.

## Out of scope (do not do)

- Canvas and Konva animations, including the viewport glide (a separate idea).
- Hover, focus and color transitions.
- shadcn / Radix overlays.
- Drawer content swaps and the persistence pill. Both are candidates later,
  once S1–S3 have settled the pattern.
- Any change to the toast store API or the pill domain API.
- Cross-document transitions (Litria is a single-page app).

## Decisions for the owner

1. **ADR or governance note?** Recommendation: a short ADR at S1 merge, using
   the next free number. It sets a cross-cutting rule that later agents need
   to find: which mechanism owns mount/unmount motion, the two global CSS
   rules, and the exclusions. ui-governance then carries pointers only.
2. **Live/Calm and motion.** Recommendation: keep motion out of Live/Calm.
   ADR-014 defines it as a static color/glow intensity axis, and the OS
   reduced-motion setting is the motion switch.
3. **Glass fallback** (only if S0 shows the blur dropping): accept ~200ms of
   flat glass, or use a hand-rolled CSS exit (a "leaving" state plus an exit
   keyframe, then removal) for pills and toasts and narrow this brief to the
   wizard.

## Verification (every slice)

- Standard checks: `npm run check:architecture`, `npm run test:domains`,
  `npm run build`. No Rust changes.
- Manual smoke per slice: the owner on Windows. macOS (tester) and Linux
  (Fedora box) either run the same list or are recorded in the PR as not run,
  per platform.
- Each PR notes which platforms showed the animation and which showed the
  instant fallback.

## Rollback

Each slice is one PR; revert it. Nothing persists, and there are no data or
schema implications.

## Sources

- [caniuse: View Transitions API](https://caniuse.com/view-transitions)
- [caniuse: `startViewTransition` options parameter](https://caniuse.com/mdn-api_document_startviewtransition_options_parameter)
- [What's new in WebKitGTK 2.46](https://webkitgtk.org/2024/10/04/webkitgtk-2.46.html)
- [WebKitGTK 2.48 highlights](https://webkitgtk.org/2025/04/08/webkitgtk-2.48.html)
- [Ubuntu jammy-updates: libwebkit2gtk-4.1-0](https://packages.ubuntu.com/jammy-updates/libwebkit2gtk-4.1-0)
- [Tauri: AppImage](https://v2.tauri.app/distribute/appimage/)
- [CSS-Tricks: Keeping the page interactive while a View Transition is running](https://css-tricks.com/keeping-the-page-interactive-while-a-view-transition-is-running/)
- [Bram.us: View Transitions page interactivity](https://www.bram.us/2025/01/29/view-transitions-page-interactivity/)
- [Chromium issue 40175472: backdrop-filter during transitions](https://issues.chromium.org/issues/40175472)
- [React CHANGELOG (19.3.0)](https://github.com/facebook/react/blob/main/CHANGELOG.md)
