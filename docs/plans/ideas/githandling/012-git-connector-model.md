# ADR-012: Litria Connects to Standing Git Servers — Connector Only

## Status
- Proposed

## Date
- 2026-03-30

## Context
Litria needs to support team collaboration and project sync. The question arose whether Litria should be capable of spinning up its own Git server or sync service for LAN or local network scenarios.

## Decision
Litria will not host, manage, or spin up any Git infrastructure. Litria is a connector only. It reads from and writes to a Git server that already exists and is managed externally — whether cloud-hosted (GitHub, GitLab, Codeberg, Bitbucket), self-hosted on a LAN (Gitea, Forgejo), or any other Git-compatible endpoint.

## Consequences

Positive:
- Litria remains lightweight, focused, and aligned with its local-first philosophy
- Compatible with any Git-compatible backend without modification
- Organizations apply their own security, compliance, and access policies — Litria is not involved
- No open ports, no server infrastructure, no hosting liability

Costs:
- Teams must provision and maintain their own Git server before using Litria's collaboration features
- Litria's Git feature surface is limited to what a remote Git server exposes via standard Git protocol
- Litria is not responsible for uptime, access control, or data integrity of the remote server

## Alternatives Considered
- Litria hosts its own sync server: Rejected — introduces infrastructure scope, security liability, and operational complexity outside Litria's product mission. A connector model is cleaner and more flexible.

## Scope Notes
- This ADR covers Litria's relationship to Git infrastructure only
- This ADR does not define the authentication or credential model (see ADR-016)
- This ADR does not specify which Git operations Litria supports (see PRD-GIT-001)

## References
- PRD-GIT-001: Git Integration & Team Collaboration
- RFC: `docs/ideas/githandling/git-integration-rfc.md`
