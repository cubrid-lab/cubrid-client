#!/usr/bin/env node
/**
 * Conservatively select CI lanes for a pull request.
 *
 * Only known non-executable documentation and the release-note verifier are
 * eligible to skip the full Node matrix. Any unknown path selects runtime.
 * Read `git diff --no-renames --name-status`, not only file names. Deletions,
 * renames (represented as D+A) and unrecognized statuses must run the full CI.
 * An unreadable diff fails closed.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DOC_EXT = /\.(?:md|mdx|rst|adoc|txt|png|jpe?g|gif|svg|webp|drawio)$/i;
const RELEASE_TOOL = new Set(["scripts/verify-release-notes.mjs"]);

export function classify(event, paths) {
  if (event !== "pull_request") {
    return { runtime: true, docs: false, reason: "non-PR full validation" };
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => !p || p.includes("\0"))) {
    return { runtime: true, docs: true, reason: "missing or invalid diff: fail closed" };
  }

  let runtime = false;
  let docs = false;
  for (const change of paths) {
    // A status is required: accepting bare paths silently treats a deleted
    // Markdown file or a renamed doc as documentation-only validation.
    const match = /^(A|M|D)\t(.+)$/.exec(change);
    if (!match) {
      return { runtime: true, docs: true, reason: "unrecognized change status: fail closed" };
    }
    const [, status, path] = match;
    const doc = DOC_EXT.test(path) &&
      (path.startsWith("docs/") || !path.includes("/") ||
        path.startsWith(".github/ISSUE_TEMPLATE/") ||
        path.startsWith(".github/PULL_REQUEST_TEMPLATE/"));
    if (doc || RELEASE_TOOL.has(path)) docs = true;
    else runtime = true;
    // Do not skip executable/source tests for deletions or a rename split into
    // D and A by --no-renames, even if both path names have a docs extension.
    if (status === "D") runtime = true;
  }
  return {
    runtime,
    docs,
    reason: runtime
      ? "runtime, dependency, CI policy or unknown paths changed"
      : "documentation or release-note validation tooling only",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.argv[2] || "pull_request";
  const paths = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
  const selected = classify(event, paths);
  console.error("CI impact:", JSON.stringify({ event, paths, ...selected }));
  process.stdout.write(`runtime=${selected.runtime}\ndocs=${selected.docs}\n`);
}
