import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePi, fakeCtx, type FakePi } from "./_fake-pi.ts";
import verifyGate, {
  classifyVerifyCommand,
  createGateState,
  recordMutation,
  recordVerification,
  needsVerification,
  isMutatingTaskCall,
  hasDesignLesson,
  buildPostSessionLessonPrompt,
} from "../src/verify-gate.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function mount(pi: FakePi, deps?: Parameters<typeof verifyGate>[1]) {
  verifyGate(pi as never, deps);
}

async function fire(
  handlers: Map<string, Handler[]>,
  name: string,
  event: unknown,
  ctx: unknown,
): Promise<unknown> {
  const list = handlers.get(name) ?? [];
  assert.ok(list.length > 0, `no handler registered for ${name}`);
  return list[0](event, ctx);
}

test("classifyVerifyCommand accepts listed commands", () => {
  const accepted = [
    "node --test",
    "npm test",
    "npm run build",
    "pnpm test",
    "pytest -q",
    "cargo test",
    "tsc --noEmit",
    "npx vitest run",
    "cd D:/omp-harness && node scripts/verify.mjs",
  ];
  for (const c of accepted) {
    assert.equal(classifyVerifyCommand(c), true, c);
  }
});

test("classifyVerifyCommand rejects non-checks", () => {
  const rejected = ["ls -la", "git status", "git diff", "cat package.json", "node --version", "npm install"];
  for (const c of rejected) {
    assert.equal(classifyVerifyCommand(c), false, c);
  }
});

test("write then stop prompts verification", async () => {
  const pi = fakePi();
  mount(pi);
  const ctx = fakeCtx(process.cwd());
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx);
  const result = await fire(pi.handlers, "session_stop", {}, ctx) as { continue?: boolean; additionalContext?: string } | undefined;
  assert.ok(result);
  assert.equal(result!.continue, true);
  assert.match(result!.additionalContext ?? "", /verify-gate/);
});

test("write then successful node --test → no prompt", async () => {
  const pi = fakePi();
  mount(pi);
  const ctx = fakeCtx(process.cwd());
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx);
  await fire(pi.handlers, "tool_result", { toolName: "bash", isError: false, input: { command: "node --test" } }, ctx);
  const result = await fire(pi.handlers, "session_stop", {}, ctx);
  assert.equal(result, undefined);
});

test("verify before write still prompts", async () => {
  const pi = fakePi();
  mount(pi);
  const ctx = fakeCtx(process.cwd());
  await fire(pi.handlers, "tool_result", { toolName: "bash", isError: false, input: { command: "node --test" } }, ctx);
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx);
  const result = await fire(pi.handlers, "session_stop", {}, ctx) as { continue?: boolean } | undefined;
  assert.ok(result);
  assert.equal(result!.continue, true);
});

test("errored node --test counts as no mutation but no crash", async () => {
  const pi = fakePi();
  mount(pi);
  const ctx = fakeCtx(process.cwd());
  await fire(pi.handlers, "tool_result", { toolName: "bash", isError: true, input: { command: "node --test" } }, ctx);
  const result = await fire(pi.handlers, "session_stop", {}, ctx);
  assert.equal(result, undefined);
});

test("a failing check after a write keeps the gate dirty (failed check does not clear mutations)", async () => {
  const pi = fakePi();
  mount(pi);
  const ctx = fakeCtx(process.cwd());
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx);
  await fire(pi.handlers, "tool_result", { toolName: "bash", isError: true, input: { command: "node --test" } }, ctx);
  const result = await fire(pi.handlers, "session_stop", {}, ctx) as { continue?: boolean; additionalContext?: string } | undefined;
  assert.equal(result?.continue, true);
  assert.ok(result?.additionalContext?.includes("FAILED"), "session_stop should warn that last verification FAILED");
});

test("maxContinuations 1 → second prompt suppressed", async () => {
  const pi = fakePi();
  mount(pi, { maxContinuations: 1 });
  const ctx = fakeCtx(process.cwd());
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx);
  const first = await fire(pi.handlers, "session_stop", {}, ctx) as { continue?: boolean } | undefined;
  assert.equal(first?.continue, true);
  // second mutation + stop
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx);
  const second = await fire(pi.handlers, "session_stop", {}, ctx);
  assert.equal(second, undefined);
});

test("subagent session_stop returns undefined", async () => {
  const pi = fakePi();
  mount(pi);
  const ctx = { ...fakeCtx(process.cwd()), agent: { kind: "sub" } };
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx);
  const result = await fire(pi.handlers, "session_stop", {}, ctx);
  assert.equal(result, undefined);
});

test("an unverified mutation in one session does not force a continuation in another session of the same cwd", async () => {
  const pi = fakePi();
  mount(pi);
  const cwd = process.cwd();
  const sessionA = fakeCtx(cwd);
  const sessionB = { ...fakeCtx(cwd), sessionManager: { getSessionId: () => "other-session" } };
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, sessionA);
  const leaked = await fire(pi.handlers, "session_stop", {}, sessionB);
  assert.equal(leaked, undefined);
  const own = await fire(pi.handlers, "session_stop", {}, sessionA) as { continue?: boolean } | undefined;
  assert.equal(own?.continue, true);
});

test("isMutatingTaskCall: mutating task marks dirty", () => {
  assert.equal(isMutatingTaskCall({ tasks: [{ agent: "coder" }] }), true);
  assert.equal(isMutatingTaskCall({ tasks: [{ agent: "builder" }] }), true);
});

test("isMutatingTaskCall: read-only agents never mark dirty", () => {
  for (const agent of ["scout", "reviewer", "security-reviewer", "architect", "plan-drafter", "plan-reviewer", "researcher", "seance", "harness-grader", "harness-proposer", "qa-verifier"]) {
    assert.equal(isMutatingTaskCall({ tasks: [{ agent }] }), false, agent);
  }
  assert.equal(isMutatingTaskCall({ tasks: [{ agent: "egm-zoom-out" }] }), false);
  assert.equal(isMutatingTaskCall({ tasks: [{ agent: "egm-something-else" }] }), false);
});

test("isMutatingTaskCall: at least one mutating task marks dirty", () => {
  assert.equal(isMutatingTaskCall({ tasks: [{ agent: "reviewer" }, { agent: "coder" }] }), true);
  assert.equal(isMutatingTaskCall({ tasks: [{ agent: "scout" }, { agent: "reviewer" }] }), false);
});

test("isMutatingTaskCall: no tasks array defaults to mutating unless agent is read-only", () => {
  assert.equal(isMutatingTaskCall({ agent: "coder" }), true);
  assert.equal(isMutatingTaskCall({ agent: "scout" }), false);
  assert.equal(isMutatingTaskCall({ agent: "egm-zoom-out" }), false);
  assert.equal(isMutatingTaskCall({}), true);
  assert.equal(isMutatingTaskCall(undefined), true);
});

test("recordVerification sets lastCheckPassed and lastCheckError", () => {
  const state = createGateState();
  state.mutations = 3;
  recordVerification(state);
  assert.equal(state.lastCheckPassed, true);
  assert.equal(state.lastCheckError, false);
  assert.equal(state.verifications, 3);
  assert.equal(needsVerification(state), false, "passing check clears outstanding mutations");

  const failing = createGateState();
  failing.mutations = 3;
  recordVerification(failing, true);
  assert.equal(failing.lastCheckPassed, false);
  assert.equal(failing.lastCheckError, true);
  assert.equal(failing.verifications, 0, "failed check does not clear mutations");
  assert.equal(needsVerification(failing), true, "failed check leaves gate dirty");
});

test("mutating task tool_result marks gate dirty", async () => {
  const pi = fakePi();
  mount(pi);
  const ctx = fakeCtx(process.cwd());
  await fire(pi.handlers, "tool_call", { toolName: "task", input: { tasks: [{ agent: "coder" }] }, toolCallId: "t1" }, ctx);
  await fire(pi.handlers, "tool_result", { toolName: "task", isError: false, input: { tasks: [{ agent: "coder" }] }, toolCallId: "t1" }, ctx);
  const result = await fire(pi.handlers, "session_stop", {}, ctx) as { continue?: boolean } | undefined;
  assert.equal(result?.continue, true);
});

test("read-only scout/reviewer/egm-zoom-out task does not mark gate dirty", async () => {
  for (const agent of ["scout", "reviewer", "egm-zoom-out"]) {
    const pi = fakePi();
    mount(pi);
    const ctx = fakeCtx(process.cwd());
    await fire(pi.handlers, "tool_result", { toolName: "task", isError: false, input: { tasks: [{ agent }] } }, ctx);
    const result = await fire(pi.handlers, "session_stop", {}, ctx);
    assert.equal(result, undefined, `${agent} should not mark dirty`);
  }
});

test("vibe_spawn mutating task marks gate dirty", async () => {
  const pi = fakePi();
  mount(pi);
  const ctx = fakeCtx(process.cwd());
  await fire(pi.handlers, "tool_call", { toolName: "vibe_spawn", input: { name: "coder-swarm", tasks: [{ agent: "coder" }] }, toolCallId: "vs1" }, ctx);
  await fire(pi.handlers, "tool_result", { toolName: "vibe_spawn", isError: false, input: { name: "coder-swarm", tasks: [{ agent: "coder" }] }, toolCallId: "vs1" }, ctx);
  const result = await fire(pi.handlers, "session_stop", {}, ctx) as { continue?: boolean } | undefined;
  assert.equal(result?.continue, true, "mutating vibe_spawn should mark gate dirty");
});

test("vibe_send mutating task marks gate dirty", async () => {
  const pi = fakePi();
  mount(pi);
  const ctx = fakeCtx(process.cwd());
  await fire(pi.handlers, "tool_call", { toolName: "vibe_send", input: { name: "coder-swarm" }, toolCallId: "vs2" }, ctx);
  await fire(pi.handlers, "tool_result", { toolName: "vibe_send", isError: false, input: { name: "coder-swarm" }, toolCallId: "vs2" }, ctx);
  const result = await fire(pi.handlers, "session_stop", {}, ctx) as { continue?: boolean } | undefined;
  assert.equal(result?.continue, true, "mutating vibe_send should mark gate dirty");
});

test("read-only/goldfish/reviewer/auditor vibe_spawn does not mark gate dirty", async () => {
  for (const name of ["goldfish-arch-critic", "egm-zoom-out", "reviewer-auditor", "security-auditor"]) {
    const pi = fakePi();
    mount(pi);
    const ctx = fakeCtx(process.cwd());
    await fire(pi.handlers, "tool_result", { toolName: "vibe_spawn", isError: false, input: { name, tasks: [{ agent: "coder" }] } }, ctx);
    const result = await fire(pi.handlers, "session_stop", {}, ctx);
    assert.equal(result, undefined, `${name} vibe_spawn should not mark dirty`);
  }
});

test("classifyVerifyCommand accepts additional listed commands", () => {
  const accepted = [
    "bun run typecheck",
    "pnpm build",
    "npx tsc --noEmit",
    "uv run pytest",
    "poetry run mypy",
    "python -m pytest",
    "yarn lint",
    "go vet",
    "dotnet build",
    "npx playwright test",
  ];
  for (const c of accepted) {
    assert.equal(classifyVerifyCommand(c), true, c);
  }
});

test("classifyVerifyCommand rejects shell and version commands", () => {
  const rejected = ["ls -la", "git status", "node --version"];
  for (const c of rejected) {
    assert.equal(classifyVerifyCommand(c), false, c);
  }
});

test("session_stop skips continuation when bash is not an active tool", async () => {
  const pi = fakePi();
  mount(pi);
  const ctx = fakeCtx(process.cwd());
  pi.setActiveTools(["read", "write"]);
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx);
  const skipped = await fire(pi.handlers, "session_stop", {}, ctx);
  assert.equal(skipped, undefined);

  // Control: bash is an active tool and a mutation is dirty → continuation.
  const pi2 = fakePi();
  mount(pi2);
  const ctx2 = fakeCtx(process.cwd());
  pi2.setActiveTools(["read", "write", "bash"]);
  await fire(pi2.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx2);
  const continued = await fire(pi2.handlers, "session_stop", {}, ctx2) as { continue?: boolean } | undefined;
  assert.equal(continued?.continue, true);
});

// ---------------------------------------------------------------------------
// Lesson gate (PUB-18 / disposition H)
// ---------------------------------------------------------------------------

test("hasDesignLesson is true only when both why and counter-example signals are present", () => {
  assert.equal(hasDesignLesson("Why this design is right. Avoid misconception: not for look-alike cases."), true);
  assert.equal(hasDesignLesson("vì sao thiết kế đúng. tránh lầm tưởng ở các case tương tự"), true);
  // "counter-example" in the why-only string trips the counter regex; use a neutral tail.
  assert.equal(hasDesignLesson("Why this design is right. All good here."), false);
  assert.equal(hasDesignLesson("Avoid misconception: not for look-alike cases. No why."), false);
  assert.equal(hasDesignLesson(""), false);
});

test("buildPostSessionLessonPrompt contains the session phrase and the mutated file list", () => {
  const prompt = buildPostSessionLessonPrompt(["src/policy.ts", "src/state.ts"]);
  assert.match(prompt, /Before ending this coding session/);
  assert.match(prompt, /src\/policy\.ts/);
  assert.match(prompt, /src\/state\.ts/);
});

test("requireLessonOnStop: first quiet session_stop continues once with lesson-gate context, second does not", async () => {
  const pi = fakePi();
  mount(pi, { requireLessonOnStop: true });
  const ctx = fakeCtx(process.cwd());
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx);
  await fire(pi.handlers, "tool_result", { toolName: "bash", isError: false, input: { command: "node --test" } }, ctx);
  const first = await fire(pi.handlers, "session_stop", {}, ctx) as { continue?: boolean; additionalContext?: string } | undefined;
  assert.ok(first);
  assert.equal(first!.continue, true);
  assert.match(first!.additionalContext ?? "", /lesson-gate/);
  const second = await fire(pi.handlers, "session_stop", {}, ctx);
  assert.equal(second, undefined);
});

test("OMP_HARNESS_LESSON_GATE=1 enables the lesson continuation without deps", async () => {
  const prev = process.env.OMP_HARNESS_LESSON_GATE;
  process.env.OMP_HARNESS_LESSON_GATE = "1";
  try {
    const pi = fakePi();
    mount(pi);
    const ctx = fakeCtx(process.cwd());
    await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx);
    await fire(pi.handlers, "tool_result", { toolName: "bash", isError: false, input: { command: "node --test" } }, ctx);
    const first = await fire(pi.handlers, "session_stop", {}, ctx) as { continue?: boolean; additionalContext?: string } | undefined;
    assert.equal(first?.continue, true);
    assert.match(first!.additionalContext ?? "", /lesson-gate/);
  } finally {
    if (prev === undefined) delete process.env.OMP_HARNESS_LESSON_GATE;
    else process.env.OMP_HARNESS_LESSON_GATE = prev;
  }
});

test("/harness-lesson on sets OMP_HARNESS_LESSON_GATE=1, off sets it to 0", async () => {
  const prev = process.env.OMP_HARNESS_LESSON_GATE;
  process.env.OMP_HARNESS_LESSON_GATE = "0";
  try {
    const pi = fakePi();
    mount(pi);
    const ctx = fakeCtx(process.cwd());
    const cmd = pi.commands.get("harness-lesson");
    assert.ok(cmd, "harness-lesson command registered");
    await cmd!.handler("on", ctx);
    assert.equal(process.env.OMP_HARNESS_LESSON_GATE, "1");
    await cmd!.handler("off", ctx);
    assert.equal(process.env.OMP_HARNESS_LESSON_GATE, "0");
  } finally {
    if (prev === undefined) delete process.env.OMP_HARNESS_LESSON_GATE;
    else process.env.OMP_HARNESS_LESSON_GATE = prev;
  }
});

// ---- verify-gate v2 (flag harness.verifyGate.v2) ----
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./_fake-pi.ts";
import { isDocPath, readVerifyCommands } from "../src/verify-gate.ts";

type StopResult = { continue?: boolean; additionalContext?: string } | undefined;

function projectWith(scripts: Record<string, string> | null): string {
  const dir = tmpDir();
  if (scripts) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx", scripts }));
  return dir;
}

async function stop(pi: FakePi, ctx: unknown): Promise<StopResult> {
  return (await fire(pi.handlers, "session_stop", {}, ctx)) as StopResult;
}

test("v2 off: block message is byte-identical to the legacy message", async () => {
  const pi = fakePi();
  mount(pi, { v2: false });
  const ctx = fakeCtx(projectWith({ test: "node --test" }));
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: { path: "a.ts" } }, ctx);
  const result = await stop(pi, ctx);
  assert.equal(
    result?.additionalContext,
    "harness verify-gate: 1 file mutation(s) since the last check run. Run the project's real verification (test/build/lint command or a scripted smoke run) and report what it printed, or state explicitly that no check applies. Once verified, also explain to the user (1) why your design/change is right and (2) which look-alike cases must NOT use this design.",
  );
});

test("v2 off: a .md-only edit is still gated", async () => {
  const pi = fakePi();
  mount(pi, { v2: false });
  const ctx = fakeCtx(projectWith({ test: "node --test" }));
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: { path: "README.md" } }, ctx);
  assert.equal((await stop(pi, ctx))?.continue, true);
});

test("v2 on with scripts.test: message names npm test", async () => {
  const pi = fakePi();
  mount(pi, { v2: true });
  const ctx = fakeCtx(projectWith({ test: "node --test", lint: "eslint ." }));
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: { path: "a.ts" } }, ctx);
  const msg = (await stop(pi, ctx))?.additionalContext ?? "";
  assert.match(msg, /npm test/);
  assert.match(msg, /npm run lint/);
});

test("v2 on without package.json: generic ask, no invented command", async () => {
  const pi = fakePi();
  mount(pi, { v2: true });
  const ctx = fakeCtx(projectWith(null));
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: { path: "a.py" } }, ctx);
  const msg = (await stop(pi, ctx))?.additionalContext ?? "";
  assert.doesNotMatch(msg, /npm /);
  assert.match(msg, /real verification/);
});

test("v2 on: docs-only mutations do not block", async () => {
  const pi = fakePi();
  mount(pi, { v2: true });
  const ctx = fakeCtx(projectWith({ test: "node --test" }));
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: { path: "README.md" } }, ctx);
  await fire(pi.handlers, "tool_result", { toolName: "edit", isError: false, input: { path: "notes.txt" } }, ctx);
  assert.equal(await stop(pi, ctx), undefined);
});

test("v2 on: a docs-only edit after a passing check does not block", async () => {
  const pi = fakePi();
  mount(pi, { v2: true });
  const ctx = fakeCtx(projectWith({ test: "node --test" }));
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: { path: "src/a.ts" } }, ctx);
  await fire(pi.handlers, "tool_result", { toolName: "bash", isError: false, input: { command: "node --test" } }, ctx);
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: { path: "README.md" } }, ctx);
  assert.equal(await stop(pi, ctx), undefined);
});

test("v2 on: docs plus one code file still blocks", async () => {
  const pi = fakePi();
  mount(pi, { v2: true });
  const ctx = fakeCtx(projectWith({ test: "node --test" }));
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: { path: "README.md" } }, ctx);
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: { path: "src/a.ts" } }, ctx);
  assert.equal((await stop(pi, ctx))?.continue, true);
});

test("v2 on: mutation with unknown path is treated as code", async () => {
  const pi = fakePi();
  mount(pi, { v2: true });
  const ctx = fakeCtx(projectWith({ test: "node --test" }));
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: {} }, ctx);
  assert.equal((await stop(pi, ctx))?.continue, true);
});

test("v2 on: third block asks to run the check or declare none applies", async () => {
  const pi = fakePi();
  mount(pi, { v2: true });
  const ctx = fakeCtx(projectWith({ test: "node --test" }));
  await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: { path: "a.ts" } }, ctx);
  const first = (await stop(pi, ctx))?.additionalContext ?? "";
  const second = (await stop(pi, ctx))?.additionalContext ?? "";
  const third = (await stop(pi, ctx))?.additionalContext ?? "";
  assert.doesNotMatch(first, /last reminder/);
  assert.doesNotMatch(second, /last reminder/);
  assert.match(third, /last reminder/);
  assert.match(third, /npm test/);
  assert.match(third, /"No check applies"/);
  assert.equal(await stop(pi, ctx), undefined);
});

test("readVerifyCommands and isDocPath helpers", () => {
  assert.deepEqual(readVerifyCommands(projectWith({ lint: "x", test: "y", build: "z" })), ["npm test", "npm run lint"]);
  assert.deepEqual(readVerifyCommands(projectWith(null)), []);
  assert.equal(isDocPath("docs/a.MD"), true);
  assert.equal(isDocPath("a.ts"), false);
});

test("v2 flag is read from config.yml harness.verifyGate.v2", async () => {
  const agentDir = tmpDir();
  const prev = process.env.PI_CODING_AGENT_DIR;
  const prevEnv = process.env.OMP_HARNESS_VERIFY_GATE_V2;
  delete process.env.OMP_HARNESS_VERIFY_GATE_V2;
  try {
    for (const [value, expectNpm] of [["true", true], ["false", false]] as const) {
      writeFileSync(join(agentDir, "config.yml"), `task:\n  eager: preferred\nharness:\n  verifyGate:\n    v2: ${value}  # note\n`);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const pi = fakePi();
      mount(pi);
      const ctx = fakeCtx(projectWith({ test: "node --test" }));
      await fire(pi.handlers, "tool_result", { toolName: "write", isError: false, input: { path: "a.ts" } }, ctx);
      const msg = (await stop(pi, ctx))?.additionalContext ?? "";
      assert.equal(/npm test/.test(msg), expectNpm, value);
    }
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    if (prevEnv !== undefined) process.env.OMP_HARNESS_VERIFY_GATE_V2 = prevEnv;
  }
});
