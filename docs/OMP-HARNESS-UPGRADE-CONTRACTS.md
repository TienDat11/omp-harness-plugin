# OMP Harness Upgrade Contracts

Five contracts that govern how the harness is upgraded, operated, and promoted.
Normative key words (MUST / MUST NOT / SHOULD / MAY) are used as in RFC 2119.

---

## 1. Auth & Clean-Room Legal Boundary

- The harness MUST treat `TYPESAFE_API_KEY` as the only credential Jev may ever read. It MUST NOT read, log, or echo any other secret (`sk-*`, `Bearer …`, `api_key=…`, passwords) into prompts, receipts, fixtures, or artifacts.
- `sanitizeLessonText` (`src/tools.ts`) MUST redact `Bearer …`, `sk-*`, and `key=value` secret patterns before any lesson text is written to `lesson.md` or `.omp/harness/lessons.jsonl`. A test pins the `Bearer sk-secret…` redaction.
- The harness MUST NOT reproduce provider source, system prompts, or proprietary text. Behavior compatibility is expressed as black-box probes (input → observed output), never as pasted implementation.
- A route with no passing probe MUST fail closed (`unavailable` / `no-passing-probe`). The model name MUST match what the endpoint reports; a mismatch (`model-mismatch: expected X, observed Y`) names the observed string so the operator can set the real one.
- Probes, fixtures, and receipts are sanitized artifacts: stdout/stderr MUST NOT contain raw credentials; any observed secret in a probe record is a harness bug, not a fixture to commit.

## 2. Portable Operations vs Author-Machine Historical Notes

Portable operation is the contract. Paths that are only true on the original author's machine are historical notes, not behavior.

| Variable | Meaning | Default / fallback |
|---|---|---|
| `OMP_HARNESS_HOME` | Root for user-global harness state (`~/.omp`-style home). | `HOME` → `USERPROFILE` → `os.homedir()` |
| `PI_CODING_AGENT_DIR` | Agent dir (`…/.omp/agent`). | `<home>/.omp/agent` |
| `OMP_HARNESS_JEV` | `1` enables shadow Jev judgments. | unset → off |
| `OMP_HARNESS_LESSON_GATE` | `1` opts the session into the one-shot post-session lesson continuation. | unset → off; `/harness-lesson on|off` toggles |

Rules:

- `resolveHomeDir` / `resolveAgentDir` / `resolveUserHarnessDir` (`src/state.ts`) are the single source of home resolution. Callers MUST NOT fall back to `process.cwd()` when home is empty; `expandHome` returns `""` instead (fail closed, never silently resolves inside the repo).
- `globalHarnessLogPath` and `appendBoundedLog` tolerate an empty home (no-op).
- `scripts/verify.mjs` and `scripts/run-probes.mjs` MUST derive every path from the env contract above (`HOME`/`USERPROFILE`/`os.homedir()`, `OMP_LIVE_CONFIG`, `OMP_PROFILES_DIR`, `OMP_BASELINE_HOME`, `OMP_BIN`) so they run on any OS — never a hardcoded author path such as `C:\Users\ADMIN`.
- Historical numbers in README (baseline capture timestamps, run ids, `probes/results-*.json` past runs) are evidence notes. They MUST NOT be treated as the live path or the live threshold; verify recomputes from the current checkout.

## 3. Evidence-Gated Skill & Harness Loop Governance

The harness loop only admits an edit when measured evidence improves.

- Admission rule: `d_in >= 0 && d_ho >= 0 && max(d_in, d_ho) > 0`, where `d_in` / `d_ho` are held-in / held-out pass deltas. One split may stay flat; neither may regress; at least one must improve. Applied by `harness_gate` via `scripts/compare.mjs` / `scripts/benchmark-compare.mjs`.
- A faster candidate with lower acceptance or more fallbacks is NOT an improvement. Missing artifacts or logs mean `measurement-error`, never a pass.
- Skill injection is pinned: `pinnedDigest` releases an `l1Digest` only when the pinned sha matches the live body **and** the recomputed digest equals the stored `l1Digest`. `decideValve` MUST NOT open the valve on a changed body. The allowlist lives under `OMP_HARNESS_HOME`, never repo-local, so a cloned repo cannot inject skills.
- `harness_record` writes `outcome.json` with acceptance pass/fail per criterion; `harness_mine` clusters failures by `(joint, criterion)` signature so the proposer never repeats a rejected edit.

## 4. Post-Session Code Design & Counter-Example Tutor Contract PUB-18/Disposition H

After a coding session, the harness teaches the user, it does not grade them.

- Trigger: `requireLessonOnStop` dep or `OMP_HARNESS_LESSON_GATE=1`, plus `state.mutations > 0`, plus no lesson already delivered or prompted. The `session_stop` hook returns at most ONE `{ continue: true, additionalContext: buildPostSessionLessonPrompt(mutatedFiles) }` continuation, then never again in that session.
- `buildPostSessionLessonPrompt` MUST contain: (1) why this design is right — goal, root cause, chosen-vs-rejected alternative, tradeoff, verification evidence with `file:line` citations; (2) 2–3 look-alike cases where copying the pattern is WRONG, why it fails there, and the correct pattern instead. Concise, local/sanitized (no hidden CoT or secrets), and explicitly non-blocking — never a quiz gate.
- `hasDesignLesson(text)` is the completion check: it requires BOTH a why-signal (`why this design` / `vì sao thiết kế` / `decision record` …) and a counter-example signal (`avoid misconception` / `tránh lầm tưởng` / `when not to use` …). Either signal alone is not a lesson.
- `/harness-lesson on|off` toggles `OMP_HARNESS_LESSON_GATE`; bare `/harness-lesson` shows the latest recorded lesson from `.omp/harness/lessons.jsonl`.
- `harness_record` persists the lesson to `<dir>/lesson.md` and appends the structured entry to `.omp/harness/lessons.jsonl` — both sanitized via `sanitizeLessonText`.

## 5. Accepted-Task Cost & King-Harness Promotion Gate PUB-20/PUB-22/F12

Cost is measured per accepted task, never per request or per token in isolation.

- `computeAcceptedTaskCost(attempts)` (`src/telemetry.ts`): `totalAttempts` counts ALL attempts (pass + fail) as the denominator. `acceptedCount` counts attempts whose check passed with no measurement error. `totalTokenCostUsd` sums only `per-token` costs; `perRequestCalls` counts `per-request` calls separately. A `null`/missing `costUsd` makes the result `UNKNOWN`; zero accepted attempts makes it `UNDEFINED`.
- `scripts/benchmark-compare.mjs` mirrors these rules over `probes/runs/*.json` (or `probes/results-*.json`): it reports per-arm accepted-task cost, held-in/held-out pass deltas, the four raw cache counters (`input`, `output`, `cacheRead`, `cacheWrite`), cache reuse, and read-budget blocks. Missing `probes/runs` prints usage and exits `0` on `--help`/`--dry-run` (no data to compare, not a failure).
- King-harness promotion (PUB-20/PUB-22/F12): a candidate replaces the standing harness only when the evidence gate in §3 passes AND the accepted-task cost does not regress (`costPerAcceptedUsd` equal or better at equal-or-better acceptance). A candidate that is cheaper per token but accepts fewer tasks, or that trades acceptance for speed, MUST NOT be promoted. Report the four cache counters separately; `cacheRead / (input + cacheRead)` is an approximation, never a universal cache-hit percentage.

## 6. Subagent Learning Contract (parent-attested, SQLite-backed)

Describes only what runs in `src/skill-telemetry.ts`, `src/superagent.ts` and `src/tools.ts`. Binding spec: `docs/superpowers/specs/SUBAGENT_SELF_IMPROVED.md`.

### Contract surfaces

- `harness_record` accepts an optional `subagentEvaluations: Assessment[]`. Without it the legacy path is unchanged and never touches the learning store. With it, the learning branch runs one store transaction instead of the direct `outcome.json` write. The parent coordinator submits assessments; a worker terminal tag never creates a reward, and the branch rejects calls from a subagent context (`ctx.agent?.kind === 'sub'`) before any write. The API is parent-attested evidence, not a defense against a malicious parent.
- Destination is derived by the tool: a directory under `<cwd>/.omp/work` and the file `outcome.json` only. Symlink components, paths outside the root, a missing directory (not created), evidence outside the workspace or not a regular file, an evidence SHA-256 that does not match current bytes, a foreign session, and a changed proposal for the same direction all reject before any learning write.
- `session_start` (parent only): drains any pending outcome projection. It never creates the DB or its directory.
- `tool_call` learning adapter (`task`, `vibe_spawn`, `vibe_send`): one `<subagent-candidates>JSON</subagent-candidates>` envelope per item is replaced by the selected prompt in that item's own field; text outside the envelope is kept. Selection is KL-UCB over parent arms, then direction arms, with a persisted dispatch trace per `toolCallId`. A missing session or call ID, a store error, a drain error, a CAS error, or a malformed or duplicate own tag blocks the learning dispatch (fail closed). Dispatch without an envelope is legacy: never blocked by pending outbox, no trace, no counter.
- `<subagent-policy-memory>` block: rendered from the freshly loaded state for the goal and appended to the selected item's text. The same revision is byte-identical and never duplicated; a different revision replaces only this block. The trace stores the exact memory text and revision for replay.

### Failure semantics

- Before COMMIT any error rolls back observations, markers and state. A stale generation raises `CAS_STALE_GENERATION` and rolls everything back.
- After COMMIT the learning is not rolled back. If the outcome file write returns false the call throws `PROJECTION_PENDING` carrying the committed generation and operation ID; the caller must treat learning as committed with the projection pending, not as rolled back. The pending projection (full `outcome.json` bytes) is flushed by the next drain: the immediate drain, the next commit or learning dispatch, or the `session_start` drain.
- A pending projection that cannot be written blocks learning commits and learning dispatch until resolved. A pending projection belonging to another operation reports the caller's operation as not committed.
- Replay of an identical operation returns the recorded generation and original bytes without reapplying. A changed payload conflicts. A skipped assessment is not upgraded on retry.
- Startup drain never throws. Skips and failures are logged by code only: `CWD_NOT_ABSOLUTE`, `STORE_ABSENT` (no DB; nothing pending), `STORE_UNAVAILABLE`, or the error code (`DRAIN_FAILED` if none). Pending data stays pending.
- A `lesson.md` / `lessons.jsonl` write failure is reported separately and does not undo learning. Lessons are outside the atomic guarantee; replay does not append a second lesson.

### Limits (values as in code)

- Candidate envelope: 1-8 candidates; prompt at most 4000 UTF-16 units; `goalId`, `directionId`, `parentId`, `mechanism`, `change` at most 512 units each; scope at most 8 paths, each at most 1024 units.
- Cooldown: a non-improving failure sets `excludedThroughOpportunity = T + 3`; the next three opportunities are excluded and the fourth is eligible. Duplicate, SKIP and restart do not renew it. It applies to the direction only.
- Failure cards: cap 50 (evict smallest `lastSeenAt`, then smallest `failureKey`); eviction never removes an active cooldown.
- Lessons: cap 6; at most 8 targets per lesson; target catalog 8 files.
- Memory render: default cap 8192 UTF-16 units including tags and revision (minimum 256); at most 8 cooldown direction IDs listed, the rest counted in `excludedCount`; `<` is escaped as the six-character sequence `\u003c` (backslash, u, 0, 0, 3, c).
- Durability: the guarantee is process-crash and reopen only (temp-write plus rename, existing SQLite settings). There is NO power-loss or fsync durability claim. File IO happens under the SQLite writer lock, so a disk error can block learning-enabled dispatch and commit until resolved.
- Security: the path and symlink checks do not defend against an OS-level adversary swapping a symlink between check and write.

### Evidence status

- Module and hook integration (evaluate, commit, next dispatch through registered hooks, SQLite rows, close and reopen) is covered by `tests/subagent-learning.test.ts` (F11).
- A temp-workspace trial on the actual omp tool dispatch was NOT run. Only module and hook integration is claimed.
- The spec section 11 upgrade evaluation (frozen corpus, held-in/held-out split, accepted-task cost) was NOT performed. The upgrade benefit is not proven and no ranking or improvement claim is made.
- TypeScript typecheck was not run: there is no `tsconfig`, and Node strips types.
- `tests/manifest.test.ts` and `npm run verify` checksums fail because `harness.manifest.json` was stale at the base commit and further drift is expected from this work; the manifest was deliberately not regenerated.
