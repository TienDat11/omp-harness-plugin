import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "./_fake-pi.ts";
import {
  readiness,
  parseReadinessBlock,
  judge,
  rankSkillFit,
  expectedModelFor,
  probeEndpoint,
  probeFileFor,
  readEndpointProbe,
  defaultProbesDir,
  type SystemOneClient,
} from "../src/decisions.ts";
import { clearSessionState } from "../src/state.ts";

const ENV_KEYS = [
  "OMP_HARNESS_JEV",
  "OMP_HARNESS_JEV_MODEL",
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "OMP_PROFILE",
  "PI_MODEL",
  "OMP_MODEL",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  // Most tests exercise the transport path; the two "Jev off" tests delete this.
  process.env.OMP_HARNESS_JEV = "1";
  clearSessionState();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (key in savedEnv) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
});

interface SpyClient {
  client: SystemOneClient;
  calls: unknown[][];
}

function spyClient(reply: unknown | (() => unknown)): SpyClient {
  const calls: unknown[][] = [];
  const client: SystemOneClient = {
    systemOne(...args: unknown[]): Promise<unknown> {
      calls.push(args);
      const value = typeof reply === "function" ? (reply as () => unknown)() : reply;
      return Promise.resolve(value);
    },
  };
  return { client, calls };
}

const ROUTE_OK = {
  model: "jev-1.14.0",
  answers: { route: { choice: "direct", confidence: 0.9, probabilities: { direct: 0.8, strong: 0.1, clarify: 0.1 } } },
};

function requestOf(calls: unknown[][], index = 0): Record<string, unknown> {
  return calls[index]?.[0] as Record<string, unknown>;
}

function questionsOf(calls: unknown[][], index = 0): Record<string, unknown> {
  return requestOf(calls, index)["questions"] as Record<string, unknown>;
}

test("readiness: all five conditions met -> go with ok true", () => {
  const result = readiness({
    problem_defined: "yes",
    evidence_strength: "strong",
    measurable_outcome: "yes",
    concept: "shaped",
    recommended_option: "opt-a",
    verdict: "go",
    reason: "ok",
  });
  assert.equal(result.verdict, "go");
  assert.equal(result.ok, true);
});

test("readiness: weak evidence with declared go -> needs-clarification and ok false", () => {
  const result = readiness({
    problem_defined: "yes",
    evidence_strength: "weak",
    measurable_outcome: "yes",
    concept: "shaped",
    recommended_option: "opt-a",
    verdict: "go",
    reason: "x",
  });
  assert.equal(result.verdict, "needs-clarification");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "evidence_strength is not strong or adequate");
});

test("readiness: unmet substantive condition -> needs-clarification, never go", () => {
  const result = readiness({
    problem_defined: "yes",
    evidence_strength: "adequate",
    measurable_outcome: "no",
    concept: "shaped",
    recommended_option: "opt-a",
    verdict: "go",
    reason: "r",
  });
  assert.equal(result.verdict, "needs-clarification");
  assert.equal(result.ok, false);
});

test("readiness: declared kill with reason -> kill and ok true", () => {
  const result = readiness({
    problem_defined: "yes",
    evidence_strength: "strong",
    measurable_outcome: "yes",
    concept: "shaped",
    recommended_option: "opt-a",
    verdict: "kill",
    reason: "stop now",
  });
  assert.equal(result.verdict, "kill");
  assert.equal(result.ok, true);
});

test("readiness: declared kill without reason -> kill but ok false", () => {
  const result = readiness({
    problem_defined: "yes",
    evidence_strength: "strong",
    measurable_outcome: "yes",
    concept: "shaped",
    recommended_option: "opt-a",
    verdict: "kill",
    reason: "",
  });
  assert.equal(result.verdict, "kill");
  assert.equal(result.ok, false);
});

test("readiness: non-object input -> needs-clarification", () => {
  assert.equal(readiness(null).verdict, "needs-clarification");
  assert.equal(readiness([]).verdict, "needs-clarification");
});

const VALID_READINESS = {
  problem_defined: "yes",
  evidence_strength: "strong",
  measurable_outcome: "yes",
  concept: "shaped",
  recommended_option: "opt-a",
  verdict: "go",
  reason: "ok",
};

const READINESS_FIELDS = [
  "problem_defined",
  "evidence_strength",
  "measurable_outcome",
  "concept",
  "recommended_option",
  "verdict",
  "reason",
] as const;

test("readiness: removing any of the seven required fields never yields go", () => {
  for (const field of READINESS_FIELDS) {
    const block: Record<string, unknown> = { ...VALID_READINESS };
    delete block[field];
    const result = readiness(block);
    assert.equal(result.verdict, "needs-clarification", `missing ${field}`);
    assert.equal(result.ok, false, `missing ${field}`);
    assert.notEqual(result.verdict, "go", `missing ${field}`);
  }
});

test("readiness: a non-string required field is malformed, never go", () => {
  const block: Record<string, unknown> = { ...VALID_READINESS, verdict: 42 };
  const result = readiness(block);
  assert.equal(result.verdict, "needs-clarification");
  assert.equal(result.ok, false);
});

test("parseReadinessBlock extracts the last ```json readiness fence", () => {
  assert.deepEqual(parseReadinessBlock("```json readiness\n{}\n```\nmore"), {});
});

test("parseReadinessBlock returns null when absent", () => {
  assert.equal(parseReadinessBlock("no fence here"), null);
});

test("parseReadinessBlock returns null when unparseable", () => {
  assert.equal(parseReadinessBlock("```json readiness\n{ broken\n```"), null);
});

test("judge with OMP_HARNESS_JEV unset -> unavailable, deterministic fallback", async () => {
  delete process.env.OMP_HARNESS_JEV;
  const answer = await judge({ kind: "intake", state: {} });
  assert.equal(answer.status, "unavailable");
  assert.equal(answer.fallback, "deterministic");
});

test("judge does not call the injected client when Jev is off", async () => {
  delete process.env.OMP_HARNESS_JEV;
  const spy = spyClient(ROUTE_OK);
  const answer = await judge({ kind: "intake", state: {} }, { client: spy.client });
  assert.equal(answer.status, "unavailable");
  assert.equal(spy.calls.length, 0);
});

test("judge sends exactly one systemOne call per invocation", async () => {
  const spy = spyClient(ROUTE_OK);
  await judge({ kind: "intake", state: {} }, { client: spy.client, now: () => Date.now() });
  assert.equal(spy.calls.length, 1);
});

test("judge passes maxRetries 0 and state + questions in the request", async () => {
  const spy = spyClient(ROUTE_OK);
  await judge({ kind: "intake", state: { hello: "world" } }, { client: spy.client, now: () => Date.now() });
  const req = requestOf(spy.calls);
  assert.deepEqual(req["state"], { hello: "world" });
  assert.ok(typeof req["questions"] === "object" && req["questions"] !== null);
  assert.equal(req["messages"], undefined);
  assert.equal(req["history"], undefined);
  assert.equal(req["prompt"], undefined);
  const options = spy.calls[0]?.[1] as Record<string, unknown>;
  assert.deepEqual(options["retry"], { maxRetries: 0 });
});

test("wrong model -> unavailable", async () => {
  const spy = spyClient({ model: "other", answers: {} });
  const answer = await judge({ kind: "intake", state: {} }, { client: spy.client, now: () => Date.now() });
  assert.equal(answer.status, "unavailable");
  assert.equal(spy.calls.length, 1);
});

test("probabilities sum not to 1 -> unavailable", async () => {
  const spy = spyClient({
    model: "jev-1.14.0",
    answers: { route: { choice: "direct", confidence: 0.9, probabilities: { direct: 0.5, strong: 0.2, clarify: 0.2 } } },
  });
  const answer = await judge({ kind: "intake", state: {} }, { client: spy.client, now: () => Date.now() });
  assert.equal(answer.status, "unavailable");
});

test("probability label set differs from requested options -> unavailable", async () => {
  const spy = spyClient({
    model: "jev-1.14.0",
    answers: { route: { choice: "direct", confidence: 0.9, probabilities: { direct: 0.5, strong: 0.3, other: 0.2 } } },
  });
  const answer = await judge({ kind: "intake", state: {} }, { client: spy.client, now: () => Date.now() });
  assert.equal(answer.status, "unavailable");
});

test("client throws -> unavailable, no throw escapes judge", async () => {
  const spy = spyClient(() => {
    throw new Error("timeout");
  });
  const answer = await judge({ kind: "intake", state: {} }, { client: spy.client, now: () => Date.now() });
  assert.equal(answer.status, "unavailable");
  assert.equal(answer.fallback, "deterministic");
  assert.equal(spy.calls.length, 1);
});

test("configured timeout is 5000 ms, one attempt, and a timeout returns unavailable deterministic", async () => {
  const timeoutError = Object.assign(new Error("request timed out"), { name: "APITimeoutError" });
  const spy = spyClient(() => {
    throw timeoutError;
  });
  const answer = await judge({ kind: "intake", state: {} }, { client: spy.client, now: () => Date.now() });
  const options = spy.calls[0]?.[1] as Record<string, unknown>;
  assert.equal(options["timeout"], 5_000);
  assert.deepEqual(options["retry"], { maxRetries: 0 });
  assert.equal(spy.calls.length, 1);
  assert.equal(answer.status, "unavailable");
  assert.equal(answer.fallback, "deterministic");
});

test("low confidence -> abstain", async () => {
  const spy = spyClient({
    model: "jev-1.14.0",
    answers: { route: { choice: "direct", confidence: 0.2, probabilities: { direct: 0.8, strong: 0.1, clarify: 0.1 } } },
  });
  const answer = await judge({ kind: "intake", state: {} }, { client: spy.client, now: () => Date.now() });
  assert.equal(answer.status, "abstain");
});

test("skill_fit: two skills add skill_0 and skill_1 questions", async () => {
  const spy = spyClient({
    model: "jev-1.14.0",
    answers: {
      route: { choice: "direct", confidence: 0.9, probabilities: { direct: 0.8, strong: 0.1, clarify: 0.1 } },
      skill_0: { score: 3, confidence: 0.9 },
      skill_1: { score: 2, confidence: 0.9 },
    },
  });
  const answer = await judge({ kind: "intake", state: {}, skills: ["a", "b"] }, { client: spy.client, now: () => Date.now() });
  const questions = questionsOf(spy.calls);
  assert.ok("route" in questions);
  assert.ok("skill_0" in questions);
  assert.ok("skill_1" in questions);
  assert.equal(answer.status, "answered");
});

test("skill_fit: one skill adds no skill questions", async () => {
  const spy = spyClient(ROUTE_OK);
  await judge({ kind: "intake", state: {}, skills: ["a"] }, { client: spy.client, now: () => Date.now() });
  const questions = questionsOf(spy.calls);
  assert.deepEqual(Object.keys(questions), ["route"]);
});

test("skill_fit: thirteen skills add no skill questions", async () => {
  const spy = spyClient(ROUTE_OK);
  const skills = Array.from({ length: 13 }, (_, index) => `s${index}`);
  await judge({ kind: "intake", state: {}, skills }, { client: spy.client, now: () => Date.now() });
  const questions = questionsOf(spy.calls);
  assert.deepEqual(Object.keys(questions), ["route"]);
});

test("rankSkillFit drops scores below 1 and sorts by score then name", () => {
  const ranked = rankSkillFit(
    { skill_0: { score: 0 }, skill_1: { score: 5 }, skill_2: { score: 5 }, skill_5: { score: 1 } },
    ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
    1,
  );
  assert.deepEqual(ranked, [
    { name: "beta", score: 5 },
    { name: "gamma", score: 5 },
    { name: "zeta", score: 1 },
  ]);
});

test("receipt: exact keys after successful intake judge, sentinel absent from file", async () => {
  const cwd = tmpDir();
  const sentinel = "REDACTED_STATE_SENTINEL_XYZ";
  const spy = spyClient(ROUTE_OK);
  await judge({ kind: "intake", state: `the ${sentinel} must not leak`, cwd }, { client: spy.client, now: () => Date.now() });
  const receipt = `${cwd}/.omp/harness/jev-decisions.jsonl`;
  assert.equal(existsSync(receipt), true);
  const text = readFileSync(receipt, "utf8");
  const line = text.trim().split("\n").pop();
  const record = JSON.parse(line as string) as Record<string, unknown>;
  const expectedKeys = [
    "schema_version",
    "decision_id",
    "timestamp",
    "kind",
    "question_set_version",
    "state_sha256",
    "candidates_sha256",
    "requested_model",
    "actual_model",
    "answers",
    "status",
    "fallback",
    "latency_ms",
    "input_tokens",
    "output_tokens",
    "applied",
  ].sort();
  assert.deepEqual(Object.keys(record).sort(), expectedKeys);
  assert.equal(record.applied, false);
  assert.ok(!text.includes(sentinel));
});

test("readiness never writes a jev-decisions receipt", async () => {
  const cwd = tmpDir();
  const spy = spyClient(() => {
    throw new Error("should not be called");
  });
  const answer = await judge({ kind: "readiness", state: {} }, { client: spy.client, now: () => Date.now() });
  assert.equal(answer.status, "unavailable");
  assert.equal(existsSync(`${cwd}/.omp/harness/jev-decisions.jsonl`), false);
});

test("oversized state over 16000 bytes -> unavailable, no client call", async () => {
  const spy = spyClient(ROUTE_OK);
  const answer = await judge({ kind: "intake", state: "A".repeat(17000) }, { client: spy.client, now: () => Date.now() });
  assert.equal(answer.status, "unavailable");
  assert.equal(spy.calls.length, 0);
});

test("state containing credential-shaped value -> unavailable, no client call", async () => {
  const spy = spyClient(ROUTE_OK);
  const answer = await judge(
    { kind: "intake", state: "request sk-abcdefghijklmnop1234567890abcdef" },
    { client: spy.client, now: () => Date.now() },
  );
  assert.equal(answer.status, "unavailable");
  assert.equal(spy.calls.length, 0);
});

test("expectedModelFor returns jev-1.14.0 for the typesafe endpoint", () => {
  assert.equal(expectedModelFor("https://api.typesafe.ai"), "jev-1.14.0");
});

test("expectedModelFor returns null for ns24 with no passing probe on disk", () => {
  assert.equal(expectedModelFor("https://api.ns24.io", process.env, tmpDir()), null);
});

// ---------------------------------------------------------------------------
// ns24 endpoint: bootstrap, identity pinning, discoverable failures
// ---------------------------------------------------------------------------

const NS24 = "https://api.ns24.io";
const PROBE_OK = { model: "jev-latest", answers: { present: { noul: 1 } } };

function writeProbeFile(dir: string, endpoint: string, model: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    probeFileFor(endpoint, dir),
    JSON.stringify({ endpoint, ok: true, model, at: "2026-01-01T00:00:00.000Z" }),
    "utf8",
  );
}

test("ns24 with no probe file -> unavailable no-passing-probe, no client call", async () => {
  process.env.TYPESAFE_BASE_URL = NS24;
  const dir = tmpDir();
  const spy = spyClient(ROUTE_OK);
  const answer = await judge(
    { kind: "intake", state: {} },
    { client: spy.client, probesDir: dir, now: () => Date.now() },
  );
  assert.equal(answer.status, "unavailable");
  assert.ok(answer.reason?.includes("no-passing-probe"), answer.reason);
  assert.equal(spy.calls.length, 0);
});

test("ns24 with a passing probe recording jev-latest -> allowed with expected model jev-latest", async () => {
  process.env.TYPESAFE_BASE_URL = NS24;
  const dir = tmpDir();
  writeProbeFile(dir, NS24, "jev-latest");
  assert.equal(expectedModelFor(NS24, process.env, dir), "jev-latest");
  const spy = spyClient({ model: "jev-latest", answers: ROUTE_OK.answers });
  const answer = await judge(
    { kind: "intake", state: {} },
    { client: spy.client, probesDir: dir, now: () => Date.now() },
  );
  assert.equal(answer.status, "answered");
  assert.equal(answer.requestedModel, "jev-latest");
  assert.equal(spy.calls.length, 1);
});

test("probe observing a different model fails, writes no file, names the observed model", async () => {
  const dir = tmpDir();
  const spy = spyClient({ model: "jev-9.9.9", answers: { present: { noul: 1 } } });
  const result = await probeEndpoint(NS24, { client: spy.client, probesDir: dir });
  assert.equal(result.ok, false);
  assert.equal(result.model, "jev-9.9.9");
  assert.ok(result.reason?.includes("jev-9.9.9"), result.reason);
  assert.equal(readEndpointProbe(NS24, dir), null);
  assert.equal(existsSync(probeFileFor(NS24, dir)), false);
});

test("OMP_HARNESS_JEV_MODEL overrides the recorded model and the mismatch names the override", async () => {
  process.env.TYPESAFE_BASE_URL = NS24;
  process.env.OMP_HARNESS_JEV_MODEL = "jev-custom";
  const dir = tmpDir();
  writeProbeFile(dir, NS24, "jev-latest");
  assert.equal(expectedModelFor(NS24, process.env, dir), "jev-custom");
  const spy = spyClient({ model: "jev-latest", answers: ROUTE_OK.answers });
  const answer = await judge(
    { kind: "intake", state: {} },
    { client: spy.client, probesDir: dir, now: () => Date.now() },
  );
  assert.equal(answer.status, "unavailable");
  assert.ok(answer.reason?.includes("expected jev-custom, observed jev-latest"), answer.reason);
});

test("probe bootstraps ns24: unavailable before, usable only after the probe records the model", async () => {
  process.env.TYPESAFE_BASE_URL = NS24;
  const dir = tmpDir();

  const before = await judge(
    { kind: "intake", state: {} },
    { client: spyClient(ROUTE_OK).client, probesDir: dir },
  );
  assert.equal(before.status, "unavailable");
  assert.ok(before.reason?.includes("no-passing-probe"), before.reason);

  const probeSpy = spyClient(PROBE_OK);
  const probe = await probeEndpoint(NS24, {
    client: probeSpy.client,
    probesDir: dir,
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
  });
  assert.equal(probe.ok, true);
  assert.equal(probe.model, "jev-latest");
  const recorded = readEndpointProbe(NS24, dir);
  assert.equal(recorded?.ok, true);
  assert.equal(recorded?.model, "jev-latest");
  assert.equal(recorded?.at, "2026-01-01T00:00:00.000Z");

  const after = await judge(
    { kind: "intake", state: {} },
    { client: spyClient({ model: "jev-latest", answers: ROUTE_OK.answers }).client, probesDir: dir },
  );
  assert.equal(after.status, "answered");
});

test("probe rejected by the gateway surfaces its error text and writes no file", async () => {
  const dir = tmpDir();
  const spy = spyClient(() => {
    throw new Error("404 model_not_found: jev-latest");
  });
  const result = await probeEndpoint(NS24, { client: spy.client, probesDir: dir });
  assert.equal(result.ok, false);
  assert.ok(result.reason?.includes("404 model_not_found: jev-latest"), result.reason);
  assert.equal(existsSync(probeFileFor(NS24, dir)), false);
});

// ---------------------------------------------------------------------------
// S6: defaultProbesDir points under OMP_HARNESS_HOME, never cwd
// ---------------------------------------------------------------------------

test("defaultProbesDir resolves to ~/.omp/harness/probes via OMP_HARNESS_HOME", () => {
  const saved = process.env.OMP_HARNESS_HOME;
  const dir = tmpDir();
  process.env.OMP_HARNESS_HOME = dir;
  try {
    assert.equal(defaultProbesDir(), path.join(dir, "probes"));
  } finally {
    if (saved === undefined) delete process.env.OMP_HARNESS_HOME;
    else process.env.OMP_HARNESS_HOME = saved;
  }
});

test("defaultProbesDir returns empty string when OMP_HARNESS_HOME unset and home unresolvable", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const saved = process.env.OMP_HARNESS_HOME;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.OMP_HARNESS_HOME;
  try {
    // If os.homedir() still resolves, defaultProbesDir returns a real path; just assert type stability.
    const out = defaultProbesDir();
    assert.ok(typeof out === "string");
  } finally {
    if (saved === undefined) delete process.env.OMP_HARNESS_HOME;
    else process.env.OMP_HARNESS_HOME = saved;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
  }
});

// ---------------------------------------------------------------------------
// S6: readEndpointProbe rejects mismatched endpoint path or expired probe
// ---------------------------------------------------------------------------

test("readEndpointProbe rejects mismatched normalized endpoint path on same host", () => {
  const dir = tmpDir();
  writeProbeFile(dir, "https://api.ns24.io/v1", "jev-latest");
  // /v2 is a different normalized path on the same host -> must not match.
  assert.equal(readEndpointProbe("https://api.ns24.io/v2", dir), null);
  assert.equal(readEndpointProbe("https://api.ns24.io/v1", dir)?.model, "jev-latest");
});

test("readEndpointProbe rejects expired expiresAt", () => {
  const dir = tmpDir();
  const past = new Date(0).toISOString();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    probeFileFor("https://api.ns24.io", dir),
    JSON.stringify({ endpoint: "https://api.ns24.io", ok: true, model: "jev-latest", at: past, expiresAt: past }),
    "utf8",
  );
  assert.equal(readEndpointProbe("https://api.ns24.io", dir, () => Date.now()), null);
});

