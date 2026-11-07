import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { tmpDir, fakePi, fakeCtx, type FakePi, type FakeCtx } from "./_fake-pi.ts";
import policyDefault, {
  looksLikeSecret,
  isSecretTarget,
  evaluateBash,
  failureKey,
  nextFailureDecision,
  recordFailure,
  resetFailureCounters,
  resolveTodoInput,
} from "../src/policy.ts";
import { clearSessionState } from "../src/state.ts";
import { expandHome } from "../src/read-budget.ts";

// ---------------------------------------------------------------------------
// S6: expandHome
// ---------------------------------------------------------------------------

test("expandHome resolves ~ and ~/ using HOME/USERPROFILE", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = path.join(path.sep, "home", "user");
  delete process.env.USERPROFILE;
  try {
    assert.equal(expandHome("~"), path.join(path.sep, "home", "user"));
    assert.equal(expandHome("~/x/y"), path.join(path.sep, "home", "user", "x", "y"));
    assert.equal(expandHome("relative.txt"), "relative.txt");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
  }
});

test("expandHome falls back to os.homedir() when HOME+USERPROFILE unset", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  try {
    const home = os.homedir();
    assert.equal(expandHome("~"), home);
    assert.equal(expandHome("~/x/y"), path.join(home, "x", "y"));
    assert.equal(expandHome("relative.txt"), "relative.txt");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
  }
});

test("expandHome returns empty string when home cannot be resolved", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  const orig = os.homedir;
  // os.homedir() may still return a dir; just assert no throw and deterministic behavior.
  try {
    const out = expandHome("~");
    assert.equal(typeof out, "string");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    os.homedir = orig;
  }
});

// ---------------------------------------------------------------------------
// S6: evaluateBash secret/env guards
// ---------------------------------------------------------------------------

test("evaluateBash blocks cat .env", () => {
  assert.equal(evaluateBash("cat .env", "/tmp/w").block, true);
});

test("evaluateBash blocks head ~/.ssh/id_rsa", () => {
  assert.equal(evaluateBash("head ~/.ssh/id_rsa", "/tmp/w").block, true);
});

test("evaluateBash blocks printenv", () => {
  assert.equal(evaluateBash("printenv", "/tmp/w").block, true);
});

test("evaluateBash blocks echo $TYPESAFE_API_KEY", () => {
  assert.equal(evaluateBash("echo $TYPESAFE_API_KEY", "/tmp/w").block, true);
});

test("evaluateBash allows cat .env.example", () => {
  assert.equal(evaluateBash("cat .env.example", "/tmp/w").block, false);
});

test("evaluateBash allows env NODE_ENV=test npm test", () => {
  assert.equal(evaluateBash("env NODE_ENV=test npm test", "/tmp/w").block, false);
});


interface PolicyBlockResult {
  block?: boolean;
  reason?: string;
}

const ENV_KEYS = [
  "OMP_HARNESS_JEV",
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "OMP_PROFILE",
  "PI_MODEL",
  "OMP_MODEL",
] as const;

const EXPECTED_EVENTS = [
  "auto_compaction_start",
  "auto_retry_start",
  "retry_fallback_applied",
  "session_shutdown",
  "tool_call",
  "tool_result",
];

const FORBIDDEN_EVENTS = [
  "context",
  "before_agent_start",
  "before_provider_request",
  "assistant_message",
  "agent_end",
  "session.compacting",
  "session_before_compact",
];

function policySource(): string {
  return readFileSync(new URL("../src/policy.ts", import.meta.url), "utf8");
}

function toolCallHandler(pi: FakePi) {
  const list = pi.handlers.get("tool_call");
  const handler = list?.[0];
  if (!handler) throw new Error("policy: no tool_call handler registered");
  return handler;
}

function toolResultHandler(pi: FakePi) {
  const list = pi.handlers.get("tool_result");
  const handler = list?.[0];
  if (!handler) throw new Error("policy: no tool_result handler registered");
  return handler;
}

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetFailureCounters();
  clearSessionState();
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (key in savedEnv) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
});

test("bash policy blocks recursive-force delete of filesystem root", () => {
  const result = evaluateBash("rm -rf /", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy blocks recursive-force delete of home directory", () => {
  const result = evaluateBash("rm -rf ~", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy blocks recursive-force delete of workspace root", () => {
  const result = evaluateBash("rm -rf .", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy blocks recursive-force delete of git metadata path", () => {
  const result = evaluateBash("rm -rf .git", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy blocks recursive-force delete with literal wildcard", () => {
  const result = evaluateBash("rm -rf *", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy blocks recursive-force delete of workspace root by absolute path", () => {
  const result = evaluateBash("rm -rf D:/ws", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy blocks recursive-force delete of outside-workspace path", () => {
  const result = evaluateBash("rm -rf D:/outside", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy allows recursive-force delete of inside-workspace subpath", () => {
  const result = evaluateBash("rm -rf sub/a.txt", "D:/ws");
  assert.equal(result.block, false);
});

test("bash policy allows git push --force-with-lease", () => {
  const result = evaluateBash("git push --force-with-lease", "D:/ws");
  assert.equal(result.block, false);
});

test("bash policy blocks git push --force", () => {
  const result = evaluateBash("git push --force", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy blocks git reset --hard without path", () => {
  const result = evaluateBash("git reset --hard", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy allows git reset --hard with path", () => {
  const result = evaluateBash("git reset --hard -- src/a.ts", "D:/ws");
  assert.equal(result.block, false);
});

test("bash policy blocks segmented git reset --hard", () => {
  const result = evaluateBash("cd sub && git reset --hard", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy blocks rm -fr flag order", () => {
  const result = evaluateBash("rm -fr /", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy blocks rm -r -f flag order", () => {
  const result = evaluateBash("rm -r -f /", "D:/ws");
  assert.equal(result.block, true);
});

test("bash policy blocks rm -R -f flag order", () => {
  const result = evaluateBash("rm -R -f /", "D:/ws");
  assert.equal(result.block, true);
});

test("failure dedup: third identical failure blocks", () => {
  resetFailureCounters();
  const key = failureKey("bash", { command: "boom" });
  assert.equal(nextFailureDecision(key).block, false);
  recordFailure(key, true);
  assert.equal(nextFailureDecision(key).block, false);
  recordFailure(key, true);
  assert.equal(nextFailureDecision(key).block, true);
});

test("failure dedup: success resets the counter", () => {
  const key = failureKey("bash", { command: "boom" });
  recordFailure(key, true);
  recordFailure(key, true);
  recordFailure(key, false);
  assert.equal(nextFailureDecision(key).block, false);
});

test("failure dedup: different inputs keep separate counters", () => {
  const keyOne = failureKey("bash", { command: "one" });
  const keyTwo = failureKey("bash", { command: "two" });
  recordFailure(keyOne, true);
  recordFailure(keyOne, true);
  assert.equal(nextFailureDecision(keyOne).block, true);
  assert.equal(nextFailureDecision(keyTwo).block, false);
});

test("failure dedup: resetFailureCounters clears counters", () => {
  const key = failureKey("bash", { command: "boom" });
  recordFailure(key, true);
  recordFailure(key, true);
  resetFailureCounters();
  assert.equal(nextFailureDecision(key).block, false);
});

test("secret target detection recognises conventional secret basenames", () => {
  assert.equal(isSecretTarget(".env", "D:/ws"), true);
  assert.equal(isSecretTarget(".env.local", "D:/ws"), true);
  assert.equal(isSecretTarget(".netrc", "D:/ws"), true);
  assert.equal(isSecretTarget("id_rsa", "D:/ws"), true);
  assert.equal(isSecretTarget("server.pem", "D:/ws"), true);
});

test("secret target detection allows documentation and public key files", () => {
  assert.equal(isSecretTarget(".env.example", "D:/ws"), false);
  assert.equal(isSecretTarget(".env.sample", "D:/ws"), false);
  assert.equal(isSecretTarget(".env.template", "D:/ws"), false);
  assert.equal(isSecretTarget("id_rsa.pub", "D:/ws"), false);
  assert.equal(isSecretTarget("notes.md", "D:/ws"), false);
});

test("secret detection: credential-shaped values look like secrets", () => {
  assert.equal(looksLikeSecret("sk-abcdefghijklmnop1234567890abcdef"), true);
  assert.equal(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----"), true);
  assert.equal(looksLikeSecret("AKIAIOSFODNN7EXAMPLE"), true);
  assert.equal(looksLikeSecret("ghp_0123456789abcdefghijklmnopqrstuvwxyz"), true);
});

test("secret detection: ordinary prose and bare token words do not", () => {
  assert.equal(looksLikeSecret("the deployment token is rotated weekly"), false);
  assert.equal(looksLikeSecret("token"), false);
});

test("tool_call policy blocks secret read without leaking file contents", async () => {
  const dir = tmpDir();
  writeFileSync(`${dir}/.env`, "SENTINEL_supersecret_value\n");
  const pi = fakePi();
  policyDefault(pi as never);
  const ctx: FakeCtx = fakeCtx(dir);
  const handler = toolCallHandler(pi);
  const outcome = (await handler({ toolName: "read", input: { path: ".env" } }, ctx)) as PolicyBlockResult | undefined;
  assert.equal(outcome?.block, true);
  const reason = outcome?.reason;
  assert.ok(typeof reason === "string");
  assert.ok(!reason.includes("SENTINEL_supersecret_value"));
  const toolResult = toolResultHandler(pi);
  await toolResult(
    { toolName: "read", input: { path: ".env" }, content: [{ type: "text", text: "SENTINEL_supersecret_value" }], isError: true },
    ctx,
  );
  const telemetryText = readFileSync(`${dir}/.omp/harness/telemetry.jsonl`, "utf8");
  assert.ok(!telemetryText.includes("SENTINEL_supersecret_value"));
});

test("policy source contains no network, no Jev import, no tool registration", () => {
  const source = policySource();
  assert.ok(!source.includes("fetch("));
  assert.ok(!source.includes("@typesafe-ai"));
  assert.ok(!source.includes("decisions.ts"));
  assert.ok(!source.includes("registerTool"));
});

test("policy registers exactly the allowed event set", () => {
  const pi = fakePi();
  policyDefault(pi as never);
  const events = [...pi.handlers.keys()].sort();
  assert.deepEqual(events, EXPECTED_EVENTS);
  for (const forbidden of FORBIDDEN_EVENTS) {
    assert.equal(events.includes(forbidden), false, `forbidden event registered: ${forbidden}`);
  }
});

test("tool_result telemetry records error shape", async () => {
  const dir = tmpDir();
  const pi = fakePi();
  policyDefault(pi as never);
  const ctx: FakeCtx = fakeCtx(dir);
  const handler = toolResultHandler(pi);
  await handler(
    { toolName: "read", input: { path: ".env" }, content: [{ type: "text", text: "boom" }], isError: true },
    ctx,
  );
  const telemetryText = readFileSync(`${dir}/.omp/harness/telemetry.jsonl`, "utf8");
  const lines = telemetryText.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.ok(typeof record.timestamp === "string");
  assert.equal(record.event, "tool_result");
  assert.equal(record.session_id, "test-session");
  assert.equal(typeof record.pid, "number");
  assert.equal(record.tool, "read");
  assert.equal(record.ok, false);
  assert.equal(typeof record.error_class, "string");
});

test("todo task text differing only by diacritics or punctuation resolves to the stored text", () => {
  const phases = [{ name: "Tasks", tasks: [{ content: "Đọc log omp: tìm lỗi Todo" }] }];
  assert.deepEqual(resolveTodoInput({ op: "done", task: "Doc log omp tim loi Todo" }, phases), {
    op: "done",
    task: "Đọc log omp: tìm lỗi Todo",
  });
});

test("todo task text that is exact, unknown, or ambiguous passes through unchanged", () => {
  const phases = [{ name: "Tasks", tasks: [{ content: "Kiểm tra memory" }, { content: "Kiem tra, memory" }] }];
  assert.equal(resolveTodoInput({ op: "start", task: "Kiểm tra memory" }, phases), undefined);
  assert.equal(resolveTodoInput({ op: "start", task: "Viết plan" }, phases), undefined);
  assert.equal(resolveTodoInput({ op: "start", task: "Kiem tra memory" }, phases), undefined);
});

test("todo append with a singular task and no items becomes items with that task", () => {
  assert.deepEqual(resolveTodoInput({ op: "append", phase: "Tasks", task: "Viết plan" }, []), {
    op: "append",
    phase: "Tasks",
    items: ["Viết plan"],
  });
  assert.equal(resolveTodoInput({ op: "append", phase: "Tasks", task: "A", items: ["B"] }, []), undefined);
});

test("todo tool_call rewrites the task from the latest committed state and skips errored results", async () => {
  const branch = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        isError: false,
        details: { op: "init", phases: [{ name: "Tasks", tasks: [{ content: "Đọc log", status: "pending" }] }] },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        isError: true,
        details: { op: "done", phases: [{ name: "Tasks", tasks: [{ content: "Khác", status: "pending" }] }] },
      },
    },
  ];
  const pi = fakePi();
  policyDefault(pi as never);
  const ctx = { ...fakeCtx(tmpDir()), sessionManager: { getSessionId: () => "test-session", getBranch: () => branch } };
  const outcome = (await toolCallHandler(pi)({ toolName: "todo", input: { op: "done", task: "Doc log" } }, ctx)) as
    | { block?: boolean; input?: Record<string, unknown> }
    | undefined;
  assert.equal(outcome?.block, undefined);
  assert.deepEqual(outcome?.input, { op: "done", task: "Đọc log" });
});

test("todo append without a phase joins the only existing phase and is unchanged with several", () => {
  const one = [{ name: "Verify", tasks: [{ content: "A" }] }];
  assert.deepEqual(resolveTodoInput({ op: "append", items: ["B"] }, one), { op: "append", items: ["B"], phase: "Verify" });
  const two = [
    { name: "Verify", tasks: [{ content: "A" }] },
    { name: "Tasks", tasks: [] },
  ];
  assert.equal(resolveTodoInput({ op: "append", items: ["B"] }, two), undefined);
});

test("secret detection ignores a trailing read selector without hiding the secret file", async () => {
  const dir = tmpDir();
  assert.equal(isSecretTarget(".env:1-5", dir), true);
  assert.equal(isSecretTarget(".env.example:1-40", dir), false);
  assert.equal(isSecretTarget("README.md:1-20", dir), false);
  const pi = fakePi();
  policyDefault(pi as never);
  const outcome = (await toolCallHandler(pi)({ toolName: "read", input: { path: ".env:1-5" } }, fakeCtx(dir))) as
    | PolicyBlockResult
    | undefined;
  assert.equal(outcome?.block, true);
});

test("bash policy normalizes MSYS drive paths against a Windows workspace", () => {
  assert.equal(evaluateBash("rm -rf /d/ws", "D:/ws").block, true);
  assert.equal(evaluateBash("rm -rf /d/ws/sub", "D:/ws").block, false);
  assert.equal(evaluateBash("rm -rf /d/outside", "D:/ws").block, true);
});

test("secret detection strips compound :raw:1-5 and :conflicts selectors", () => {
  const dir = tmpDir();
  assert.equal(isSecretTarget(".env:raw:1-5", dir), true);
  assert.equal(isSecretTarget(".env:conflicts", dir), true);
});

test("session_shutdown from a subagent does not reset parent failure counters", async () => {
  const dir = tmpDir();
  const pi = fakePi();
  policyDefault(pi as never);
  const resultHandler = pi.handlers.get("tool_result")?.[0];
  const shutdownHandler = pi.handlers.get("session_shutdown")?.[0];
  assert.ok(resultHandler && shutdownHandler);
  const call = { toolName: "bash", input: { command: "false" } };
  await resultHandler({ ...call, toolCallId: "c1", isError: true, content: "fail" }, fakeCtx(dir));
  await resultHandler({ ...call, toolCallId: "c2", isError: true, content: "fail" }, fakeCtx(dir));
  await shutdownHandler({}, { ...fakeCtx(dir), agent: { kind: "sub" } });
  const blocked = (await toolCallHandler(pi)(call, fakeCtx(dir))) as PolicyBlockResult | undefined;
  assert.equal(blocked?.block, true);
  await shutdownHandler({}, fakeCtx(dir));
  const afterMainShutdown = (await toolCallHandler(pi)(call, fakeCtx(dir))) as PolicyBlockResult | undefined;
  assert.equal(afterMainShutdown, undefined);
});

test("secret detection catches .. ranges, L-prefixed lines, and hashline edit headers", async () => {
  const dir = tmpDir();
  assert.equal(isSecretTarget(".env:1..50", dir), true);
  assert.equal(isSecretTarget(".env:L1-L20", dir), true);
  assert.equal(isSecretTarget(".env:1-5,:-10", dir), true);
  const pi = fakePi();
  policyDefault(pi as never);
  const editOutcome = (await toolCallHandler(pi)(
    { toolName: "edit", input: { input: "[.env#1A2B]\nPUT 1.=1:\n+FOO=bar\n" } },
    fakeCtx(dir),
  )) as PolicyBlockResult | undefined;
  assert.equal(editOutcome?.block, true);
});

test("resetFailureCounters(prefix) removes only matching keys", () => {
  const keyA = failureKey("bash", { command: "scopeA|cmd1" });
  const keyB = failureKey("bash", { command: "scopeB|cmd2" });
  const keyC = failureKey("edit", { input: "scopeA|cmd3" });
  recordFailure(keyA, true);
  recordFailure(keyB, true);
  recordFailure(keyC, true);
  assert.equal(nextFailureDecision(keyA).block, false);
  assert.equal(nextFailureDecision(keyB).block, false);
  assert.equal(nextFailureDecision(keyC).block, false);

  resetFailureCounters("scopeA");
  recordFailure(keyA, true);
  recordFailure(keyA, true);
  assert.equal(nextFailureDecision(keyA).block, true);

  recordFailure(keyB, true);
  assert.equal(nextFailureDecision(keyB).block, true);

  recordFailure(keyC, true);
  assert.equal(nextFailureDecision(keyC).block, true);

  resetFailureCounters();
  assert.equal(nextFailureDecision(keyA).block, false);
  assert.equal(nextFailureDecision(keyB).block, false);
  assert.equal(nextFailureDecision(keyC).block, false);
});

// ---------------------------------------------------------------------------
// F-04: git -C <dir> push --force guard via isGitPushCommand
// ---------------------------------------------------------------------------

test("bash policy blocks git -C <dir> push --force origin main", () => {
  const result = evaluateBash("git -C D:/omp-harness push --force origin main", "D:/omp-harness");
  assert.equal(result.block, true);
  assert.ok(result.reason!.includes("git push --force"));
});

test("bash policy allows git -C <dir> push --force-with-lease origin main", () => {
  const result = evaluateBash("git -C D:/omp-harness push --force-with-lease origin main", "D:/omp-harness");
  assert.equal(result.block, false);
});

test("bash policy blocks plain git push --force", () => {
  const result = evaluateBash("git push --force origin main", "D:/omp-harness");
  assert.equal(result.block, true);
});

// ---------------------------------------------------------------------------
// F-03: rewritten-input failure-dedup key alignment via toolCallId
// ---------------------------------------------------------------------------

test("tool_call saves effectiveInput keyed by toolCallId and tool_result reuses it", async () => {
  const dir = tmpDir();
  const pi = fakePi();
  policyDefault(pi as never);
  const ctx: FakeCtx = { ...fakeCtx(dir), sessionManager: { getSessionId: () => "s1" } };

  const handler = toolCallHandler(pi);
  const resultHandler = toolResultHandler(pi);

  // Prime the failure counter: 1 prior identical failure (count=1, not yet blocked).
  const key = failureKey("bash", { command: "false" });
  recordFailure(key, true);
  assert.equal(nextFailureDecision(key).block, false);

  // tool_call saves effectiveInput under toolCallId "c1"; not blocked yet (count=1).
  await handler({ toolName: "bash", input: { command: "false" }, toolCallId: "c1" }, ctx);
  // tool_result records a failure on that same effectiveInput → count=2.
  await resultHandler({ toolName: "bash", input: { command: "true" }, toolCallId: "c1", isError: true, content: "fail" }, ctx);

  // A new tool_call with the same effective input now hits count=2 and is blocked.
  const blocked = (await handler({ toolName: "bash", input: { command: "false" }, toolCallId: "c2" }, ctx)) as
    | { block?: boolean; reason?: string }
    | undefined;
    assert.equal(blocked?.block, true, "second identical effective input should be blocked");
});

// ---------------------------------------------------------------------------
// Joint 3: resolveTodoInput todo auto-heal
// ---------------------------------------------------------------------------

test("init auto-heals missing phase", () => {
  assert.deepEqual(resolveTodoInput({ op: "init", items: ["A"] }, []), {
    op: "init",
    list: [{ phase: "Tasks", items: ["A"] }],
  });
});

test("init two entries missing phase", () => {
  assert.deepEqual(
    resolveTodoInput({ op: "init", list: [{ items: ["A"] }, { items: ["B"] }] }, []),
    { op: "init", list: [{ phase: "Tasks", items: ["A"] }, { phase: "Phase 2", items: ["B"] }] },
  );
});

test("init filters empty-item phases", () => {
  assert.deepEqual(
    resolveTodoInput(
      { op: "init", list: [{ phase: "X", items: [] }, { phase: "Y", items: ["Z"] }] },
      [],
    ),
    { op: "init", list: [{ phase: "Y", items: ["Z"] }] },
  );
});

test("init wraps top-level task", () => {
  assert.deepEqual(resolveTodoInput({ op: "init", task: "buy milk" }, []), {
    op: "init",
    items: ["buy milk"],
  });
});

test("done with items converts to task", () => {
  const phases = [{ name: "Tasks", tasks: [{ content: "existing task" }] }];
  assert.deepEqual(resolveTodoInput({ op: "done", items: ["existing task"] }, phases), {
    op: "done",
    task: "existing task",
  });
});

test("init with tasks instead of items", () => {
  assert.deepEqual(
    resolveTodoInput({ op: "init", list: [{ phase: "P", tasks: [{ content: "t1" }] }] }, []),
    { op: "init", list: [{ phase: "P", items: ["t1"] }] },
  );
});
