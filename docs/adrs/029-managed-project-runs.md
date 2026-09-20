# ADR-029: Managed project runs with explicit choice and cross-platform ownership

## Status

Accepted (2026-09-16 - owner accepted the final recommendations for target
discovery, selected environment files, local-first configurations with
explicit sharing, and cleanup after an unexpected Litria crash; prior
discussion settled the Run UI, review, save, switch and browser behavior).
Implementation has not started. Acceptance records the design, not shipped
capability or completed platform verification.

## Date

2026-09-16

## Context

Litria users currently start their applications through the interactive
terminal. A project-level Run action needs to own a known application
process, output and cleanup without replacing that terminal session.

The owner established choice as the governing product principle. The
common path should become one click after the user has seen what will run,
while target, runtime, command and save behavior remain editable.

Litria already compiles and runs on Windows, macOS and Linux, confirmed by
the owner. This feature must preserve that baseline. The Rust review at
commit `9023c5d78604e5a61933b49a7630363aa5b8c85c` found most necessary
dependencies present, but shell-specific teardown, incomplete process-tree
ownership and environment handling cannot be copied into an application
runner unchanged. Existing `glib` and transitive `rand` advisories belong
to the upstream Tauri dependency chain; this decision does not require
forced direct upgrades or make them new Run blockers.

The [Run Application brief](../plans/ideas/brief-run-application.md) is the
canonical detailed design, including evidence, contracts and boundaries.
The [build plan](../plans/run-application/run-application-build-plan.md)
owns delivery sequencing and verification.

## Decision

### 1. Run targets the current project's application

V1 runs one selected application or development-server target for the
active project. It does not implicitly run the active editor file.

Discovery covers the project types Litria scaffolds, using the owning
recipe registry's run metadata where available. Existing projects use
recognized manifest/script targets. Ambiguity presents a compact chooser;
custom executable-and-argument targets remain available. A project with no
runnable entry point receives an explanation and configuration action.
Discovery never executes project code to decide what to offer.

Configuration is shaped for later composition, but compound execution,
debugging, remote execution and background runs across project switches
are outside v1.

### 2. Approval belongs to the resolved launch definition

The first run of an unfamiliar target shows the resolved command, relevant
script contents, working directory and source, with Run and Edit actions.
Subsequent launches are one click until execution-affecting inputs change.
The chooser also serves as review when multiple targets exist.

Approvals are local to the user/install, project and target. Rust owns
resolution and revalidation; the frontend cannot submit an arbitrary
command with a boolean asserting that it was approved. Changes from an
editor, agent or Git update invalidate the applicable approval.

Litria-created targets may omit the first review only when a local
creation receipt matches the resolved launch definition. A repository
field, copied configuration or recipe identifier cannot grant trust.
Approving a launch does not certify the project or its dependencies safe.

### 3. Run preserves explicit save and navigation choices

Dirty files offer Save All and Run, Run Saved Files, and Cancel. The saved
files option preserves dirty buffers. An optional remembered project
preference is explicit and reversible. Failed or cancelled saves abort
the launch.

Restart completes save/target/review choices before stopping the existing
run. Cancellation leaves that run intact; saving may still activate the
application's own file watchers. The replacement starts only after the
old run has been cleaned up successfully and the plan revalidated.

Switching projects with an active run offers Stop and Switch or Stay.
Quit stops owned runs after the existing unsaved-work decision allows
exit. All project replacement/close routes use the same transition gate.

### 4. Run has its own UI and lifecycle owner

The project bar exposes Run, target selection, Stop and Restart. A
dedicated Run tab in the existing drawer displays output and status.
Hiding it never stops the application or blocks output draining.

An accepted, initially unimplemented `RunDomain` owns frontend run
orchestration through injected adapters. The Rust run service is the
authority for process state, launch approval and cleanup. It has a
separate registry from interactive terminal sessions. App remains a
composition shell, and all new domain paths receive guard coverage before
implementation is exposed.

Readiness and liveness are distinct. A printed URL is a candidate to open,
not proof that the server is ready. Healthy long-running applications have
no arbitrary total or idle lifetime limit.

### 5. Process ownership is established before execution

All supported platforms provide the same visible lifecycle through native
adapters. Windows uses ConPTY and required job ownership established
before project code can run. macOS/Linux use native PTYs and owned Unix
process groups, with an independent supervisor for unexpected owner death.

Stop follows the architecture's ordered, bounded cleanup contract:
request interruption, drain output, wait, escalate, reap and finish worker
cleanup. Failure remains observable. Restart cannot overlap a run whose
cleanup is unresolved. No cleanup searches by process name or port.

V1 includes cleanup after an unexpected Litria process crash. The Unix
supervisor must detect loss of its owner without relying on the frontend
event loop; Windows job handles must not leak into children. Both require
native failure fixtures. The guarantee covers the managed foreground
process group/job, not arbitrary daemonized processes that escape it,
privilege changes, a killed supervisor, OS failure or a security sandbox.

### 6. Environment files are explicit and secrets stay out of configuration

Users may select environment files. Litria parses them as data into a
per-child environment with explicit, documented precedence. It does not
source them as shell code or mutate its own process environment.

Run configurations contain references to environment files or explicitly
forwarded variable names, never stored secret values. Raw environment
values remain in Rust execution memory and are excluded from frontend
events, saved logs and automatic traces. Framework-owned environment
loading remains visible as a separate source of behavior.

V1 has no built-in credential vault. Raw process output is sensitive:
bounded in-memory viewing is the default, export is explicit, and no
redaction claim promises that arbitrary child output is secret-free.

### 7. Configuration is local by default and sharing is explicit

The default run configuration is saved in local application storage. An
explicit Share with Project action writes a versioned, portable project
configuration through the filesystem write owner. It does not commit,
stage, include environment-file contents or publish anything.

The project file records intent and optional platform overrides. Local
settings own selected tools, absolute machine paths and preferences.
Approvals and creation receipts remain local even when configuration is
shared. Unsupported schema versions or missing referenced files fail
visibly rather than silently falling back to another command.

### 8. Setup and browser actions require user intent

Run does not silently download runtimes, install dependencies or activate
an arbitrary login shell to repair PATH. Missing prerequisites lead to
visible selection/setup guidance under the existing execution policies.

Detected HTTP(S) URLs offer an Open action. There is no automatic browser
launch by default and no generic frontend open-anything capability.

### 9. Cross-platform behavior is part of completion

Native build, installed-application and process-lifecycle evidence is
required for the existing supported release targets. Dependency
resolution, cross-compilation and host-architecture tests are recorded
separately from target execution.

Unix signal support, an environment-file parser and Rust UUID generation
receive explicit dependency review when adopted. Existing Windows APIs
stay target-gated. The bundled runtime's integrity and architecture must
match the target. No platform or package support expansion is implied by
this ADR; in particular Linux ARM64 remains a separate expansion from the
current release matrix.

## Consequences

Positive:

- Common runs become one click while users retain control over execution.
- Review and actual launch share a single Rust-resolved plan.
- Output visibility, interactive terminals and application lifetime have
  independent ownership.
- Shared configurations remain useful across machines without carrying
  local approvals or secret values.
- Windows, macOS and Linux are implemented and tested within the same arc.

Costs:

- Native supervision, especially Unix owner-death cleanup, requires real
  process fixtures and packaged helper/entry-point verification.
- Configuration, approval and event schemas need explicit migrations and
  bounded input handling.
- Runtime resolution and command adapters need platform-specific evidence;
  supported crate names alone are insufficient.
- Existing launch infrastructure needs selective hardening before reuse.

## Alternatives Considered

- **Type a command into the existing terminal:** rejected because session
  replacement, shell state and shell teardown cannot define managed runs.
- **Always show a setup screen:** rejected in favor of compact review and
  a saved target.
- **Silently trust a freshly opened repository:** rejected; unfamiliar and
  changed launch definitions require review.
- **Automatically save or choose a runtime:** rejected; explicit user
  choice is the accepted product behavior.
- **Store all configuration and approvals in the repository:** rejected;
  portable intent and machine-local trust have different ownership.
- **Clean up only on normal quit:** rejected; the owner accepted crash
  cleanup for the managed run as part of v1.
- **Implement Windows first and defer Unix behavior:** rejected; existing
  macOS/Linux support must remain intact when Run ships.

## Scope Notes

This ADR authorizes the design, not a release claim. It does not implement
the feature, certify project code, resolve upstream Tauri advisories, or
change the separately owned scaffold recipe integrity arc (ADR-028).

Run consumes that arc's recipe metadata through an explicit integration
contract. It must not create a competing framework/version matrix or
declare unfinished scaffold integrations runnable.

## Implementation Follow-ups

Follow the [sliced build plan](../plans/run-application/run-application-build-plan.md).
The domain register records `RunDomain` as accepted and planned until the
implementation and guard coverage land together. No further product
ruling is outstanding for this design.
