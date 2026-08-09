import { useMemo } from 'react';

// Aggregate severity order (higher = worse): problems outrank activity —
// a warning member must never be masked by a sibling's unsaved-changes
// blue. (The original table ranked blue above amber, contradicting its own
// doc comment; owner-reported grey-LED bug pass, 2026-08-01.)
const SEVERITY = { empty: 0, green: 1, blue: 2, amber: 3, red: 4 };

/**
 * Aggregate health for EVERY group: worst state across the group's whole
 * subtree (own pieces + descendant groups' pieces via parentId,
 * cycle-guarded). Returns Map<groupId, healthState>.
 *
 * Priority: red > amber > blue > green > empty.
 *
 * Expanded groups get entries too — the collapsed pill is the only current
 * consumer, but the map no longer decides who may ask.
 *
 * `healthByPieceId` must cover ALL pieces, not just visible ones — a
 * collapsed group's members are by definition hidden, and they are exactly
 * the pieces this aggregation exists to represent.
 *
 * @param {Array} groups - all groups
 * @param {Map} healthByPieceId - pieceId → health, over all pieces
 */
export function computeGroupHealth(groups, healthByPieceId) {
  const map = new Map();
  if (!Array.isArray(groups) || !healthByPieceId) return map;

  const childrenByParent = new Map();
  for (const group of groups) {
    if (group.parentId == null) continue;
    if (!childrenByParent.has(group.parentId)) childrenByParent.set(group.parentId, []);
    childrenByParent.get(group.parentId).push(group);
  }

  for (const group of groups) {
    let worstSeverity = 0;
    let worstState = 'empty';

    const seen = new Set();
    const stack = [group];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current.id)) continue;
      seen.add(current.id);
      for (const pieceId of current.pieceIds ?? []) {
        const health = healthByPieceId.get(pieceId) ?? 'empty';
        const sev = SEVERITY[health] ?? 0;
        if (sev > worstSeverity) {
          worstSeverity = sev;
          worstState = health;
        }
      }
      for (const child of childrenByParent.get(current.id) ?? []) stack.push(child);
    }

    map.set(group.id, worstState);
  }

  return map;
}

export function useGroupHealth(groups, healthByPieceId) {
  return useMemo(
    () => computeGroupHealth(groups, healthByPieceId),
    [groups, healthByPieceId]
  );
}
