// Provenance and distribution checks (#295, docs/PROVENANCE.md).
//
// Usage:
//   node scripts/check-provenance.mjs pack
//     Packs the built package (run `npm run build` first) with `npm pack` and
//     checks what would be published, network-free: only package.json,
//     README.md, LICENSE and dist/index.{js,cjs,d.ts,d.cts} (plus
//     THIRD_PARTY_NOTICES.md when the repository has one); LICENSE is the MIT
//     text; no runtime, peer, optional or bundled dependencies; dist imports
//     Node built-ins only; dist carries no third-party license comment; any
//     source map lists only files under src/.
//
//   node scripts/check-provenance.mjs similarity [--node-cubrid=<version>]...
//       [--upstream=<dir>]... [--rev=<git rev>] [--min-raw=<tokens>]
//       [--min-normalized=<tokens>] [--reviewed=<file>|none] [--verbose] [--emit]
//     Compares src/**/*.ts with upstream source and prints every run of
//     identical tokens at least --min-raw tokens long (default 25) and every
//     run of the same token shape (identifiers, strings and numbers
//     normalised) at least --min-normalized tokens long (default 50).
//     Comments, whitespace and TypeScript-only syntax (type annotations,
//     interfaces, type aliases, modifiers) never count, so TypeScript is
//     compared with JavaScript as the JavaScript it compiles to.
//     Each --node-cubrid downloads that node-cubrid release with `npm pack`
//     (network); each --upstream reads .js/.cjs/.mjs/.ts files from a
//     directory (parsed) and .java/.c/.h/.cpp files (lexed: weak evidence
//     across languages). Defaults to --node-cubrid=11.0.0. --rev compares the
//     src/ tree of a past commit instead of the working tree.
//     Hits are leads for a manual review, not findings. A hit recorded in
//     scripts/provenance-reviewed.json (file, comparison, sha256 of its tokens,
//     length) was reviewed and is only counted; every other hit fails (exit 1)
//     until it is reviewed and recorded there and in docs/PROVENANCE.md.
//     --emit prints the unreviewed hits as entry skeletons; --verbose lists the
//     reviewed ones.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOTICES = "THIRD_PARTY_NOTICES.md";
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  ...(existsSync(join(REPO, NOTICES)) ? [NOTICES] : []),
  "dist/index.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/index.d.cts",
];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

function walk(dir, filter, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".git") walk(path, filter, out);
    } else if (filter(path)) out.push(path);
  }
  return out;
}

const posix = (path) => path.split(sep).join("/");

function packInto(cwd, spec, dest) {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", ...(spec ? [spec] : []), "--ignore-scripts", "--json", "--pack-destination", dest],
      { cwd, encoding: "utf8" },
    ),
  );
  execFileSync("tar", ["-xzf", join(dest, packed.filename), "-C", dest]);
  return join(dest, "package");
}

function checkPack() {
  const problems = [];
  const tmp = mkdtempSync(join(tmpdir(), "provenance-"));
  try {
    const pkg = packInto(REPO, null, tmp);
    const files = walk(pkg, () => true).map((f) => posix(relative(pkg, f)));
    for (const file of REQUIRED) {
      if (!files.includes(file)) problems.push(`missing from the package: ${file}`);
    }
    for (const file of files) {
      if (!REQUIRED.includes(file) && !/^dist\/index\.c?js\.map$/.test(file)) {
        problems.push(`unexpected file in the package: ${file}`);
      }
    }
    const license = readFileSync(join(pkg, "LICENSE"), "utf8");
    if (!license.startsWith("MIT License") || !/^Copyright \(c\) \d{4} \S/m.test(license)) {
      problems.push("LICENSE is not the MIT license text with a copyright line");
    }
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    if (manifest.license !== "MIT") problems.push(`package.json license is ${manifest.license}`);
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
      "bundleDependencies",
      "bundledDependencies",
    ]) {
      const value = manifest[field];
      if (value && (Array.isArray(value) ? value.length : Object.keys(value).length)) {
        problems.push(
          `package.json ${field} is not empty: the package has no runtime dependencies`,
        );
      }
    }
    for (const file of files.filter((f) => /\.(?:c?js|d\.c?ts)$/.test(f))) {
      const code = readFileSync(join(pkg, file), "utf8");
      const specifiers = [
        ...code.matchAll(/\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g),
      ].map((m) => m[1]);
      for (const spec of new Set(specifiers)) {
        if (!BUILTINS.has(spec)) problems.push(`${file}: imports ${spec}, not a Node built-in`);
      }
      // esbuild keeps /*! */ and @license comments: a bundled third-party
      // file would bring its notice; this repository's source has none.
      if (/\/\*!|@license|@preserve|Copyright \(c\)|SPDX-License-Identifier/i.test(code)) {
        problems.push(`${file}: contains a license or copyright comment; check what was bundled`);
      }
    }
    for (const file of files.filter((f) => f.endsWith(".map"))) {
      const map = JSON.parse(readFileSync(join(pkg, file), "utf8"));
      for (const source of map.sources ?? []) {
        const resolved = posix(normalize(join(dirname(file), source)));
        if (!resolved.startsWith("src/") || resolved.includes("node_modules")) {
          problems.push(`${file}: bundles ${source}, which is not repository source`);
        }
      }
    }
    console.log(`packed ${manifest.name}@${manifest.version}: ${files.length} files`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return problems;
}

const TS_ONLY_KEYWORDS = new Set([
  ts.SyntaxKind.PublicKeyword,
  ts.SyntaxKind.PrivateKeyword,
  ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.ReadonlyKeyword,
  ts.SyntaxKind.DeclareKeyword,
  ts.SyntaxKind.AbstractKeyword,
  ts.SyntaxKind.OverrideKeyword,
]);

/** A node that only exists in TypeScript and is erased when compiling to JavaScript. */
function typeOnly(node) {
  return (
    ts.isTypeNode(node) ||
    ts.isTypeParameterDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) ||
    ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && node.isTypeOnly) ||
    ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      (node.isTypeOnly || node.importClause?.isTypeOnly)) ||
    TS_ONLY_KEYWORDS.has(node.kind)
  );
}

/** Leaf token of a raw/normalised pair; strings compare by value, not quote style. */
function leaf(node, sf) {
  const kind = node.kind;
  let raw = node.getText(sf);
  let norm = raw;
  if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier) norm = "I";
  else if (
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    raw = JSON.stringify(node.text);
    norm = "S";
  } else if (kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral) {
    norm = "N";
  } else if (kind >= ts.SyntaxKind.TemplateHead && kind <= ts.SyntaxKind.TemplateTail) norm = "T";
  else if (kind === ts.SyntaxKind.RegularExpressionLiteral) norm = "R";
  return { raw, norm, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 };
}

/**
 * Tokens of a TypeScript or JavaScript file with comments, whitespace and
 * TypeScript-only syntax removed: [{ raw, norm, line }]. The leaf tokens of
 * the parsed tree, so template literals and regular expressions are split as
 * the parser sees them. A type annotation's `:`, an `as`/`satisfies` cast, a
 * `?`/`!` before an annotation, type-argument brackets and the non-null `!`
 * are dropped with the type.
 */
export function tokenize(text, fileName = "x.ts") {
  const kind = /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const isTypeList = (n) =>
    n.kind === ts.SyntaxKind.SyntaxList &&
    n.getChildren(sf).length > 0 &&
    n
      .getChildren(sf)
      .every((c) => c.kind === ts.SyntaxKind.CommaToken || ts.isTypeNode(c) || typeOnly(c));
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(sf);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken && node.getText(sf) !== "") {
        out.push(leaf(node, sf));
      }
      return;
    }
    const skip = new Set();
    for (const [i, child] of children.entries()) {
      const prev = children[i - 1]?.kind;
      if (typeOnly(child) && !(ts.isTypeNode(child) && ts.isExpressionWithTypeArguments(child))) {
        skip.add(i);
        if (ts.isImportSpecifier(child) || ts.isExportSpecifier(child)) {
          // `{ a, type B }` compiles to `{ a }`: drop one adjacent comma.
          if (children[i + 1]?.kind === ts.SyntaxKind.CommaToken) skip.add(i + 1);
          else if (prev === ts.SyntaxKind.CommaToken) skip.add(i - 1);
        } else if (
          prev === ts.SyntaxKind.ColonToken ||
          prev === ts.SyntaxKind.AsKeyword ||
          prev === ts.SyntaxKind.SatisfiesKeyword
        ) {
          skip.add(i - 1);
          const before = children[i - 2]?.kind;
          if (
            prev === ts.SyntaxKind.ColonToken &&
            (before === ts.SyntaxKind.QuestionToken || before === ts.SyntaxKind.ExclamationToken) &&
            !ts.isConditionalExpression(node)
          ) {
            skip.add(i - 2);
          }
        }
      } else if (isTypeList(child) && prev === ts.SyntaxKind.LessThanToken) {
        skip
          .add(i - 1)
          .add(i)
          .add(i + 1);
      } else if (ts.isNonNullExpression(node) && child.kind === ts.SyntaxKind.ExclamationToken) {
        skip.add(i);
      } else if (
        child.kind === ts.SyntaxKind.CommaToken &&
        node.kind === ts.SyntaxKind.SyntaxList &&
        i === children.length - 1
      ) {
        // A trailing comma is formatting, not code.
        skip.add(i);
      }
    }
    for (const [i, child] of children.entries()) {
      if (!skip.has(i)) visit(child);
    }
  };
  visit(sf);
  return out;
}

/** Lexical tokens of a C, C++ or Java file (no parse tree; weak evidence across languages). */
export function lex(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const lineOf = (pos) => text.slice(0, pos).split("\n").length;
  const out = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    let raw = scanner.getTokenText();
    let norm = raw;
    if (kind === ts.SyntaxKind.Identifier || ts.isKeyword(kind)) {
      norm = ts.isKeyword(kind) ? raw : "I";
    } else if (kind === ts.SyntaxKind.StringLiteral) {
      raw = JSON.stringify(scanner.getTokenValue());
      norm = "S";
    } else if (kind === ts.SyntaxKind.NumericLiteral) norm = "N";
    out.push({ raw, norm, line: lineOf(scanner.getTokenStart()) });
  }
  return out;
}

const PARSED = /\.(?:[cm]?js|ts)$/;
const LEXED = /\.(?:java|c|h|cpp|hpp)$/;

function upstreamFromDir(dir, label = dir) {
  return walk(dir, (p) => (PARSED.test(p) && !p.endsWith(".d.ts")) || LEXED.test(p)).map((p) => {
    const text = readFileSync(p, "utf8");
    return {
      name: `${label}/${posix(relative(dir, p))}`,
      tokens: LEXED.test(p) ? lex(text) : tokenize(text, p),
    };
  });
}

function oursFromRev(rev) {
  const names = execFileSync("git", ["ls-tree", "-r", "--name-only", rev, "--", "src"], {
    cwd: REPO,
    encoding: "utf8",
  })
    .split("\n")
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts"));
  return names.map((name) => ({
    name,
    tokens: tokenize(
      execFileSync("git", ["show", `${rev}:${name}`], { cwd: REPO, encoding: "utf8" }),
      name,
    ),
  }));
}

/**
 * Runs of at least `min` equal tokens (`field` 'raw' or 'norm') between `ours`
 * and `theirs` ([{ name, tokens }]), the longest match at each position.
 */
export function findRuns(ours, theirs, field, min) {
  const K = Math.min(20, min);
  const index = new Map();
  for (const file of theirs) {
    for (let j = 0; j + K <= file.tokens.length; j++) {
      const key = file.tokens
        .slice(j, j + K)
        .map((t) => t[field])
        .join("\u0000");
      const list = index.get(key);
      if (!list) index.set(key, [[file, j]]);
      else if (list.length < 64) list.push([file, j]);
    }
  }
  const runs = [];
  for (const file of ours) {
    const tokens = file.tokens;
    let i = 0;
    while (i + K <= tokens.length) {
      const key = tokens
        .slice(i, i + K)
        .map((t) => t[field])
        .join("\u0000");
      let best = null;
      for (const [other, j] of index.get(key) ?? []) {
        let n = K;
        while (
          i + n < tokens.length &&
          j + n < other.tokens.length &&
          tokens[i + n][field] === other.tokens[j + n][field]
        )
          n++;
        if (!best || n > best.n) best = { other, j, n };
      }
      if (best && best.n >= min) {
        const run = tokens.slice(i, i + best.n);
        runs.push({
          file: file.name,
          field,
          sha256: runHash(field, run),
          start: tokens[i].line,
          end: tokens[i + best.n - 1].line,
          theirs: `${best.other.name}:${best.other.tokens[best.j].line}-${best.other.tokens[best.j + best.n - 1].line}`,
          tokens: best.n,
          text: run
            .slice(0, 30)
            .map((t) => t.raw)
            .join(" "),
        });
        i += best.n;
      } else i++;
    }
  }
  return runs;
}

/** SHA-256 of a run's tokens as compared (`field` 'raw' or 'norm'), independent of lines. */
export function runHash(field, tokens) {
  return createHash("sha256")
    .update(`${field}\u0000${tokens.map((t) => t[field]).join("\u0000")}`)
    .digest("hex");
}

/** The reviewed entry of a run: same file, comparison and token content, no longer than reviewed. */
export function reviewedEntry(entries, run) {
  return entries.find(
    (e) =>
      e.file === run.file &&
      e.field === run.field &&
      e.sha256 === run.sha256 &&
      run.tokens <= e.tokens,
  );
}

function checkSimilarity(argv) {
  const opt = (name, fallback) => {
    const flag = argv.find((a) => a.startsWith(`--${name}=`));
    return flag ? flag.slice(name.length + 3) : fallback;
  };
  const all = (name) =>
    argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
  const minRaw = Number(opt("min-raw", 25));
  const minNorm = Number(opt("min-normalized", 50));
  const reviewedPath = opt("reviewed", join(REPO, "scripts/provenance-reviewed.json"));
  const reviewed =
    reviewedPath === "none" ? [] : JSON.parse(readFileSync(reviewedPath, "utf8")).entries;
  const rev = opt("rev", null);
  let versions = all("node-cubrid");
  const dirs = all("upstream");
  if (versions.length === 0 && dirs.length === 0) versions = ["11.0.0"];
  const tmp = mkdtempSync(join(tmpdir(), "provenance-upstream-"));
  try {
    const theirs = [
      ...versions.flatMap((v) => {
        const dest = mkdtempSync(join(tmp, `node-cubrid-${v}-`));
        return upstreamFromDir(packInto(tmp, `node-cubrid@${v}`, dest), `node-cubrid@${v}`);
      }),
      ...dirs.flatMap((d) => upstreamFromDir(resolve(d), d)),
    ];
    if (theirs.length === 0) return ["no upstream source found"];
    const ours = rev
      ? oursFromRev(rev)
      : walk(join(REPO, "src"), (p) => p.endsWith(".ts") && !p.endsWith(".d.ts")).map((p) => ({
          name: posix(relative(REPO, p)),
          tokens: tokenize(readFileSync(p, "utf8"), p),
        }));
    const sources = [...versions.map((v) => `node-cubrid@${v}`), ...dirs].join(", ");
    console.log(
      `compared ${ours.length} files in src/${rev ? ` at ${rev}` : ""} with ${theirs.length} upstream files (${sources}), thresholds ${minRaw} identical / ${minNorm} same-shape tokens`,
    );
    const problems = [];
    const unreviewed = [];
    let reviewedHits = 0;
    for (const [field, min] of [
      ["raw", minRaw],
      ["norm", minNorm],
    ]) {
      for (const run of findRuns(ours, theirs, field, min)) {
        const line = `${field === "raw" ? "identical" : "same shape"} ${run.tokens} tokens: ${run.file}:${run.start}-${run.end} ~ ${run.theirs}`;
        const entry = reviewedEntry(reviewed, run);
        if (entry) {
          reviewedHits++;
          if (argv.includes("--verbose")) console.log(`reviewed (${entry.category}) ${line}`);
        } else {
          problems.push(`${line}\n    ${run.text}`);
          unreviewed.push({
            file: run.file,
            field: run.field,
            tokens: run.tokens,
            sha256: run.sha256,
            lines: `${run.start}-${run.end}`,
            upstream: run.theirs,
          });
        }
      }
    }
    console.log(`${reviewedHits} hit(s) match reviewed entries`);
    if (argv.includes("--emit")) console.log(JSON.stringify(unreviewed, null, 2));
    return problems;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main(argv) {
  const [mode, ...rest] = argv;
  let problems;
  if (mode === "pack") problems = checkPack();
  else if (mode === "similarity") problems = checkSimilarity(rest);
  else {
    console.error(
      "Usage: check-provenance.mjs pack | similarity [--node-cubrid=<v>]... [--upstream=<dir>]...",
    );
    return 2;
  }
  for (const p of problems) console.error(p);
  console.log(problems.length === 0 ? "provenance check passed" : `${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
