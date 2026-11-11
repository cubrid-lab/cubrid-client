// Compares transaction() on a client, which opens and closes a connection for
// every transaction, with transaction() on a pool, which reuses its sessions.
// Each round runs the same transactions both ways, in alternating order, so
// changing load on the host falls on both.
//
// A local TCP relay sits between the driver and the broker and counts what the
// driver sends: handshakes (new sessions) and CAS requests. Those counts do not
// depend on the host's load, so read them before the timings. On a loaded host
// the timings mostly measure the server's commits and the scheduler. Both paths
// send about four framed requests per transaction: the client's include closing
// its connection, the pool's include the CHECK_CAS probe of a reused session. What
// the pool saves is the handshake (broker exchange and OpenDatabase) per transaction.
//
//   CUBRID_TEST_PORT=33000 node --import tsx scripts/bench-pool.ts [rounds] [transactions] [concurrency]
import { createServer, connect as netConnect, type Socket } from "node:net";
import { performance } from "node:perf_hooks";

import { createClient } from "../src/client/create-client.js";
import { createPool } from "../src/client/pool.js";
import type { TransactionClient } from "../src/types/client.js";

const rounds = Number(process.argv[2] ?? 3);
const transactions = Number(process.argv[3] ?? 200);
const concurrency = Number(process.argv[4] ?? 4);
const table = "cc_bench_pool";
const brokerHost = process.env.CUBRID_TEST_HOST ?? "127.0.0.1";
const brokerPort = Number(process.env.CUBRID_TEST_PORT ?? 33000);

/** ClientInfoExchange (10 bytes) and OpenDatabase (628 bytes) are not framed. */
const HANDSHAKE_BYTES = 10 + 628;

const counts = { handshakes: 0, requests: 0 };

/**
 * Relays one driver socket to the broker, counting framed requests after the
 * handshake. A CUBRID broker hands the socket itself to a CAS (redirect port
 * 0), so one TCP connection carries the whole session.
 */
function relay(client: Socket): void {
  const server = netConnect(brokerPort, brokerHost);
  counts.handshakes += 1;
  let skip = HANDSHAKE_BYTES;
  let pending = Buffer.alloc(0);

  client.on("data", (chunk: Buffer) => {
    server.write(chunk);
    let data = chunk;
    if (skip > 0) {
      const skipped = Math.min(skip, data.length);
      skip -= skipped;
      data = data.subarray(skipped);
    }
    pending = Buffer.concat([pending, data]);
    // Request frame: 4-byte payload length, 4 bytes of CAS_INFO, payload.
    while (pending.length >= 8) {
      const size = 8 + pending.readInt32BE(0);
      if (pending.length < size) {
        break;
      }
      counts.requests += 1;
      pending = pending.subarray(size);
    }
  });
  server.on("data", (chunk: Buffer) => client.write(chunk));
  const end = (): void => {
    client.destroy();
    server.destroy();
  };
  client.on("close", end);
  server.on("close", end);
  client.on("error", end);
  server.on("error", end);
}

const proxy = createServer(relay);
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
const address = proxy.address();
const port = typeof address === "object" && address ? address.port : 0;
const config = { host: "127.0.0.1", port, database: "testdb", user: "dba", password: "" };

const work = async (tx: TransactionClient, id: number): Promise<void> => {
  await tx.query(`UPDATE ${table} SET n = n + 1 WHERE id = ?`, [id % 100]);
};

/** Runs `transactions` transactions, `concurrency` at a time. */
async function drive(run: (id: number) => Promise<unknown>): Promise<number> {
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < transactions) {
        const id = next;
        next += 1;
        await run(id);
      }
    }),
  );
  return performance.now() - start;
}

interface Measure {
  ms: number;
  handshakes: number;
  requests: number;
}

async function measure(run: () => Promise<number>): Promise<Measure> {
  const before = { ...counts };
  const ms = await run();
  return {
    ms,
    handshakes: counts.handshakes - before.handshakes,
    requests: counts.requests - before.requests,
  };
}

const client = createClient(config);
// A client round can outlast the default 30-second idle timeout; keeping idle
// sessions makes the handshake count show reuse rather than that timeout.
const pool = createPool({ ...config, max: concurrency, idleTimeoutMs: 0 });

try {
  await client.query(`DROP TABLE IF EXISTS ${table}`);
  await client.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, n INT)`);
  await client.query(
    `INSERT INTO ${table} SELECT ROWNUM - 1, 0 FROM db_attribute a, db_attribute b LIMIT 100`,
  );
  // Open the pool's sessions before measuring, as a running application would have.
  await Promise.all(Array.from({ length: concurrency }, () => pool.query("SELECT 1 FROM db_root")));

  const withClient = (): Promise<number> => drive((id) => client.transaction((tx) => work(tx, id)));
  const withPool = (): Promise<number> => drive((id) => pool.transaction((tx) => work(tx, id)));

  console.log(
    `server ${await client.getServerVersion()}; ${rounds} rounds of ${transactions} ` +
      `transactions, ${concurrency} at a time`,
  );
  console.log(
    "| Round | Path | Handshakes | CAS requests | Requests per transaction | Time | Transactions/s |",
  );
  console.log("| ---: | --- | ---: | ---: | ---: | ---: | ---: |");
  for (let round = 1; round <= rounds; round += 1) {
    const order: Array<[string, () => Promise<number>]> = [
      ["client.transaction()", withClient],
      ["pool.transaction()", withPool],
    ];
    if (round % 2 === 0) {
      order.reverse();
    }
    for (const [name, run] of order) {
      const { ms, handshakes, requests } = await measure(run);
      console.log(
        `| ${round} | ${name} | ${handshakes} | ${requests} | ` +
          `${(requests / transactions).toFixed(1)} | ${ms.toFixed(0)} ms | ` +
          `${((transactions * 1000) / ms).toFixed(0)} |`,
      );
    }
  }
} finally {
  await client.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
  await pool.close();
  await client.close();
  proxy.close();
}
