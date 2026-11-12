// Counts the CAS exchanges each public call sends, by function code, and times
// the calls, against a live broker (#248).
//
// A local TCP relay sits between the driver and the broker, as in
// scripts/bench-pool.ts. It reads the function code of every framed request and
// matches each reply to its request, so the counts come from the wire, not from
// the driver's own bookkeeping, and the driver runs unmodified. A CUBRID broker
// hands its socket to a CAS (redirect port 0), so one TCP connection carries a
// whole session; a redirecting broker or `ssl: true` is not supported here.
//
// Every scenario has its own client, warmed once before measuring unless it is
// the cold one, and each round runs every scenario once, so changing load on the
// host falls on all of them. Exchange counts do not depend on the host's load:
// read them before the timings. Timings include the relay's extra hop.
//
//   CUBRID_TEST_PORT=33000 node --import tsx scripts/bench-round-trips.ts [rounds]
import { createServer, connect as netConnect, type Socket } from "node:net";
import { performance } from "node:perf_hooks";

import type { CubridClient } from "../src/client/client.js";
import { createClient } from "../src/client/create-client.js";
import { type CubridPool, createPool } from "../src/client/pool.js";
import { CASFunctionCode, OPEN_DB_TOTAL_SIZE } from "../src/protocol/constants.js";

const rounds = Number(process.argv[2] ?? 50);
const brokerHost = process.env.CUBRID_TEST_HOST ?? "127.0.0.1";
const brokerPort = Number(process.env.CUBRID_TEST_PORT ?? 33000);
const table = "cc_bench_round_trips";

/** ClientInfoExchange (10 bytes) and OpenDatabase are sent unframed. */
const HANDSHAKE_BYTES = 10 + OPEN_DB_TOTAL_SIZE;
/** The broker answers ClientInfoExchange with one unframed int, the redirect port. */
const BROKER_REPLY_BYTES = 4;
const OPEN_DATABASE = "OPEN_DATABASE";

/**
 * Every request seen on the wire, in the order sent, with its relay-side round
 * trip once answered. A request counts where it was sent, so a reply that comes
 * late, such as CON_CLOSE's, is never counted in the next call.
 */
interface Exchange {
  name: string;
  sentAt: number;
  ms?: number;
  /** The scenario that was running when this request's connection opened. */
  owner: string;
}
const exchanges: Exchange[] = [];
/** The scenario running now, which owns any connection opened meanwhile. */
let active = "setup";
let handshakes = 0;

const codeName = (code: number | undefined): string =>
  (code !== undefined && CASFunctionCode[code]) || `FC_${code}`;

/** Splits a byte stream into frames of 4-byte length, 4-byte CAS_INFO and payload. */
function frames(onFrame: (frame: Buffer) => void): (data: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (data) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= 8) {
      const size = 8 + pending.readInt32BE(0);
      if (pending.length < size) {
        break;
      }
      onFrame(pending.subarray(0, size));
      pending = pending.subarray(size);
    }
  };
}

/** A relay to the broker. `kill()` drops every connection it carries, as a network failure would. */
async function startRelay(): Promise<{ port: number; kill: () => void; close: () => void }> {
  const live = new Set<Socket>();
  const proxy = createServer((client) => {
    const server = netConnect(brokerPort, brokerHost);
    live.add(client);
    handshakes += 1;
    // Requests waiting for their reply, oldest first.
    const waiting: Exchange[] = [];
    const owner = active;
    const sent = (name: string): void => {
      const exchange = { name, sentAt: performance.now(), owner };
      exchanges.push(exchange);
      waiting.push(exchange);
    };
    let requestSkip = HANDSHAKE_BYTES;
    let replySkip = BROKER_REPLY_BYTES;

    const onRequest = frames((frame) => {
      sent(codeName(frame[8]));
    });
    const onReply = frames(() => {
      const request = waiting.shift();
      if (request) {
        request.ms = performance.now() - request.sentAt;
      }
    });

    client.on("data", (chunk: Buffer) => {
      server.write(chunk);
      let data = chunk;
      if (requestSkip > 0) {
        const skipped = Math.min(requestSkip, data.length);
        requestSkip -= skipped;
        data = data.subarray(skipped);
        if (requestSkip === 0) {
          sent(OPEN_DATABASE);
        }
      }
      if (data.length > 0) {
        onRequest(data);
      }
    });
    server.on("data", (chunk: Buffer) => {
      client.write(chunk);
      let data = chunk;
      if (replySkip > 0) {
        const skipped = Math.min(replySkip, data.length);
        replySkip -= skipped;
        data = data.subarray(skipped);
      }
      if (data.length > 0) {
        onReply(data);
      }
    });
    const end = (): void => {
      live.delete(client);
      client.destroy();
      server.destroy();
    };
    client.on("close", end);
    server.on("close", end);
    client.on("error", end);
    server.on("error", end);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
  const address = proxy.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    kill: () => {
      for (const socket of live) {
        socket.destroy();
      }
    },
    close: () => proxy.close(),
  };
}

const relay = await startRelay();
// The reconnect scenario drops its connections, so it has a relay of its own.
const dropRelay = await startRelay();
const config = (port: number) => ({
  host: "127.0.0.1",
  port,
  database: "testdb",
  user: "dba",
  password: "",
});

interface Scenario {
  name: string;
  /** Runs before each measured call, outside the counts and the timing. */
  before?: () => Promise<void>;
  run: () => Promise<unknown>;
  /** Runs after each measured call, outside the counts and the timing. */
  after?: () => Promise<void>;
}

let nextId = 1_000_000;
const byKey = `SELECT id, name FROM ${table} WHERE id = ?`;
const insert = `INSERT INTO ${table} (id, name) VALUES (?, ?)`;
const fresh = (): CubridClient => createClient(config(relay.port));

const clients: CubridClient[] = [];
const warm = (): CubridClient => {
  const client = fresh();
  clients.push(client);
  return client;
};
const selectClient = warm();
const scanClient = warm();
const insertClient = warm();
const updateClient = warm();
const preparedSelectClient = warm();
const preparedInsertClient = warm();
const batchClient = warm();
const transactionClient = warm();
const streamClient = warm();
const earlyStopClient = warm();
const reconnectClient = createClient(config(dropRelay.port));
clients.push(reconnectClient);
const pool: CubridPool = createPool({ ...config(relay.port), max: 1, idleTimeoutMs: 0 });

let cold: CubridClient | null = null;
const scenarios: Scenario[] = [
  {
    name: "cold: new client, query() SELECT by key",
    before: async () => {
      cold = fresh();
    },
    run: () => (cold ?? fresh()).query(byKey, [1]),
    after: async () => {
      await cold?.close();
      cold = null;
    },
  },
  { name: "query() SELECT by key", run: () => selectClient.query(byKey, [nextId % 1000]) },
  {
    name: "query() SELECT 1000 rows",
    run: () => scanClient.query(`SELECT id, name FROM ${table} WHERE id < ?`, [1000]),
  },
  { name: "execute() INSERT", run: () => insertClient.execute(insert, [nextId++, "n"]) },
  {
    name: "execute() UPDATE by key",
    run: () => updateClient.execute(`UPDATE ${table} SET name = ? WHERE id = ?`, ["u", 1]),
  },
  {
    name: "queryPrepared() SELECT by key",
    run: () => preparedSelectClient.queryPrepared(byKey, [2]),
  },
  {
    name: "executePrepared() INSERT",
    run: () => preparedInsertClient.executePrepared(insert, [nextId++, "p"]),
  },
  {
    name: "executeMany() INSERT of 10 rows",
    run: () =>
      batchClient.executeMany(
        insert,
        Array.from({ length: 10 }, () => [nextId++, "m"]),
      ),
  },
  {
    name: "transaction(): SELECT + INSERT, commit",
    run: () =>
      transactionClient.transaction(async (tx) => {
        await tx.query(byKey, [3]);
        await tx.execute(insert, [nextId++, "t"]);
      }),
  },
  {
    name: "stream() 1000 rows, fetchSize 100",
    run: async () => {
      for await (const _row of streamClient.stream(
        `SELECT id, name FROM ${table} WHERE id < ?`,
        [1000],
        { fetchSize: 100 },
      )) {
        // Consume every row.
      }
    },
  },
  {
    name: "stream() stopped after 1 of 1000 rows",
    run: async () => {
      for await (const _row of earlyStopClient.stream(
        `SELECT id, name FROM ${table} WHERE id < ?`,
        [1000],
        { fetchSize: 100 },
      )) {
        break;
      }
    },
  },
  {
    name: "reconnect: query() after the socket was dropped",
    before: async () => {
      dropRelay.kill();
      // Let the driver see the close before it sends anything.
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    run: () => reconnectClient.query(byKey, [4]),
  },
  { name: "pool.query() SELECT by key", run: () => pool.query(byKey, [5]) },
  { name: "pool.execute() INSERT", run: () => pool.execute(insert, [nextId++, "o"]) },
];

interface Tally {
  times: number[];
  totals: number[];
  handshakes: number[];
  /** The function codes of the last run, in order. */
  sequence: string[];
}

const percentile = (sorted: number[], share: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? Number.NaN;
const range = (values: number[]): string => {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? `${low}` : `${low}–${high}`;
};

/** Collapses repeats: FETCH, FETCH, FETCH becomes FETCH ×3. */
function describe(sequence: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < sequence.length; ) {
    let j = i;
    while (sequence[j] === sequence[i]) j += 1;
    parts.push(j - i > 1 ? `${sequence[i]} ×${j - i}` : `${sequence[i]}`);
    i = j;
  }
  return parts.join(", ");
}

try {
  const setup = fresh();
  clients.push(setup);
  await setup.query(`DROP TABLE IF EXISTS ${table}`);
  await setup.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(40))`);
  const seed = Array.from({ length: 1000 }, (_, i) => `(${i}, 'name')`).join(", ");
  await setup.query(`INSERT INTO ${table} (id, name) VALUES ${seed}`);
  const version = await setup.getServerVersion();

  // One call each, so the measured calls find an open session and a known
  // backslash mode, as a running application's would.
  for (const scenario of scenarios.slice(1)) {
    active = scenario.name;
    await scenario.before?.();
    await scenario.run();
    await scenario.after?.();
  }

  const tallies = new Map<Scenario, Tally>(
    scenarios.map((s) => [s, { times: [], totals: [], handshakes: [], sequence: [] }]),
  );
  exchanges.length = 0;
  const lateCloses = new Map<string, number>();
  for (let round = 0; round < rounds; round += 1) {
    // Rotating the start each round spreads any cost of going first.
    const first = round % scenarios.length;
    for (const [scenario, tally] of [...tallies]
      .slice(first)
      .concat([...tallies].slice(0, first))) {
      active = scenario.name;
      await scenario.before?.();
      const firstExchange = exchanges.length;
      const firstHandshake = handshakes;
      const start = performance.now();
      await scenario.run();
      tally.times.push(performance.now() - start);
      // A connection can send CON_CLOSE after the call that closed it has
      // returned; it belongs to that call's scenario, not to this one.
      const seen: string[] = [];
      for (const { name, owner } of exchanges.slice(firstExchange)) {
        if (name === "CON_CLOSE" && owner !== scenario.name) {
          lateCloses.set(owner, (lateCloses.get(owner) ?? 0) + 1);
        } else {
          seen.push(name);
        }
      }
      tally.totals.push(seen.length);
      tally.handshakes.push(handshakes - firstHandshake);
      tally.sequence = seen;
      await scenario.after?.();
    }
  }

  console.log(`server ${version}; ${rounds} rounds`);
  console.log("");
  // Measured at the relay, from a request's last byte to its reply's last byte:
  // the broker's share of each exchange, without the driver's.
  console.log("| Function code | Exchanges | Median round trip | p95 round trip |");
  console.log("| --- | ---: | ---: | ---: |");
  const byCode = new Map<string, number[]>();
  for (const { name, ms } of exchanges) {
    if (ms === undefined) continue;
    byCode.set(name, [...(byCode.get(name) ?? []), ms]);
  }
  for (const [name, times] of [...byCode].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = times.sort((a, b) => a - b);
    console.log(
      `| ${name} | ${sorted.length} | ${percentile(sorted, 0.5).toFixed(2)} ms | ` +
        `${percentile(sorted, 0.95).toFixed(2)} ms |`,
    );
  }
  console.log("");
  console.log("| Call | Requests | TCP connects | Sequence | Median | p95 |");
  console.log("| --- | ---: | ---: | --- | ---: | ---: |");
  for (const [scenario, tally] of tallies) {
    const sorted = [...tally.times].sort((a, b) => a - b);
    const ms = (value: number): string => `${value.toFixed(2)} ms`;
    console.log(
      `| ${scenario.name} | ${range(tally.totals)} | ${range(tally.handshakes)} | ` +
        `${describe(tally.sequence)} | ${ms(percentile(sorted, 0.5))} | ${ms(percentile(sorted, 0.95))} |`,
    );
  }
  for (const [owner, count] of lateCloses) {
    console.log(
      `\nCON_CLOSE of a connection "${owner}" opened, seen during a later call ` +
        `and not counted there: ${count} of ${rounds}`,
    );
  }
} finally {
  const cleanup = createClient(config(brokerPort));
  await cleanup.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
  await cleanup.close();
  await pool.close();
  for (const client of clients) {
    await client.close().catch(() => undefined);
  }
  relay.close();
  dropRelay.close();
}
