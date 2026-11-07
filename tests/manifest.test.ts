/**
 * manifest.test.ts — bundle integrity and structural security contracts.
 *
 * Most assertions here are content checks by design: they encode invariants
 * (entrypoint identity, dependency direction, single receipt writer) that no
 * runtime observation can prove.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "harness.manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

const extensions: string[] = pkg.omp.extensions.map((entry: string) => entry.replace(/^\.\//, ""));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test("package extensions match the manifest entrypoints in order", () => {
  assert.deepEqual(extensions, manifest.entrypoints);
});

test("every manifest file exists and matches its recorded sha256", () => {
  for (const [rel, expected] of Object.entries(manifest.files as Record<string, string>)) {
    const full = path.join(ROOT, rel);
    assert.equal(existsSync(full), true, `missing ${rel}`);
    const actual = createHash("sha256").update(readFileSync(full, "utf8")).digest("hex");
    assert.equal(actual, expected, `sha256 mismatch for ${rel}`);
  }
});

test("every entrypoint exports a default factory function", () => {
  for (const rel of manifest.entrypoints as string[]) {
    const source = readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(source, /export default function/, `${rel} must export a default function`);
  }
});

test("state.ts is a library, not an entrypoint, and registers nothing", () => {
  // Structural invariant: state ownership must never subscribe or register.
  assert.equal((manifest.entrypoints as string[]).includes("src/state.ts"), false);
  assert.equal(extensions.includes("src/state.ts"), false);
  const source = readFileSync(path.join(ROOT, "src", "state.ts"), "utf8");
  assert.equal(source.includes("pi.on("), false);
  // The docstring names the forbidden APIs; assert the call form, not prose.
  assert.equal(source.includes("pi.register("), false);
});

test("policy.ts does not reach the decision layer, the network, or the SDK", () => {
  // Structural invariant: the policy hot path stays local and dependency-free.
  const source = readFileSync(path.join(ROOT, "src", "policy.ts"), "utf8");
  assert.equal(source.includes("@typesafe-ai"), false);
  assert.equal(source.includes("./decisions.ts"), false);
  assert.equal(source.includes("fetch("), false);
});

test("the manifest declares the minimum omp version it was tested against", () => {
  assert.equal(manifest.omp.minimum, "18.12.6");
  assert.ok((manifest.omp.tested as string[]).includes("18.12.6"));
});

test("the manifest file set covers every source, config, agent, skill and package file", () => {
  const expected = new Set<string>();
  for (const name of readdirSync(path.join(ROOT, "src"))) {
    if (name.endsWith(".ts")) expected.add(`src/${name}`);
  }
  expected.add("config/recommended.yml");
  for (const name of readdirSync(path.join(ROOT, "agents"))) {
    if (name.endsWith(".md")) expected.add(`agents/${name}`);
  }
  for (const name of readdirSync(path.join(ROOT, "skills"))) {
    if (existsSync(path.join(ROOT, "skills", name, "SKILL.md"))) expected.add(`skills/${name}/SKILL.md`);
  }
  const pyDir = path.join(ROOT, "py");
  if (existsSync(pyDir)) {
    for (const name of readdirSync(pyDir)) {
      if (name.endsWith(".py")) expected.add(`py/${name}`);
    }
  }
  expected.add("package.json");

  assert.deepEqual(Object.keys(manifest.files as Record<string, string>).sort(), [...expected].sort());
});

test("the model routing fingerprint is a 64-character lowercase hex digest", () => {
  assert.match(manifest.modelRoutingFingerprint, /^[0-9a-f]{64}$/);
});

test("only decisions.ts names the Jev receipt file under src", () => {
  // Structural invariant: the receipt filename has exactly one writer; no other
  // source file may know it, and tools.ts in particular must not.
  for (const full of walk(path.join(ROOT, "src"))) {
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (rel === "src/decisions.ts") continue;
    assert.equal(readFileSync(full, "utf8").includes("jev-decisions.jsonl"), false, rel);
  }
  const toolsSource = readFileSync(path.join(ROOT, "src", "tools.ts"), "utf8");
  assert.equal(toolsSource.includes("jev-decisions.jsonl"), false);
});
