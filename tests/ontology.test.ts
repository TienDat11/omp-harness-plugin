import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  certifyTermsForFiles,
  checkOntologyCoverage,
  compileOntology,
  exportOntologyYaml,
  importOntologyYaml,
  ontologyYamlPath,
} from "../src/ontology.ts";
import { ZeroMemBridge, appendUnits, dbPath } from "../src/zeromem.ts";

process.env.OMP_HARNESS_TEST = "1";

function fixtureProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "omp-ontology-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "zeromem.ts"),
    "export function ZeroMemBridge(): string { return 'bridge'; }\nexport const dbPath = 'p';\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "src", "consumer.ts"),
    'import { ZeroMemBridge } from "./zeromem.ts";\nexport const wired = ZeroMemBridge;\n',
    "utf8",
  );
  writeFileSync(
    path.join(root, "src", "orphan.ts"),
    'import { Nothing } from "./gone.ts";\nexport const lonely = 1;\n',
    "utf8",
  );
  writeFileSync(path.join(root, "src", "other.ts"), "export const unrelated = 2;\n", "utf8");
  writeFileSync(
    path.join(root, "tests", "zeromem.test.ts"),
    'import { ZeroMemBridge } from "../src/zeromem.ts";\nZeroMemBridge();\n',
    "utf8",
  );
  return root;
}

test("compileOntology ingests terms and verifies only joins that exist on disk", () => {
  const root = fixtureProject();
  try {
    const result = compileOntology(root);
    assert.ok(result.termsCount >= 4, `expected >=4 terms, got ${result.termsCount}`);
    assert.ok(result.certifiedCount >= 1, "a term referenced from tests/ is certified");
    assert.ok(result.verifiedRelationsCount >= 1, "consumer -> zeromem import is verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage gate reports compound entities whole and gates answerability", () => {
  const root = fixtureProject();
  try {
    compileOntology(root);
    const cov = checkOntologyCoverage(root, "update ZeroMemBridge query and nonexistent_widget_xyz");
    assert.equal(cov.coverage, 0.5);
    assert.equal(cov.answerable, false);
    assert.deepEqual(cov.matchedTermIds, ["term:zeromem"]);
    assert.deepEqual(cov.uncoveredEntities, ["nonexistent_widget_xyz"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("certified units outrank identical uncertified units and certifiedOnly excludes them", async () => {
  const root = fixtureProject();
  const bridge = new ZeroMemBridge();
  try {
    compileOntology(root);
    // src/zeromem.ts is already certified by the tests/ reference; consumer.ts is not.
    const certifiedCount = certifyTermsForFiles(root, ["src/consumer.ts"], "harness_record");
    assert.equal(certifiedCount, 1, "certifyTermsForFiles marks the file-backed term");

    const at = new Date(1_700_000_000_000).toISOString();
    appendUnits(root, [
      {
        id: "unit-certified",
        kind: "decision",
        text: "decision: ZeroMemBridge ranks ontology evidence deterministically alpha",
        at,
        session: "s",
        files: ["src/consumer.ts"],
        symbols: ["ZeroMemBridge"],
      },
      {
        id: "unit-plain",
        kind: "decision",
        text: "decision: ZeroMemBridge ranks ontology evidence deterministically bravo",
        at,
        session: "s",
        files: ["src/other.ts"],
        symbols: ["unrelated"],
      },
    ]);

    const all = await bridge.query(root, "ZeroMemBridge ontology evidence", { topK: 5 });
    const byId = new Map(all.evidence.map((e) => [e.id, e.score]));
    const certified = byId.get("unit-certified");
    const plain = byId.get("unit-plain");
    assert.ok(certified !== undefined && plain !== undefined, "both units are recalled");
    assert.ok(certified! > plain!, `certified ${certified} must exceed uncertified ${plain}`);

    const onlyCertified = await bridge.query(root, "ZeroMemBridge ontology evidence", {
      topK: 5,
      certifiedOnly: true,
    });
    assert.ok(onlyCertified.evidence.length > 0, "certified evidence is admitted");
    assert.ok(
      onlyCertified.evidence.every((e) => e.id === "unit-certified"),
      "certifiedOnly never backfills uncertified units",
    );
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Ossie YAML round-trips through a fresh database", () => {
  const root = fixtureProject();
  try {
    compileOntology(root);
    const yamlPath = exportOntologyYaml(root);
    const doc = readFileSync(yamlPath, "utf8");
    assert.ok(doc.startsWith("# Apache Ossie-compatible Domain Ontology v1.0"));
    assert.ok(doc.includes('"schema": "apache-ossie-compatible"'));
    assert.equal(yamlPath, ontologyYamlPath(root));

    const reimported = importOntologyYaml(root, yamlPath);
    assert.ok(reimported.termsCount >= 4);
    assert.ok(reimported.verifiedRelationsCount >= 1);

    const cov = checkOntologyCoverage(root, "ZeroMemBridge");
    assert.equal(cov.answerable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withMemoryDb closes its handle so the store is deletable on Windows", () => {
  const root = fixtureProject();
  compileOntology(root);
  assert.ok(readFileSync(dbPath(root)).length > 0);
  rmSync(root, { recursive: true, force: true });
});
