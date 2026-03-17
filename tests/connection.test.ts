import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket as NetSocket } from "node:net";

import { CASConnection, type CASConnectionConfig } from "../src/protocol/connection.js";
import {
  CAS_MAGIC,
  CAS_VERSION,
  CLIENT_JDBC,
  SIZE_CAS_INFO,
  SIZE_DATA_LENGTH,
  SIZE_BROKER_INFO,
  CAS_PROTOCOL_VERSION,
} from "../src/protocol/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: CASConnectionConfig = {
  host: "127.0.0.1",
  port: 0, // overridden per test
  database: "testdb",
  user: "dba",
  password: "",
};

/**
 * Build a valid OpenDatabase response payload.
 * Format: [CAS_INFO:4][responseCode:int32][brokerInfo:8][sessionId:int32]
 */
function buildOpenDbResponse(sessionId: number, serverProtoVersion = 7): Buffer {
  const casInfo = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const responseCode = Buffer.alloc(4);
  responseCode.writeInt32BE(0, 0); // success

  const brokerInfo = Buffer.alloc(SIZE_BROKER_INFO);
  // byte[4] contains the server version (low 6 bits)
  brokerInfo[4] = serverProtoVersion & 0x3f;

  const sessId = Buffer.alloc(4);
  sessId.writeInt32BE(sessionId, 0);

  return Buffer.concat([casInfo, responseCode, brokerInfo, sessId]);
}

/**
 * Frame a response with DATA_LENGTH prefix.
 * The body is [CAS_INFO:4][payload].
 * DATA_LENGTH = body.length - CAS_INFO
 */
function frameResponse(body: Buffer): Buffer {
  const dataLength = body.length - SIZE_CAS_INFO;
  const header = Buffer.alloc(SIZE_DATA_LENGTH);
  header.writeInt32BE(dataLength, 0);
  return Buffer.concat([header, body]);
}

/**
 * Creates a local TCP server that mimics the CUBRID broker.
 * Returns the server and its assigned port.
 */
function createMockBroker(
  handler: (socket: NetSocket) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// connect() — full handshake
// ---------------------------------------------------------------------------

test("CASConnection connect — reuse broker socket (newPort=0)", async () => {
  const { server, port } = await createMockBroker((socket) => {
    // Step 1: Read 10-byte ClientInfoExchange
    socket.once("data", (data) => {
      assert.equal(data.length, 10);
      assert.equal((data as Buffer).subarray(0, 5).toString("ascii"), CAS_MAGIC);
      assert.equal(data[5], CLIENT_JDBC);
      assert.equal(data[6], CAS_VERSION);

      // Step 2: Send redirect port = 0 (reuse this socket)
      const portBuf = Buffer.alloc(4);
      portBuf.writeInt32BE(0, 0);
      socket.write(portBuf);

      // Step 3: Read 628-byte OpenDatabase request
      socket.once("data", (_openDbData) => {
        // Step 4: Send framed OpenDatabase response
        const body = buildOpenDbResponse(99);
        const framed = frameResponse(body);
        socket.write(framed);
      });
    });
  });

  try {
    const cas = new CASConnection({ ...DEFAULT_CONFIG, port });
    await cas.connect();

    assert.equal(cas.isConnected, true);
    assert.equal(cas.sessionId, 99);
    assert.ok(cas.protoVersion <= CAS_PROTOCOL_VERSION);
    assert.equal(cas.casInfo.length, SIZE_CAS_INFO);

    await cas.close();
    assert.equal(cas.isConnected, false);
  } finally {
    await closeServer(server);
  }
});

test("CASConnection accepts connection URL string", async () => {
  const { server, port } = await createMockBroker((socket) => {
    socket.once("data", () => {
      const portBuf = Buffer.alloc(4);
      portBuf.writeInt32BE(0, 0);
      socket.write(portBuf);

      socket.once("data", () => {
        socket.write(frameResponse(buildOpenDbResponse(77)));
      });
    });
  });

  try {
    const cas = new CASConnection(`cubrid://dba:%40pw@127.0.0.1:${port}/testdb`);
    await cas.connect();

    assert.equal(cas.isConnected, true);
    assert.equal(cas.sessionId, 77);

    await cas.close();
  } finally {
    await closeServer(server);
  }
});

test("CASConnection connect — redirect to new port (newPort > 0)", async () => {
  // Create the CAS server that will receive the redirected connection
  const { server: casServer, port: casPort } = await createMockBroker((socket) => {
    // CAS receives the OpenDatabase request directly
    socket.once("data", (_openDbData) => {
      const body = buildOpenDbResponse(42);
      const framed = frameResponse(body);
      socket.write(framed);
    });
  });

  // Create the broker that redirects to casPort
  const { server: broker, port: brokerPort } = await createMockBroker((socket) => {
    socket.once("data", (_data) => {
      // Send redirect port = casPort
      const portBuf = Buffer.alloc(4);
      portBuf.writeInt32BE(casPort, 0);
      socket.write(portBuf);
    });
  });

  try {
    const cas = new CASConnection({ ...DEFAULT_CONFIG, port: brokerPort });
    await cas.connect();

    assert.equal(cas.isConnected, true);
    assert.equal(cas.sessionId, 42);

    await cas.close();
  } finally {
    await closeServer(broker);
    await closeServer(casServer);
  }
});

test("CASConnection connect — negative redirect port rejects", async () => {
  const { server, port } = await createMockBroker((socket) => {
    socket.once("data", () => {
      const portBuf = Buffer.alloc(4);
      portBuf.writeInt32BE(-1, 0); // rejection
      socket.write(portBuf);
    });
  });

  try {
    const cas = new CASConnection({ ...DEFAULT_CONFIG, port });
    await assert.rejects(
      () => cas.connect(),
      (err: Error) => {
        assert.match(err.message, /broker rejected/);
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test("CASConnection connect — already connected is a no-op", async () => {
  const { server, port } = await createMockBroker((socket) => {
    socket.once("data", () => {
      const portBuf = Buffer.alloc(4);
      portBuf.writeInt32BE(0, 0);
      socket.write(portBuf);

      socket.once("data", () => {
        const body = buildOpenDbResponse(1);
        socket.write(frameResponse(body));
      });
    });
  });

  try {
    const cas = new CASConnection({ ...DEFAULT_CONFIG, port });
    await cas.connect();
    // Second connect should be a no-op
    await cas.connect();
    assert.equal(cas.isConnected, true);
    await cas.close();
  } finally {
    await closeServer(server);
  }
});

test("CASConnection connect — connection timeout", { timeout: 5000 }, async () => {
  // Use a non-routable IP (TEST-NET-1, RFC 5737) that will silently drop packets,
  // causing a real TCP-level timeout.
  const cas = new CASConnection({
    ...DEFAULT_CONFIG,
    host: "192.0.2.1",
    port: 33000,
    connectionTimeout: 200,
  });
  await assert.rejects(
    () => cas.connect(),
    (err: Error) => {
      assert.match(err.message, /timed out|ETIMEDOUT|Failed to connect/i);
      return true;
    },
  );
});

test("CASConnection connect — socket error (ECONNREFUSED)", async () => {
  // Port 19999 — nothing listening
  const cas = new CASConnection({ ...DEFAULT_CONFIG, port: 19999 });
  await assert.rejects(
    () => cas.connect(),
    (err: Error) => {
      assert.match(err.message, /Failed to connect/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// send() / recv() / sendAndRecv()
// ---------------------------------------------------------------------------

test("CASConnection send throws when not connected", async () => {
  const cas = new CASConnection(DEFAULT_CONFIG);
  await assert.rejects(
    () => cas.send(Buffer.alloc(8), Buffer.alloc(4)),
    (err: Error) => {
      assert.match(err.message, /not connected/);
      return true;
    },
  );
});

test("CASConnection recv throws when not connected", async () => {
  const cas = new CASConnection(DEFAULT_CONFIG);
  await assert.rejects(
    () => cas.recv(),
    (err: Error) => {
      assert.match(err.message, /not connected/);
      return true;
    },
  );
});

test("CASConnection sendAndRecv round-trip", async () => {
  const { server, port } = await createMockBroker((socket) => {
    // Handshake
    socket.once("data", () => {
      const portBuf = Buffer.alloc(4);
      portBuf.writeInt32BE(0, 0);
      socket.write(portBuf);

      socket.once("data", () => {
        const body = buildOpenDbResponse(1);
        socket.write(frameResponse(body));

        // Now handle the actual sendAndRecv request
        socket.once("data", (_reqData) => {
          // Build a response: CAS_INFO(4) + payload("OK\0")
          const casInfo = Buffer.from([0x10, 0x20, 0x30, 0x40]);
          const payload = Buffer.from("OK\0", "utf-8");
          const responseBody = Buffer.concat([casInfo, payload]);
          const framed = frameResponse(responseBody);
          socket.write(framed);
        });
      });
    });
  });

  try {
    const cas = new CASConnection({ ...DEFAULT_CONFIG, port });
    await cas.connect();

    const result = await cas.sendAndRecv(Buffer.alloc(8), Buffer.from([0x01]));
    // sendAndRecv strips CAS_INFO, returns payload only
    assert.equal(result.toString("utf-8"), "OK\0");
    // CAS_INFO should be updated
    assert.deepEqual([...cas.casInfo], [0x10, 0x20, 0x30, 0x40]);

    await cas.close();
  } finally {
    await closeServer(server);
  }
});

test("CASConnection recv handles chunked data", async () => {
  const { server, port } = await createMockBroker((socket) => {
    // Handshake
    socket.once("data", () => {
      const portBuf = Buffer.alloc(4);
      portBuf.writeInt32BE(0, 0);
      socket.write(portBuf);

      socket.once("data", () => {
        const body = buildOpenDbResponse(1);
        socket.write(frameResponse(body));

        // Handle sendAndRecv — send response in chunks
        socket.once("data", () => {
          const casInfo = Buffer.from([0x01, 0x02, 0x03, 0x04]);
          const payload = Buffer.from("CHUNKED\0", "utf-8");
          const responseBody = Buffer.concat([casInfo, payload]);
          const dataLen = responseBody.length - SIZE_CAS_INFO;

          const header = Buffer.alloc(4);
          header.writeInt32BE(dataLen, 0);

          // Send header first
          socket.write(header);
          // Send body in 2 chunks with delay
          setTimeout(() => {
            socket.write(responseBody.subarray(0, 4));
            setTimeout(() => {
              socket.write(responseBody.subarray(4));
            }, 10);
          }, 10);
        });
      });
    });
  });

  try {
    const cas = new CASConnection({ ...DEFAULT_CONFIG, port });
    await cas.connect();

    const result = await cas.sendAndRecv(Buffer.alloc(8), Buffer.from([0x01]));
    assert.equal(result.toString("utf-8"), "CHUNKED\0");

    await cas.close();
  } finally {
    await closeServer(server);
  }
});

test("CASConnection recv rejects on socket close", async () => {
  const { server, port } = await createMockBroker((socket) => {
    // Handshake
    socket.once("data", () => {
      const portBuf = Buffer.alloc(4);
      portBuf.writeInt32BE(0, 0);
      socket.write(portBuf);

      socket.once("data", () => {
        const body = buildOpenDbResponse(1);
        socket.write(frameResponse(body));

        // When next request arrives, close the socket
        socket.once("data", () => {
          socket.destroy();
        });
      });
    });
  });

  try {
    const cas = new CASConnection({ ...DEFAULT_CONFIG, port });
    await cas.connect();

    await assert.rejects(
      () => cas.sendAndRecv(Buffer.alloc(8), Buffer.from([0x01])),
      (err: Error) => {
        assert.match(err.message, /closed|ended/i);
        return true;
      },
    );

    await cas.close();
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

test("CASConnection close is a no-op when no socket", async () => {
  const cas = new CASConnection(DEFAULT_CONFIG);
  // Should not throw
  await cas.close();
  assert.equal(cas.isConnected, false);
});

test("CASConnection close destroys socket and resets state", async () => {
  const { server, port } = await createMockBroker((socket) => {
    socket.once("data", () => {
      const portBuf = Buffer.alloc(4);
      portBuf.writeInt32BE(0, 0);
      socket.write(portBuf);

      socket.once("data", () => {
        const body = buildOpenDbResponse(1);
        socket.write(frameResponse(body));
      });
    });
  });

  try {
    const cas = new CASConnection({ ...DEFAULT_CONFIG, port });
    await cas.connect();
    assert.equal(cas.isConnected, true);

    await cas.close();
    assert.equal(cas.isConnected, false);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// recvExact — buffered data path
// ---------------------------------------------------------------------------

test("CASConnection recvExact resolves from buffered data", async () => {
  const { server, port } = await createMockBroker((socket) => {
    // Handshake
    socket.once("data", () => {
      const portBuf = Buffer.alloc(4);
      portBuf.writeInt32BE(0, 0);
      socket.write(portBuf);

      socket.once("data", () => {
        const body = buildOpenDbResponse(1);
        socket.write(frameResponse(body));

        // Send two responses concatenated (simulates buffered data)
        socket.once("data", () => {
          // Response 1
          const casInfo1 = Buffer.from([0x01, 0x02, 0x03, 0x04]);
          const payload1 = Buffer.from("FIRST\0", "utf-8");
          const body1 = Buffer.concat([casInfo1, payload1]);

          // Response 2
          const casInfo2 = Buffer.from([0x05, 0x06, 0x07, 0x08]);
          const payload2 = Buffer.from("SECOND\0", "utf-8");
          const body2 = Buffer.concat([casInfo2, payload2]);

          const framed1 = frameResponse(body1);
          const framed2 = frameResponse(body2);

          // Send both concatenated — tests the buffered data path
          socket.write(Buffer.concat([framed1, framed2]));
        });
      });
    });
  });

  try {
    const cas = new CASConnection({ ...DEFAULT_CONFIG, port });
    await cas.connect();

    // First send+recv
    await cas.send(Buffer.alloc(8), Buffer.from([0x01]));
    const result1 = await cas.recv();
    // result1 = CAS_INFO + payload
    const payload1 = result1.subarray(SIZE_CAS_INFO).toString("utf-8");
    assert.equal(payload1, "FIRST\0");

    // Second recv (from buffered data)
    const result2 = await cas.recv();
    const payload2 = result2.subarray(SIZE_CAS_INFO).toString("utf-8");
    assert.equal(payload2, "SECOND\0");

    await cas.close();
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

test("CASConnection default getter values before connect", () => {
  const cas = new CASConnection(DEFAULT_CONFIG);
  assert.equal(cas.isConnected, false);
  assert.equal(cas.sessionId, 0);
  assert.equal(cas.protoVersion, 1);
  assert.equal(cas.casInfo.length, SIZE_CAS_INFO);
});
