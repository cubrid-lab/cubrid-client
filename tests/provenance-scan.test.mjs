// Controls for the similarity scan of scripts/check-provenance.mjs (#295,
// docs/PROVENANCE.md). Offline: the controls use this repository's own source,
// so no upstream code is needed or stored here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { findRuns, reviewedEntry, runHash, tokenize } from "../scripts/check-provenance.mjs";

const source = readFileSync(new URL("../src/protocol/packet-writer.ts", import.meta.url), "utf8");
const toJs = (text) =>
  ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
const file = (name, text) => ({ name, tokens: tokenize(text, name) });
const longest = (runs) => Math.max(0, ...runs.map((r) => r.tokens));

test("TypeScript-only syntax is dropped as the compiler drops it", () => {
  const ours = tokenize(source, "packet-writer.ts").map((t) => t.raw);
  const compiled = tokenize(toJs(source), "packet-writer.js").map((t) => t.raw);
  assert.deepEqual(ours, compiled);
  const snippet =
    "class A extends B<T> implements C { private x?: number; f<U>(a: U, b?: string): void { g(a as any)!; } }";
  assert.equal(
    tokenize(snippet)
      .map((t) => t.raw)
      .join(" "),
    "class A extends B { x ; f ( a , b ) { g ( a ) ; } }",
  );
});

test("a compiled, renamed copy of a source file is found as one long run", () => {
  const renamed = toJs(source)
    .replace(/PacketWriter/g, "Encoder")
    .replace(/\bwrite(Int|Byte|Short|Bytes)\b/g, "put$1")
    .replace(/\boffset\b/g, "pos");
  const ours = [file("src/protocol/packet-writer.ts", source)];
  assert.ok(longest(findRuns(ours, [file("copy.js", toJs(source))], "raw", 25)) > 200);
  assert.ok(longest(findRuns(ours, [file("renamed.js", renamed)], "norm", 50)) > 200);
});

test("a reviewed hit survives moved code and fails when changed or longer", () => {
  const ours = [file("src/x.ts", source)];
  const theirs = [file("copy.js", toJs(source))];
  const [run] = findRuns(ours, theirs, "raw", 25);
  const entry = { file: run.file, field: run.field, sha256: run.sha256, tokens: run.tokens };
  const moved = findRuns([file("src/x.ts", `\n\n${source}`)], theirs, "raw", 25)[0];
  assert.ok(reviewedEntry([entry], moved));
  assert.equal(reviewedEntry([{ ...entry, tokens: run.tokens - 1 }], run), undefined);
  assert.equal(
    reviewedEntry([{ ...entry, sha256: runHash("norm", ours[0].tokens) }], run),
    undefined,
  );
});

test("every reviewed entry is complete", () => {
  const reviewed = JSON.parse(
    readFileSync(new URL("../scripts/provenance-reviewed.json", import.meta.url), "utf8"),
  );
  for (const e of reviewed.entries) {
    assert.match(e.file, /^src\/.+\.ts$/);
    assert.ok(e.field === "raw" || e.field === "norm");
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(e.tokens) && e.tokens > 0);
    assert.ok(e.where && e.upstream && e.category && e.reason);
  }
});
