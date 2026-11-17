import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HOOK_SOURCE = join(process.cwd(), "scripts", "claude-memory-hook.mjs");

function copyHookOutsideRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hook-copy-"));
  const dest = join(dir, "memory-intake.mjs");
  copyFileSync(HOOK_SOURCE, dest);
  return { dir, dest };
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}
function runHook(dest: string, event: unknown) {
  return spawnSync(process.execPath, [dest], {
    input: JSON.stringify(event),
    encoding: "utf8",
    timeout: 15000,
  });
}

describe("claude-memory-hook copied location", () => {
  it("Stop event exits 0 with no module-not-found when run from outside the repo", () => {
    const { dir, dest } = copyHookOutsideRepo();
    try {
      const r = runHook(dest, { hook_event_name: "Stop", cwd: dir });
      assert.strictEqual(r.status, 0, `expected status 0, got ${r.status}; stderr: ${r.stderr}`);
      assert.ok(!r.stderr.includes("ERR_MODULE_NOT_FOUND"), `stderr: ${r.stderr}`);
      assert.ok(!r.stderr.includes("Cannot find module"), `stderr: ${r.stderr}`);
    } finally {
      cleanup(dir);
    }
  });

  it("Stop event with missing transcript_path exits 0 from outside repo", () => {
    const { dir, dest } = copyHookOutsideRepo();
    try {
      const r = runHook(dest, {
        hook_event_name: "Stop",
        cwd: dir,
        transcript_path: join(dir, "does-not-exist.jsonl"),
      });
      assert.strictEqual(r.status, 0, `expected status 0, got ${r.status}; stderr: ${r.stderr}`);
      assert.ok(!r.stderr.includes("ERR_MODULE_NOT_FOUND"), `stderr: ${r.stderr}`);
      assert.ok(!r.stderr.includes("Cannot find module"), `stderr: ${r.stderr}`);
    } finally {
      cleanup(dir);
    }
  });

  it("UserPromptSubmit event exits 0 from outside repo", () => {
    const { dir, dest } = copyHookOutsideRepo();
    try {
      const r = runHook(dest, {
        hook_event_name: "UserPromptSubmit",
        cwd: dir,
        prompt: "x".repeat(40),
      });
      assert.strictEqual(r.status, 0, `expected status 0, got ${r.status}; stderr: ${r.stderr}`);
      assert.ok(!r.stderr.includes("ERR_MODULE_NOT_FOUND"), `stderr: ${r.stderr}`);
      assert.ok(!r.stderr.includes("Cannot find module"), `stderr: ${r.stderr}`);
      if (r.stdout && r.stdout.trim()) {
        JSON.parse(r.stdout.trim());
      }
    } finally {
      cleanup(dir);
    }
  });
});
