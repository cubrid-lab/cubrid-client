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
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { ConnectionLostError } from "../errors/internal-errors.js";
import { ReadTimeoutError } from "../errors/read-timeout-error.js";
import { parseConnectionString } from "../utils/connection-string.js";
import {
  CASFunctionCode,
  DEFAULT_MAX_FRAME_LENGTH,
  SIZE_CAS_INFO,
  SIZE_DATA_LENGTH,
} from "./constants.js";
import { FrameReader } from "./frame-reader.js";
import {
  type OpenDatabaseResult,
  parseCheckCas,
  parseClientInfoExchange,
  parseGetDbVersion,
  parseOpenDatabase,
  parseSimpleResponse,
  writeCheckCas,
  writeClientInfoExchange,
  writeGetDbVersion,
  writeOpenDatabase,
  writeSetDbParameter,
} from "./protocol.js";

const RETRY_BASE_DELAY_MS = 100;
const RETRY_MAX_DELAY_MS = 2000;
/** Handshake inactivity limit when `readTimeout` is unset. Later requests are not limited by it. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Limit of each TCP connect when `connectionTimeout` is unset. 0 disables it. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
/** Idle time before the first TCP keepalive probe. Not a read timeout. */
export const KEEP_ALIVE_INITIAL_DELAY_MS = 60_000;

/** What destroy() rejects with: an operation that was running, and one still waiting. */
const DESTROYED_IN_FLIGHT =
  "The connection was destroyed; the outcome of a request in flight is unknown";
const DESTROYED_BEFORE_SENT = "The connection was destroyed before this request was sent";

/** CAS_INFO[0] once no transaction is open. Any other value means one is. */
const CAS_INFO_STATUS_OUT_TRAN = 0;

/** The TCP connection could not be opened; no byte was sent, so a retry is safe. */
class SocketConnectError extends Error {}

/** One SET_DB_PARAMETER request that every session of a connection must receive. */
export interface SessionParameter {
  parameter: number;
  value: number;
}

export interface CASConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /**
   * Limit of each TCP connect, to the broker and to the CAS it redirects to, in
   * milliseconds. Undefined: 10 seconds. 0: no limit beyond the operating
   * system's. Retried by `maxConnectionRetryCount`.
   */
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
  /**
   * Largest accepted reply DATA_LENGTH, the `maxReplyBytes` client option. A
   * longer reply fails before its body is read and retires the socket.
   * Default: DEFAULT_MAX_FRAME_LENGTH.
   */
  maxFrameLength?: number;
  /** Sent on each new session before anything else. See applySessionParametersUnlocked(). */
  sessionParameters?: readonly SessionParameter[];
}

/**
 * Limits of the requests one statement makes. See CASConnection.runScoped().
 */
export interface RequestScope {
  /** Stops the statement's requests. A request already written retires the socket. */
  readonly signal?: AbortSignal | undefined;
  /** Replaces `CASConnectionConfig.readTimeout` for these requests; 0 disables it. */
  readonly readTimeout?: number | undefined;
  /** Set once a request of this scope has been written, so the socket may be out of step. */
  sent: boolean;
  /** Set when `signal` stopped a request of this scope. */
  aborted: boolean;
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
  private _connectionGeneration = 0;
  private _failedExchanges = 0;
  private _unknownOutcomes = 0;
  private inHandshake = false;
  private _outOfTransaction = false;
  private _outOfTransactionReplies = 0;
  /** A probe has answered since the last reply. Never inferred from CAS_INFO. */
  private casVerified = false;
  /**
   * The transport is open but the session settings are still being sent. Until
   * they hold, the session is not usable, so `isConnected` stays false.
   */
  private settingUp = false;

  /** Set by destroy(); nothing runs on this connection again. */
  private destroyed = false;

  /** Every socket this connection opened that has not closed, handshake ones included. */
  private readonly sockets = new Set<Socket>();

  /**
   * The reader of each socket, from connect (or the TLS handshake) on. Never
   * removed on 'close', so bytes that arrived before it are still read; it goes
   * with the socket. See dropSocket().
   */
  private readonly readers = new WeakMap<Socket, FrameReader>();

  /** Rejects each operation waiting on the socket or a timer when destroy() runs. */
  private readonly onDestroy = new Set<(error: Error) => void>();

  /**
   * Per-instance FIFO serialization queue. Public entry points that mutate
   * shared socket / buffer / CAS_INFO state (connect, sendAndRecv, close) are
   * chained through this tail promise so concurrent callers run strictly
   * one-at-a-time. The chain must NEVER reject: a rejected op is swallowed
   * here so it cannot poison subsequent queued operations.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly config: CASConnectionConfig;

  /** Given to each operation queued while it is set. See runScoped(). */
  private scope: RequestScope | null = null;

  /** The scope of the queued operation running now. */
  private activeScope: RequestScope | null = null;

  private sessionParameters: readonly SessionParameter[];

  constructor(config: CASConnectionConfig | string) {
    this.config = typeof config === "string" ? parseConnectionString(config) : config;
    this.sessionParameters = this.config.sessionParameters ?? [];
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

  /**
   * Run `run` with every operation it queues on this connection limited by
   * `scope`: its signal and its readTimeout apply to those requests and to no
   * other. The caller must be the only one queuing operations meanwhile, which
   * the adapter's statement queue ensures.
   */
  async runScoped<T>(scope: RequestScope, run: () => Promise<T>): Promise<T> {
    const previous = this.scope;
    this.scope = scope;
    try {
      return await run();
    } finally {
      this.scope = previous;
    }
  }

  /**
   * Wait for `pending`, work of the running scope that is not a request, such as
   * reading the next chunk of a LOB source. The scope's signal stops the wait as
   * it stops a request: once a request of the scope has been written, its
   * outcome on the server is unknown, so the session is discarded.
   */
  async awaitScoped<T>(pending: Promise<T>): Promise<T> {
    const scope = this.scope;
    const signal = scope?.signal;
    if (!scope || !signal) {
      return this.untilDestroyed(pending);
    }
    // Abandoned on abort, so a later failure of it must not go unhandled.
    pending.catch(() => undefined);

    if (!signal.aborted) {
      let onAbort = (): void => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([this.untilDestroyed(pending), aborted]);
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }

    if (scope.sent) {
      // The request written may have run, and its reply will never be read.
      await this.discardSession(true);
    }
    scope.aborted = true;
    throw signal.reason;
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

        // destroy() clears the timer too, so nothing keeps the process alive.
        let timer: NodeJS.Timeout | undefined;
        const clear = (): void => clearTimeout(timer);
        this.onDestroy.add(clear);
        try {
          await this.untilDestroyed(
            new Promise((resolve) => {
              timer = setTimeout(
                resolve,
                Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS),
              );
            }),
          );
        } finally {
          this.onDestroy.delete(clear);
        }
      }
    }
  }

  private async handshakeUnlocked(): Promise<void> {
    if (this.connected) {
      return;
    }

    // An aborted statement opens no connection, and neither does a destroyed one.
    this.throwIfAborted();
    this.throwIfDestroyed(DESTROYED_BEFORE_SENT);

    // Built first, so credentials the broker would not read intact open no socket.
    const openDatabase = writeOpenDatabase(
      this.config.database,
      this.config.user,
      this.config.password,
    );

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
        this.dropSocket(brokerSocket);
        throw new Error(`CUBRID broker rejected connection (code: ${newPort})`);
      }

      // Step 3: If port > 0, connect to CAS on new port; if 0, reuse broker socket
      if (newPort > 0) {
        // Anything the broker sent past the port goes with its socket, as in JDBC:
        // a CAS sends nothing before OPEN_DATABASE, and dropSocket() disposes the
        // broker socket's reader, so its bytes never answer a read on the CAS socket.
        this.dropSocket(brokerSocket);
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
      await this.socketWrite(this.socket, openDatabase);

      // Step 5: Receive framed OpenDatabase response
      const responseBody = await this.readFrame(this.socket);

      const result: OpenDatabaseResult = parseOpenDatabase(responseBody);
      // A reply that arrived as destroy() ran must not open a session.
      this.throwIfDestroyed(DESTROYED_IN_FLIGHT);
      this._casInfo = result.casInfo;
      this._protoVersion = result.protoVersion;
      this._sessionId = result.sessionId;
      this._connectionGeneration += 1;
      this._outOfTransaction = false;
      this.casVerified = false;
      this.connected = true;
      this.settingUp = true;
      await this.applySessionParametersUnlocked();
      this.settingUp = false;
    } catch (error) {
      this.connected = false;
      this.settingUp = false;
      this.dropSocket(brokerSocket);
      this.dropSocket(this.socket);
      this.socket = null;
      throw error;
    } finally {
      this.inHandshake = false;
    }
  }

  /**
   * Make a session hold `sessionParameters`, before anything else runs on it.
   *
   * This belongs to opening a session because a session is replaced in several
   * places, and the server starts each one from its defaults: on CUBRID 10.2 to
   * 11.4 nothing carries over after a broker restart, a killed CAS, a database
   * server restart or the CAS going to another client. All of those arrive here,
   * so no statement can run on a new session without its settings. A failure
   * leaves no session behind.
   *
   * Every SET_DB_PARAMETER reply says OUT_TRAN, even on a brand-new session, so
   * the CAS may go to another client from then on. The closing CHECK_CAS holds it
   * and leaves the session as OPEN_DATABASE did. If the CAS goes in that moment,
   * this fails rather than run on without the settings.
   *
   * Nothing here counts in `failedExchanges` or `outOfTransactionReplies`: it runs
   * no statement, and no transaction can have ended here.
   */
  private async applySessionParametersUnlocked(): Promise<void> {
    if (this.sessionParameters.length === 0) {
      return;
    }

    try {
      for (const { parameter, value } of this.sessionParameters) {
        const { header, payload } = writeSetDbParameter(parameter, value, this._casInfo);
        await this.send(header, payload);
        const response = await this.recv();
        response.copy(this._casInfo, 0, 0, SIZE_CAS_INFO);
        parseSimpleResponse(response.subarray(SIZE_CAS_INFO));
      }

      const { header, payload } = writeCheckCas(this._casInfo);
      await this.send(header, payload);
      const response = await this.recv();
      response.copy(this._casInfo, 0, 0, SIZE_CAS_INFO);
      parseCheckCas(response.subarray(SIZE_CAS_INFO));
    } catch (error) {
      // mapError() must still see a read timeout or a lost connection at the top,
      // and an abort is the caller's own.
      if (error instanceof ReadTimeoutError || this.isAbortReason(error) || this.destroyed) {
        throw error;
      }
      throw new Error("The session settings could not be applied, so nothing was sent", {
        cause: error,
      });
    }

    this._outOfTransaction = this._casInfo[0] === CAS_INFO_STATUS_OUT_TRAN;
    this.casVerified = true;
  }

  /**
   * Replace the parameters every session receives, and give them to the open
   * session if there is one. The caller must not have a transaction open: on
   * CUBRID 10.2 to 11.4 a change takes effect inside the running transaction.
   */
  async setSessionParameters(parameters: readonly SessionParameter[]): Promise<void> {
    return this.enqueue(async () => {
      this.sessionParameters = parameters;

      // A CAS that has gone is replaced here, and that new session already has them.
      const generation = this._connectionGeneration;
      await this.verifySessionUnlocked();
      if (!this.connected || this._connectionGeneration !== generation) {
        return;
      }

      try {
        await this.applySessionParametersUnlocked();
      } catch (error) {
        // This session may hold some of them, and the next statement must not run on it.
        this.retireSocket();
        throw error;
      }
    });
  }

  /**
   * Send a framed CAS request (header + payload).
   * Both buffers are written as a single TCP send.
   */
  async send(header: Buffer, payload: Buffer): Promise<void> {
    const socket = this.assertWritable();
    const combined = Buffer.concat([header, payload]);
    await this.socketWrite(socket, combined);
  }

  /** The socket a request can be written to now; throws, writing nothing, if there is none. */
  private assertWritable(): Socket {
    this.throwIfDestroyed(DESTROYED_IN_FLIGHT);
    if (!this.socket || !this.connected) {
      throw new ConnectionLostError("CASConnection is not connected");
    }

    if (this.socketDead) {
      throw new ConnectionLostError("Socket has been closed by the remote side");
    }
    return this.socket;
  }

  /**
   * Receive a framed CAS response.
   * Reads 4-byte DATA_LENGTH, then reads DATA_LENGTH + CAS_INFO bytes.
   * Returns the body (CAS_INFO + payload) without the DATA_LENGTH prefix.
   */
  async recv(): Promise<Buffer> {
    this.throwIfDestroyed(DESTROYED_IN_FLIGHT);
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
    }, true);
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
    }, true);
  }

  /** Unlocked exchange body. MUST only be called from within the queue. */
  private async exchangeUnlocked(
    header: Buffer,
    payload: Buffer,
    outcomeUnknownOnFailure = true,
  ): Promise<Buffer> {
    const scope = this.activeScope;
    if (scope?.signal?.aborted) {
      // Nothing of this request is written. A statement that already wrote one
      // may have a reply on its way, so its socket cannot be used again.
      if (scope.sent) {
        if (outcomeUnknownOnFailure) {
          this._failedExchanges += 1;
          this._unknownOutcomes += 1;
        }
        this.retireSocket();
      }
      this.throwIfAborted();
    }

    let response: Buffer;
    // Set once the request is handed to the socket: from then on the server may
    // have received it, whatever happens to the reply.
    let written = false;
    try {
      this.assertWritable();
      written = true;
      if (scope) {
        scope.sent = true;
      }
      await this.send(header, payload);
      response = await this.recv();
    } catch (error) {
      // The stream position is unknown after a failed exchange, so this
      // socket can never be trusted to line up with the next frame.
      if (outcomeUnknownOnFailure) {
        this._failedExchanges += 1;
        if (written) {
          this._unknownOutcomes += 1;
        }
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
   * Drop the current session so the server discards its uncommitted work. It
   * counts as a failed exchange. Queued: serialized against in-flight requests.
   *
   * `outcomeUnknown` says whether a request of the statement that led here may
   * have reached the server without a reply saying what it did (#254): true for
   * an abort after a request was written or a reply too damaged to read, false
   * when every request was answered or none was sent yet.
   */
  async discardSession(outcomeUnknown: boolean): Promise<void> {
    return this.enqueue(async () => {
      // Nothing is left to discard, and a destroyed connection is never reused.
      if (this.destroyed) {
        return;
      }
      this._failedExchanges += 1;
      if (outcomeUnknown) {
        this._unknownOutcomes += 1;
      }
      this.retireSocket();
    }, true);
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

      // destroy() during the hook has already torn the socket down.
      const socket = this.socket;
      if (!socket) {
        return;
      }
      this.sockets.delete(socket);
      this.socket = null;
      this.connected = false;
      this.socketDead = false;

      this.readers.get(socket)?.dispose();
      socket.removeAllListeners();
      socket.destroy();
    }, true);
  }

  /**
   * Tear the connection down now, without waiting for the request in flight or
   * the queue: every socket closes at once, the TLS handshake and broker sockets
   * of a connect in progress included, and nothing is sent first.
   *
   * The request in flight rejects with a ConnectionLostError; its outcome on the
   * server is unknown and it counts in `failedExchanges`. Every operation queued
   * behind it rejects with a ConnectionLostError without sending anything, and so
   * does every later one: a destroyed connection never opens another session, so
   * no late reply can be read and nothing is replayed. close() still resolves.
   * Synchronous and idempotent.
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.connected = false;
    this.settingUp = false;
    this.socket = null;

    for (const socket of this.sockets) {
      this.dropSocket(socket);
    }
    this.sockets.clear();

    const interrupts = [...this.onDestroy];
    this.onDestroy.clear();
    for (const interrupt of interrupts) {
      interrupt(new ConnectionLostError(DESTROYED_IN_FLIGHT));
    }
  }

  /** Whether destroy() has run. */
  get isDestroyed(): boolean {
    return this.destroyed;
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

    // Nothing of the statement is sent yet: an abort now must not retire the
    // session, which in a transaction would lose work that was never touched.
    this.throwIfAborted();

    if (await this.probeCasUnlocked()) {
      this.casVerified = true;
      return;
    }

    this.retireSocket();
    // An abort of the probe is no sign that the CAS has gone.
    this.throwIfAborted();
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
   * Requests that were handed to the socket, or whose session was discarded,
   * without a reply that says what they did: the server may or may not have
   * run them. Unlike `failedExchanges` this leaves out a request that failed
   * before any byte of it was written, which the server cannot have seen. A
   * statement whose run raised this count has an unknown outcome (#254).
   */
  get unknownOutcomes(): number {
    return this._unknownOutcomes;
  }

  /**
   * Replies that said no transaction is open, across every session, leaving out
   * END_TRAN, which is meant to, and probes, which report IN_TRAN regardless. A
   * count, because the status itself is overwritten by the very next reply.
   */
  get outOfTransactionReplies(): number {
    return this._outOfTransactionReplies;
  }

  /** Whether a session is open and ready: its transport is up and its settings hold. */
  get isConnected(): boolean {
    // Callers outside the queue, such as beginTransaction(), decide from this
    // whether to wait for connect(). A session whose settings are still being
    // sent may yet fail, so it must not count as one they can start work on.
    return this.connected && !this.settingUp;
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
  private enqueue<T>(fn: () => Promise<T>, afterDestroy = false): Promise<T> {
    const scope = this.scope;
    const step = async (): Promise<T> => {
      // Queued before destroy() and never started: nothing of it was sent.
      if (!afterDestroy) {
        this.throwIfDestroyed(DESTROYED_BEFORE_SENT);
      }
      this.activeScope = scope;
      try {
        return await fn();
      } finally {
        this.activeScope = null;
      }
    };
    const run = this.queue.then(step, step);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private createSocket(host: string, port: number): Promise<Socket> {
    // Node.js revives a destroyed socket on connect(), so none may be started.
    if (this.destroyed) {
      return Promise.reject(new ConnectionLostError(DESTROYED_IN_FLIGHT));
    }
    const connecting = new Promise<Socket>((resolve, reject) => {
      const socket = new Socket();
      this.track(socket);
      const timeout = this.config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT_MS;

      if (timeout > 0) {
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
        // Each request is one write that waits for its reply, so Nagle's
        // algorithm only delays it. Keepalive lets the OS notice a vanished
        // peer on an idle socket; it does not bound a read.
        socket.setNoDelay(true);
        socket.setKeepAlive(true, KEEP_ALIVE_INITIAL_DELAY_MS);

        // Track remote socket closure (broker may close after auto-commit)
        this.trackSocketDeath(socket);
        this.readers.set(socket, new FrameReader(socket));
        resolve(socket);
      });
    });

    return this.untilDestroyed(connecting);
  }

  /** Lets destroy() reach `socket` until it closes, whoever holds it meanwhile. */
  private track(socket: Socket): void {
    if (this.destroyed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once("close", () => {
      this.sockets.delete(socket);
    });
  }

  /**
   * Settle as `operation` does, or reject at once when destroy() runs first. An
   * abandoned `operation` that rejects later is handled here, never unhandled.
   */
  private untilDestroyed<T>(operation: Promise<T>): Promise<T> {
    if (this.destroyed) {
      operation.catch(() => undefined);
      return Promise.reject(new ConnectionLostError(DESTROYED_IN_FLIGHT));
    }

    return new Promise<T>((resolve, reject) => {
      this.onDestroy.add(reject);
      operation.then(resolve, reject).finally(() => {
        this.onDestroy.delete(reject);
      });
    });
  }

  private throwIfDestroyed(message: string): void {
    if (this.destroyed) {
      throw new ConnectionLostError(message);
    }
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
    // Guarantee a clean boundary before wrapping with TLS. The raw socket's
    // reader lets go of it paused, so nothing is emitted unread, and any bytes
    // it holds past the redirect-port int are pushed back onto the raw socket so
    // tls.connect() sees them as the start of the TLS stream. Over-read is
    // unlikely (the server cannot send ServerHello before our ClientHello) but
    // is guarded defensively.
    const leftover = this.readers.get(rawSocket)?.detach();
    this.readers.delete(rawSocket);
    if (leftover && leftover.length > 0 && !rawSocket.readableEnded) {
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
    this.track(tlsSocket);

    const handshake = new Promise<TLSSocket>((resolve, reject) => {
      const onError = (err: Error): void => {
        tlsSocket.removeListener("secureConnect", onSecure);
        tlsSocket.destroy();
        reject(new Error(`TLS handshake failed: ${err.message}`));
      };

      // A socket destroyed by a timeout emits no error, and the wait must still end.
      const onClose = (): void => {
        tlsSocket.removeListener("secureConnect", onSecure);
        reject(new ConnectionLostError("TLS handshake failed: the connection closed"));
      };

      const onSecure = (): void => {
        tlsSocket.removeListener("error", onError);
        tlsSocket.removeListener("close", onClose);

        // Re-wire dead-socket tracking onto the TLS socket.
        this.trackSocketDeath(tlsSocket);
        this.readers.set(tlsSocket, new FrameReader(tlsSocket));
        resolve(tlsSocket);
      };

      tlsSocket.once("error", onError);
      tlsSocket.once("close", onClose);
      tlsSocket.once("secureConnect", onSecure);
    });

    try {
      return await this.withReadTimeout(tlsSocket, handshake);
    } catch (error) {
      this.dropSocket(tlsSocket);
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
    this.dropSocket(socket);
  }

  /** Destroy `socket` and drop the bytes its reader holds; a read waiting on it rejects. */
  private dropSocket(socket: Socket | null): void {
    if (!socket) {
      return;
    }
    this.readers.get(socket)?.dispose();
    socket.destroy();
  }

  /**
   * Read one framed response, rejecting an impossible or over-limit DATA_LENGTH
   * before any body bytes are awaited. Returns CAS_INFO + payload. The rest of a
   * rejected reply is still on its way, so every caller must discard the socket.
   */
  private async readFrame(socket: Socket): Promise<Buffer> {
    const dataLengthBuf = await this.recvExact(socket, SIZE_DATA_LENGTH);
    const dataLength = dataLengthBuf.readInt32BE(0);
    const maxFrameLength = this.config.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;

    if (dataLength < 0) {
      throw new Error(`Invalid CAS frame length ${dataLength} (expected 0 to ${maxFrameLength})`);
    }
    if (dataLength > maxFrameLength) {
      throw new Error(
        `The server's reply of ${dataLength} bytes is over the maxReplyBytes limit of ` +
          `${maxFrameLength} bytes, so the connection was closed without reading it`,
      );
    }

    return this.recvExact(socket, dataLength + SIZE_CAS_INFO);
  }

  /**
   * Settle with `operation`, or reject with ReadTimeoutError if `socket` goes
   * quiet for `readTimeout` ms first, or with the reason of the running
   * scope's signal once it aborts. Node.js restarts this socket timer on
   * every chunk read and on write progress, which is what makes the limit one
   * of inactivity. The timer and the abort listener are removed on the way out
   * so an idle connection is never timed out. The caller must discard the
   * socket on rejection: the abandoned operation is only released when the
   * socket closes.
   */
  private async withReadTimeout<T>(socket: Socket, operation: Promise<T>): Promise<T> {
    const scope = this.activeScope;
    const limit = scope?.readTimeout !== undefined ? scope.readTimeout : this.config.readTimeout;
    const readTimeout = limit || (this.inHandshake ? DEFAULT_HANDSHAKE_TIMEOUT_MS : undefined);
    const signal = scope?.signal;

    if (readTimeout === undefined && !signal) {
      return this.untilDestroyed(operation);
    }

    let onTimeout = (): void => {};
    let onAbort = (): void => {};
    // Once the reply is in, an abort is too late: the statement completed and
    // the session is still in step, so it must not be reported as aborted.
    let settled = false;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onTimeout = () => reject(new ReadTimeoutError(readTimeout ?? 0));
      onAbort = () => {
        if (settled) {
          return;
        }
        if (scope) {
          scope.aborted = true;
        }
        reject(signal?.reason);
      };
    });

    if (readTimeout !== undefined) {
      socket.setTimeout(readTimeout);
      socket.once("timeout", onTimeout);
    }
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    try {
      return await Promise.race([
        this.untilDestroyed(operation).finally(() => {
          settled = true;
        }),
        interrupted,
      ]);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (readTimeout !== undefined) {
        socket.removeListener("timeout", onTimeout);
        socket.setTimeout(0);
      }
    }
  }

  /** Rejects with the running scope's abort reason, if its signal has aborted. */
  private throwIfAborted(): void {
    const scope = this.activeScope;
    if (scope?.signal?.aborted) {
      scope.aborted = true;
      throw scope.signal.reason;
    }
  }

  private isAbortReason(error: unknown): boolean {
    const signal = this.activeScope?.signal;
    return signal?.aborted === true && error === signal.reason;
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
   * Read exactly `size` bytes from the socket, through its reader. A socket
   * with no reader has been dropped, so the read fails like a closed one.
   */
  private recvExact(socket: Socket, size: number): Promise<Buffer> {
    const reader = this.readers.get(socket);
    const read = reader
      ? reader.read(size)
      : Promise.reject(new ConnectionLostError("Connection closed while reading"));
    return this.withReadTimeout(socket, read);
  }
}
