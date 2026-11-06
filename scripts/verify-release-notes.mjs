// Verify human-authored GitHub Release notes before a tag is created.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const notePath = join("docs", "releases", `${tag}.md`);
const isCandidate = process.argv.includes("--candidate");

function fail(message) {
  console.error(`Release notes gate: ${message}`);
  process.exitCode = 1;
}

let notes = "";
try {
  notes = readFileSync(notePath, "utf8");
} catch {
  fail(`missing ${notePath}`);
}

if (notes) {
  for (const heading of [
    `# cubrid-client ${tag}`,
    "## Highlights",
    "## Fixes",
    "## Compatibility",
    "## Known limitations",
    "## Validation and release scope",
  ]) {
    if (!notes.includes(heading)) fail(`missing required section: ${heading}`);
  }
  if (/\b(?:TODO|TBD|PLACEHOLDER)\b/i.test(notes)) {
    fail("release notes contain unresolved placeholders");
  }
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
if (/^## \[Unreleased\]/m.test(changelog)) {
  fail("duplicate manually maintained [Unreleased] section remains in CHANGELOG.md");
}
if (!isCandidate && !changelog.includes(`## [${version}]`)) {
  fail(`Release Please has not written a ${version} CHANGELOG section`);
}
if (process.exitCode !== 1) {
  console.log(`Release notes verified: ${tag}${isCandidate ? " (candidate mode)" : ""}`);
}
