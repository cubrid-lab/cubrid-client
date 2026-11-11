import assert from "node:assert/strict";
import test from "node:test";
import { checkNpmVersion } from "../scripts/verify-npm-version.mjs";

test("exact npm version is accepted, without trusting the latest dist-tag", () => {
  const stub = (bin, args, options) => {
    assert.equal(bin, "npm");
    assert.deepEqual(args, [
      "view",
      "cubrid-client@1.2.0",
      "version",
      "--json",
      "--fetch-retries=0",
      "--registry=https://registry.npmjs.org/",
    ]);
    assert.equal(options.timeout, 30000);
    return { status: 0, stdout: '"1.2.0"\n', stderr: "" };
  };
  assert.equal(checkNpmVersion("1.2.0", stub).status, "published");
});

test("GitHub-only version absent from npm blocks progression", () => {
  const stub = () => ({ status: 1, stdout: "", stderr: "npm error code E404" });
  assert.equal(checkNpmVersion("1.2.0", stub).status, "missing");
});

test("registry unavailability is not mistaken for success", () => {
  const stub = () => ({ status: 1, stdout: "", stderr: "npm error code ECONNRESET" });
  assert.equal(checkNpmVersion("1.2.0", stub).status, "unavailable");
});

test("unexpected successful response is not a matching publication", () => {
  const stub = () => ({ status: 0, stdout: '"1.1.0"', stderr: "" });
  assert.equal(checkNpmVersion("1.2.0", stub).status, "missing");
});

test("invalid JSON and process errors fail closed", () => {
  assert.equal(
    checkNpmVersion("1.2.0", () => ({ status: 0, stdout: "bad" })).status,
    "unavailable",
  );
  assert.equal(
    checkNpmVersion("1.2.0", () => ({ error: new Error("DNS lookup failed") })).status,
    "unavailable",
  );
});

test("untrusted version syntax cannot be passed to npm", () => {
  assert.throws(() => checkNpmVersion("1.2.0; echo owned"), TypeError);
});
