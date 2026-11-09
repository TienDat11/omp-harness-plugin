# RESEARCH BUNDLE: Harness / Agent Workflow (X + Reddit + primary sources)
`exec: egolite MCP (logged-in X/Reddit) + web_search/read`. Files: none. No plan/code.
> Sources are vendor/primary + 2 arXiv + 1 bench blog where metrics exist. X/Reddit hype that cites them is marked `secondary`. Every retained claim = source + metric, else `anecdotal`.

## 1. HARNESS ENGINEERING
### 1.1 What a harness is - 7 subsystems (measured source study)
**Claim:** `agent = model + harness`. Every production harness implements same 7 subsystems: Agent Loop, LLM Integration, Tools & Actions, Memory & Context, Safety & Permissions, Orchestration, Extensibility. Minimal = Mini-SWE-Agent 100-line loop+bash; maximal = Claude Code 43 typed tools + deferred loading / Codex V8-executed tools / OpenHands event-sourced log.
**Source:** Wavestone AI Lab, *Harness Engineering: Anatomy of 11 Coding Agents*, arXiv:2609.00006, 2026-07-15. https://arxiv.org/abs/2609.00006
**Evidence:** Measured source-code study. ~4M LOC Python/TS/Rust across Claude Code, Codex CLI, Gemini CLI, Mistral Vibe, OpenHands, Aider, Mini-SWE-Agent, Hermes, Pi, OpenCode, OpenClaw + Omnigent meta-harness. 13 observations, 29 patterns.
- **No framework imports:** 0/11 runtimes import LangChain/LangGraph/AutoGen/CrewAI (incl. Gemini CLI not using Google's own). Runs on hand-rolled async loops.
- **No vector code retrieval:** 0/11 uses embeddings; deterministic ripgrep/tree-sitter/glob/AGENTS.md discovery.
- **Extensibility:** SKILL.md 9/11 > MCP 8/11. ACP (Agent Client Protocol) 6/11, gained 3rd role *harness hosting* (OpenHands can run Claude/Codex/Gemini as backends).
- **Convergence = imitation (90-day diff):** Codex adopts Claude Code hook vocabulary verbatim + session importer; OpenHands reads Claude plugin format. Behavioral policy migrating prompt-prose → config.
**omp map:** validates current `stack-router` closed-valve + deterministic retrieval (no vector), `memory.ts` FTS5 BM25, `superagent.ts`.
**Fabrication risk:** Medium-low. arXiv not peer-reviewed, but reproducible (pinned releases) and corroborated by X citations. Numbers are counts, not marketing multipliers.
**Metric:** adoption counts above; 90-line MVH scaffold in paper §16 implements 10/18 recommendations.

### 1.2 OpenAI harness engineering (Codex, agent-first) - large measured case
**Claim:** 0 lines human code, ~1M LOC, 1500 PRs / 5 months, 3 engineers → 7, throughput *rose* to 3.5 PRs/engineer/day, ~1/10th human time, single runs >6h unattended.
**Source:** Ryan Lopopolo, OpenAI, 2026-02-11. https://openai.com/index/harness-engineering
**Evidence:** Measured production experiment (internal beta, hundreds daily users). Vendor-reported, not independently replicated.
**Upgrade-relevant tactics:**
1. **AGENTS.md as table-of-contents (~100 lines), `docs/` as system-of-record.** Monolith failed. Fix: `AGENTS.md` map + `docs/{design-docs,exec-plans,product-specs,references,QUALITY_SCORE,RELIABILITY}` + linters/CI for freshness/cross-links + doc-gardening agent PRs.
2. **Invariants, not micromanagement.** Fixed layered domain architecture. Enforced by custom linters + structural tests. Error messages inject remediation into context.
3. **Legibility tooling:** per-worktree boot, CDP DOM/screenshot, Vector → Logs/Metrics/Traces queried via LogQL/PromQL/TraceQL.
4. **Throughput merge philosophy:** minimal blocking gates, short-lived PRs, flakes fixed in follow-ups.
5. **Garbage collection:** golden principles + recurring background agents scanning deviations.
**omp map:** `memory.ts`/`zeromem.ts` → repo-as-record; `read-budget.ts` 180-line cap aligns with 100-line TOC; `verify-gate.ts` → linter-as-invariant; `intake.ts` exec-plans.

### 1.3 LangChain Deep Agents - controlled harness-only A/B
**Claim:** Only harness changed, model fixed (`gpt-5.2-codex`): Terminal-Bench 2.0 **52.8% → 66.5% (+13.7 pts), Top-30 → Top-5.**
**Source:** Vivek Trivedy, LangChain, 2026-02-17. https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering
**Evidence:** Reproducible benchmark (89 tasks, Harbor+Daytona sandbox, LangSmith traces: latency/token/cost per action). Best metric + intervention separation in set.
- **Build & Self-Verify loop + `PreCompletionChecklistMiddleware`** intercepting exit (Ralph-Wiggum-like Stop hook).
- **`LocalContextMiddleware`:** inject cwd tree + toolchain at start.
- **`LoopDetectionMiddleware`:** track per-file edit counts; inject "consider reconsidering" after N edits to same file (traces showed 10+ doom-loop edits).
- **Reasoning sandwich xhigh-plan → high-build → xhigh-verify:** 66.5% vs xhigh-only 53.9% vs high-only 63.6%.
- **Trace Analyzer Skill:** parallel error-analysis agents over LangSmith traces.
**omp map (round 4 corrected):** `verify-gate.ts` advisory `session_stop {continue:true}` (cap 3, `src/verify-gate.ts:224-247`) is omp's Stop-hook equivalent — do NOT invent Claude exit-2. `read-budget.ts` duplicate-refusal complements existing `superagent.ts:391-414` `recordFileEdit(maxEdits=4)` edit-thrash watchdog (`tool_call {block:true}` at `1180,1187-1195`, G1 rc=30/W2); LangChain LoopDetection is the same mechanism, not a new detector. `harness_gate` = trace feedback loop.

### 1.4 Claude Code best practices - deterministic vs non-deterministic
**Claim:** Split instructions: Non-deterministic (prompt/CLAUDE.md/skills - model *decides*) vs Deterministic (hooks/deny rules/managed settings - harness *enforces*). "If you keep adding IMPORTANT to CLAUDE.md and it's ignored, that's a hook."
**Source:** Anthropic, https://www.anthropic.com/engineering/claude-code-best-practices + https://code.claude.com/docs/en/best-practices
- **CLAUDE.md keep short (<200 lines),** only what agent can't find by reading repo. Path-scoped `.claude/rules/*.md` with `paths:` filter.
- **Give a check to run:** prompt → `/goal` (separate checker model) → Stop hook (`exit 2` blocks stop, stderr fed back, cap 8 blocks) → independent `/code-review` subagent (fresh context). Always ask for evidence (command + output), not "all pass". omp equivalent: `session_stop {continue:true, additionalContext}` (advisory, cap 3) — see §4 U1 reframed.
- **Skills = progressive disclosure:** name+description always in context, full SKILL.md only on demand.
**omp map:** `policy.ts` bash deny = deterministic layer; `stack-router` AUTOLOAD_THETA 0.7 = skill progressive disclosure; `verify-gate` = Stop hook ancestor; advisory-only is the gap LangChain closes with blocking middleware. U1 reframed uses the existing `session_stop` continue mechanism with a false-block metric (F3).

### 1.5 Reddit/X anecdotal patterns (kept, marked `anecdotal`)
| # | Claim | Source | Metric | Risk |
|---|---|---|---|---|
| R1 | Read-only custom subagent: **116k → 30k tokens/call (-74%)** | r/ClaudeCode u/Vektoris_AI_Workflow, 2026-11-04 https://www.reddit.com/r/ClaudeCode/comments/1x97ix2/ | Per-call token count, single user | Medium. No harness dump, no task success rate. |
| R2 | 9-hour autonomous `/goal` session, 5 passes | r/ClaudeCode 2026-06 https://www.reddit.com/r/ClaudeCode/comments/1tmm4sd/ | Duration + pass table, single case | Medium. n=1, no cost/latency. |
| R3 | "Demo statement" = single biggest quality lever | r/ClaudeCode 2026-04 https://www.reddit.com/r/ClaudeCode/comments/1rr7vgo/ | Qualitative, no metric | Medium. Plausible but unmeasured. |
| R4 | Orchestrator → doers → reviewer subagent topology | r/ClaudeCode https://www.reddit.com/r/ClaudeCode/comments/1wvhzr2/ | Anecdotal setup, repeated pattern | Low as topology; no efficiency metric. |
| R5 | "Stop unmanaged runs fail at turn 14. Isolate worktrees, enforce contracts" | X @marfinxx 2026-11-05 https://x.com/marfinxx/status/2118313633381745064 | No metric | High (X article marketing). Pattern plausible, discard numbers. |
| R6 | X @Mr_Buzzoni Jev harness "200x faster, 400x cheaper" | https://x.com/Mr_Buzzoni/status/2119448608697209283 | No denominator | **DISCARD** |
| R7 | X @RodmanAi jcode "20x memory, 60x faster, parallel swarms" | https://x.com/RodmanAi/status/2049028224697684072 | No bench | **DISCARD** |

## 2. X AGENT WORKFLOWS (multi-agent, model routing, cache-safe)
### 2.1 Anthropic prompt caching - governing constraint
**Sources:** Thariq Shihipar, Anthropic, 2026-04-30 https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything ; Claude Code docs https://code.claude.com/docs/en/prompt-caching ; Anthropic *Optimizing for cost & intelligence* https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence ; Lumer et al., *Don't Break the Cache*, arXiv:2601.06007 https://arxiv.org/abs/2601.06007
**Evidence: measured (vendor telemetry + 500+ session eval, 10k sys prompt, DeepResearch Bench).**
- Paper: **41-80% cost ↓, 13-31% TTFT ↓** across OpenAI/Anthropic/Google. Strategic block control beats naive full-context caching.
- Vendor telemetry: median agent loop reads **84% input from cache**; top-10% **≥94%**; well-built loop <1% full-price. **<80% = investigate break.**
- Tool search: 502 tools $0.55→$1.02/run; with `defer_loading` flat $0.56, same accuracy, 0 wrong-tool calls.
- Context lifecycle (long run): prune stale tool results **-39% cost**, compaction **-32%**; short run: context editing **+73%** (hurts).
- Prefix edit cost: system-prompt edit **25-50×** same text as mid-conversation system message ($1.26 vs $0.026 at ~100k tokens).
- TTL: default 5m vs 1h (write 1.25× vs 2×). Break-even ~1 in 30 turns paused 5m-1h.
- `superglue`/LangChain corroborate: KV-cache hit = #1 production metric.
**Cache-hit-preserving rules (keep list - maps to omp):**
1. **Order: static first, dynamic last.** System prompt + tools → project → session context → conversation (grows). Never timestamp/dynamic in system prefix.
2. **Updates via messages, not system prompt.** Use `<system-reminder>` appended in next user/tool message. omp already does this: tail custom messages (`harness-stack`, `zero-mem-recall`, display=false) with immutable `systemPrompt` prefix. **Keep that invariant - it's the #1 omp cache advantage.**
3. **Never add/remove tools or switch model mid-session.** Model switch = full reprocess. Use Plan Mode as *tool*, not tool-set swap. Use subagent with handoff message to change model. omp: don't swap `crouton-alpha` ↔ fallback mid-session; spawn new subagent.
4. **Defer, don't remove.** `defer_loading: true` stubs + tool-search discovery. omp `stack-router` (MiniSearch + closed valve) is this pattern; keep stubs stable order.
5. **Cache-safe forking for compaction/side work.** Summarizer must use *identical* system+tools+history, append "summarize" as new message.
6. **Monitor hit rate.** Claude Code confirms via `/context` + cache diagnostics; alert like uptime. omp has probes — add hit-rate probe.
7. **Invalidate list (avoid mid-task):** model switch, effort/fast-mode toggle, MCP connect/remove (deferred=safe), plugin enable/disable with MCP, deny-rule bare tool name, upgrading Claude Code, accumulating images. **Keep:** permission-mode change, output-style change, skill invocation (message), `/recap`, `/rewind`, spawning subagent (own cache).
8. **Compaction timing:** at natural task breaks, not mid-task; after 5m gap summarizer pays full reprocess. Haiku >100k tokens = 5× price on all tokens - trigger compaction ~90k (model-specific). omp overlay: **80% of 200K = 160K between turns** (`config/recommended.yml:59-67`, `midTurnEnabled:false`, `idleEnabled:false`) — no mid-task compaction; reconcile per wire (Anthropic wire re-bills subagent tail, openai wire caches; vilao flat pricing makes -32% token saving evaporate, leaving overflow prevention only).
**omp constraint:** ns24 openai-wire caches subagents, anthropic-wire does not; `tools+tool_choice:none` → 400 on crouton-alpha; reasoning tokens precede content; 80s tool loop. Cache-safe = keep subagent prompt prefix stable across retries (don't shuffle tool order, don't rewrite system prompt per retry).

### 2.2 Multi-agent orchestration patterns
**A. Context-pollution avoidance via subagents.** Codex Subagents docs https://developers.openai.com/codex/subagents — main chat holds requirements/decisions; noisy exploration/test/log output goes to parallel subagents returning summaries. Consumes **more tokens** than single-agent. Parallel read-heavy = safe; write-heavy = conflicts.
**B. Model routing by task shape.** Anthropic cost-intel: Advisor (low-cost consults high-cost only on hard decisions), Orchestrator (split work exceeding one context window), **Re-run failures: run low effort, re-run failures at high: ~40% cheaper, same pass rate**, **Elapsed-time injection: 7-47% less wall time, few points score cost.**
**C. Dynamic workflows / Agent SDK.** X @trq212 2026-06-02 https://x.com/trq212/article/2061907337154367865 + Claude Cookbook dynamic workflows https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows — code-driven workflow scripts spawning full Claude Code agents. Theoretical/product launch, no user-measured success delta. **Dropped per §5 discipline (retained-only-with-metric rule); not an upgrade candidate.**
**D. Cache-safe prompting for multi-agent:** subagents = separate cache buckets (5m TTL default). Keep subagent prompt templates *frozen*; pass task data in final user message. Mixed-model fan-out breaks caches per-model (each model own namespace). Prefer: pick model per *subagent*, spawn fresh subagent with handoff doc, don't hot-swap.

## 3. CODEX CLI vs CLAUDE CLI ADAPTATION
### 3.1 Tool / hook surface mapping (omp hooks → each CLI)
| omp concept | Claude CLI | Codex CLI | OMP CLI (native) |
|---|---|---|---|
| Policy/deny bash | Deny rules `.claude/settings.json`, sandbox modes, `PreToolUse` (`Bash` matcher), `PostToolUse`, `PermissionRequest` | Sandbox mode + approval, `PreToolUse` hook matcher `Bash`, `PermissionRequest` hook (hash-pinned) | `policy.ts` tool_call gate (secret targets, destructive `bash`, dedup); `bashInterceptor.enabled` |
| Verify-gate | `Stop` hook exit 2 → stderr back, cap 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`); `SubagentStop`, `UserPromptSubmit`, `PreCompact`, `SessionStart/End` | `Stop` hook `timeout 600s`, `SubagentStop` | `session_stop {continue:true, additionalContext}` (advisory, cap 3); `tool_call {block:true}` precedent in `superagent.ts:1192-1195` |
| Worker supervision | Subagents (foreground/background), Agent Teams, `Agent` tool, subagent depth limit 1 | Subagents `/subagents`, custom agents `~/.codex/agents/*.toml` (model, `model_reasoning_effort`, sandbox, MCP) | `task` subagent (`maxRecursionDepth:1`, `maxConcurrency:4`); `superagent.ts` W1/W2; `/superagent` |
| Stack router / skills | Skills `.claude/skills/<name>/SKILL.md` (name/desc in context, full on demand), path-rules `.claude/rules/`, MCP tool-search `defer_loading` | Skills + plugins (`hooks.json`), MCP tools, marketplace | `stack-router` closed-valve (0.7/0.15/4000/15%/20/±0.2); 105-skill catalog, 119 deferred tools |
| Intake / spec | Root `CLAUDE.md` (<200 lines) + `SPEC.md`, `/init`, `/doctor`, `/goal`, `/code-review` | Root `AGENTS.md` (~100 lines TOC) + `docs/exec-plans/`; `codex exec`; `codex mcp` (Codex as MCP server) | `.omp/work/<date>/<slug>/00-requirement.md` via `intake_open` + `outcome.json` via `harness_record` |
| Memory / RAG | Auto-memory, nested CLAUDE.md on-demand, code-intel LSP plugin | Agent-maintained cross-session memory pipeline | `memory.ts` FTS5 BM25 (`cacheReuse = cacheRead/(input+cacheRead)`, `telemetry.ts:296-300`) |
| Modes | `default`/`acceptEdits`/`plan`/`auto`, `opusplan` (each toggle = model switch = cache break) | `read-only`/`workspace-write`/`full-access` + approval `untrusted`/`on-request`/`on-failure`/`never` | profile isolation `OMP_PROFILE/PI_MODEL`; `/plan` `/vibe`; `task.enableEffort:false`; `isMutatingTaskCall`/`READ_ONLY_AGENTS`; commands `/harness-stack /superagent /harness-allow-secret /harness-allow-destructive /zero-mem` |
| Prompt cache | Prefix match, 5m/1h TTL per bucket, keep-alive `max_tokens:0` | OpenAI wire caches; no published hit-rate SLO | vs anthropic wire re-bills subagent tail; `vilao` flat 5 VND/request (0.031285 USD/Mtok estimator); tail-only injection invariant; compaction 80%→160K |
| REA MCP (this case) | — | — | `mcp__rea_*` ~100 tools bounded by table in §3.3; `_meta.provenance.untrusted_content` wrapped in `tool_result` |
### 3.3 REA MCP trust boundary (closed here, F1)
`policy.ts:570-673` gates only `tool_call` (secret/destructive/dedup) + telemetry `tool_result`. REA surface maps as:
| REA surface | Examples | Mapping |
|---|---|---|
| read (allow) | `list_procedures`, `search_procedures/strings`, `procedure_pseudo_code`, `inspect_*`, `analyze_function`, `trace_*`, `decompile_all`, `open_binary`, `get_evidence_bundle` | allow; treat results as data, never instructions (`_meta.provenance.untrusted_content`) |
| state-write (gate) | `set_address_name(s)`, `annotate_native_function`, `set_comment`, `set_inline_comment`, `set_bookmark`, `record_unknown`, `update_analysis_settings` (recovery), `export_evidence_bundle` (writes `snapshot_path`, `overwrite`) | route through `isSecretAllowed/isDestructiveAllowed` + evidence-bundle `allowedPaths` guard; adapter: name file before claim |
| exec (declare) | `instrument_with_frida`, `capture_*_scenario` load caller JS into target | outside `bash` interceptor — declare explicitly, never pretend `evaluateBash` covers it |
### 3.2 Codex specifics worth stealing for omp
- **Worktree-per-change + ephemeral observability:** `git worktree add` per worker, tear down logs/metrics after. omp superagent workers currently share cwd - parallel write conflict risk. Candidate U3.
- **Auto-review:** sandbox-boundary approvals routed through reviewer agent. omp analog: deny-rule → verifier worker.
- **Custom agents TOML:** per-role model/effort. crouton-alpha (weak) only low-effort narrow roles (triage, scan), never plan/verify.
- **Multi-agent via Agents SDK:** Codex as MCP server enables orchestration. Meta-harness orchestrates 11 vendor harnesses behind one API — omp superagent should expose `/superagent` as MCP server.
### 3.3 Making a weak/destructive model obedient inside harness
1. **Constraints via deterministic layer, not prompt emphasis.** Weak model ignores CLAUDE.md lines under context pressure; Stop hook + deny rules + sandbox enforce regardless. REA boundary: same rule — `set_*/annotate/record_unknown/export/instrument/capture` must hit policy, never rely on prompt.
2. **Verification gate as harness, not suggestion.** PreCompletionChecklist: block stop, inject failing test output, allow N retries (Claude cap 8, omp cap 3).
3. **Read ledger / doom-loop detection.** LangChain LoopDetection + omp `read-budget` (180-line cap + duplicate refusal) + EXISTING `superagent.recordFileEdit` (maxEdits=4, G1 rc=30/W2). Duplicate loop removed — tuning only, not new detector.
4. **Spec handoff + progressive disclosure.** 100-line TOC + docs/, Claude <200-line CLAUDE.md + path rules, spec written in clean session, build in fresh session.
5. **Fallback chains at subagent boundary (cache-safe).** Spawn fresh subagent on fallback model with handoff message. Log fallback in ledger.
6. **Reasoning budget asymmetry.** Weak model gets `low` effort + narrow scope + read-only tools (R1 116k→30k). Planning/verify roles reserve high effort to strong model.

## 4. CONCRETE UPGRADE CANDIDATES (gate: `d_in>=0 AND d_ho>=0 AND max>0` on pass counts, `src/tools.ts:315-324`; `d_in`/`d_ho` = held-out pass-rate deltas)
| ID | Candidate | omp target | Metric (formula + baseline) | Evidence base | Disposition |
|---|---|---|---|---|---|
| U1 | **Blocking PreCompletionChecklist** | `src/verify-gate.ts` `session_stop {continue:true}` (cap 3) | `falseBlockRate = blockedPassingTasks/totalBlocked`; held-out pass rate via `harness_record` (baseline: `G1 rc=40/41` advisory rate) | LangChain +13.7 pts; `session_stop` is omp's Stop-hook (do NOT invent exit-2) | **YES after fix** |
| U2 | ~~new edit-count detector~~ | `src/superagent.ts:391-414` `recordFileEdit` | Doom-loop incidence = edit-thrash / task (baseline: current `maxEdits=4` rate from `W2` logs) | Existing shipped watchdog | **Duplicate — threshold-tune or delete** |
| U3 | **Worktree isolation** | `src/superagent.ts` | parallel-write conflict rate = conflicts / parallel tasks; merge success; wall time (baseline: none — collect `W1/W2` conflict baseline first) | OpenAI 1M LOC; Codex | **Deferred** |
| U4 | **Read-only scan template** | reuse `agents/harness-grader.md` / `READ_ONLY_AGENTS` (`src/verify-gate.ts:65-77`) or publish `agents/scan.md` | tokens/call via `telemetry.ts` `sessionTotals` (baseline: R1 n=1 only); gate on scan-probe success set | R1 anecdotal n=1; Anthropic tool-search $0.56 flat | **YES after fix** |
| U5 | **Cache-hit alert (not probe)** | `src/telemetry.ts` + `scripts/compare.mjs` cache-regression | `cacheHitRate = cacheRead/(input+cacheRead)` (already in `telemetry.ts:296-300`; baseline `probes/baseline.json` 0.938/0.962); provider-aware threshold (top 100%/92.2% vs anthropic subagents 21-62%) → alert to `harness.log` | Anthropic 84% median; paper 41-80% cost ↓ | **YES alert-only** |
| U6 | **Low→high failure re-run** | `src/superagent.ts` `tool_call` spawn + `fallbackChains` | `costPerAcceptedUsd` = `computeAcceptedTaskCost` (`telemetry.ts:319-340`); define "solved" + pass-equality tolerance + p50/p95 latency budget (crouton 400 / 80s loop); `enableEffort:false` effort map | Anthropic ~40% (vendor) | **Deferred (wrong target fixed; cold-bucket budget missing)** |
| U7 | ~~exec-plans artifact~~ | `src/intake.ts` | spec-drift / rework rounds (no formula) | OpenAI — duplicates `intake_open` `.omp/work/.../00-requirement.md` + `outcome.json` | **Duplicate — close or diff `docs/exec-plans/` vs `.omp/work/`** |
| U8 | **Elapsed-time injection** | `src/superagent.ts` `before_agent_start` tail-message | wall `wall_ms` (M1/`agent_end`); score delta (baseline: collect omp `wall_ms` first) | Anthropic 7-47% wall-time (vendor) | **Deferred (template ready, baseline missing)** |
Cache rule: U1/U2/U8 inject as tail `customType/display:false` messages only; U4 keeps tool stubs stable order; U6 spawns fresh subagent per retry (new cache bucket — never hot-swap). `$/solved_task = (input·p_in + output·p_out + cacheRead·p_read + cacheWrite·p_write + reasoningTokens·p_reas + cold-reprocess) / solved` (reasoningTokens aggregated at `telemetry.ts:93-99`, ignored in vendor %. On `vilao` flat pricing token saving evaporates — gate cost/task, not tokens).

## 5. DISCARD LIST (theory/marketing/unverifiable - do NOT feed gate)
| Claim | Source | Reason |
|---|---|---|
| Jev harness "up to 200× faster, 400× cheaper" | X @Mr_Buzzoni 2026-11-08 https://x.com/Mr_Buzzoni/status/2119448608697209283 | No task set, no denominator. Marketing multiplier. |
| jcode "20× memory, 60× faster, parallel swarms" | X @RodmanAi 2026-04-28 https://x.com/RodmanAi/status/2049028224697684072 | No bench, no model/task named. |
| "135 agents, 35 skills, 176 plugins, 20 hooks" repos | X @thedelost 2026-10-24 | Count of files, not effectiveness. |
| Prompt-engineering keywords ("think step by step") | Anthropic docs: "ordinary prompt text, not keywords" | Superseded by effort level. |
| X hype venues (Andreesen/Haber, Roko, Bengio spec threads) | Individual X accounts | No harness mechanism, no metric. |

## 6. Non-duplication check vs existing omp-harness repo (v1.2.1)
Existing (do NOT re-propose): `policy.ts` (secret/destructive/dedup, `tool_call` only), `read-budget.ts` (180 cap, dup refusal, parent-ledger), `superagent.recordFileEdit` (maxEdits=4, G1 rc=30/W2), `stack-router.ts` closed-valve (0.7/0.15/4000/15%/20/±0.2), `memory.ts`/`zeromem.ts` FTS5 BM25, `verify-gate.ts` (advisory `session_stop`, cap 3), `intake_open` (`.omp/work/.../00-requirement.md`) + `harness_record` (`outcome.json`), `telemetry.ts` (`cacheReuse`, `computeAcceptedTaskCost`), cache tail-only injection + compaction-off overlay. REA: disjoint surface (no `mcp__rea_*` in harness code) — see §3.3 boundary table, not a re-proposal.
New scope (MVP only): U1 `session_stop` blocking + false-block metric, U5 provider-aware cache alert reusing existing telemetry. Deferred (need baselines): U3 worktree lifecycle, U6 low→high retry, U8 injection. Deleted as duplicates: U2 (edit watcher shipped), U7 (intake shipped). REA + OMP mode tables are prerequisite specs, not code.
