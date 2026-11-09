# Changelog — omp-harness 1.2.0

- Subagent learning (opt-in): `harness_record` takes optional `subagentEvaluations`; the parent commits independent assessments in one SQLite transaction (KL-UCB selection, 50-card cap, 3-opportunity direction cooldown, 6-lesson bounded policy memory rendered as `<subagent-policy-memory>` within 8192 UTF-16 units). A projection write failure after commit raises `PROJECTION_PENDING` and is drained on the next commit, learning dispatch or `session_start`. Guarantee is process-crash/reopen only, no power-loss fsync claim; the spec §11 upgrade measurement has not been run. See `docs/OMP-HARNESS-UPGRADE-CONTRACTS.md` §6.

- Watchdog target extraction now unwraps markdown-decorated paths (backticks, bold, link form, trailing colon) so a markdown `# Target` no longer escapes scope checking; glob tokens are still rejected.
- Routing scores only user prose: `extractUserPrompt` strips `<critical>`, `<system-reminder>`, `<zero-mem-recall>`, `<parent-read-ledger>`, `<superagent-watchdog>` envelopes and `[IMPORTANT: User invoked the ...]` lines before `classifyTaskCategory` / `scoreSkillDocs`. Explicit `/skill:<name>` and `skill://<name>` invocations are captured and boosted +0.25, outranking MiniSearch recall.
- Length damping engages only past ~16 matched terms (`Math.max(1, log2(n/8))`) so oversized prompts cannot saturate every skill to 1.00 while ordinary prompts keep the calibrated curve and stay above the pointer floor.
- `decideValve`: an already-injected top candidate closes the valve as `already-injected` instead of walking down the list; a margin under 0.03 closes the valve even at `>= 0.85` confidence, so saturated ties never autoload.
- `parseSkillDoc` supports YAML block-scalar `description: >` / `|`.
- Skill discovery and pinning cover `user-global`, `bundle`, and `plugin-cache` origins; repo-local stays unpinned until `/harness-skill pin`.
- `before_agent_start` announces the stack once per session (branch- and session-checked before the turn counter advances) and only emits the autoload tail afterwards.
- Subagent work is attributed: `tool_result` no longer ignores subagent contexts, `task`/`vibe_spawn` mutations and verification runs count toward telemetry, and the model id comes from `ctx.model.id` instead of `"*"`.
- Watchdog path extraction rejects prose (`try/catch`), and packet inputs yield paths from `# Target` only; `[file#TAG]` and `path:line` citations count as evidence; the last `[SUPERAGENT-REPORT: ...]` tag wins; spawn ACKs no longer log a bogus `W1`.
- Harness telemetry never writes during tests (guard on `OMP_HARNESS_TEST`, `--test`, `NODE_TEST_CONTEXT`, test/verify/probes entrypoints); an explicit `OMP_HARNESS_LOG_PATH` still overrides.
- `session_stop` no longer marks verification as recorded before the continuation turn runs.
- Skill reward accounting uses outcome mass (treatment `alpha += r, beta += (1-r)`, control `beta += 1`) instead of run counts, and a manual rating rewrites the run reward and recomputes lift.
- Memory recall scores the stripped user prompt, so injected envelopes cannot trigger `code-entity-match` recall every turn.
