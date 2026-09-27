/**
 * GridDomain — owner of the workspace's applied grid definition (ADR-030,
 * brief-structural-grid §4). One lattice per workspace, shared by placement,
 * rendering and routing.
 *
 * Owns: the applied definition, its validation and hydration, explicit
 * structural changes, and a geometry revision that caches key on.
 * Does not own: piece coordinates (PieceDomain), grid paint (themes), the
 * Strict/Flex choice (preferences) or the camera.
 *
 * A pure closure like ThemeDomain: commands return the next state and the
 * orchestration hook holds it in React. Persistence is injected by that hook;
 * nothing here imports UI or storage.
 */

import {
  DEFAULT_GRID_DEFINITION,
  GRID_COMPATIBILITY_DEFINITION,
  deriveGridSteps,
  sameGridDefinition,
  validateGridDefinition,
} from '../utils/gridGeometry.js';

// Where the applied definition came from.
//   default        no workspace loaded yet
//   saved          a valid record read from the workspace
//   compatibility  a workspace saved before the grid record existed
//   fallback       an invalid or newer record; the default is shown instead
//   applied        changed by the user in this session
const initialState = () => ({
  definition: { ...DEFAULT_GRID_DEFINITION, origin: { x: 0, y: 0 } },
  steps: deriveGridSteps(DEFAULT_GRID_DEFINITION),
  revision: 0,
  source: 'default',
  hydrated: false,
  // A newer or unreadable saved record is kept, never overwritten; a
  // read-only workspace cannot be written at all. Either locks editing.
  locked: false,
  diagnostics: [],
});

export function createGridDomain() {
  let state = initialState();

  const commit = (patch) => {
    state = { ...state, ...patch };
    return state;
  };

  const withDefinition = (definition, patch) => commit({
    ...patch,
    definition,
    steps: deriveGridSteps(definition),
    revision: state.revision + 1,
  });

  return {
    commands: {
      /**
       * Load a workspace's saved record. `record` is null for a workspace
       * saved before the grid existed: it gets the compatibility definition
       * and no node moves. `unreadable` reports a stored row the backend
       * could not decode: it is shown as a fallback and never overwritten.
       * Hydration never writes back.
       */
      hydrate({ record = null, readOnly = false, unreadable = false } = {}) {
        if (unreadable) {
          return withDefinition(
            { ...DEFAULT_GRID_DEFINITION, origin: { x: 0, y: 0 } },
            { source: 'fallback', hydrated: true, locked: true, diagnostics: ['the saved grid record could not be read'] },
          );
        }
        if (record == null) {
          return withDefinition(
            { ...GRID_COMPATIBILITY_DEFINITION, origin: { x: 0, y: 0 } },
            { source: 'compatibility', hydrated: true, locked: Boolean(readOnly), diagnostics: [] },
          );
        }
        const result = validateGridDefinition(record);
        if (result.ok) {
          return withDefinition(result.definition, {
            source: 'saved',
            hydrated: true,
            locked: Boolean(readOnly),
            diagnostics: [],
          });
        }
        return withDefinition(
          { ...DEFAULT_GRID_DEFINITION, origin: { x: 0, y: 0 } },
          { source: 'fallback', hydrated: true, locked: true, diagnostics: result.errors },
        );
      },

      /**
       * Apply a new definition to this workspace. Returns
       * `{ ok, changed, previous, state, errors }`; nodes never move.
       */
      applyDefinition(next) {
        if (state.locked) {
          return { ok: false, changed: false, previous: state.definition, state, errors: ['the grid cannot be changed in this workspace'] };
        }
        const result = validateGridDefinition(next);
        if (!result.ok) {
          return { ok: false, changed: false, previous: state.definition, state, errors: result.errors };
        }
        if (sameGridDefinition(result.definition, state.definition)) {
          return { ok: true, changed: false, previous: state.definition, state, errors: [] };
        }
        const previous = state.definition;
        withDefinition(result.definition, { source: 'applied' });
        return { ok: true, changed: true, previous, state, errors: [] };
      },

      /** Forget the workspace (project close or switch). */
      reset() {
        state = { ...initialState(), revision: state.revision + 1 };
        return state;
      },
    },
    selectors: {
      getState: () => state,
      getDefinition: () => state.definition,
      getSteps: () => state.steps,
      getRevision: () => state.revision,
      isHydrated: () => state.hydrated,
      canEdit: () => state.hydrated && !state.locked,
    },
  };
}
