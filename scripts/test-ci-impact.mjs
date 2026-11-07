import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "./ci-impact.mjs";

const fixtures = [
  ["README only", ["README.md"], false, true],
  ["release notes", ["CHANGELOG.md", "docs/releases/v1.1.0.md"], false, true],
  ["release format verifier", ["scripts/verify-release-notes.mjs"], false, true],
  ["docs illustration", ["docs/images/architecture.svg"], false, true],
  ["TypeScript source", ["src/client.ts"], true, false],
  ["TypeScript under docs is executable", ["docs/examples/connection.ts"], true, false],
  ["test fixture", ["tests/integration.test.ts"], true, false],
  ["dependency manifest", ["package-lock.json"], true, false],
  ["CI workflow self-change", [".github/workflows/ci.yml"], true, false],
  ["other release workflow", [".github/workflows/publish.yml"], true, false],
  ["unknown file", ["config/unknown.magic"], true, false],
  ["mixed docs and runtime", ["README.md", "src/index.ts"], true, true],
  ["rename from runtime to docs", ["src/removed.ts", "docs/removed.md"], true, true],
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
