// Verify human-authored GitHub Release notes before a tag is created.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const notePath = join("docs", "releases", `${tag}.md`);
const isCandidate = process.argv.includes("--candidate");
// Reject decorative emoji, but allow the agreed inline first-contribution celebration.
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
  const [major, minor] = version.split(".").map(Number);
  const modernFormat = major > 1 || (major === 1 && minor >= 3);
  if (modernFormat) {
    // Curated release notes: ordered headings, one change per PR/related group,
    // human attribution, and a single comparison link at the end.
    const required = [
      "## v" + version + " (",
      "### Upgrade notes",
      "### Features",
      "### Bug Fixes",
      "**Full Changelog:**",
    ];
    const lines = notes.trimEnd().split("\n");
    let lastIndex = -1;
    for (const heading of required) {
      const found = lines.findIndex(line => line.startsWith(heading));
      if (found <= lastIndex) fail("missing or unordered release section: " + heading);
      lastIndex = found;
    }
    const credit = / by @[A-Za-z0-9-]+(?: \(first contribution 🎉\))?$/;
    let inChangeSection = false;
    let credited = 0;
    for (const line of lines) {
      if (line.startsWith("### ")) {
        inChangeSection = ["### Features", "### Bug Fixes", "### CI"].includes(line);
      }
      if (inChangeSection && line.startsWith("- ")) {
        if (!credit.test(line)) fail("change entry missing by @username: " + line);
        credited++;
      }
    }
    if (credited === 0) fail("no credited change entries in the release notes");
    const pullIds = [...notes.matchAll(/github\.com\/cubrid-lab\/cubrid-client\/pull\/(\d+)/g)].map(match => match[1]);
    if (pullIds.length !== new Set(pullIds).size) {
      fail("duplicate pull request entries in the release notes");
    }
    const footer = lines.at(-1) ?? "";
    if (!footer.startsWith("**Full Changelog:** [v") || !footer.includes("..." + tag + "](") ||
        !footer.includes("github.com/cubrid-lab/cubrid-client/compare/")) {
      fail("missing or malformed final Full Changelog link");
    }
  } else {
    for (const heading of [
      "# cubrid-client " + tag,
      "## Highlights",
      "## Fixes",
      "## Compatibility",
      "## Known limitations",
      "## Validation and release scope",
    ]) {
      if (!notes.includes(heading)) fail("missing required section: " + heading);
    }
  }
  if (/\b(?:TODO|TBD|PLACEHOLDER)\b/i.test(notes)) {
    fail("release notes contain unresolved placeholders");
  }
}

for (const filename of readdirSync(join("docs", "releases"))) {
  if (!/^v\d+\.\d+\.\d+\.md$/.test(filename)) continue;
  const path = join("docs", "releases", filename);
  const content = readFileSync(path, "utf8");
  const withoutFirstContributionCelebrations = content.replaceAll("(first contribution 🎉)", "(first contribution)");
  if (emojiPattern.test(withoutFirstContributionCelebrations)) {
    fail(`emoji are not allowed in ${path}, except an inline first-contribution credit`);
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
