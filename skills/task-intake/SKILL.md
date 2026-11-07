---
name: task-intake
description: Choose the S/M/L/XL tier before any file edit; S and M are lightweight, L/XL run the full intake-plan-verify cycle. Use for file-creating or file-changing tasks; not for pure questions.
---

# Task intake

Choose tier before editing.

## Tier → artifacts

| Tier | Files | Process |
|---|---|---|
| S | none | direct edit + one observed check |
| M | `.omp/work/<date>/<slug>/00-requirement.md` + `outcome.json` | no plan file, no mandatory subagent, no mandatory reviewer |
| L/XL code | `00-requirement.md`, `01-plan.md`, `02-verification.md`, `outcome.json` | one plan, bounded delegation, one independent review only when risky |
| BA/PM discovery | `00-requirement.md`, `01-assessment.md`, `outcome.json` | evidence before concept, no source edits before approval; add `01-plan.md` + `02-verification.md` only after `go` |

## Tier selection

- Reversible? How many files? Existing pattern?
- Escalate tier and say so; never continue silently past escalation.

## Process

- `intake_open` creates the directory. Never `mkdir` yourself.
- Headless (no `ask`): write `[NEEDS CLARIFICATION: <question>]`, stop. Never guess.
- BA/PM work → `skill://product-delivery`.

## Cache contract

- No `session.compacting` hook; no mid-turn compaction.
- Never rewrite system prompt / tool schema / older messages; append at tail only.
- Never stuff intake content into AGENTS.md.
