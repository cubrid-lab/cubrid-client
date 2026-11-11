// #217: proves the committed Biome configuration rejects violations, so a green
// `npm run lint:ci` means something. Each probe file goes in a temporary
// directory whose config only extends the repository's and widens `includes`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const biome = join(root, "node_modules", "@biomejs", "biome", "bin", "biome");

function biomeCi(source) {
  const dir = mkdtempSync(join(tmpdir(), "cubrid-client-biome-"));
  try {
    writeFileSync(
      join(dir, "biome.json"),
      JSON.stringify({ extends: [join(root, "biome.json")], files: { includes: ["**"] } }),
    );
    writeFileSync(join(dir, "probe.ts"), source);
    return spawnSync(process.execPath, [biome, "ci", "probe.ts"], { cwd: dir, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("biome ci accepts code in the repository style", () => {
  const result = biomeCi('export const value = { a: 1, b: "two" };\n');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("biome ci rejects misformatted code without rewriting it", () => {
  const result = biomeCi("export const  value = {a:1,b:'two'}\n");
  assert.notEqual(result.status, 0);
});

test("biome ci rejects a lint error", () => {
  const result = biomeCi(
    "export function f(): number {\n  try {\n    return 1;\n  } finally {\n    return 2;\n  }\n}\n",
  );
  assert.notEqual(result.status, 0);
});

test("biome ci rejects unsorted imports", () => {
  const result = biomeCi(
    'import { b } from "./b.js";\nimport { a } from "./a.js";\n\nexport const value = [a, b];\n',
  );
  assert.notEqual(result.status, 0);
});
