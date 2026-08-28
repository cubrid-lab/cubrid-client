import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket as NetSocket } from "node:net";
import { TLSSocket } from "node:tls";

import { CASConnection, type CASConnectionConfig } from "../src/protocol/connection.js";
import { writeClientInfoExchange } from "../src/protocol/protocol.js";
import {
  CAS_MAGIC,
  CAS_MAGIC_SSL,
  SIZE_CAS_INFO,
  SIZE_DATA_LENGTH,
  SIZE_BROKER_INFO,
} from "../src/protocol/constants.js";

// ---------------------------------------------------------------------------
// Self-signed cert/key for CN=localhost (SAN: localhost, 127.0.0.1).
// Test-only material — never used in production.
// ---------------------------------------------------------------------------

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUT7A/QXh4bIOITsnFxo8edUHtj5wwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgyNzEzMzI1OVoXDTM2MDgy
NDEzMzI1OVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAp6xBUbk3zPWG9Ex+8/mbG87wK1yQcdYAD9giaabI7WnX
p09xeBlxmajlT8rMUwFu6nw2z5aVP3KNL/AiJfqQnEcAPZ2Fl//mIWUHZbzOfFTk
yuf1W9S236Xpgt6PV7l5PL7JCYxX6uPZ9lj86ckcwGUCp1tHPEeMxDtDjkSKlaoC
u902dRAxb5lk/CenLskZyg5bS3HKchMr+sy7WIYZ+DwSRFZN4HRgQjYFeMls86ZK
3XwN19pU/NTyBDbUVYiq760VyhpSD60cUyXLBNcqhghVC5Csp2FqxIhWLYSItbMA
rclQeqpXiFn3USXULi7FpcmGJ4c3LWLCqhx4ImZxewIDAQABo28wbTAdBgNVHQ4E
FgQUIgpiroR3no4lhRkJBi0aa7ibEBcwHwYDVR0jBBgwFoAUIgpiroR3no4lhRkJ
Bi0aa7ibEBcwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAJTy1mu1iBoGkLwcSk6PSt8fhdrDp2wC
yQVKtjwDJPALkSU7N22aCoTrzhZkYQ3yVv3/vbotf5dc8aY3AjU0PV+0zH1wyEDa
uCZPKFYr4IcEiRCDixXw/VbMo3mbdimIdxJnkZ1w0rZni7K088fAI/i6Ur/WbWIi
LAcdC9JbkKpNebclDNkyiP6LdZo/Rr9tpAvL2gNXufuY4rRn0rpmiTIGNJoTccGP
5D0QUBCJ1R2k8xZbzh+PdvDD2sFIG+H1RZNdGuHNeFt4HV4PZQ2kMQw0TgpbgqsO
9hKok8ao4+ZNAp8ihSCxc/KZYk2Qbz11bYhyAo8sn7JFVWy3Ueu5BWc=
-----END CERTIFICATE-----
`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCnrEFRuTfM9Yb0
TH7z+ZsbzvArXJBx1gAP2CJppsjtadenT3F4GXGZqOVPysxTAW7qfDbPlpU/co0v
8CIl+pCcRwA9nYWX/+YhZQdlvM58VOTK5/Vb1LbfpemC3o9XuXk8vskJjFfq49n2
WPzpyRzAZQKnW0c8R4zEO0OORIqVqgK73TZ1EDFvmWT8J6cuyRnKDltLccpyEyv6
zLtYhhn4PBJEVk3gdGBCNgV4yWzzpkrdfA3X2lT81PIENtRViKrvrRXKGlIPrRxT
JcsE1yqGCFULkKynYWrEiFYthIi1swCtyVB6qleIWfdRJdQuLsWlyYYnhzctYsKq
HHgiZnF7AgMBAAECggEAQenKR7kbAXxnj/PeWESAQB9KdJFPyyBIJ/JcHNJO3F2m
RARL492EtdYaRxK+3caLdqxb06ErjKSYcgbhNbLZVEXpB0+8K7OSIQCZNtpRBblN
s6IZ5v6o4SRUtniNOvwTd9i8KP+9s/3cOiZjTfgcUFmlAGs2hrDN2no9pVi2bfyj
b3JTPSVcY7RsajLsfutyjvk0DChzQkMrwWOhTPqaaPQZ/3aUM/ALKIdIo8AKhMmF
6jA7cQda3WIkNMI8FTGQ9dpwoER3FyRtk/CrBozGt+/KtQBxHilXiw/6TjEP0AjT
tTsSXVZ86jh3iNoi6uOe5tZzsMrxgRa+YuEhhsBWqQKBgQDQhdPC6i5XaIuTnSv4
wS8NiCkOysZNJCkFuNHWL+BI7e7SmdEBj22qn3ynnHBF+kgvr3j+7fcCTMCcU0Q2
glB76yjgmEdgcFJ6bKSDhAeB3ghwOywn/OfrKMarAmUVECV/NvSV4UBMnMzJp2d9
knNcyWpT27lp0q1PAgrBRR6XnwKBgQDN2Wi6U7zDMToxsQcAmLU1zHc9STArpavs
6s+sZ3BaY+BVKd/BZ+NfoKchjeu57hve8jYTvYM3S3rbJwWB/3ss8laS1NNCHShn
r/hDFs7fA1U75s71lLfxnlMwOsJ2ueMLLUBtXe82U6AAP8BtZJuQgPrwhb+mOSFP
blJb0LZIpQKBgQCPLQSc1fzhyYfk4Etb7xFmwjIm1PZZ61U7d46k+ZSPnseX1UOc
RaYwPHf0AkdY1SQRkfOLX0t2ScsKy2WP4+RtYadcp1KDFjybkNNY9iPNeO3kWczU
3CNF5Wab7vYHA2IrukkwTEzBDfzTDV3S6+bINAgM8laaIa0cDbPixpnd0wKBgEmp
bwyeQoIm74gwrSzNeKsTy+emdRJpaqiRLlenfFEcRH61SVjQcFEcEDK1spEKX/bb
/fX6byYuYHxj7liir9VZsxlAB4k1Hexc0B5R3x12991DrvO6kEhqO6KapFQQGOs6
+j8oyh1Kt4rfRWDgC7seLK49bmNxNjZSaC5q9Y/xAoGBAK7G4TC4WzD609Kjrbgr
cqPGeTC+cxqqugd98j4bmh9dPuMqA3tlc/qVXooUnDGDJiBkkccy/iteu+ySyIWj
gYRFhexw3jKK0KlmdRoY83/79r4zVUE677vlXZvfPK8wOJEPBK73+Kzitsdxhah0
q8BaNxDejWF9EBumlRnaZyAg
-----END PRIVATE KEY-----
`;

const DEFAULT_CONFIG: CASConnectionConfig = {
  host: "127.0.0.1",
  port: 0,
  database: "testdb",
  user: "dba",
  password: "",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildOpenDbResponse(sessionId: number, serverProtoVersion = 7): Buffer {
  const casInfo = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const responseCode = Buffer.alloc(4);
  responseCode.writeInt32BE(0, 0);
  const brokerInfo = Buffer.alloc(SIZE_BROKER_INFO);
  brokerInfo[4] = serverProtoVersion & 0x3f;
  const sessId = Buffer.alloc(4);
  sessId.writeInt32BE(sessionId, 0);
  return Buffer.concat([casInfo, responseCode, brokerInfo, sessId]);
}

function frameResponse(body: Buffer): Buffer {
  const dataLength = body.length - SIZE_CAS_INFO;
  const header = Buffer.alloc(SIZE_DATA_LENGTH);
  header.writeInt32BE(dataLength, 0);
  return Buffer.concat([header, body]);
}

function int32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value, 0);
  return buf;
}

/**
 * Mock SSL-enabled CUBRID broker mimicking the confirmed CAS ordering
 * (verified against a live SSL=ON CUBRID 11.2 broker):
 *   1. read 10-byte client-info (asserts "CUBRS" magic)
 *   2. write EXACTLY ONE plaintext 4-byte int (redirect port = 0, reuse socket)
 *   3. immediately TLS-accept (SSL_accept) on the same socket
 *   4. read OpenDatabase over TLS, write framed response over TLS
 *
 * There is NO separate second plaintext "NO_ERROR" int: the single int in
 * step 2 is the only pre-TLS int the client reads.
 */
function createMockSslBroker(opts: {
  sessionId?: number;
}): Promise<{ server: Server; port: number; sawMagic: () => string }> {
  let magicSeen = "";
  return new Promise((resolve) => {
    const server = createServer((socket: NetSocket) => {
      socket.once("data", (clientInfo: Buffer) => {
        magicSeen = clientInfo.subarray(0, 5).toString("ascii");
        // Exactly one plaintext int (redirect/status), then SSL_accept.
        socket.write(int32(0)); // redirect: reuse this socket

        // SSL_accept on the same socket.
        const tls = new TLSSocket(socket, {
          isServer: true,
          cert: TEST_CERT,
          key: TEST_KEY,
        });
        tls.once("secure", () => {
          tls.once("data", () => {
            tls.write(frameResponse(buildOpenDbResponse(opts.sessionId ?? 55)));
          });
        });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, port, sawMagic: () => magicSeen });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// writeClientInfoExchange — magic selection
// ---------------------------------------------------------------------------

test("writeClientInfoExchange emits normal magic by default", () => {
  const buf = writeClientInfoExchange();
  assert.equal(buf.subarray(0, 5).toString("ascii"), CAS_MAGIC);
});

test("writeClientInfoExchange emits SSL magic when useSsl=true", () => {
  const buf = writeClientInfoExchange(true);
  assert.equal(buf.subarray(0, 5).toString("ascii"), CAS_MAGIC_SSL);
  assert.equal(CAS_MAGIC_SSL, "CUBRS");
});

// ---------------------------------------------------------------------------
// TLS handshake
// ---------------------------------------------------------------------------

test("CASConnection connect over TLS — rejectUnauthorized=false", async () => {
  const { server, port, sawMagic } = await createMockSslBroker({ sessionId: 71 });
  try {
    const cas = new CASConnection({
      ...DEFAULT_CONFIG,
      port,
      ssl: true,
      rejectUnauthorized: false,
    });
    await cas.connect();

    assert.equal(cas.isConnected, true);
    assert.equal(cas.sessionId, 71);
    assert.equal(sawMagic(), "CUBRS"); // server saw the SSL magic
    await cas.close();
  } finally {
    await closeServer(server);
  }
});

test("CASConnection connect over TLS — verifies server cert via ca", async () => {
  const { server, port } = await createMockSslBroker({ sessionId: 88 });
  try {
    const cas = new CASConnection({
      ...DEFAULT_CONFIG,
      port,
      ssl: true,
      ca: TEST_CERT,
      servername: "localhost",
    });
    await cas.connect();

    assert.equal(cas.isConnected, true);
    assert.equal(cas.sessionId, 88);
    await cas.close();
  } finally {
    await closeServer(server);
  }
});

test("CASConnection connect over TLS — rejects self-signed cert by default", async () => {
  const { server, port } = await createMockSslBroker({ sessionId: 1 });
  try {
    const cas = new CASConnection({ ...DEFAULT_CONFIG, port, ssl: true });
    await assert.rejects(
      () => cas.connect(),
      (err: Error) => {
        assert.match(err.message, /TLS handshake failed|self.signed|self signed/i);
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test("CASConnection connect over TLS — rejects negative redirect/status code", async () => {
  // The broker signals rejection with a negative redirect/status int in the
  // single pre-TLS read; the client must reject before attempting TLS.
  const server = createServer((socket: NetSocket) => {
    socket.once("data", () => {
      socket.write(int32(-1));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  try {
    const cas = new CASConnection({
      ...DEFAULT_CONFIG,
      port,
      ssl: true,
      rejectUnauthorized: false,
    });
    await assert.rejects(
      () => cas.connect(),
      (err: Error) => {
        assert.match(err.message, /rejected connection/i);
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});
