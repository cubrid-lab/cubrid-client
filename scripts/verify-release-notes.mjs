// Verify every curated GitHub Release note and the generated changelog.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateCuratedNote } from "./release-notes-format.mjs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const noteDir = join("docs", "releases");
const currentPath = join(noteDir, "v" + version + ".md");
const isCandidate = process.argv.includes("--candidate");
const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u20E3]/u;
const errors = [];

if (!existsSync(currentPath)) errors.push("Missing curated release notes for current version: " + currentPath);
const files = readdirSync(noteDir).filter(name => /^v\d+\.\d+\.\d+\.md$/.test(name));
for (const file of files) {
  const releaseVersion = file.slice(1, -3);
  const content = readFileSync(join(noteDir, file), "utf8");
  for (const problem of validateCuratedNote(releaseVersion, content)) {
    errors.push(file + ": " + problem);
  }
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
if (emoji.test(changelog)) errors.push("Decorative emoji are not allowed in generated CHANGELOG.md");
if (/^## \[Unreleased\]/m.test(changelog)) errors.push("Unexpected manually maintained Unreleased section");
if (!isCandidate && !changelog.includes("## [" + version + "]")) {
  errors.push("Release Please did not generate a changelog section for " + version);
}

if (errors.length > 0) {
  for (const error of errors) console.error("Release notes gate: " + error);
  process.exitCode = 1;
} else {
  console.log("Verified " + files.length + " versioned release notes" + (isCandidate ? " (candidate mode)" : ""));
}
