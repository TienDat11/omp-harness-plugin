---
name: omp-harness
description: Reference for this machine's omp harness — model roles, provider wiring, prompt-cache behavior, magic keywords, compaction, delegation tiers, and settings that matter for fast models. Read when tuning omp, changing models/providers, debugging cache hits or tool failures, or deciding how to route work between agents.
---

## Harness bundle

- Versioned bundle: `D:\omp-harness` (`@local/omp-adaptive-harness`).
- Machine policy: `C:\Users\ADMIN\.omp/agent`.
- Generated task evidence: per-project under `.omp/work/` and `.omp/harness/`.
- Ops: `node scripts/verify.mjs`, `node scripts/run-probes.mjs`, rollback via `omp plugin uninstall @local/omp-adaptive-harness`.

`muse2api/muse-chat` is a dormant manual `/advisor on` selector only — never an automatic advisor, never vision, never a correctness gate.

## 0. Read budget & subagent read-ledger handoff — the largest avoidable token cost

`src/read-budget.ts` enforces three rules before `read` or `task` executes. None touch the system prompt or cached prefix.

- **Cap.** An explicit range wider than 180 lines is rewritten to its first 180 lines; a whole-file `:raw` above 64 KiB becomes `1-180:raw`. The tool's own `[Showing lines 1-180 of N. Use :181 to continue]` footer tells the model where to resume. `read.defaultLimit: 180` makes a bare read match the same cap.
- **Duplicate.** A read whose content is still live in the session is refused with the `[name#TAG]` anchor already held: `blocked: big.ts (lines 181-360) is already in context as [big.ts#B12D]; reuse it.`
- **Subagent read-ledger handoff (`<parent-read-ledger>`).** Before a `task` call executes, `resolveTaskInput` collects up to 12 stat-verified live reads from the parent branch and appends `<parent-read-ledger>` (path, `[name#TAG]`, held window labels, and extracted top-level symbol `name@line` map for code files) to `task.context` (or `task.task` for single-task calls). All sibling subagents share the identical `context` block in their trailing user turn without mutating the static system prompt.

"Live" means all of: same resolved path, same or covering range, `prunedAt` unset, after the latest `firstKeptEntryId` compaction boundary, file `mtimeMs`/`size` equal to the stat captured when the result arrived, and no later `edit`/`write`/`ast_edit` on that path. Any of those changing re-allows the read, so the guard fails open — including on a resumed session, which has no recorded stats. In-process subagent teardown (`session_shutdown` with `ctx.agent.kind === "sub"`) is ignored by `policy.ts`, `intake.ts`, and `memory.ts` so parent `readStats`, failure counters, Jev state, and the Zero-Mem bridge stay intact across subagent waves.

The `[name#TAG]` anchor is a content hash: a changed tag after an edit is proof the file moved, and a stale anchor is a signal the model is quoting an old window.

## 0b. Self-verification and stack routing (v1.1.0)

Two entrypoints added in `1.1.0`; both are cache-safe (no `systemPrompt` override, no history rewrite, no tool activation).

- `src/verify-gate.ts` — `session_stop` advisory gate. A main-session turn that ran `write`/`edit`/`ast_edit` and no check runner afterwards gets exactly one `{ continue: true, additionalContext }`, capped at 3 per session. Counted check runners include `node --test`, `npm test|run build|run lint|run typecheck`, `vitest`, `jest`, `pytest`, `go test`, `cargo test|check|clippy`, `tsc`, `eslint`, `ruff`, `mypy`, `playwright test`, `make test|check`, `scripts/verify.mjs`, `scripts/run-probes.mjs`. A run that **failed** still counts — the gate asks whether a check ran, never whether it passed, so a red suite cannot become a nagging loop. Subagent sessions are skipped: only the main session is accountable for "done".
- `src/stack-router.ts` — `session_start` derives `languages`/`frameworks`/`tooling` from `package.json`, `pyproject.toml`/`requirements.txt`, `go.mod`, `Cargo.toml` and marker paths, bounded to 4000 directory entries. The first `before_agent_start` appends one custom message (`customType: "harness-stack"`, `display: false`) naming only skills that exist under `~/.omp/agent/skills`; `/harness-stack` prints the fingerprint on demand. This replaces guesswork over the alphabetical `<skills>` catalog.

Installed alongside it, 13 new skills (each with `PROVENANCE.md`), plus `impeccable` upgraded `4.7.0 → 4.8.0` (craft ceiling): `design-taste-frontend` (art direction), `ui-ux-pro-max` (style/palette/font database), `senior-backend`, `senior-data-engineer`, `senior-architect`, `senior-qa`, `api-and-interface-design`, `context-engineering`, `observability-and-instrumentation`, `ci-cd-and-automation`, `react-native-best-practices`, `terraform-style-guide`, `mutation-testing`. Frontend trio split by role: taste deals direction, ui-ux-pro-max is the searchable token database, impeccable sets the craft floor and audits.

## 1. Providers that actually work

Measured, not guessed. Numbers below come from real sessions on 2026-10-19.

| Provider | Wire | Status |
|---|---|---|
| `ns24` | openai-completions | live, 21 models catalogued |
| `ns24-anthropic` | anthropic-messages | live, 2 models (added 2026-10-19) |
| `vilao` | anthropic-messages | live, 1 model (added 2026-10-27) — **carries the mechanical subagent roles** |
| `openai-codex` | codex-responses | live, 3 models + gpt-image-2 |
| `local-relay` | openai-completions | live but flaky — combo aliases drift; **no longer in any role or override since 2026-10-27** |

Dead or unusable on this account (verified by probe):

- `bai` — `credit insufficient balance: balance=0` on every model.
- `ramclouds` — prepaid balance exhausted (`$0.000438` remaining).
- `novita` — `NOT_ENOUGH_BALANCE`.
- `xpl` — requires $1 card verification.
- `openai` — `Incorrect API key provided`.
- `vercel-ai-gateway` — no `AI_GATEWAY_API_KEY`.
- `xai-oauth` — deposit required for premium models.

Relay catalogue, verified 2026-10-19 with `omp models local-relay`, a `omp -p` probe,
and real subagent turns where noted. A `omp -p` probe sends no tools, so it does
**not** prove a model usable:

| Model | Thinking | Evidence |
|---|---|---|
| `nemotron-3-ultra-550b-a55b` | minimal…xhigh | **primary for subagents** — 2 real tool-using subagent turns completed on relay, no fallback |
| `nex-n2.5-pro` | minimal…xhigh | `omp -p` only; accepts images |
| `laguna-xs` | minimal…xhigh | `omp -p` only — the old "not in catalogue" note is stale |
| `nemotron-3.5-lightning` | none | `omp -p` only; slow to first token |
| `north-mini-code` | none | **combo**, not a model — see §1b. Working since 2026-10-23 after the combo list and the fallback patch were fixed |

`north-mini-code` has **no thinking levels**: bare selector only, never `:high`.

## 1a. `vilao` — the per-request provider (added 2026-10-27)

Anthropic-compatible gateway at `https://api.vilao.ai/v1`, catalogued in
`~/.omp/agent/models.yml`. `GET /v1/models` returns exactly one id:
`claude-haiku-5-5`. It replaced `local-relay/north-mini-code` in every role and
agent override — the relay is flaky (§1b) and the mini model was the weakest link
in the mechanical tier.

**Billed per request, not per token: 5 VND = 0.000193 USD per request.** The
catalogue `cost` block is USD per Mtok and cannot express that, so the stored
rates are derived, not quoted: measured 2026-10-27 over 146 real relay subagent
calls (mean 5,269 in + 683 out = 6,169 tokens), `0.000193 / 6169 × 1e6 =
0.031285 USD/Mtok` on all four fields. **Treat any reported cost from this
provider as an estimator with a ~300x spread** — a 600-token title call and a
200k-token agent call bill the same 5 VND upstream but omp reports 0.000019 vs
0.0063. Do not set `--warn-cost` / `--max-cost` thresholds assuming these numbers
track the real bill.

Probed live 2026-10-27 (each accepted, none erroring): SSE streaming with
`tool_use` blocks and `input_json_delta`; `thinking {type: enabled,
budget_tokens}`; `cache_control` ephemeral with `ttl: "1h"`; 234,048 input tokens
in one request; `max_tokens` 64,000 and 128,000; image blocks. A malformed base64
PNG returns `BAD_REQUEST`, so validate image bytes before blaming the gateway.

`contextWindow 200000` / `maxTokens 64000` are **declared** to match the
`ns24-anthropic` twin of the same model id; only the 234k-input and 64k-param
acceptance above is measured. The 200k ceiling itself is not pinned down.

Flat per-request billing changes the thinking-level calculus: a higher effort
costs no extra money, only latency. `defaultLevel: medium` for the mechanical
roles, not `high`.

## 1b. `north-mini-code` is a 9router combo (fixed 2026-10-23)
The relay on `localhost:20128` is **9router** (global npm install; the
`AppData/Roaming/npm` path is a symlink to `D:\DevCache\npm-global\node_modules\9router`).
`north-mini-code` is not an upstream model: it is a row in 9router's `combos` table
(`~/AppData/Roaming/9router/db/data.sqlite`), an ordered list of provider/model pairs.

**Why it kept failing.** Two independent faults, both required a fix:

1. **Stale combo list.** 4 of 6 entries were dead upstream:
   `oc/ling-3.1-flash-free` and `oc/space-bunny-free` → `400 Model is unavailable`;
   `openrouter/minimax/minimax-m3.1-flash:free` → `404` free tier retired 2026-10-22;
   `oc/muse-spark-1.3-contributor-free` → `410 ModelDeprecated`. Only
   `oc/mimo-v2.6-flash-free` and `openrouter/recursive/flint-v1.0:free` still answered.
2. **9router aborted the combo on those errors.** Its combo runner asks
   `shouldFallback(status, message)`; the classifier returns `false` for every 4xx
   except 401/402/403/429 (404 is covered by a rule-table entry). So a `410`
   (or `400 Model is unavailable`) returned the error immediately instead of trying
   the next combo entry. `0.5.99` and `0.5.104` are identical here — upgrading does
   **not** fix it.

**What was changed** (both must survive a 9router reinstall):

- Combo row now: `openrouter/recursive/flint-v1.0:free`, `oc/mimo-v2.6-flash-free`,
  `openrouter/xingchen-agi/xing4.0-29b-a4b:free`. All three verified for tool calls
  and multi-turn tool results. Backup of the old rows:
  `~/AppData/Roaming/9router/backups/omp-fix-*/combos.json`.
- **Order = currently-usable first.** 9router does not skip a combo entry that is
  rate-limited, so an exhausted first entry costs a full round trip (~2.5-3 s) on
  every request before the next is tried. `oc/mimo-v2.6-flash-free` hit
  `429 FreeUsageLimitError` (daily free cap) on 2026-10-23, which is why flint is
  first. Move a recovered model back to the front by editing the `combos` row.
- **Context window.** 9router advertises a combo's `context_length` as the minimum
  over its members. With the old member list that was **128000**, while
  `~/.omp/agent/models.yml` declared 200000 — omp would have compacted at 85% of
  200K, past the upstream limit, and hard-failed instead of compacting. After the
  member change the relay advertises 200000 and a 190,775-token prompt through the
  combo returns 200, so the 200000 in `models.yml` is now correct. Re-check
  `/v1/models` whenever combo members change.
- `nemotron-3-ultra-550b-a55b` and `nemotron-3.5-lightning` advertise 128000; their
  `models.yml` entries were corrected from 200000 to 128000 on 2026-10-23. The dead
  `laguna-xs` entry was removed (relay returns `No active credentials for provider:
  openai`).
- Vendored patch in
  `D:\DevCache\npm-global\node_modules\9router\app\.next-cli-build\server\chunks\8910.js`
  (module `18910`, the combo runner): the `if(!i)return …` guard became
  `if(!i&&!([406,410].includes(b.status)||(400===b.status&&/unavailable|not found|deprecated|not supported|does not exist/i.test(String(f)))))return …`
  so a dead combo entry is skipped. **Lost on `npm i -g 9router@…`** — re-apply, or
  keep the combo list free of dead entries.

Restart: kill the server PID; the `cli.js` supervisor respawns it in a few seconds.
DB combo edits apply without a restart; the chunk patch does not.

Verification that matters: a combo with a `410` and a `400-unavailable` entry in front
now returns `200` from the next entry, and a real tool-using subagent turn on
`local-relay/north-mini-code` completes without a paid fallback. **Historical since
2026-10-27** — nothing routes to the relay any more; kept because the 9router combo
patch is still installed and still needs re-applying after `npm i -g 9router@…`.

## 1c. Subagent routing (relay split verified 2026-10-23, vilao split 2026-10-27)

`task.agentModelOverrides` beats `modelRoles.<role>`. Setting only
`modelRoles.task: vilao/…` does nothing while
`task.agentModelOverrides.task` names another model.

Current split — mechanical work on vilao (flat per-request), judgment on paid
per-token models:

| Agent | Model |
|---|---|
| `task`, `coder`, `scout`, `sonic`, `researcher`, `harness-grader`, `seance` | `vilao/claude-haiku-5-5` |
| `reviewer`, `security-reviewer`, `harness-proposer`, `session-orchestrator`, `architect` | `ns24/deepseek-v4.1-flash:high` |

`task.maxRecursionDepth: 1` — a subagent may not spawn its own children.

### Fallback for a subagent override does NOT use `fallbackChains.task`

Measured trace, `RouteCheck2`:

```
Configured subagent runtime model fallback chain
  role: subagent:RouteCheck2
  requested: ["local-relay/north-mini-code"]      <- one entry, not the 7 in fallbackChains.task
agent turn ended with provider error 410
agent.continue scheduled  source: automatic-retry
provider: ns24  model: deepseek-v4.1-flash        <- fallbackChains.default[0]
```

So the relay-first entries placed in `fallbackChains.task` / `.smol` do **not**
keep a failed subagent on the relay. The retry resolves through
`fallbackChains.default`. Consequence: every relay failure costs one paid
`ns24/deepseek-v4.1-flash` call. That is accepted, not fixed — moving relay
models into `default` would also change the main agent's fallback, which is worse.

Still true after the 2026-10-27 vilao switch, and now the *desired* shape: a
`vilao` failure (provider down, key dead) lands on `ns24/deepseek-v4.1-flash`
rather than retrying a 12-deep chain of dead entries. `vilao` itself is absent
from every `fallbackChains` list on purpose — it is a primary only.

Verify routing from the log, not from the agent's self-report (models routinely
name the wrong model, and a fallback makes the self-report even less useful):

```bash
grep -h 'Configured subagent runtime model fallback chain' ~/.omp/logs/omp.*.log | tail -5
grep -h '"provider":"vilao"' ~/.omp/logs/omp.*.log | tail -5
```

A `provider proxy resolved provider: vilao` line appears once per session and is
enough to prove the catalog entry loaded; `agent_end maintenance routing` with
`"provider":"vilao","model":"claude-haiku-5-5"` proves the turn actually ran there.

Cost note: every subagent also runs a `title-generator` call on `modelRoles.tiny`
— now `vilao/claude-haiku-5-5`, i.e. another 5 VND request per spawn, flat
regardless of size.

Do not put any dead provider in a `fallbackChains` entry. A dead first hop burns
`retry.maxRetries` (12) before the next candidate is tried.

## 2. Why two providers for the same host

`api.ns24.io` serves both wires. The Anthropic wire is the only one where omp
places explicit `cache_control` breakpoints, so `ns24-anthropic` exists to make
cache hits explicit rather than dependent on the gateway's implicit prefix cache.

Both wires cache well. Measured on 8-step tool loops:

| Model | Wire | Cache hit |
|---|---|---|
| claude-haiku-5-5 | anthropic | **100.0%** (219,170 cached / 49 uncached) |
| claude-haiku-5-5 | openai | 92.2% (209,244 / 17,583) |
| deepseek-v4.1-flash | anthropic | **99.0%** |
| deepseek-v4.1-flash | openai | 89.9% |

The gap is uncached prompt bytes per turn: the Anthropic wire re-sends almost
nothing after the first turn. Use `ns24-anthropic` for anything multi-turn —
**except subagents** (see below).

### The Anthropic wire does not cache subagent turns (measured 2026-10-20)

Top-level sessions on `ns24-anthropic` cache correctly. Subagent sessions on the
same wire do not: every turn reports `cacheWrite` equal to the whole message tail
and `cacheRead` pinned at the turn-1 prompt, so the growing conversation is
re-billed at 1.25x on every request. A 7-agent fan-out accumulated 724k
cache-write tokens against 198k cache-read on a 176k-token conversation (21-62%
effective hit).

Same workload, same provider, 3 parallel `web_search` calls per turn:

| Wire | turn 1 | turn 2 | turn 3 |
|---|---|---|---|
| `ns24-anthropic` | read 13,476 / write 5,681 | read 19,157 / write 3,688 | read 19,157 / write 6,917 |
| `ns24` (openai) | read 0 / write 0 | read 19,283 / write 0 | read 22,794 / write 0 |

Isolation work, so nobody repeats it:

- The gateway itself is fine. A hand-built request sequence against
  `https://api.ns24.io/v1/messages` reuses an entry that ends on a `tool_result`
  block and survives the breakpoint moving: R1 write 9,166 → R2 read 9,166 →
  R3 read 9,238.
- omp's breakpoint layout is correct and identical in both cases: 4 markers =
  last non-deferred tool, the last system block before `<project-context>`, and
  the newest two messages (`applyPromptCaching`, budget `IP = 4`).
- Captured bodies (local logging proxy on the provider `baseUrl`) differ between
  consecutive subagent turns **only** by which content block carries
  `cache_control` — text, system and tool arrays are byte-identical — yet the
  next turn does not reuse the entry.
- Not the cause: thinking-block replay, tool-result re-rendering, `defer_loading`
  with 119 tools, request headers, `metadata.user_id`, MCP startup. Top-level
  requests carry thinking blocks, move their breakpoints the same way, and still
  hit.
- **Concurrency, partially tested.** The Anthropic-wire failure was never
  isolated under an interleaved-request test — that experiment was planned and
  not run, so interleaving or eviction under load is still an open suspect for
  the *old* behavior. On the openai wire it is now measured: 4 concurrent haiku
  subagents, 4 turns each, cacheWrite 0 on every turn and cacheRead equal to the
  previous prompt (total read 291,501 / write 0). Concurrency does not break
  caching on `ns24`.

Consequence: **haiku subagents ran on `ns24` (openai wire), not
`ns24-anthropic`** while haiku was still in use. Verified after that change on
the same fan-out pattern: cacheWrite 0 on every turn and cacheRead tracking the
full previous prompt (4 concurrent subagents, 4 turns each, total read 291,501 /
write 0).

In the **paired** A/B (same prompt, back-to-back runs) turn 1 read 13,476 on the
Anthropic wire against **0** on the openai wire — the openai wire had nothing
warm to read on its first request. Later openai runs show 5,272 on turn 1 or 0,
depending on whether an identical static prefix from an earlier run is still
warm; that number is not comparable to the paired one and must not be presented
as "the same static prefix". Why the paired gap exists was not isolated — do not
attribute it to the explicit breakpoint without a test.

What is solid is the shape, not the first read: from turn 2 the Anthropic wire
stops reading the growing conversation and re-bills the whole tail as a write,
while the openai wire reads the previous prompt in full every turn.

Haiku is back in use for hard and medium-hard agents since 2026-10-20 (see §7),
which means these hard agents re-bill their tail on every turn. That is a known,
accepted cost, not a bug to re-investigate.

## 3. Model roles

```
plan     openai-codex/gpt-6-luna:max
advisor  openai-codex/gpt-6-luna:max
slow     ns24/deepseek-v4.1-flash:high
task     vilao/claude-haiku-5-5
vision   ns24-anthropic/claude-haiku-5-5:high
smol     vilao/claude-haiku-5-5
commit   vilao/claude-haiku-5-5
tiny     vilao/claude-haiku-5-5
judge    vilao/claude-haiku-5-5
web      openai-codex/gpt-5.6-luna
image    openai-codex/gpt-image-2
default  ns24-anthropic/deepseek-v4.1-flash:high
```

Provider notes for the model classes in use:

- `vilao/claude-haiku-5-5` — 200K/64K declared, images, `minimal…max`, no
  `:high` suffix needed (catalogue `defaultLevel: medium`). **Flat 5 VND per
  request**, so longer prompts are free but a `title-generator` call costs the
  same as a 200k-token agent call. Mechanical work: research, file reading,
  grading, coder, plus every `tiny`/`commit`/`judge` helper call. Anthropic wire,
  so §2's tail re-billing applies — under flat pricing that costs nothing.
- `ns24/deepseek-v4.1-flash` — 200K/64K, images, `low|high|max`. Same model as
  `default`, so any role moved here reuses the top-level prefix cache. Judgement
  work: review, security review.
- `ns24-anthropic/claude-haiku-5-5` — 200K/64K, images, `minimal|low|medium|high`
  (no `xhigh`/`max`) on **ns24's** entry; costs more per token than the other two
  and re-bills the subagent tail every turn (§2), so it stays only where `vilao`
  is not the right bill — `vision`, `debugger`, `plan-drafter`.
- `local-relay/north-mini-code` — retired from routing 2026-10-27. 200K/16K, no
  thinking levels, no images, weak tool use. Kept in `models.yml` because the
  9router combo patch is still installed.

`plan` and `advisor` stay on Codex because `ns24/claude-opus-5-5` returns
`model does not exist` on this account — the id is catalogued but not granted.
Verify any role with `omp -p --model <selector> "Reply: X"` before trusting it.

## 4. Effort levels that actually work

Probed per model on the Anthropic wire with `output_config.effort`:

| Model | Accepted |
|---|---|
| claude-haiku-5-5 | minimal, low, medium, high, xhigh, max |
| deepseek-v4.1-flash | minimal, low, medium, high, max |

`deepseek-v4.1-flash` rejects `xhigh`. The `ns24-anthropic` model entry lists
only what the model accepts, so omp never sends an unsupported level.

`vilao/claude-haiku-5-5` lists the full `minimal…max` range, copied from the
`ns24-anthropic` entry for the same model id. Level changes are free here — flat
per-request billing — so raise the level on a role whose output is bad before
changing the model.

## 5. Cache lifetime

`providers.cacheRetention: long` sends `ttl: "1h"` on `cache_control`. Verified:
the gateway accepts it and replays from cache. `providers.cacheWarming: idle`
then replays the last request before expiry, so a session left open for lunch
resumes on a warm prefix.

Warming only runs when the avoided-miss cost exceeds the refresh cost by $0.05.
With `cost` set to `0` for these models, warming is effectively inert — the
`promptCache: {short: 300, long: 3600}` declaration is what matters.

`vilao` is the one provider with non-zero `cost` rates (0.031285 USD/Mtok, §1a),
but they are ~30x too low to reach the $0.05 warming threshold: a 200k-token
prefix costs $0.0063 to re-send. Warming stays inert for every provider in use.
