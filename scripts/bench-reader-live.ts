// Live counterpart of bench-reader.ts (#253): what the per-read socket
// listeners of CASConnection cost on real queries against a live broker.
//
// One client per reader (see bench-reader-variants.ts) runs the same
// workloads, in blocks whose order rotates so that changing host load falls on
// every reader. Client CPU time is taken with process.cpuUsage() around each
// block, latency per operation. Listing one reader twice
// (BENCH_READERS=per-read,per-read,...) measures the noise between two clients.
//
//   CUBRID_TEST_PORT=33000 BENCH_READERS=per-read,per-read,per-read-nocopy,framed \
//     node --import tsx scripts/bench-reader-live.ts [blocks]
import { performance } from "node:perf_hooks";

import { createClient } from "../src/client/create-client.js";
import { framesRead, type Mode, useReader } from "./bench-reader-variants.js";

const blocks = Number(process.argv[2] ?? 10);
const table = "cc_bench_reader";
const modes = (process.env.BENCH_READERS ?? "per-read,per-read,per-read-nocopy,framed").split(
  ",",
) as Mode[];

const options = {
  host: process.env.CUBRID_TEST_HOST ?? "127.0.0.1",
  port: Number(process.env.CUBRID_TEST_PORT ?? 33000),
  database: process.env.CUBRID_TEST_DB ?? "testdb",
  user: "dba",
  password: "",
  maxReplyBytes: 128 * 1024 * 1024,
};
type Client = ReturnType<typeof createClient>;
const clients: [label: string, client: Client][] = [];
for (const [index, mode] of modes.entries()) {
  useReader(mode);
  const client = createClient(options);
  await client.query("SELECT 1");
  clients.push([`${index + 1}:${mode}`, client]);
}
const [, setup] = clients[0] ?? [];
if (!setup) {
  throw new Error("BENCH_READERS names no reader");
}

type Workload = readonly [
  name: string,
  opsPerBlock: number,
  run: (c: Client, i: number) => Promise<unknown>,
];

const workloads: readonly Workload[] = [
  [
    "select by primary key",
    200,
    (c, i) => c.query(`SELECT id, name FROM ${table} WHERE id = ?`, [i % 10000]),
  ],
  ["10000 rows (FETCH windows)", 5, (c) => c.query(`SELECT id, name FROM ${table}`)],
  [
    "one 64 MiB row",
    1,
    async (c) => {
      const [row] = await c.query<{ a: string; b: string }>(`SELECT a, b FROM ${table}_big`);
      if (row?.a.length !== 33554432 || row.b.length !== 33554432) {
        throw new Error("the 64 MiB row did not arrive whole");
      }
    },
  ],
];

const percentile = (values: number[], share: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? Number.NaN;
};

try {
  await setup.query(`DROP TABLE IF EXISTS ${table}, ${table}_big`);
  await setup.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(100))`);
  for (let start = 0; start < 10000; start += 1000) {
    const values = Array.from(
      { length: 1000 },
      (_, i) => `(${start + i}, '${"n".repeat(90)}')`,
    ).join(", ");
    await setup.query(`INSERT INTO ${table} (id, name) VALUES ${values}`);
  }
  // Two 32 MiB columns: 32 MiB is the largest string_max_size_bytes allows.
  await setup.query("SET SYSTEM PARAMETERS 'string_max_size_bytes=33554432'");
  await setup.query(`CREATE TABLE ${table}_big (a STRING, b STRING)`);
  await setup.query(
    `INSERT INTO ${table}_big SELECT REPEAT('x', 33554432), REPEAT('y', 33554432) FROM db_root`,
  );

  console.log(
    `node ${process.version}, server ${await setup.getServerVersion()}, ${blocks} blocks per reader`,
  );
  console.log("| Workload | Reader | median ms/op | p95 ms/op | client CPU ms/op | frames/op |");
  console.log("|---|---|---:|---:|---:|---:|");
  for (const [name, ops, run] of workloads) {
    const stats = clients.map(() => ({ times: [] as number[], cpu: 0, ops: 0, frames: 0 }));
    for (const [, client] of clients) {
      await run(client, 0);
    }
    for (let block = 0; block < blocks; block += 1) {
      for (let k = 0; k < clients.length; k += 1) {
        const index = (block + k) % clients.length;
        const client = clients[index]?.[1];
        const entry = stats[index];
        if (!client || !entry) continue;
        const framesBefore = framesRead();
        const cpu = process.cpuUsage();
        for (let i = 0; i < ops; i += 1) {
          const start = performance.now();
          await run(client, block * ops + i);
          entry.times.push(performance.now() - start);
        }
        const used = process.cpuUsage(cpu);
        entry.cpu += (used.user + used.system) / 1000;
        entry.ops += ops;
        entry.frames += framesRead() - framesBefore;
      }
    }
    for (const [index, entry] of stats.entries()) {
      console.log(
        `| ${name} | ${clients[index]?.[0]} | ` +
          `${percentile(entry.times, 0.5).toFixed(3)} | ${percentile(entry.times, 0.95).toFixed(3)} | ` +
          `${(entry.cpu / entry.ops).toFixed(3)} | ${(entry.frames / entry.ops).toFixed(1)} |`,
      );
    }
  }
} finally {
  await setup.query(`DROP TABLE IF EXISTS ${table}, ${table}_big`).catch(() => undefined);
  for (const [, client] of clients) {
    await client.close();
  }
}
