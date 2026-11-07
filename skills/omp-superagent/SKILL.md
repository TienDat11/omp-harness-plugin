---
name: omp-superagent
description: Router-Worker-Watchdog state machine for EGM-reviewed ticket lifecycle wired into src/superagent.ts. Triggers: superagent, subagent, watchdog, ticket routing, parallel wave delegation.
---

# omp-superagent

**Router–Worker–Watchdog** state machine for EGM-reviewed ticket lifecycle, wired into the OMP harness via `src/superagent.ts`.

## Purpose

`omp-superagent-prototype` gives the main session a deterministic way to:
- Route goals into tickets (`Router`)
- Track worker assignments (`Worker`)
- Emit watchdog alerts for edit-thrash, degraded output, waits-for-person, and retry-exhausted (`Watchdog`)

It is **cache-safe**: never mutates `systemPrompt`, never rewrites conversation history, and never blocks `bash` on the main session.

## Domain model

### Ticket
```
ticketId, goal, stage, waitsForPerson, retryCount,
allowedPaths[], createdAt, updatedAt
```
Stages: `planned → running → ready | blocked | failed | dropped | unavailable`.

### Assignment
```
assignmentId, ticketId, agent, status, startedAt, completedAt?
```
Statuses: `active → completed | degraded | failed`.

### WorkerReport
```
kind, ticketId, agent, summary?, degraded?, at
```
Kinds: `progress | question | ready | dropped | failed | blocked`.

Terminal reports (`ready`, `blocked`, `failed`, `dropped`) move the ticket stage. `blocked`/`failed` also set `waitsForPerson = true` and emit a `waits-for-person` alert.

### WatchdogAlert
```
alertId, kind, ticketId, target, detail, at
```
Kinds:
- `edit-thrash` — ≥ `maxEdits` (default 4) edits on one file without a passing verify.
- `degraded-output` — `<abort-reason>`, `status="cancelled"`, or `(no output)` in a task result.
- `waits-for-person` — worker report is `blocked` or `failed`.
- `retry-exhausted` — `retryCount > maxRetries` (default 2).

### SuperagentPacket
Markdown packet parsed by `validatePacket`:
```
# Target
<target>

# Change
<change>

# Acceptance
- criterion 1
- criterion 2

# Stop
<stop condition>
```

## Lifecycle

1. **Router** — `openTicket(state, goal, allowedPaths?, ticketId?, now?)` creates a `Ticket` at stage `planned`.
2. **Worker** — `assignWorker(state, ticketId, agent, now?)` creates an `Assignment` at `active`. `recordWorkerReport(state, report, now?)` records the outcome and transitions the ticket.
3. **Watchdog** — `recordFileEdit(state, filePath, ticketId?, maxEdits?, now?)` counts edits per normalized file path; at the limit it emits `edit-thrash`. `requeueExpiredTicket(state, ticketId, maxRetries?, now?)` bumps `retryCount` and, past the limit, flips stage to `unavailable` and emits `retry-exhausted`. `inspectSubagentResult(state, rawOutput, ticketId, agent, now?)` detects degraded task output and marks the matching assignment `degraded`.
4. **Human turn** — `noteHumanTurn(state)` clears `waitsForPerson` on all tickets.
5. **Verify** — `recordVerifyPass(state)` clears `editsSinceVerify`.

## Extension hooks (`createSuperagent` / default `superagent`)

| Hook | Behavior |
|---|---|
| `session_start` | Subagent guard (`ctx.agent.kind === "sub"` → no-op). `event.reason === "resume"` loads snapshot from `<cwd>/.omp/harness/superagent-state.json`; otherwise fresh state (saved if `persistState` or absolute `cwd`). Clears pending call maps. |
| `before_agent_start` | Subagent guard. Calls `noteHumanTurn(state)`, drains `pendingInspections` into `{ message: { customType: "superagent-watchdog", content, display: false } }`; saves snapshot. |
| `tool_call` | `edit`/`write`/`ast_edit` → `recordFileEdit` + `checkSurgicalScope`. `task`/`vibe_spawn`/`vibe_send` → `waits-for-person` block, `resolveTaskGoal` ticket reuse/open, `assignWorker` → `running`, record `pendingToolCalls`/`pendingAnonCalls`, inject `<superagent-worker-contract>`. Never touches `bash`. |
| `tool_result` | `task`/`vibe_spawn`/`vibe_send` → `extractToolResultOutput` + tracked lookup + `inspectSubagentResult` + `parseWorkerReportTag` (severity `failed > blocked > question > dropped > ready > progress`) + `recordWorkerReport`; `bash` verify → `recordVerifyPass`. Saves snapshot. |
| `registerCommand("superagent")` | Returns `formatSuperagentStatus(state)` via `ctx.ui.notify` (session-scoped state via `getState`). |
## `egm-review-loop` integration

The prototype feeds the EGM (`egm-review-loop`) review cycle:
- Watchdog alerts surface `edit-thrash` and `degraded-output` for reviewer attention.
- `waits-for-person` alerts pause ticket progression until the next human turn.
- `/superagent` command emits the full status for reviewer inspection.

## Files

- `src/superagent.ts` — types, pure functions, and ExtensionAPI wiring.
- `tests/superagent.test.ts` — `node:test` coverage for all exports and hooks using `tests/_fake-pi.ts`.

## Non-goals

- Does not edit `package.json`, `harness.manifest.json`, `src/verify-gate.ts`, `src/policy.ts`, `src/telemetry.ts`, or `src/tools.ts`.
- Does not block `bash` unconditionally (breaks Tier-S and `src/verify-gate.ts`).
