# Brief: GitHub Labels — Taxonomy + Sync Script

> **Status**: Built in #117 (2026-10-06): labels file, sync script, and test.
> The owner's renames and `--apply` are still to do. Agent preview before the
> renames: 18 create, 2 update, 0 keep, 7 not managed.
> Implementation handoff, reviewed, ready to build (2026-10-06, #116).
> **Author**: DalL337 + Claude; reviewed by Claude Code and Codex (2026-10-06), owner accepted the merged review
> **Date**: 2026-10-06
> **GitHub state** (verified 2026-10-06 with `gh`): the repo has only GitHub's
> nine default labels, zero issues in any state, and no labels on any PR.

## Goal

Give the public Litria repo a small, consistent label set, defined in one file
and applied by a script. This is contributor groundwork. It takes about an hour
now and works the same for one maintainer or twenty.

**Why now.** Litria is post-launch and has one maintainer. Before outside
contributors arrive, every new issue should be easy to sort by where it lives
and what kind of work it is.

**Scope.** The labels file, the sync script and its test, and applying it once.
Nothing else.

## Where work lives

Labels apply only to the first row.

| Bucket | Example | Home |
| --- | --- | --- |
| Public work | Fix mobile canvas on litria.dev | Public GitHub Issues, labeled per this brief |
| Private notes and raw ideas | Half-formed feature thoughts | A private repo or gitignored local files. **Not** `docs/plans/ideas/`: that directory is tracked and public. |
| Security-sensitive items | A vulnerability report or scan finding | GitHub private security advisories, never public issues. Outsiders can't use this channel yet (Out of scope, item 1). |

## The label set

Twenty labels in four families. Each family answers one question.

| Label | Family | Color | Description (shown on hover) |
| --- | --- | --- | --- |
| `area: canvas` | Where? | `78909c` | Konva canvas, nodes, groups, wires, HUD, minimap |
| `area: editor` | Where? | `78909c` | Monaco editor, tabs, split panes, save system |
| `area: lsp` | Where? | `78909c` | Language servers, diagnostics, hover, completions |
| `area: terminal` | Where? | `78909c` | Embedded terminal, PTY, ConPTY host |
| `area: theme` | Where? | `78909c` | Theme tokens, presets, materials, Live/Calm |
| `area: shell` | Where? | `78909c` | Drawers, menubar, window chrome, launcher (mechanics and UX) |
| `area: scaffold` | Where? | `78909c` | New Project wizard, Blank Project, scaffold tree |
| `area: persistence` | Where? | `78909c` | SQLite workspace and app databases, migrations |
| `area: website` | Where? | `78909c` | litria.dev marketing site |
| `area: repo` | Where? | `78909c` | CI, release builds, installers, repo tooling |
| `type: bug` | What kind? | `ef5350` | It's broken |
| `type: feature` | What kind? | `42a5f5` | It doesn't exist yet |
| `type: ux` | What kind? | `ab47bc` | It works but feels wrong to use |
| `type: docs` | What kind? | `ffca28` | It isn't explained |
| `type: maintenance` | What kind? | `8d6e63` | Refactors, dependencies, chores |
| `os: macos` | Which OS? | `5c6bc0` | Only happens on macOS |
| `os: linux` | Which OS? | `5c6bc0` | Only happens on Linux |
| `os: windows` | Which OS? | `5c6bc0` | Only happens on Windows |
| `good first issue` | Contributor help | `66bb6a` | Small, well-scoped, good entry point |
| `help wanted` | Contributor help | `26a69a` | Maintainer would welcome outside help |

**Colors** are copied from `THEME_ACCENT_SWATCHES` in `src/app/themeDomain.js`.
All areas share one neutral color, each type has its own color, all OS labels
share one color, and the contributor labels are green and teal. Copy the values
into the labels file. Don't import app code, because the repo's label config
should stand on its own. Once `.github/labels.json` exists, it owns names,
colors, and descriptions, and this table is only the starting spec.

**Keep `good first issue` and `help wanted` spelled exactly like this.** They are
GitHub's conventional names, and GitHub uses `good first issue` to point new
contributors at issues. Don't prefix or rename them.

### Triage convention

Labels don't sort anything by themselves. The maintainer applies them when
triaging a new issue, so reporters don't need to.

- **One `type:`.**
- **At least one `area:`.** Add more when an issue clearly spans areas. Until
  the cause is known, label by where the user sees the problem. For example, a
  save failure starts as `area: editor` and gets `area: persistence` once the
  cause is traced to SQLite.
- **`os:` only when the problem is confirmed on one OS.** Leave it off when it
  happens everywhere or the OS is unknown.
- **Contributor help is optional.** Both labels can be on the same issue.

## Implementation

The pattern is one data file, one pure module, and one CLI script. This is the
same split `scripts/scaffold-evidence-shims.mjs` (pure helpers) and
`scripts/scaffold-recipe-evidence.mjs` (CLI) already use. Branch from `main` and
follow AGENTS.md (implementation and verification policies).

**1. `.github/labels.json`, the source of truth.** A flat array, one object per
label. Colors are 6-digit hex without `#`, the format GitHub's API uses and
`gh label list` returns.

```json
[
  { "name": "area: canvas", "color": "78909c", "description": "Konva canvas, nodes, groups, wires, HUD, minimap" }
]
```

**2. `scripts/labels-plan.mjs`, the pure logic.** No I/O and no `gh`. It exports:

- `validateLabels(labels)` returns a list of problems, or an empty list. It
  checks that:
  - every entry has string `name`, `color`, and `description` fields;
  - names are unique case-insensitively (GitHub treats `Bug` and `bug` as the
    same label);
  - colors match `/^[0-9a-f]{6}$/i`;
  - descriptions are 100 characters or fewer.
- `planSync(desired, existing)` matches labels by name case-insensitively and
  compares colors case-insensitively (GitHub returns lowercase). It returns
  four lists:
  - `create`;
  - `update`, with the changed fields named;
  - `keep`;
  - `unmanaged` (on GitHub but not in the file).

  When nothing differs, `create` and `update` are both empty.

**3. `scripts/sync-labels.mjs`, the CLI.** It uses Node built-ins only. Steps,
in order:

1. Parse the arguments: `--apply` and an optional `--repo owner/name`. Reject
   unknown flags.
2. Read `.github/labels.json` and run `validateLabels`. If there are problems,
   print all of them and exit non-zero **before any `gh` call**.
3. Check `gh`. If it isn't installed, say how to install it. If `gh auth status`
   fails, say to run `gh auth login`.
4. Resolve the repo from `--repo` or from
   `gh repo view --json nameWithOwner -q .nameWithOwner`. Print it first. Pass
   `--repo` on **every** later `gh` call. Never hardcode the repo name.
5. List the existing labels with
   `gh label list --repo <r> --limit 200 --json name,color,description`. The
   default limit of 30 would silently miss labels.
6. Run `planSync` and print the plan in plain English:

   ```text
   Target repo: <owner>/<name>
   + create        area: repo
   ~ update        type: bug (color, description)
   = keep          area: canvas
   ? not managed   wontfix
   Preview only. Nothing changed. Run `npm run labels:sync -- --apply` to apply.
   ```

7. Only with `--apply`, run `gh label create` for creates and `gh label edit`
   for updates, each with `--color`, `--description`, and `--repo`. Stop at the
   first failure with a clear message.

Rules for the script:

- **Never use a shell.** Call `spawnSync('gh', [...args])` with an argument
  array. Names contain `: ` and spaces, and descriptions contain apostrophes
  ("It's broken"), so a command string will break under some shell. Without a
  shell, Windows still resolves `gh.exe`. The `execSync("…")` string style in
  `scripts/bundle-*.mjs` is not the model here.
- **Never delete a label, in any mode.** There is no `--prune`. Labels that
  aren't in the file are reported as `not managed` and left alone.
- Keep it small enough to read in one sitting.

**4. `test/domains/syncLabels.test.mjs`.** This test imports
`../../scripts/labels-plan.mjs`, the same way
`test/domains/scaffoldEvidenceShims.test.mjs` imports its script. It covers:

- a duplicate name, including one that differs only in case;
- an invalid hex value;
- a description of 101 characters;
- a color that differs only in case, which produces `keep`, not `update`;
- a changed description, which produces an `update` naming `description`;
- a GitHub label not in the file, which produces `unmanaged`;
- applying a plan's results and planning again, which produces empty `create`
  and `update` lists.

`npm run test:domains` runs the test automatically. No fake `gh` is needed: the
part that touches GitHub is only the steps above, and the owner's preview
exercises it against the real repo.

**5. npm script.** Add `"labels:sync": "node scripts/sync-labels.mjs"` to
`package.json`. The commands are:

- `npm run labels:sync` to preview;
- `npm run labels:sync -- --apply` to apply.

## One-time setup: the three duplicate defaults

GitHub's `bug`, `enhancement`, and `documentation` labels duplicate the `type:`
family. Before the first `--apply`, the owner renames them by hand from the repo
root:

```sh
gh label edit bug --name "type: bug"
gh label edit enhancement --name "type: feature"
gh label edit documentation --name "type: docs"
```

Renaming keeps any existing associations (there are none today) and lets the
script give them their new colors and descriptions.

**Expected first preview, after the renames:** 15 create, 5 update (the three
renamed labels plus `good first issue` and `help wanted`, which get new colors
and descriptions), 0 keep, and 4 not managed. If `bug`, `enhancement`, or
`documentation` show up as not managed, the renames haven't happened yet. Do
them before `--apply`.

The other four defaults (`duplicate`, `invalid`, `question`, `wontfix`) stay
as they are, unmanaged. Deciding what to do with them is out of scope.

## Acceptance criteria

- [ ] `.github/labels.json` holds the 20 labels above.
- [ ] `scripts/labels-plan.mjs` and `scripts/sync-labels.mjs` use Node built-ins only and contain no hardcoded repo name.
- [ ] Invalid input stops the script with every problem listed, before any `gh` call.
- [ ] `test/domains/syncLabels.test.mjs` covers the cases in step 4, and `npm run test:domains` passes.
- [ ] `npm run labels:sync` prints the target repo and the plan, and writes nothing to GitHub.
- [ ] Every `gh` call passes `--repo` and an argument array, with no shell.
- [ ] The script deletes no label in any mode.
- [ ] The implementing agent runs the preview only. The owner does the renames, reads the preview (15 / 5 / 0 / 4), runs `--apply`, and confirms that a second preview shows 20 keep and nothing to create or update.

## Out of scope (next handoffs, one at a time, in this order)

1. **Security reporting channel.** Turn on private vulnerability reporting and
   add `SECURITY.md`. Both were verified absent on 2026-10-06. This comes first
   because, until it exists, an outsider's only way to report a vulnerability
   is a public issue.
2. **Issue templates.** Bug and feature forms that pre-select a `type:` label
   and tell reporters that the maintainer applies labels.
3. **GitHub Project board.** Kanban columns for issue state.
4. **CI auto-sync.** Rerun the sync when `labels.json` changes. Manual runs
   are enough for now.
5. **The four unmanaged defaults.** Keep them, add them to `labels.json`, or
   delete them by hand. Deleting a label also removes it from closed issues and
   PRs, so check usage across all states first.
6. **litria.dev Contribute page.** Pulls open `help wanted` issues at build
   time. Do this when the first outside contributor asks how to help.

## Review notes (2026-10-06)

These are the changes from the first draft, from the Claude Code and Codex
reviews:

- **Corrected:** private notes don't live in `docs/plans/ideas/`, which is
  public. The security bucket now says the outsider channel doesn't exist yet.
- **Added:**
  - `area: repo` and `type: maintenance` (Codex): label work had no area or
    type that fit.
  - the `os:` family (Claude): a desktop app on three OSes needs it as a triage
    filter.
  - the triage convention (Codex).
  - `--repo` on every call (Codex).
  - the split into a pure module and a test.
- **Renamed:** the "Newcomer?" family to "Contributor help". `help wanted`
  isn't only for newcomers.
- **Removed:**
  - `--prune` and counting open issues before deleting. Deletion also strips
    closed issues and PRs, and there are zero issues anyway.
  - the proposed `resolution:` family, which nothing needs.
  - relabeling existing issues, since none exist.
- **Rejected:** testing with a fake `gh` on PATH. Without a shell, Node on
  Windows can't launch a `.cmd` stand-in, and adding a shell brings back the
  quoting problem. The pure-module test covers the same behavior.
