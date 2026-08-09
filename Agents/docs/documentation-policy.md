# Documentation Policy

Scoped agent-governance procedure (see AGENTS.md §1/§2). Rules accumulate here
as lessons are learned; each entry records its provenance.

## Rule 1 — Documents live in the working tree

(Owner directive, 2026-07-13 — origin: ADR-021 was committed on a PR branch
and the agent switched the tree back to `main`, making the doc invisible in
the local `docs/` tree and its GitHub blob link unreliable.)

Any document an agent creates for the repository (ADR, plan, brief, RFC, PRD,
note) must be present in the local working tree when the turn ends:

- If the doc was committed on a branch, LEAVE that branch checked out (or
  otherwise ensure the file exists in the tree) — do not switch back to
  `main` and let the doc vanish from the user's view.
- Do not park repo documents in scratchpad directories, memory folders, or
  other out-of-tree locations. The only content that belongs outside the tree
  is agent memory itself (`MEMORY.md` + memory topic files) and `.research/`
  journals (which are in-tree but gitignored by design).
- When sharing a link to a doc on an unmerged branch, prefer the PR "Files"
  URL over a branch blob URL (branch names containing `/` make blob URLs
  unreliable), and say explicitly that the doc is on a branch pending merge.

## Rule 2 — Markdown Linting

(Moved from AGENTS.md §10, 2026-07-13.) Ignore all markdownlint warnings.
Follow standard markdown conventions only. The markdownlint VS Code extension
is not used as a quality gate in this project.

## Rule 3 — Document Types: Home, Scope, Naming

(Codified from existing practice, 2026-07-13.) Every repo document is one of
these kinds; pick the kind before writing, and don't blend scopes:

| Kind | Home + naming | Scope — what belongs in it |
|---|---|---|
| ADR | `docs/adrs/NNN-kebab-title.md` | **Normative decisions only** — what was decided and why, alternatives rejected, consequences. Detailed design does NOT belong here: the ADR cites the brief/plan as "the canonical detailed design" (ADR-020 is the model). |
| Brief / design doc | `docs/plans/**/brief-<topic>.md` (ideas: `docs/plans/ideas/`) | The full design: investigation evidence, mechanisms, trade-offs, open questions. May precede its ADR. |
| Build plan | `docs/plans/<area>/…-build-plan.md` | Delivery slices, each with Goal / Tasks / Tests / Acceptance. Owns sequencing, not decisions. |
| RFC / PRD | `docs/rfcs/`, `docs/prds/` | Early-shape proposals and product requirements. When an ADR supersedes parts of one, add a dated supersession note to the old doc — do not silently rewrite it. |
| Research journal | `.research/<date>-<task>.md` (gitignored) | Investigation state per the persistent research policy. Never a home for repo-facing content. |

## Rule 4 — Format and Provenance Conventions

- **ADR skeleton** (house format): `# ADR-NNN: Title` → `## Status` (a
  ledger: every state with its date and one-line context — `Accepted
  (2026-07-07 — revised…)`, `Extended (2026-07-10 — addendum…)`, original
  `Proposed` kept at the bottom) → `## Date` → `## Context` → `## Decision`
  (numbered subsections) → `## Consequences` (positive / costs) →
  `## Alternatives Considered` → `## Scope Notes` → optional
  `## Implementation Follow-ups`.
- **Amend, never rewrite:** accepted documents grow by dated addenda and
  blockquote errata (`> **Erratum (date, context):** …`); history stays
  legible in the document itself.
- **Pointers over restatement:** never restate what another artifact owns —
  guards are the enforcement of record (cite `PROTECTED_FILES`, don't copy
  the list), Orchestration.md owns architecture, code constants own values.
  A copied list is a future contradiction.
- **Provenance on every claim that needs trust:** date status changes and
  addenda; attribute decisions (`owner decision`); name the PR that delivered
  a slice; when a document records an empirical finding, say how it was
  verified (the gopls erratum names the check and the date).
- **Docs ride with their code** (AGENTS.md §7.2.3): a doc describing unmerged
  behavior belongs on that branch, not on `main`.
