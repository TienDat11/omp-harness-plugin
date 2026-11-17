# Changelog — omp-harness 1.3.0
- Startup fix: `src/optional-deps.ts` resolves `minisearch`, `graphology`, and
  `graphology-metrics/centrality/pagerank.js` through `createRequire` in
  `try/catch` with a `setOptionalDepsOverride` test seam. `zeromem.ts` and
  `stack-router.ts` no longer use top-level static imports, so a missing
  `node_modules` degrades one ranking stage instead of killing the extension
  at module evaluation. Evidence: `EXTENSIONS_LOAD_OK`.
- Auto-Ontology layer: `src/ontology.ts` two-pass compile (catalog, then
  cross-file join verification where a relation is `verified` only when the
  target file exists on disk and the target's symbol appears in the source
  text), a read-only `0..1` coverage gate with default threshold `0.6` that
  never compiles on the hot path, `certified = 1` terms granting a `1.35×`
  retrieval boost plus `certifiedOnly` exclusion in `ZeroMemBridge.query()`,
  and Apache Ossie-compatible YAML at `.omp/ontology/domain-ontology.yaml`.
  Storage is the existing Zero-Mem SQLite DB at `dbPath(cwd)`
  (`<root>/.omp/memory/zero-mem/<slug>-<hash12>/memory.db`). New
  `withMemoryDb` always closes its handle so Windows never leaks a `-wal`
  lock.
- 4-tier compute router: `computeTaskComplexity` in `src/superagent.ts` routes
  on structural signals (entity count, cross-module spread, ontology coverage,
  reversibility risk, ambiguity), never prompt length: T1_MECHANICAL
  `ramclouds/glm-5.3-flash:max` / budget 12; T2_STANDARD
  `ns24/deepseek-v4.1-flash:high` / 18; T3_DEEP_REASONING
  `ns24/deepseek-v4.1-flash:max` / 24; T4_PREMIER
  `openai-codex/gpt-6-luna:max` / 24; escalates one tier after 2 degraded
  retries. `resolveSuperagentTaskInput(input, state, now, cwd?)` appends
  `<ontology-context>`, `<compute-budget>`, `<output-grammar>` after the
  worker contract, only when `cwd` is supplied, and stays idempotent via the
  contract tag.
- Claude CLI activation: `scripts/omp-harness-mcp.mjs` is a stdio JSON-RPC 2.0
  MCP server exposing 11 tools (`jev_decide`, `jev_rank`, `jev_gate`,
  `intake_open`, `harness_record`, `harness_mine`, `harness_gate`,
  `harness_decide`, `zero_mem_recall`, `ontology_check`, `ontology_compile`),
  reusing the real `src/tools.ts` handlers; Jev calls use model `"jev"` on
  `https://api.ns24.io/v1/systemone` with a 4s abort and a deterministic
  fallback. `scripts/claude-memory-hook.mjs` adds `UserPromptSubmit` recall
  injection and `Stop` durable write. The hook resolves the harness root
  absolutely (`OMP_HARNESS_ROOT`, then walk-up, then `D:/omp-harness`) so a
  copy at `~/.claude/hooks/memory-intake.mjs` loads correctly, and always
  exits 0.
- Skill discovery: `discoverPluginSkillDirs` in `src/stack-router.ts` scans
  `installed_plugins.json` install paths, `cache/plugins/*/skills`,
  `plugins/src/*/skills` and `plugins/node_modules/*/skills`, deduplicated
  and sorted, shared by `installedSkillDirs` and `sortedSkillDirs`.
- Advisory telemetry: `checkUnboundedBashDump` in `src/policy.ts` logs `B1`
  for an unbounded `cat`, `git log` or `grep -r` without a bounding pipe or
  count flag. It never blocks.
- Verifier: new `runtime-deps` check (#13) resolves every declared runtime
  dependency and fails the build when one is missing, so an empty
  `node_modules` is caught in CI instead of at extension load.
  `harness.manifest.json` declares omp `18.22.0` tested.
- After pulling: `npm ci`; then `node scripts/sync-cli-surface.mjs`; then
  restart the CLI once.

# Changelog — omp-harness 1.2.1
- `read-budget.ts`: a duplicate-read refusal now states the file's line count and the next unread slice, and an over-wide repeat whose narrowed prefix is already held is served as its uncovered tail instead of refused. Evidence: 104 duplicate-read refusals in 2026-11-06..09 transcripts, 52 of them a bare re-read, retried by `vilao/minimax-m3.1-flash` and `local-relay/north-mini-code` instead of moving to the next slice.
- Skill `omp-harness` §1a/§1b: recorded that `vilao` `/v1/models` advertises six active ids while `POST /v1/messages` answers only for `minimax-m3.1-flash`, `glm-5.3-flash` and `zai-org/glm-5.3-flash` (haiku/opus/fable return `403 permission_error`); recorded the 2026-11-09 `north-mini-code` combo repair and the `provider returned error` fallback patch.
- Environment (outside the bundle): 9router `north-mini-code` combo reordered to five verified members and the dead/aborting ones removed; the vendored combo-runner regex now also skips `Provider returned error`. The exact 544 KB, 393-message body that produced 96 captured 400s now returns `200`.

- Subagent learning (opt-in): `harness_record` takes optional `subagentEvaluations`; the parent commits independent assessments in one SQLite transaction (KL-UCB selection, 50-card cap, 3-opportunity direction cooldown, 6-lesson bounded policy memory rendered as `<subagent-policy-memory>` within 8192 UTF-16 units). A projection write failure after commit raises `PROJECTION_PENDING` and is drained on the next commit, learning dispatch or `session_start`. Guarantee is process-crash/reopen only, no power-loss fsync claim; the spec §11 upgrade measurement has not been run. See `docs/OMP-HARNESS-UPGRADE-CONTRACTS.md` §6.

# Changelog — omp-harness 1.2.0
- Docs: rewrote SUBAGENT_SELF_IMPROVED.md directly with mandatory skill receipts, scoped worker packets and coordinator gates; preserved three-table learning schema, hierarchical KL-UCB, strict observation gates, cooldown and bounded memory. Plan fence TypeScript/math/SQL checks are separate from unimplemented runtime acceptance; no additional Goldfish round or absolute prompt-enforcement claim.
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
