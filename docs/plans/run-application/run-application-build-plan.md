# Run Application build plan

Status: Ready for implementation planning, 2026-09-16. Product decisions
accepted; **all slices are pending and no code has been delivered**.

Decisions: [ADR-029](../../adrs/029-managed-project-runs.md).
Canonical mechanisms/contracts: [Run Application brief](../ideas/brief-run-application.md).
This document owns sequencing, executable evidence and completion status.

## 1. Delivery rules and baseline

- Preserve the established Windows/macOS/Linux compile-and-run baseline.
  This arc adds Run-specific behavior and regression evidence.
- Work in isolated branches/worktrees from refreshed main. Do not amend
  another agent's scaffold slice or reuse its branch for this arc.
- Reconcile the brief's reviewed commit with implementation HEAD. If the
  scaffold arc already closed a gap, link its implementation and verify the
  needed contract rather than applying a duplicate fix.
- Record exact versions/features when a dependency is adopted. Apply the
  [dependency](../../../Agents/docs/dependency-change-policy.md),
  [security](../../../Agents/docs/security-policy.md) and
  [verification](../../../Agents/docs/verification-policy.md) policies.
- Existing glib/transitive rand advisories remain upstream Tauri tracking
  items per the owner. They do not block this arc by themselves and are not
  instructions to force direct upgrades. New advisories or changed exposure
  require their own disposition.
- Keep the feature unavailable to ordinary users until both native ownership
  paths and approval checks are connected. A partially wired Run button is
  not a completed slice or a successful launch experience.
- Update each slice with commit/PR, exact test commands, outcomes and native
  environments. A checkbox is not evidence. Failed/unavailable checks stay
  visible, with the next action and responsible slice.

The initial supported artifact set follows the existing release matrix:
Windows x64, macOS ARM64, macOS x64 and Linux x64. Do not silently add Linux
ARM64/Windows ARM64/musl support. Existing supported OS versions and package
formats must be retained or have an explicit compatibility resolution.

## 2. Slice map

| Slice | Delivery | Dependencies | Status |
| --- | --- | --- | --- |
| S1 | Shared contracts, local storage boundary, RunDomain and guards | ADR-029 | Pending |
| S2 | Discovery, env files, runtime resolution and approval | S1 | Pending |
| S3 | Windows owned launch/stop | S1, S2 contracts | Pending |
| S4 | Unix owned launch and owner-death supervisor | S1, S2 contracts | Pending |
| S5 | Output, input, replay, result and browser events | S3, S4 | Pending |
| S6 | Scaffold adapter and bundled runtime integrity | S2; scaffold registry integration available | Pending |
| S7 | Run UI, save/restart/switch/quit flows and sharing | S2-S6 | Pending |
| S8 | Native installed-artifact evidence and release readiness | S1-S7 | Pending |

S3 and S4 consume the same contract. Neither is a substitute for the other.
S6 may use explicit fixtures while the scaffold arc is still being built,
but final recipe coverage must use the actual integrated registry.

## S1. Shared contracts and domain boundaries

### Goal

Establish one authoritative run model and ownership boundary before any UI
can spawn a process.

### Tasks

- Implement the typed target/launch-plan/preview/result/event schema in
  Rust and shared serialization fixtures for the frontend. Reject unknown
  execution kinds, unsupported schema versions, duplicate IDs and oversize
  input. Keep compound execution rejected in v1.
- Add the separate run registry and atomic start/restart reservation model,
  with canonical root, run ID, target ID and request idempotency. Keep slow
  operations outside registry locks. Late callbacks compare identity.
- Add versioned local configuration/approval/creation-receipt migrations
  through the app database owner. Declare per-user/install scope and use
  real UUIDs for new persistent entities.
- Add `createRunDomain` with commands/selectors and injected adapters; keep
  editor saves and project transitions behind their owning APIs.
- Extend architecture and domain-contract guard coverage to `src/run` in
  the same slice. Verify the guard actually visits the new directory;
  registration prose alone is insufficient. Keep App composition-only.
- Define native adapter and Unix supervisor protocol contracts, bounded
  payloads and ownership-ready handshake. No public network listener.
- Declare/audit direct Unix signal, UUID and env-parser candidate needs.
  Record exact versions, minimum Rust support, target gates, features,
  licenses and advisory dispositions when chosen; no blanket latest bump.

### Tests

Schema round trips and rejection cases; two starts for one canonical root;
same root under different IDs; stale run event; cancelled start reservation;
database failure preserving prior state; cross-project preview rejection;
shared UUID without local trust; StrictMode duplicate invocation; guard
coverage rejecting a deliberately invalid temporary fixture.

### Acceptance

- One model owns state and one Rust boundary authorizes execution.
- New files are guard-covered and no generic shell execution IPC is added.
- Local data cannot be mistaken for a shared approval.
- Standard frontend guards/tests/build pass; Rust build has zero warnings
  and Rust tests pass when this slice changes Rust.
- No user-facing Run activation before native and approval paths exist.

## S2. Discovery, environment and reviewed launch plans

### Goal

Resolve what will run from saved project state and the user's choices,
without hidden execution or secret persistence.

### Tasks

- Implement bounded inert discovery for declared scripts/entry points and
  explicit custom targets, plus the recipe adapter interface for S6.
  Ambiguous manifests/workspaces remain choices; no active-file guessing.
- Resolve selected runtimes to absolute executables, with manager-specific
  launch adapters and explicit native/script/batch distinctions. Preserve
  explicit runtime selection and expose missing prerequisites.
- Support normal GUI-launched PATH; do not source login profiles or run
  project-owned probes during inert discovery. Bound authorized preflight
  probes and cancellation; abandoned workers cannot launch later.
- Build clean per-child environments. Implement the brief's env-file
  grammar/precedence with a reviewed parser; no global env mutation,
  ambient interpolation or shell evaluation. Keep raw values Rust-local.
- Compute versioned execution-affecting fingerprints and issue expiring,
  single-use previews. Bind approvals to install, root, target and resolved
  inputs. Revalidate after saves and before spawn; sanitize all error paths.
- Implement local config revisions, explicit portable projection and
  creation-receipt validation. A repository-supplied trust flag is inert.
- Implement structured actionable errors and one-time review behavior when
  local approval persistence fails; never report a failed save as saved.

### Tests

Use fixtures for selected script/pre/post hook changes, Git-style manifest
replacement, changed runtime/manager/cwd, env-content/source changes,
preview expiration, missing/malformed/oversize env files, ordered overrides,
literal substitution syntax, Windows env key casing, Unix case sensitivity,
NUL/encoding rejection, symlink escape, external local-only references,
quoted/metacharacter arguments and a selected runtime differing from PATH.

Assert no project code executes during discovery, no download/install is
performed by preflight, and no secret values appear in configuration,
receipts, frontend payloads, structured errors or trace/breadcrumb captures.
Test ordinary source edits that do not alter a launch definition separately
from edits which must invalidate approval.

### Acceptance

- Review and execution consume the same validated plan.
- Changed definitions cannot reuse stale consent; a copied project cannot
  import approval from its shared configuration or recipe label.
- Exact parser/manager/runtime behavior is verified for adopted versions.
- Required S1 checks remain green; no project scripts are used as discovery
  shortcuts or silent prerequisite repair.

## S3. Windows launch and process ownership

### Goal

Establish job ownership before application execution and provide bounded,
observable Stop/Restart/owner-death cleanup on Windows.

### Tasks

- Implement ConPTY creation with job association before project code can
  run. Test the creation-time or suspended-create/assign/resume mechanism;
  refuse unmanaged fallback on any acquisition failure.
- Retain non-inheritable lifetime handles and compatible nested-job behavior.
  Preserve the vendored ConPTY consumer patch and existing terminal behavior.
- Implement native executable/Node-entry/batch-shim launch paths with correct
  argument boundaries. Remove sensitive full-command logging from reused
  vendor error paths before exposing them to Run.
- Implement graceful interrupt, bounded job escalation, observed child exit,
  reaping and PTY worker/handle cleanup. Do not send literal shell `exit`.
- Exercise partial start failures after every acquired resource, stop during
  spawn, and unexpected Litria process termination. Retain ownership state
  when cleanup cannot be confirmed.

### Tests

Native fixtures: direct application; package-manager `.cmd` shim; immediate
child/grandchild spawn; descendant retaining output; ignored interrupt;
root exit before descendant; failed job assignment; failed PTY reader setup;
arguments/paths containing spaces, Unicode and shell metacharacters;
normal stop; force stop; parent process killed; unrelated process survives;
repeated runs without handle/thread/process accumulation.

### Acceptance

- No application code runs before required ownership is established.
- The tested managed job exits on owner death without frontend assistance.
- Restart cannot overlap an unresolved old run.
- Windows debug/release fixtures and existing terminal regressions pass.
- Source review and a passing Windows build alone do not close this slice.

## S4. Unix launch and owner-death supervisor

### Goal

Provide macOS/Linux run ownership and crash cleanup with the same product
contract as Windows.

### Tasks

- Add a non-UI supervisor entry mode dispatched before Tauri initialization,
  packaged for each existing Unix target. Implement bounded versioned
  private IPC and a per-run identity handshake.
- Implement PTY/session/group establishment before execution and retain an
  ownership anchor until the final destructive operation. No delayed kill
  based solely on a persisted/recycled PID or PGID.
- Ensure only the Litria owner retains the lifetime endpoint. Close all
  unintended inherited descriptors in the supervisor/target/grandchildren.
- Implement direct argv launch, signal/mask setup, group interruption and
  bounded escalation/reaping. A root application exit still cleans its
  remaining managed descendants.
- Observe owner EOF independently of output pressure and UI liveness.
  Owner death, normal Stop and failed startup use the same cleanup owner.
- Specify safe behavior for helper startup/protocol failure and cleanup
  failure. No direct unmanaged fallback, shell sourcing or process-name kill.
- Exercise packaged entry dispatch and native permission/signing behavior;
  record the explicit unsupported daemon/privilege/supervisor-death boundary.

### Tests

Run native fixtures on macOS and Linux: child/grandchild; immediate fork;
parent Litria process terminated with SIGKILL; inherited-lifetime-FD leak
regression; root exits while descendant stays; ignored SIGINT/SIGTERM;
blocked output transport; stdin/PTY EOF; helper incompatible/missing; stop
during handshake; PID/group ownership retained through teardown; unrelated
process unaffected; repeated starts; temporary frontend disconnect versus
actual process death. Include optimized builds and bounded completion.

### Acceptance

- Managed runs are cleaned after abrupt Litria process death on both OSes.
- Supervisor readiness precedes Running and ownership cannot silently fail.
- No leaked helper, run process, descriptors or unowned cleanup worker in
  repeated native tests; unresolved failure stays explicit.
- Intel execution evidence is identified separately from ARM64 host tests
  or Rosetta. See S8 for final installed-artifact acceptance.

## S5. Output, result, input and browser surface

### Goal

Provide reliable output and final state independently of drawer visibility
and transport timing.

### Tasks

- Implement bounded byte storage, bounded event batches/queues, incremental
  decoding, sequence numbers and replay cursors. Overflow emits a visible
  gap; hidden/slow UI does not stop child output draining.
- Separate process completion from PTY EOF and supervisor status. Emit one
  final lifecycle result with application exit/signal, reason and cleanup
  outcome, scoped to the correct run.
- Add bounded active-run input and resize commands; restrict presentation
  escape side effects and preserve the independent interactive terminal.
- Implement bounded URL candidates and a user-invoked narrow HTTP(S) opener.
  Keep readiness separate from printed URLs and process liveness.
- Keep raw output out of automatic logs/traces. Build an explicit export
  path with content review/notice and guarded writes; do not claim masking
  guarantees secrecy of arbitrary output.

### Tests

Split multibyte UTF-8; malformed output; ANSI sequences; huge output while
hidden; subscriber disconnect/reconnect; replay gaps; stale run events;
closed stdout with a live process; duplicate exit callbacks; output after
stop request; absent browser; credential-bearing/invalid/non-HTTP URL;
URL split across reads; wildcard listen address; unrelated port already
bound; application that never prints a URL; secret-like child output never
automatically persisted or attached to a report.

### Acceptance

- Hiding/showing Run output cannot kill, restart or indefinitely block it.
- Exit status comes from native lifecycle observation, not a guessed EOF.
- Browser opens only after user action through the narrow validated path.
- Memory and queued-output limits hold under sustained fixture output.

## S6. Scaffold metadata and bundled runtime integration

### Goal

Make the accepted target coverage real without duplicating the scaffold
matrix, and ensure the runtime executed matches its verified platform asset.

### Tasks

- Integrate with the scaffold recipe registry after coordinating its public
  run metadata contract. Resolve candidates from actual outputs and expose
  incomplete/non-runnable recipes honestly.
- Produce local creation receipts only after successful creation and
  launch-input verification. Test existing/legacy/copied/generated projects
  separately. Missing receipt uses normal review.
- Extract/reuse manager/runtime resolution behind the proper owner, without
  importing a scaffold creation command as Run's process launcher.
- Verify official per-target Node artifact digests and commit the expected
  hashes for every existing release target. Normal staging rejects unknown
  hashes; it must not bless a download by recording its own hash.
- Key extracted runtime identity by OS/architecture/version/digest; verify
  and atomically publish. Preserve prior usable assets on failed extraction
  and handle concurrent starts safely.
- Reconcile runtime OS floors with the existing support baseline, packaged
  paths, executable permissions and Mac architecture/signing behavior. Any
  proposed support change needs explicit evidence and disposition.

### Tests

Registry-to-Run contract fixtures, generated runnable output, no-entry-point
recipes, stale creation receipts, legacy scaffold without receipt, custom
edited scripts, each distinct offered manager path, Python interpreter/venv
bindings, Node chosen differently from ambient PATH, missing/wrong hash,
partial extraction, same-version Mac architecture switch, concurrent cache
use and GUI-launched runtime discovery.

### Acceptance

- Every offered scaffold target has a valid launch plan and appropriate
  runnable-stage evidence; no new independent support matrix exists.
- The first-review exemption is local and exact, never inferred from a
  repository flag.
- Existing-platform runtime assets have independent expected hashes and
  correct identity. Unverified generated combinations stay visible as such.

## S7. User-facing Run and transition integration

### Goal

Deliver the agreed workflow through the project bar and dedicated drawer,
with user choice and failure-aware state transitions.

### Tasks

- Wire project-bar Run/target menu/Stop/Restart and the independent Run tab.
  Keep the App shell thin and use domain commands/selectors.
- Implement compact review/chooser/Edit, local target saving and explicit
  portable sharing through the filesystem write owner. Preview the file;
  disclose ignored-file status if relevant without changing Git ignores or
  staging anything automatically.
- Wire the three unsaved choices and optional explicit per-project memory
  through PreferencesDomain/registry. Respect actual editor save results.
- Integrate Restart's pre-stop choices and backend expected-run reservation.
  Re-review changes detected after teardown; never launch a stale preview.
- Wire Stop and Switch / Stay into every project replacement route, then
  normal quit and crash/window-failure hooks into the same cleanup owner.
- Present missing prerequisites, invalid target/config, approval-store
  failure, interrupted previous run and cleanup failure as actionable states.
- Follow UI governance/accessibility/protected-zone contracts. Verify real
  visuals, keyboard focus and control labels; color alone is insufficient.

### Tests

UI/domain/native integration: first run and later one-click run; script edited
by user/Git/agent; local creation exemption; ambiguous target chooser;
configuration edit invalidates preview; Save All success/failure/cancel;
Run Saved Files preserves buffers; untitled entry point; remembered choice
reset; Restart cancel retains existing run; file watchers after save;
Stop-and-Switch success/failure; each alternate project-opening route;
cancelled quit; normal quit; helper cleanup after crash; shared configuration
on a second machine/root needs review; sharing conflicts/ignored files;
interactive terminal remains independent.

### Acceptance

- All accepted choices are available without a mandatory full setup screen.
- A save/cancel/write failure never produces a false launch/switch/saved state.
- No background run survives an accepted project switch in v1.
- Visual verification and keyboard/accessibility evidence are recorded.
- Feature becomes available only with both native implementations and the
  approval boundary wired; standard repository checks pass.

## S8. Native acceptance and delivery evidence

### Goal

Prove the new behavior in installed Litria on every existing supported
platform and close the arc with reproducible evidence.

### Tasks

- Add non-publishing PR Rust build/test coverage for the affected platform
  code, keeping release-upload workflows separate. Stage approved resources
  before Tauri-dependent builds/tests.
- Use the same source commit, lockfile and recorded toolchain for evidence.
  Run locked Rust builds/tests with zero warnings and optimized supervision
  fixtures; run the frontend standard guards/tests/build.
- Produce and launch installed Windows/macOS/Linux artifacts from normal
  desktop entry points. Test GUI PATH, helper dispatch, browser offer,
  desktop child processes and cleanup under ordinary user permissions.
- Run representative declared JavaScript, Python and native application
  fixtures; map each distinct recipe/manager/native adapter path to evidence.
  Do not treat one npm fixture as all-manager/all-recipe coverage.
- Refresh exact dependency/advisory results and vendor-patch review. Carry
  upstream Tauri dispositions explicitly; new findings get independent review.
- Verify no test-only automation bridge/listener ships in release artifacts.
  Record X11/Wayland, architecture, minimum supported OS and package formats.
- Update implemented domain registration/capability claims and delivery
  ledgers only after the corresponding code and evidence exist.

### Tests

Run the coverage matrix below, including application-owner death, forced
teardown and repeated start/stop cycles. A native helper fixture supplements
but does not replace the installed application's UI/lifecycle integration.

### Acceptance

- Every existing supported target has passed the applicable Run acceptance
  paths with recorded evidence; unavailable environments are not marked passed.
- Windows/macOS/Linux regressions introduced by Run are resolved.
- G1-G12 and the decision coverage table have linked implementation and
  verification, or an explicit separately owned disposition where applicable.
- No unsupported compound/background/secret-vault/platform behavior is
  accidentally advertised as part of v1.

## 3. Native evidence matrix

All rows below are **pending for the new Run feature**. They do not dispute
the owner's existing application compile-and-run evidence.

| Target/environment | Build/package | Run UI + fixture | Stop/restart/switch/quit | Abrupt owner death | Status |
| --- | --- | --- | --- | --- | --- |
| Windows x64, installed artifact | Locked build/tests; existing installer formats | JS/Python/native routes; `.cmd` and selected runtime | Job and handle cleanup; repeated runs | Job lifetime proof | Pending |
| macOS ARM64, installed `.app` | Native build/tests/package | Finder launch; permissions/signing; env selection | Group/supervisor cleanup | Owner pipe EOF with SIGKILL | Pending |
| macOS x64, installed `.app` | Explicit target build; identify execution host | Actual x64 execution; record native Intel versus Rosetta | Same native lifecycle contract | Same supervisor contract | Pending |
| Linux x64, established distro/package baseline | Native build/tests; GTK/WebKitGTK prerequisites | Desktop launch; selected runtime/browser | Group/supervisor cleanup | Owner pipe EOF with SIGKILL | Pending |
| Linux x64, newer desktop/X11 and Wayland coverage | Applicable artifact compatibility | GUI child/session env and drawer behavior | Native lifecycle regression | Applicable owner-death fixture | Pending |

Record actual runner/hardware architecture, OS/distribution version,
display session, artifact identity, source commit, lockfile digest,
toolchain, runtime/manager versions, commands and observed results. Do not
record secrets, user account identifiers or machine-specific private paths.

## 4. Decision and gap coverage

| Requirement | Primary slice | Evidence required |
| --- | --- | --- |
| Current-project application target and editable discovery | S2/S6/S7 | Actual candidate/chooser/custom-target fixtures |
| First/changed-command review; local creation exemption | S2/S6/S7 | Changed inputs, copied projects, stale receipts and preview race |
| Unsaved choice and cancellation before Restart stop | S7 | Failure/cancel/dirty-buffer integration |
| Local default, explicit sharing and secret separation | S1/S2/S7 | Local/shared persistence, conflict and second-root tests |
| Selected env files and defined precedence | S2 | Parser grammar, clean env, secret-free structured data |
| Independent terminal and Run output | S1/S5/S7 | Existing shell remains; hidden output keeps draining |
| Windows ownership and `.cmd` handling (G2/G3/G6) | S3 | Native launch/failure/teardown fixtures |
| Unix process-group and owner-death cleanup (G4) | S4 | Native parent SIGKILL and inherited-FD regression |
| Atomic start, environment and final event correctness (G1/G5/G7) | S1/S2/S5 | Concurrency, environment probe, EOF/live-process cases |
| Sensitive output and spawn errors (G8) | S2/S3/S5 | No raw automatic persistence/trace; explicit export path |
| Runtime hashes and architecture identity (G9/G10) | S6 | Bad/missing hash and same-version architecture switch |
| Browser offer without automatic opening | S5/S7 | Validated user action and opener failure |
| Project switch/quit/crash integration (G12) | S4/S7 | Every transition route; owner death without UI |
| Cross-platform regression evidence (G11) | S8 | Target-specific installed-artifact ledger |

## 5. Completion record

- Documentation: accepted decisions, detailed brief and this plan created
  2026-09-16; no implementation PRs or code tests are claimed by this entry.
- Upstream dependencies: Tauri-level glib/rand disposition is recorded in
  brief section 11.3. It does not close new advisories or establish a
  universally clean dependency graph.
- S1-S8: pending. Fill in delivery/evidence as each slice is actually
  completed; retain history and failed/unverified checks.
