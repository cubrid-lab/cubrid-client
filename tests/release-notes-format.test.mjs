import assert from "node:assert/strict";
import test from "node:test";
import { validateCuratedNote } from "../scripts/release-notes-format.mjs";

const sample = [
  "## v1.2.0 (2026-11-07)", "", "Selected CUBRID driver corrections.", "",
  "### Upgrade notes", "", "- Node.js 18 remains supported.", "",
  "### Bug Fixes", "",
  "- Correct a wire type ([#126](https://github.com/cubrid-lab/cubrid-client/pull/126)) by @yeongseon", "",
  "**Full Changelog:** [v1.1.0...v1.2.0](https://github.com/cubrid-lab/cubrid-client/compare/v1.1.0...v1.2.0)", "",
].join("\n");

test("accepts verified concise historic notes", () => {
  assert.deepEqual(validateCuratedNote("1.2.0", sample), []);
});
test("rejects missing contributor credits", () => {
  assert.match(validateCuratedNote("1.2.0", sample.replace(" by @yeongseon", "")).join(" "), /credited author/);
});
test("rejects duplicated PRs and outdated organization", () => {
  assert.match(validateCuratedNote("1.2.0", sample.replace("### Bug Fixes", "### Bug Fixes\n\n- Other ([#126](https://github.com/cubrid-lab/cubrid-client/pull/126)) by @yeongseon")).join(" "), /Repeated/);
  assert.match(validateCuratedNote("1.2.0", sample.replaceAll("cubrid-lab/cubrid-client", "cubrid-labs/cubrid-client")).join(" "), /Outdated/);
});
test("allows only the inline first-contribution celebration", () => {
  assert.deepEqual(validateCuratedNote("1.2.0", sample.replace(" by @yeongseon", " by @yeongseon (first contribution 🎉)")), []);
  assert.match(validateCuratedNote("1.2.0", sample.replace("wire type", "wire type 🎉")).join(" "), /Decorative/);
});
test("rejects a hard-wrapped bullet", () => {
  assert.match(validateCuratedNote("1.2.0", sample.replace(" by @yeongseon", " by @yeongseon\n  continued")).join(" "), /Hard-wrapped/);
});
test("allows first version without an earlier compare tag", () => {
  const initial = ["## v0.1.0 (2026-03-13)", "", "Initial API.", "",
    "### Features", "", "- Add a Promise-based client by @yeongseon", "",
    "**Full Changelog:** [v0.1.0 commits](https://github.com/cubrid-lab/cubrid-client/commits/v0.1.0)"].join("\n");
  assert.deepEqual(validateCuratedNote("0.1.0", initial), []);
});
test("rejects an incorrect comparison and wrong section ordering", () => {
  assert.match(validateCuratedNote("1.2.0", sample.replace("v1.1.0...v1.2.0", "v1.0.0...v1.2.0")).join(" "), /Full Changelog/);
  assert.match(validateCuratedNote("1.2.0", sample.replace("### Upgrade notes", "### Features\n\n- Test by @yeongseon\n\n### Upgrade notes")).join(" "), /Upgrade notes/);
});

test("newly released versions are accepted without hardcoded version changes", () => {
  const next = sample
    .replaceAll("v1.2.0", "v1.4.0")
    .replaceAll("v1.1.0", "v1.3.0")
    .replaceAll("2026-11-07", "2026-12-01");
  const versions = ["0.1.0", "0.2.0", "1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"];
  assert.deepEqual(validateCuratedNote("1.4.0", next, versions), []);
});
