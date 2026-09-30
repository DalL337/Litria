# ADR-033: Contract Schemas — Rust Types as the Single Source

## Status

Accepted (2026-09-30 — owner ruling after the S0 spike, PR #84. Adoption starts with the Project API contract and build plan under ADR-031, scheduled separately. The ruling on the three forced lockfile bumps (Consequences) is still open.)

S0 run (2026-09-30 — every §9 acceptance check passed, and all twelve planted mistakes failed a test (brief §11, S0 record). One new cost surfaced: the validator dev-dependency raises three shipped transitive crates through the shared lockfile (see Consequences). Status stays Proposed until the owner rules on acceptance and on those bumps.)

Revised (2026-09-29 — peer review by Codex, each point re-verified before adoption. Changes: directional inbound/outbound schemas; three-layer enforcement tested as a whole-boundary verdict; the committed schema named as the contract, with fixtures as sampled evidence; complete-file-set drift check with CI path coverage; wire versions separated from `engines.litria`; reader-side compatibility rules; typed catalog registration (new decision 7); explicit legacy translation; corrected alternatives. Decisions renumbered; the spike is now decision 9.)

Proposed (2026-09-29 — drafted at owner direction after reviewing an externally drafted API/Forge brief; the owner ruled that the contract schema's source of truth gets its own ADR. Acceptance is conditional on the S0 spike; see decision 9.)

## Date

2026-09-29

## Context

Three designs need typed contracts that cross the Rust boundary:

- **ADR-031's Project API and its MCP adapter** need a JSON Schema for every tool, validated inputs, and structured results that conform to their declared output schema.
- **ADR-029's Run build plan, slice S1,** needs a typed Rust schema with shared serialization fixtures for the frontend.
- **The extension sandbox design (draft)** commits to defining its interface once and generating everything from it, but leaves the interface language open (its open question 4).

None of the three says where its schemas come from. The repository has no schema or type-generation tooling. The frontend is plain JavaScript with no type checking, so a generated TypeScript file would gate nothing.

The enforcing side is already settled:
- the canonical agent brief places request validation and authorization in a Rust-owned boundary;
- ADR-032 decision 1 made Rust the authority for workspace identity;
- ADR-029 validates run schemas once at the Rust boundary.

MCP revision 2026-07-28 adds four external constraints. Implementations must support JSON Schema 2020-12. They must not automatically dereference network `$ref` values. Servers must validate every tool input. Structured results must conform to any declared output schema.

The [contract schemas brief](../plans/contracts/brief-contract-schemas.md) is the **canonical detailed design**. It holds the repository baseline, the evaluated options and their evidence, the conventions, and the S0 spike.

## Decision

### 1. Rust contract types are the source of truth

Every new contract that crosses the Rust boundary is defined authoritatively as a Rust type. This covers:
- Project API requests, results and outcomes;
- the Rust ↔ JavaScript bridge to live owners;
- Run schemas;
- extension broker operations.

Contract types are dedicated boundary types, not internal state or database rows with a derive added.

The boundary is already Rust-owned. Defining its contracts there needs fewer tools and less mapping machinery than authoring them elsewhere and generating Rust.

### 2. JSON Schema 2020-12 is the canonical derived artifact, and it is directional

Each contract family's schemas are generated from its contract types by schemars, with the 2020-12 dialect pinned explicitly. They are self-contained (local `$defs` only), committed to the repository, and embedded by the running application, which never regenerates them.

Schemas are generated per direction:
- An **inbound** schema describes what Rust accepts, using schemars' deserialize contract.
- An **outbound** schema describes what Rust emits, using `for_serialize()`.

Where the two differ for one type (defaulted and omitted fields, for example), both artifacts exist; the Rust type stays the single definition. Each family also exports an operation catalog.

Every other artifact derives from these committed files, never from a second path out of Rust or by hand. That includes MCP tool schemas, extension shims and declarations, schemas for user-facing files, documentation, and any TypeScript declarations.

### 3. The schema describes; the Rust boundary enforces

Enforcement happens in three layers:
1. an operational byte budget on the raw request, applied before an arbitrarily large payload is parsed;
2. typed deserialization, which rejects unknown input fields;
3. explicit validation of every constraint the schema declares, plus the operational limits JSON Schema cannot express.

A runtime JSON Schema validator is not the enforcement mechanism. Tests prove that the complete boundary's accept or reject verdict matches the inbound schema's verdict.

### 4. The committed schema is the contract; fixtures are the evidence

Golden fixtures are committed beside the schemas: valid, invalid and edge-case requests, results and errors. They sample the contract rather than define it. Rust tests check the boundary verdict and outbound conformance against them.

JavaScript tests run the real adapter code against them, with the transport or owner mocked, so a JavaScript-side field or identifier mistake fails a test. Conformance on the JavaScript side does not depend on adopting a type checker.

### 5. Drift fails the build

Regenerating the schemas must reproduce the complete committed file set exactly; missing, stale or extra files fail. The check runs in `cargo test`.

Rust CI is filtered by path, so the first change that introduces contract artifacts also adds their artifact, fixture and generator paths to that filter. A contract change is therefore always a visible, checked diff in review.

### 6. Wire conventions serve JavaScript and MCP

These apply to every contract family:
- camelCase fields;
- `kind`-tagged unions;
- unknown input fields rejected;
- declared constraints enforced.

No integer that can exceed 2^53−1 crosses into JavaScript as a JSON number; identifiers, revisions, epochs and cursors are opaque strings.

Each family carries its own wire-contract version. The extension manifest's `engines.litria` is an application-compatibility range, not a wire version.

Compatibility is defined by reader rules: inputs are read strictly and outputs tolerantly. An added output field is compatible only because readers ignore unknown fields. An unfamiliar union variant must surface as unknown, never as a known outcome. The brief owns the detailed conventions.

### 7. Operations are registered through the catalog

Handlers are bound to catalog entries by typed registration. A catalog entry without a handler, a handler without an entry, or a mismatched request or result type fails at compile time or in a test.

Dispatch stays hand-written, but operation names, types and capability metadata cannot drift apart.

### 8. New contracts adopt it; existing commands are not retrofitted

Existing Tauri commands are not migrated wholesale. A command may adopt the pipeline when its contract changes for another reason.

Until then, a new boundary adapter that calls an existing command translates the legacy representation and its `CommandError` explicitly into contract types; it never passes a legacy shape through.

MCP's protocol envelope, the SQLite schema and LSP messages remain owned by their specifications and migrations. Transport shaping over the same types is adapter work, for example MCP's `isError` results and JSON-RPC error codes outside the reserved range.

### 9. Accepted on the spike, not on this document

The S0 spike (brief §9) must show that the pipeline catches mistakes in four places: the Rust types, the committed artifacts, catalog registration and JavaScript handling. Specifically, it must demonstrate:

- **On two Project API read operations and one outcome union:**
  - self-contained 2020-12 inbound and outbound artifacts that honour the serde attributes the conventions use;
  - boundary verdicts equal to schema verdicts across the fixture set, including non-ASCII length cases;
  - outbound conformance.
- **A drift check** over the complete file set, with CI path coverage.
- **Failing catalog-registration cases.**
- **JavaScript tests** that fail on a deliberate adapter mistake.
- **A minimal MCP adapter proof:** published schemas byte-identical to the committed artifacts, local references resolving, and conforming success and error results.
- **Dependency evidence** recorded under the dependency-change and security policies.

A successful regeneration alone is not acceptance. If schemars cannot faithfully represent a shape a contract needs, this decision is reopened; the conventions do not bend silently to fit the tool.

## Consequences

### Positive

- One definition serves the enforcing boundary and every consumer. What MCP advertises is exactly what Rust accepts, and what Rust emits is described separately and checked.
- The JavaScript side gains tests of real adapter code without a new JavaScript dependency or a TypeScript migration.
- The Project API contract and Run S1 share one set of tooling instead of inventing two. The extension sandbox's interface-language question gets a concrete answer if that work resumes.
- Drift in types, artifacts or catalog registration becomes a failing test.

### Costs and limits

- Boundary types duplicate parts of internal types, and mapping and legacy-translation code is required. This is deliberate.
- Directional artifacts can double the committed files for types used both ways.
- schemars 1.x becomes a direct dependency, at least for development, alongside the 0.8 line that Tauri already uses at build time. Two major versions sit in the graph.
- Dev-dependencies share the one `Cargo.lock` with the shipped build. S0 found that the fixture validator's minimum versions raise shipped transitive crates (`regex-automata`, `regex-syntax`, `zmij`; brief §11). Each such bump needs a decision.
- Committed generated artifacts add diff volume to reviews.
- The CI path filter must track the artifact locations; a location added without its path entry escapes the drift check.
- A declared constraint can still be mis-enforced, for example by counting bytes where JSON Schema counts characters. Only boundary-verdict tests keep them aligned.
- Fixtures are sampled evidence: JavaScript gets no compile-time checking, and fixture coverage is a discipline, not a guarantee.
- Serde shapes that schemars cannot represent faithfully are excluded from contract types by convention. `flatten` on inputs, for example, is excluded because serde does not support it with `deny_unknown_fields`.

## Alternatives Considered

1. **ts-rs (Rust → TypeScript).** Rejected. It produces TypeScript only, so MCP would still need JSON Schema from a second derivation, and the frontend is not type-checked.
2. **specta / tauri-specta (Rust → multiple exporters).** Not chosen for S0, but a credible Rust-first alternative. It exports TypeScript and Swift (stable) and JSON Schema for Draft 7, 2019-09 and 2020-12 (marked partial), among others, and tauri-specta adds typed command bindings. Its JSON Schema exporter is partial and its 2.x line is still a release candidate (2.0.0-rc.25, 2026-05). schemars is stable, already in the graph and used by the official Rust MCP SDK. It is the first option re-examined if S0 reopens this decision. Typed `invoke` bindings for existing commands remain a separate, open question.
3. **Hand-authored JSON Schema, optionally generating Rust with typify.** Viable, and generating Rust from a definition would not weaken Rust's enforcement. Not preferred because the boundary is already Rust-owned. It adds a source format, a generator, and mapping between generated and hand-written types, without a capability the Rust-first path lacks.
4. **TypeSpec as the source language.** Viable on the same terms as alternative 3. Not preferred: it adds a Node-hosted source language and a Rust-generation step around a boundary Rust already owns.
5. **WIT, the extension sandbox draft's candidate.** Rejected for the contract layer. WIT is the WebAssembly Component Model's interface language, and none of Litria's contract hosts is a Wasm component.
6. **OpenAPI with Forge/Fern generation.** Not adopted; deferred until a public HTTP API is planned, per the 2026-09-29 review. ADR-031 has none, and Litria's transports are not HTTP.
7. **Hand-written serde structs plus fixtures only (Run S1's current wording).** Insufficient once MCP needs JSON Schema. It survives as the fixture half of this decision.
8. **Runtime JSON Schema validation as enforcement.** Rejected. It duplicates typed deserialization, adds a runtime dependency, and places enforcement in a descriptive artifact.

## Scope Notes

This ADR adds no code, domain, guard or dependency. The [Domain Register](../Orchestration.md#2-domain-register) is unaffected.

[ADR-031](../plans/agent-integration/031-agent-integration-and-lifecycle.md) and its [canonical brief](../plans/agent-integration/brief-agent-integration.md) keep ownership of Project API semantics: operations, outcomes, authorization and limits. This ADR decides only how those contracts are written down and checked.

[ADR-029](029-managed-project-runs.md)'s build plan S1 would adopt this pipeline for its schema. The [extension sandbox design](../plans/ideas/extension-sandbox-design.md)'s open question 4 would be answered at the contract layer, while its open question 6 (`engines.litria` semantics) stays with that design. Supersession notes in those documents are added on acceptance, not before.

Numbering note: 031 is held by the agent-integration decision, which by owner direction lives under `docs/plans/agent-integration/`.

## Implementation Follow-ups

1. Run the S0 spike (brief §9), then accept or reopen this decision.
2. On acceptance, add dated notes to Run build plan S1 and to the extension sandbox design's open question 4. Then write the Project API contract and build plan under ADR-031 against this pipeline.
3. Resolve the brief's open questions (§10) in S0 or in the first consumer's plan.
