/**
 * scout.test.ts — the read-only scout agent stays registered, read-only, and probe-gradable.
 *
 * Probe copy lives in tests/fixtures/scout-probe/ for review; the runner reads probes/ (gitignored).
 * To use it: copy scout-explore.probe.jsonl lines into probes/probes.jsonl and
 * tests/fixtures/scout-probe/scout-explore into probes/fixtures/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMutatingTaskCall } from "../src/verify-gate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "harness.manifest.json"), "utf8"));
const scoutSource = readFileSync(path.join(ROOT, "agents", "scout.md"), "utf8");

function frontmatter(source: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  assert.ok(match, "scout.md has a frontmatter block");
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

test("the manifest registers agents/scout.md", () => {
  assert.ok("agents/scout.md" in manifest.files);
});

test("scout is read-only: @smol model, read/grep/glob/lsp only, no bash or write", () => {
  const fm = frontmatter(scoutSource);
  assert.equal(fm.name, "scout");
  assert.ok(fm.description.length > 0);
  assert.equal(fm.model, '"@smol"');
  assert.equal(fm.tools, "[read, grep, glob, lsp]");
  assert.equal(/\b(bash|write|edit)\b/.test(fm.tools), false);
  assert.equal(fm.autoloadSkills, "[karpathy-guidelines]");
});

test("dispatching scout is not a mutating task call", () => {
  assert.equal(isMutatingTaskCall({ agent: "scout" }), false);
});

test("the scout-explore probe passes only for the correct file:line", () => {
  const probe = JSON.parse(readFileSync(path.join(ROOT, "tests", "fixtures", "scout-probe", "scout-explore.probe.jsonl"), "utf8").trim());
  assert.equal(probe.split, "in");
  const dir = mkdtempSync(path.join(os.tmpdir(), "scout-probe-"));
  try {
    cpSync(path.join(ROOT, "tests", "fixtures", "scout-probe", probe.fixture), dir, { recursive: true });
    const run = () => spawnSync(probe.check.command, { cwd: dir, shell: true }).status;
    writeFileSync(path.join(dir, "answer.txt"), "src/cache.mjs:4\n");
    assert.notEqual(run(), 0);
    writeFileSync(path.join(dir, "answer.txt"), "src/retry.mjs:9\n");
    assert.equal(run(), 0);
    assert.match(readFileSync(path.join(dir, "src", "retry.mjs"), "utf8").split("\n")[8], /function retryBudget/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
