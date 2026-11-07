// Validates curated historical GitHub Release notes, without inferring authorship.
export const previousVersion = {
  "0.1.0": null, "0.2.0": "0.1.0", "1.0.0": "0.2.0",
  "1.1.0": "1.0.0", "1.2.0": "1.1.0", "1.3.0": "1.2.0",
};
const changeHeadings = new Set([
  "### Features", "### Bug Fixes", "### Improvements", "### Documentation", "### CI",
]);
const credit = / by @[A-Za-z0-9-]+(?: \(first contribution 🎉\))?$/;
const decorativeEmoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u20E3]/u;

export function validateCuratedNote(version, note) {
  const errors = [];
  if (!(version in previousVersion)) return ["Unknown release version: " + version];
  const tag = "v" + version;
  const lines = note.trimEnd().split("\n");
  if (!new RegExp("^## " + tag.replaceAll(".", "\\.") + " \\(\\d{4}-\\d{2}-\\d{2}\\)$").test(lines[0])) {
    errors.push("First line must contain the version and its historical release date");
  }
  const sections = lines.filter(line => line.startsWith("### "));
  if (sections.length === 0) errors.push("Missing change sections");
  if (sections.length !== new Set(sections).size) errors.push("Duplicate section headings");
  if (sections.some(h => h !== "### Upgrade notes" && !changeHeadings.has(h))) errors.push("Unrecognized release section heading");
  const upgradeIndex = sections.indexOf("### Upgrade notes");
  if (upgradeIndex > 0) errors.push("Upgrade notes must appear before change sections");
  if (!sections.some(h => changeHeadings.has(h))) errors.push("No user-facing change section");

  let current = "";
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("### ")) current = line;
    if (line.startsWith("- ") && changeHeadings.has(current)) {
      count++;
      if (!credit.test(line)) errors.push("Change missing credited author at line " + (i + 1));
      if (i + 1 < lines.length && /^[ \t]{2,}\S/.test(lines[i + 1])) errors.push("Hard-wrapped change entry at line " + (i + 1));
    }
  }
  if (count === 0) errors.push("No change entries");
  if (note.includes("cubrid-labs/cubrid-client")) errors.push("Outdated organization URL");
  if (/(?:^|\n)## (?:New Contributors|Highlights|Known limitations)/.test(note)) errors.push("Outdated or duplicated release section");
  const ids = [...note.matchAll(/github\.com\/cubrid-lab\/cubrid-client\/pull\/(\d+)/g)].map(x => x[1]);
  if (ids.length !== new Set(ids).size) errors.push("Repeated pull-request reference");

  const prior = previousVersion[version];
  const footer = prior === null
    ? "**Full Changelog:** [v0.1.0 commits](https://github.com/cubrid-lab/cubrid-client/commits/v0.1.0)"
    : "**Full Changelog:** [v" + prior + "..." + tag + "](https://github.com/cubrid-lab/cubrid-client/compare/v" + prior + "..." + tag + ")";
  if (lines.at(-1) !== footer) errors.push("Incorrect or missing final Full Changelog link");
  if (/\b(?:TODO|TBD|PLACEHOLDER)\b/i.test(note)) errors.push("Unresolved placeholder");
  if (decorativeEmoji.test(note.replaceAll("(first contribution 🎉)", ""))) errors.push("Decorative emoji are not allowed in release notes");
  return errors;
}
