import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleJsonRpcRequest } from "../scripts/omp-harness-mcp.mjs";
import { runClaudeMemoryHook } from "../scripts/claude-memory-hook.mjs";

const EXPECTED_TOOLS = [
  "jev_decide",
  "jev_rank",
  "jev_gate",
  "intake_open",
  "harness_record",
  "harness_mine",
  "harness_gate",
  "harness_decide",
  "zero_mem_recall",
  "ontology_check",
  "ontology_compile",
];

let rpcCounter = 0;
function rpc(method: string, params: unknown, cwd: string) {
  return handleJsonRpcRequest(
    { jsonrpc: "2.0", id: String(++rpcCounter), method, params },
    { cwd },
  );
}

function makeFixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "omp-harness-mcp-"));
  writeFixture(root, files);
  return root;
}

function writeFixture(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    const parent = join(full, "..");
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

function cleanup(root: string) {
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      // Windows may hold SQLite WAL handles briefly; retry after a short pause.
      const start = Date.now();
      while (Date.now() - start < 100) { /* spin */ }
    }
  }
  if (lastErr) throw lastErr;
}

describe("omp-harness-mcp", () => {
  it("initialize, ping, notifications/initialized and tools/list lists all 11 tools", async () => {
    const root = makeFixture({});
    try {
      const init = await rpc("initialize", {}, root);
      assert.strictEqual(init.jsonrpc, "2.0");
      assert.strictEqual(init.id, "1");
      assert.ok(init.result && init.result.protocolVersion);
      assert.ok(init.result && init.result.serverInfo && init.result.serverInfo.name);

      const initialized = await rpc("notifications/initialized", {}, root);
      assert.strictEqual(initialized, null);

      const ping = await rpc("ping", {}, root);
      assert.deepStrictEqual(ping.result, {});

      const list = await rpc("tools/list", {}, root);
      const tools = list.result && list.result.tools;
      assert.ok(Array.isArray(tools), "tools/list must return a tools array");
      assert.strictEqual(tools.length, EXPECTED_TOOLS.length, "expected exactly 11 tools");
      const names = tools.map((t) => t.name);
      for (const expected of EXPECTED_TOOLS) assert.ok(names.includes(expected), `missing tool: ${expected}`);
      for (const t of tools) {
        assert.ok(t && t.name && typeof t.name === "string");
        assert.ok(t && t.description && typeof t.description === "string");
        assert.ok(t && t.inputSchema && typeof t.inputSchema === "object");
      }
    } finally {
      cleanup(root);
    }
  });

  it("unknown method returns JSON-RPC error instead of throwing", async () => {
    const root = makeFixture({});
    try {
      const res = await rpc("tools/nope", {}, root);
      assert.ok(res.error);
      assert.strictEqual(res.error.code, -32601);
    } finally {
      cleanup(root);
    }
  });

  it("ontology_compile then ontology_check returns text and numeric coverage", async () => {
    const root = makeFixture({});
    try {
      writeFixture(root, {
        "src/math.ts": "export function calculateTotal(a: number, b: number): number { return a + b; }\n",
      });
      const compiled = await rpc("tools/call", { name: "ontology_compile", arguments: { cwd: root, export_yaml: true } }, root);
      assert.ok(!compiled.result.isError, "ontology_compile must not error");
      assert.ok(compiled.result.content && compiled.result.content.length > 0);
      assert.ok(typeof compiled.result.content[0].text === "string" && compiled.result.content[0].text.length > 0);
      assert.ok(compiled.result.structuredContent && typeof compiled.result.structuredContent.termsCount === "number");

      const checked = await rpc("tools/call", { name: "ontology_check", arguments: { cwd: root, query: "calculateTotal" } }, root);
      assert.ok(!checked.result.isError, "ontology_check must not error");
      assert.ok(typeof checked.result.content?.[0]?.text === "string");
      assert.ok(
        checked.result.structuredContent && typeof checked.result.structuredContent.coverage === "number",
        "coverage must be numeric",
      );
    } finally {
      cleanup(root);
    }
  });

  it("zero_mem_recall on an empty project returns a non-error response", async () => {
    const root = makeFixture({});
    try {
      const res = await rpc("tools/call", { name: "zero_mem_recall", arguments: { cwd: root, query: "anything at all", top_k: 3 } }, root);
      assert.ok(!res.result.isError, "zero_mem_recall must not error on empty project");
      assert.ok(res.result.content && res.result.content.length > 0);
      assert.ok(res.result.structuredContent && res.result.structuredContent.ok === true);
    } finally {
      cleanup(root);
    }
  });

  it("jev_decide with no key available returns deterministic fallback (no network)", async () => {
    const root = makeFixture({});
    const saved = {
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
      NS24_API_KEY: process.env.NS24_API_KEY,
      JEV_KEY_FILE: process.env.JEV_KEY_FILE,
    };
    try {
      delete process.env.TYPESAFE_API_KEY;
      delete process.env.NS24_API_KEY;
      process.env.JEV_KEY_FILE = join(root, "does-not-exist.key");
      const res = await rpc(
        "tools/call",
        { name: "jev_decide", arguments: { kind: "decide", state: "some state", candidates: [{ id: "a" }, { id: "b" }], path: "/tmp/readiness.md" } },
        root,
      );
      assert.ok(!res.result.isError, "jev_decide fallback must not be an error");
      const text = res.result.content?.[0]?.text ?? "";
      assert.ok(text.includes("unavailable"), `expected 'unavailable' in: ${text}`);
      assert.strictEqual(res.result.structuredContent?.status, "unavailable");
      assert.strictEqual(res.result.structuredContent?.fallback, "deterministic");
    } finally {
      process.env.TYPESAFE_API_KEY = saved.TYPESAFE_API_KEY;
      process.env.NS24_API_KEY = saved.NS24_API_KEY;
      if (saved.JEV_KEY_FILE === undefined) delete process.env.JEV_KEY_FILE;
      else process.env.JEV_KEY_FILE = saved.JEV_KEY_FILE;
      cleanup(root);
    }
  });

  it("runClaudeMemoryHook Stop then UserPromptSubmit injects zero-mem-recall", async () => {
    const root = makeFixture({});
    const chunks: Buffer[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(Buffer.from(chunk as Buffer | string));
      return true;
    }) as typeof process.stdout.write;
    try {
      writeFixture(root, {
        "src/math.ts": "export function add(a: number, b: number): number { return a + b; }\n",
      });

      await runClaudeMemoryHook(
        { hook_event_name: "Stop", request: "Implement add", outcome: "decision: use the `add` function in `src/math.ts` for all integer sums", cwd: root },
        { cwd: root },
      );
      const stopOut = Buffer.concat(chunks).toString("utf8");
      assert.strictEqual(stopOut, "", "Stop event must write nothing to stdout");
      chunks.length = 0;

      await runClaudeMemoryHook(
        { hook_event_name: "UserPromptSubmit", prompt: "How do I use the `add` function in `src/math.ts`?", cwd: root },
        { cwd: root },
      );
      const out = Buffer.concat(chunks).toString("utf8");
      const parsed = JSON.parse(out);
      assert.strictEqual(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
      assert.ok(typeof parsed.hookSpecificOutput.additionalContext === "string");
      assert.ok(
        parsed.hookSpecificOutput.additionalContext.includes("<zero-mem-recall>"),
        `expected <zero-mem-recall> in: ${parsed.hookSpecificOutput.additionalContext}`,
      );
    } finally {
      process.stdout.write = origWrite;
      cleanup(root);
    }
  });

  it("Stop event with garbage transcript_path exits cleanly (no throw)", async () => {
    const root = makeFixture({});
    try {
      writeFileSync(join(root, "transcript.jsonl"), "this is not jsonl\n{broken}\n", "utf8");
      await assert.doesNotReject(
        runClaudeMemoryHook(
          { hook_event_name: "Stop", transcript_path: join(root, "transcript.jsonl"), cwd: root },
          { cwd: root },
        ),
      );
      await assert.doesNotReject(
        runClaudeMemoryHook({ hook_event_name: "Stop", transcript_path: join(root, "absent.jsonl"), cwd: root }, { cwd: root }),
      );
    } finally {
      cleanup(root);
    }
  });
});
