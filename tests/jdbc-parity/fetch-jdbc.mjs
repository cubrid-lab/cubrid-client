#!/usr/bin/env node
/**
 * Downloads the pinned official CUBRID JDBC driver from Maven Central and
 * refuses it unless its SHA-256 matches tests/jdbc-parity/jdbc-driver.json.
 * Prints the JAR path for CUBRID_JDBC_JAR. Transient failures (HTTP 429,
 * 5xx and network errors) are retried with backoff, honoring Retry-After.
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
const MAX_ATTEMPTS = 6;
const MAX_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const isTransient = (status) => status === 408 || status === 429 || status >= 500;

/** Milliseconds to wait before the next attempt, honoring Retry-After when present. */
function retryDelay(attempt, response) {
  const header = response?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, MAX_DELAY_MS);
  }
  return Math.min(2 ** attempt * 1000 + Math.floor(Math.random() * 1000), MAX_DELAY_MS);
}

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      // The timeout covers the body too, so a stalled transfer is retried.
      response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`GET ${url} failed: ${error}`);
      const delay = retryDelay(attempt);
      process.stderr.write(
        `GET ${url} failed (${error}); retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(delay / 1000)}s\n`,
      );
      await sleep(delay);
      continue;
    }
    if (!isTransient(response.status) || attempt >= MAX_ATTEMPTS) {
      throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    }
    await response.body?.cancel();
    const delay = retryDelay(attempt, response);
    process.stderr.write(
      `GET ${url} returned HTTP ${response.status}; retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(delay / 1000)}s\n`,
    );
    await sleep(delay);
  }
}

const bytes = await download(pin.url);
const actual = sha256(bytes);
if (actual !== pin.sha256) {
  throw new Error(`SHA-256 mismatch for ${pin.url}: expected ${pin.sha256}, got ${actual}`);
}
mkdirSync(dir, { recursive: true });
writeFileSync(`${jar}.part`, bytes);
renameSync(`${jar}.part`, jar);
process.stdout.write(`${jar}\n`);
