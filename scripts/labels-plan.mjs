// ---------------------------------------------------------------------------
// labels-plan.mjs — the pure half of scripts/sync-labels.mjs: check
// .github/labels.json, then work out what has to change on GitHub.
//
// No I/O and no `gh`, so test/domains/syncLabels.test.mjs can cover every
// decision. Label names are matched ignoring case because GitHub treats
// `Bug` and `bug` as the same label; colors are compared ignoring case
// because `gh label list` returns them lowercase.
// ---------------------------------------------------------------------------

const FIELDS = ['name', 'color', 'description'];
const HEX = /^[0-9a-f]{6}$/i;
const MAX_DESCRIPTION = 100; // GitHub rejects longer label descriptions

/** Every problem in the labels file, or [] when it is safe to sync. */
export function validateLabels(labels) {
  if (!Array.isArray(labels)) return ['the file must be a JSON array of labels'];
  const problems = [];
  const firstSeen = new Map(); // lowercased name -> entry number
  labels.forEach((label, i) => {
    const entry = `entry ${i + 1}`;
    if (label === null || typeof label !== 'object' || Array.isArray(label)) {
      problems.push(`${entry}: must be an object with ${FIELDS.join(', ')}`);
      return;
    }
    const { name, color, description } = label;
    const named = typeof name === 'string' && name.trim() !== '';
    const who = named ? `"${name}" (${entry})` : entry;
    if (!named) problems.push(`${entry}: name must be a non-empty string`);
    else if (name !== name.trim()) problems.push(`${who}: name has leading or trailing spaces`);
    if (typeof color !== 'string' || !HEX.test(color)) {
      problems.push(`${who}: color must be 6 hex digits without #, got ${JSON.stringify(color)}`);
    }
    if (typeof description !== 'string') problems.push(`${who}: description must be a string`);
    else if (description.length > MAX_DESCRIPTION) {
      problems.push(`${who}: description is ${description.length} characters, GitHub allows ${MAX_DESCRIPTION}`);
    }
    const unknown = Object.keys(label).filter((key) => !FIELDS.includes(key));
    if (unknown.length) problems.push(`${who}: unknown field ${unknown.join(', ')}`);
    if (named) {
      const key = name.toLowerCase();
      if (firstSeen.has(key)) problems.push(`${who}: duplicates entry ${firstSeen.get(key)} (GitHub ignores case in label names)`);
      else firstSeen.set(key, i + 1);
    }
  });
  return problems;
}

/**
 * Compare the wanted labels with the labels on GitHub.
 * `update` entries carry `from` (the name on GitHub, which `gh label edit`
 * needs) and `changes` (which of name, color, description differ).
 * `unmanaged` labels are on GitHub but not in the file; nothing touches them.
 */
export function planSync(desired, existing) {
  const onGitHub = new Map(existing.map((label) => [label.name.toLowerCase(), label]));
  const plan = { create: [], update: [], keep: [], unmanaged: [] };
  for (const label of desired) {
    const current = onGitHub.get(label.name.toLowerCase());
    if (!current) {
      plan.create.push(label);
      continue;
    }
    const changes = [];
    if (current.name !== label.name) changes.push('name');
    if (current.color.toLowerCase() !== label.color.toLowerCase()) changes.push('color');
    if ((current.description ?? '') !== label.description) changes.push('description');
    if (changes.length) plan.update.push({ label, from: current.name, changes });
    else plan.keep.push(label);
  }
  const managed = new Set(desired.map((label) => label.name.toLowerCase()));
  plan.unmanaged = existing.filter((label) => !managed.has(label.name.toLowerCase()));
  return plan;
}
