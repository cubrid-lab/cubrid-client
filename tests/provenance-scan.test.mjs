// Controls for the similarity scan of scripts/check-provenance.mjs (#295,
// docs/PROVENANCE.md). Offline: the controls use this repository's own source,
// so no upstream code is needed or stored here.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import {
  bundledModules,
  findRuns,
  reviewedEntry,
  runHash,
  tokenize,
} from "../scripts/check-provenance.mjs";

const source = readFileSync(new URL("../src/protocol/packet-writer.ts", import.meta.url), "utf8");
const toJs = (text) =>
  ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
const file = (name, text) => ({ name, tokens: tokenize(text, name) });
const longest = (runs) => Math.max(0, ...runs.map((r) => r.tokens));

const srcFiles = (dir = new URL("../src/", import.meta.url)) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? srcFiles(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)],
  );
const raw = (text, name) => tokenize(text, name).map((t) => t.raw);

// Files the compiler rewrites beyond erasing types: enums become functions,
// constructor parameter properties become fields and assignments. Their
// tokens differ from the compiler's by design; the list must match the code.
const REWRITTEN = [
  "adapters/native.ts",
  "adapters/stream-cursor.ts",
  "client/client.ts",
  "client/pool.ts",
  "client/transaction.ts",
  "errors/read-timeout-error.ts",
  "protocol/constants.ts",
  "protocol/frame-reader.ts",
  "protocol/packet-reader.ts",
  "protocol/protocol.ts",
];

test("every src/ file tokenizes as its compiler output", () => {
  const rewritten = [];
  for (const url of srcFiles()) {
    const name = url.pathname.replace(/.*\/src\//, "");
    const text = readFileSync(url, "utf8");
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    let rewrite = false;
    const visit = (node) => {
      if (ts.isEnumDeclaration(node) || ts.isParameterPropertyDeclaration(node, node.parent)) {
        rewrite = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (rewrite) {
      rewritten.push(name);
      continue;
    }
    let compiled = raw(toJs(text), "x.js");
    // A file of types alone compiles to `export {};`.
    if (raw(text, name).length === 0)
      compiled = compiled.join(" ") === "export { } ;" ? [] : compiled;
    assert.deepEqual(raw(text, name), compiled, name);
  }
  assert.deepEqual(rewritten.sort(), REWRITTEN);
});

test("TypeScript-only syntax is dropped as the compiler drops it", () => {
  const cases = [
    "class A extends B<T> implements C { private x?: number; f<U>(a: U, b?: string): void { g(a as any)!; } }",
    "import { a, type B, c, type D, } from 'm'; export { type B };",
    "function f(a: string): void; function f(a: number): void; function f(a) { return (a as X)[0] + (<Y>a).b + (a satisfies Z).c; }",
    "class K { declare x: number; y = 1; m(): void; m() {} } declare const q: number; declare function r(): void;",
  ];
  for (const snippet of cases) {
    assert.deepEqual(raw(snippet, "x.ts"), raw(toJs(snippet), "x.js"), snippet);
  }
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

test("the pack check reads which modules esbuild bundled", () => {
  const code =
    "// src/index.ts\nvar a = 1;\n// vendor/pad.js\n// node_modules/x/index.mjs\n// not a marker\n";
  assert.deepEqual(bundledModules(code), [
    "src/index.ts",
    "vendor/pad.js",
    "node_modules/x/index.mjs",
  ]);
  for (const built of ["index.js", "index.cjs"]) {
    const path = new URL(`../dist/${built}`, import.meta.url);
    if (!existsSync(path)) continue; // npm test may run before the build
    const modules = bundledModules(readFileSync(path, "utf8"));
    assert.ok(modules.length > 0, built);
    for (const module of modules) assert.match(module, /^src\/(?!.*node_modules)/, built);
  }
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
