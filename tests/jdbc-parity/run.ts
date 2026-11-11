/**
 * JDBC-vs-TypeScript semantic comparison against one live CUBRID broker (#118).
 *
 *   CUBRID_TEST_PORT=33000 CUBRID_JDBC_JAR="$(npm run -s jdbc-parity:fetch)" npm run test:jdbc-parity
 *
 * Optional: CUBRID_TEST_HOST (127.0.0.1), CUBRID_TEST_DATABASE (testdb), JAVA
 * (java on PATH), JDBC_PARITY_OUT (jdbc-parity-results). Both runners use user
 * dba with an empty password, create and drop jp_* tables, and run one after
 * the other. Exits non-zero on any unexpected difference, any runner failure
 * or zero executed cases.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare } from "./compare.js";
import { loadCorpus, type RunnerOutput, runTs } from "./ts-runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; see tests/jdbc-parity/run.ts`);
  return value;
}

async function main(): Promise<number> {
  const port = Number(required("CUBRID_TEST_PORT"));
  const jar = resolve(required("CUBRID_JDBC_JAR"));
  const host = process.env.CUBRID_TEST_HOST ?? "127.0.0.1";
  const database = process.env.CUBRID_TEST_DATABASE ?? "testdb";
  const outDir = resolve(process.env.JDBC_PARITY_OUT ?? "jdbc-parity-results");
  const pin = JSON.parse(readFileSync(join(here, "jdbc-driver.json"), "utf8")) as {
    version: string;
    sha256: string;
  };
  const jarSha = createHash("sha256").update(readFileSync(jar)).digest("hex");
  if (jarSha !== pin.sha256) {
    throw new Error(`${jar} has SHA-256 ${jarSha}, not the pinned ${pin.sha256}`);
  }

  const corpusPath = join(here, "corpus.json");
  const corpus = loadCorpus(corpusPath);
  mkdirSync(outDir, { recursive: true });
  const jdbcPath = join(outDir, "jdbc.json");

  const java = spawnSync(
    process.env.JAVA ?? "java",
    [
      "-Duser.timezone=UTC",
      "-cp",
      jar,
      join(here, "JdbcRunner.java"),
      corpusPath,
      jdbcPath,
      host,
      String(port),
      database,
    ],
    { stdio: "inherit" },
  );
  if (java.status !== 0) throw new Error(`JDBC runner exited with ${java.status ?? java.signal}`);
  const jdbc = JSON.parse(readFileSync(jdbcPath, "utf8")) as RunnerOutput;

  const ts = await runTs(corpus, { host, port, database });
  writeFileSync(join(outDir, "ts.json"), `${JSON.stringify(ts, null, 2)}\n`);

  const report = compare(corpus, jdbc, ts);
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  const environment = {
    commit: commit || "unknown",
    jdbcDriver: `${jdbc.driverVersion} sha256:${jarSha}`,
    jdbcRuntime: jdbc.runtime,
    tsDriver: ts.driverVersion,
    tsRuntime: ts.runtime,
    serverVersionJdbc: jdbc.serverVersion,
    serverVersionTs: ts.serverVersion,
  };
  writeFileSync(
    join(outDir, "report.json"),
    `${JSON.stringify({ environment, ...report }, null, 2)}\n`,
  );

  for (const [key, value] of Object.entries(environment)) console.log(`${key}: ${value}`);
  console.log("");
  for (const c of report.cases) {
    const flag = c.unexpected ? "FAIL" : "ok  ";
    console.log(`${flag} ${c.classification.padEnd(31)} ${c.id}`);
    for (const d of c.differences) console.log(`       difference: ${d}`);
    for (const w of c.warnings) console.log(`       warning: ${w}`);
  }
  console.log("");
  console.log(
    Object.entries(report.counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" "),
  );
  if (jdbc.serverVersion !== ts.serverVersion) {
    console.error("The runners reached different servers");
    return 1;
  }
  if (report.counts.executed === 0) console.error("No case was executed");
  return report.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
