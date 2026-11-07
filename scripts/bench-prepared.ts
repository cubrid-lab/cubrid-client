// Compares the literal path with prepared binding against a live broker.
// Each round runs one statement on each path, so changing load on the host
// falls on both. It reports latency only: it says nothing about a server's
// plan cache under other workloads.
//
//   CUBRID_TEST_PORT=33000 node --import tsx scripts/bench-prepared.ts [rounds]
import { performance } from "node:perf_hooks";

import { createClient } from "../src/client/create-client.js";

const rounds = Number(process.argv[2] ?? 300);
const table = "cc_bench_prepared";
const client = createClient({
  host: process.env.CUBRID_TEST_HOST ?? "127.0.0.1",
  port: Number(process.env.CUBRID_TEST_PORT ?? 33000),
  database: "testdb",
  user: "dba",
  password: "",
});

const percentile = (sorted: number[], share: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? Number.NaN;

async function timed(run: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

type Workload = readonly [
  name: string,
  literal: (round: number) => Promise<unknown>,
  prepared: (round: number) => Promise<unknown>,
];

const byKey = `SELECT id, name FROM ${table} WHERE id = ?`;
const scan = `SELECT id, name FROM ${table} WHERE id < ? ORDER BY id`;
const update = `UPDATE ${table} SET name = ? WHERE id = ?`;
const insert = `INSERT INTO ${table} (id, name) VALUES (?, ?)`;
let nextId = 2000;

const workloads: readonly Workload[] = [
  ["select by primary key", (r) => client.query(byKey, [r % 1000]), (r) => client.queryPrepared(byKey, [r % 1000])],
  ["select 1000 rows", () => client.query(scan, [1000]), () => client.queryPrepared(scan, [1000])],
  ["update by primary key", (r) => client.execute(update, ["u", r % 1000]), (r) => client.executePrepared(update, ["u", r % 1000])],
  ["insert one row", () => client.execute(insert, [nextId++, "n"]), () => client.executePrepared(insert, [nextId++, "n"])],
];

try {
  await client.query(`DROP TABLE IF EXISTS ${table}`);
  await client.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(40))`);
  const seed = Array.from({ length: 1000 }, (_, i) => `(${i}, 'name')`).join(", ");
  await client.query(`INSERT INTO ${table} (id, name) VALUES ${seed}`);

  console.log(`rounds per workload: ${rounds}; server ${await client.getServerVersion()}`);
  console.log("| Workload | Literal median | Prepared median | Literal p95 | Prepared p95 |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const [name, literal, prepared] of workloads) {
    const times: [number[], number[]] = [[], []];
    for (let round = 0; round < rounds; round += 1) {
      // Swapping the order each round cancels any cost of going first.
      const first = round % 2;
      const runs = [literal, prepared];
      times[first]?.push(await timed(() => runs[first]!(round)));
      times[1 - first]?.push(await timed(() => runs[1 - first]!(round)));
    }
    const [lit, pre] = times.map((list) => list.sort((a, b) => a - b)) as [number[], number[]];
    const ms = (value: number): string => `${value.toFixed(2)} ms`;
    console.log(
      `| ${name} | ${ms(percentile(lit, 0.5))} | ${ms(percentile(pre, 0.5))} | ${ms(percentile(lit, 0.95))} | ${ms(percentile(pre, 0.95))} |`,
    );
  }
} finally {
  await client.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
  await client.close();
}
