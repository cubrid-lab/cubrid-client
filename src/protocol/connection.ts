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
import {
  CASFunctionCode,
  DEFAULT_MAX_FRAME_LENGTH,
  SIZE_CAS_INFO,
  SIZE_DATA_LENGTH,
} from "./constants.js";
import { ConnectionLostError } from "../errors/internal-errors.js";
import { ReadTimeoutError } from "../errors/read-timeout-error.js";
import { parseConnectionString } from "../utils/connection-string.js";
import {
  writeClientInfoExchange,
  parseClientInfoExchange,
  writeOpenDatabase,
  parseOpenDatabase,
  writeGetDbVersion,
  parseGetDbVersion,
  writeCheckCas,
  parseCheckCas,
  type OpenDatabaseResult,
} from "./protocol.js";

const RETRY_BASE_DELAY_MS = 100;
const RETRY_MAX_DELAY_MS = 2000;
/** Handshake inactivity limit when `readTimeout` is unset. Later requests are not limited by it. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** CAS_INFO[0] once no transaction is open. Any other value means one is. */
const CAS_INFO_STATUS_OUT_TRAN = 0;

/** The TCP connection could not be opened; no byte was sent, so a retry is safe. */
class SocketConnectError extends Error {}

export interface CASConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeout?: number;
  /**
   * Retries after a failed first attempt to open a TCP connection to the broker
   * or CAS (refused, unreachable, timed out). Only that step is retried, so no
   * request has been sent and nothing can run twice. Rejected credentials and
   * every failure after the socket opened are not retried. Delays between
   * attempts double from 100 ms up to 2 s. Default: 0.
   */
  maxConnectionRetryCount?: number;
  /**
   * Fail a socket read, write or TLS handshake that makes no progress for this
   * many milliseconds. Measures inactivity, not total time, so a large response
   * that keeps arriving is not cut off. The clock only runs while this
   * connection is using the socket: not while idle, and not while a request
   * waits in the queue. Undefined or 0 disables it for requests; the
   * connection handshake (broker exchange, TLS, OpenDatabase) then still gives
   * up after 10 seconds of inactivity.
   */
  readTimeout?: number;
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
  /** Largest accepted frame DATA_LENGTH. Default: DEFAULT_MAX_FRAME_LENGTH. */
  maxFrameLength?: number;
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
  private _connectionGeneration = 0;
  private _failedExchanges = 0;
  private inHandshake = false;
  private _outOfTransaction = false;
  private _outOfTransactionReplies = 0;
  /** A probe has answered since the last reply. Never inferred from CAS_INFO. */
  private casVerified = false;

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

  /**
   * Open a session if there is none, and verify one that is out of transaction,
   * replacing it if its CAS has gone. sendAndRecv() would do the same on its next
   * request; calling this first lets the caller learn which session that request
   * will run on, so anything it measures on that session is not stale when sent.
   */
  async ensureSession(): Promise<void> {
    return this.enqueue(async () => {
      await this.verifySessionUnlocked();
      await this.connectUnlocked();
    });
  }

  /** Unlocked connect body. MUST only be called from within the queue. */
  private async connectUnlocked(): Promise<void> {
    const retries = this.config.maxConnectionRetryCount ?? 0;

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.handshakeUnlocked();
      } catch (error) {
        if (!(error instanceof SocketConnectError) || attempt >= retries) {
          throw error;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)),
        );
      }
    }
  }

  private async handshakeUnlocked(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.socketDead = false;
    this.inHandshake = true;

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
      // The only plaintext word the broker sends is the redirect/status int
      // already consumed in step 2; there is no second NO_ERROR word (see
      // upgradeToTls). The CAS then runs SSL_accept and reads the OpenDatabase
      // credentials over TLS. This step is SSL-only; the non-SSL path is
      // intentionally left byte-for-byte unchanged.
      if (this.config.ssl) {
        this.socket = await this.upgradeToTls(this.socket);
      }

      // Step 4: Send OpenDatabase (628 bytes, unframed)
      await this.socketWrite(
        this.socket,
        writeOpenDatabase(this.config.database, this.config.user, this.config.password),
      );

      // Step 5: Receive framed OpenDatabase response
      const responseBody = await this.readFrame(this.socket);

      const result: OpenDatabaseResult = parseOpenDatabase(responseBody);
      this._casInfo = result.casInfo;
      this._protoVersion = result.protoVersion;
      this._sessionId = result.sessionId;
      this._connectionGeneration += 1;
      this._outOfTransaction = false;
      this.casVerified = false;
      this.connected = true;
    } catch (error) {
      brokerSocket.destroy();
      this.socket?.destroy();
      this.socket = null;
      this.receiveBuffer = Buffer.alloc(0);
      throw error;
    } finally {
      this.inHandshake = false;
    }
  }

  /**
   * Send a framed CAS request (header + payload).
   * Both buffers are written as a single TCP send.
   */
  async send(header: Buffer, payload: Buffer): Promise<void> {
    if (!this.socket || !this.connected) {
      throw new ConnectionLostError("CASConnection is not connected");
    }

    if (this.socketDead) {
      throw new ConnectionLostError("Socket has been closed by the remote side");
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
      throw new ConnectionLostError("CASConnection is not connected");
    }

    return this.readFrame(this.socket);
  }

  /**
   * Send request and receive response in one call.
   * Strips the CAS_INFO from the response (first 4 bytes) and returns the payload.
   *
   * Before sending, verifies a session that is out of transaction, and replaces
   * it only if its CAS has gone. See verifySessionUnlocked().
   */
  async sendAndRecv(header: Buffer, payload: Buffer): Promise<Buffer> {
    return this.enqueue(async () => {
      await this.verifySessionUnlocked();
      return this.exchangeUnlocked(header, payload);
    });
  }

  /**
   * Exchange on one specific session, for requests that mean nothing on any
   * other, such as closing a query handle. Unlike sendAndRecv() this never
   * reconnects: a CAS that is out of transaction still answers on its socket and
   * still holds its handles, whereas a new session would accept the request and
   * do nothing.
   *
   * Returns null without sending anything when that session is gone.
   */
  async sendAndRecvOnSession(
    generation: number,
    header: Buffer,
    payload: Buffer,
  ): Promise<Buffer | null> {
    return this.enqueue(async () => {
      if (!this.connected || this._connectionGeneration !== generation) {
        return null;
      }

      return this.exchangeUnlocked(header, payload);
    });
  }

  /**
   * sendAndRecvOnSession() for a request whose failure says nothing about any
   * statement, such as releasing the handle of one that has already answered.
   * A CAS can go to another client straight after an autocommit reply, and that
   * must not fail the statements waiting behind this one.
   */
  async releaseOnSession(
    generation: number,
    header: Buffer,
    payload: Buffer,
  ): Promise<Buffer | null> {
    return this.enqueue(async () => {
      if (!this.connected || this._connectionGeneration !== generation) {
        return null;
      }

      return this.exchangeUnlocked(header, payload, false);
    });
  }

  /** Unlocked exchange body. MUST only be called from within the queue. */
  private async exchangeUnlocked(
    header: Buffer,
    payload: Buffer,
    outcomeUnknownOnFailure = true,
  ): Promise<Buffer> {
    let response: Buffer;
    try {
      await this.send(header, payload);
      response = await this.recv();
    } catch (error) {
      // The stream position is unknown after a failed exchange, so this
      // socket can never be trusted to line up with the next frame.
      if (outcomeUnknownOnFailure) {
        this._failedExchanges += 1;
      }
      this.retireSocket();
      throw error;
    }

    // Update CAS_INFO from response
    response.copy(this._casInfo, 0, 0, SIZE_CAS_INFO);

    this._outOfTransaction = this._casInfo[0] === CAS_INFO_STATUS_OUT_TRAN;
    this.casVerified = false;
    if (this._outOfTransaction && payload[0] !== CASFunctionCode.END_TRAN) {
      this._outOfTransactionReplies += 1;
    }

    // Return payload portion (after CAS_INFO)
    return response.subarray(SIZE_CAS_INFO);
  }

  /**
   * Drop the current session so the server discards its uncommitted work. The
   * statement that led here has an unknown outcome, so it counts as a failed
   * exchange. Queued: serialized against in-flight requests.
   */
  async discardSession(): Promise<void> {
    return this.enqueue(async () => {
      this._failedExchanges += 1;
      this.retireSocket();
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
   * Before a request on a session that last replied OUT_TRAN, confirm with one
   * CHECK_CAS that its CAS is still there, and open a new session only if not.
   *
   * CAS_INFO status 0 means the last transaction ended, not that the CAS is gone:
   * on CUBRID 10.2 to 11.4 the session and its settings stay, whatever the
   * broker's KEEP_CONNECTION. But it is also the state in which a CAS closes the
   * socket on purpose: to serve another client when KEEP_CONNECTION=AUTO has more
   * clients than CASes, or once a broker restart or a lost database server leaves
   * it nothing to do. A statement sent into that gap would have an unknown
   * outcome, and it could not safely be repeated. The probe runs no SQL, so a
   * failed one loses nothing. It also closes the gap, because the CAS counts as
   * in transaction from CHECK_CAS until the next statement ends.
   *
   * Runs at most once per request, before the request is first sent. Nothing is
   * replayed. A failed probe is not a failed exchange: it proves nothing about
   * earlier statements, so the statements waiting behind it stay valid.
   *
   * The official JDBC driver makes the same check in
   * `UClientSideConnection.checkReconnect()`.
   */
  private async verifySessionUnlocked(): Promise<void> {
    if (!this.connected || !this._outOfTransaction || this.casVerified) {
      return;
    }

    if (await this.probeCasUnlocked()) {
      this.casVerified = true;
      return;
    }

    this.retireSocket();
    await this.connectUnlocked();
  }

  /** True if this socket's CAS answered CHECK_CAS. Every failure means replace it. */
  private async probeCasUnlocked(): Promise<boolean> {
    try {
      const { header, payload } = writeCheckCas(this._casInfo);
      await this.send(header, payload);
      const response = await this.recv();
      response.copy(this._casInfo, 0, 0, SIZE_CAS_INFO);
      parseCheckCas(response.subarray(SIZE_CAS_INFO));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verify the connection is alive.
   * Returns the server version string on success, throws on failure.
   *
   * GET_DB_VERSION with its autocommit byte set commits the session, and that
   * commit is what notices a stopped database server: with the byte clear, the
   * CAS still reports its version. So an open transaction clears the byte and
   * proves liveness with CHECK_CAS first. CHECK_CAS cannot replace GET_DB_VERSION
   * because its reply has no body, so no version.
   */
  async ping(inTransaction: boolean): Promise<string> {
    if (inTransaction) {
      const { header, payload } = writeCheckCas(this._casInfo);
      parseCheckCas(await this.sendAndRecv(header, payload));
    }

    const { header, payload } = writeGetDbVersion(!inTransaction, this._casInfo);
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

  /** Changes on every new session, including transparent reconnects. */
  get connectionGeneration(): number {
    return this._connectionGeneration;
  }

  /**
   * Requests whose outcome is unknown because their exchange failed or their
   * session was discarded, across every session. The generation cannot show
   * this: it also changes on each
   * transparent reconnect. A failed connect sends no statement and is not counted.
   */
  get failedExchanges(): number {
    return this._failedExchanges;
  }

  /**
   * Replies that said no transaction is open, across every session, leaving out
   * END_TRAN, which is meant to, and probes, which report IN_TRAN regardless. A
   * count, because the status itself is overwritten by the very next reply.
   */
  get outOfTransactionReplies(): number {
    return this._outOfTransactionReplies;
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
        reject(new SocketConnectError(`Failed to connect to ${host}:${port}: ${err.message}`));
      });

      socket.once("timeout", () => {
        socket.destroy();
        reject(new SocketConnectError(`Connection to ${host}:${port} timed out`));
      });

      socket.connect(port, host, () => {
        socket.removeAllListeners("error");
        socket.removeAllListeners("timeout");
        socket.setTimeout(0); // Disable timeout after successful connect

        // Track remote socket closure (broker may close after auto-commit)
        this.trackSocketDeath(socket);
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
    const tlsSocket = tlsConnect({
      socket: rawSocket,
      rejectUnauthorized: this.config.rejectUnauthorized ?? true,
      ca: this.config.ca,
      servername: this.config.servername,
      minVersion: "TLSv1.2",
    });

    const handshake = new Promise<TLSSocket>((resolve, reject) => {
      const onError = (err: Error): void => {
        tlsSocket.removeListener("secureConnect", onSecure);
        tlsSocket.destroy();
        reject(new Error(`TLS handshake failed: ${err.message}`));
      };

      const onSecure = (): void => {
        tlsSocket.removeListener("error", onError);

        // Re-wire dead-socket tracking onto the TLS socket.
        this.trackSocketDeath(tlsSocket);
        resolve(tlsSocket);
      };

      tlsSocket.once("error", onError);
      tlsSocket.once("secureConnect", onSecure);
    });

    try {
      return await this.withReadTimeout(tlsSocket, handshake);
    } catch (error) {
      tlsSocket.destroy();
      throw error;
    }
  }

  /**
   * Mark the connection dead when `socket` goes away, unless `socket` has been
   * replaced: a redirected broker socket or a retired socket closes after its
   * successor exists, and that must not condemn the successor.
   *
   * The error listener also absorbs EPIPE / ECONNRESET from late writes, which
   * Node.js would otherwise treat as unhandled and crash the process.
   */
  private trackSocketDeath(socket: Socket): void {
    const markDead = (): void => {
      if (this.socket === socket) {
        this.socketDead = true;
      }
    };

    socket.on("end", markDead);
    socket.on("close", markDead);
    socket.on("error", markDead);
  }

  /**
   * Drop the current socket and its buffered bytes. `isConnected` turns false,
   * so the next caller opens a fresh connection instead of reusing this one.
   */
  private retireSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.receiveBuffer = Buffer.alloc(0);
    socket?.destroy();
  }

  /**
   * Read one framed response, rejecting an impossible DATA_LENGTH before any
   * body bytes are awaited. Returns CAS_INFO + payload.
   */
  private async readFrame(socket: Socket): Promise<Buffer> {
    const dataLengthBuf = await this.recvExact(socket, SIZE_DATA_LENGTH);
    const dataLength = dataLengthBuf.readInt32BE(0);
    const maxFrameLength = this.config.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;

    if (dataLength < 0 || dataLength > maxFrameLength) {
      throw new Error(
        `Invalid CAS frame length ${dataLength} (expected 0 to ${maxFrameLength})`,
      );
    }

    return this.recvExact(socket, dataLength + SIZE_CAS_INFO);
  }

  /**
   * Settle with `operation`, or reject with ReadTimeoutError if `socket` goes
   * quiet for `readTimeout` ms first. Node.js restarts this socket timer on
   * every chunk read and on write progress, which is what makes the limit one
   * of inactivity. The timer is cleared on the way out so an idle connection
   * is never timed out. The caller must discard the socket on rejection: the
   * abandoned operation is only released when the socket closes.
   */
  private async withReadTimeout<T>(socket: Socket, operation: Promise<T>): Promise<T> {
    const readTimeout =
      this.config.readTimeout || (this.inHandshake ? DEFAULT_HANDSHAKE_TIMEOUT_MS : undefined);

    if (readTimeout === undefined) {
      return operation;
    }

    let onTimeout = (): void => {};
    const timedOut = new Promise<never>((_resolve, reject) => {
      onTimeout = () => reject(new ReadTimeoutError(readTimeout));
    });

    socket.setTimeout(readTimeout);
    socket.once("timeout", onTimeout);

    try {
      return await Promise.race([operation, timedOut]);
    } finally {
      socket.removeListener("timeout", onTimeout);
      socket.setTimeout(0);
    }
  }

  private socketWrite(socket: Socket, data: Buffer): Promise<void> {
    const write = new Promise<void>((resolve, reject) => {
      socket.write(data, (err) => {
        if (err) {
          reject(new ConnectionLostError(err.message, { cause: err }));
        } else {
          resolve();
        }
      });
    });

    return this.withReadTimeout(socket, write);
  }

  /**
   * Read exactly `size` bytes from the socket.
   * Accumulates data chunks until the required amount is received.
   */
  private recvExact(socket: Socket, size: number): Promise<Buffer> {
    const read = new Promise<Buffer>((resolve, reject) => {
      // Check if we already have enough buffered data
      if (this.receiveBuffer.length >= size) {
        resolve(this.takeBuffered(size));
        return;
      }

      // A destroyed socket emits nothing further, so waiting would never end.
      if (socket.destroyed) {
        reject(new ConnectionLostError("Connection closed while reading"));
        return;
      }

      // Collect chunks and join once: re-concatenating on every chunk is
      // quadratic in the frame size.
      const chunks: Buffer[] = [this.receiveBuffer];
      let received = this.receiveBuffer.length;

      const onData = (chunk: Buffer): void => {
        chunks.push(chunk);
        received += chunk.length;

        if (received >= size) {
          cleanup();
          this.receiveBuffer = Buffer.concat(chunks, received);
          resolve(this.takeBuffered(size));
        }
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(new ConnectionLostError(err.message, { cause: err }));
      };

      const onClose = (): void => {
        cleanup();
        reject(new ConnectionLostError("Connection closed while reading"));
      };

      const onEnd = (): void => {
        cleanup();
        reject(new ConnectionLostError("Connection ended while reading"));
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

    return this.withReadTimeout(socket, read);
  }

  private takeBuffered(size: number): Buffer {
    const result = this.receiveBuffer.subarray(0, size);
    this.receiveBuffer = this.receiveBuffer.subarray(size);
    return result;
  }
}
