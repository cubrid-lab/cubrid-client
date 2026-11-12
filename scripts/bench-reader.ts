// Measures what the per-read socket listeners of CASConnection cost (#253).
//
// Each framed read attaches data/error/close/end listeners and removes them
// again. This drives the real CASConnection.recv() against an in-memory socket
// with each reader of bench-reader-variants.ts. All of them go through the same
// readFrame() and withReadTimeout() code, so the differences are the listener
// churn and chunk handling only. No network is involved.
//
//   node --import tsx --expose-gc scripts/bench-reader.ts [rounds]
import { PerformanceObserver, performance } from "node:perf_hooks";
import { Duplex } from "node:stream";

import { CASConnection } from "../src/protocol/connection.js";
import { type Mode, useReader } from "./bench-reader-variants.js";

const rounds = Number(process.argv[2] ?? 5);
const KiB = 1024;
const MiB = 1024 * KiB;

class FakeSocket extends Duplex {
  attached = 0;
  detached = 0;

  override _read(): void {}

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    callback();
  }

  setTimeout(): this {
    return this;
  }

  constructor() {
    super();
    // Counted from the events. Only differences are reported.
    this.on("newListener", () => {
      this.attached += 1;
    });
    this.on("removeListener", () => {
      this.detached += 1;
    });
  }
}

interface Internals {
  socket: FakeSocket | null;
  connected: boolean;
}

function frame(bodyBytes: number): Buffer {
  const out = Buffer.alloc(4 + 4 + bodyBytes);
  out.writeInt32BE(bodyBytes, 0);
  return out;
}

function split(buffer: Buffer, size: number): Buffer[] {
  const parts: Buffer[] = [];
  for (let at = 0; at < buffer.length; at += size) {
    parts.push(buffer.subarray(at, at + size));
  }
  return parts;
}

interface Scenario {
  name: string;
  frames: number;
  /** The chunks one reply arrives in, as the socket would deliver them. */
  chunks: Buffer[];
}

const scenarios: Scenario[] = [
  // A primary-key SELECT or an END_TRAN: one short reply in one chunk.
  { name: "short reply, 1 chunk (64 B)", frames: 200_000, chunks: [frame(56)] },
  // The same reply split so that DATA_LENGTH itself is fragmented.
  {
    name: "short reply, 3 chunks (64 B)",
    frames: 200_000,
    chunks: [frame(56).subarray(0, 2), frame(56).subarray(2, 9), frame(56).subarray(9)],
  },
  // A FETCH window of 1000 rows of about 100 bytes, in 64 KiB socket reads.
  {
    name: "1000-row FETCH (~100 KiB, 64 KiB chunks)",
    frames: 5_000,
    chunks: split(frame(100 * KiB), 64 * KiB),
  },
  // A FETCH window of 1000 rows in 16 KiB TLS records.
  {
    name: "1000-row FETCH (~100 KiB, 16 KiB chunks)",
    frames: 5_000,
    chunks: split(frame(100 * KiB), 16 * KiB),
  },
  // One 64 MiB row.
  { name: "64 MiB reply, 64 KiB chunks", frames: 8, chunks: split(frame(64 * MiB), 64 * KiB) },
];

let gcCount = 0;
let gcMs = 0;
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcCount += 1;
    gcMs += entry.duration;
  }
}).observe({ entryTypes: ["gc"] });

async function run(scenario: Scenario, mode: Mode) {
  const cas = new CASConnection({
    host: "127.0.0.1",
    port: 1,
    database: "x",
    user: "x",
    password: "",
    maxFrameLength: 128 * MiB,
  });
  const internals = cas as unknown as Internals;
  const socket = new FakeSocket();
  internals.socket = socket;
  internals.connected = true;
  useReader(mode);
  const attachedBefore = socket.attached;
  const detachedBefore = socket.detached;

  (globalThis as { gc?: () => void }).gc?.();
  await new Promise((resolve) => setImmediate(resolve));
  const gcBefore = [gcCount, gcMs] as const;
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < scenario.frames; i += 1) {
    const reply = cas.recv();
    for (const chunk of scenario.chunks) {
      socket.push(chunk);
      // A socket delivers each read from its own I/O callback, and Node.js runs
      // every pending tick and microtask before the next one. The per-read reader
      // depends on that: a chunk pushed in the same tick as the one completing
      // DATA_LENGTH reaches no listener and is lost, so this waits a macrotask.
      await new Promise((resolve) => setImmediate(resolve));
    }
    await reply;
  }
  const wall = performance.now() - start;
  const used = process.cpuUsage(cpu);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    usPerFrame: (wall * 1000) / scenario.frames,
    cpuUsPerFrame: (used.user + used.system) / scenario.frames,
    listenersPerFrame:
      (socket.attached - attachedBefore + socket.detached - detachedBefore) / scenario.frames,
    gcs: gcCount - gcBefore[0],
    gcMs: gcMs - gcBefore[1],
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

console.log(`node ${process.version}, ${rounds} rounds, medians`);
console.log("| Scenario | Reader | µs/frame | CPU µs/frame | listener calls/frame | GCs | GC ms |");
console.log("|---|---|---:|---:|---:|---:|---:|");
const modes: Mode[] = ["per-read", "per-read-nocopy", "framed"];
for (const scenario of scenarios) {
  const results = new Map<Mode, Awaited<ReturnType<typeof run>>[]>(modes.map((m) => [m, []]));
  for (const mode of modes) {
    await run({ ...scenario, frames: Math.max(1, scenario.frames / 10) }, mode);
  }
  // Rotate the order each round so that host load falls on every reader.
  for (let round = 0; round < rounds; round += 1) {
    for (let k = 0; k < modes.length; k += 1) {
      const mode = modes[(round + k) % modes.length] ?? "framed";
      results.get(mode)?.push(await run(scenario, mode));
    }
  }
  for (const [name, list] of results) {
    console.log(
      `| ${scenario.name} | ${name} | ${median(list.map((r) => r.usPerFrame)).toFixed(2)} | ` +
        `${median(list.map((r) => r.cpuUsPerFrame)).toFixed(2)} | ` +
        `${median(list.map((r) => r.listenersPerFrame)).toFixed(1)} | ` +
        `${median(list.map((r) => r.gcs))} | ${median(list.map((r) => r.gcMs)).toFixed(1)} |`,
    );
  }
}
