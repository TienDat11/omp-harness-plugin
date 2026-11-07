import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "./_fake-pi.ts";
import {
  collectLiveReads,
  evaluateRead,
  extractFileSymbols,
  MAX_RAW_BYTES,
  MAX_READ_LINES,
  narrowSelector,
  PARENT_LEDGER_TAG,
  parseSelector,
  resolveTaskInput,
  selectorKey,
} from "../src/read-budget.ts";
import { clearSessionState, rememberReadStat } from "../src/state.ts";

beforeEach(() => {
  clearSessionState();
});

/** Canonical key of a selector as written by a model (`":1-400"` without the colon). */
function key(sel: string | undefined): string {
  return selectorKey(parseSelector(sel));
}

function narrow(sel: string, sizeBytes = 0): string | undefined {
  return narrowSelector(parseSelector(sel), sizeBytes);
}

interface ReadFixture {
  cwd: string;
  file: string;
  callId: string;
  branch: unknown[];
}

/**
 * A session branch holding exactly one completed `read` of `relPath` with
 * `sel`, whose result carried `tag`, recorded at the file's current stat.
 */
function oneLiveRead(relPath: string, sel: string | undefined, tag = "[file.ts#AB12]", body = "line 1"): ReadFixture {
  const cwd = tmpDir();
  const file = path.join(cwd, relPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  const stat = statSync(file);
  const callId = "call-1";
  rememberReadStat(callId, stat.mtimeMs, stat.size);
  const branch = [
    {
      type: "message",
      id: "e1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: sel === undefined ? relPath : `${relPath}:${sel}` } }],
      },
    },
    {
      type: "message",
      id: "e2",
      message: { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: `${tag}\n1:line 1` }] },
    },
  ];
  return { cwd, file, callId, branch };
}

test("selectorKey distinguishes bare, raw, ranged and tail reads", () => {
  assert.equal(key(undefined), "");
  assert.equal(key("raw"), "raw");
  assert.equal(key("1-180"), "lines:1-180");
  assert.equal(key("1-180:raw"), "lines:1-180:raw");
  assert.equal(key("1-180"), key("1-180"));
  assert.equal(key("1-180") === key("1-181"), false);
  assert.equal(key("-60"), "tail:60");
});

test("narrowSelector leaves a read at or under the cap alone", () => {
  assert.equal(narrow(undefined), undefined);
  assert.equal(narrow("1-180"), undefined);
  assert.equal(narrow("40-90"), undefined);
  assert.equal(narrow("raw", 1024), undefined);
  assert.equal(narrow("conflicts"), undefined);
  assert.equal(narrow("img"), undefined);
});

test("narrowSelector cuts an oversized range to the first MAX_READ_LINES lines", () => {
  assert.equal(narrow("1-400"), `1-${MAX_READ_LINES}`);
  assert.equal(narrow("1-181"), `1-${MAX_READ_LINES}`);
  assert.equal(narrow("1-20,40-200"), "1-20,40-199");
  assert.equal(narrow("1-400:raw"), `1-${MAX_READ_LINES}:raw`);
  assert.equal(narrow("-400"), `-${MAX_READ_LINES}`);
  assert.equal(narrow("50+400"), `50-${50 + MAX_READ_LINES - 1}`);
});

test("narrowSelector leaves open-ended ranges to read.defaultLimit", () => {
  assert.equal(narrow("50"), undefined);
  assert.equal(narrow("50-"), undefined);
});

test("narrowSelector bounds a whole-file raw read by byte size", () => {
  assert.equal(narrow("raw", MAX_RAW_BYTES + 1), `1-${MAX_READ_LINES}:raw`);
  assert.equal(narrow("raw", MAX_RAW_BYTES), undefined);
});

test("a second identical read is blocked and names the anchor already in context", () => {
  const fixture = oneLiveRead("file.ts", undefined);
  const verdict = evaluateRead("file.ts", fixture.cwd, fixture.branch);
  assert.equal(verdict?.block !== undefined, true);
  assert.match(String(verdict?.block), /already in context as \[file\.ts#AB12\]/);
  assert.equal(verdict?.rewrite, undefined);
});

test("the same file at a different range is allowed", () => {
  const fixture = oneLiveRead("file.ts", "1-180");
  assert.equal(evaluateRead("file.ts:181-360", fixture.cwd, fixture.branch), undefined);
});

test("a range already held is blocked even when the request is narrower", () => {
  const fixture = oneLiveRead("file.ts", "1-180");
  const verdict = evaluateRead("file.ts:50-100", fixture.cwd, fixture.branch);
  assert.equal(verdict?.block !== undefined, true);
});

test("a range outside the held window is allowed after the guard narrowed the first read", () => {
  // The model asked for 1-400; the guard delivered 1-180. 181-360 is not in context.
  const fixture = oneLiveRead("file.ts", "1-400");
  assert.equal(evaluateRead("file.ts:181-360", fixture.cwd, fixture.branch), undefined);
});

test("a re-read is allowed once the file changed on disk", () => {
  const fixture = oneLiveRead("file.ts", undefined, "[file.ts#AB12]", "line 1");
  writeFileSync(fixture.file, "line 1\nline 2\n");
  assert.equal(evaluateRead("file.ts", fixture.cwd, fixture.branch), undefined);
});

test("a re-read is allowed once the earlier result was pruned", () => {
  const fixture = oneLiveRead("file.ts", undefined);
  (fixture.branch[1] as { message: { prunedAt?: string } }).message.prunedAt = "2026-10-30T00:00:00.000Z";
  assert.equal(evaluateRead("file.ts", fixture.cwd, fixture.branch), undefined);
});

test("a re-read is allowed once a compaction boundary moved past the earlier result", () => {
  const fixture = oneLiveRead("file.ts", undefined);
  fixture.branch.push({ type: "compaction", id: "c1", firstKeptEntryId: "c1", summary: "" });
  assert.equal(evaluateRead("file.ts", fixture.cwd, fixture.branch), undefined);
});

test("a read invalidated by a later write to the same file is allowed", () => {
  const fixture = oneLiveRead("file.ts", undefined);
  fixture.branch.push({
    type: "message",
    id: "e3",
    message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "edit", arguments: { path: "file.ts" } }] },
  });
  assert.equal(evaluateRead("file.ts", fixture.cwd, fixture.branch), undefined);
});

test("internal URI reads are never guarded", () => {
  const cwd = tmpDir();
  assert.equal(evaluateRead("skill://omp-harness/SKILL.md", cwd, []), undefined);
  assert.equal(evaluateRead("agent://abc", cwd, []), undefined);
});

test("an oversized range is rewritten instead of refused", () => {
  const fixture = oneLiveRead("file.ts", undefined);
  const verdict = evaluateRead("file.ts:1-400", fixture.cwd, []);
  assert.equal(verdict?.block, undefined);
  assert.equal(verdict?.rewrite, `file.ts:1-${MAX_READ_LINES}`);
  assert.equal(fixture.branch.length, 2);
});

test("a missing file is left to the read tool to report", () => {
  const cwd = tmpDir();
  assert.equal(evaluateRead("nope.ts:1-400", cwd, []), undefined);
});

test("collectLiveReads returns stat-verified live reads with tags and windows and skips invalidated files", () => {
  const fixture = oneLiveRead("file.ts", "1-20", "[file.ts#A1B2]\n1:const a = 1;\n");
  assert.deepEqual(collectLiveReads(fixture.branch, fixture.cwd), [
    { path: "file.ts", tag: "[file.ts#A1B2]", windows: ["lines 1-20"] },
  ]);
  fixture.branch.push({
    type: "message",
    id: "e3",
    message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "edit", arguments: { path: "file.ts" } }] },
  });
  assert.deepEqual(collectLiveReads(fixture.branch, fixture.cwd), []);
});

test("resolveTaskInput injects parent-read-ledger into batch task.context and is idempotent", () => {
  const fixture = oneLiveRead("file.ts", undefined, "[file.ts#A1B2]\n1:const a = 1;\n");
  const first = resolveTaskInput(
    { context: "# Goal\nTest", tasks: [{ task: "Do X", solutionSpace: "narrow" }] },
    fixture.branch,
    fixture.cwd,
  );
  assert.ok(first);
  assert.equal(typeof first.context, "string");
  assert.ok(String(first.context).includes(PARENT_LEDGER_TAG));
  assert.ok(String(first.context).includes("- file.ts [file.ts#A1B2] (the default window)"));
  const second = resolveTaskInput(first, fixture.branch, fixture.cwd);
  assert.equal(second, undefined);
});

test("resolveTaskInput leaves task unchanged when no live reads exist", () => {
  const cwd = tmpDir();
  assert.equal(
    resolveTaskInput({ context: "# Goal", tasks: [{ task: "Do X", solutionSpace: "narrow" }] }, [], cwd),
    undefined,
  );
});

test("splitPathAndSelector and evaluateRead handle compound :raw selectors and open-ended continuation ranges", () => {
  const fixture = oneLiveRead("file.ts", "1-180:raw", "[file.ts#A1B2]\n1:const a = 1;\n");
  const rewritten = evaluateRead("file.ts:1-400:raw", fixture.cwd, []);
  assert.equal(rewritten?.rewrite, `file.ts:1-${MAX_READ_LINES}:raw`);
  const duplicateRaw = evaluateRead("file.ts:1-50:raw", fixture.cwd, fixture.branch);
  assert.match(duplicateRaw?.block ?? "", /already in context/);

  const openEnded = oneLiveRead("open.ts", "50", "[open.ts#C3D4]\n50:line 50\n");
  assert.match(evaluateRead("open.ts:60-100", openEnded.cwd, openEnded.branch)?.block ?? "", /already in context/);
  assert.equal(evaluateRead("open.ts:240-300", openEnded.cwd, openEnded.branch), undefined);
});

test("a hashline edit toolCall with [PATH#TAG] in arguments.input invalidates earlier reads", () => {
  const fixture = oneLiveRead("file.ts", undefined, "[file.ts#A1B2]\n1:const a = 1;\n");
  fixture.branch.push({
    type: "message",
    id: "e3",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-2", name: "edit", arguments: { input: "[file.ts#A1B2]\nPUT 1.=1:\n+const a = 2;\n" } }],
    },
  });
  assert.equal(evaluateRead("file.ts", fixture.cwd, fixture.branch), undefined);
  assert.deepEqual(collectLiveReads(fixture.branch, fixture.cwd), []);
});

test("extractFileSymbols and resolveTaskInput include symbol@line coordinates in parent-read-ledger for code files", () => {
  const fixture = oneLiveRead(
    "mod.ts",
    undefined,
    "[mod.ts#AB12]\n1:export function alpha() {}\n",
    "export function alpha() {}\nexport class Beta {}\nexport const GAMMA = 1;\n",
  );
  const reads = collectLiveReads(fixture.branch, fixture.cwd);
  assert.deepEqual(reads, [
    { path: "mod.ts", tag: "[mod.ts#AB12]", windows: ["the default window"], symbols: ["alpha@1", "Beta@2", "GAMMA@3"] },
  ]);
  const out = resolveTaskInput(
    { context: "# Goal\nTest", tasks: [{ task: "Do X", solutionSpace: "narrow" }] },
    fixture.branch,
    fixture.cwd,
  );
  assert.ok(out);
  assert.ok(String(out.context).includes("— symbols: alpha@1, Beta@2, GAMMA@3"));
});

test("extractFileSymbols prioritizes top-level functions over constants, ignores nested functions, and evaluateRead surfaces symbol hints", () => {
  const lines = [
    "export const C1 = 1;",
    "export const C2 = 2;",
    "export const C3 = 3;",
    "export function outer() {",
    "  function innerHelper() { return 1; }",
    "  return innerHelper();",
    "}",
    "export class Worker {}",
  ];
  const fixture = oneLiveRead("code.ts", undefined, "[code.ts#FF00]\n1:export const C1 = 1;\n", lines.join("\n"));
  const reads = collectLiveReads(fixture.branch, fixture.cwd);
  assert.ok(reads[0].symbols?.includes("outer@4"));
  assert.ok(reads[0].symbols?.includes("Worker@8"));
  assert.ok(!reads[0].symbols?.some((s) => s.startsWith("innerHelper@")));
  const blocked = evaluateRead("code.ts", fixture.cwd, fixture.branch);
  assert.match(blocked?.block ?? "", /Symbols in file: .*outer@4.*Worker@8/);
});

test("R-01: partial raw read notice does not block a follow-up slice read", () => {
  const cwd = tmpDir();
  const file = path.join(cwd, "big.ts");
  mkdirSync(path.dirname(file), { recursive: true });
  const longBody = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
  writeFileSync(file, longBody);
  const stat = statSync(file);
  const callId = "call-partial";
  rememberReadStat(callId, stat.mtimeMs, stat.size);
  // The read result carries omp's partial/truncation notice.
  const branch = [
    {
      type: "message",
      id: "e1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "big.ts:1-300" } }],
      },
    },
    {
      type: "message",
      id: "e2",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "read",
        content: [{ type: "text", text: "[big.ts#AB12]\n[Showing lines 1-180 of 300, partial]\n1:line 1\n" }],
      },
    },
  ];
  // A follow-up narrow slice read should NOT be blocked by the truncated read.
  const verdict = evaluateRead("big.ts:1-50", cwd, branch);
  assert.equal(verdict, undefined, "truncated read must not block a follow-up slice");
});

test("R-01: [Some lines truncated to N chars] notice does not block a follow-up read", () => {
  const cwd = tmpDir();
  const file = path.join(cwd, "big.ts");
  mkdirSync(path.dirname(file), { recursive: true });
  const longBody = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
  writeFileSync(file, longBody);
  const stat = statSync(file);
  const callId = "call-trunc";
  rememberReadStat(callId, stat.mtimeMs, stat.size);
  const branch = [
    {
      type: "message",
      id: "e1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "big.ts:raw" } }],
      },
    },
    {
      type: "message",
      id: "e2",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "read",
        content: [{ type: "text", text: "[big.ts#CD34]\n[Some lines truncated to 5000 chars]\n1:line 1\n" }],
      },
    },
  ];
  const verdict = evaluateRead("big.ts:1-50", cwd, branch);
  assert.equal(verdict, undefined, "truncated raw read must not block a follow-up slice");
});

test("R-01: folded ellipsis line in held read does not block a narrower sub-range read, exact repeat still blocked", () => {
  const cwd = tmpDir();
  const file = path.join(cwd, "folded.ts");
  mkdirSync(path.dirname(file), { recursive: true });
  const body = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
  writeFileSync(file, body);
  const stat = statSync(file);
  const callId = "call-fold";
  rememberReadStat(callId, stat.mtimeMs, stat.size);
  // Held bare read carries a folded ellipsis line (omp folds inner code blocks).
  const branch = [
    {
      type: "message",
      id: "e1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "folded.ts" } }],
      },
    },
    {
      type: "message",
      id: "e2",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "read",
        content: [{ type: "text", text: "[folded.ts#EF56]\n…\n1:line 1\n" }],
      },
    },
  ];
  // A narrower sub-range read to unfold lines must NOT be blocked by the folded held read.
  assert.equal(evaluateRead("folded.ts:1-50", cwd, branch), undefined, "folded held read must not block a narrower slice");
  // An exact repeat read (same bare key) must still be blocked even with folded lines.
  const blocked = evaluateRead("folded.ts", cwd, branch);
  assert.equal(blocked?.block !== undefined, true, "exact repeat read must be blocked even with folded lines");
});

test("R-01: resolveTaskInput injects parent-read-ledger into vibe_spawn.prompt", () => {
  const cwd = tmpDir();
  const file = path.join(cwd, "file.ts");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "const a = 1;\n");
  const stat = statSync(file);
  const callId = "call-vibe";
  rememberReadStat(callId, stat.mtimeMs, stat.size);
  const branch = [
    {
      type: "message",
      id: "e1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "file.ts" } }],
      },
    },
    {
      type: "message",
      id: "e2",
      message: { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: "[file.ts#A1B2]\n1:const a = 1;\n" }] },
    },
  ];
  const out = resolveTaskInput({ prompt: "Spawn worker to edit file.ts" }, branch, cwd);
  assert.ok(out);
  assert.ok(typeof out.prompt === "string");
  const p = String(out.prompt);
  assert.ok(p.includes(PARENT_LEDGER_TAG));
  assert.ok(p.includes("- file.ts [file.ts#A1B2]"));
  assert.ok(p.includes("Spawn worker to edit file.ts"));
});

test("R-01: resolveTaskInput is idempotent for vibe_spawn when ledger already present", () => {
  const cwd = tmpDir();
  const file = path.join(cwd, "file.ts");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "const a = 1;\n");
  const stat = statSync(file);
  const callId = "call-vibe2";
  rememberReadStat(callId, stat.mtimeMs, stat.size);
  const branch = [
    {
      type: "message",
      id: "e1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "file.ts" } }],
      },
    },
    {
      type: "message",
      id: "e2",
      message: { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: "[file.ts#A1B2]\n1:const a = 1;\n" }] },
    },
  ];
  const first = resolveTaskInput({ prompt: "Spawn worker" }, branch, cwd);
  assert.ok(first);
  const second = resolveTaskInput(first as Record<string, unknown>, branch, cwd);
  assert.equal(second, undefined, "vibe_spawn with ledger already present must return undefined");
});