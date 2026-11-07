import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decideValve, foldVietnamese, parseSkillDoc, pinnedDigest, scoreSkillDocs, type SkillDoc } from "../src/skill-specs.ts";
import { selectCandidateDocs } from "../src/stack-router.ts";

const BODIES: Record<string, string> = {
  "business-flow": "---\nname: business-flow\ndescription: Turn a plain-language feature request (Vietnamese or English) into a business process spec QT-nn with actors, main flow, error paths, acceptance criteria. Triggers: quy trinh nghiep vu, business flow, phieu yeu cau.\n---\n",
  "business-flow-qa": "---\nname: business-flow-qa\ndescription: Turn a business flow spec into an executable test matrix with RBAC authorization tests and boundary values. Triggers: kiem thu, test nghiep vu, phan quyen.\n---\n",
  "oss-blueprint": "---\nname: oss-blueprint\ndescription: Dissect a third-party open-source repo into one blueprint file with license gate and LAY THAY BO HOAN verdicts. Triggers: boc tach repo, ma nguon mo, dung lai he thong.\n---\n",
  "security-audit": "---\nname: security-audit\ndescription: Security guidance and vulnerability review for codebases and APIs. Triggers: security, vulnerability, pentest.\n---\n",
  "karpathy-guidelines": "---\nname: karpathy-guidelines\ndescription: Andrej Karpathy's 4 rules: think before coding, simplicity first, surgical changes, goal-driven execution. Avoid overcomplication and bloat.\n---\n",
  "egm-review-loop": "---\nname: egm-review-loop\ndescription: EGM-reviewed spec review loop: interrogate the skill, plan review, spec review, goldfish memory bounds, elephant context.\n---\n",
  "omp-superagent": "---\nname: omp-superagent\ndescription: OMP superagent: subagents, workers, watchdog, parallel wave delegation through the router.\n---\n",
  "skill-upgrade": "---\nname: skill-upgrade\ndescription: Review skills, skill routing, skill eval, trigger eval, skill description, and upgrade skill workflows.\n---\n",
  "ask-matt": "---\nname: ask-matt\ndescription: Ask Matt: non-technical life questions and Matt's advice.\n---\n",
};

function corpus(): SkillDoc[] {
  const docs: SkillDoc[] = [];
  for (const [name, body] of Object.entries(BODIES)) {
    const doc = parseSkillDoc(body, name);
    if (doc !== null) docs.push(doc);
  }
  return docs;
}

function rank(prompt: string) {
  return scoreSkillDocs(selectCandidateDocs(corpus(), prompt, {}), prompt, {});
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

test("foldVietnamese strips tone marks and maps đ and Đ to d", () => {
  assert.equal(foldVietnamese("nghiệp vụ"), "nghiep vu");
  assert.equal(foldVietnamese("Đặc tả"), "dac ta");
});

test("VN business-flow prompt ranks business-flow first with a score above the noise floor", () => {
  const top = rank("tôi muốn viết quy trình nghiệp vụ cho phiếu yêu cầu nhắc hạn card")[0];
  assert.equal(top.name, "business-flow");
  assert.ok(top.score > 0.5, `score ${top.score}`);
});

test("accented VN business-flow prompt survives the MiniSearch funnel", () => {
  const funnel = selectCandidateDocs(corpus(), "tôi muốn viết quy trình nghiệp vụ cho phiếu yêu cầu nhắc hạn card", {});
  assert.ok(funnel.some((d) => d.name === "business-flow"), `funnel kept ${funnel.map((d) => d.name).join(",")}`);
});

test("VN repo-dissection prompt ranks oss-blueprint first", () => {
  const top = rank("bóc tách repo open source này để dựng lại hệ thống")[0];
  assert.equal(top.name, "oss-blueprint");
  assert.ok(top.score > 0.3, `score ${top.score}`);
});

test("VN RBAC test prompt ranks business-flow-qa first", () => {
  const top = rank("kiểm thử phân quyền RBAC cho API xóa workspace")[0];
  assert.equal(top.name, "business-flow-qa");
});

test("the Vietnamese word lợi does not match the alias for lỗi", () => {
  const debugger_ = { name: "debugger", description: "bug error", keywords: ["bug", "error"], notFor: [] };
  const scored = scoreSkillDocs([debugger_], "lợi ích cho người dùng", {});
  assert.equal(scored[0].score, 0, `score ${scored[0].score} from ${scored[0].reason}`);
});

test("pinnedDigest releases a digest only when the pinned sha matches the live body", () => {
  const live = sha(BODIES["security-audit"]);
  assert.equal(pinnedDigest({ l1Digest: "digest" }, live, live), "digest");
  assert.equal(pinnedDigest({ l1Digest: "digest" }, live, undefined), null, "no pin must not release");
  assert.equal(pinnedDigest({ l1Digest: "digest" }, live, ""), null, "empty pin must not release");
  assert.equal(pinnedDigest({ l1Digest: "digest" }, sha("tampered"), live), null, "changed body must not release");
});

test("pinnedDigest rejects when recomputedDigest !== l1Digest even if actualSha256 === pinnedSha256", () => {
  const live = sha(BODIES["security-audit"]);
  // actual and pinned match, but the recomputed digest differs from the stored l1Digest.
  assert.equal(pinnedDigest({ l1Digest: "stored digest" }, live, live, "other-digest"), null, "recomputed digest mismatch must reject");
  // recomputed digest equal to l1Digest releases.
  assert.equal(pinnedDigest({ l1Digest: "stored digest" }, live, live, "stored digest"), "stored digest", "matching recomputed digest releases");
});

test("decideValve never opens for a changed body even when an l1Digest is stored", () => {
  const cand = { name: "security-audit", score: 0.95, margin: 0.9, reason: "" };
  const d = decideValve([cand], {
    allowlist: { "security-audit": { l1Digest: "stored digest" } },
    actualSha256: { "security-audit": sha("tampered") },
    pinnedSha256: { "security-audit": sha(BODIES["security-audit"]) },
    holdout: false,
    alreadyInjected: [],
  });
  assert.equal(d.valveOpen, false);
  assert.equal(d.reason, "sha-mismatch");
});

test("Garry Tan resolver: Vietnamese nang-cap prompt routes karpathy-guidelines first, pulls in egm-review-loop / omp-superagent / skill-upgrade, vetoes ask-matt and business-flow", () => {
  const results = rank("Coi còn gì nâng cấp được nâng cấp luôn nhé. Bạn và subagent đọc thử chị lauren tan và andrej karparthy đang nổi ở trên X á...");
  const names = results.map((r) => r.name);
  assert.equal(names[0], "karpathy-guidelines", `top is ${names[0]}, full ranking ${names.join(",")}`);
  assert.ok(names.includes("egm-review-loop"), `expected egm-review-loop in ${names.join(",")}`);
  assert.ok(names.includes("omp-superagent"), `expected omp-superagent in ${names.join(",")}`);
  assert.ok(names.includes("skill-upgrade"), `expected skill-upgrade in ${names.join(",")}`);
  assert.ok(!names.includes("ask-matt"), `ask-matt must be vetoed: ${names.join(",")}`);
  assert.ok(!names.includes("business-flow"), `business-flow must be vetoed: ${names.join(",")}`);
});

test("Garry Tan resolver: English upgrade prompt routes karpathy-guidelines first and vetoes ask-matt and business-flow", () => {
  const results = rank("upgrade everything I can and read Lauren Tan and Andrej Karpathy on X");
  const names = results.map((r) => r.name);
  assert.equal(names[0], "karpathy-guidelines", `top is ${names[0]}, full ranking ${names.join(",")}`);
  assert.ok(!names.includes("ask-matt"), `ask-matt must be vetoed: ${names.join(",")}`);
  assert.ok(!names.includes("business-flow"), `business-flow must be vetoed: ${names.join(",")}`);
});

test("notForUnless exception: Matt advised on the QT business flow does not veto ask-matt or business-flow", () => {
  const results = rank("Matt advised me on the QT business flow for promo code");
  const byName: Record<string, number> = {};
  for (const r of results) byName[r.name] = r.score;
  const names = Object.keys(byName);
  assert.ok(names.includes("ask-matt"), `ask-matt must not be vetoed: ${names.join(",")}`);
  assert.ok(names.includes("business-flow"), `business-flow must not be vetoed: ${names.join(",")}`);
  assert.ok(byName["ask-matt"]! > 0, `ask-matt score must be > 0, got ${byName["ask-matt"]}`);
  assert.ok(byName["business-flow"]! > 0, `business-flow score must be > 0, got ${byName["business-flow"]}`);
});

test("notFor veto: trivial typo fix keeps egm-review-loop out of scored candidates", () => {
  const results = rank("trivial typo fix in readme");
  assert.ok(!results.map((r) => r.name).includes("egm-review-loop"), `egm-review-loop must be vetoed: ${results.map((r) => r.name).join(",")}`);
});

test("notFor veto: single-line question keeps omp-superagent out of scored candidates", () => {
  const results = rank("single-line question about router");
  assert.ok(!results.map((r) => r.name).includes("omp-superagent"), `omp-superagent must be vetoed: ${results.map((r) => r.name).join(",")}`);
});

test("notFor veto: pure q&a explain only keeps karpathy-guidelines out of scored candidates", () => {
  const results = rank("pure q&a explain only");
  assert.ok(!results.map((r) => r.name).includes("karpathy-guidelines"), `karpathy-guidelines must be vetoed: ${results.map((r) => r.name).join(",")}`);
});
