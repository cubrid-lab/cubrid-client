// Verify human-authored GitHub Release notes before a tag is created.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const notePath = join("docs", "releases", `${tag}.md`);
const isCandidate = process.argv.includes("--candidate");
// Reject emoji in both historical and upcoming release notes, including flags and keycap sequences.
const emojiPattern = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u20E3]/u;

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

for (const filename of readdirSync(join("docs", "releases"))) {
  if (!/^v\\d+\\.\\d+\\.\\d+\\.md$/.test(filename)) continue;
  const path = join("docs", "releases", filename);
  if (emojiPattern.test(readFileSync(path, "utf8"))) {
    fail(`emoji are not allowed in ${path}`);
  }
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
if (emojiPattern.test(changelog)) {
  fail("emoji are not allowed in CHANGELOG.md");
}
if (/^## \[Unreleased\]/m.test(changelog)) {
  fail("duplicate manually maintained [Unreleased] section remains in CHANGELOG.md");
}
if (!isCandidate && !changelog.includes(`## [${version}]`)) {
  fail(`Release Please has not written a ${version} CHANGELOG section`);
}
if (process.exitCode !== 1) {
  console.log(`Release notes verified: ${tag}${isCandidate ? " (candidate mode)" : ""}`);
}
