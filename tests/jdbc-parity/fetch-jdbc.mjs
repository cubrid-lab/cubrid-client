#!/usr/bin/env node
/**
 * Downloads the pinned official CUBRID JDBC driver from Maven Central and
 * refuses it unless its SHA-256 matches tests/jdbc-parity/jdbc-driver.json.
 * Prints the JAR path for CUBRID_JDBC_JAR.
 *
 *   npm run jdbc-parity:fetch [-- <directory>]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pin = JSON.parse(readFileSync(new URL("./jdbc-driver.json", import.meta.url), "utf8"));
const dir = resolve(process.argv[2] ?? ".cache/cubrid-jdbc");
const jar = join(dir, `${pin.artifactId}-${pin.version}.jar`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (existsSync(jar) && sha256(readFileSync(jar)) === pin.sha256) {
  process.stdout.write(`${jar}\n`);
  process.exit(0);
}
const response = await fetch(pin.url);
if (!response.ok) throw new Error(`GET ${pin.url} failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const actual = sha256(bytes);
if (actual !== pin.sha256) {
  throw new Error(`SHA-256 mismatch for ${pin.url}: expected ${pin.sha256}, got ${actual}`);
}
mkdirSync(dir, { recursive: true });
writeFileSync(`${jar}.part`, bytes);
renameSync(`${jar}.part`, jar);
process.stdout.write(`${jar}\n`);
