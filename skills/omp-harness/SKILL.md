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
- **Duplicate.** A read whose content is still live in the session is refused with the `[name#TAG]` anchor already held: `blocked: big.ts (lines 181-360) is already in context as [big.ts#B12D]; reuse it.` Since `1.2.1` the refusal also states the file's line count and the next unread slice (`The file has 451 lines. Lines 181-451 are not in context; read big.ts:181-360 for the rest.`), and an over-wide repeat whose narrowed prefix is already held is served as its **uncovered tail** (`big.ts:1-400` → rewritten to `big.ts:181-360`) instead of refused. Measured 2026-11-09 against 104 duplicate-read refusals in three days of transcripts: weak models (`vilao/minimax-m3.1-flash`, `local-relay/north-mini-code`) retried the dead end instead of asking for the next slice.
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
- `ramclouds` — was prepaid-exhausted on 2026-10-19 (`$0.000438` remaining); funded and serving again on 2026-11-09. Live list and probe results: §1c.
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

**2026-11-09: `/v1/models` advertises entitlements the key cannot use.** `GET /v1/models`
lists six active rows — `minimax-m3.1-flash`, `glm-5.3-flash`, `zai-org/glm-5.3-flash`,
`cl​aude-fable-5.1`, `cl​aude-opus-5-5`, `cl​aude-haiku-5-5` — but `POST /v1/messages`
answers `200` only for the first three. `cl​aude-haiku-5-5`, the `bee-tok/` prefixed
form of the same id, and `cl​aude-opus-5-5` all return
`403 permission_error: "Please subscribe to model in the API Key"`, which is why the
Nov 6-9 logs carry 18 such turn-killers. Treat the catalogue as a **list of candidates,
not a capability statement**: probe the id with one `POST /v1/messages` before putting
it in a role, and keep `modelRoles`/`compaction.modelThresholds` on ids that answered
`200`. The two dead `modelThresholds` rows were removed from
`~/.omp/agent/config.yml` on 2026-11-09.

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

- Combo row **2026-11-09**: `openrouter/recursive/flint-v1.0:free`,
  `openrouter/cohere/north-mini-code:free`,
  `openrouter/dots-studio/dots-3-note-preview:free`,
  `openrouter/xingchen-agi/xing4.0-29b-a4b:free`, `oc/mimo-v2.6-flash-free`.
  All five answered a `tools` + `tool_choice:"none"` request with `200`; flint,
  cohere, dots and xing4.0 also emitted real `tool_calls`. Backup of every earlier
  row: `~/AppData/Roaming/9router/backups/omp-fix-*/combos.json`. Members removed
  that day, with the measured failure:
  - `openrouter/stealth/crouton-alpha` — `400 Provider returned error` **only** when
    the body carries `tool_choice:"none"` together with `tools`; the same body with
    `tool_choice:"auto"` or no `tool_choice` returns `200`, and with a full token
    budget it emits real `tool_calls`. omp sends `tool_choice:"none"` on no-tools
    turns, so the failure is deterministic per turn type, not per request size. It
    was the **first** member, so all 96 captured HTTP-400 bodies in
    `~/.omp/logs/http-400-requests/` were this entry — every one
    `local-relay/north-mini-code`, every one ≥ 544 KB / ≥ 393 messages.
  - `openrouter/google/lyria-3-pro-preview`, `openrouter/thinkingmachines/inkling:free`,
    `openrouter/thinkingmachines/inkling-small:free` — `404 No endpoints found` /
    `This model is unavailable for free`.
  - `oc/ling-3.1-flash-free` — `400 Model is unavailable` (documented 2026-10-23).
  - `oc/mimo-v2.6-flash-free` answers `429 FreeUsageLimitError` once the daily free
    cap is spent; keep it last rather than first.
  - All kept members are reasoning models with high reasoning-token overhead:
    `max_tokens: 200` returns `finish_reason:"length"` with `content: null` because
    200-760 reasoning tokens are spent first. omp sends `max_completion_tokens:
    16384`, which is enough; a harness/CLI that pins a small `max_tokens` through
    this combo will see empty completions.
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
  `if(!i&&!([406,410].includes(b.status)||(400===b.status&&/unavailable|not found|deprecated|not supported|does not exist|provider returned error/i.test(String(f)))))return …`
  so a dead combo entry is skipped. `provider returned error` was added 2026-11-09
  because that is the exact OpenRouter text for a broken upstream, and the previous
  regex did not match it — one bad first member aborted the whole combo.
  **Lost on `npm i -g 9router@…`** — re-apply, or keep the combo list free of dead entries.

Restart: kill the server PID; the `cli.js` supervisor respawns it in a few seconds.
DB combo edits apply without a restart; the chunk patch does not.

Verification that matters: the exact 544 KB, 393-message body that 400'd before now
returns `200` through `north-mini-code` (served by `recursive/flint-v1.0`), and a real
tool-using subagent turn on `local-relay/north-mini-code` completes without a paid
fallback. **The relay is in use again** — 57 `model_change` entries and 96 captured
400s across 2026-11-06..09 transcripts, so the "nothing routes to the relay" note of
2026-10-27 no longer holds; keep this section current whenever the combo drifts.

## 1c. `ramclouds` — live again 2026-11-09, `glm-5.3-flash` is the subagent primary since 2026-11-10

`GET https://ramclouds.me/v1/models` with `RAMCLOUDS_API_KEY` returned **12 ids**
on 2026-11-09; the 25-id list recorded on 2026-09-13 is gone upstream:
`deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.3`, `qwen-3.8-flash`, `qwen-3.8-max`,
`MiniMax-M3`, the four `gemini-3.x-flash*`, `gpt-5.6-luna`, `grok-4.5`, `grok-4.6`,
`grok-composer-2.5-fast`, `kimi-k2.7-code`, `kimi-k3`, `mimo-v2.5`,
`grok-imagine-image-2.0`, `grok-imagine-image-edit` all answer 503/404 now.

Live: `crouton-alpha`, `agnes-3.0-flash`, `deepseek-v4.1-flash`,
`deepseek-v4.1-flash-1017`, `glm-5.3-flash`, `gpt-5.5-chat`, `gpt-6`, `mercury-3`,
`laguna-s-2.1`, `laguna-xs-2.1`, `gpt-image-2`, `dall-e-3`.
`~/.omp/agent/models.yml` was reconciled to exactly these 12 on 2026-11-09; the old
"ramclouds does not serve deepseek-v4.1-flash" note is stale.

**Wire caveats (probed 2026-11-09, this key):**
- A bare `urllib`/`curl` User-Agent gets Cloudflare **1010** on
  `/v1/chat/completions`; `/v1/models` answers either way. Send a browser UA when
  probing by hand. omp is unaffected.
- `crouton-alpha` resolves to upstream **`stealth/crouton-alpha`** (OpenRouter
  provider "Stealth") and returns its own id, not `crouton-alpha`, in responses.
- `tools` + `tool_choice:"auto"` → real `tool_calls` with streamed arguments.
  A full assistant-tool_call → tool_result → answer loop completes.
  **`tools` + `tool_choice:"none"` → 400 `Provider returned error`** — the same
  stealth-upstream defect that removed it from the 9router combo (§1b).
- It is a reasoning model: reasoning tokens are spent before content, so a small
  `max_tokens` yields `content:null` + `finish_reason:"length"`. `reasoning:{effort}`
  and `reasoning_effort` both accept low/high. omp line-probe with the full system
  prompt: 48,821 input tokens accepted, 2 turns (one `bash` tool call) in 20 s;
  a 4-message tool loop took 80.7 s — **latency, not correctness, is the risk.**
- `contextWindow`/`maxTokens` are not in the gateway payload; every value in
  `models.yml` is a conservative cap. `glm-5.3-flash` is declared 131072/16384, so
  `compaction.modelThresholds["ramclouds/glm-5.3-flash"] = f104000` (80% of 131072)
  and the subagent `agentCompactionThresholdOverrides` dropped 160000 → 104000 —
  a 131K model behind a 160K ceiling hard-fails instead of compacting.
  `crouton-alpha`'s 200K threshold row was retired with the routing.

**Routing since 2026-11-10** (supersedes the split tables in §1d and §3 for
subagents): `task.agentModelOverrides` for all 16 agents = `ramclouds/glm-5.3-flash:max`,
`modelRoles.task` = `ramclouds/glm-5.3-flash:max`, and
`retry.fallbackChains["ramclouds/glm-5.3-flash"] = [vilao/minimax-m3.1-flash:max]`.
The pre-existing `fallbackChains.subagent` and `.default` entries already resolve to
`vilao/minimax-m3.1-flash:max`, so a glm failure lands on minimax either way.
`crouton-alpha` keeps its catalogue entry but is in no role.

### Why `max` — measured obedience battery, 2026-11-10

Six probes per level against `POST /v1/chat/completions` (browser UA, `tools` present,
system prompt = "execute the spec literally, never explain"):

|Probe|`low`|`high`|`max`|
|---|---|---|---|
|3 exact lines, no markdown|pass 2.6s|pass 3.0s|pass 8.3s|
|exact tool args, 1 call|pass 2.8s|pass 6.3s|pass 5.6s|
|"do not call a tool"|pass, 0 calls|pass, 0 calls|pass, 0 calls|
|**main-agent instruction over system suffix**|**refused**|**refused**|**`GO\n\nSTOP`**|
|one call when tempted twice|pass 11.1s|pass 8.8s|pass 2.0s|
|exact `OK` after 25 lines of context|pass 3.3s|pass 6.0s|pass 2.3s|

Only `max` followed the main agent's content instruction when the system prompt
demanded a suffix — `low`/`high` answered "I can't ignore my instructions" and
emitted the mandated token instead. Nothing regressed at `max`, and it was not
slower overall. Consequence: pin `:max`, do not drop the level to save tokens.

`glm-5.3-flash` has **none** of `crouton-alpha`'s wire defects: `tools` +
`tool_choice:"none"` returns 200 (the body that 400s on crouton), a no-tools turn
returns text, and a full `omp -p` tool loop completes in 26 s. It also self-identifies
as "AutoClaw" and may add a greeting when the prompt is one word — harmless for
spec-driven subagent work, confusing if a subagent answer is read verbatim.

## 1d. Subagent routing (relay split verified 2026-10-23, vilao split 2026-10-27)

`task.agentModelOverrides` beats `modelRoles.<role>`. Setting only
`modelRoles.task: vilao/…` does nothing while
`task.agentModelOverrides.task` names another model.

Current split — mechanical work on vilao (flat per-request), judgment on paid
per-token models:

| Agent | Model |
|---|---|
| `task`, `coder`, `scout`, `sonic`, `researcher`, `harness-grader`, `seance` | `vilao/claude-haiku-5-5` |
| `reviewer`, `security-reviewer`, `harness-proposer`, `session-orchestrator`, `architect` | `ns24/deepseek-v4.1-flash:high` |

Route "where is X / how does Y connect" exploration to `scout` (read-only, `read grep glob lsp`, bounded `file:line` summary) instead of reading many files in the main context.

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

## 6. Model role tiers

| Tier | Selector | Budget | Role |
|---|---|---|---|
| `T1_MECHANICAL` | `ramclouds/glm-5.3-flash:max` | 12 | Subagent mechanical work — research, file reading, grading, coder, title generation |
| `T2_STANDARD` | `ns24/deepseek-v4.1-flash:high` | 18 | Judgement work — review, security review, architect |
| `T3_DEEP_REASONING` | `ns24/deepseek-v4.1-flash:max` | 24 | Complex reasoning — planning, deep analysis, hard agent overrides |
| `T4_PREMIER` | `openai-codex/gpt-6-luna:max` | 24 | Premier — plan and advisor roles, complex code generation |

`task.agentModelOverrides` beats `modelRoles.<role>`. Setting only
`modelRoles.task` does nothing while `task.agentModelOverrides.task` names
another model. `task.maxRecursionDepth: 1` — a subagent may not spawn its own
children.

## 7. Auto-Ontology layer

The harness runs an Auto-Ontology pipeline on every project `cwd`:

- `ontology_check` — scans the project for certified terms and computes ontology
  coverage against the Zero-Mem SQLite DB from `dbPath(cwd)`.
- `ontology_compile` — compiles discovered terms into `.omp/ontology/domain-ontology.yaml`
  (Ossie YAML format).
- **0..1 coverage gate** — default threshold `0.6`. Coverage below the gate
  triggers deeper subagent analysis before routing.
- **Certified terms** (`certified = 1`) receive a `1.35×` retrieval boost in
  Zero-Mem unit scoring.
- `certifiedOnly` exclusion — when set, only certified terms are eligible for
  retrieval, excluding all non-certified units.
- Storage is the Zero-Mem SQLite DB at
  `<projectRoot>/.omp/memory/zero-mem/<dataset>/memory.db`, where `<dataset>`
  is `<slug>-<hash12>` from `datasetName(cwd)` in `src/zeromem.ts`.

## 8. Four-tier router

The router selects a delegation tier from structural signals (never prompt
length). Inputs: entity count, cross-module spread, ontology coverage,
reversibility risk, ambiguity.

Precedence order (mirrors `computeTaskComplexity` in `src/superagent.ts`):

1. `/\b\/plan\b/` in the text, or `agent === "advisor"` → **T4_PREMIER**, reason `premier-advisor`
2. else agent in `architect|reviewer|security-reviewer|plan-reviewer|harness-proposer|session-orchestrator`, or `ambiguityScore > 0.35`, or `reversibilityRisk >= 0.5` → **T3_DEEP_REASONING**, reason `deep-reasoning-or-risk`
3. else `crossModuleSpread >= 3`, or agent in `debugger|plan-drafter` → **T2_STANDARD**, reason `cross-module-or-standard`
4. else → **T1_MECHANICAL**, reason `mechanical-bounded`
5. after 2+ `degradedRetries`, escalate one tier and append `:escalated` to `reason`

Tier depends on structural signals, never prompt length.

## 9. Unified CLI matrix

| CLI | MCP server | Hooks |
|---|---|---|
| OMP CLI (`~/.omp/agent`) | `omp-harness` (`node D:/omp-harness/scripts/omp-harness-mcp.mjs`) | Not applicable — OMP uses its own hook system |
| Claude CLI (`~/.claude`) | `omp-harness` (`node D:/omp-harness/scripts/omp-harness-mcp.mjs`) | `memory-intake.mjs` (UserPromptSubmit / Stop) |

Claude CLI reaches omp-harness tools **only** through
`scripts/omp-harness-mcp.mjs`, configured as a stdio MCP server with
`OMP_HARNESS_JEV=1`, `TYPESAFE_BASE_URL=https://api.ns24.io`,
`OMP_HARNESS_JEV_MODEL=jev`, and
`JEV_KEY_FILE=C:/Users/ADMIN/.config/typesafe/key`.
