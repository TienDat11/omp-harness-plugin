# Subagent self-improvement — kế hoạch triển khai và hợp đồng thực thi

**Trạng thái:** đặc tả để triển khai, chưa phải feature đã chạy. Lần chỉnh này chỉ sửa tài liệu; không sửa runtime. Bằng chứng lần chỉnh: `.omp/work/2026-11-08/subagent-plan-direct-final/`. Không tiếp tục vòng Goldfish 6.

## 1. Mục tiêu và ranh giới

Dùng kết quả được coordinator đánh giá độc lập để thay đổi **lựa chọn parent + direction** và **policy memory mà worker kế tiếp thực sự nhận**. Giữ đủ bốn primitive: hierarchical KL-UCB; observation Bernoulli với bốn gate, SKIP khác 0; failure-direction card + cooldown; bounded memory injection vào task/spawn/send.

Thành công không phải số trang plan, số review hay worker nói `ready`. Thành công là cùng một goal, sau kết quả có bằng chứng: lần dispatch tiếp theo chọn theo state đã học, tránh direction không cải thiện trong cooldown, nhận memory mới; replay/restart không học hai lần.

Không thêm dependency, database thứ hai, embedding, migration zeromem, retry framework hay model routing mới. Không thay schema ba bảng ở §4. Không đổi acceptance để biến lỗi thành pass. Không tuyên bố “upgrade số 1 tháng” trước khi đo §11.

## 2. Hợp đồng cho coordinator và subagent

### 2.1 Load skills trước công việc tương ứng

Coordinator giữ một skill receipt cho từng worker: `skill URI → nội dung/range đã nhận → quy tắc áp dụng`. Đường dẫn hoặc thông báo “already in context” không chứng minh đã đọc nội dung. Coordinator có thể cung cấp nguyên văn phần cần thiết và ghi `provided excerpt`, thay vì bắt worker đọc lặp.

| Vai trò / trigger | Skill bắt buộc | Đầu ra trước khi qua gate |
|---|---|---|
| Coordinator bắt đầu thay đổi file | `skill://task-intake`, `skill://karpathy-guidelines`, `skill://ponytail` | Tier, intake duy nhất, AC cố định, allowlist |
| Kiến trúc hoặc thay đổi interface | `skill://senior-architect`, `skill://api-and-interface-design` | Quyết định schema/API/ownership; không để coder tự thiết kế |
| Coder TypeScript | `skill://karpathy-guidelines`, `skill://ponytail`, `skill://ua-impact`; `skill://typescript-pro` khi làm branded IDs/discriminated unions | Skill receipt, source anchors, impact và checkpoint trước sửa |
| Reviewer | `skill://code-review`, `skill://karpathy-guidelines`; `skill://api-and-interface-design` nếu kiểm contract | Checklist scope + spec + correctness; quote finding, không sửa production |
| Lập thứ tự sprint | `skill://sprint-plan` | Dependency/critical path; capacity và velocity thiếu thì ghi unknown, không bịa point/date |
| Sửa phần hướng dẫn agent | `skill://writing-for-agents` | Steps và completion gates ở cùng vị trí, một nguồn sự thật |

Chỉ nạp skills đúng trigger một lần trong session; không dump cả thư viện, không chạy script của skill không liên quan. Skill không có hoặc nội dung không đọc được: ghi chính xác phần thiếu, coordinator cung cấp phần cần thiết hoặc tiếp quản. Không bỏ qua mà ghi “loaded”.

### 2.2 Packet bắt buộc cho mỗi worker

Coordinator điền template này, không giao một câu “hãy làm theo plan”:

```text
Task type / owner / phase:
Plan revision: SHA-256 của SUBAGENT_SELF_IMPROVED.md; sections cần làm
Target: exact Create/Modify paths; các file khác read-only
Observed context: path#TAG:ranges + nguyên văn các contract cần thiết
Skills: URI + quy tắc áp dụng + receipt phải trả
Change: từng symbol, input/output, state transition theo sections của plan
Acceptance: AC IDs + lệnh/scenario + kết quả cụ thể mong đợi
Stop: sau artifact/checkpoint này; không spawn; không đổi schema/AC/allowlist
Evidence: file paths + command + exit code + stdout + limits
Report: ready|failed|blocked; completed ACs; missing ACs; changed files; skill receipt
```

Cùng file chỉ một writer. Worker chỉ triển khai phần đã quyết định; phát hiện thiếu quyết định thì trả counterexample cụ thể cho coordinator, không tự “simplify” mất primitive. Coordinator tự tiếp quản khi worker không thực hiện packet; không lặp lại cùng packet thất bại, không mở thêm intake hay reviewer để che lỗi.

### 2.3 Gates có chủ sở hữu, không dựa lời hứa prompt

| Gate | Coordinator phải quan sát | Khi fail |
|---|---|---|
| G0 trước dispatch | Revision/hash, skills, AC, allowlist, baseline file hashes và phase dependencies đủ | Hoàn thiện packet trước dispatch |
| G1 trước sửa | Worker nêu source anchors và chính xác symbols cần sửa; thay đổi khớp phase | Chặn việc mở rộng scope; coordinator quyết định, worker không tự đổi |
| G2 bàn giao worker | Artifact tồn tại, changed-path set nằm trong allowlist, output lệnh thực tế; `ready` đơn thuần không đủ | Ghi failed/blocked và counterexample, không nhận pass |
| G3 integration | Coordinator chạy actual module/CLI/dispatch changed path, kiểm next-input + DB/restart; kiểm tra source tests thật | Một grouped repair batch từ lỗi cụ thể |
| G4 độc lập | Một reviewer đọc frozen revision + requirement + full change + evidence; inaccessible coverage là incomplete | Không tính là clean; coordinator xử lý lỗi trong repair batch duy nhất |
| G5 cuối | Re-run deterministic failed checks + smoke sau repair; outcome đúng mọi AC, không bỏ failed item | Còn fail thì báo nguyên trạng và dừng, không vòng 6 |

Đây là quy trình kiểm soát, **không phải sandbox hay bảo đảm tuân thủ tuyệt đối**. Read/hash/diff và acceptance phải do coordinator kiểm, không tin worker tự khai. Dùng quyền read-only/worktree/write allowlist của harness nếu có; không giả vờ prompt đã khóa filesystem. Nếu công cụ không enforce quyền, coordinator xác minh changed files so baseline và từ chối bàn giao ngoài scope. Không tự ghi đè thay đổi của người dùng.

Ngân sách luồng cố định: triển khai theo phase → một independent review → tối đa một grouped repair → deterministic checks + smoke → bàn giao. Không review lại semantic sau repair; chưa giải quyết được ghi open. Cấm worker tự tạo review vòng mới. Lỗi tool đọc: đổi cách truy cập đúng một lần hoặc dùng excerpt đã cung cấp; không nhân bản file để đánh lừa read ledger.

## 3. Phạm vi code tương lai và điểm nối thực tế

| File | Thay đổi khi triển khai; không phải đã có |
|---|---|
| `src/skill-telemetry.ts` | Modify: DDL ba bảng mới; types/math/evaluator; transaction/dispatch/drain methods; per-cwd cache + close exports |
| `src/stack-router.ts` | Modify: thay private `stores`/`storeFor` bằng cache export; migrate toàn bộ callers và shutdown |
| `src/superagent.ts` | Modify: parse candidate envelope, dispatch trace/selection, bounded input adapter, startup drain; giữ watchdog hiện tại |
| `src/tools.ts` | Modify: optional assessment schema, validation/evidence resolution, gọi transaction thay outcome writer trên learning branch |
| `tests/subagent-learning.test.ts` | Create: transaction, selection, restart, failure injection và memory scenarios §11 |
| `tests/superagent.test.ts` | Modify: task variants, static contract, memory revision, task/spawn/send và legacy regression |
| `tests/stack-router.test.ts` | Modify: cache lifecycle/shared instance/null legacy/shutdown regression |
| `docs/OMP-HARNESS-UPGRADE-CONTRACTS.md`, `CHANGELOG.md` | Modify: contract, failure semantics và giới hạn đã chạy |

Giữ nguyên `src/state.ts`, `src/policy.ts`, `src/read-budget.ts`, `src/memory.ts`, `src/telemetry.ts`, manifest/package/lockfile. Reuse `writeTextFileAtomic` và `computeAcceptedTaskCost`; không đổi semantics của shared helper để phục vụ riêng feature.

Source anchors đã đọc khi soạn (line chỉ là locator; implementer resolve symbols tại revision G0): `SkillTelemetryStore` constructor/close ở skill-telemetry.ts:14–22/116–118; private cache/storeFor và shutdown ở stack-router.ts:589–613/988–1000; `resolveSuperagentTaskInput` ở superagent.ts:606–649; task toolCallId ở :1268–1273, spawn/send ở :1304–1327; harness_record schema/execute ở tools.ts:182–249; atomic writer boolean ở state.ts:157–168; read ledger adapter ở read-budget.ts:550–584; cost interface ở telemetry.ts:302–319. Các API learning dưới đây đều **mới**, không giả định host đã cung cấp.

## 4. Storage, identity và typed contract

Một `DatabaseSync` per canonical cwd tại `<cwd>/.omp/harness/skill-telemetry.db`, do `SkillTelemetryStore` sở hữu. Thêm ba bảng sau constructor hiện tại; giữ `skill_runs`, `skill_stats` và indexes/callers hiện có. Không dùng tên bảng thay thế. Seed idempotent không reset state cũ.

```sql
CREATE TABLE IF NOT EXISTS dispatch_traces (
  dispatch_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  observation_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
INSERT OR IGNORE INTO learning_state(id, generation, payload_json)
VALUES (1, 0, '{"generation":0,"arms":{},"opportunityCounters":{},"cooldowns":{},"cards":[],"memory":{"lessons":[],"targetCatalog":[]}}');
```

IDs = SHA-256 UTF-8 của `JSON.stringify(array)`; normalize trước hash: scope là repo-relative slash `/`, không `..`, unique + lex sort; goal/direction IDs trim, nonempty; parentId nonempty hoặc null. Không hash timestamp để dedupe. Caller gửi CandidateSpec, không gửi branded arm IDs. Goal ID do coordinator cố định qua các trial cùng mục tiêu; parentId là baseline state đã chọn, không phải ID worker vừa chạy.

```ts
export type ArmId = string & { readonly __brand: "ArmId" };
export type CriterionSet = { criterionIds: string[]; passed: boolean[] };
export type ReportKind = "ready" | "failed" | "blocked" | "dropped";
export interface CandidateSpec {
  parentId: string | null;
  directionId: string;
  mechanism: string;
  change: string;
  scope: string[];
  prompt: string;
}
export interface Candidate extends CandidateSpec {
  parentArmId: ArmId;
  directionArmId: ArmId;
}
export interface CandidateEnvelope {
  version: 1;
  goalId: string;
  candidates: CandidateSpec[];
}
export interface Assessment {
  dispatchId: string;
  reportKind: ReportKind;
  followed: boolean;
  attributable: boolean;
  allChecksCompleted: boolean;
  measurementError: boolean;
  baseline: CriterionSet;
  candidate: CriterionSet;
  evidenceRefs: Array<{ path: string; sha256: string }>;
  changedPaths: string[];
  availableAt: number;
}
export interface Observation {
  observationId: string;
  dispatchId: string;
  target: "parent" | "direction";
  armId: ArmId;
  value: 0 | 1;
  availableAt: number;
}
export interface FailureDirectionCard {
  failureKey: string;
  directionArmId: ArmId;
  mechanism: string;
  change: string;
  scope: string[];
  firstSeenAt: number;
  lastSeenAt: number;
}
export interface Lesson {
  lessonKey: ArmId;
  kind: "successful_pattern" | "failure_pattern" | "conditional_guidance";
  goalId: string;
  appliesWhen: string;
  mechanism: string;
  recommendedChange: string;
  targets: Array<{ file: string; change: string }>;
  targetIndexes: number[];
  reinforceCount: number;
  contradictionCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}
export interface LearningStateJSON {
  generation: number;
  arms: Record<ArmId, { successes: number; n: number }>;
  opportunityCounters: Record<ArmId, number>;
  cooldowns: Record<ArmId, { excludedThroughOpportunity: number; failures: number }>;
  cards: FailureDirectionCard[];
  memory: {
    lessons: Lesson[];
    targetCatalog: Array<{ file: string; change: string }>;
  };
}
export interface OutcomeProjection {
  operationId: string;
  requestHash: string;
  operationHash: string;
  destination: string;
  outcomeJson: string;
  generation: number;
  status: "pending" | "flushed";
}
export interface Trace {
  dispatchId: string;
  sessionId: string;
  toolCallId: string;
  itemIndex: number;
  ticketId: string;
  agent: string;
  goalId: string;
  candidates: Candidate[];
  selectedDirectionArmId: ArmId | null;
  selectedPrompt: string;
  inputHash: string;
  memoryRevision: string;
  memoryText: string;
  createdAt: number;
  assessmentStatus: "pending" | "applied" | "skipped" | "not_dispatched";
  assessmentHash?: string;
  evaluationOperationId?: string;
  outcome?: OutcomeProjection;
}
export interface DispatchInput {
  sessionId: string;
  toolCallId: string;
  itemIndex: number;
  ticketId: string;
  agent: string;
  envelope: CandidateEnvelope;
  inputHash: string;
  now: number;
}
export interface DispatchResult {
  trace: Trace;
  selected: Candidate | null;
  memoryText: string;
  reason: "selected" | "all_excluded";
}
export interface CommitBatchInput {
  operationId: string;
  sessionId: string;
  requestHash: string;
  destination: string;
  outcomeJson: string;
  assessments: Assessment[];
  now: number;
}
export interface CommitBatchResult {
  generation: number;
  status: "pending" | "flushed";
  replay: boolean;
}
export interface SubagentLearningStore {
  prepareSubagentDispatch(input: DispatchInput): DispatchResult;
  prepareSubagentDispatchBatch(inputs: DispatchInput[]): DispatchResult[];
  findEvaluationProjection(operationId: string, sessionId: string): OutcomeProjection | null;
  commitSubagentEvaluationBatch(input: CommitBatchInput): CommitBatchResult;
  drainPending(): void;
}
```

- `parentArmId = hash(['parent-v1', goalId, parentId])`; `directionArmId = hash(['arm-v1', goalId, parentId, directionId])`. Null parent vẫn là một parent arm hợp lệ. Không thêm alias `armId` mơ hồ.
- `dispatchId = hash(['dispatch-v1', sessionId, toolCallId, itemIndex])`; itemIndex là chỉ số task trong batch, spawn/send = 0. `inputHash` tính trên original input loại bỏ **chỉ own generated** memory/contract/ledger blocks, giữ candidate JSON và user instructions. Same dispatchId + khác inputHash → reject trước mutate; cùng hash → recorded selection, không tăng counters. Dùng memoryRevision/text tại trace generation cho replay, không render revision mới để giả replay byte-identical.
- `observationId = hash(['observation-v1', dispatchId, target, armId])`: hai observation khác ID cho parent/direction. `failureKey = hash(['failure-v1', goalId, parentId, directionId, mechanism, change, normalizedScope])`. Bỏ `cardId` dư thừa; key duy nhất là failureKey.
- Một `T` authority: opportunityCounters; arms chỉ materialized successes/n, cập nhật cùng transaction khi insert observation mới. observations là event log để audit/rebuild, **không full scan mỗi dispatch**.
- Runtime validation boundary: version đúng 1, 1–8 candidates, unique (parentId,directionId), strings nonempty, prompt ≤4000 UTF-16, IDs/mechanism/change ≤512, scope ≤8 paths mỗi path ≤1024. Cùng directionArmId phải có cùng mechanism/change/scope; muốn đổi proposal dùng directionId mới. Reuse trace lịch sử để kiểm collision metadata; không silently merge proposals.
- Cả JSON hydrate và input từ tools phải kiểm shape/count/domain; malformed state fail learning, không reset DB về seed. `generation` trong row và JSON phải bằng nhau.

## 5. KL-UCB và selection chính xác

Chỉ coordinator tạo candidate envelope; selection không phát minh candidate mới. Parent trước, direction sau; không đổi thành một UCB chung.

```ts
export function klUcbIndex(
  successes: number, n: number, T: number,
  c = 1, tolerance = 1e-8, maxIterations = 100,
): number {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(n) ||
      !Number.isSafeInteger(T) || n < 0 || successes < 0 || successes > n || T < n) {
    throw new RangeError("invalid counts: require 0 <= successes <= n <= T");
  }
  if (!Number.isFinite(c) || c < 0 || !Number.isFinite(tolerance) || tolerance <= 0 ||
      !Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new RangeError("invalid solver parameters");
  }
  if (n === 0) return 1;
  const p = successes / n;
  if (p === 1) return 1;
  const budget = Math.log1p(T) + c * Math.log1p(Math.log1p(T));
  const kl = (q: number): number =>
    (p > 0 ? p * Math.log(p / q) : 0) + (1 - p) * Math.log((1 - p) / (1 - q));
  let low = p;
  let high = 1;
  for (let i = 0; i < maxIterations && high - low > tolerance; i += 1) {
    const mid = (low + high) / 2;
    if (n * kl(mid) <= budget) low = mid;
    else high = mid;
  }
  return low;
}
```

`prepareSubagentDispatch`: drain dưới writer lock → load fresh state → replay check → tăng T đúng một lần cho mỗi supplied distinct direction và distinct parent → filter cooldown → sort parent index desc, direction index desc, directionArmId lex asc → chọn first. Defaults successes=n=T=0 trước increment. Counter overflow safe integer → reject/rollback, không saturate.

Nếu tất cả bị exclude: commit counter advancement + trace `selectedDirectionArmId=null`, `assessmentStatus=not_dispatched`, selectedPrompt empty; trả all_excluded và block dispatch. Không gửi worker, không ghi observation hay đánh giá terminal sau đó. Coordinator có thể đưa direction mới ở tool call mới; không tự quay vòng tạo request đến khi hết cooldown.

`prepareSubagentDispatch` owns một BEGIN IMMEDIATE/CAS/COMMIT cho toàn bộ task batch: adapter normalize/validate **mọi item** trước write, dùng private transaction helper cho từng item, một generation chung; nếu item lỗi rollback cả batch. API public single dùng cùng helper với batch size 1; thêm public `prepareSubagentDispatchBatch(inputs: DispatchInput[]): DispatchResult[]` khi nối task batch, khai báo vào class/interface lúc P2. Batch có item all_excluded thì persist mọi selection/counter/trace nhưng block toàn bộ tool call; mark các item không được gửi `not_dispatched` và không học từ chúng. Không ghi trace là worker đã chạy khi host tool bị block. Repeated blocked same toolCallId replay không tạo lần thử mới.

## 6. Independent assessment: bốn gate, SKIP và cooldown

Chỉ **parent coordinator** gửi `subagentEvaluations?: Assessment[]` vào harness_record. Worker terminal tag không tự tạo reward. Coordinator chạy checks với baseline và candidate theo cùng ordered criterion IDs, kiểm followed/attributable qua candidate/scope + artifact thực, không dùng worker tự chấm. Trust boundary: API là parent-attested evidence, không phải chữ ký chống parent độc hại. Giữ nguyên subagent guards ở memory/superagent; không cho worker gọi riêng để tự thưởng.
`src/tools.ts` learning branch tự kiểm `ctx.agent?.kind !== 'sub'` trước mọi write; guard ở memory hook không thay cho authorization tại execute. Parent session không xác định thì reject learning. Đổi này chỉ nằm trong optional-assessments branch, không đổi legacy harness_record.

Validation trước side effects: dispatch tồn tại cùng session, đã selected và thực sự dispatch; criterion IDs unique/nonempty/ordered identical, passed arrays cùng length N>0, finite safe integer availableAt; evidence paths trong workspace, regular file và SHA-256 bytes hiện tại khớp; changedPaths normalized. Mismatched schema/foreign IDs/hash sai hoặc ready kèm failed criterion → reject cả batch, không “sửa” reportKind để nhận reward.

| Điều kiện | Ghi observation | Card/cooldown/memory |
|---|---|---|
| followed && attributable && valid && statistic defined, report ready và candidate all-pass | Parent=1, direction=1 | Success lesson, không card |
| Bốn gate trên đúng, report failed/blocked/dropped | Parent=0, direction=0 | Failure lesson/card chỉ khi delta ≤0; delta >0 là conditional guidance, không card |
| Bất cứ gate false/unknown | SKIP: không row, không n/success change | Chỉ trace skipped + assessmentHash, không card/cooldown/memory update |
Assessment.reportKind failed/blocked/dropped kèm candidate all-pass vẫn là terminal failure0 nếu các gate đúng: đó có thể là lỗi execution ngoài criterion; parent phải giải thích trong outcome notes/evidence. Không tự convert thành ready.

`valid = allChecksCompleted && !measurementError && evidenceRefs.length>0` sau kiểm evidence; `statistic = (candidatePassCount - baselinePassCount)/N`. `blocked/dropped` là kind do parent báo, không suy ra từ parentId null. Có valid evidence nhưng blocked không đồng nghĩa automatic SKIP. ready thiếu evidence → SKIP; ready có failed criterion → reject.

Mỗi assessment đủ gate emit đúng hai IDs §4. `INSERT OR IGNORE` chỉ cho replay đã xác nhận identical; một trong hai row đã tồn tại nhưng trace chưa terminal là invariant violation → rollback, không học nửa cặp. Assessment hash gồm canonical đầy đủ payload (kể cả evidence/time đã đóng băng); terminal trace applied/skipped là immutable. Replay cùng hash không mutate; khác hash → conflict. SKIP không được upgrade thành ready trên cùng dispatch.

**Cooldown cố định:** mỗi eligible non-improving failure mới tăng failures và đặt direction `excludedThroughOpportunity = currentT + 3`. Khi selection tăng T rồi filter, ba opportunity kế tiếp bị loại, opportunity thứ tư được xét. Duplicate, SKIP và process restart không renew. Cooldown chỉ direction, không cấm cả parent. Card existing failureKey cập nhật lastSeenAt, firstSeenAt giữ nguyên; cap 50, evict lastSeenAt nhỏ nhất rồi failureKey lex nhỏ nhất. Card evict không xóa cooldown đang hoạt động; khi T vượt excludedThroughOpportunity thì xóa entry trước selection. failures chỉ diagnostic trong thời gian entry còn sống, không dùng escalation khác.

## 7. Một transaction owner, replay và projection recovery

`SkillTelemetryStore` implements §4. Helpers private `selectSubagentDirection`, `recordSubagentOutcome`, `summarizeSubagentPolicyMemory`, `persistLearningStateWithinTransaction` không BEGIN/COMMIT riêng, không export second-writer `saveSubagentPolicyMemory`.

1. Boundary tools: `operationId = hash(['evaluation-v1', sessionId, sortedDispatchIds])`, assessments nonempty và dispatch IDs unique. `requestHash` tính canonical toàn bộ caller params (kể cả lesson, assessments và dir đã canonical), trước khi attach telemetry/recorded_at. Với operation mới, attach telemetry/recorded_at rồi serialize outcome **một lần**; `operationHash` = hash canonical assessments + destination + outcomeJson. Persist operationId trong mỗi trace; projection full bytes/hash đặt ở owner trace dispatchId lex nhỏ nhất. Replay xác nhận requestHash/destination/session và dùng original outcomeJson/operationHash/generation, không serialize timestamp/telemetry mới.
   tools dùng `findEvaluationProjection` read-only trước khi dựng outcome để lấy original bytes khi replay; store commit kiểm lại operation dưới BEGIN IMMEDIATE, vì prelookup không khóa được concurrent caller. Hai caller cùng operation đều dựng bytes riêng: first commit thắng, caller sau chỉ replay nếu requestHash/destination/session giống, bỏ fresh telemetry bytes của caller sau và trả original projection; khác requestHash reject. Với direct store callers, outcomeJson đầu vào chỉ có hiệu lực khi operation mới; replay luôn dùng original operation payload.
2. BEGIN IMMEDIATE, started=true. Drain mọi pending projection dưới cùng lock trước mutation; query `json_extract(payload_json,'$.outcome.status')='pending'`, order generation asc rồi operationId. Nếu lỗi file: rollback markers, throw explicit error; không học batch mới.
3. Replay: nếu mọi trace terminal, cùng operationId/assessmentHash/owner operationHash → return recorded generation, không reapply. Terminal khác operation hay payload → conflict. Mixed terminal+pending không được tiếp tục một phần; reject cả batch. Unknown/selected-null/not_dispatched trace reject.
4. Với batch hoàn toàn pending, evaluate các assessments theo dispatchId lex; insert obs, update materialized arms/card/memory; SKIP chỉ marker. Save một JSON state generation+1. `UPDATE learning_state SET generation=?,payload_json=? WHERE id=1 AND generation=?`; changes=0 → CAS_STALE_GENERATION, rollback cả observations+markers+state. UPDATE traces kể cả owner outcome.pending trong cùng transaction. COMMIT rồi started=false.
5. Immediate `drainPending()` reacquire lock. New commits/learning selections cũng drain trước mutate, nên writer cũ không overwrite outcome mới cùng destination. Under BEGIN IMMEDIATE: call existing `writeTextFileAtomic(destination,outcomeJson)` và **check boolean**; true rồi update owner marker flushed, commit; false rollback markers, giữ pending và throw `PROJECTION_PENDING` kèm committed generation/operationId. Caller biết learning đã commit, không report rolled-back. Không gọi legacy outcome writer lần nữa trên branch này.
6. Process crash trước COMMIT không lưu phần nào; sau COMMIT trước file write drain phục hồi full outcome bytes; sau rename trước marker write replay cùng bytes an toàn. Chỉ ROLLBACK nếu started=true; sau COMMIT thất bại file không rollback learning đã commit.

Một serialization gate theo DB store (SQLite writer lock), không thêm global generation gate trên outcome paths. File IO dưới lock là tradeoff được chấp nhận cho lượng outcome nhỏ; lỗi disk có thể chặn **learning-enabled** dispatch/commit đến khi giải quyết. Không giữ lock qua await/model/tool invocation. Sync writer boolean, không sửa helper shared. Bảo đảm **process-crash/reopen**, không hứa durability mất điện/fsync: helper hiện tại chỉ temp-write + rename, SQLite config hiện có được giữ nguyên.

Destination: tools derive từ canonical dir nằm trong cwd/.omp/work, file chỉ `outcome.json`; caller không chọn arbitrary destination. Resolve existing parents, reject symlink components/outside root, kiểm tại write; nếu dir chưa có thì lỗi (intake phải có trước). Evidence regular files realpath trong workspace; không execute nội dung file. Giới hạn này không chống OS adversary thay symlink giữa check/write; sandbox-level security ngoài scope.

Legacy harness_record không có assessments giữ behavior cũ. Khi có assessments, tools phải dùng transaction branch thay direct `writeTextFileAtomic(outcome.json)`. Lesson.md/lessons.jsonl là artifact phụ sau successful flush, không nằm trong atomic learning guarantee; replay không append lesson lần hai. Lỗi lesson báo riêng, không reapply learning. Existing lesson behavior trên legacy branch giữ nguyên.

## 8. Memory deterministic và bounded rendering

LessonKey = directionArmId, giữ goalId. New eligible success tạo successful_pattern; non-improving failure tạo failure_pattern với guidance `Avoid <change>; choose another direction`; partial improvement failure tạo conditional_guidance `Improved some criteria; remaining criteria must pass: <failed criterion IDs>`. Một lần assessment không vừa reinforce vừa contradict: cùng kind + guidance tăng reinforce; opposite success/failure tăng contradiction; conditional cùng guidance mới reinforce, thay guidance thì reset thành lesson mới. Remove khi contradiction>=reinforce và >0; lần assessment hiện tại chỉ retire, không lập lại ngay. First lesson reinforce=1/contradiction=0. SKIP/replay không đổi memory.

Cap 6 lessons toàn state, giữ lastSeenAt desc rồi lessonKey lex asc. Mỗi lesson lưu targets từ selected scope + changedPaths unique lex sorted, tối đa 8. Rebuild targetCatalog từ union targets của retained lessons, giữ 8 file lex nhỏ nhất; cùng file chọn change từ lesson mới nhất (tie lessonKey lex). Assign indexes theo file lex và chỉ trỏ targets còn trong catalog; không đọc/scan trace history để render. Renderer filter goalId, output JSON escaped (escape `<` thành `\u003c` để data không đóng XML tag), không coi text từ worker thành instruction trusted.

`getSubagentPolicyMemory(state,goalId,maxChars=8192): string` pure. maxChars integer ≥256, default 8192 UTF-16 gồm opening/closing tags + revision. Body cố định shape `{lessons:[...],cooldowns:[...],excludedCount:number}`; lessons gồm kind/appliesWhen/mechanism/recommendedChange và targets đã resolve, không emit state counters. Render tối đa 8 active cooldown direction IDs lex + tổng số còn lại trong excludedCount; compact selected goal lessons theo thứ tự trên. Nếu quá dài: drop oldest whole lesson, rồi bớt cooldown entries; fallback `{lessons:[],cooldowns:[],excludedCount:N}` vẫn dưới cap. Không cắt giữa JSON hay tag. Revision = hash final JSON body, không tự tham chiếu hash trong body. Dùng renderer ngay sau fresh state load; Trace lưu exact memoryText cho replay. Counter/generation-only changes không bắt buộc đổi revision nếu memory body như cũ.

Memory injected cho legacy dispatch được load/read-only nếu store khả dụng; lỗi store thì giữ input legacy không memory mới, không giả snapshot. Legacy dispatch **không bị chặn bởi pending learning outbox**, không tạo trace/counter. Learning envelope lỗi store/drain/CAS thì fail closed. Startup drain lỗi ghi diagnostic và giữ pending, không làm crash session/khóa legacy tools.

## 9. Hook wiring và adapters: host surface không suy đoán

- `getSkillTelemetryStore(cwd): SkillTelemetryStore|null` và `closeSkillTelemetryStores():void` mới ở skill-telemetry.ts: canonical cwd cache, constructor catch log+null, không cache null vĩnh viễn. Tất cả stack-router storeFor callers migrate; close tất cả trong try/finally clear map, giữ isSub early return ở shutdown. Learning branch coi null là block, legacy telemetry giữ null semantics.
- superagent `session_start`: parent only, lấy store, drain pending catch diagnostic. `tool_call` learning task/spawn/send: lấy session key từ getState(ctx), event.toolCallId (thực tế có optional), stable ticketId/agent; thiếu session/call ID thì learning block, không dùng anonymous queue làm learning ID. Existing anonymous legacy path giữ nguyên.
- harness_record execute (`src/tools.ts`): thêm optional zod schema `subagentEvaluations: Assessment[]`; session identity phải dùng cùng normalization source session file với superagent `getState` (existing ctx.sessionManager.getSessionFile), không lấy từ caller. Reject nếu không derive được cùng key. Derive candidate/goal từ persisted trace, không tin caller gửi EvalInput. Parse/hashes/evidence validation parent side, transaction revalidate trace trong lock.
- Existing `resolveSuperagentTaskInput(input,state)` thêm optional internal memory context argument (default undefined giữ callers cũ); migrate tool_call callsite và tests. Preserve existing static `<superagent-worker-contract>` text. Kiểm full own block chứ không chỉ opening tag. Same revision byte-identical no duplicate; khác revision replace own memory only; malformed/duplicate own tags trên learning branch block, legacy giữ input và log, không phá user text.
- Candidate envelope là **một** `<subagent-candidates>JSON</subagent-candidates>` trong task item text hoặc spawn.prompt/send.message; single task có thể ở input.context nếu không có tasks batch. Batch >1: mỗi item có envelope riêng; shared context chỉ instructions, có envelope trong shared context thì reject ambiguous batch. tasks[i] field precedence first nonempty task → assignment → description; single task fallback task → assignment → description; không có supported string thì learning block, legacy giữ behavior. Không thêm host top-level JSON fields chưa được tool schema hỗ trợ.
- For task batch learning: selection của từng item thay **candidate envelope** bằng selected prompt trong field của chính item, giữ các instructions ngoài envelope và shared input.context. Own per-goal memory/contract append vào item text, không ép nhiều goal memory vào shared context. For no-envelope task giữ context-first static injection hiện tại; đồng thời bổ sung single task fallback còn thiếu. For spawn/send: thay envelope tại prompt/message, giữ prefix/suffix, thêm static contract nếu thiếu và memory bounded.
- Các block `<parent-read-ledger>` do policy/read-budget sinh ra giữ nguyên. Không yêu cầu host order giữa extensions: hai adapters chỉ sửa own block và bảo toàn field của nhau; test cả ledger-before-memory và memory-before-ledger. Không đổi policy/read-budget chỉ để đoán ordering.
- tool_result không tự score terminal tag. Parent coordinator đọc actual result/artifact rồi harness_record; existing sub guards và watchdog logic không bị xóa.

## 10. Phases có checkpoint; giao việc không tự mở rộng

Chưa có roster, availability, sprint window hay velocity đáng tin: capacity/date/points **unknown**. Sequence là dependency plan, không phải cam kết thời lượng bịa. Critical path P1→P2→P3→P4. Một writer cho skill-telemetry.ts xuyên P1/P2; superagent/tools chỉ mở sau typed contract frozen. Có thể QA đọc contract song song, không viết chung production.

| Phase | Owner / paths | Done gate trước phase sau |
|---|---|---|
| P1 store/contracts | Coder: skill-telemetry.ts, stack-router.ts; tests/stack-router.test.ts | DDL seed/hydrate; move cache và shutdown cùng batch buildable; existing telemetry behavior pass; single instance/cwd close+reopen |
| P2 learning core | Cùng coder: skill-telemetry.ts; Create tests/subagent-learning.test.ts | Implement types/math/selection, public single+batch methods, assessment/card/memory/CAS/outbox; failure+restart scenarios pass trên real store |
| P3 integration | Coder: superagent.ts, tools.ts; tests/superagent.test.ts, tests/subagent-learning.test.ts | harness_record optional schema/parent evidence, dispatch batch, actual adapters và startup drain wired; no-envelope legacy regression pass |
| P4 acceptance | Coordinator integration, independent reviewer; docs contract/changelog | Actual next-dispatch smoke, full existing suite + verify once, finite review/repair gates §2, final AC evidence |

Không activate learning envelope trước khi cả P2/P3 sẵn sàng; mỗi phase commit giữ legacy hoạt động. Schema additive, rollback code không drop learning data; canonical outbox chỉ được drain bởi code có contract này. Rollback activation bằng ngừng phát candidate envelopes; pending outcomes phải drain bằng known-good implementation trước khi downgrade writer. Không xóa tables để “fix” corrupted state.

Lệnh implementation verification: `node --test tests/skill-telemetry.test.ts tests/stack-router.test.ts tests/subagent-learning.test.ts tests/superagent.test.ts`; integration cuối `npm test` và `npm run verify`. LSP references trước đổi exported symbols; ua_impact trước edit/deletion. Nếu có failure người dùng đã báo, dùng đó làm ground truth, không chạy lại chỉ để xác nhận. Worker chạy focused checks phase, full suite chỉ coordinator chạy lúc integration.

## 11. AC và bằng chứng bắt buộc khi triển khai

| ID | Scenario / assertions phải quan sát |
|---|---|
| F1 | DB mới có existing 2 tables + đúng 3 new, seed generation0; reopen giữ state; legacy recordRun/queryLift không đổi |
| F2 | KL: (0,1,1)≈0.704692; all-success=1; cold(0,0,0)=1; invalid (2,0,5), n>T, NaN/Infinity/negative/noninteger bị reject; high success index > low cùng n/T |
| F3 | Two candidates khác parent sinh khác parentArmId; cold tie lex deterministic; parent then direction UCB; T tăng distinct supplied arms, n chỉ từ eligible observations |
| F4 | Success đúng 2 rows target parent/direction, IDs khác; failure0; từng gate false → SKIP có marker không rows/memory/card; ready+failed criterion reject; partial improvement0 nhưng no card; null baseline parent hợp lệ |
| F5 | Exact dispatch replay và assessment replay không tăng T/n/generation; changed payload conflict; skipped retry không upgrade; batch mixed-terminal và unknown/selected-null reject; no partial two-row insert |
| F6 | Non-improving failure card + excludedThrough=T+3; next3 distinct opportunities excluded, fourth eligible; all-excluded block persists trace/counters không gửi worker; duplicate/SKIP/restart không renew; card cap50 không bypass active cooldown |
| F7 | Inject throw sau first obs + state update và stale CAS sau earlier insert → rollback mọi state/trace/obs; replay success cập nhật đúng một lần |
| F8 | Real file write returnsfalse sau learning commit → pending + committed error, reopen store/drain ghi **full exact outcome bytes**, đánh flushed; failure sau rename trước marker replay exact; two commits same destination không stale-overwrite |
| F9 | Success/failure/conditional lesson, reinforce/contradict/retire; cap6/cap8, no dangling indexes; render ≤8192 UTF-16 gồm tags, `<` escaped; deterministic revision và full valid JSON khi trim |
| F10 | Actual task context/single/tasks[].task/assignment/description + spawn.prompt/send.message nhận selected prompt và memory; no prefix mất, no duplicate static contract; malformed envelope fail; test two extension orders; no-envelope legacy hoạt động lúc DB/disk lỗi |
| F11 | Parent evaluate→commit→**actual next dispatch hook**: capture input received by stub host tool (not echo mock), inspect real SQLite rows, close/reopen, dispatch tiếp nhận revision mới và cooldown đổi lựa chọn. Test gọi production modules/hooks, không substitute toy protocol |
| F12 | Path traversal/symlink/evidence hash mismatch/foreign session/changed proposal same direction đều reject trước learning writes; cache shared+shutdown clear giữ subagent guard |

Smoke của coordinator phải chạy production store + registered host hooks với harness test host hiện có, ghi input ở boundary host thực sự nhận; không chỉ test forwarded arguments hay giả `PASS`. Ngoài tests, chạy một temp-workspace trial trên actual omp tool dispatch nếu runtime khả dụng: baseline→candidate→parent assessment→next worker input; nếu runtime unavailable ghi missing prerequisite và chỉ claim module/hook integration đã chạy.

Đánh giá upgrade: đóng băng task corpus và criteria trước treatment, tách held-in/held-out không trộn tuning. Cùng baseline/model/config, lưu mọi attempt (cả thất bại) + elapsed + accepted outcomes + bốn token counters input/output/cacheRead/cacheWrite riêng. Dùng `computeAcceptedTaskCost(AcceptedCostAttempt[])`; billing unknown/acceptedCount0 → UNKNOWN/UNDEFINED, không suy giá từ tokens tổng. Admit chỉ khi acceptance pass count cả hai split không giảm và ít nhất một tăng; cost/accepted không tăng khi cost known. Không đủ measurement thì ghi chưa chứng minh, không quảng cáo ranking tháng.

## 12. Bàn giao và trạng thái chứng minh

Mỗi AC báo `pass|fail|not-run` với command, exit, raw output/artifact, revision đã chạy. Outcome native cần boolean thì not-run=pass:false + reason; không đổi check thành “đã ghi nhận failure” để pass:true. Coordinator đọc final files, đối chiếu baseline paths, ghi harness_record đúng một lần vào intake cuối của task. Không tạo intake mới cho từng retry; không chỉnh telemetry tự động để làm đẹp số liệu.

Plan-only check lần này: chạy **chính** TS/SQL fences ở trên (types/math và DDL), numerical KL và SQL seed/CAS; đó là tính nhất quán các đoạn executable, **không phải bằng chứng feature runtime F1–F12 đã được triển khai**. Formal Goldfish convergence hoặc independent reviewer pass không được suy từ việc sửa tài liệu. Skills và gate §2 là nghĩa vụ thực thi tương lai; enforcement runtime bổ sung không được giả là đã tồn tại.
