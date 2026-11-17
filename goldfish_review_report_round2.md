# Goldfish Review — Round 2 (code diff)

- Target: `.omp/work/review-round2.diff` (`git diff HEAD`, base `d0fae16`, 881 lines, 14 modified files + CHANGELOG.md untracked)
- Reviewers: codebase_details, implementation_readiness
- Standard: resources/document_standards/implementation-readiness-standard.md
- Mode: REVIEW (code-diff adaptation)
- Convergence: 1 round. Round not clean (1 Blocker, 2 Major). Accepted at 1 round per operator instruction.

## Findings

### cd-1 — 🔴 Blocker — src/skill-specs.ts decideValve (already-injected branch)
`genuineSecondary` exception let an already-injected top candidate walk down to a tie partner. The partner's margin equals its own score, so the thin-margin guard never fired and the partner autoloaded — the 5-way saturated tie therefore autoloaded a fresh irrelevant skill every turn, which is the production symptom this change set set out to remove.
Decision: **ACCEPTED / FIXED** — branch now returns `already-injected` unconditionally. Explicit `/skill:` pinning still reaches autoload because the +0.25 explicit boost makes the pinned skill `candidates[0]`.

### ir-1 — 🟡 Major — src/superagent.ts:458 looksLikePath
`dirPrefixes` contained the literal `"D:/"`, hardcoding one workstation's drive letter into a published plugin.
Decision: **ACCEPTED / FIXED** — replaced with a drive-agnostic absolute test `/^(?:[A-Za-z]:[\\/]|[\\/])/`.

### ir-2 — 🟡 Major — src/superagent.ts:463-471 collectStrings
Dead function that still read `# Change` and `# Acceptance` prose as path sources, contradicting the target-only packet rule and leaving a latent scope hazard.
Decision: **ACCEPTED / FIXED** — function deleted after proving zero callers in `src/` and `tests/`.

### cd-2 — 🟢 Nit — tests/intake.test.ts first-submission assertion
`assert.notEqual(afterFirst, "null")` compared a JSON string to the literal `"null"` and could not fail.
Decision: **ACCEPTED / FIXED** — assertion now parses the value and asserts it is an object.

### ir-3 — 🟢 Nit — src/skill-specs.ts:410 length damping constant
Reported as an undocumented implementer design decision.
Decision: **CONTESTED / NO CHANGE** — the constant carries a rationale comment in code, and the literal plan formula was rejected on measured evidence: it drove genuine matches to 0.2687, below the `AUTOLOAD_THETA / 2 = 0.35` pointer floor, so relevant skills would have stopped being suggested. The shipped form is inert to ~16 matched terms and engages only on oversized text.

### cd-3 — 🟢 Nit — recordWorkerReport diff hunk
The diff renders `completed → dropped` in a way that implies the `"ready"` case changed.
Decision: **CONTESTED / NO CHANGE** — rendering artifact. Live code keeps `"ready" → "completed"` and adds `"dropped" → "dropped"`.

## Reviewer status
- codebase_details: completed (first attempt exceeded the runtime cap; findings emitted on retry)
- implementation_readiness: completed

## Verified during review
- `node --test`: 382 pass, 0 fail
- `node scripts/verify.mjs`: 12/12 checks ok, exit 0
- `REPORT_SEVERITY` removed with zero dangling references
- CHANGELOG bullets each map to live code
- The three edited test files are legitimate consequences of the specified behavior, not weakened assertions
