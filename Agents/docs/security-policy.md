# Security Policy

Scoped agent-governance procedure (AGENTS.md §1/§2). Load for security-
relevant work: anything creating a new execution or network surface,
dependency changes, supply-chain features, or audit/review passes.
Codified 2026-07-13 from the repo's practiced method (ADR-005, ADR-021,
the npm post-mortem research) — the existing audits under
`docs/security-audits/` are the deliverable models and stay as-is.

## Rule 1 — When a Security Review Is Mandatory

- A change introduces a **new execution surface** (anything that downloads,
  installs, or runs third-party code) or a **new network surface**.
- A new Tauri command touches filesystem, process spawn, or network.
- Dependencies are added or materially upgraded (npm or Cargo).
- A release or visibility milestone approaches (public flip, external beta).
- External intel lands (a post-mortem, advisory, or incident relevant to a
  surface Litria has).
- Periodically: the living audit says "reviewed periodically and after
  significant changes" — a major arc touching any of the above re-triggers it.

## Rule 2 — Method

- **Classify before designing** (ADR-005 A1 generalized): who executes what,
  under whose trust? (1) verified artifact — pin version + SHA-256, verify
  before use, official distributors only; (2) reference data — cache, size-
  cap, treat as inert; (3) project-owned execution — never run it hidden;
  the visible terminal is the consent and audit trail; (4) system-owned
  toolchains — detect and hint, never install. Any "should Litria
  download/run Z?" question starts with the class.
- **Primary sources, adversarially verified**: the persistent research
  policy applies to all security investigation; claims that shape design get
  verified against primary sources before they're load-bearing (the gopls
  no-binaries finding and the detection≠removal lesson both came from this).
- **Standing trust rules**: no silent downloads, ever; pinned exact versions
  over `latest`; freshness risk gets an age gate; provenance is not a safety
  signal by itself (valid provenance appeared on compromised packages).
- **Name the residual risk in the same breath as the mitigation.** Every
  posture statement lists what is NOT covered. User-facing safety claims
  follow the forbidden-claims discipline and get test-enforced where
  possible (ADR-021 §5 and its posture-note test are the model).

## Rule 3 — Deliverables

- **`docs/security-audits/` is the home.** Two artifact kinds exist; match
  them, don't invent new shapes:
  - `security-audit.md` — the **living audit**: dated review ledger
    ("Last reviewed"), explicit scope line, checklist form (`[x]`/`[ ]`),
    dependency scan results with commit refs, a "Verified Strengths"
    section, and blocked-upstream items carrying their reason and what
    unblocks them. A review pass = a new dated entry + refreshed scans,
    never a rewrite of history.
  - Scoped audit/PRD documents (model: `OSS-security-prd.md`) — deep dives
    on one surface. If a premise dies, the document is **parked with a
    dated banner explaining why** (and what a revival must re-scope), never
    silently deleted.
- Security decisions that change behavior are **ADRs**, not audit entries
  (ADR-005, ADR-021 are the models); the audit records observed state, the
  ADR records the decision. Cross-link both ways.
- Findings mid-arc that don't block the arc get journaled and surfaced to
  the owner with severity honestly stated (the npm-dlx finding pattern:
  flagged in the PR that found it, fixed before the surface went live).

## Rule 4 — Chokepoint Exceptions Inherit Every Exemption (added 2026-07-28)

(Origin: the reserved-Windows-name arc. The rule was enforced at the
filesystem write manager — the single chokepoint all writes route through —
which felt airtight. But `useUntitledSaveAs` held a ratified exception to
the *manager*, and that silently made it an exception to the *new rule
too*: the native Save As dialog + raw write created `con.py` straight past
the guard. The owner caught it by asking the right question: "what rename
gets past the rules?")

When a policy is enforced at a central chokepoint, every ratified
exception or bypass of that chokepoint silently inherits an exemption
from **every rule the chokepoint carries — including rules added later**.
Therefore:

- **Exceptions live in a register at the chokepoint** (the manager's file
  header is the model). An exception that isn't listed is a bug, not an
  exception.
- **Adding a rule to the chokepoint re-triggers an audit of the
  register.** Each exception either re-applies the new rule locally
  (documented in its header as a policy check it carries — the
  useUntitledSaveAs model) or is explicitly recorded as deliberately
  exempt, with the reason.
- **Sweep for effect-equivalent paths, not just registered exceptions**:
  ask "what user action produces this same effect through different
  code?" (rename produces creation; save-as produces creation; promote
  produces a folder). The loophole class hides in flows that don't share
  the guarded verb's name.
- **Refusals must be visible.** A chokepoint that blocks silently reads
  as a bug upstream, trains users to retry or route around, and hides the
  loophole class from live verification. Every refusal surfaces (pill,
  toast, inline error) at whichever layer can show it.
- Ordering interacts with refusal: see implementation-policy Rule 7
  (state follows disk) — a chokepoint that can refuse makes any
  state-first flow a drift trap.
