/**
 * CAS TCP connection — socket lifecycle, framed send/recv, and broker handshake.
 *
 * Implements the two-step CUBRID connection sequence:
 *   1. Broker handshake — send 10-byte magic, receive redirect port
 *   2. Open database   — send 628-byte credentials, receive session info
 *
 * All subsequent communication uses length-framed packets:
 *   Request:  [DATA_LENGTH:4][CAS_INFO:4][payload]
 *   Response: read 4-byte DATA_LENGTH, then read DATA_LENGTH + CAS_INFO bytes
 */

import { Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { SIZE_CAS_INFO, SIZE_DATA_LENGTH } from "./constants.js";
import { parseConnectionString } from "../utils/connection-string.js";
import {
  writeClientInfoExchange,
  parseClientInfoExchange,
  writeOpenDatabase,
  parseOpenDatabase,
  writeGetDbVersion,
  parseGetDbVersion,
  type OpenDatabaseResult,
} from "./protocol.js";

export interface CASConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeout?: number;
  /**
   * Enable TLS/SSL for the connection. Requires the CUBRID broker to be
   * configured with `SSL=ON` in `cubrid_broker.conf`. When enabled the client
   * sends the SSL magic ("CUBRS") and upgrades the CAS socket to TLS
   * (STARTTLS-style) after the broker redirect, before OpenDatabase.
   * Default: false.
   */
  ssl?: boolean;
  /**
   * Reject connections whose server certificate cannot be verified against the
   * trusted CA set. Default: true (secure by default). CUBRID ships a
   * self-signed server certificate by default, so verification will fail unless
   * you supply `ca`. Setting this to false disables verification and is
   * intended for development/testing only.
   */
  rejectUnauthorized?: boolean;
  /** PEM CA certificate(s) used to verify the server certificate. */
  ca?: string | Buffer;
  /** Server name for SNI and certificate hostname verification. */
  servername?: string;
}

/**
 * Low-level TCP connection to a CUBRID CAS broker.
 *
 * Manages socket lifecycle, the two-step handshake, and framed binary I/O.
 */
export class CASConnection {
  private socket: Socket | TLSSocket | null = null;
  private connected = false;
  private socketDead = false;
  private _casInfo: Buffer = Buffer.alloc(SIZE_CAS_INFO);
  private _protoVersion = 1;
  private _sessionId = 0;
  private receiveBuffer: Buffer = Buffer.alloc(0);

  /**
   * Per-instance FIFO serialization queue. Public entry points that mutate
   * shared socket / buffer / CAS_INFO state (connect, sendAndRecv, close) are
   * chained through this tail promise so concurrent callers run strictly
   * one-at-a-time. The chain must NEVER reject: a rejected op is swallowed
   * here so it cannot poison subsequent queued operations.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly config: CASConnectionConfig;

  constructor(config: CASConnectionConfig | string) {
    this.config = typeof config === "string" ? parseConnectionString(config) : config;
  }

  /**
   * Perform broker handshake and open database.
   *
   * Queued: serialized against other public operations on this instance.
   */
  async connect(): Promise<void> {
    return this.enqueue(() => this.connectUnlocked());
  }

  /** Unlocked connect body. MUST only be called from within the queue. */
  private async connectUnlocked(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.socketDead = false;

    // Step 1: Connect to broker and send ClientInfoExchange
    const brokerSocket = await this.createSocket(this.config.host, this.config.port);

    try {
      await this.socketWrite(brokerSocket, writeClientInfoExchange(this.config.ssl));

      // Step 2: Receive redirect port (4 bytes)
      const portData = await this.recvExact(brokerSocket, SIZE_DATA_LENGTH);
      const newPort = parseClientInfoExchange(portData);

      if (newPort < 0) {
        brokerSocket.destroy();
        throw new Error(`CUBRID broker rejected connection (code: ${newPort})`);
      }

      // Step 3: If port > 0, connect to CAS on new port; if 0, reuse broker socket
      if (newPort > 0) {
        brokerSocket.destroy();
        this.socket = await this.createSocket(this.config.host, newPort);
      } else {
        this.socket = brokerSocket;
      }

      // Step 3.5 (SSL only): STARTTLS-style upgrade on the resolved CAS socket.
      // Per CUBRID source (src/broker/cas_common_main.c) the CAS sends a
      // plaintext 4-byte NO_ERROR int, then runs SSL_accept, then reads the
      // OpenDatabase credentials over TLS. This step is SSL-only; the non-SSL
      // path is intentionally left byte-for-byte unchanged.
      if (this.config.ssl) {
        this.socket = await this.upgradeToTls(this.socket);
      }

      // Step 4: Send OpenDatabase (628 bytes, unframed)
      await this.socketWrite(
        this.socket,
        writeOpenDatabase(this.config.database, this.config.user, this.config.password),
      );

      // Step 5: Receive framed OpenDatabase response
      const dataLengthBuf = await this.recvExact(this.socket, SIZE_DATA_LENGTH);
      const dataLength = dataLengthBuf.readInt32BE(0);
      const responseBody = await this.recvExact(this.socket, dataLength + SIZE_CAS_INFO);

      const result: OpenDatabaseResult = parseOpenDatabase(responseBody);
      this._casInfo = result.casInfo;
      this._protoVersion = result.protoVersion;
      this._sessionId = result.sessionId;
      this.connected = true;
    } catch (error) {
      brokerSocket.destroy();
      if (this.socket && this.socket !== brokerSocket) {
        this.socket.destroy();
        this.socket = null;
      }
      throw error;
    }
  }

  /**
   * Send a framed CAS request (header + payload).
   * Both buffers are written as a single TCP send.
   */
  async send(header: Buffer, payload: Buffer): Promise<void> {
    if (!this.socket || !this.connected) {
      throw new Error("CASConnection is not connected");
    }

    if (this.socketDead) {
      throw new Error("Socket has been closed by the remote side");
    }

    const combined = Buffer.concat([header, payload]);
    await this.socketWrite(this.socket, combined);
  }

  /**
   * Receive a framed CAS response.
   * Reads 4-byte DATA_LENGTH, then reads DATA_LENGTH + CAS_INFO bytes.
   * Returns the body (CAS_INFO + payload) without the DATA_LENGTH prefix.
   */
  async recv(): Promise<Buffer> {
    if (!this.socket || !this.connected) {
      throw new Error("CASConnection is not connected");
    }

    const dataLengthBuf = await this.recvExact(this.socket, SIZE_DATA_LENGTH);
    const dataLength = dataLengthBuf.readInt32BE(0);
    const totalLen = dataLength + SIZE_CAS_INFO;

    return this.recvExact(this.socket, totalLen);
  }

  /**
   * Send request and receive response in one call.
   * Strips the CAS_INFO from the response (first 4 bytes) and returns the payload.
   *
   * Before sending, checks CAS_INFO status and reconnects if the broker
   * has released the CAS process — matching the official CUBRID JDBC
   * driver's `UClientSideConnection.checkReconnect()`.
   */
  async sendAndRecv(header: Buffer, payload: Buffer): Promise<Buffer> {
    return this.enqueue(async () => {
      await this.checkReconnectUnlocked();
      await this.send(header, payload);
      const response = await this.recv();

      // Update CAS_INFO from response
      response.copy(this._casInfo, 0, 0, SIZE_CAS_INFO);

      // Return payload portion (after CAS_INFO)
      return response.subarray(SIZE_CAS_INFO);
    });
  }

  /**
   * Close the connection.
   *
   * Queued: serialized against connect()/sendAndRecv() so it never tears down
   * the socket underneath an in-flight request. An optional `beforeClose` hook
   * runs inside the same queued critical section, immediately before teardown,
   * while the socket is still live — use it to emit a best-effort protocol-level
   * close frame (e.g. CON_CLOSE) atomically with the teardown. The hook is only
   * invoked when a live socket is present; its errors are swallowed.
   */
  async close(beforeClose?: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      if (!this.socket) {
        return;
      }

      if (beforeClose) {
        try {
          await beforeClose();
        } catch {
          // Best-effort — ignore close-frame failures.
        }
      }

      const socket = this.socket;
      this.socket = null;
      this.connected = false;
      this.socketDead = false;
      this.receiveBuffer = Buffer.alloc(0);

      socket.removeAllListeners();
      socket.destroy();
    });
  }

  /**
   * Reconnect to the broker when the CAS has been released.
   *
   * The CUBRID broker sets `CAS_INFO[0]` to `INACTIVE` (0) when the CAS
   * process is no longer reserved for this client (`KEEP_CONNECTION=AUTO`).
   * The official JDBC driver checks this before every request and
   * transparently reconnects.
   */
  private async checkReconnectUnlocked(): Promise<void> {
    if (!this.connected || !this.socket) {
      return;
    }

    if (this._casInfo[0] === CASConnection.CAS_INFO_STATUS_INACTIVE) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
      this.receiveBuffer = Buffer.alloc(0);
      await this.connectUnlocked();
    }
  }

  private static readonly CAS_INFO_STATUS_INACTIVE = 0;

  /**
   * Send GET_DB_VERSION to verify the connection is alive.
   * Returns the server version string on success, throws on failure.
   */
  async ping(): Promise<string> {
    const { header, payload } = writeGetDbVersion(true, this._casInfo);
    const response = await this.sendAndRecv(header, payload);
    return parseGetDbVersion(response);
  }
  /** Current CAS_INFO bytes (echoed back to server on each request). */
  get casInfo(): Buffer {
    return this._casInfo;
  }

  /** Protocol version negotiated during OpenDatabase. */
  get protoVersion(): number {
    return this._protoVersion;
  }

  /** Session ID from OpenDatabase. */
  get sessionId(): number {
    return this._sessionId;
  }

  /** Whether the connection is currently open. */
  get isConnected(): boolean {
    return this.connected;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Chain `fn` onto the per-instance FIFO queue and return its result.
   *
   * `fn` runs only after all previously-queued operations settle. The
   * caller receives the true result/rejection of `fn`, but the internal
   * queue tail always resolves (rejections are swallowed) so one failing
   * operation cannot deadlock or poison the queue.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn(), () => fn());
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private createSocket(host: string, port: number): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = new Socket();
      const timeout = this.config.connectionTimeout;

      if (timeout && timeout > 0) {
        socket.setTimeout(timeout);
      }

      socket.once("error", (err) => {
        socket.destroy();
        reject(new Error(`Failed to connect to ${host}:${port}: ${err.message}`));
      });

      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error(`Connection to ${host}:${port} timed out`));
      });

      socket.connect(port, host, () => {
        socket.removeAllListeners("error");
        socket.removeAllListeners("timeout");
        socket.setTimeout(0); // Disable timeout after successful connect

        // Track remote socket closure (broker may close after auto-commit)
        socket.on("end", () => {
          this.socketDead = true;
        });

        socket.on("close", () => {
          this.socketDead = true;
        });

        // Absorb EPIPE / ECONNRESET from late writes to a dead socket.
        // Without this handler Node.js treats the error event as unhandled
        // and crashes the process.
        socket.on("error", () => {
          this.socketDead = true;
        });

        resolve(socket);
      });
    });
  }

  /**
   * Upgrade a plaintext CAS socket to TLS (STARTTLS-style), used only when
   * `config.ssl` is enabled.
   *
   * Ordering is dictated by the CUBRID CAS server. After the client sends the
   * "CUBRS" SSL magic, the broker replies with a single 4-byte int (the CAS
   * redirect port / status) — the SAME int the non-SSL path reads in step 2 of
   * connectUnlocked — and then immediately runs SSL_accept, blocking on the
   * client's TLS ClientHello. There is NO separate second "NO_ERROR" int.
   *
   * Verified against a live SSL=ON broker (CUBRID 11.2): after the magic the
   * broker sends exactly one 4-byte int and then waits in SSL_accept; issuing
   * the TLS handshake immediately after consuming that int completes (TLSv1.3).
   * Therefore this method must NOT read another int — the int is already
   * consumed by connectUnlocked — it only flushes any buffered bytes and
   * performs the TLS handshake.
   */
  private async upgradeToTls(rawSocket: Socket): Promise<TLSSocket> {
    // Guarantee a clean boundary before wrapping with TLS. Any bytes buffered
    // past the redirect-port int must be pushed back onto the raw socket so
    // tls.connect() sees them as the start of the TLS stream. Over-read is
    // unlikely (the server cannot send ServerHello before our ClientHello) but
    // is guarded defensively.
    if (this.receiveBuffer.length > 0) {
      const leftover = this.receiveBuffer;
      this.receiveBuffer = Buffer.alloc(0);
      rawSocket.unshift(leftover);
    }

    // Wrap the raw socket in TLS and wait for the handshake.
    return new Promise<TLSSocket>((resolve, reject) => {
      const tlsSocket = tlsConnect({
        socket: rawSocket,
        rejectUnauthorized: this.config.rejectUnauthorized ?? true,
        ca: this.config.ca,
        servername: this.config.servername,
        minVersion: "TLSv1.2",
      });

      const onError = (err: Error): void => {
        tlsSocket.removeListener("secureConnect", onSecure);
        tlsSocket.destroy();
        reject(new Error(`TLS handshake failed: ${err.message}`));
      };

      const onSecure = (): void => {
        tlsSocket.removeListener("error", onError);

        // Re-wire dead-socket tracking onto the TLS socket.
        tlsSocket.on("end", () => {
          this.socketDead = true;
        });
        tlsSocket.on("close", () => {
          this.socketDead = true;
        });
        tlsSocket.on("error", () => {
          this.socketDead = true;
        });

        resolve(tlsSocket);
      };

      tlsSocket.once("error", onError);
      tlsSocket.once("secureConnect", onSecure);
    });
  }


  private socketWrite(socket: Socket, data: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      socket.write(data, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Read exactly `size` bytes from the socket.
   * Accumulates data chunks until the required amount is received.
   */
  private recvExact(socket: Socket, size: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      // Check if we already have enough buffered data
      if (this.receiveBuffer.length >= size) {
        const result = this.receiveBuffer.subarray(0, size);
        this.receiveBuffer = this.receiveBuffer.subarray(size);
        resolve(result);
        return;
      }

      const onData = (chunk: Buffer): void => {
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

        if (this.receiveBuffer.length >= size) {
          cleanup();
          const result = this.receiveBuffer.subarray(0, size);
          this.receiveBuffer = this.receiveBuffer.subarray(size);
          resolve(result);
        }
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      const onClose = (): void => {
        cleanup();
        reject(new Error("Connection closed while reading"));
      };

      const onEnd = (): void => {
        cleanup();
        reject(new Error("Connection ended while reading"));
      };

      const cleanup = (): void => {
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        socket.removeListener("end", onEnd);
      };

      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("end", onEnd);
    });
  }
}
