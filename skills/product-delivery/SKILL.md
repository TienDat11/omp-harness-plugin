---
name: product-delivery
description: Use for idea assessment, requirements, issue triage, prioritization, or delivery planning; do NOT use for ordinary code tasks (those go through task-intake).
---

# Product delivery

Pipeline, state machine, nothing parallel:

```
verbatim idea/issue
  → 00-requirement.md: actors, problem, desired outcome, constraints, 3–7 measurable AC IDs
  → evidence: primary sources + existing repo/issue evidence + evidence AGAINST + explicit ASSUMPTION labels
  → 01-assessment.md: problem/evidence/value/feasibility/strategic-fit/risk + 2–3 concept options, including do-nothing
  → deterministic readiness verdict: go | needs-clarification | kill
  → go: user confirms chosen option → 01-plan.md with AC-linked implementation/delivery steps
  → implementation and native GitHub issue/PR links
  → delivery only: 02-verification.md + outcome.json; every AC has observed evidence
  → discovery terminal: 01-assessment.md + outcome.json; no 02-verification.md before go
```

Concretely:

- `intake_open` with `kind:"product"` and `source:{kind,locator}`. Same `.omp/work/<date>/<slug>/` dir. Never `.specify` tree; never five-document cascade.

- `00-requirement.md` records source kind (`text`/`issue`/`pr`/`document`) and locator. Never paste confidential document body; locator is the pointer.

- `01-assessment.md` ends with fenced block:

````
```json readiness
{ "problem_defined": "yes", "evidence_strength": "adequate", "measurable_outcome": "yes", "concept": "shaped", "recommended_option": "option-id", "verdict": "go", "reason": "one-sentence evidence-based reason" }
```
````

- Before presenting `go`, call `harness_decide` with `kind:"readiness"` and the block (or `path` to `01-assessment.md`). Runs pure local `readiness()`: `go` only when `problem_defined=yes`, `evidence_strength` is `strong` or `adequate`, `measurable_outcome=yes`, `concept=shaped`, and `recommended_option` is nonempty. Any other non-`kill` input → `needs-clarification`; malformed or missing fields → `needs-clarification`, never `go`. Declared verdict mismatch → correct the block, not the prose.

- `kill` = agent/user decision with stated reason (no valid problem, better alternative, cost exceeds value, explicit out-of-scope). Successful terminal outcome, not failure. Stops before any code change.

- `needs-clarification` names blocking questions and the single section to refine.

- BA/product-only task stops after `01-assessment.md` + `outcome.json`; touches no source file.

- Priority arithmetic uses real numeric inputs in code; never infer precise scores from Jev rubric positions. Jev supplies advisory component judgments only, never the verdict.

- Human approval required for product scope changes, external publication, issue/PR mutation, high-impact domains.

- Issue triage: read via `issue://` or GitHub reads; group duplicates only with source links; link each work item as `source → requirement AC → change/files → verification → PR`. `gh` only for specifically authorized create/edit/comment/label/close; reading never implies write. PR bodies link AC IDs and actual checks; `Closes #N` only when closure requested. Label cached GitHub views with freshness when recency matters.

- Native `/plan` for unknown technical design; `/goal` with finite token budget only for clear long-running finish line; `/guided-goal` when end state needs interview. Never goal mode for ambiguous product decisions, credentials, production changes, unattended destructive work.

- Measured by: unsupported `go` downgraded, evidence-against retained, kill stops before code, AC-to-PR trace complete, no external write without confirmation, no Markdown beyond declared tier.
