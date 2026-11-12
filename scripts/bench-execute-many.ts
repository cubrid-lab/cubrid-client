// Compares executeMany() with a loop of execute() calls against a live broker.
// Each round inserts the same number of rows both ways into a fresh table, in
// alternating order, so changing load on the host falls on both. Both paths run
// in autocommit mode: the loop commits every row, executeMany() the whole batch.
// It reports latency and request counts only. On a host where each commit is
// slow (a loaded machine, or a container flushing its log), the loop's time is
// mostly commits, so compare the request counts before any ratio.
//
//   CUBRID_TEST_PORT=33000 node --import tsx scripts/bench-execute-many.ts [rounds] [sizes]
//
// `sizes` is a comma-separated list of row counts, 10,100,1000 by default.
import { performance } from "node:perf_hooks";

import { createClient } from "../src/client/create-client.js";

const rounds = Number(process.argv[2] ?? 3);
const sizes = (process.argv[3] ?? "10,100,1000").split(",").map(Number);
const table = "cc_bench_execute_many";
const client = createClient({
  host: process.env.CUBRID_TEST_HOST ?? "127.0.0.1",
  port: Number(process.env.CUBRID_TEST_PORT ?? 33000),
  database: "testdb",
  user: "dba",
  password: "",
});

const insert = `INSERT INTO ${table} (id, name, amount) VALUES (?, ?, ?)`;
const rows = (count: number): Array<[number, string, number]> =>
  Array.from({ length: count }, (_, id) => [id, `name-${id}`, id * 1.5]);

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

async function timed(run: () => Promise<unknown>): Promise<number> {
  await client.query(`DELETE FROM ${table}`);
  const start = performance.now();
  await run();
  return performance.now() - start;
}

try {
  await client.query(`DROP TABLE IF EXISTS ${table}`);
  await client.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(40), amount DOUBLE)`);

  console.log(`rounds per size: ${rounds}; server ${await client.getServerVersion()}`);
  console.log(
    "| Rows | execute() loop requests | executeMany() requests | execute() loop median | executeMany() median |",
  );
  console.log("| ---: | ---: | ---: | ---: | ---: |");
  for (const size of sizes) {
    const sets = rows(size);
    const loop = async (): Promise<void> => {
      for (const set of sets) {
        await client.execute(insert, set);
      }
    };
    const batch = (): Promise<unknown> => client.executeMany(insert, sets);

    const times: [number[], number[]] = [[], []];
    for (let round = 0; round < rounds; round += 1) {
      // Swapping the order each round cancels any cost of going first.
      const runs = [loop, batch];
      const first = round % 2;
      times[first]?.push(await timed(runs[first]!));
      times[1 - first]?.push(await timed(runs[1 - first]!));
    }
    const [looped, batched] = times.map(median) as [number, number];
    const ms = (value: number): string => `${value.toFixed(1)} ms`;
    // Each call on a reused session starts with the CHECK_CAS probe. Then
    // execute() of an INSERT, per row: PREPARE_AND_EXECUTE, GET_LAST_INSERT_ID,
    // END_TRAN (one commit per row) and the handle release. executeMany(): PREPARE,
    // EXECUTE_ARRAY (these rows are far below the 1 MiB request limit), END_TRAN
    // and the handle release. scripts/bench-round-trips.ts counts them on the wire.
    console.log(`| ${size} | ${size * 5} | 5 | ${ms(looped)} | ${ms(batched)} |`);
  }
} finally {
  await client.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
  await client.close();
}
