# ADR-016: Authentication Delegated to Git Service

## Status
- Proposed

## Date
- 2026-03-30

## Context
Litria needs to authenticate with remote Git servers to perform fetch, pull, and push operations. The team considered two approaches: Litria manages credentials (storing tokens, handling refresh, managing expiration) or Litria delegates authentication entirely to the Git service.

The original design had Litria storing credentials in the user profile using platform-native secure storage. This creates ownership of token lifecycle — expiration, refresh, rotation — and makes Litria responsible for credential security across platforms.

## Decision
Litria acts as a login broker, not a credential manager. The user authenticates through their Git service's own flow. The service owns the auth. Litria holds the resulting session token in memory during the session and optionally delegates to the OS keychain for persistence across sessions. Litria does not store passwords.

**Per-service auth flows**:

| Service | Flow |
|---|---|
| GitHub | OAuth device flow — Litria opens browser, user authorizes, token returned |
| GitLab | OAuth or PAT — user generates token on service, pastes into Litria |
| Codeberg | PAT — user generates token on service, pastes into Litria |
| Self-hosted (Gitea, Forgejo, etc.) | Server URL + PAT — user provides endpoint and token |

The setup modal presents a service picker. Litria walks the user through the selected service's auth flow. Connection is established. The user is done.

## Consequences

Positive:
- Eliminates token expiration, refresh, and rotation as Litria's problem — the service handles it
- Reduces Litria's security surface — Litria never knows the user's password
- Aligns with ADR-012's connector-only philosophy — Litria connects, it doesn't manage
- Simpler implementation — no credential storage abstraction layer needed per platform
- Auth failure is the service's domain — Litria just shows "authentication failed, please re-authenticate"

Costs:
- Litria depends on each service's auth flow working correctly
- PAT-based services (self-hosted) still require the user to generate and paste a token manually
- If the OS keychain is unavailable, the user must re-authenticate each session
- Adding support for a new Git service requires implementing its specific auth flow

## Alternatives Considered
- Litria manages credentials in user profile with platform-native secure storage: Rejected — makes Litria responsible for token lifecycle, expiration handling, and cross-platform credential security. Adds complexity and liability that belongs with the service.
- SSH key authentication: Deferred for v1 — adds key management complexity. PAT and OAuth cover the primary use cases. Can be added in a future version.

## Scope Notes
- This ADR covers how Litria authenticates with remote Git servers
- This ADR does not cover what Litria does with the authenticated connection (see ADR-012, ADR-013)
- This ADR does not define the connection modal UI (see PRD-GIT-001 Section 5.1)

## References
- ADR-012: Litria Connects to Standing Git Servers — Connector Only
- PRD-GIT-001: Git Integration & Team Collaboration
- RFC: `docs/ideas/githandling/git-integration-rfc.md`
