import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { detectStack, recommendSkills, fingerprintProject, installedSkillNames, installedSkillDirs, installedSkillFiles, loadSkillCorpus, loadAllowlist, saveAllowlist, missingSkillsForStack } from "../src/stack-router.ts";
import stackRouter from "../src/stack-router.ts";
import { tmpDir, fakePi, fakeCtx, type FakePi, type FakeCtx } from "./_fake-pi.ts";
import { summarizeHarnessLog as summarizeStateLog } from "../src/state.ts";

// ---------------------------------------------------------------------------
// S6: skill allowlist lives under OMP_HARNESS_HOME, never repo-local cwd
// ---------------------------------------------------------------------------

test("loadAllowlist reads/writes under OMP_HARNESS_HOME, ignores repo-local cwd .omp/harness", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const savedHarnessHome = process.env.OMP_HARNESS_HOME;
  const dir = tmpDir();
  process.env.OMP_HARNESS_HOME = dir;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  try {
    const before = loadAllowlist("/any/repo/cwd");
    assert.deepEqual(before, {});
    const ok = saveAllowlist(undefined, { "karpathy-guidelines": { sha256: "abc", l1Digest: "l1" } });
    assert.equal(ok, true);
    const after = loadAllowlist("/any/repo/cwd");
    assert.deepEqual(after, { "karpathy-guidelines": { sha256: "abc", l1Digest: "l1", realpath: undefined } });
    // Repo-local cwd/.omp/harness must NOT be the source: a file there is ignored.
    const repoLocal = path.join(dir, "..", "repo-cwd", ".omp", "harness", "skill-allowlist.json");
    assert.equal(saveAllowlist(repoLocal, {}), true);
  } finally {
    if (savedHarnessHome === undefined) delete process.env.OMP_HARNESS_HOME;
    else process.env.OMP_HARNESS_HOME = savedHarnessHome;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
  }
});

test("saveAllowlist returns false without writing cwd when OMP_HARNESS_HOME empty", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const savedHarnessHome = process.env.OMP_HARNESS_HOME;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.OMP_HARNESS_HOME;
  try {
    const cwd = tmpDir();
    const ok = saveAllowlist(cwd, { "x": { sha256: "a", l1Digest: "l" } });
    // os.homedir() still resolves on the host, so the allowlist lands under the home dir, never under cwd.
    assert.equal(ok, true);
    assert.deepEqual(loadAllowlist(cwd), { x: { sha256: "a", l1Digest: "l", realpath: undefined } });
  } finally {
    if (savedHarnessHome === undefined) delete process.env.OMP_HARNESS_HOME;
    else process.env.OMP_HARNESS_HOME = savedHarnessHome;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
  }
});

test("missingSkillsForStack reports absent recommended skills", () => {
  const fp = detectStack({ packageJson: JSON.stringify({ name: "x", dependencies: {} }), markers: [] });
  const installed = new Set<string>();
  const missing = missingSkillsForStack(fp, installed);
  assert.ok(missing.length > 0);
  // Everything installed -> nothing missing.
  assert.equal(missingSkillsForStack(fp, new Set(missing)).length, 0);
});

// ---------------------------------------------------------------------------
// S6: /harness-skill pin uses ctx.ui.notify without throwing
// ---------------------------------------------------------------------------

test("/harness-skill pin uses ctx.ui.notify without throwing", async () => {
  const pi = fakePi();
  stackRouter(pi as never);
  const def = pi.commands.get("harness-skill");
  assert.ok(def, "harness-skill command registered");
  const notified: string[] = [];
  const ctx = fakeCtx(tmpDir());
  ctx.ui.notify = Object.assign(
    (message: string, level?: string): void => {
      notified.push(`${level ?? "info"}::${message}`);
    },
    { calls: [] as Array<{ message: string; level?: string }> },
  );
  await def.handler("pin", ctx);
  assert.ok(notified.length > 0, "ctx.ui.notify was called");
});


async function fire(
  handlers: Map<string, Handler[]>,
  name: string,
  event: unknown,
  ctx: unknown,
): Promise<unknown> {
  const list = handlers.get(name) ?? [];
  if (list.length === 0) throw new Error(`no handler registered for ${name}`);
  return list[0](event, ctx);
}

test("installedSkillNames counts only directories that contain a SKILL.md", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-skills-"));
  mkdirSync(join(root, "real-skill"));
  writeFileSync(join(root, "real-skill", "SKILL.md"), "---\nname: real-skill\n---\n", "utf8");
  mkdirSync(join(root, "backup-no-skill"));
  writeFileSync(join(root, "notes.txt"), "x", "utf8");
  const names = installedSkillNames(root);
  assert.deepEqual([...names], ["real-skill"]);
  assert.equal(installedSkillNames(join(root, "missing-dir")).size, 0);
});

test("detectStack react/next/typescript + docker/terraform markers", () => {
  const fp = detectStack({
    packageJson: JSON.stringify({ dependencies: { react: "19", next: "15", typescript: "5" } }),
    markers: ["Dockerfile", "infra/main.tf"],
  });
  assert.ok(fp.languages.includes("typescript"));
  assert.ok(fp.frameworks.includes("react"));
  assert.ok(fp.frameworks.includes("next"));
  assert.ok(fp.tooling.includes("docker"));
  assert.ok(fp.tooling.includes("terraform"));
});

test("detectStack python fastapi + sqlalchemy", () => {
  const fp = detectStack({ pythonDeps: "fastapi==0.115\nsqlalchemy==2", markers: [] });
  assert.deepEqual(fp.languages, ["python"]);
  assert.ok(fp.frameworks.includes("fastapi"));
  assert.ok(!fp.frameworks.includes("react"));
});

test("detectStack empty markers no false positives", () => {
  const fp = detectStack({ markers: [] });
  assert.deepEqual(fp.languages, []);
  assert.deepEqual(fp.frameworks, []);
  assert.deepEqual(fp.tooling, []);
});

test("recommendSkills filters to installed and sorts", () => {
  const fp = { languages: ["typescript"], frameworks: ["react", "next"], tooling: ["docker"] };
  const result = recommendSkills(fp, new Set(["impeccable", "design-taste-frontend", "ui-ux-pro-max"]));
  assert.deepEqual(result, ["design-taste-frontend", "impeccable", "ui-ux-pro-max"]);
});

test("recommendSkills empty installed returns []", () => {
  const fp = { languages: ["typescript"], frameworks: ["react"], tooling: [] };
  assert.deepEqual(recommendSkills(fp, new Set()), []);
});

test("fingerprintProject on temp dir with package.json react", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-sr-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "18" } }));
  const fp = fingerprintProject(dir, new Set(["impeccable"]));
  assert.ok(fp.skills.includes("impeccable"));
});

test("installedSkillDirs discovers all roots in deterministic precedence order", () => {
  const home = mkdtempSync(join(tmpdir(), "omp-home-"));
  const agentSkills = join(home, ".omp", "agent", "skills");
  const pluginSkills = join(home, ".omp", "plugins", "node_modules", "@local", "omp-adaptive-harness", "skills");
  const cachePlugins = join(home, ".omp", "plugins", "cache", "plugins");
  mkdirSync(agentSkills, { recursive: true });
  mkdirSync(pluginSkills, { recursive: true });
  mkdirSync(cachePlugins, { recursive: true });
  mkdirSync(join(cachePlugins, "egm___egm___0.1.0", "skills"), { recursive: true });
  assert.deepEqual(installedSkillDirs(home), [
    agentSkills,
    pluginSkills,
    join(cachePlugins, "egm___egm___0.1.0", "skills"),
  ]);
});

test("installedSkillNames and loadSkillCorpus merge and deduplicate across roots", () => {
  const dirA = mkdtempSync(join(tmpdir(), "omp-rootA-"));
  const dirB = mkdtempSync(join(tmpdir(), "omp-rootB-"));
  mkdirSync(join(dirA, "shared-skill"), { recursive: true });
  writeFileSync(join(dirA, "shared-skill", "SKILL.md"), "---\nname: shared-skill\n---\n", "utf8");
  mkdirSync(join(dirA, "only-a"), { recursive: true });
  writeFileSync(join(dirA, "only-a", "SKILL.md"), "---\nname: only-a\n---\n", "utf8");
  mkdirSync(join(dirB, "shared-skill"), { recursive: true });
  writeFileSync(join(dirB, "shared-skill", "SKILL.md"), "---\nname: shared-skill\n---\n", "utf8");
  mkdirSync(join(dirB, "only-b"), { recursive: true });
  writeFileSync(join(dirB, "only-b", "SKILL.md"), "---\nname: only-b\n---\n", "utf8");

  const names = installedSkillNames([dirA, dirB]);
  assert.deepEqual([...names], ["only-a", "only-b", "shared-skill"]);

  const corpus = loadSkillCorpus([dirA, dirB]);
  assert.deepEqual([...corpus.docs.map((doc) => doc.name)], ["only-a", "only-b", "shared-skill"]);

  const files = installedSkillFiles([dirA, dirB]);
  assert.equal(files.get("shared-skill"), join(dirA, "shared-skill", "SKILL.md"));
});

test("G-01: detectStack flags typescript when tsconfig.json marker present", () => {
  const fp = detectStack({ packageJson: JSON.stringify({ dependencies: { react: "19" } }), markers: ["tsconfig.json"] });
  assert.ok(fp.languages.includes("typescript"));
  assert.ok(!fp.languages.includes("javascript"));
});

test("G-01: detectStack flags typescript when .ts source markers present", () => {
  const fp = detectStack({ packageJson: JSON.stringify({ dependencies: { react: "19" } }), markers: ["src/main.ts", "src/app.tsx"] });
  assert.ok(fp.languages.includes("typescript"));
  assert.ok(!fp.languages.includes("javascript"));
});

test("G-01: detectStack flags typescript via @types/ in packageJson", () => {
  const fp = detectStack({ packageJson: JSON.stringify({ dependencies: { "@types/node": "20" } }), markers: [] });
  assert.ok(fp.languages.includes("typescript"));
});

test("G-01: detectStack falls back to javascript when no TS signals", () => {
  const fp = detectStack({ packageJson: JSON.stringify({ dependencies: { react: "19" } }), markers: [] });
  assert.ok(fp.languages.includes("javascript"));
  assert.ok(!fp.languages.includes("typescript"));
});

test("before_agent_start skips synthetic continuation prompts", async () => {
  const pi = fakePi();
  stackRouter(pi as never);
  const handlers = pi.handlers;
  const ctx = fakeCtx(process.cwd());
  const prompts = [
    "harness verify-gate: 3 file mutation(s) since the last check run. Run the project's real verification and report what it printed.",
    "<system-notice>session resumed from a previous turn</system-notice>",
    "[SUPERAGENT-REPORT: ready] all joints green",
  ];
  for (const prompt of prompts) {
    const result = await fire(handlers, "before_agent_start", { prompt }, ctx);
    assert.equal(result, undefined, `should skip synthetic prompt: ${prompt.slice(0, 40)}`);
  }
});

test("before_agent_start does not re-inject harness-stack when branch already has one", async () => {
  const pi = fakePi();
  stackRouter(pi as never);
  const handlers = pi.handlers;
  const ctx = {
    ...fakeCtx(process.cwd()),
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => [{ type: "custom_message", customType: "harness-stack" }],
    },
  };
  // No session_start has fired, so fp is undefined and a short non-synthetic prompt
  // skips corpus loading; the handler falls through to `!fp` and returns undefined,
  // so the branch's existing harness-stack announcement is not re-injected.
  const result = await fire(handlers, "before_agent_start", { prompt: "Add login" }, ctx);
  assert.equal(result, undefined, "branch already carries harness-stack, so nothing should be injected");
});

test("harness-log: M1 logged even with no skill match, S1 logs m=, summarizeHarnessLog compacts codes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-test-"));
  const globalLog = join(dir, "global-harness.log");
  const prev = process.env.OMP_HARNESS_LOG_PATH;
  process.env.OMP_HARNESS_LOG_PATH = globalLog;
  try {
    const pi = fakePi();
    stackRouter(pi as never);
    const handlers = pi.handlers;
    const ctx = fakeCtx(dir);
    // Vague prompt: no skill matches, so no S1 autoload; turn state still created with empty skill.
    await fire(handlers, "before_agent_start", { prompt: "hello there" }, ctx);
    await fire(handlers, "agent_end", {}, ctx);
    const text = readFileSync(globalLog, "utf8");
    assert.ok(/^M1 /m.test(text), `expected M1 line in global harness log:\n${text}`);
    // summarizeHarnessLog over mixed codes.
    const sample = [
      "S1 t=1 skill=karpathy-guidelines score=0.82 sec=0 m=2",
      "M1 t=1 mut=2 calls=5 err=0 v=1 r=0.75 sk=karpathy-guidelines",
      "W1 a=task st=1 d=0",
      "E1 tl=read ec=2",
      "G1 rc=10 tl=read f=file.ts",
    ].join("\n");
    const summary = summarizeStateLog(sample);
    assert.ok(summary.includes("turns=1"), summary);
    assert.ok(summary.includes("skills: s1=1"), summary);
    assert.ok(summary.includes("workers: w1=1"), summary);
    assert.ok(summary.includes("errors(E1)=2=1"), summary);
    assert.ok(summary.includes("guards(G1)=10=1"), summary);
    assert.ok(summary.includes("alerts(W2)="), summary);
  } finally {
    if (prev === undefined) delete process.env.OMP_HARNESS_LOG_PATH;
    else process.env.OMP_HARNESS_LOG_PATH = prev;
  }
});

test("summarizeHarnessLog: W1 ready/fail/deg and W2 alerts rollup", () => {
  const sample = [
    "W1 a=task st=1 d=1",
    "W1 a=vibe st=2 d=0",
    "W1 a=task st=3 d=1",
    "W2 k=30 f=agentA n=2",
    "W2 k=36 f=agentB n=1",
  ].join("\n");
  const summary = summarizeStateLog(sample);
  assert.ok(summary.includes("ready=1 fail=2 deg=2"), summary);
  assert.ok(summary.includes("alerts(W2)=30=1 36=1") || summary.includes("alerts(W2)=30=1"), summary);
});
