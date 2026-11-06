// Public API compatibility check.
// Compares the built declarations (dist/index.d.ts and dist/index.d.cts, the
// files consumers get from the npm package) with the reviewed baseline in
// api/index.d.ts. Run `npm run build` first. Use --update to rewrite the baseline.
import { spawnSync } from "node:child_process";
import { publicDeclarationSurface } from "./api-public-surface.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(root, "api/index.d.ts");
const builtPaths = ["dist/index.d.ts", "dist/index.d.cts"].map((p) => resolve(root, p));
const update = process.argv.includes("--update");

const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

let built;
try {
	built = builtPaths.map(read);
} catch {
	console.error("dist/index.d.ts or dist/index.d.cts not found. Run `npm run build` first.");
	process.exit(2);
}
if (built[0] !== built[1]) {
	console.error("dist/index.d.ts and dist/index.d.cts differ; ESM and CJS types must match.");
	process.exit(1);
}

if (update) {
	mkdirSync(dirname(baselinePath), { recursive: true });
	writeFileSync(baselinePath, built[0]);
	console.log("Updated api/index.d.ts. Review the diff and commit it with your change.");
	process.exit(0);
}

let baseline;
try {
	baseline = read(baselinePath);
} catch {
	console.error("api/index.d.ts is missing. Run `npm run api:update` to create it.");
	process.exit(2);
}
// Compare the consumer-facing API, not private class implementation details.
if (publicDeclarationSurface(baseline) === publicDeclarationSurface(built[0])) {
	console.log("Public API matches api/index.d.ts.");
	process.exit(0);
}

console.error("Consumer-visible TypeScript API differs from the reviewed baseline api/index.d.ts:\n");
const diff = spawnSync("diff", ["-u", "--label", "baseline", "--label", "built", baselinePath, builtPaths[0]], {
	encoding: "utf8",
});
console.error(diff.stdout || "(diff unavailable)");
console.error(
	"If this change is intentional, run `npm run api:update`, commit api/index.d.ts and explain\n" +
		"the change in the PR (see CONTRIBUTING.md, Public API compatibility).",
);
process.exit(1);
