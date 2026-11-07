/**
 * intake.test.ts — shadow Jev intake behavior.
 *
 * Deterministic and offline: the input handler returns before judging whenever
 * Jev is disabled, and even when enabled the judge fails closed (no API key) to
 * an `unavailable` answer without touching the session or writing a receipt.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tools from "../src/tools.ts";
import { fakePi, fakeCtx, collectSpyCalls, tmpDir, type FakePi } from "./_fake-pi.ts";
import intake, { skillCandidates } from "../src/intake.ts";
import { jevEndpoint, probeFileFor, readEndpointProbe } from "../src/decisions.ts";
import {
  clearSessionState,
  getSuggestion,
  isJevInputAllowed,
  setJevInputAllowed,
  setSuggestion,
  submissionCount,
} from "../src/state.ts";

const ENV_KEYS = [
  "OMP_HARNESS_JEV",
  "OMP_HARNESS_JEV_MODEL",
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "OMP_PROFILE",
  "PI_MODEL",
  "OMP_MODEL",
];
const FORBIDDEN_EVENTS = [
  "tool_call",
  "tool_result",
  "context",
  "before_agent_start",
  "before_provider_request",
  "assistant_message",
  "agent_end",
  "session.compacting",
  "session_before_compact",
];

type ExtensionFactoryArg = Parameters<typeof intake>[0];

/** Mount the real factory on the test double (FakePi covers only the SDK surface intake uses). */
function mountIntake(pi: FakePi, deps?: Parameters<typeof intake>[1]): void {
  intake(pi as unknown as ExtensionFactoryArg, deps);
}

function sessionSpies(pi: FakePi): Array<{ name: string; calls: unknown[][] }> {
  return [
    { name: "sendMessage", calls: collectSpyCalls(pi.sendMessage) },
    { name: "sendUserMessage", calls: collectSpyCalls(pi.sendUserMessage) },
    { name: "appendEntry", calls: collectSpyCalls(pi.appendEntry) },
    { name: "setModel", calls: collectSpyCalls(pi.setModel) },
    { name: "setThinkingLevel", calls: collectSpyCalls(pi.setThinkingLevel) },
    { name: "setActiveTools", calls: collectSpyCalls(pi.setActiveTools) },
  ];
}

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  clearSessionState();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  clearSessionState();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function skillPrompt(entries: string[]): string {
  return ["<skills>", ...entries.map((entry) => `- ${entry}`), "</skills>"].join("\n");
}

async function fireInput(pi: FakePi, event: Record<string, unknown>): Promise<void> {
  for (const handler of pi.handlers.get("input") ?? []) {
    await handler(event, fakeCtx(process.cwd()));
  }
}

// ---------------------------------------------------------------------------
// skillCandidates
// ---------------------------------------------------------------------------

test("skillCandidates selects a skill that shares at least two distinct tokens", () => {
  const prompt = skillPrompt([
    "code-review: review pull request diffs for defects",
    "harness-loop: mine outcome files and grade harness quality",
  ]);
  assert.deepEqual(skillCandidates(prompt, "please review the pull request diff"), ["code-review"]);
});

test("skillCandidates selects nothing when the request shares zero or one token", () => {
  const prompt = skillPrompt(["code-review: review pull request diffs for defects"]);
  // zero shared tokens
  assert.deepEqual(skillCandidates(prompt, "hello world"), []);
  // exactly one shared token ("review") is below the two-token threshold
  assert.deepEqual(skillCandidates(prompt, "review everything"), []);
});

test("skillCandidates caps results at the requested limit", () => {
  const prompt = skillPrompt([
    "s-a: alpha bravo tokens",
    "s-b: alpha bravo tokens",
    "s-c: alpha bravo tokens",
  ]);
  assert.deepEqual(skillCandidates(prompt, "alpha bravo tokens", 2), ["s-a", "s-b"]);
});

test("skillCandidates breaks score ties by skill name ascending", () => {
  const prompt = skillPrompt([
    "zeta-review: review parser tokens",
    "alpha-review: review parser tokens",
  ]);
  assert.deepEqual(skillCandidates(prompt, "review parser tokens"), ["alpha-review", "zeta-review"]);
});

test("skillCandidates keeps two- and three-letter technical acronyms", () => {
  const prompt = skillPrompt([
    "supabase-postgres-best-practices: sql rls policy schema migration",
    "impeccable: css layout polish contrast",
  ]);
  // Both prompts below would score zero if sql/rls/css were dropped for length.
  assert.deepEqual(skillCandidates(prompt, "fix the sql rls policy on this table"), ["supabase-postgres-best-practices"]);
  assert.deepEqual(skillCandidates(prompt, "css layout polish"), ["impeccable"]);
});

// ---------------------------------------------------------------------------
// Registered surface
// ---------------------------------------------------------------------------

test("intake registers exactly the input and session_shutdown events", () => {
  // Structural invariant: the event set is a cache/security contract. Any
  // subscription that mutates prompt or history would break the stable prefix,
  // and no runtime observation of one request can prove the absence of others.
  const pi = fakePi();
  mountIntake(pi);
  assert.deepEqual([...pi.handlers.keys()].sort(), ["input", "session_shutdown"]);
  for (const name of FORBIDDEN_EVENTS) {
    assert.equal(pi.handlers.has(name), false, `must not register ${name}`);
  }
  for (const spy of sessionSpies(pi)) {
    assert.equal(spy.calls.length, 0, `${spy.name} must not be called`);
  }
});

test("input handler resolves without touching the session when Jev is unset", async () => {
  const pi = fakePi();
  mountIntake(pi);
  const handler = pi.handlers.get("input")?.[0];
  assert.ok(handler, "input handler must be registered");
  await assert.doesNotReject(async () => {
    await handler(
      { text: "please add a docker compose file", source: "interactive" },
      fakeCtx(process.cwd()),
    );
  });
  for (const spy of sessionSpies(pi)) {
    assert.equal(spy.calls.length, 0, `${spy.name} must not be called`);
  }
});

test("G-04: input handler sets deterministic suggestion even when Jev is off", async () => {
  // Jev disabled: deterministic skill candidates must still be surfaced via setSuggestion.
  const pi = fakePi();
  mountIntake(pi);
  const handler = pi.handlers.get("input")?.[0];
  assert.ok(handler);
  await handler(
    { text: "please review the pull request diff", source: "interactive" },
    { ...fakeCtx(process.cwd()), getSystemPrompt() { return skillPrompt(["code-review: review pull request diffs for defects"]); } },
  );
  const suggestion = getSuggestion();
  assert.ok(suggestion, "deterministic suggestion must be set when Jev is off");
  const s = suggestion as { skills?: string[]; skill_basis?: string; status?: string };
  assert.ok(Array.isArray(s.skills) && s.skills.length > 0, "skills must be non-empty");
  assert.equal(s.skill_basis, "deterministic");
  assert.equal(s.status, "skipped");
});

test("G-04: input handler skips extension source before computing skills", async () => {
  const pi = fakePi();
  mountIntake(pi);
  const handler = pi.handlers.get("input")?.[0];
  assert.ok(handler);
  await handler(
    { text: "please review the pull request diff", source: "extension" },
    { ...fakeCtx(process.cwd()), getSystemPrompt() { return skillPrompt(["code-review: review pull request diffs for defects"]); } },
  );
  assert.equal(getSuggestion(), null, "extension-sourced input must not set a suggestion");
});

test("G-04: input handler with empty text sets no suggestion", async () => {
  const pi = fakePi();
  mountIntake(pi);
  const handler = pi.handlers.get("input")?.[0];
  assert.ok(handler);
  await handler({ text: "", source: "interactive" }, fakeCtx(process.cwd()));
  assert.equal(getSuggestion(), null, "empty text must not set a suggestion");
});

// ---------------------------------------------------------------------------
// Skips
// ---------------------------------------------------------------------------

test("input handler skips slash commands and image-bearing input", async () => {
  const pi = fakePi();
  mountIntake(pi);

  await fireInput(pi, { text: "/harness-decision status", source: "interactive" });
  assert.equal(getSuggestion(), null);

  await fireInput(pi, { text: "please add a docker compose file", images: [{ type: "image" }] });
  assert.equal(getSuggestion(), null);
});

test("input handler classifies only the first submission in a task", async () => {
  process.env.OMP_HARNESS_JEV = "1";
  setJevInputAllowed(true);
  const pi = fakePi();
  mountIntake(pi);
  const event = { text: "please refactor the login module", source: "interactive" };

  await fireInput(pi, event);
  const afterFirst = JSON.stringify(getSuggestion());
  assert.notEqual(afterFirst, "null", "the first submission stores a shadow suggestion");

  await fireInput(pi, event);
  assert.equal(submissionCount(), 2);
  assert.equal(JSON.stringify(getSuggestion()), afterFirst, "the second submission must not replace it");
});

// ---------------------------------------------------------------------------
// harness-decision command
// ---------------------------------------------------------------------------

test("harness-decision status prints the endpoint host and no credential", async () => {
  const pi = fakePi();
  mountIntake(pi);
  const command = pi.commands.get("harness-decision");
  assert.ok(command, "harness-decision command must be registered");

  const ctx = fakeCtx(process.cwd());
  await command.handler("status", ctx);
  const messages = ctx.ui.notify.calls.map((call) => call.message);
  assert.equal(messages.length, 1);
  const text = messages[0];

  const expectedHost = new URL(jevEndpoint()).host;
  assert.ok(text.includes(expectedHost), `status shows the endpoint host ${expectedHost}`);
  assert.doesNotMatch(text, /secret|token|password|apikey|api[_-]?key/i);
  assert.doesNotMatch(text, /:\/\//, "status must not echo a full URL with a path");
});

test("harness-decision allow-input enables egress and off disables and clears it", async () => {
  const pi = fakePi();
  mountIntake(pi);
  const command = pi.commands.get("harness-decision");
  assert.ok(command, "harness-decision command must be registered");

  await command.handler("allow-input", fakeCtx(process.cwd()));
  assert.equal(isJevInputAllowed(), true);

  setSuggestion({ status: "answered", route: "direct", skills: ["x"], skill_basis: "jev" });
  await command.handler("off", fakeCtx(process.cwd()));
  assert.equal(isJevInputAllowed(), false);
  assert.equal(getSuggestion(), null);
});

// ---------------------------------------------------------------------------
// harness-decision probe (bootstrap)
// ---------------------------------------------------------------------------

const NS24 = "https://api.ns24.io";
const PROBE_OK = { model: "jev-latest", answers: { present: { noul: 1 } } };

interface ProbeSpy {
  client: { systemOne(request: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };
  calls: unknown[][];
}

function probeSpy(reply: unknown | (() => unknown)): ProbeSpy {
  const calls: unknown[][] = [];
  return {
    calls,
    client: {
      systemOne(...args: unknown[]): Promise<unknown> {
        calls.push(args);
        return Promise.resolve(typeof reply === "function" ? (reply as () => unknown)() : reply);
      },
    },
  };
}

async function runProbe(pi: FakePi): Promise<string> {
  const command = pi.commands.get("harness-decision");
  assert.ok(command, "harness-decision command must be registered");
  const ctx = fakeCtx(process.cwd());
  await command.handler("probe", ctx);
  return ctx.ui.notify.calls.map((call) => call.message).join("\n");
}

test("harness-decision probe without TYPESAFE_API_KEY prints the missing key, makes no request, writes no file", async () => {
  process.env.TYPESAFE_BASE_URL = NS24;
  const dir = tmpDir();
  const spy = probeSpy(PROBE_OK);
  const pi = fakePi();
  mountIntake(pi, { client: spy.client, probesDir: dir });

  const text = await runProbe(pi);
  assert.match(text, /TYPESAFE_API_KEY/);
  assert.equal(spy.calls.length, 0);
  assert.equal(readEndpointProbe(NS24, dir), null);
  assert.equal(existsSync(probeFileFor(NS24, dir)), false);
});

test("harness-decision probe writes the probe file and reports usable", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_BASE_URL = NS24;
  const dir = tmpDir();
  const spy = probeSpy(PROBE_OK);
  const pi = fakePi();
  mountIntake(pi, { client: spy.client, probesDir: dir, now: () => Date.parse("2026-01-01T00:00:00.000Z") });

  const text = await runProbe(pi);
  assert.match(text, /usable: yes/);
  assert.match(text, /observed-model: jev-latest/);
  const recorded = readEndpointProbe(NS24, dir);
  assert.equal(recorded?.ok, true);
  assert.equal(recorded?.model, "jev-latest");
});

test("harness-decision probe surfaces a gateway rejection and writes no file", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_BASE_URL = NS24;
  const dir = tmpDir();
  const spy = probeSpy(() => {
    throw new Error("404 model_not_found: jev-latest");
  });
  const pi = fakePi();
  mountIntake(pi, { client: spy.client, probesDir: dir });

  const text = await runProbe(pi);
  assert.match(text, /usable: no/);
  assert.match(text, /404 model_not_found: jev-latest/);
  assert.equal(existsSync(probeFileFor(NS24, dir)), false);
});

test("harness-decision status reports expected model and a passing probe", async () => {
  process.env.TYPESAFE_BASE_URL = NS24;
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    probeFileFor(NS24, dir),
    JSON.stringify({ endpoint: NS24, ok: true, model: "jev-latest", at: "2026-01-01T00:00:00.000Z" }),
    "utf8",
  );
  const pi = fakePi();
  mountIntake(pi, { probesDir: dir });

  const command = pi.commands.get("harness-decision");
  assert.ok(command, "harness-decision command must be registered");
  const ctx = fakeCtx(process.cwd());
  await command.handler("status", ctx);
  const text = ctx.ui.notify.calls.map((call) => call.message).join("\n");
  assert.match(text, /endpoint: api\.ns24\.io/);
  assert.match(text, /expected-model: jev-latest/);
  assert.match(text, /probe: passing 2026-01-01T00:00:00\.000Z/);
  assert.match(text, /jev: off/);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

test("session_shutdown clears the Jev egress permission", async () => {
  const pi = fakePi();
  mountIntake(pi);
  setJevInputAllowed(true);
  assert.equal(isJevInputAllowed(), true);

  const handler = pi.handlers.get("session_shutdown")?.[0];
  assert.ok(handler, "session_shutdown handler must be registered");
  await handler({}, fakeCtx(process.cwd()));

  assert.equal(isJevInputAllowed(), false);
});

test("a subagent session_shutdown does not clear the Jev egress permission", async () => {
  const pi = fakePi();
  mountIntake(pi);
  setJevInputAllowed(true);
  assert.equal(isJevInputAllowed(), true);

  const handler = pi.handlers.get("session_shutdown")?.[0];
  assert.ok(handler, "session_shutdown handler must be registered");
  await handler({}, { ...fakeCtx(process.cwd()), agent: { kind: "sub" } });

  assert.equal(isJevInputAllowed(), true);

  // A top-level shutdown still clears.
  setJevInputAllowed(true);
  await handler({}, fakeCtx(process.cwd()));
  assert.equal(isJevInputAllowed(), false);
});

// ---------------------------------------------------------------------------
// harness_record lesson artifact (lesson.md + lessons.jsonl, sanitized)
// ---------------------------------------------------------------------------

test("harness_record writes lesson.md and lessons.jsonl with sanitized secret material", async () => {
  const root = tmpDir();
  const dir = tmpDir();
  const pi = fakePi();
  tools(pi as never);
  const def = pi.tools.get("harness_record");
  assert.ok(def, "harness_record tool registered");
  const exe = def as { execute: (id: string, params: Record<string, unknown>, _s: unknown, _u: unknown, ctx: unknown) => Promise<unknown> };
  const lesson = {
    why_this_design: "Why this design is right: env wins over cwd, Bearer sk-secret123456 must never leak.",
    avoid_misconceptions: [
      {
        similar_case: "cwd fallback looks similar",
        why_wrong_there: "it silently writes into the repo and fails typed check 5",
        right_pattern_instead: "fail closed on empty home",
      },
    ],
    files: ["src/state.ts"],
  };
  await exe.execute("rec-1", { tier: "M", goal: "lesson landing", acceptance: [], models: [], tokens: 0, wall_ms: 0, lesson, dir }, undefined, undefined, { cwd: root });
  const lessonPath = join(dir, "lesson.md");
  assert.ok(existsSync(lessonPath), "lesson.md written");
  const lessonText = readFileSync(lessonPath, "utf8");
  assert.ok(!lessonText.includes("sk-secret123456"), "raw secret redacted from lesson.md");
  assert.match(lessonText, /Bearer \[redacted\]/);
  const lessonsFile = join(root, ".omp", "harness", "lessons.jsonl");
  assert.ok(existsSync(lessonsFile), "lessons.jsonl written");
  const line = readFileSync(lessonsFile, "utf8").trim().split(/\r?\n/);
  assert.ok(line.length >= 1);
  const entry = JSON.parse(line[line.length - 1] as string);
  assert.ok(String(entry.goal ?? "") === "lesson landing");
});
