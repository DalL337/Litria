# Litria — Pull Request Proposal

Thank you for contributing to Litria! Before your PR can be reviewed, it needs to pass through our five governance pillars. This isn't bureaucracy — it's how we protect the experience for every person who uses Litria.

Read through this template carefully and fill out every section that applies to your PR type.

**Target branch:** `main` (unless told otherwise in the linked Issue)

---

## What Is This PR?

Select the type that best describes your contribution. If it touches more than one, pick the dominant one and explain the overlap in your reasoning.

- [ ] **Fix** — Something is broken and this corrects it
- [ ] **Feature** — A new capability that doesn't currently exist
- [ ] **Refactor** — Same behavior, improved internals
- [ ] **New Domain** — Adds a whole new concern, layer, or system to Litria

> Sections marked with **(Feature/Domain only)** can be answered N/A for Fixes and Refactors with a brief explanation.

---

## Summary

> One or two sentences. What does this PR do, and why does it exist?

<!-- Your answer here -->

---

## Reasoning

### What problem does this solve, or what value does it add?

<!-- Your answer here -->

### If this is a Fix — what is the current broken behavior vs the expected behavior?

<!-- Your answer here or N/A -->

### If this is a Feature, Refactor, or New Domain — what was discussed before this PR was opened? **(Feature/Domain only)**

> New Domains must have a prior Issue or Discussion thread. Features and Refactors should have one unless the scope is small and self-evident.

<!-- Link to Issue/Discussion here, or N/A for small Refactors -->

---

## The Five Pillars

Every PR merged into Litria must honestly satisfy all five. Walk through each one.

---

### Safe

**Does this PR introduce any exploitable surface area, unvalidated inputs, or leaked data?**

- [ ] No new attack surface is introduced
- [ ] All inputs are validated and sanitized where applicable
- [ ] No sensitive data is exposed, logged, or leaked
- [ ] Dependencies added (if any) have been vetted

<!-- Explain your security posture here -->

---

### Sane

**Does this make sense within the Litria architecture?**

- [ ] This fits within the current roadmap or has a clear rationale for extending it
- [ ] It does not duplicate existing functionality
- [ ] Domain placement evaluated against `docs/Orchestration.md`
- [ ] New Domains and Refactors have a documented reason to exist beyond personal preference

<!-- Justify why this belongs in Litria -->

---

### Performant

**Does this add resource overhead? If so, defend the cost.**

- [ ] No measurable performance regression introduced
- [ ] If overhead is added, the trade-off is justified and documented below
- [ ] Relevant profiling or benchmarks have been considered

<!-- If this adds resource usage, explain why it's worth it -->

---

### Reliable

**Will this work correctly when Litria ships on Windows, macOS, and Linux?**

- [ ] No platform-specific assumptions are baked in
- [ ] File paths, system calls, and dependencies are cross-platform safe
- [ ] Tested on more than one OS, or flagged clearly if not yet verified

<!-- Note any platform considerations or limitations -->

---

### Easy to Use

**Does this improve the experience for the person sitting at the keyboard?** **(Feature/Domain only)**

- [ ] It is intuitive and does not add unnecessary complexity
- [ ] It aligns with the Litria design ethos (visual clarity, low friction, learner-friendly)
- [ ] If it changes the UI or UX, the change makes the overall experience better — not just different

<!-- Describe how this serves the end user -->

---

## Automated Validation

These must pass before review. CI runs them automatically, but run them locally first.

- [ ] `npm run check:architecture` — all 4 guards pass
- [ ] `npm run test:domains` — all domain tests pass
- [ ] `npm run build` — clean production build

---

## Architecture Checklist

- [ ] No forbidden dependency edges added
- [ ] No new domain-coupled imports added to `src/App.jsx`
- [ ] No shadcn/Radix imports in protected zones (ADR-008)
- [ ] New domains follow contract (`create*Domain` factory + `commands`)
- [ ] If domain API changed, `docs/Orchestration.md` or phase plan updated
- [ ] If domain API changed, domain tests updated

### New Domain Requirements **(New Domain only)**

- [ ] Prior Issue or Discussion exists and is linked above
- [ ] Domain added to the Domain Master List in `docs/Orchestration.md`
- [ ] Domain follows contract (`create*Domain` factory + `commands` + `selectors`)
- [ ] Domain test file added in `test/domains/`

---

## How Was This Tested?

Screenshots, recordings, logs, reproduction steps — whatever demonstrates it works.

<!-- Your answer here -->

---

## Anything Reviewers Should Watch For?

Edge cases, known limitations, follow-up work, or anything that needs a second set of eyes.

<!-- Your answer here or N/A -->

---

## Contributor Checklist

- [ ] I have read the [Litria Contribution Guidelines](CONTRIBUTING.md)
- [ ] My code follows the Litria tech stack and styling policy (see CONTRIBUTING.md)
- [ ] I have not introduced hardcoded values where configuration or modularity is possible
- [ ] This PR is scoped — it does one thing and does it well
- [ ] All five governance pillars have been addressed honestly above

---

> _"Whatever this PR is trying to accomplish, it has to be sane, safe, performant, reliable, and easy to use for the end user."_
> — Litria Contribution Standard
