/**
 * Offline checks of the JDBC parity comparator (#118). The live comparison
 * itself is `npm run test:jdbc-parity`; these make sure it cannot pass by
 * classifying nothing or by hiding a difference.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compare } from "./jdbc-parity/compare.js";
import {
  type CaseResult,
  type CaseSpec,
  type Corpus,
  normalize,
  type RunnerOutput,
  rep,
} from "./jdbc-parity/ts-runner.js";

const representations: Corpus["representations"] = {
  equivalent: [
    ["Integer", "number"],
    ["null", "null"],
  ],
  intentional: [{ jdbc: "Long", ts: "bigint", reason: "64-bit" }],
};

function output(runner: "jdbc" | "ts", cases: CaseResult[]): RunnerOutput {
  return { runner, driverVersion: "x", serverVersion: "11.4", runtime: "x", cases };
}

function rows(values: string[], reps: string[]): CaseResult {
  return {
    id: "c",
    status: "ran",
    steps: [{ columns: values.map((_, i) => `c${i}`), rows: [values], reps: [reps] }],
  };
}

function run(spec: Partial<CaseSpec>, jdbc: CaseResult, ts: CaseResult) {
  const corpus: Corpus = {
    representations,
    cases: [{ id: "c", area: "a", steps: [{ op: "query", sql: "SELECT 1" }], ...spec }],
  };
  return compare(corpus, output("jdbc", [jdbc]), output("ts", [ts]));
}

test("equal values with equivalent representations are equivalent", () => {
  const report = run({}, rows(["1"], ["Integer"]), rows(["1"], ["number"]));
  assert.equal(report.cases[0]?.classification, "equivalent");
  assert.equal(report.ok, true);
});

test("an intentional representation is listed with its reason", () => {
  const report = run({}, rows(["1"], ["Long"]), rows(["1"], ["bigint"]));
  assert.equal(report.cases[0]?.classification, "intentional-node-representation");
  assert.match(report.cases[0]?.reasons[0] ?? "", /Long -> bigint: 64-bit/);
  assert.equal(report.ok, true);
});

test("an unlisted representation is a defect even when the text is equal", () => {
  const report = run({}, rows(["1"], ["Integer"]), rows(["1"], ["string"]));
  assert.equal(report.cases[0]?.classification, "defect");
  assert.equal(report.ok, false);
});

test("an undeclared value difference fails the run", () => {
  const report = run({}, rows(["1"], ["Integer"]), rows(["2"], ["number"]));
  assert.equal(report.cases[0]?.classification, "defect");
  assert.equal(report.counts.unexpected, 1);
  assert.equal(report.ok, false);
});

test("error codes are compared, a missing error is a difference", () => {
  const err = (error: number | null): CaseResult => ({
    id: "c",
    status: "ran",
    steps: [{ error }],
  });
  assert.equal(run({}, err(-493), err(-493)).ok, true);
  assert.equal(run({}, err(-493), err(-494)).ok, false);
  assert.equal(run({}, err(-493), rows(["1"], ["number"])).ok, false);
});

test("a recorded defect stays a defect but only covers its declared steps", () => {
  const declared = { expectedDefect: { issue: null, reason: "r", steps: [1] } };
  const report = run(declared, rows(["a"], ["Integer"]), rows(["b"], ["number"]));
  assert.equal(report.cases[0]?.classification, "defect");
  assert.equal(report.ok, true);
  assert.match(report.cases[0]?.warnings.join() ?? "", /no issue yet/);

  const elsewhere = { expectedDefect: { issue: null, reason: "r", steps: [2] } };
  assert.equal(run(elsewhere, rows(["a"], ["Integer"]), rows(["b"], ["number"])).ok, false);
});

test("a known limitation is classified with its issue", () => {
  const declared = { knownLimitation: { issue: "#1", reason: "r" } };
  const report = run(declared, rows(["a"], ["Integer"]), rows(["b"], ["number"]));
  assert.equal(report.cases[0]?.classification, "known-limitation");
  assert.equal(report.ok, true);
  const stale = run(declared, rows(["a"], ["Integer"]), rows(["a"], ["number"]));
  assert.equal(stale.cases[0]?.classification, "equivalent");
  assert.match(stale.cases[0]?.warnings.join() ?? "", /did not reproduce/);
});

test("a runner failure or a missing case fails the run", () => {
  const failed: CaseResult = { id: "c", status: "failed", failure: "boom" };
  assert.equal(run({}, failed, rows(["1"], ["number"])).ok, false);
  const corpus: Corpus = { representations, cases: [{ id: "c", area: "a", steps: [] }] };
  assert.equal(compare(corpus, output("jdbc", []), output("ts", [])).ok, false);
});

test("zero executed cases never passes", () => {
  const skipped: CaseResult = { id: "c", status: "skipped" };
  const report = run({ unverified: "needs fault injection" }, skipped, skipped);
  assert.equal(report.counts.unverified, 1);
  assert.equal(report.counts.executed, 0);
  assert.equal(report.ok, false);
});

test("TypeScript values normalize like JdbcRunner.java", () => {
  assert.equal(normalize(3, "DOUBLE"), "3");
  assert.equal(normalize(-0, "DOUBLE"), "0");
  assert.equal(normalize(0.1, "DOUBLE"), "f64:3fb999999999999a");
  assert.equal(normalize(9007199254740993n, "BIGINT"), "9007199254740993");
  assert.equal(normalize(Buffer.from([0, 255]), "VARBIT"), "0x00ff");
  const d = new Date(Date.UTC(1, 0, 1, 0, 0, 0, 5));
  d.setUTCFullYear(1);
  assert.equal(normalize(d, "DATE"), "0001-01-01");
  assert.equal(normalize(d, "DATETIME"), "0001-01-01 00:00:00.005");
  assert.equal(normalize(new Date(Date.UTC(1970, 0, 1, 23, 59, 58)), "TIME"), "23:59:58");
  assert.deepEqual(normalize([1, null, [2n]], "INT"), ["1", null, ["2"]]);
  assert.deepEqual(rep([1, null]), ["Array", "number", "null"]);
});

test("the committed corpus is well formed", () => {
  const corpus = JSON.parse(
    readFileSync(new URL("./jdbc-parity/corpus.json", import.meta.url), "utf8"),
  ) as Corpus;
  const ids = corpus.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of corpus.cases) {
    assert.ok(c.unverified !== undefined || (c.steps?.length ?? 0) > 0, c.id);
  }
  assert.ok(corpus.cases.filter((c) => c.unverified === undefined).length >= 30);
});
