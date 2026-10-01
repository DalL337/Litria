# Test-Authoring Policy

Scoped agent-governance procedure (AGENTS.md §1/§2). Rules accumulate here as
lessons are learned; each records its provenance.

## Rule 1 — Test the Producer of a Signal, Not Only Its Consumers

(Added 2026-09-30, Project API build plan P2, PR #89. The owner bridge's
tests passed a hand-made "hydrated" signal and proved the bridge used it
correctly. The signal itself was wrong for an empty project, and the bridge
served another project's text; a peer reviewer found it by running the real
hook. See the adversarial check policy, learned flaw 8.)

When code acts on a signal another module produces — readiness, "loaded",
"current", an epoch, a permission — a test that injects the signal tests the
consumer only. The signal's producer needs its own test through the real
code, driven through the sequences that can make it lie: switches, empty
inputs, cancelled async work, re-renders between steps.

React hooks and providers can run under `node --test`: register
`test/support/jsx-hooks.mjs` for `.jsx` sources and render with `happy-dom`
(`workspaceEpochFence.test.mjs` and `projectHydrationIsolation.test.mjs` are
the models). Keep any object a hook's effects depend on stable across
renders, as the shell does, or the harness loops.
