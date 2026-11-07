import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AUTOLOAD_THETA,
  AUTOLOAD_MARGIN,
  MAX_L1_DIGEST_CHARS,
  HOLDOUT_RATE,
  MIN_SHADOW_SAMPLES,
  MAX_SUGGESTED_SKILLS,
  classifyTaskCategory,
  isHoldoutTurn,
  scoreSkillDocs,
  parseSkillDoc,
  digestSkillDoc,
  pinnedDigest,
  decideValve,
} from "../src/skill-specs.ts";
import {
  SkillTelemetryStore,
  computeReward,
  isHardRevert,
} from "../src/skill-telemetry.ts";

test("classifyTaskCategory one prompt per category + general", () => {
  const cases: Array<[string, string]> = [
    ["build a react component with tailwind css", "frontend-ui"],
    ["create a rest api endpoint with express middleware", "backend-api"],
    ["write a sql migration for postgres schema", "database-data"],
    ["deploy with docker and terraform pipeline", "devops-iac"],
    ["add unit tests with vitest coverage", "testing-qa"],
    ["fix xss vulnerability and rotate secrets", "security"],
    ["debug a crash and stack trace timeout", "debugging"],
    ["write an adr for module boundary refactor", "architecture-docs"],
    ["hello world", "general"],
  ];
  for (const [prompt, expected] of cases) {
    assert.equal(classifyTaskCategory(prompt), expected, prompt);
  }
});

test("isHoldoutTurn deterministic and rate in range", () => {
  assert.equal(typeof isHoldoutTurn("s", 1), "boolean");
  assert.equal(isHoldoutTurn("s", 1), isHoldoutTurn("s", 1));
  let count = 0;
  for (let i = 0; i < 10000; i++) {
    if (isHoldoutTurn(`session-${i}`, i)) count++;
  }
  const rate = count / 10000;
  assert.ok(rate >= 0.12 && rate <= 0.18, `rate ${rate}`);
});

test("scoreSkillDocs keyword order, bonuses, notFor, ties", () => {
  const docs = [
    { name: "a", description: "sql rls", keywords: ["sql", "rls"], notFor: [] },
    { name: "b", description: "sql", keywords: ["sql"], notFor: ["postgres"] },
    { name: "c", description: "css", keywords: ["css"], notFor: [] },
  ];
  const r = scoreSkillDocs(docs, "sql rls", { stackSkills: ["c"], suggestionSkills: [] });
  assert.equal(r[0].name, "a");
  const docs2 = [
    { name: "x", description: "sql", keywords: ["sql"], notFor: ["sql"] },
    { name: "y", description: "rls", keywords: ["rls"], notFor: [] },
  ];
  const r2 = scoreSkillDocs(docs2, "sql rls");
  assert.ok(!r2.some((c) => c.name === "x"));
  const docs3 = [
    { name: "z", description: "css", keywords: ["css"], notFor: [] },
    { name: "a", description: "css", keywords: ["css"], notFor: [] },
  ];
  const r3 = scoreSkillDocs(docs3, "css");
  assert.equal(r3[0].name, "a");
  assert.equal(r3[1].name, "z");
  const docs4 = [
    { name: "low", description: "sql", keywords: ["sql"], notFor: [] },
    { name: "high", description: "css", keywords: ["css"], notFor: [] },
  ];
  const r4 = scoreSkillDocs(docs4, "sql css", { stackSkills: ["high"] });
  assert.equal(r4[0].name, "high");
});

test("decideValve branches", () => {
  const cand = (name: string, score: number, margin: number): { name: string; score: number; margin: number; reason: string } => ({ name, score, margin, reason: "" });
  let d = decideValve([], { allowlist: {}, actualSha256: {}, holdout: false, alreadyInjected: [] });
  assert.equal(d.reason, "no-candidate");
  d = decideValve([cand("s", 0.9, 0.5)], { allowlist: {}, actualSha256: {}, holdout: false, alreadyInjected: ["s"] });
  assert.equal(d.reason, "already-injected");
  d = decideValve([cand("s", 0.5, 0.5)], { allowlist: {}, actualSha256: {}, holdout: false, alreadyInjected: [] });
  assert.equal(d.reason, "below-theta");
  d = decideValve([cand("s", 0.8, 0.05)], { allowlist: {}, actualSha256: {}, holdout: false, alreadyInjected: [] });
  assert.equal(d.reason, "thin-margin");
  d = decideValve([cand("s", 0.9, 0.5)], { allowlist: {}, actualSha256: { s: "sha" }, holdout: false, alreadyInjected: [] });
  assert.equal(d.reason, "not-allowlisted");
  d = decideValve([cand("s", 0.9, 0.5)], { allowlist: { s: { l1Digest: "digest" } }, actualSha256: { s: "actual" }, pinnedSha256: { s: "pinned" }, holdout: false, alreadyInjected: [] });
  assert.equal(d.reason, "sha-mismatch");
  d = decideValve([cand("s", 0.9, 0.5)], { allowlist: { s: { l1Digest: "" } }, actualSha256: { s: "sha" }, pinnedSha256: { s: "sha" }, holdout: false, alreadyInjected: [] });
  assert.equal(d.reason, "no-l1-digest");
  d = decideValve([cand("s", 0.9, 0.5)], { allowlist: { s: { l1Digest: "d".repeat(10) } }, actualSha256: { s: "sha" }, pinnedSha256: { s: "sha" }, holdout: true, alreadyInjected: [] });
  assert.equal(d.reason, "holdout");
  assert.equal(d.mode, "holdout_control");
  d = decideValve([cand("s", 0.9, 0.5)], { allowlist: { s: { l1Digest: "d".repeat(10) } }, actualSha256: { s: "sha" }, pinnedSha256: { s: "sha" }, holdout: false, alreadyInjected: [] });
  assert.equal(d.reason, "autoload");
  assert.equal(d.valveOpen, true);
  assert.equal(d.mode, "l1_autoload");
  // Step 2e: high confidence no longer bypasses the margin guard; saturated ties never open.
  d = decideValve([cand("s", 0.95, 0.02)], { allowlist: { s: { l1Digest: "d".repeat(10) } }, actualSha256: { s: "sha" }, pinnedSha256: { s: "sha" }, holdout: false, alreadyInjected: [] });
  assert.equal(d.reason, "thin-margin");
  assert.equal(d.valveOpen, false);
});

test("digestSkillDoc length and empty bullets and name", () => {
  const doc = { name: "foo-skill", description: "use when x", keywords: [], notFor: [] };
  const body = "intro\n- must do A\n- avoid B\n1. never C\nsome line with always D";
  const d = digestSkillDoc(doc, body);
  assert.ok(d.length <= MAX_L1_DIGEST_CHARS);
  assert.ok(d.includes("foo-skill"));
  // A short body with no list markup is already a digest in full: autoloading
  // it costs the same as autoloading a summary of it.
  const short = digestSkillDoc(doc, "no bullets here just prose");
  assert.equal(short, "no bullets here just prose");
  // A body too long to autoload whole and too unstructured to summarise stays closed.
  const long = digestSkillDoc(doc, `${"prose without any list markup. ".repeat(200)}`);
  assert.equal(long, "");
});

test("pinnedDigest basic", () => {
  assert.equal(pinnedDigest({ l1Digest: "abc" }, "sha", "sha"), "abc");
  assert.equal(pinnedDigest({ l1Digest: "abc" }, "sha", undefined), null);
  assert.equal(pinnedDigest({ l1Digest: "abc" }, "sha", "other"), null);
  assert.equal(pinnedDigest({ l1Digest: "" }, "sha", "sha"), null);
});

test("SkillTelemetryStore record/query/manual", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-tel-"));
  const dbPath = join(dir, "t.db");
  const store = new SkillTelemetryStore(dbPath);
  store.recordRun({
    runId: "r1", sessionId: "s", turnIndex: 1, skillName: "sk", skillSha256: "sh",
    taskCategory: "frontend-ui", modelId: "m", loadMode: "auto_injected", holdout: false,
    routerScore: 0.9, mutations: 1, toolCalls: 2, toolErrors: 0, verifyRan: true, verifyPassed: true,
    hardReverted: false, acceptancePassRate: 1, manualRating: null, reward: 0.9, recordedAt: "2026-01-01T00:00:00Z",
  });
  store.recordRun({
    runId: "r2", sessionId: "s", turnIndex: 2, skillName: "sk", skillSha256: "sh",
    taskCategory: "frontend-ui", modelId: "m", loadMode: "holdout_control", holdout: true,
    routerScore: 0.9, mutations: 1, toolCalls: 2, toolErrors: 0, verifyRan: true, verifyPassed: false,
    hardReverted: false, acceptancePassRate: 0.5, manualRating: null, reward: 0.4, recordedAt: "2026-01-02T00:00:00Z",
  });
  const q = store.queryLift("sk", "sh", "frontend-ui", "m");
  assert.equal(q.totalRuns, 2);
  assert.equal(q.shadowMode, true);
  assert.ok(Number.isFinite(q.lift));
  const store2 = new SkillTelemetryStore(join(dir, "t2.db"));
  store2.recordRun({
    runId: "r3", sessionId: "s", turnIndex: 3, skillName: "sk", skillSha256: "sh",
    taskCategory: "*", modelId: "*", loadMode: "pointer_only", holdout: false,
    routerScore: 0, mutations: 0, toolCalls: 0, toolErrors: 0, verifyRan: false, verifyPassed: false,
    hardReverted: false, acceptancePassRate: null, manualRating: null, reward: 0.5, recordedAt: "2026-01-03T00:00:00Z",
  });
  const q2 = store2.queryLift("sk", "sh", "frontend-ui", "m");
  assert.equal(q2.totalRuns, 1);
  store2.close();
  store.recordManualRating("sk", "sh", 0.8);
  const stats = store.listStats();
  assert.ok(stats.some((s) => Number(s.manual_overrides) >= 1));
  store.close();
});

test("computeReward boundaries", () => {
  const manual = computeReward({ mutations: 0, verifyRan: false, verifyPassed: false, hardReverted: false, toolErrors: 0, toolCalls: 0, acceptancePassRate: null, manualRating: 0.25 });
  assert.equal(manual, 0.25);
  const reverted = computeReward({ mutations: 1, verifyRan: true, verifyPassed: false, hardReverted: true, toolErrors: 4, toolCalls: 4, acceptancePassRate: null, manualRating: null });
  assert.ok(reverted <= 0.1, `reverted ${reverted}`);
  const pass = computeReward({ mutations: 1, verifyRan: true, verifyPassed: true, hardReverted: false, toolErrors: 0, toolCalls: 1, acceptancePassRate: null, manualRating: null });
  const fail = computeReward({ mutations: 1, verifyRan: true, verifyPassed: false, hardReverted: false, toolErrors: 0, toolCalls: 1, acceptancePassRate: null, manualRating: null });
  assert.ok(pass > fail);
});

test("isHardRevert cases", () => {
  assert.equal(isHardRevert("git restore --staged x"), false);
  assert.equal(isHardRevert("git restore x"), true);
  assert.equal(isHardRevert("git revert HEAD"), true);
  assert.equal(isHardRevert("git checkout -- file"), true);
  assert.equal(isHardRevert("git reset --hard"), true);
  assert.equal(isHardRevert("git stash drop"), true);
  assert.equal(isHardRevert("git status"), false);
});

test("constants exported", () => {
  assert.equal(AUTOLOAD_THETA, 0.7);
  assert.equal(MAX_L1_DIGEST_CHARS, 4000);
  assert.equal(HOLDOUT_RATE, 0.15);
  assert.equal(MIN_SHADOW_SAMPLES, 20);
  assert.equal(MAX_SUGGESTED_SKILLS, 3);
});
