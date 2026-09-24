# ADR-031: Existing Agent Runtimes, Project API Access, and Foreground Execution

## Status

Accepted (2026-09-19 — owner requested finalization of the discussed design as a brief and ADR, including reusable connections and background execution off by default).

Acceptance fixes the product and architecture direction. Runtime selection, compatibility evidence and the implementation prerequisites remain outstanding; this records no shipped functionality.

## Date

2026-09-19

## Context

Litria users should be able to add an agent after starting a project, connect a frontier provider or a local model through a compatible runtime, and work with the project's graph, source and editor state. They should keep a valid login across projects and retain useful conversation history after closing the application.

The initial proposals combined this experience with broader work: universal provider authentication, possible ownership of an agent reasoning loop, and an exclusively API-mediated project access mode. Comparison with existing IDE integrations established a smaller viable direction: reuse an agent runtime and add Litria's project-specific capabilities.

The owner also explicitly rejected ongoing token consumption after closing Litria as the default. Persisting connection/history must not imply persistent execution.

The [agent integration brief](brief-agent-integration.md) is the **canonical detailed design**, including boundaries, connection flow, security trade-offs, lifecycle behavior and implementation gates. Earlier [MCP research](../ideas/brief-mcp-integration.md) and the [Project API proposal](../ideas/brief-project-api-mcp.md) remain historical evidence; this decision supersedes their conflicting delivery and ownership recommendations.

## Decision

### 1. Reuse an existing agent runtime

The initial integration uses a qualified existing runtime for inference, its tool loop and supported model-provider connections. Litria does not build its own agent engine or a universal OAuth broker as prerequisites.

Support for frontier/cloud models and users' local models remains a product requirement. Qualify a limited, explicit set of runtime/model/platform combinations before advertising support. Prefer one runtime covering both routes; add adapters when justified. A local model endpoint alone is not an agent runtime.

### 2. Separate session control from project tools

Use Agent Client Protocol where it fits the chosen runtime, or a supported provider-specific interface behind an adapter, for conversation, activity, permission requests and cancellation.

Expose Litria project capabilities through MCP backed by a provider-independent typed Project API. The API is initially an application service, not a public REST service. Existing graph, editor, syntax, save and filesystem owners retain their responsibilities. No direct SQL or database mutation interface is exposed to agents.

### 3. Persist connections at user scope and work at project scope

Connection profiles and valid authentication are reusable across projects. Conversations, context and resource/action grants are associated with their projects. Changing projects does not log the user out, grant access to another project automatically, or start a task.

Authentication remains with the selected runtime when it owns the credential lifecycle. Litria uses supported login/status interfaces and reuses an explicitly selected profile. Litria-owned secrets use secure native storage. Browser login is preferred where supported, with honest key/endpoint alternatives; it is not promised for every provider.

Connection reuse across compatible IDEs is allowed through supported runtime profiles. Universal credential or conversation portability is not promised. Session restoration depends on negotiated capabilities and must be represented honestly.

### 4. Default to foreground, explicitly initiated work

Closing the Litria session window or application cancels Litria's active agent work and terminates agent processes it owns. The initial project-switching flow also stops outgoing project work before detachment. Preserve valid login, conversation history and recorded outcomes.

Startup, reopening, reconnecting and restoring a session must leave the agent idle. Continuing interrupted work requires an explicit user action. Non-generative status checks must not start paid generation or project execution.

Qualify orderly cancellation and crash/parent-death cleanup. Never terminate an unrelated agent session or shared model server. Already-submitted remote inference may have provider-specific cancellation/billing limits; do not claim unconfirmed cancellation or zero further charges for in-flight work.

Background continuation, scheduling and autonomous work across app closure are deferred advanced capabilities. If later introduced, they require explicit opt-in and remain off by default.

### 5. Permit qualified native tools without overstating MCP control

Runtime-native filesystem tools may coexist with Litria MCP tools. Their permissions are enforced by the runtime; Litria reconciles their external effects. They do not inherit the Project API's edit approval, conditional persistence, receipt or undo guarantees.

Litria-mediated mutations continue through existing editor/save/FSM owners. Native writes require a tested synchronization and dirty-buffer conflict strategy. Command execution and implicit hooks remain separately gated by the existing security and visible execution policies.

MCP grants, working directories and Git worktrees are not OS sandboxes. A connection-wide permission label must describe both native and MCP paths truthfully. Internal database exclusion from MCP does not prove that a broadly privileged native agent cannot read its files. Stronger containment is a separately qualified mode, not a universal launch requirement or claim.

### 6. Preserve authorization and data-integrity requirements

Every Project API call is bound to an authenticated connection and a server-selected workspace identity/epoch. Apply resource policy to all returned and derived data. Project switching, cancellation and revocation fence stale requests.

Mediated edits require current revisions, concrete authorization, application through the owning services, and truthful per-effect outcomes. Make retry behavior idempotent and reconcile uncertain results before further mutation. Do not equate buffer application with durable save or promise an atomic transaction across files, editor state and SQLite.

The earlier integrity findings remain implementation gates. Runtime reuse reduces the new agent infrastructure required; it does not waive those gates.

### 7. Keep onboarding small and capability claims tested

Support adding an agent to an existing project through one guided connection flow. Detect existing supported installations/logins, automatically configure Litria's project connection, and keep protocol configuration out of ordinary onboarding. Setup does not automatically analyze the project or begin a model turn.

Installs remain explicit and follow the repository's artifact trust policy. A small tested catalog is preferred to arbitrary commands or a broad marketplace. Unavailable features remain unavailable rather than silently falling back to broader permissions or another provider.

## Consequences

### Positive

- The initial implementation concentrates on Litria's graph/editor value while reusing mature agent and authentication machinery.
- Users can add assistance at any point, retain login across projects, and return to saved work without starting new paid activity.
- Local and cloud models share the project contract without requiring identical provider internals.
- Native-tool and MCP guarantees remain distinguishable and reviewable.

### Costs and limits

- Runtime adapters, installation/version policy and real compatibility testing remain ongoing responsibilities.
- Native writes require conflict handling and graph/editor reconciliation; MCP alone cannot enforce their scope.
- Provider-specific authentication, session resumption and cancellation limit uniform behavior.
- Secure, truthful writes and cancellation on failure still require backend/editor work before release.
- A narrower first release will not support arbitrary agents, every model, unattended tasks or universal cross-IDE conversation transfer.

## Alternatives Considered

1. **Build a Litria-owned universal agent engine first:** deferred. Adds provider integration, tool-loop and lifecycle work before the requested experience is proven.
2. **Require every project operation to pass through MCP:** not the default. Stronger control can be valuable, but requires qualified runtime restrictions and is not necessary for ordinary IDE-style integration.
3. **Give agents a direct database interface:** rejected. Bypasses live state, ownership, authorization and integrity rules.
4. **Require login for every project:** rejected. Account identity and project authorization have different lifetimes.
5. **Keep agent work running after Litria closes:** rejected as default by owner direction. Optional future behavior needs a separate explicit advanced design.
6. **Ship only an external-client MCP connector:** retained as a possible later integration, but insufficient as the primary in-app conversation experience.

## Scope Notes

Both documents live under `docs/plans/agent-integration/` at the owner's explicit request, instead of the usual ADR home. ADR-031 retains the repository-wide decision number.

This decision creates no implementation modules, changes no existing domain imports or guards, and selects no vendor, SDK version or OS support matrix. The Domain Register remains authoritative; any new domain and guard coverage must be settled before code is introduced.

## Implementation Follow-ups

Qualify the initial runtime and cloud/local routes; define module placement and shared contracts; prove login reuse and foreground cancellation; resolve the write and native-reconciliation gates; then produce a build plan with actual platform evidence. The [brief's implementation gates](brief-agent-integration.md#10-implementation-gates-and-unresolved-choices) own the detailed requirements.
