# Dependency Change Policy

Scoped agent-governance procedure (AGENTS.md §1/§2). Load before changing
dependencies, external tool versions or arguments, generated-project recipes,
or the combinations the product claims to support.

Added 2026-09-16 from the New Project wizard investigation. Exact scaffold
CLI pins existed and focused tests passed, but the recipes still combined
incompatible Vite/plugin majors, passed invalid template and add-on flags,
used npm syntax for Yarn, and omitted configuration needed to use installed
packages. This policy addresses compatibility evidence; it does not mark
those implementation findings resolved.

## Rule 1 — Define the Supported Recipe

A supported combination is a complete recipe, not a set of package names.
Before adding or changing one, identify the relevant dimensions:

- Runtime/wrapper, framework or archetype, and language.
- Template/create CLI and any add-on CLIs, including their actual arguments.
- Package manager, supported manager versions, and runtime/interpreter
  requirements.
- Add-ons, prerequisite order, and required build/runtime configuration.
- OS-dependent paths, executable resolution, and native requirements.
- Generated files and the behavior the user is promised after creation.

Use the owning domain's registry and execution plan as the source of truth.
Record affected combinations and verification coverage in the related
plan/PR; do not introduce another independently maintained version or support
list in prose. Pin registries identify tools, while compatibility rules
identify which tools and outputs work together. Neither substitutes for the
other.

This applies to dependencies of generated projects as well as Litria's own
manifests and lockfiles. A recipe change includes changing CLI flags, a
template, package-manager support, interpreter eligibility, or a support
claim even when no package version changes in this repository.

## Rule 2 — Verify the Exact Tools and Dependency Requirements

Use primary sources for the versions the recipe will actually execute:
published package metadata/source, versioned official documentation, or the
installed tool's help output. Current documentation for a different version
is not sufficient evidence for a pinned CLI's arguments.

Check the parts relevant to the change:

- Template identifiers, supported flags, and noninteractive behavior.
- Engine requirements and peer dependencies of the generated template,
  framework, plugins, and add-ons, including transitive requirements that
  constrain the combination.
- Manager-specific commands and version differences; the label “Yarn” or
  “pnpm” alone does not establish CLI compatibility.
- Agreement between discovery/selection and execution validation: every
  offered interpreter or tool variant must be usable by its selected recipe.

Do not suppress a peer conflict, ignore an engine requirement, or widen a
declared support range merely to make installation pass. Select a compatible
combination or narrow the supported choice, and record the reason.

[Security Policy](security-policy.md) remains authoritative for trust,
provenance, pinning, release age, downloads, and execution consent. A clean
vulnerability scan establishes no compatibility guarantee, and a successful
build establishes no security guarantee.

## Rule 3 — Integrate What the Choice Promises

Adding dependencies is complete only when the advertised behavior is wired
up. A framework recipe may need a renderer entry point and plugin config;
CSS tooling may need a build plugin and stylesheet import; a backend choice
may need server files and a start command; a test add-on may need test files.
If the intended feature only declares or installs packages, say that in its
description and acceptance criteria.

Prerequisites must be ordered by their dependencies, independently of the
order in which the user selects them. Required configuration must exist before
a dependent initializer runs. Preview, validation, and execution must agree
on the selected recipe, generated files, resolved engine, and operation order.
Prefer one validated plan; when implementations cross language boundaries,
verify their contract with shared cases rather than independent assumptions.

## Rule 4 — Exercise Affected Recipes

Before adding, expanding, or changing a support claim, validate the affected
recipes in disposable fixtures under the applicable security rules:

1. Execute the real scaffold command/blueprint with the recorded tool and
   manager versions. Check both its exit/result and whether expected files
   were actually generated.
2. Resolve/install dependencies as the supported workflow permits. Inspect
   peer/engine diagnostics and record the resolved versions or lockfile
   identity; do not silently bypass compatibility failures.
3. Check the promised output: configuration, imports, entry points, add-on
   files, and scripts. Build or run an appropriate smoke check of the
   generated project, not just Litria's own production build.
4. Exercise relevant failure and boundary cases: unsupported tool versions,
   noninteractive invocation, prerequisite order, and OS/path behavior when
   the change affects those boundaries.

Offline and files-only recipes must be verified without enabling downloads
or installs. If running the generated project requires a later user-consent
step, record creation-stage verification and consented runnable-stage
verification separately. Do not relax the execution policy to obtain a pass.

Cover each affected distinct execution path. Equivalent combinations may
share a representative check only with a stated equivalence rationale and
coverage map. Different manager commands, templates, native platforms, or
interpreter validators are distinct paths. Unavailable environments are
reported as unverified, with the remaining check named; they are never
reported as passed.

Keep reusable checks automated where practical. Unit tests of command
builders and source-text checks are supporting evidence; neither replaces
execution evidence for a supported recipe. The standard checks in
[Verification Policy](verification-policy.md) still apply to code changes.

## Rule 5 — Revalidate Moving Dependencies

Pinning a create CLI does not freeze the framework ranges in its templates,
unversioned post-install packages, registry content, or globally installed
tools. Identify these moving inputs when claiming support.

For each recipe with moving inputs, record its owning domain/maintainer,
last verified date and resolution, and revalidation triggers in the owning
plan or support evidence. Triggers must include changes to its template,
CLI, manager/runtime support, dependency constraints, and relevant upstream
compatibility changes. Before a release, refresh evidence for advertised
recipes that resolve moving inputs against the versions they now receive.

If upstream resolution breaks a recipe, constrain it to a verified
combination or visibly restrict the affected support claim until fixed.
Do not continue to cite an older passing run as evidence for a different
resolution. Retain the failing case as a regression check when practical.

## Rule 6 — Record Evidence and Bound the Claim

The related plan/PR must record:

- Recipe/combination tested, date, platform, runtime, and manager versions.
- Actual commands/arguments and resolved dependency versions or lockfile
  identity, with secrets and machine-specific identities omitted.
- Expected generated behavior, observed result, and the relevant test/build
  output or reproducible check.
- Combinations not exercised, the reason, and the remaining verification.

Successful scaffolding alone does not establish that an integration works.
A default npm path does not establish other managers or platforms. Claims
must stay within the evidence; an unavailable test does not justify silently
expanding support. Existing known gaps remain open until the corresponding
recipe and verification are repaired.
