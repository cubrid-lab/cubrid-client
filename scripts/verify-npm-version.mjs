// Verify the exact public npm version before proposing or tagging a newer release.
// A GitHub Release is not proof that npm distribution succeeded.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkNpmVersion(version, run = spawnSync) {
  if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new TypeError("Expected an exact X.Y.Z npm version.");
  }

  const args = [
    "view",
    "cubrid-client@" + version,
    "version",
    "--json",
    "--fetch-retries=0",
    "--registry=https://registry.npmjs.org/",
  ];
  const result = run("npm", args, { encoding: "utf8", timeout: 30000 });
  if (result.error) {
    return { status: "unavailable", detail: String(result.error.message) };
  }

  if (result.status !== 0) {
    const message = String(result.stderr ?? "");
    if (/\b(?:E404|ETARGET)\b/.test(message)) {
      return { status: "missing", detail: "Exact version absent from public npm registry." };
    }
    return { status: "unavailable", detail: "npm registry verification failed: " + message.slice(0, 350) };
  }

  let observed;
  try {
    observed = JSON.parse(result.stdout);
  } catch {
    return { status: "unavailable", detail: "Registry returned an invalid JSON response." };
  }

  if (observed !== version) {
    return { status: "missing", detail: "Exact version not returned by the public npm registry." };
  }
  return { status: "published", detail: "Verified cubrid-client@" + version + " on public npm." };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const check = checkNpmVersion(process.argv[2]);
    const message = check.status + ": " + check.detail;
    if (check.status === "published") {
      console.log(message);
    } else {
      console.error(message);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("Unable to verify exact npm version: " + String(error));
    process.exitCode = 1;
  }
}
