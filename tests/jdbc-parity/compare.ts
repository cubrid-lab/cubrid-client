/**
 * Classifies each corpus case from the JDBC and TypeScript runner outputs.
 *
 * - `equivalent`: the same values, row counts, error codes and side effects,
 *   carried by representations listed as equivalent in corpus.json.
 * - `intentional-node-representation`: the same values, but at least one value
 *   is carried by a representation listed as intentional, with its reason.
 * - `known-limitation`: values differ, and the case declares `knownLimitation`
 *   with the local issue.
 * - `defect`: values differ without a declaration, or a representation pair is
 *   in neither table. A verified defect recorded as `expectedDefect` (not fixed
 *   by this comparison) keeps this classification but does not fail the run.
 * - `unverified`: the case declares why it is not run.
 *
 * A declaration with `steps` covers only differences in those steps. A runner
 * failure, a missing case, a step count mismatch, an undeclared difference or
 * zero executed cases makes the comparison fail. Nothing is
 * dropped: every difference is listed in the report.
 */
import { isDeepStrictEqual } from "node:util";
import type { Corpus, Rep, RunnerOutput, StepResult } from "./ts-runner.js";

export type Classification =
  | "equivalent"
  | "intentional-node-representation"
  | "known-limitation"
  | "defect"
  | "unverified";

export interface CaseReport {
  id: string;
  area: string;
  classification: Classification;
  /** True when this case makes the run fail. */
  unexpected: boolean;
  differences: string[];
  reasons: string[];
  warnings: string[];
}

export interface ComparisonReport {
  cases: CaseReport[];
  counts: Record<Classification | "total" | "executed" | "unexpected", number>;
  ok: boolean;
}

function repName(r: Rep): string {
  return Array.isArray(r) ? (r[0] as string) : r;
}

/** Pairs each JDBC representation with the TypeScript one at the same position. */
function pairReps(j: Rep, t: Rep, out: Array<[string, string]>): void {
  out.push([repName(j), repName(t)]);
  if (Array.isArray(j) && Array.isArray(t) && j.length === t.length) {
    for (let i = 1; i < j.length; i++) pairReps(j[i] as Rep, t[i] as Rep, out);
  }
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function compareStep(
  index: number,
  j: StepResult,
  t: StepResult,
  pairs: Array<[string, string]>,
): string[] {
  const at = `step ${index + 1}`;
  if ("error" in j || "error" in t) {
    const je = "error" in j ? j.error : "no error";
    const te = "error" in t ? t.error : "no error";
    if (je === te) return [];
    return [`${at}: JDBC ${describe("error" in j ? { error: je } : j)}, TS ${describe(t)}`];
  }
  if ("rows" in j && "rows" in t) {
    const diffs: string[] = [];
    if (!isDeepStrictEqual(j.columns, t.columns)) {
      diffs.push(`${at}: columns JDBC ${describe(j.columns)}, TS ${describe(t.columns)}`);
    }
    if (!isDeepStrictEqual(j.rows, t.rows)) {
      diffs.push(`${at}: rows JDBC ${describe(j.rows)}, TS ${describe(t.rows)}`);
    }
    j.reps.forEach((row, r) => {
      row.forEach((rep, c) => {
        const other = t.reps[r]?.[c];
        if (other !== undefined) pairReps(rep, other, pairs);
      });
    });
    return diffs;
  }
  if ("sha256" in j && "sha256" in t) {
    const diffs: string[] = [];
    if (!isDeepStrictEqual(j.columns, t.columns)) {
      diffs.push(`${at}: columns JDBC ${describe(j.columns)}, TS ${describe(t.columns)}`);
    }
    if (j.count !== t.count) diffs.push(`${at}: row count JDBC ${j.count}, TS ${t.count}`);
    if (j.sha256 !== t.sha256) diffs.push(`${at}: row checksum JDBC ${j.sha256}, TS ${t.sha256}`);
    j.columnReps.forEach((set, c) => {
      for (const jr of set) {
        for (const tr of t.columnReps[c] ?? []) {
          pairReps(JSON.parse(jr) as Rep, JSON.parse(tr) as Rep, pairs);
        }
      }
    });
    return diffs;
  }
  if (isDeepStrictEqual(j, t)) return [];
  return [`${at}: JDBC ${describe(j)}, TS ${describe(t)}`];
}

export function compare(corpus: Corpus, jdbc: RunnerOutput, ts: RunnerOutput): ComparisonReport {
  const equivalent = new Set(corpus.representations.equivalent.map(([j, t]) => `${j}|${t}`));
  const intentional = new Map(
    corpus.representations.intentional.map((e) => [`${e.jdbc}|${e.ts}`, e.reason]),
  );
  const byId = (out: RunnerOutput) => new Map(out.cases.map((c) => [c.id, c]));
  const jCases = byId(jdbc);
  const tCases = byId(ts);
  const cases: CaseReport[] = [];

  for (const spec of corpus.cases) {
    const report: CaseReport = {
      id: spec.id,
      area: spec.area,
      classification: "equivalent",
      unexpected: false,
      differences: [],
      reasons: [],
      warnings: [],
    };
    cases.push(report);
    const j = jCases.get(spec.id);
    const t = tCases.get(spec.id);

    if (spec.unverified !== undefined) {
      report.classification = "unverified";
      report.reasons.push(spec.unverified);
      if (j?.status !== "skipped" || t?.status !== "skipped") {
        report.unexpected = true;
        report.differences.push("an unverified case was not skipped by both runners");
      }
      continue;
    }
    if (!j || !t || j.status !== "ran" || t.status !== "ran") {
      report.classification = "unverified";
      report.unexpected = true;
      report.differences.push(
        `runner did not complete the case: JDBC ${j ? `${j.status} ${j.failure ?? ""}` : "missing"}; ` +
          `TS ${t ? `${t.status} ${t.failure ?? ""}` : "missing"}`,
      );
      continue;
    }

    const jSteps = j.steps ?? [];
    const tSteps = t.steps ?? [];
    const pairs: Array<[string, string]> = [];
    if (jSteps.length !== tSteps.length || jSteps.length !== (spec.steps ?? []).length) {
      report.differences.push(`step count JDBC ${jSteps.length}, TS ${tSteps.length}`);
    } else {
      for (const [i, js] of jSteps.entries()) {
        report.differences.push(...compareStep(i, js, tSteps[i] as StepResult, pairs));
      }
    }

    const unknownPairs = new Set<string>();
    const reasons = new Set<string>();
    for (const [jr, tr] of pairs) {
      const key = `${jr}|${tr}`;
      if (equivalent.has(key)) continue;
      const reason = intentional.get(key);
      if (reason !== undefined) reasons.add(`${jr} -> ${tr}: ${reason}`);
      else unknownPairs.add(key);
    }
    report.reasons.push(...reasons);
    for (const key of unknownPairs) {
      const [jr, tr] = key.split("|");
      report.differences.push(`representation JDBC ${jr}, TS ${tr} is in neither table`);
    }

    const declaration = spec.knownLimitation ?? spec.expectedDefect;
    const label = spec.knownLimitation
      ? `known limitation ${spec.knownLimitation.issue}`
      : `recorded defect ${spec.expectedDefect?.issue ?? "(no issue yet)"}`;
    if (report.differences.length > 0) {
      const covered = (d: string) => {
        const step = /^step (\d+):/.exec(d)?.[1];
        return (
          declaration?.steps === undefined ||
          (step !== undefined && declaration.steps.includes(Number(step)))
        );
      };
      report.classification = spec.knownLimitation ? "known-limitation" : "defect";
      if (declaration) report.reasons.unshift(`${label}: ${declaration.reason}`);
      if (!declaration || !report.differences.every(covered)) report.unexpected = true;
      if (spec.expectedDefect && spec.expectedDefect.issue === null) {
        report.warnings.push("recorded defect has no issue yet");
      }
    } else {
      if (declaration) report.warnings.push(`${label} did not reproduce on this server`);
      report.classification = reasons.size > 0 ? "intentional-node-representation" : "equivalent";
    }
  }

  const counts = {
    total: cases.length,
    executed: cases.filter((c) => c.classification !== "unverified").length,
    equivalent: 0,
    "intentional-node-representation": 0,
    "known-limitation": 0,
    defect: 0,
    unverified: 0,
    unexpected: cases.filter((c) => c.unexpected).length,
  };
  for (const c of cases) counts[c.classification]++;
  return { cases, counts, ok: counts.unexpected === 0 && counts.executed > 0 };
}
