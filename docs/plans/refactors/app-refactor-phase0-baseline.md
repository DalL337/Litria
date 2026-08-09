# App Refactor Phase 0 Baseline And Safety Net

## Purpose
Phase 0 freezes behavior and defines validation gates before subsystem extraction.

## Captured Baseline (2026-02-12)
- `src/App.jsx` line count: `2149`
- `src/App.jsx` structural markers:
- `const handle`: `31`
- `useCallback(`: `33`
- `useEffect(`: `14`
- `useMemo(`: `10`
- Existing built asset sizes (`dist/assets`):
- `index-Dmoqxx-T.js`: `571160` bytes
- `EditorMonaco-BWsHXHfQ.js`: `16007` bytes
- `window-uLMn-Kty.js`: `14283` bytes
- `core-mPlcS5K-.js`: `830` bytes
- `index-DInnaAbL.css`: `13459` bytes

## Phase Gates (Must Stay Green Every Phase)
- [ ] Launch project from launch screen.
- [ ] Open/create at least one piece and confirm it appears on desk.
- [ ] Select one piece and open editor via launcher tab.
- [ ] Edit tab content, save tab, confirm content persists.
- [ ] Reopen project and confirm saved content is restored.
- [ ] Dirty tab close prompt works (`Save / Discard / Cancel`).
- [ ] App exit with dirty tabs prompts unsaved-changes flow.
- [ ] Lasso multi-select works.
- [ ] Multi-piece drag works.
- [ ] Snap behavior still applies on drag end.
- [ ] Undo/redo works for move + create/delete actions.
- [ ] Group menu actions still work (`create/collapse/expand/rename/delete`).
- [ ] Scaffold drawer open/select/open-entry still works.
- [ ] Folder group creation still moves/updates file paths correctly.
- [ ] No obvious frame drops while dragging pieces.

## Runtime Baseline Capture (Fill Before Phase 1)
- [ ] Cold start to usable window (seconds): `_____`
- [ ] Initial project load to interactive desk (seconds): `_____`
- [ ] Open editor drawer latency (subjective): `_____`
- [ ] Save tab latency (subjective): `_____`
- [ ] Multi-drag smoothness at normal project size: `_____`

## Phase 0 Exit Criteria
- Checklist exists and is used as mandatory gate for every extraction phase.
- Baseline metrics are recorded before Phase 1 code movement.
- No functional refactor performed in Phase 0.

## Phase 6 Post-Refactor Snapshot (2026-02-14)
- `src/App.jsx` line count: `777` (was `2149`)
- `src/App.jsx` structural markers:
- `const handle`: `1` (was `31`)
- `useCallback(`: `9` (was `33`)
- `useEffect(`: `4` (was `14`)
- `useMemo(`: `15` (was `10`)
- Build status: `npm run build` passes after Phase 6.
- Current key build outputs (`dist/assets`):
- `index-Dfa_q13H.js`: `624366` bytes
- `EditorMonaco-DsCynEfJ.js`: `2342451` bytes
- `window-uLMn-Kty.js`: `14283` bytes
- `core-mPlcS5K-.js`: `830` bytes
- `index-Cpj6EuvL.css`: `19989` bytes
