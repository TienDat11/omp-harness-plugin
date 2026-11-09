---
title: Measure-First Harness Upgrade - Plan
type: feat
date: 2026-11-09
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan (brainstorm in session)
execution: code
origin: docs/X-REDDIT-HARNESS-RESEARCH.md
---

# Measure-First Harness Upgrade - Plan

## Context
Người dùng muốn nâng cấp omp-harness để agent đạt pass rate cao hơn, rẻ hơn và tự chạy lâu hơn. Plan dựa trên `docs/X-REDDIT-HARNESS-RESEARCH.md`. Khi đối chiếu với code, phần lớn U1–U8 trong research đã có một phần, hoặc trùng tính năng sẵn có. Chỗ thật sự thiếu là **số đo**: chưa biết lần chặn nào của verify-gate có ích, chưa đo wall time thật, chưa có cảnh báo cache, và probe đã bão hòa nên gate không chứng minh được cải tiến. Plan này dựng lớp đo trước (PR1), sau đó mới làm 3 cải tiến sau cờ (PR2–PR4), mỗi cải tiến phải chứng minh bằng số liệu.

> On approval this file is copied to `docs/plans/2026-11-09-001-feat-measure-first-harness-upgrade-plan.md` (force-added, because `docs/` is gitignored, same as the existing specs), together with `docs/X-REDDIT-HARNESS-RESEARCH.md` from the main checkout.

## Goal Capsule

- **Objective:** Người dùng omp-harness thấy được bằng số liệu thật mỗi agent session pass bao nhiêu, tốn bao nhiêu, chạy được bao lâu mà không cần can thiệp. Mỗi cải tiến workflow sau đó chỉ được bật mặc định khi số liệu chứng minh nó tốt hơn.
- **Means:** đào transcript và `harness.log` có sẵn bằng hàm thuần, dùng chung cho script và `harness_record` (KTD1). Sau đó là ba cải tiến sau cờ cấu hình, mỗi cái qua gate `d_in/d_ho` với probe nhắm đúng (KTD4).
- **Thứ tự ưu tiên khi các nguồn mâu thuẫn:** R-IDs > KTDs > Units. Research doc chỉ là nguồn tham khảo. Nếu nó mâu thuẫn với code thì code đúng (xem Sources).
- **Điều kiện dừng:**
  - (a) Spike ở U7 không ghép được `tool_call` với `before_subagent_spawn` một cách xác định: dừng U7, ghi lại kết quả, không đoán.
  - (b) Baseline ở U2 cho thấy một vấn đề đã nhỏ hơn ngưỡng đáng sửa. Ví dụ ignoredRate < 5%: bỏ unit tương ứng ở pha 2 và báo lại.
  - (c) Bất kỳ thay đổi nào làm tụt cache reuse của probe (`compare.mjs` exit 2): revert.
- **Cách triển khai:** 4 PR nối tiếp. Worker là `worker-coder` (Sonnet), kiểm chứng bằng `code-verifier`. Orchestrator tự review từng PR rồi mở draft PR, không tự merge.

## Product Contract

### Summary
Thêm một lớp đo lường suy ra hoàn toàn từ dữ liệu omp đã ghi: transcript session (có timestamp, có entry `session-stop-continuation`) và `harness.log` (G1/W1/W2/M1). Lớp này cho baseline ngay hôm nay từ 3617 session lịch sử. Sau đó ba cải tiến (verify-gate v2, agent scout chỉ-đọc, nâng model khi worker fail) được đưa vào sau cờ, và chỉ bật mặc định khi probe gate cùng số liệu đào được đều không tụt.

### Problem Frame
Research doc đề xuất U1–U8, nhưng đối chiếu code cho thấy phần lớn đề xuất không đo được hiệu quả:
- verify-gate đã re-prompt (`src/verify-gate.ts:243-247`) nhưng không ai biết lần chặn nào có ích.
- `wall_ms` do model tự khai (`src/tools.ts:16`).
- Không có cảnh báo cache lúc runtime.
- Probe gate đã bão hòa (8/8 pass) nên không thay đổi nào chứng minh được `max>0`.

Dữ liệu thật cho thấy có vấn đề đáng sửa: `~/.omp/harness/harness.log` có 181 lần chặn (rc=40), 37 lần chạm trần 3 lượt (rc=41), 118 lần edit-thrash (W2 k=30) và 73 worker degraded (W2 k=33). Nhưng chưa có cách nào nối các con số đó với kết quả task.

### Requirements

**Đo lường (pha 1)**
- R1. Mỗi lần verify-gate chặn trong transcript được phân loại thành đúng một nhãn: `verified_pass`, `verified_fail`, `declared_no_check`, `user_took_over` hoặc `ignored`. Ngoài ra có hai cờ phụ: `unnecessary` (lần kiểm chứng đầu tiên sau khi chặn đã pass và không có edit nào trước nó) và `caught` (có verify fail rồi sau đó pass).
- R2. Thời gian làm việc thực (`activeWallMs`) được đo từ timestamp transcript, loại các khoảng nghỉ dài hơn `idleGapMs` (mặc định 300000).
- R3. Một lệnh offline xuất báo cáo tổng hợp toàn bộ session, chỉ gồm số đếm và tỷ lệ, không chứa nội dung tin nhắn hay đường dẫn file của người dùng. Báo cáo gồm:
  - phân phối nhãn chặn, `falseBlockRate = unnecessary/blocks`, `catchRate = caught/blocks`, `ignoredRate`;
  - phân phối `activeWallMs` (p50/p95);
  - cache reuse theo provider/model (p10/p50);
  - số worker fail/degraded và edit-thrash.

  Lệnh có thể ghi báo cáo thành baseline.
- R4. `harness_record` gắn khối `metrics` (R1 và R2 của session hiện tại) vào `outcome.json`. Khi `wall_ms` đầu vào bằng 0, giá trị đo được sẽ thay thế, giống cách `tokens` đang được thay (`src/tools.ts:409`).
- R5. Khi cache reuse của một session chính (không phải subagent) tụt dưới ngưỡng của provider đó sau giai đoạn khởi động, harness ghi một dòng `C1` vào `harness.log` và hiện cảnh báo UI, mỗi session một lần. Cảnh báo không bao giờ được chèn vào context của model.

**Cải tiến có kiểm chứng (pha 2)**
- R6. verify-gate v2 (cờ `harness.verifyGate.v2`):
  - Tin nhắn chặn nêu đúng lệnh kiểm chứng của project, lấy từ `package.json` scripts `test`/`verify`/`typecheck`/`lint` nếu có.
  - Không chặn khi mọi file bị sửa là tài liệu (`.md`, `.txt`).
  - Ở lượt cuối trước trần, tin nhắn yêu cầu agent hoặc chạy lệnh kiểm chứng, hoặc tuyên bố rõ ràng là không có check nào áp dụng.
- R7. Có agent `scout` chỉ-đọc dùng model rẻ cho việc khám phá codebase. Tên `scout` đã nằm sẵn trong `READ_ONLY_AGENTS` (`src/verify-gate.ts:65-77`), nên verify-gate coi nó là không sửa file.
- R8. Nâng model khi worker fail (cờ `harness.escalation.enabled`): khi một task có cùng chữ ký với một lần dispatch trước đó đã fail (W1 st=2/3) được dispatch lại, subagent mới chạy bằng model mạnh đã cấu hình. Mỗi chữ ký chỉ được nâng một lần, và lần nâng được ghi log.
- R9. Mỗi cải tiến pha 2 chỉ được bật mặc định khi thỏa cả hai điều kiện:
  - (a) `harness_gate` chấp nhận, với một probe held-in mới fail ở baseline và pass ở candidate;
  - (b) báo cáo đào được trong khoảng thời gian bật cờ không tệ hơn baseline ở các chỉ số của R1/R3 mà nó nhắm tới, với tối thiểu 20 lần chặn (R6) hoặc 10 lần dispatch liên quan (R7/R8).

### Key Decisions
- **Đo trước, sửa sau; cân bằng pass/chi phí/tự chạy.** (session-settled: user-directed — chọn thay vì chỉ làm MVP U1+U5 hoặc làm toàn bộ roadmap: cần số liệu trước khi đầu tư.) Governs R1–R9.
- **Đào transcript thay vì ghi sự kiện runtime hay dùng SQLite.** (session-settled: user-approved — chọn thay vì metrics.jsonl runtime hoặc thêm bảng vào SkillTelemetryStore: có baseline ngay từ lịch sử và không thêm state runtime.) Governs R1–R4.
- **U3 worktree isolation và U8 elapsed-time injection hoãn sang đợt sau.** Báo cáo R3 cung cấp baseline (p95 wall, worker fail) để quyết định đợt đó. Bỏ U2 và U7 của research vì trùng với tính năng đã có (`recordFileEdit`, `intake_open`).

### Scope Boundaries
- Không đổi model hay effort giữa session. Không thêm hoặc bớt tool giữa session. Mọi nội dung chèn vào context chỉ đi qua tail message `display:false` (giữ bất biến cache, research §2.1).
- Không gửi số liệu ra ngoài máy. Báo cáo không chứa prompt hay nội dung code.
- Không dùng `decision:"block"` của host. Giữ `continue:true` với trần 3.
- Không đụng REA MCP boundary (§3.3 research), không có code liên quan.

## Planning Contract

### Key Technical Decisions
- KTD1. **Module thuần `src/session-metrics.ts`**, không đăng ký extension. Module tái sử dụng `parseSessionText`/`resolveBranch` (`src/telemetry.ts:30,66`), `classifyVerifyCommand` (`src/verify-gate.ts:27`) và `cacheReuse` (`src/telemetry.ts:296`). Mọi API là hàm `(entries, opts) → plain object`, không đụng I/O, để script, `harness_record` và test dùng chung. (Owns R1, R2.)
- KTD2. **Phân loại lần chặn theo cửa sổ.** Một cửa sổ bắt đầu từ entry `custom_message` có `customType:"session-stop-continuation"` và kết thúc ở continuation kế tiếp, user message kế tiếp hoặc cuối nhánh.
  - Ghép tool call với kết quả qua `toolCallId` giữa block `toolCall` của assistant và `toolResult`.
  - Nhãn được xét theo thứ tự ưu tiên: có verify → `verified_pass`/`verified_fail` theo lần verify cuối; không verify mà assistant có câu khớp regex "no check applies" (EN/VI) → `declared_no_check`; cửa sổ kết thúc bằng user message → `user_took_over`; còn lại → `ignored`.
  - Chỉ phân tích nhánh đang hoạt động (`resolveBranch`). (Owns R1 mechanism.)
- KTD3. **Cảnh báo cache là extension mới `src/cache-alert.ts`**, đăng ký trong `package.json` `omp.extensions` và `harness.manifest.json`.
  - Nghe `message_end` của assistant trong session chính và dùng cửa sổ trượt 10 lượt, sau tối thiểu 5 lượt có usage.
  - Ngưỡng theo provider lấy từ config `harness.cacheAlert.thresholds`. Giá trị mặc định là p10 lịch sử theo provider đo được ở U2; nếu không có dữ liệu thì dùng 0.80 (theo ngưỡng "<80% = investigate" của Anthropic).
  - `summarizeHarnessLog` được mở rộng để đọc mã `C1` (`src/state.ts:231` regex `[SMWEG]` → thêm `C`). (Owns R5.)
- KTD4. **Probe bão hòa nên mỗi cải tiến pha 2 tự mang theo một probe held-in mới**, fail ở baseline và pass ở candidate. Bộ held-out giữ nguyên để làm lưới chống tụt (`d_ho>=0`). Định nghĩa probe nằm trong `probes/` (gitignored, chỉ có ở `D:\omp-harness\probes`), nên mỗi PR pha 2 kèm theo bản sao probe dưới `tests/fixtures/probes/` để review được, và tài liệu ghi lệnh chép sang `probes/`. (Owns R9a.)
- KTD5. **Nâng model đi qua `before_subagent_spawn`.** Hook trả `{model}` (`HOST/extensibility/extensions/types.ts:1175-1186,1739-1747`). Hook không có nội dung task, nên superagent phải lưu chữ ký task ở `tool_call` (`src/superagent.ts:1632`), rồi khớp với hook spawn ngay sau đó qua `spawnKey` hoặc thứ tự FIFO trong cùng lượt. Mỗi lần nâng là một subagent mới, cache riêng, đúng với research §2.2-D. Spike quyết định cách khớp. (Owns R8 mechanism.)
- KTD6. **Cờ pha 2 đọc qua đường cấu hình hiện có của từng extension**, mặc định tắt. Bật mặc định là một commit riêng, kèm bằng chứng R9.

### High-Level Technical Design
```
~/.omp/agent/sessions/**/*.jsonl ─┐                ┌─> scripts/mine-sessions.mjs ─> report / .omp/harness/metrics-baseline.json
~/.omp/harness/harness.log ───────┼─> session-metrics.ts (pure) ─┤
current session file ─────────────┘                └─> harness_record ─> outcome.json.metrics

message_end (assistant usage) ─> cache-alert.ts ─> harness.log "C1 …" + ui.notify   (never model context)

Phase 2 (flags off) ─> probe held-in mới + harness_gate ─> shadow window ─> mine --since ─> so với baseline ─> bật mặc định
```

### Sequencing
PR1 (pha 1) → ghi baseline thật → PR2/PR3/PR4 song song được (chạm file khác nhau: verify-gate / agents / superagent), mỗi PR tự qua R9.

### Risks & Dependencies
- **Nhánh nền.** `worktree-subagent-learning-plan` đi trước `main` 26 commit, sửa `src/tools.ts` và `src/superagent.ts`. PR1 tách nhánh từ nhánh này, và chỉ merge sau khi PR subagent-learning đã merge.
- **Lịch sử transcript ít mẫu.** Chỉ 30/3617 session có lưu entry continuation (runtime 18.14.1 trở lên), trong khi `harness.log` có 181 lần chặn. Báo cáo phải in ra số mẫu, và tỷ lệ chỉ được tính khi có tối thiểu 20 mẫu. Dưới mức đó in `insufficient`.
- **Test và log.** `logHarnessCode` không làm gì trong test trừ khi đặt `OMP_HARNESS_LOG_PATH` (`src/state.ts:198`). Test cho `C1` phải đặt biến này. Fake `sendMessage` sẽ throw (`tests/_fake-pi.ts`), nên cache-alert chỉ dùng `ui.notify` và log.
- **Bundle integrity.** `scripts/verify.mjs` kiểm tra manifest và checksum. Extension hoặc agent mới phải cập nhật `harness.manifest.json`, nếu không `npm run verify` fail.

## Implementation Units

### PR1 — Measurement foundation
Phụ thuộc: PR subagent-learning phải merge vào `main` trước. Không cần deploy.

### U1. Bộ phân tích transcript thuần
- **Goal:** Hiện thực R1, R2 theo KTD1, KTD2.
- **Requirements:** R1, R2.
- **Files:** `src/session-metrics.ts` (mới), `tests/session-metrics.test.ts` (mới), `tests/fixtures/sessions/*.jsonl` (mới, transcript tổng hợp nhỏ, không dùng dữ liệu thật).
- **Approach:**
  - Export `classifyStopBlocks(entries, {isVerify?})`, `activeWallMs(entries, {idleGapMs?})` và `summarizeSessionMetrics(entries)`.
  - Nhận dạng tool call theo cùng cách `src/telemetry.ts:143-175` đang đọc block `toolCall`.
- **Test scenarios:**
  - Mỗi nhãn của R1 có một fixture riêng.
  - `unnecessary` và `caught`.
  - Hai lần chặn liên tiếp, lần đầu `ignored`.
  - Nhánh bị rẽ (`parentId`): chỉ đếm nhánh hoạt động.
  - Khoảng nghỉ 2 ngày bị loại khỏi `activeWallMs`.
  - Dòng hỏng hoặc cuối file chưa flush không throw.
- **Verification:** `node --test tests/session-metrics.test.ts` pass.

### U2. Script đào dữ liệu và baseline
- **Goal:** Hiện thực R3.
- **Requirements:** R3.
- **Files:** `scripts/mine-sessions.mjs` (mới), `package.json` (`"mine": "node scripts/mine-sessions.mjs"`), `harness.manifest.json`, `tests/mine-sessions.test.ts` (mới).
- **Approach:**
  - Cờ: `--sessions <dir>` (mặc định `~/.omp/agent/sessions`), `--log <path>` (mặc định `globalHarnessLogPath()` ở `src/state.ts:171`), `--since <ISO>`, `--project <slug>`, `--json`, `--record-baseline` (ghi `.omp/harness/metrics-baseline.json`).
  - Chỉ số từ log dùng lại cách parse của `summarizeHarnessLog`.
  - Cache theo provider đọc từ `model_change` và usage của assistant.
  - Exit code: 0 khi thành công, 2 khi lỗi đầu vào.
- **Test scenarios:**
  - Thư mục fixture cho số đếm đúng.
  - `--since` lọc đúng.
  - Dưới 20 mẫu thì in `insufficient`.
  - Output không chứa chuỗi nội dung của fixture (kiểm tra privacy).
- **Verification:** test pass. Chạy `npm run mine -- --json` trên máy thật, in ra số mẫu chặn và phân phối nhãn.

### U3. Gắn metrics vào outcome.json
- **Goal:** Hiện thực R4.
- **Requirements:** R4.
- **Files:** `src/tools.ts` (đường legacy quanh `:500` và đường learning `buildLearningOutcomeJson` `:403-418`), `tests/telemetry-totals.test.ts`.
- **Approach:**
  - Ở cả hai đường, sau `summarizeSessionFile`, gọi `summarizeSessionMetrics` trên cùng file và gắn kết quả vào `metrics`.
  - Thay `wall_ms` khi đầu vào bằng 0.
  - Replay của đường learning phải giữ nguyên bytes đã lưu, không tính lại.
- **Test scenarios:**
  - outcome có `metrics` khi có session file.
  - Không có session file thì không có khóa `metrics`.
  - `wall_ms:0` bị thay bằng giá trị đo.
  - `wall_ms>0` được giữ nguyên.
  - Replay learning cho bytes y hệt.
- **Verification:** `npm test` pass toàn bộ.

### U4. Cảnh báo cache theo provider
- **Goal:** Hiện thực R5 theo KTD3.
- **Requirements:** R5.
- **Files:** `src/cache-alert.ts` (mới), `src/state.ts` (`summarizeHarnessLog`), `package.json`, `harness.manifest.json`, `config/recommended.yml` (thêm `harness.cacheAlert`), `tests/cache-alert.test.ts` (mới).
- **Approach:**
  - Ngưỡng mặc định lấy từ baseline U2 (p10 theo provider) và ghi vào `config/recommended.yml`.
  - Bỏ qua khi `ctx.agent.kind === "sub"`.
- **Test scenarios:**
  - Dưới 5 lượt thì không cảnh báo.
  - Tụt dưới ngưỡng thì có đúng một dòng `C1` và một notify.
  - Tụt lần thứ hai trong cùng session thì không cảnh báo thêm.
  - Subagent bị bỏ qua.
  - Provider không có trong map thì dùng 0.80.
  - `summarizeHarnessLog` đếm được `C1`.
- **Verification:**
  - `npm test` và `npm run verify` pass.
  - `npm run probes` rồi `npm run compare` không báo cache regression (exit khác 2).

### PR2 — verify-gate v2
Phụ thuộc: PR1 phải merge, và baseline phải được ghi bằng `npm run mine -- --record-baseline`.

### U5. verify-gate v2 sau cờ
- **Goal:** Hiện thực R6 và giảm `ignoredRate`/`falseBlockRate` mà không giảm `catchRate`.
- **Requirements:** R6, R9.
- **Files:** `src/verify-gate.ts`, `tests/verify-gate.test.ts`, `config/recommended.yml`, `tests/fixtures/probes/verify-gate-v2.jsonl` (mới) cùng fixture.
- **Approach:**
  - Đọc `package.json` ở `ctx.cwd` một lần cho mỗi session.
  - Thông điệp chặn vẫn là `additionalContext` của `continue:true` (`src/verify-gate.ts:243-247`).
  - Bỏ qua chặn khi mọi đường dẫn trong `state.mutatedFiles` là tài liệu.
- **Test scenarios:**
  - Cờ tắt thì hành vi y hệt hiện tại (snapshot thông điệp).
  - Cờ bật và có `scripts.test` thì thông điệp chứa `npm test`.
  - Chỉ sửa `.md` thì không chặn.
  - Lượt thứ 3 có câu yêu cầu tuyên bố.
  - Probe mới: fixture có `npm test` fail, model phải sửa rồi báo kết quả.
- **Verification:**
  - `npm test` pass.
  - `harness_gate` chấp nhận (probe mới thuộc held-in).
  - Bật cờ, đợi tối thiểu 20 lần chặn, chạy `npm run mine -- --since <ngày bật>` so với baseline theo R9b.

### PR3 — Scout agent chỉ-đọc
Phụ thuộc: PR1 phải merge.

### U6. `agents/scout.md`
- **Goal:** Hiện thực R7.
- **Requirements:** R7, R9.
- **Files:** `agents/scout.md` (mới, cùng format frontmatter với `agents/harness-grader.md`), `harness.manifest.json`, `skills/omp-harness/SKILL.md` (một dòng định tuyến), `tests/manifest.test.ts`, probe held-in mới.
- **Approach:**
  - Model `@smol`, tools `[read, grep, glob, lsp]`, không có bash/write.
  - Output là một bản tóm tắt có giới hạn độ dài, kèm `file:line`.
- **Test scenarios:**
  - Manifest có scout.
  - `isMutatingTaskCall({agent:"scout"})` là false.
  - Probe: câu hỏi khám phá trên fixture nhiều file, được chấm theo đúng `file:line` và tổng token/session thấp hơn baseline (`sessionTotals`).
- **Verification:** `npm test`, `npm run verify` và `harness_gate` pass.

### PR4 — Nâng model khi worker fail
Phụ thuộc: PR1 phải merge.

### U7. Escalation qua `before_subagent_spawn`
- **Goal:** Hiện thực R8 theo KTD5.
- **Requirements:** R8, R9.
- **Files:** `src/superagent.ts`, `config/recommended.yml` (`harness.escalation.{enabled,strongModel}`), `tests/superagent.test.ts`, probe held-in mới.
- **Approach:**
  - Bước 1 là spike: đọc chỗ host phát `before_subagent_spawn` để xác định `spawnKey` có mặt với task tool không, và hook có luôn chạy ngay sau `tool_call` cùng lượt không. Nếu không khớp được một cách xác định thì áp dụng điều kiện dừng (a).
  - Chữ ký task là `hash(agent + normalized assignment)`. Dùng lại cách băm trong subagent-learning nếu có.
  - Log `W2 k=40` khi nâng model.
- **Test scenarios:**
  - Fail rồi dispatch lại cùng chữ ký thì hook trả `{model: strongModel}`.
  - Lần thứ ba thì không nâng nữa.
  - Chữ ký khác thì không nâng.
  - Cờ tắt thì hook trả `undefined`.
  - Subagent-learning vẫn chọn prompt như trước (regression).
- **Verification:**
  - `npm test` và `harness_gate` pass.
  - Shadow window đạt tối thiểu 10 lần nâng. `computeAcceptedTaskCost` không tăng so với baseline.

## Verification Contract
- Mọi PR: `npm test` (= `node --test`) và `npm run verify` đều pass. Bằng chứng là output của lệnh, không phải lời kể.
- PR chạm runtime (U4–U7): `npm run probes` cho cả baseline và candidate, rồi `npm run compare`. Exit 0 là bắt buộc để bật mặc định. Exit 2 (cache regression) kích hoạt điều kiện dừng (c).
- Gate: `harness_gate` với `d_in>=0 AND d_ho>=0 AND max>0` (`src/tools.ts:586-588`), với probe mới của unit nằm ở held-in.
- Số liệu thật: `npm run mine -- --json` trước và sau, so theo R9b. Báo cáo kèm số mẫu.

## Definition of Done
- **PR1:**
  - Báo cáo baseline thật đã được ghi.
  - Có một đoạn tóm tắt baseline (số mẫu, ignoredRate, falseBlockRate, catchRate, p50/p95 activeWallMs, p10 cache theo provider) trong mô tả PR.
  - `C1` hiện trong `/harness-stack` summary khi giả lập tụt cache.
- **Mỗi PR pha 2:**
  - Cờ mặc định tắt khi merge.
  - Có commit bật mặc định riêng, chỉ khi R9 thỏa, kèm số liệu.
  - Nếu không thỏa thì cờ vẫn tắt, và kết luận được ghi vào `CHANGELOG.md`.
- **Toàn cục:**
  - Không còn code thử nghiệm bỏ dở trong diff.
  - `docs/OMP-HARNESS-UPGRADE-CONTRACTS.md` có mục mới cho số đo (định nghĩa nhãn R1, ngưỡng, nguồn dữ liệu).
  - Research doc được cập nhật ở các điểm sai so với code (Sources).

## Sources
- `docs/X-REDDIT-HARNESS-RESEARCH.md` (main checkout, chưa track) §1.3, §2.1, §4. Các điểm đã chỉnh so với code:
  - Gate nằm ở `src/tools.ts:570-600`, không phải `:315-324`.
  - verify-gate đã re-prompt, trần 3 là của harness, host cho 8.
  - `wall_ms` không được đo.
  - `compare.mjs:86-103` đã có kiểm tra cache tương đối.
  - Hook `before_subagent_spawn` có sẵn nhưng repo chưa dùng.
- Host: `node_modules/@oh-my-pi/pi-coding-agent/src/session/agent-session.ts:5783-5808` (session-stop-continuation được lưu là `custom_message` có timestamp), `.../extensibility/shared-events.ts:492-501`.
- Dữ liệu máy: `~/.omp/harness/harness.log` (3100 dòng; G1 rc=40:181, rc=41:37, rc=42:20; W2 k=30:118, k=33:73), `~/.omp/agent/sessions` (3617 file, 30 có continuation), `D:\omp-harness\probes\baseline.json` (in/out 8/8, cache 0.939/0.962).
