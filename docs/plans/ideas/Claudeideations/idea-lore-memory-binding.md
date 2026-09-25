# Idea: LORE memory as a pointer, with the web as the "NAS"

> **Status:** Parked (2026-09-24). Design intent captured. Blocks the Litria backport discussion.

## Original intent (owner)

The memory module was always meant to be a **pointer**: the user declares where
memory lives. The shipped link web was supposed to be the **backup location**,
like a NAS for memory, not the one prescribed system. The first build drafted
it the other way around: the web is mandatory and authoritative, and vendor
memory is a secondary space (`policies/memory.md` §6).

## The shape

- **`memory.md` becomes the socket.** It states what memory is for and the rules
  every space must follow: links over restated detail, dated entries,
  provenance, no secrets.
- **Spaces plug in** through an adopt-time binding table (space · location ·
  who reads/writes · what it holds):
  - **User memory** follows the person across repos (account- or harness-owned).
  - **Agent/toolchain memory** is the platform's own memory (Claude Code, Codex, …).
  - **Repo memory** lives with the code and is shared by every agent.
- **The web ships as the NAS:** always available, repo-level, and tool-independent.
  It survives a harness swap, a wiped vendor memory, or a new machine.

## Hard constraint

Claims (`policies/orchestration.md`) only work in a space **every** agent can see
and write. Agent-private memory can't host them. Coordination therefore needs
the NAS (or another shared space) to be bound. With no shared space bound, the
repo is single-agent only.

## Open questions

1. **Mirror or fallback?** Is the NAS written *alongside* the primary on every
   update (mirror), or only used when the primary is unavailable (fallback)?
   A mirror means two copies that can disagree, and needs a rule for which
   copy wins.
2. **What must always land on the NAS**, regardless of the primary?
   Candidates: claims, and a hub entry pointing at the primary.
3. **Lint scope:** `memory-lint.mjs` checks the web's format only. Does it stay
   NAS-only, or do bound spaces get their own checks?
4. **Backport order:** settle this model in LORE first, then decide what Litria takes.
