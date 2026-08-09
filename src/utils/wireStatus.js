/**
 * wireStatus.js — worst-status-wins for aggregated wires
 * (brief-cross-group-wires D2, owner-ratified 2026-07-17).
 *
 * Mirrors the syntax domain's status priority, with `pending` slotted
 * between unused and resolved for display purposes. Lives in utils so both
 * the canvas components and selectors can use it without crossing the
 * domain/UI import boundary.
 */

const SYNTAX_STATUS_PRIORITY = {
  broken: 5,
  orphaned: 4,
  drifted: 3,
  unused: 2,
  pending: 1,
  resolved: 0,
};

/**
 * @param {Iterable<string|null|undefined>} statuses
 * @returns {string|null} the worst known status, or null when none present
 */
export function worstSyntaxStatus(statuses) {
  let worst = null;
  let worstRank = -1;
  for (const status of statuses ?? []) {
    if (status == null) continue;
    const rank = SYNTAX_STATUS_PRIORITY[status] ?? -1;
    if (rank > worstRank) {
      worst = status;
      worstRank = rank;
    }
  }
  return worst;
}
