# Research Bootstrap

Before any investigation:

☐ Read this document completely

☐ Create research journal

☐ Record objective

☐ Record success criteria

☐ Begin investigation

# Mandatory Operational Policies

Before performing any research, debugging, investigation, architecture discovery,
or repository exploration, you MUST read and follow:

Agents/docs/persistent-research-policy.md (this document, in full)

Failure to follow this policy is considered an execution error.

This policy overrides default model behavior regarding
research persistence and investigation workflow.

# AGENTS.md

## Research & Investigation Persistence Policy (MANDATORY)

This policy applies to **every** task involving research, investigation, debugging, architecture discovery, codebase exploration, documentation review, root-cause analysis, or any task requiring more than a few tool calls.

Failure to follow this policy is considered a workflow error.

---

# Primary Objective

Research must be resilient to interruption.

Assume that execution may stop at any time because of:

* Session expiration
* Context window limits
* Rate limits
* Model replacement
* IDE restart
* User interruption
* Process termination

At no point should significant investigative work exist only inside the model's context window.

---

# Rule 1 - Create a Research Journal Immediately

Before performing the first search, grep, file read, or tool call, create a temporary Markdown file.

Recommended filename:

```
.research/<timestamp>-<short-task-name>.md
```

or

```
tmp/research-<task>.md
```

if a project convention already exists.

This file becomes the authoritative record of the investigation.

---

# Rule 2 - Record the Original Objective

The beginning of the journal must contain:

* Original user request
* Current objective
* Success criteria
* Known constraints
* Assumptions

This section must never be overwritten.

---

# Rule 3 - Log Every Investigation Step

Every significant action must be recorded.

Examples include:

* Web searches
* Documentation searches
* grep/ripgrep
* Symbol lookups
* File inspections
* API exploration
* Repository navigation
* Build/test execution
* Database inspection
* Log inspection

Each entry should contain:

* Timestamp (optional)
* Action performed
* Why the action was taken
* Result
* Relevant files
* Relevant symbols

Do not merely state that an action occurred.

Record what was learned.

---

# Rule 4 - Record Evidence, Not Chain of Thought

The journal is a technical notebook.

Do NOT dump internal reasoning.

Instead record:

Observed facts

Evidence

Supporting code

Documentation references

Verified behavior

Rejected hypotheses

Confirmed conclusions

The journal should be understandable by another engineer or another AI without requiring hidden reasoning.

---

# Rule 5 - Maintain Running Conclusions

Maintain a continuously updated section named:

```
## Current Findings
```

Every confirmed discovery should be summarized here.

Do not force a future agent to reconstruct findings from hundreds of log entries.

---

# Rule 6 - Maintain Remaining Questions

Always maintain:

```
## Remaining Questions
```

Include:

Unknowns

Missing evidence

Unverified assumptions

Potential edge cases

---

# Rule 7 - Maintain Next Actions

Always maintain:

```
## Next Actions
```

This should contain an ordered checklist.

Example:

* inspect auth middleware
* grep CacheManager
* verify configuration loading
* compare startup sequence

This section must always represent the next executable work items.

---

# Rule 8 - Save After Every Meaningful Update

After every significant investigation step:

Append to the journal.

Save the journal.

Never accumulate large amounts of investigative work only in memory.

The maximum amount of work that may be lost during interruption should be one investigation step.

---

# Rule 9 - Resume From the Journal

If interrupted for any reason:

Never restart the investigation blindly.

Instead:

1. Locate the existing research journal.
2. Read it completely.
3. Reconstruct the current investigation state.
4. Continue from the recorded "Next Actions."

Avoid repeating completed searches unless verification is explicitly required.

---

# Rule 10 - Avoid Duplicate Investigation

Before performing any search, grep, or file inspection:

Consult the journal.

If the investigation has already been performed and remains valid:

Reuse the existing findings.

Do not repeat expensive work.

---

# Rule 11 - Final Deliverable

When the investigation is complete, ensure the journal contains:

## Objective

## Original Request

## Investigation Log

## Evidence

## Current Findings

## Remaining Questions

## Next Actions

## Final Conclusions

The final report presented to the user should be derived from this journal.

---

# Rule 12 - Journal Is the Source of Truth

Treat the research journal as the canonical investigation state.

The conversation context is temporary.

The journal is persistent.

If they disagree, prefer the journal.

---

# Rule 13 - Multi-Agent Compatibility

Write the journal so another AI or engineer can immediately continue work.

Do not assume shared memory.

Do not rely on prior conversation context.

Everything necessary to resume the investigation should exist inside the journal.

---

# Rule 14 - Minimize Rework

The investigation process should always satisfy this invariant:

> If execution stops unexpectedly, another agent should be able to continue after reading only the journal, without repeating previously completed investigative work.

This invariant takes priority over convenience or speed.

