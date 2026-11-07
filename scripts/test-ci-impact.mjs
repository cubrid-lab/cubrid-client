import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "./ci-impact.mjs";

const fixtures = [
  ["README only", ["M\tREADME.md"], false, true],
  ["release notes", ["M\tCHANGELOG.md", "A\tdocs/releases/v1.1.0.md"], false, true],
  ["release format verifier", ["M\tscripts/verify-release-notes.mjs"], false, true],
  ["docs illustration", ["A\tdocs/images/architecture.svg"], false, true],
  ["TypeScript source", ["M\tsrc/client.ts"], true, false],
  ["TypeScript under docs is executable", ["M\tdocs/examples/connection.ts"], true, false],
  ["test fixture", ["M\ttests/integration.test.ts"], true, false],
  ["dependency manifest", ["M\tpackage-lock.json"], true, false],
  ["CI workflow self-change", ["M\t.github/workflows/ci.yml"], true, false],
  ["other release workflow", ["M\t.github/workflows/publish.yml"], true, false],
  ["unknown file", ["M\tconfig/unknown.magic"], true, false],
  ["mixed docs and runtime", ["M\tREADME.md", "M\tsrc/index.ts"], true, true],
  ["rename from runtime to docs", ["D\tsrc/removed.ts", "A\tdocs/removed.md"], true, true],
  ["deleted documentation requires full CI", ["D\tdocs/removed.md"], true, true],
  ["docs-only rename requires full CI", ["D\tdocs/old.md", "A\tdocs/new.md"], true, true],
  ["unexpected git change status fails closed", ["R100\tdocs/old.md\tdocs/new.md"], true, true],
  ["missing status fails closed", ["README.md"], true, true],
  ["added docs stay lightweight", ["A\tdocs/new.md"], false, true],
];
for (const [name, paths, runtime, docs] of fixtures) {
  test(name, () => {
    const scope = classify("pull_request", paths);
    assert.equal(scope.runtime, runtime);
    assert.equal(scope.docs, docs);
  });
}
test("missing diff fails closed", () => {
  assert.deepEqual(
    { runtime: classify("pull_request", []).runtime, docs: classify("pull_request", []).docs },
    { runtime: true, docs: true },
  );
});
test("push to main always runs full matrix", () => {
  assert.equal(classify("push", ["README.md"]).runtime, true);
});
