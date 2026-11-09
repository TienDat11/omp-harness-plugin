import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpDir } from "./_fake-pi.ts";

const SCRIPT = path.resolve("scripts/mine-sessions.mjs");
const MARKER = "UNIQ-PRIVACY-MARKER-7f3a";

function session(startIso: string, blocks: number): string {
  const lines: object[] = [{ type: "session", id: "s", timestamp: startIso }];
  let n = 0;
  let last = "s";
  const push = (body: object) => {
    n += 1;
    const id = `e${n}`;
    lines.push({ ...body, id, parentId: last, timestamp: new Date(Date.parse(startIso) + n * 1000).toISOString() });
    last = id;
  };
  for (let i = 0; i < blocks; i++) {
    push({ type: "custom_message", customType: "session-stop-continuation", content: MARKER, display: false });
    push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: MARKER }, { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "npm test" } }],
        provider: "pp",
        model: "mm",
        usage: { input: 100, cacheRead: 300 },
      },
    });
    push({ type: "message", message: { role: "toolResult", toolCallId: `c${i}`, isError: false, content: [{ type: "text", text: MARKER }] } });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function setup(): string {
  const root = tmpDir("mine");
  mkdirSync(path.join(root, "projA"), { recursive: true });
  mkdirSync(path.join(root, "projB"), { recursive: true });
  writeFileSync(path.join(root, "projA", "old.jsonl"), session("2026-01-01T00:00:00Z", 3));
  writeFileSync(path.join(root, "projB", "new.jsonl"), session("2026-06-01T00:00:00Z", 2));
  return root;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

test("counts, insufficient rates, and privacy", () => {
  const root = setup();
  const r = run(["--sessions", root, "--log", path.join(root, "none.log"), "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.sessions, 2);
  assert.equal(out.stopBlocks.total, 5);
  assert.equal(out.stopBlocks.counts.verified_pass, 5);
  assert.equal(out.stopBlocks.falseBlockRate, "insufficient");
  assert.equal(out.cacheReuse.byProvider.pp.n, 2);
  assert.equal(out.cacheReuse.byProvider.pp.p50, 0.75);
  assert.ok(!r.stdout.includes(MARKER));
  assert.ok(!r.stdout.includes(root));
  const human = run(["--sessions", root, "--log", path.join(root, "none.log")]);
  assert.equal(human.status, 0);
  assert.ok(!human.stdout.includes(MARKER));
});

test("--since and --project filter; rates numeric at >= 20 blocks", () => {
  const root = setup();
  const log = path.join(root, "x");
  const since = JSON.parse(run(["--sessions", root, "--log", log, "--since", "2026-03-01T00:00:00Z", "--json"]).stdout);
  assert.equal(since.sessions, 1);
  assert.equal(since.stopBlocks.total, 2);
  const proj = JSON.parse(run(["--sessions", root, "--log", log, "--project", "projA", "--json"]).stdout);
  assert.equal(proj.stopBlocks.total, 3);
  writeFileSync(path.join(root, "projA", "big.jsonl"), session("2026-02-01T00:00:00Z", 20));
  const big = JSON.parse(run(["--sessions", root, "--log", log, "--json"]).stdout);
  assert.equal(big.stopBlocks.falseBlockRate, 1);
});

test("harness.log counts and bad input exit 2", () => {
  const root = setup();
  const log = path.join(root, "harness.log");
  writeFileSync(log, "G1 p=x rc=blocked\nG1 p=x rc=blocked\nW1 p=x st=1\nW2 p=x k=slow\n");
  const out = JSON.parse(run(["--sessions", root, "--log", log, "--json"]).stdout);
  assert.deepEqual(out.harnessLog, { G1: { blocked: 2 }, W1: { "1": 1 }, W2: { slow: 1 } });
  assert.equal(run(["--sessions", path.join(root, "missing")]).status, 2);
});
