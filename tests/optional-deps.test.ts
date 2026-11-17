import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadGraphology, loadMiniSearch, setOptionalDepsOverride } from "../src/optional-deps.ts";
import { selectCandidateDocs } from "../src/stack-router.ts";
import { ZeroMemBridge, appendUnits, corpusPath } from "../src/zeromem.ts";

process.env.OMP_HARNESS_TEST = "1";

function seed(cwd: string, text: string, files: string[]): void {
  mkdirSync(path.dirname(corpusPath(cwd)), { recursive: true });
  appendUnits(cwd, [
    {
      id: `u-${files[0]}`,
      kind: "decision",
      text,
      at: new Date(1_700_000_000_000).toISOString(),
      session: "s",
      files,
      symbols: [],
    },
  ]);
}

test("real installs resolve both packages", () => {
  setOptionalDepsOverride(null);
  assert.equal(typeof loadMiniSearch(), "function");
  const graphDeps = loadGraphology();
  assert.ok(graphDeps);
  assert.equal(typeof graphDeps.Graph, "function");
  assert.equal(typeof graphDeps.pagerank, "function");
});

test("missing minisearch and graphology degrade instead of throwing", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "omp-optional-deps-"));
  seed(cwd, "decision: ZeroMemBridge ranks evidence with FTS5 bm25 only when the graph stages are absent", [
    "src/zeromem.ts",
  ]);
  setOptionalDepsOverride({ minisearch: null, graphology: null });
  try {
    assert.equal(loadMiniSearch(cwd), null);
    assert.equal(loadGraphology(cwd), null);

    const bridge = new ZeroMemBridge();
    const result = await bridge.query(cwd, "ZeroMemBridge evidence rank", { topK: 3 });
    assert.equal(result.ok, true);
    assert.ok((result.evidence.length ?? 0) > 0, "FTS5/entity stages must still return evidence");
    bridge.close();

    const docs = [
      { name: "alpha", description: "first skill", keywords: [], notFor: [] },
      { name: "beta", description: "second skill", keywords: [], notFor: [] },
    ];
    // No lexical recall available: with no stack/suggestion signal the full catalog survives.
    assert.deepEqual(selectCandidateDocs(docs, "anything at all"), docs);
    // A stack fingerprint still filters when MiniSearch cannot.
    assert.deepEqual(
      selectCandidateDocs(docs, "anything at all", { stackSkills: ["beta"] }).map((d) => d.name),
      ["beta"],
    );
  } finally {
    setOptionalDepsOverride(null);
  }
});

test("reset restores the real packages", () => {
  setOptionalDepsOverride({ minisearch: null });
  assert.equal(loadMiniSearch(), null);
  setOptionalDepsOverride(null);
  assert.equal(typeof loadMiniSearch(), "function");
});
