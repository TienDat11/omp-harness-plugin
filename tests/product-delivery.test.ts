/**
 * product-delivery.test.ts — BA/PM acceptance rules, no network.
 *
 * Every filesystem write lands in a fresh mkdtemp directory that is removed
 * after each test; nothing touches the repository.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readiness } from "../src/decisions.ts";
import tools from "../src/tools.ts";
import { fakePi, tmpDir, type FakePi } from "./_fake-pi.ts";

type ToolResult = { details: Record<string, unknown> };

const temps: string[] = [];

function mkTmp(): string {
  const dir = tmpDir();
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

function mountTools(): FakePi {
  const pi = fakePi();
  tools(pi as unknown as Parameters<typeof tools>[0]);
  return pi;
}

async function runTool(pi: FakePi, name: string, params: Record<string, unknown>): Promise<ToolResult> {
  const def = pi.tools.get(name);
  assert.ok(def, `tool ${name} must be registered`);
  return (await def.execute("call-1", params)) as ToolResult;
}

const GO_BLOCK = {
  problem_defined: "yes",
  evidence_strength: "strong",
  measurable_outcome: "yes",
  concept: "shaped",
  recommended_option: "opt-a",
  verdict: "go",
  reason: "evidence is adequate",
};

// ---------------------------------------------------------------------------
// readiness()
// ---------------------------------------------------------------------------

test("a go verdict with weak evidence is downgraded to needs-clarification", () => {
  const result = readiness({ ...GO_BLOCK, evidence_strength: "weak" });
  assert.equal(result.verdict, "needs-clarification");
  assert.equal(result.ok, false);
});

test("an adequate block with a matching declared verdict is go and ok", () => {
  const result = readiness({ ...GO_BLOCK });
  assert.equal(result.verdict, "go");
  assert.equal(result.ok, true);
});

test("a non-object readiness block yields needs-clarification", () => {
  for (const raw of [null, [], "go", 42]) {
    const result = readiness(raw);
    assert.equal(result.verdict, "needs-clarification");
    assert.equal(result.ok, false);
  }
});

test("each missing go-gating field forces needs-clarification", () => {
  const gating = [
    "problem_defined",
    "evidence_strength",
    "measurable_outcome",
    "concept",
    "recommended_option",
  ];
  for (const field of gating) {
    const block: Record<string, unknown> = { ...GO_BLOCK };
    delete block[field];
    const result = readiness(block);
    assert.equal(result.verdict, "needs-clarification", `missing ${field}`);
    assert.equal(result.ok, false, `missing ${field}`);
  }
});

test("a declared kill is honoured with a reason and flagged without one", () => {
  const withReason = readiness({ ...GO_BLOCK, verdict: "kill", reason: "out of scope" });
  assert.equal(withReason.verdict, "kill");
  assert.equal(withReason.ok, true);

  const withoutReason = readiness({ ...GO_BLOCK, verdict: "kill", reason: "" });
  assert.equal(withoutReason.verdict, "kill");
  assert.equal(withoutReason.ok, false);
});

// ---------------------------------------------------------------------------
// harness_decide (readiness is local: no receipt, no network)
// ---------------------------------------------------------------------------

test("readiness via harness_decide writes no Jev receipt", async () => {
  const pi = mountTools();
  const root = mkTmp();
  const result = await runTool(pi, "harness_decide", {
    kind: "readiness",
    state: JSON.stringify(GO_BLOCK),
    cwd: root,
  });
  assert.equal(result.details.verdict, "go");
  assert.equal(existsSync(path.join(root, ".omp", "harness", "jev-decisions.jsonl")), false);
});

test("readiness parsed from 01-assessment.md downgrades weak evidence", async () => {
  const pi = mountTools();
  const root = mkTmp();
  const assessment = path.join(root, "01-assessment.md");
  const block = { ...GO_BLOCK, evidence_strength: "weak" };
  const body = ["# Assessment", "", "```json readiness", JSON.stringify(block, null, 2), "```", ""].join("\n");
  writeFileSync(assessment, body, "utf8");

  const result = await runTool(pi, "harness_decide", { kind: "readiness", path: assessment, cwd: root });
  assert.equal(result.details.verdict, "needs-clarification");
  assert.equal(result.details.ok, false);
});

// ---------------------------------------------------------------------------
// intake_open (terminal product artifact set)
// ---------------------------------------------------------------------------

function productParams(root: string): Record<string, unknown> {
  return {
    tier: "M",
    kind: "product",
    source: { kind: "issue", locator: "#42" },
    acceptance: [{ id: "A1", check: "true" }],
    cwd: root,
    date: "2026-01-02",
    title: "Assess Thing",
    requirement: "Assess the thing and record the decision.",
  };
}

test("intake_open writes only the terminal product requirement artifact", async () => {
  const pi = mountTools();
  const root = mkTmp();
  const result = await runTool(pi, "intake_open", productParams(root));

  const expected = path.join(root, ".omp", "work", "2026-01-02", "assess-thing");
  assert.equal(path.resolve(String(result.details.dir)), path.resolve(expected));

  assert.deepEqual(readdirSync(expected).sort(), ["00-requirement.md"]);
  for (const absent of ["01-plan.md", "01-assessment.md", "02-verification.md"]) {
    assert.equal(existsSync(path.join(expected, absent)), false, absent);
  }

  const body = readFileSync(path.join(expected, "00-requirement.md"), "utf8");
  for (const needle of ["## Source", "Locator: #42", "## Acceptance", "- A1: true"]) {
    assert.ok(body.includes(needle), `requirement file must contain ${needle}`);
  }
});

test("intake_open with tier S skips and creates nothing", async () => {
  const pi = mountTools();
  const root = mkTmp();
  const result = await runTool(pi, "intake_open", { ...productParams(root), tier: "S" });

  assert.equal(result.details.skipped, true);
  assert.equal(existsSync(path.join(root, ".omp")), false);
});

test("a second intake_open for the same day and title claims a -2 folder", async () => {
  const pi = mountTools();
  const root = mkTmp();
  const first = await runTool(pi, "intake_open", productParams(root));
  const second = await runTool(pi, "intake_open", productParams(root));

  assert.equal(path.basename(String(first.details.dir)), "assess-thing");
  assert.equal(path.basename(String(second.details.dir)), "assess-thing-2");
  assert.notEqual(first.details.dir, second.details.dir);
  assert.deepEqual(readdirSync(String(second.details.dir)), ["00-requirement.md"]);
});
