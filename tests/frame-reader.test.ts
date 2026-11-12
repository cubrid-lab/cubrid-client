/**
 * The session-owned socket reader (#253): FrameReader against an in-memory
 * socket, and CASConnection over loopback TCP and TLS for what depends on a
 * real socket (timeouts, aborts and retirement). The TLS handover is in
 * connection-tls.test.ts.
 */
import assert from "node:assert/strict";
import { createServer, type Socket as NetSocket, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import test from "node:test";

import { ConnectionLostError } from "../src/errors/internal-errors.js";
import { ReadTimeoutError } from "../src/errors/read-timeout-error.js";
import { CASConnection, type CASConnectionConfig } from "../src/protocol/connection.js";
import { SIZE_BROKER_INFO } from "../src/protocol/constants.js";
import { FrameReader, SURPLUS_LIMIT } from "../src/protocol/frame-reader.js";

class FakeSocket extends Duplex {
  override _read(): void {}

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    callback();
  }
}

function fake(): { socket: FakeSocket; reader: FrameReader } {
  const socket = new FakeSocket();
  return { socket, reader: new FrameReader(socket as unknown as Socket) };
}

/** Let the socket deliver what was pushed, as an I/O callback would. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function frame(payload: string): Buffer {
  const body = Buffer.from(payload);
  const out = Buffer.alloc(8 + body.length);
  out.writeInt32BE(body.length, 0);
  body.copy(out, 8);
  return out;
}

/** Read one frame as CASConnection.readFrame() does: DATA_LENGTH, then CAS_INFO + payload. */
async function readFrame(reader: FrameReader): Promise<string> {
  const length = (await reader.read(4)).readInt32BE(0);
  return (await reader.read(length + 4)).subarray(4).toString();
}

// ---------------------------------------------------------------------------
// FrameReader on an in-memory socket
// ---------------------------------------------------------------------------

test("FrameReader joins a frame whose DATA_LENGTH and body arrive in fragments", async () => {
  const { socket, reader } = fake();
  const bytes = frame("fragmented");
  const reply = readFrame(reader);
  const cuts = [0, 1, 3, 6, 9, 13, bytes.length];
  for (let i = 1; i < cuts.length; i += 1) {
    socket.push(bytes.subarray(cuts[i - 1], cuts[i]));
    await tick();
  }
  assert.equal(await reply, "fragmented");
});

test("FrameReader serves several frames from one chunk in order", async () => {
  const { socket, reader } = fake();
  socket.push(Buffer.concat([frame("one"), frame("two"), frame("three")]));
  await tick();
  assert.equal(await readFrame(reader), "one");
  assert.equal(await readFrame(reader), "two");
  assert.equal(await readFrame(reader), "three");
});

test("FrameReader loses no chunk delivered in the same tick as the one ending DATA_LENGTH", async () => {
  // The reader before #253 dropped the second chunk here: its body read had
  // not attached a listener yet when the stream emitted it.
  const { socket, reader } = fake();
  const bytes = frame("x".repeat(100));
  const reply = readFrame(reader);
  socket.push(bytes.subarray(0, 50));
  socket.push(bytes.subarray(50));
  assert.equal(await reply, "x".repeat(100));
});

test("FrameReader keeps surplus bytes for the next read, first in first out", async () => {
  const { socket, reader } = fake();
  const bytes = Buffer.concat([frame("first"), frame("second")]);
  socket.push(bytes.subarray(0, 15));
  await tick();
  assert.equal(await readFrame(reader), "first");
  socket.push(bytes.subarray(15));
  await tick();
  assert.equal(await readFrame(reader), "second");
});

for (const [event, emit, message] of [
  ["close", (s: FakeSocket) => s.destroy(), "Connection closed while reading"],
  ["end", (s: FakeSocket) => s.push(null), "Connection ended while reading"],
  ["error", (s: FakeSocket) => s.destroy(new Error("ECONNRESET")), "ECONNRESET"],
] as const) {
  test(`FrameReader rejects a read cut short by '${event}'`, async () => {
    const { socket, reader } = fake();
    socket.on("error", () => {});
    const read = reader.read(10);
    socket.push(Buffer.alloc(4));
    await tick();
    emit(socket);
    await assert.rejects(read, (error: Error) => {
      assert.ok(error instanceof ConnectionLostError);
      assert.equal(error.message, message);
      return true;
    });
    // Whatever the socket does next, the first failure is the one reported.
    await assert.rejects(reader.read(10), { message });
  });
}

test("FrameReader still serves bytes that arrived before the socket closed", async () => {
  const { socket, reader } = fake();
  socket.push(frame("last words"));
  await tick();
  socket.destroy();
  await tick();
  assert.equal(await readFrame(reader), "last words");
  await assert.rejects(reader.read(1), ConnectionLostError);
});

test("FrameReader rejects at once on a socket already destroyed", async () => {
  const { socket, reader } = fake();
  socket.destroy();
  await assert.rejects(reader.read(4), { message: "Connection closed while reading" });
});

test("FrameReader refuses a second read while one is pending", async () => {
  const { socket, reader } = fake();
  const first = reader.read(4);
  await assert.rejects(reader.read(4), /already pending/);
  socket.push(Buffer.from([0, 0, 0, 7]));
  assert.deepEqual([...(await first)], [0, 0, 0, 7]);
});

test("FrameReader pauses its socket above SURPLUS_LIMIT and resumes it for the next read", async () => {
  const { socket, reader } = fake();
  socket.push(Buffer.alloc(SURPLUS_LIMIT));
  await tick();
  assert.equal(socket.isPaused(), false);
  socket.push(Buffer.alloc(1));
  await tick();
  assert.equal(socket.isPaused(), true);

  // Satisfied from what is held: the socket stays paused.
  await reader.read(1);
  assert.equal(socket.isPaused(), true);

  // A read that needs more resumes it.
  const read = reader.read(SURPLUS_LIMIT + 10);
  assert.equal(socket.isPaused(), false);
  socket.push(Buffer.alloc(10));
  assert.equal((await read).length, SURPLUS_LIMIT + 10);
});

test("FrameReader pauses on surplus that arrives with the frame a read was waiting for", async () => {
  const { socket, reader } = fake();
  const read = reader.read(4);
  socket.push(Buffer.alloc(4 + SURPLUS_LIMIT + 1));
  await read;
  assert.equal(socket.isPaused(), true);
});

test("FrameReader dispose() rejects the pending read, drops its bytes and is idempotent", async () => {
  const { socket, reader } = fake();
  socket.push(Buffer.alloc(3));
  await tick();
  const read = reader.read(4);
  reader.dispose();
  reader.dispose();
  await assert.rejects(read, ConnectionLostError);
  await assert.rejects(reader.read(1), ConnectionLostError);
  assert.equal(socket.listenerCount("data"), 0);
  assert.equal(socket.listenerCount("close"), 0);
});

test("FrameReader detach() pauses the socket and hands back the bytes it held", async () => {
  const { socket, reader } = fake();
  socket.push(Buffer.from("int!rest"));
  await tick();
  assert.equal((await reader.read(4)).toString(), "int!");
  assert.equal(reader.detach().toString(), "rest");
  assert.equal(socket.isPaused(), true);
  assert.equal(socket.listenerCount("data"), 0);
  // Bytes that come later stay in the stream for its next owner.
  socket.push(Buffer.from("later"));
  await tick();
  assert.equal(socket.read()?.toString(), "later");
});

// ---------------------------------------------------------------------------
// CASConnection over loopback
// ---------------------------------------------------------------------------

const CONFIG: CASConnectionConfig = {
  host: "127.0.0.1",
  port: 0,
  database: "testdb",
  user: "dba",
  password: "",
};

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function openDbReply(sessionId: number): Buffer {
  const brokerInfo = Buffer.alloc(SIZE_BROKER_INFO);
  brokerInfo[4] = 7;
  const body = Buffer.concat([Buffer.alloc(4), int32(0), brokerInfo, int32(sessionId)]);
  return Buffer.concat([int32(body.length - 4), body]);
}

/** A CAS reply with CAS_INFO in transaction, so no probe precedes the next request. */
function reply(payload: string): Buffer {
  const body = Buffer.from(payload);
  return Buffer.concat([int32(body.length), Buffer.from([1, 0, 0, 0]), body]);
}

/**
 * A broker that answers on the broker socket (redirect 0). `onRequest` gets
 * each request after OPEN_DATABASE with its connection number, from 1.
 */
async function broker(
  onRequest: (socket: NetSocket, connection: number) => void,
): Promise<{ server: Server; port: number }> {
  let connections = 0;
  const server = createServer((socket) => {
    const connection = ++connections;
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write(int32(0));
      socket.once("data", () => {
        socket.write(openDbReply(connection));
        socket.on("data", () => onRequest(socket, connection));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

/** Server-side sockets still open, closed with the server. */
const open = new Set<NetSocket>();

function closeServer(server: Server): Promise<void> {
  for (const socket of open) {
    socket.destroy();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

test("after a read timeout the next session reads only its own replies", {
  timeout: 5000,
}, async () => {
  let stalled: NetSocket | undefined;
  const { server, port } = await broker((socket, connection) => {
    if (connection === 1) {
      // Half a reply, then silence: the read times out.
      stalled = socket;
      socket.write(reply("stale reply").subarray(0, 6));
    } else {
      socket.write(reply("fresh"));
    }
  });

  try {
    const cas = new CASConnection({ ...CONFIG, port, readTimeout: 200 });
    await cas.connect();
    await assert.rejects(cas.sendAndRecv(Buffer.alloc(8), Buffer.from([1])), ReadTimeoutError);

    // The rest of the stale reply is sent; it must not reach the new session.
    stalled?.write(reply("stale reply").subarray(6));
    await cas.connect();
    const answer = await cas.sendAndRecv(Buffer.alloc(8), Buffer.from([1]));
    assert.equal(answer.toString(), "fresh");
    assert.equal(cas.sessionId, 2);
    await cas.close();
  } finally {
    await closeServer(server);
  }
});

test("an aborted read retires its socket, and the next request reads its own reply", {
  timeout: 5000,
}, async () => {
  const { server, port } = await broker((socket, connection) => {
    if (connection === 2) {
      socket.write(reply("after abort"));
    }
  });

  try {
    const cas = new CASConnection({ ...CONFIG, port });
    await cas.connect();
    const controller = new AbortController();
    const reason = new Error("stop");
    const scope = { signal: controller.signal, sent: false, aborted: false };
    const pending = cas.runScoped(scope, () => cas.sendAndRecv(Buffer.alloc(8), Buffer.from([1])));
    setTimeout(() => controller.abort(reason), 50);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(scope.aborted, true);
    assert.equal(cas.isConnected, false);

    await cas.connect();
    const answer = await cas.sendAndRecv(Buffer.alloc(8), Buffer.from([1]));
    assert.equal(answer.toString(), "after abort");
    await cas.close();
  } finally {
    await closeServer(server);
  }
});

test("repeated destroy() and close() settle a read in flight once, and later reads fail at once", {
  timeout: 5000,
}, async () => {
  // The server never answers, so the read is pending in the socket's reader.
  const { server, port } = await broker(() => {});

  try {
    const cas = new CASConnection({ ...CONFIG, port });
    await cas.connect();
    const inFlight = cas.sendAndRecv(Buffer.alloc(8), Buffer.from([1]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    cas.destroy();
    cas.destroy();
    await cas.close();
    await cas.close();
    await assert.rejects(inFlight, (error: Error) => {
      assert.ok(error instanceof ConnectionLostError);
      assert.match(error.message, /destroyed/);
      return true;
    });
    await assert.rejects(cas.recv(), ConnectionLostError);
  } finally {
    await closeServer(server);
  }
});
