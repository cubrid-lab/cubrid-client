/**
 * Native CUBRID adapter — speaks the CAS protocol directly over TCP.
 *
 * Replaces NodeCubridAdapter by eliminating the node-cubrid dependency.
 * Implements the ConnectionLike interface used by CubridClient.
 */

import { TextDecoder } from "node:util";

import {
  CASConnection,
  type CASConnectionConfig,
  type SessionParameter,
} from "../protocol/connection.js";
import {
  writePrepareAndExecute,
  parsePrepareAndExecute,
  writePrepare,
  parsePrepare,
  writeExecute,
  parseExecute,
  encodePreparedParams,
  assertPreparableSql,
  readQueryHandle,
  MalformedReplyError,
  writeFetch,
  parseFetch,
  writeCloseReqHandle,
  parseSimpleResponse,
  writeEndTran,
  writeConClose,
  writeLobRead,
  parseLobRead,
  LobLocator,
  mayHoldLob,
  setColumn,
  UnsupportedValueError,
  interpolateParams,
  type ColumnMeta,
  writeGetLastInsertId,
  parseGetLastInsertId,
  type PrepareAndExecuteResult,
  type PreparedBinds,
} from "../protocol/protocol.js";
import {
  CUBRIDDataType,
  DbParameter,
  DEFAULT_MAX_LOB_BYTES,
  EndTranType,
  ISOLATION_LEVEL_CODES,
  LOB_READ_CHUNK_SIZE,
  StatementType,
  TYPE_NAMES,
} from "../protocol/constants.js";
import {
  ConnectionLostError,
  isServerTransactionAbort,
  StreamBusyError,
  type CasReplyError,
} from "../errors/internal-errors.js";
import { mapError, type ErrorKind } from "../internals/map-error.js";
import { TransactionError } from "../errors/transaction-error.js";
import {
  assertValidFetchSize,
  assertValidMaxLobBytes,
  assertValidRetryCount,
  assertValidStreamOptions,
  assertValidTimezone,
  assertValidTransactionOptions,
  pickTransactionOptions,
} from "../internals/normalize-config.js";
import { StreamCursor } from "./stream-cursor.js";
import type { DriverAdapter } from "./base.js";
import type { ClientConfig, ExecuteResult, StreamOptions, TransactionOptions } from "../types/client.js";
import type { QueryParams } from "../types/query.js";
import type { ColumnInfo, QueryResult, QueryResultRow } from "../types/result.js";

const DEFAULT_FETCH_SIZE = 100;

const QUERY_FAILED = "Failed to execute CUBRID query.";

/** A stream's maximum idle-consumer wait, unless configured otherwise. */
const DEFAULT_CONSUMER_TIMEOUT_MS = 5000;

/** Internal control-flow signal: an orderly iterator close is not a query error. */
const STREAM_STOPPED = Symbol("stream stopped");

/** A cancelled stream must not issue another CAS request after an in-flight reply. */
function assertStreamWanted(cursor?: StreamCursor): void {
  if (!cursor) return;
  cursor.assertNotCancelled();
  if (cursor.isStopped) throw STREAM_STOPPED;
}



/** Fatal so a CLOB that is not UTF-8 is refused, not silently given U+FFFD. */
const CLOB_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The connection a query was issued on, and its failure count at that moment. */
interface IssuedOn {
  cas: CASConnection;
  failedExchanges: number;
}

/** A statement that has not started yet. See inTurn(). */
interface WaitingStatement {
  since: number;
  refuse: (reason: Error) => void;
}


/** Whether any parameter renders differently under the two backslash modes. */
function needsBackslashMode(params: QueryParams): boolean {
  return params.some((value) => {
    if (
      value === null ||
      value === undefined ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Date ||
      Buffer.isBuffer(value)
    ) {
      return false;
    }
    return /[\\\r\n]/.test(String(value));
  });
}

function toSessionParameters({ isolationLevel, lockTimeout }: TransactionOptions): SessionParameter[] {
  return [
    ...(isolationLevel === undefined
      ? []
      : [{ parameter: DbParameter.ISOLATION_LEVEL, value: ISOLATION_LEVEL_CODES[isolationLevel] }]),
    ...(lockTimeout === undefined
      ? []
      : [{ parameter: DbParameter.LOCK_TIMEOUT, value: lockTimeout }]),
  ];
}

export class NativeCubridAdapter implements DriverAdapter {
  private cas: CASConnection | null = null;
  private autoCommit = true;

  /** What every session of this connection must hold. See setTransactionOptions(). */
  private transactionOptions: TransactionOptions;

  /**
   * Server backslash-escaping mode, negotiated once per physical session via
   * `SELECT CHAR_LENGTH('\\')`. `null` until negotiated. `true` means the CUBRID
   * default `no_backslash_escapes=yes` (backslash is a literal char); `false`
   * means backslash-escape processing is active. See `negotiateBackslashEscapes`.
   */
  private noBackslashEscapes: boolean | null = null;
  /** Session (`connectionGeneration`) that `noBackslashEscapes` was measured on. */
  private backslashModeGeneration: number | null = null;

  /**
   * Session that holds the open transaction's statements. Set by the first
   * statement rather than by beginTransaction(): a CAS that went away between
   * transactions is legitimately replaced on that first statement, before there
   * is any work to lose.
   */
  private transactionGeneration: number | null = null;

  /**
   * `cas.outOfTransactionReplies` just before the transaction's first statement,
   * or null with no statement sent yet. See transactionEnded().
   */
  private transactionEndReplies: number | null = null;

  /**
   * The reply that said the server rolled back the open transaction on its own.
   * The session is still healthy, but its next statement would start a new
   * server transaction, and a commit would persist that statement alone. So
   * until the caller acknowledges it, this counts as a lost transaction.
   */
  private transactionAbort: CasReplyError | null = null;

  /**
   * The session's last generated AUTO_INCREMENT value as this adapter last saw
   * it: `undefined` for none, `null` when a statement may have changed it unseen.
   * See readExecuteResult().
   */
  private insertIdBaseline: string | undefined | null;
  /** Session (`connectionGeneration`) that `insertIdBaseline` describes. */
  private insertIdGeneration: number | null = null;

  /**
   * Tail of the statement queue; see inTurn(). It never rejects, so one failed
   * statement cannot block the ones behind it.
   */
  private statementQueue: Promise<void> = Promise.resolve();

  /** Statements behind the running one, which a stalled stream can make refuse. */
  private readonly waitingStatements = new Set<WaitingStatement>();

  /** Every stream between its first read and its end, so close() can stop them. */
  private readonly openCursors = new Set<StreamCursor>();

  /** The stream whose turn is waiting for its consumer to ask for more rows. */
  private heldBy: StreamCursor | null = null;

  /** Timer of the next possible refusal. See watchHeldTurn(). */
  private refusalTimer: NodeJS.Timeout | null = null;

  /** See ClientOptions.timezone. */
  private readonly utcDates: boolean;

  constructor(private readonly config: ClientConfig) {
    assertValidRetryCount(config.maxConnectionRetryCount);
    assertValidMaxLobBytes(config.maxLobBytes);
    assertValidFetchSize(config.fetchSize);
    assertValidTimezone(config.timezone);
    assertValidTransactionOptions(config);
    this.transactionOptions = pickTransactionOptions(config);
    this.utcDates = config.timezone === "utc";
  }

  async connect(): Promise<void> {
    const cas = this.getOrCreateCAS();

    try {
      await cas.connect();
    } catch (error) {
      throw mapError("connection", error, "Failed to connect to CUBRID.");
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    return (await this.queryResult<T>(sql, params)).rows;
  }

  async queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    const cas = this.getOrCreateCAS();
    const issued: IssuedOn = { cas, failedExchanges: cas.failedExchanges };
    return this.inTurn("query", QUERY_FAILED, () => this.queryNow<T>(sql, params, issued, undefined));
  }

  /**
   * Reads a result one server reply at a time. See `CubridClient.stream()` for the
   * contract. The statement is issued by the first read, like any other statement
   * in the queue, and keeps its turn until it has released its query handle.
   */
  stream<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: StreamOptions,
  ): AsyncGenerator<T, void, undefined> {
    assertValidStreamOptions(options);
    return this.streamRows<T>(sql, params, options);
  }

  private async *streamRows<T extends QueryResultRow>(
    sql: string,
    params: QueryParams | undefined,
    options: StreamOptions | undefined,
  ): AsyncGenerator<T, void, undefined> {
    const signal = options?.signal;
    signal?.throwIfAborted();

    const cursor = new StreamCursor(options?.consumerTimeout ?? DEFAULT_CONSUMER_TIMEOUT_MS);
    const fetchSize = options?.fetchSize ?? this.config.fetchSize ?? DEFAULT_FETCH_SIZE;
    const onAbort = (): void => cursor.cancel(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    this.openCursors.add(cursor);

    try {
      const cas = this.getOrCreateCAS();
      const issued: IssuedOn = { cas, failedExchanges: cas.failedExchanges };
      cursor.run(
        this.inTurn("query", QUERY_FAILED, async () => {
          if (cursor.begin()) {
            await this.streamNow(cursor, sql, params, fetchSize, issued);
          }
        }),
      );

      for (;;) {
        const rows = await cursor.take();
        if (rows === null) {
          return;
        }

        for (const row of rows) {
          cursor.assertNotCancelled();
          yield row as T;
          cursor.activityAt = Date.now();
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.openCursors.delete(cursor);
      await cursor.close();
    }
  }

  async execute(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    const cas = this.getOrCreateCAS();
    const issued: IssuedOn = { cas, failedExchanges: cas.failedExchanges };
    return this.inTurn("query", "Failed to execute CUBRID statement.", () => this.executeNow(sql, params, issued, undefined));
  }

  async queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    return (await this.queryResultPrepared<T>(sql, params)).rows;
  }

  async queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    const binds = bindOrRefuse(sql, params, "Failed to execute CUBRID query.");
    const cas = this.getOrCreateCAS();
    const issued: IssuedOn = { cas, failedExchanges: cas.failedExchanges };
    return this.inTurn("query", QUERY_FAILED, () => this.queryNow<T>(sql, params, issued, binds));
  }

  async executePrepared(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    const binds = bindOrRefuse(sql, params, "Failed to execute CUBRID statement.");
    const cas = this.getOrCreateCAS();
    const issued: IssuedOn = { cas, failedExchanges: cas.failedExchanges };
    return this.inTurn("query", "Failed to execute CUBRID statement.", () => this.executeNow(sql, params, issued, binds));
  }

  private async executeNow(
    sql: string,
    params: QueryParams | undefined,
    issued: IssuedOn,
    binds: PreparedBinds | undefined,
  ): Promise<ExecuteResult> {
    try {
      await this.readInsertIdBaseline(sql);
      return await this.runStatement(
        sql,
        params,
        issued,
        (cas, result) => this.readExecuteResult(cas, result),
        true,
        binds,
      );
    } catch (error) {
      this.forgetInsertId();
      this.bindSessionLostByFirstStatement();
      this.recordTransactionAbort(error);
      throw mapError("query", error, "Failed to execute CUBRID statement.");
    }
  }

  private async queryNow<T extends QueryResultRow>(
    sql: string,
    params: QueryParams | undefined,
    issued: IssuedOn,
    binds: PreparedBinds | undefined,
  ): Promise<QueryResult<T>> {
    try {
      return await this.executeQuery<T>(sql, params, issued, binds);
    } catch (error) {
      // If the first transactional statement lost its session before the
      // post-response bind, remember that failed generation. A ping/reconnect
      // must never make subsequent statements commit on a replacement CAS.
      this.forgetInsertId();
      this.bindSessionLostByFirstStatement();
      this.recordTransactionAbort(error);
      throw mapError("query", error, "Failed to execute CUBRID query.");
    }
  }

  private async streamNow(
    cursor: StreamCursor,
    sql: string,
    params: QueryParams | undefined,
    fetchSize: number,
    issued: IssuedOn,
  ): Promise<void> {
    try {
      await this.runStatement(sql, params, issued, async (cas, result) => {
        this.forgetInsertIdAfterQuery(result);

        if (result.statementType === StatementType.SELECT) {
          await this.streamWindows(cursor, cas, result, fetchSize);
        }
      });
    } catch (error) {
      throw this.queryFailure(error);
    }
  }

  private queryFailure(error: unknown): Error {
    // If the first transactional statement lost its session before the
    // post-response bind, remember that failed generation. A ping/reconnect
    // must never make subsequent statements commit on a replacement CAS.
    this.forgetInsertId();
    this.bindSessionLostByFirstStatement();
    this.recordTransactionAbort(error);
    return mapError("query", error, QUERY_FAILED);
  }

  /**
   * Keep these settings on every session of this connection, in place of what was
   * set before and leaving any option not given as it is. close() goes back to
   * the configured values, so an adapter reused after a transaction inherits none.
   *
   * Refused inside a transaction: the server would apply it to the running
   * transaction at once, so reads before and after it could follow different
   * levels, while the caller believes the whole transaction ran under one.
   */
  async setTransactionOptions(options: TransactionOptions): Promise<void> {
    assertValidTransactionOptions(options);
    return this.inTurn("transaction", "Failed to apply transaction options.", () => this.setTransactionOptionsNow(options));
  }

  private async setTransactionOptionsNow(options: TransactionOptions): Promise<void> {
    if (!this.autoCommit) {
      throw new TransactionError(
        "Transaction options cannot change inside a transaction, so nothing was sent.",
      );
    }

    try {
      this.transactionOptions = { ...this.transactionOptions, ...pickTransactionOptions(options) };
      await this.cas?.setSessionParameters(toSessionParameters(this.transactionOptions));
    } catch (error) {
      throw mapError("connection", error, "Failed to apply transaction options.");
    }
  }

  async beginTransaction(): Promise<void> {
    return this.inTurn("transaction", "Failed to start transaction.", () => this.beginTransactionNow());
  }

  private async beginTransactionNow(): Promise<void> {
    try {
      const cas = this.getOrCreateCAS();

      // Starting over here would hide that acknowledged statements are gone.
      // rollback() acknowledges the loss and clears this state. An abort has no
      // generation yet when it answered the backslash probe of the first statement.
      if (this.transactionGeneration !== null || this.transactionAbort !== null) {
        this.assertTransactionSession(cas);
      }

      if (!cas.isConnected) {
        await cas.connect();
      }

      this.autoCommit = false;
    } catch (error) {
      throw mapError("transaction", error, "Failed to start transaction.");
    }
  }

  async commit(): Promise<void> {
    return this.inTurn("transaction", "Failed to commit transaction.", () => this.commitNow());
  }

  private async commitNow(): Promise<void> {
    const cas = this.getOrCreateCAS();

    try {
      await this.dropSessionIfTransactionEnded(cas);

      if (!cas.isConnected) {
        throw this.notConnectedError(cas);
      }

      this.assertTransactionSession(cas);

      const { header, payload } = writeEndTran(EndTranType.COMMIT, cas.casInfo);
      const responsePayload = await cas.sendAndRecv(header, payload);
      parseSimpleResponse(responsePayload);

      // Replacing a session inside sendAndRecv() would have committed an empty
      // one, so this success must still be checked.
      this.assertTransactionSession(cas);
      this.endTransaction();
    } catch (error) {
      this.recordTransactionAbort(error);
      this.endTransactionIfSessionLost(cas);
      throw mapError("transaction", error, "Failed to commit transaction.");
    }
  }

  async rollback(): Promise<void> {
    return this.inTurn("transaction", "Failed to roll back transaction.", () => this.rollbackNow());
  }

  private async rollbackNow(): Promise<void> {
    const cas = this.getOrCreateCAS();

    try {
      if (!cas.isConnected) {
        throw this.notConnectedError(cas);
      }

      const { header, payload } = writeEndTran(EndTranType.ROLLBACK, cas.casInfo);
      const responsePayload = await cas.sendAndRecv(header, payload);
      parseSimpleResponse(responsePayload);

      this.endTransaction();
    } catch (error) {
      this.recordTransactionAbort(error);
      this.endTransactionIfSessionLost(cas);
      throw mapError("transaction", error, "Failed to roll back transaction.");
    }
  }

  async close(): Promise<void> {
    for (const cursor of this.openCursors) {
      cursor.cancel(
        mapError(
          "query",
          new ConnectionLostError("The connection was closed while this stream was open"),
          QUERY_FAILED,
        ),
      );
    }

    return this.queueStatement(() => this.closeNow());
  }

  private async closeNow(): Promise<void> {
    this.transactionOptions = pickTransactionOptions(this.config);

    if (!this.cas) {
      return;
    }

    const cas = this.cas;
    this.cas = null;
    this.noBackslashEscapes = null;
    this.backslashModeGeneration = null;
    this.insertIdBaseline = undefined;
    this.insertIdGeneration = null;
    this.endTransaction();

    try {
      // Send CON_CLOSE and tear down the socket as a single queued critical
      // section, so the close frame never interleaves with an in-flight query
      // (issue #39). The hook only runs while a live socket is present.
      await cas.close(async () => {
        const { header, payload } = writeConClose(cas.casInfo);
        await cas.send(header, payload);
      });
    } catch (error) {
      throw mapError("connection", error, "Failed to close CUBRID connection.");
    }
  }

  async ping(): Promise<string> {
    return this.inTurn("connection", "Health check failed.", () => this.pingNow());
  }

  private async pingNow(): Promise<string> {
    try {
      const cas = this.getOrCreateCAS();

      if (!cas.isConnected) {
        await cas.connect();
      }

      return await cas.ping(!this.autoCommit);
    } catch (error) {
      throw mapError("connection", error, "Health check failed.");
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Run `statement` after every statement issued before it has settled.
   *
   * One query is several CAS requests (execute, FETCHes, handle release), and
   * CASConnection only keeps those frames apart. A statement that ran between
   * them would be unsafe: on CUBRID 10.2 to 11.4 the end of a transaction closes
   * every other cursor on the session, and in autocommit mode that end comes
   * with DML, an error, a ping or another query's last row. The next FETCH of
   * the first query would then fail, or read whatever now has that handle
   * number. So at most one query lifecycle is live at a time. Autocommit could
   * not do better; an open
   * transaction could, but its commit and rollback would still have to wait.
   *
   * Nothing runs here but this adapter's own statements, so a statement can
   * never wait on its own turn. Waiting does not count towards readTimeout.
   */
  private inTurn<T>(
    kind: ErrorKind,
    failureMessage: string,
    statement: () => Promise<T>,
  ): Promise<T> {
    let waiting!: WaitingStatement;
    const refused = new Promise<never>((_resolve, reject) => {
      waiting = {
        since: Date.now(),
        refuse: (reason) => reject(mapError(kind, reason, failureMessage)),
      };
    });

    this.waitingStatements.add(waiting);
    this.watchHeldTurn();

    const turn = this.queueStatement(async () => {
      // A refused statement keeps its place in the queue but must not run.
      if (this.waitingStatements.delete(waiting)) {
        return statement();
      }
      return undefined as T;
    });

    return Promise.race([turn, refused]);
  }

  private queueStatement<T>(statement: () => Promise<T>): Promise<T> {
    const turn = this.statementQueue.then(statement);
    // The tail drops the result, so an idle connection does not keep its rows.
    const settled = (): void => undefined;
    this.statementQueue = turn.then(settled, settled);
    return turn;
  }

  /**
   * Arms the timer that refuses statements stuck behind a held stream, at the
   * earliest moment one of them could have waited `consumerTimeout` with no sign of
   * the consumer. Reading only the timestamps here keeps a row's cost at one
   * assignment: a consumer that is still reading just moves the deadline.
   */
  private watchHeldTurn(): void {
    const cursor = this.heldBy;
    if (!cursor || this.refusalTimer || this.waitingStatements.size === 0) {
      return;
    }

    const deadline = (statement: WaitingStatement): number =>
      Math.max(statement.since, cursor.activityAt) + cursor.consumerTimeout;
    let soonest = Number.POSITIVE_INFINITY;
    for (const statement of this.waitingStatements) {
      soonest = Math.min(soonest, deadline(statement));
    }

    this.refusalTimer = setTimeout(() => {
      this.refusalTimer = null;
      const now = Date.now();

      for (const statement of this.waitingStatements) {
        if (this.heldBy === cursor && now >= deadline(statement)) {
          this.waitingStatements.delete(statement);
          statement.refuse(
            new StreamBusyError(
              `This statement waited ${cursor.consumerTimeout}ms behind a stream whose ` +
                "consumer asked for no row. A statement awaited while iterating stream() " +
                "on the same connection can never run: finish or close the stream first, " +
                "or use transaction() or another client. Nothing was sent.",
            ),
          );
        }
      }

      this.watchHeldTurn();
    }, Math.max(0, soonest - Date.now()));
  }

  /** Hands rows over and, while more can follow, waits for the consumer to ask for them. */
  private async offerRows(
    cursor: StreamCursor,
    rows: Record<string, unknown>[],
    more: boolean,
  ): Promise<void> {
    const offered = cursor.offer(rows, more);

    if (more) {
      this.heldBy = cursor;
      this.watchHeldTurn();
      await offered;
      this.heldBy = null;

      if (this.refusalTimer) {
        clearTimeout(this.refusalTimer);
        this.refusalTimer = null;
      }
    }
  }

  /**
   * Feeds a stream from an open cursor, one window at a time and only on demand.
   *
   * LOB content is read when the consumer reaches its row, so `maxLobBytes` limits
   * one row and a stream holds one row's content, not a window's. Reads must not
   * be followed by the END_TRAN that query() sends after them: in autocommit mode
   * that would close this cursor (-1012), so it waits until the cursor is finished.
   *
   * An autocommit SELECT reports IN_TRAN until it reaches its last row, and closing
   * its handle earlier does not end that transaction: on CUBRID 10.2 to 11.4 the
   * session keeps its table lock, and its CAS, until the next statement. So a stream
   * that stops early commits. It changed nothing unless the SQL text did, and an
   * autocommit statement that ran is committed anyway.
   */
  private async streamWindows(
    cursor: StreamCursor,
    cas: CASConnection,
    result: PrepareAndExecuteResult,
    fetchSize: number,
  ): Promise<void> {
    const generation = cas.connectionGeneration;
    const lobColumns = result.columns.some(mayHoldLob);
    let rows = result.rows;
    let fetched = rows.length;
    let lobsRead = false;
    let replyDamaged = false;

    try {
      for (;;) {
        const lastWindow = fetched >= result.totalTupleCount;

        if (lobColumns) {
          for (const [index, row] of rows.entries()) {
            if (cursor.isStopped) {
              return;
            }
            // Detach the delivered row: decoded FETCH windows may remain referenced
            // by the query response while the consumer holds a large BLOB/CLOB.
            const delivered = { ...row };
            // Mark LOB activity before awaiting a read: a server error or abort
            // must still release the autocommit read transaction.
            lobsRead = this.measureLobs([delivered], "row").total > 0 || lobsRead;
            await this.loadRowLobs(cas, generation, delivered, cursor);
            await this.offerRows(cursor, [delivered], !lastWindow || index < rows.length - 1);
          }
        } else if (rows.length > 0) {
          await this.offerRows(cursor, rows, !lastWindow);
        }

        if (lastWindow || cursor.isStopped) {
          return;
        }

        rows = await this.fetchWindow(cas, generation, result, fetched, fetchSize);
        fetched += rows.length;
      }
    } catch (error) {
      if (error === STREAM_STOPPED) return;
      replyDamaged = error instanceof MalformedReplyError;
      throw error;
    } finally {
      if (this.autoCommit && !replyDamaged && (lobsRead || fetched < result.totalTupleCount)) {
        await this.endReadTransaction(cas, generation);
      }
    }
  }

  /** An INSERT executed by a query path can invalidate the insert-ID baseline. */
  private forgetInsertIdAfterQuery(result: PrepareAndExecuteResult): void {
    if (result.resultInfos.some((info) => info.statementType !== StatementType.SELECT)) {
      this.forgetInsertId();
    }
  }

  private executeQuery<T extends QueryResultRow>(
    sql: string,
    params: QueryParams | undefined,
    issued: IssuedOn,
    binds: PreparedBinds | undefined,
  ): Promise<QueryResult<T>> {
    const read = async (
      cas: CASConnection,
      result: PrepareAndExecuteResult,
    ): Promise<QueryResult<T>> => {
      // This may generate a value that nobody reads, so a later execute() on this
      // session could not tell it from its own.
      if (result.resultInfos.some((info) => info.statementType !== StatementType.SELECT)) {
        this.forgetInsertId();
      }

      if (result.statementType !== StatementType.SELECT) {
        return { rows: [], columns: [] };
      }

      const allRows = [...result.rows];
      const generation = cas.connectionGeneration;

      if (result.totalTupleCount > allRows.length) {
        try {
          await this.fetchRemaining(cas, result, allRows);
        } catch (error) {
          // An autocommit SELECT stays IN_TRAN until its last row is fetched, so
          // a FETCH that fails partway leaves the session holding the table lock,
          // and its CAS, until the next statement (#214). Ending it here keeps the
          // caller's error. A prepared statement is rolled back by runStatement(),
          // and nothing may follow a damaged reply: its session is dropped.
          if (binds === undefined && !(error instanceof MalformedReplyError)) {
            await this.endReadTransaction(cas, generation);
          }
          throw error;
        }
      }

      if (result.columns.some(mayHoldLob)) {
        // A prepared statement's transaction belongs to runStatement(), which
        // commits it only once everything succeeded.
        await this.loadLobs(cas, generation, allRows, binds === undefined);
      }

      return { rows: allRows as T[], columns: result.columns.map(toColumnInfo) };
    };

    return this.runStatement(sql, params, issued, read, false, binds);
  }

  /**
   * Counts a statement's affected rows and, after an INSERT, asks for the
   * session's last generated AUTO_INCREMENT value. See ExecuteResult.
   */
  private async readExecuteResult(
    cas: CASConnection,
    result: PrepareAndExecuteResult,
  ): Promise<ExecuteResult> {
    let affectedRows = 0;
    for (const { statementType, resultCount } of result.resultInfos) {
      if (statementType !== StatementType.SELECT && resultCount > 0) {
        affectedRows += resultCount;
      }
    }

    const executed: ExecuteResult = { affectedRows };
    if (!result.resultInfos.some((info) => info.statementType === StatementType.INSERT)) {
      if (affectedRows > 0) {
        this.forgetInsertId();
      }
      return executed;
    }

    const text = await this.fetchLastInsertId(cas);
    // The value belongs to the session: on CUBRID 10.2 to 11.4 nothing clears it,
    // not COMMIT, ROLLBACK or a failed statement, and an INSERT into a table
    // without AUTO_INCREMENT reports it again. Two tables can also generate the
    // same number, so nothing in the reply says whether this statement generated
    // it. A value that differs from the one seen before the statement is certainly
    // new; an equal one is ambiguous and reported as no id, because a wrong id is
    // worse than none.
    this.followInsertIdSession(cas);
    const generated =
      text !== undefined && this.insertIdBaseline !== null && text !== this.insertIdBaseline;
    this.insertIdBaseline = text;
    if (text !== undefined && generated) {
      const id = BigInt(text);
      executed.lastInsertId =
        id >= BigInt(Number.MIN_SAFE_INTEGER) && id <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(id)
          : id;
    }
    return executed;
  }

  /**
   * Sends one statement and hands its decoded reply to `use` while the handle
   * is open.
   *
   * `commitAfter` runs an autocommit statement as a transaction that ends only
   * after `use`: the generated AUTO_INCREMENT value lives in the session, and a
   * commit lets the CAS go, so a question asked after the autocommit flag could
   * reach a new session that holds no value. The statement is then committed with
   * END_TRAN, or rolled back if anything failed.
   *
   * `binds`, encoded when the call was made, sends PREPARE and EXECUTE with
   * typed binds instead of SQL text holding the values. The handle belongs to this one call and is released
   * like any other, so it can never outlive its session or be reused. Prepared
   * statements always end by END_TRAN in autocommit mode, so a failed PREPARE,
   * which leaves the session in a transaction, is rolled back.
   */
  private async runStatement<R>(
    sql: string,
    params: QueryParams | undefined,
    issued: IssuedOn,
    use: (cas: CASConnection, result: PrepareAndExecuteResult) => Promise<R>,
    commitAfter = false,
    binds?: PreparedBinds,
  ): Promise<R> {
    const cas = this.getOrCreateCAS();

    // Reconnecting here would drop the earlier statements of this transaction
    // and let a later commit() persist only the ones that follow.
    await this.dropSessionIfTransactionEnded(cas);
    this.assertTransactionSession(cas);

    // A query that was waiting when an earlier request ended with an unknown
    // outcome fails too, even if that session opened after this query was
    // issued or a ping has since reconnected. Running it on a new session would
    // hide that the statements before it may not have completed, and a hung
    // server would hold every waiting query for its own readTimeout. The next
    // query issued reconnects.
    if (cas === issued.cas && cas.failedExchanges !== issued.failedExchanges) {
      throw new Error("CASConnection is not connected");
    }

    // Settle the session before binding: a CAS that has gone is replaced by the
    // next request, which could otherwise be a different session than the one the
    // backslash mode was measured on.
    await cas.ensureSession();

    // Only a backslash, CR or LF is escaped differently by the two modes, so any
    // other parameters bind the same on every session and skip the probe.
    const resolvedSql =
      !binds && params && params.length > 0
        ? interpolateParams(
            sql,
            params,
            needsBackslashMode(params) ? await this.ensureBackslashMode(cas) : true,
          )
        : sql;

    const deferCommit = (commitAfter || binds !== undefined) && this.autoCommit;
    const { header, payload } = binds
      ? writePrepare(sql, cas.casInfo)
      : writePrepareAndExecute(resolvedSql, this.autoCommit && !deferCommit, cas.casInfo);

    // Before the first statement a ping may truthfully report OUT_TRAN.
    if (!this.autoCommit && this.transactionGeneration === null) {
      this.transactionEndReplies = cas.outOfTransactionReplies;
    }

    // Taken after the exchange: sending can replace a session whose CAS has gone,
    // and the statement then ran on the new session that COMMIT must reach.
    let generation = cas.connectionGeneration;
    try {
      const responsePayload = await cas.sendAndRecv(header, payload);
      generation = cas.connectionGeneration;

      const finished = await this.withQueryHandle(cas, responsePayload, async () => {
        await this.bindTransactionSession(cas);

        const result: PrepareAndExecuteResult = binds
          ? await this.executeHandle(cas, responsePayload, binds, generation)
          : parsePrepareAndExecute(responsePayload, cas.protoVersion, this.utcDates);

        const value = await use(cas, result);
        if (deferCommit) {
          await this.endStatementTransaction(cas, EndTranType.COMMIT, generation);
        }
        return value;
      });

      // A FETCH or the handle's release may have reported the end of the
      // transaction, so this statement cannot be called part of it.
      if (this.transactionEnded(cas)) {
        await cas.discardSession();
        throw new ConnectionLostError("Connection lost during transaction");
      }
      return finished;
    } catch (error) {
      if (deferCommit) {
        await this.endStatementTransaction(cas, EndTranType.ROLLBACK, generation).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  /**
   * Sends EXECUTE for the handle in a PREPARE reply. It must reach the session
   * that prepared it: on any other session the same number is another statement
   * or nothing. The CAS ignores extra values and the literal path ignores extra
   * parameters, so the count is checked against the server's here.
   */
  private async executeHandle(
    cas: CASConnection,
    prepareReply: Buffer,
    binds: PreparedBinds,
    generation: number,
  ): Promise<PrepareAndExecuteResult> {
    const statement = parsePrepare(prepareReply);
    if (statement.bindCount !== binds.count) {
      throw new Error(
        `Parameter count mismatch: the statement has ${statement.bindCount} markers, got ${binds.count} values`,
      );
    }

    const { header, payload } = writeExecute(statement, binds, cas.casInfo);
    const reply = await this.exchangeOnSession(cas, generation, header, payload);
    return parseExecute(reply, statement, cas.protoVersion, this.utcDates);
  }

  private async exchangeOnSession(
    cas: CASConnection,
    generation: number,
    header: Buffer,
    payload: Buffer,
  ): Promise<Buffer> {
    const reply = await cas.sendAndRecvOnSession(generation, header, payload);
    if (!reply) {
      throw new ConnectionLostError("Connection lost before the prepared statement finished");
    }
    return reply;
  }

  /** Ends the transaction of a statement run by runStatement(commitAfter), on its own session. */
  private async endStatementTransaction(
    cas: CASConnection,
    type: EndTranType,
    generation: number,
  ): Promise<void> {
    const { header, payload } = writeEndTran(type, cas.casInfo);
    const responsePayload = await cas.sendAndRecvOnSession(generation, header, payload);
    if (responsePayload) {
      parseSimpleResponse(responsePayload);
    } else if (type === EndTranType.COMMIT) {
      // The session that ran the statement is gone, and so are its changes.
      throw new ConnectionLostError("Connection lost before the statement was committed");
    }
  }

  /** Sends GET_LAST_INSERT_ID and returns the session's value, or undefined if it has none. */
  private async fetchLastInsertId(cas: CASConnection): Promise<string | undefined> {
    const { header, payload } = writeGetLastInsertId(cas.casInfo);
    return parseGetLastInsertId(await cas.sendAndRecv(header, payload));
  }

  /** A new session starts with no value, whatever the last one held. */
  private followInsertIdSession(cas: CASConnection): void {
    if (this.insertIdGeneration !== cas.connectionGeneration) {
      this.insertIdGeneration = cas.connectionGeneration;
      this.insertIdBaseline = undefined;
    }
  }

  /** The statement that just ran or failed may have changed the session's value. */
  private forgetInsertId(): void {
    if (this.cas) {
      this.followInsertIdSession(this.cas);
      this.insertIdBaseline = null;
    }
  }

  /**
   * When the baseline is unknown, read the server's value before a statement that
   * may ask for it. REPLACE replies as an INSERT, and no other SQL text does.
   */
  private async readInsertIdBaseline(sql: string): Promise<void> {
    const cas = this.getOrCreateCAS();
    this.followInsertIdSession(cas);
    if (this.insertIdBaseline !== null || !/insert|replace/i.test(sql)) {
      return;
    }
    this.assertTransactionSession(cas);
    if (cas.isConnected) {
      try {
        const value = await this.fetchLastInsertId(cas);
        this.followInsertIdSession(cas);
        this.insertIdBaseline = value;
      } catch (error) {
        // This read is outside withQueryHandle(), so a damaged reply, which may
        // not have ended where its frame said, must drop the session here.
        if (error instanceof MalformedReplyError) {
          await cas.discardSession();
        }
        throw error;
      }
    }
  }

  /**
   * Run `use`, then release the query handle held by `response` however `use`
   * ended. The handle is read first because decoding the response can fail
   * after the server has already allocated it. A discarded session has no
   * handle left to release, and closeQueryHandle() sends nothing on it.
   */
  private async withQueryHandle<R>(
    cas: CASConnection,
    response: Buffer,
    use: () => Promise<R>,
  ): Promise<R> {
    const queryHandle = readQueryHandle(response);
    const generation = cas.connectionGeneration;

    try {
      return await use();
    } catch (error) {
      // A damaged reply may not have ended where its frame said, so another
      // request here could read stale bytes as its answer, or wait forever.
      // The server rolls back the session's work and frees its handles.
      if (error instanceof MalformedReplyError) {
        await cas.discardSession();
      }
      throw error;
    } finally {
      if (queryHandle !== null) {
        await this.closeQueryHandle(cas, queryHandle, generation);
      }
    }
  }

  /** True when an open transaction's session is gone, or the server rolled it back. */
  private isTransactionSessionLost(cas: CASConnection): boolean {
    if (this.autoCommit) {
      return false;
    }

    return (
      this.transactionAbort !== null ||
      !cas.isConnected ||
      (this.transactionGeneration !== null &&
        cas.connectionGeneration !== this.transactionGeneration)
    );
  }

  /** Nothing was lost if this adapter never held a transaction on a session. */
  private notConnectedError(cas: CASConnection): Error {
    const message = "Not connected";
    return this.isTransactionSessionLost(cas) ? new ConnectionLostError(message) : new Error(message);
  }

  private assertTransactionSession(cas: CASConnection): void {
    // Keeping the reply as the cause reports the same code and kind as the
    // statement that failed, so a caller can tell this is worth a retry.
    if (this.transactionAbort !== null) {
      throw new Error("The server already rolled back this transaction, so nothing was sent", {
        cause: this.transactionAbort,
      });
    }

    if (this.isTransactionSessionLost(cas)) {
      throw new ConnectionLostError("Connection lost during transaction");
    }
  }

  /**
   * Called after a statement ran. If the session changed underneath it, that
   * statement is open on the new session, so drop the session rather than
   * let a later autocommit query persist work reported here as failed.
   *
   * The same goes for a transaction the server reports as over. See
   * transactionEnded().
   */
  private async bindTransactionSession(cas: CASConnection): Promise<void> {
    if (!this.autoCommit && this.transactionGeneration === null) {
      this.transactionGeneration = cas.connectionGeneration;
    }

    if (this.isTransactionSessionLost(cas) || this.transactionEnded(cas)) {
      await cas.discardSession();
      throw new ConnectionLostError("Connection lost during transaction");
    }
  }

  /**
   * Whether any reply since the transaction's first statement, END_TRAN aside,
   * said no transaction is open. Every reply inside a transaction says IN_TRAN on
   * CUBRID 10.2 to 11.4, even after -72, so this would mean the earlier statements
   * are gone and the next one would start over on a healthy session. It covers
   * FETCH, handle releases and pings too, because any later reply overwrites the
   * status, and a later statement would make it look open again.
   */
  private transactionEnded(cas: CASConnection): boolean {
    return (
      !this.autoCommit &&
      this.transactionEndReplies !== null &&
      cas.outOfTransactionReplies !== this.transactionEndReplies
    );
  }

  /** Dropping the session turns this into a lost transaction, which everything checks. */
  private async dropSessionIfTransactionEnded(cas: CASConnection): Promise<void> {
    if (cas.isConnected && this.transactionEnded(cas)) {
      await cas.discardSession();
    }
  }

  /** Retain a failed first statement's session so reconnection cannot hide it. */
  private bindSessionLostByFirstStatement(): void {
    if (
      !this.autoCommit &&
      this.transactionGeneration === null &&
      this.cas &&
      !this.cas.isConnected
    ) {
      this.transactionGeneration = this.cas.connectionGeneration;
    }
  }

  private recordTransactionAbort(error: unknown): void {
    if (!this.autoCommit && isServerTransactionAbort(error)) {
      this.transactionAbort = error;
    }
  }

  private endTransaction(): void {
    this.autoCommit = true;
    this.transactionGeneration = null;
    this.transactionEndReplies = null;
    this.transactionAbort = null;
  }

  /** The server discarded the work, so there is nothing left to end. */
  private endTransactionIfSessionLost(cas: CASConnection): void {
    if (this.isTransactionSessionLost(cas)) {
      this.endTransaction();
    }
  }

  private getOrCreateCAS(): CASConnection {
    if (!this.cas) {
      const casConfig: CASConnectionConfig = {
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        ...(this.config.connectionTimeout !== undefined && {
          connectionTimeout: this.config.connectionTimeout,
        }),
        ...(this.config.maxConnectionRetryCount !== undefined && {
          maxConnectionRetryCount: this.config.maxConnectionRetryCount,
        }),
        ...(this.config.readTimeout !== undefined && {
          readTimeout: this.config.readTimeout,
        }),
        sessionParameters: toSessionParameters(this.transactionOptions),
        ...this.resolveSslConfig(),
      };
      this.cas = new CASConnection(casConfig);
    }

    return this.cas;
  }

  /**
   * Translate the public `ssl` option (boolean | ClientSSLOptions) into the flat
   * TLS fields understood by CASConnectionConfig. Returns an empty object when
   * SSL is disabled so the non-SSL path is untouched.
   */
  private resolveSslConfig(): Partial<CASConnectionConfig> {
    const ssl = this.config.ssl;
    if (!ssl) {
      return {};
    }
    if (ssl === true) {
      return { ssl: true };
    }
    return {
      ssl: true,
      ...(ssl.rejectUnauthorized !== undefined && {
        rejectUnauthorized: ssl.rejectUnauthorized,
      }),
      ...(ssl.ca !== undefined && { ca: ssl.ca }),
      ...(ssl.servername !== undefined && { servername: ssl.servername }),
    };
  }


  /**
   * Return the negotiated backslash-escaping mode for the current connection,
   * probing again whenever the session has changed since it was measured.
   */
  private async ensureBackslashMode(cas: CASConnection): Promise<boolean> {
    if (this.noBackslashEscapes === null || this.backslashModeGeneration !== cas.connectionGeneration) {
      const generation = cas.connectionGeneration;
      this.noBackslashEscapes = await this.negotiateBackslashEscapes(cas);
      this.backslashModeGeneration = generation;
    }
    return this.noBackslashEscapes;
  }

  /**
   * Probe the live server to determine whether backslash-escape processing is
   * active, mirroring the CUBRID JDBC/pycubrid strategy.
   *
   * Sends `SELECT CHAR_LENGTH('\\')` (a literal two-backslash string):
   *   - result `2` -> backslash is a literal character
   *     (`no_backslash_escapes=yes`, the CUBRID default) -> returns `true`.
   *   - result `1` -> backslash-escape processing is on -> returns `false`.
   *
   * Any other result is treated as unknown and rejected rather than guessed,
   * because guessing wrong silently corrupts every string parameter.
   */
  private async negotiateBackslashEscapes(cas: CASConnection): Promise<boolean> {
    const { header, payload } = writePrepareAndExecute(
      "SELECT CHAR_LENGTH('\\\\')",
      // Never autocommit: that would commit an open transaction, and in autocommit
      // mode end the turn of the session the statement is about to bind on.
      false,
      cas.casInfo,
    );
    const responsePayload = await cas.sendAndRecv(header, payload);

    return this.withQueryHandle(cas, responsePayload, async () => {
      const result = parsePrepareAndExecute(responsePayload, cas.protoVersion);
      const firstRow = result.rows[0];
      const length = firstRow ? Number(Object.values(firstRow)[0]) : NaN;

      if (length === 2) {
        return true;
      }
      if (length === 1) {
        return false;
      }
      throw new Error(
        `Unable to determine CUBRID backslash-escaping mode: CHAR_LENGTH probe ` +
          `returned ${String(length)} (expected 1 or 2). Refusing to guess, as an ` +
          `incorrect mode silently corrupts string parameters.`,
      );
    });
  }

  private async fetchRemaining(
    cas: CASConnection,
    result: PrepareAndExecuteResult,
    allRows: Record<string, unknown>[],
  ): Promise<void> {
    const generation = cas.connectionGeneration;
    const fetchSize = this.config.fetchSize ?? DEFAULT_FETCH_SIZE;

    while (allRows.length < result.totalTupleCount) {
      const rows = await this.fetchWindow(cas, generation, result, allRows.length, fetchSize);
      allRows.push(...rows);
    }
  }

  /** Sends one FETCH for the rows after the first `fetched`, and returns its rows. */
  private async fetchWindow(
    cas: CASConnection,
    generation: number,
    result: PrepareAndExecuteResult,
    fetched: number,
    fetchSize: number,
  ): Promise<Record<string, unknown>[]> {
    const { header, payload } = writeFetch(result.queryHandle, fetched, fetchSize, cas.casInfo);
    // The handle exists only on this session, and FETCH is not a new request
    // that could be probed or moved to another one.
    const fetchPayload = await cas.sendAndRecvOnSession(generation, header, payload);
    if (fetchPayload === null) {
      throw new ConnectionLostError("Connection lost during FETCH");
    }
    const fetchResult = parseFetch(fetchPayload, result.columns, this.utcDates);

    // Returning a partial result as success silently corrupts the query
    // contract. The execute response still promises more rows here.
    if (fetchResult.tupleCount <= 0) {
      throw new Error(
        `CUBRID FETCH returned no rows before the expected ${result.totalTupleCount} rows`,
      );
    }
    if (
      fetchResult.rows.length !== fetchResult.tupleCount ||
      fetched + fetchResult.tupleCount > result.totalTupleCount
    ) {
      throw new Error("CUBRID FETCH returned an inconsistent row count");
    }

    return fetchResult.rows;
  }

  /**
   * Replace every LOB locator in `rows` with its content: a Buffer for a BLOB and
   * a string for a CLOB. A row never leaves the driver holding a locator.
   *
   * This runs inside the query's own turn because a locator cannot be kept: on
   * CUBRID 10.2 to 11.4 a later commit of a DELETE or UPDATE, or a rollback,
   * deletes the file it names, and there is no request that holds it or releases
   * it. The session is pinned for the same reason a query handle's release is:
   * sendAndRecv() could move to a new session after an autocommit reply.
   *
   * The sizes are checked before the first read, so a result over the limit
   * costs no LOB transfer and no memory.
   */
  private async loadLobs(
    cas: CASConnection,
    generation: number,
    rows: Record<string, unknown>[],
    endsReadTransaction: boolean,
  ): Promise<void> {
    const limit = this.config.maxLobBytes ?? DEFAULT_MAX_LOB_BYTES;
    const cells: Array<{ row: Record<string, unknown>; name: string; lob: LobLocator }> = [];
    let total = 0;

    for (const row of rows) {
      for (const [name, lob] of Object.entries(row)) {
        if (!(lob instanceof LobLocator)) {
          continue;
        }
        total += lob.size;
        if (total > limit) {
          throw new UnsupportedValueError(
            `CUBRID column "${name}" takes this query's LOB content to ${total} bytes, ` +
              `over the maxLobBytes limit of ${limit}`,
          );
        }
        cells.push({ row, name, lob });
      }
    }

    let replyDamaged = false;

    try {
      for (const { row, name, lob } of cells) {
        setColumn(row, name, decodeLob(name, lob, await this.readLob(cas, generation, name, lob)));
      }
    } catch (error) {
      replyDamaged = error instanceof MalformedReplyError;
      throw error;
    } finally {
      // An empty LOB sends no LOB_READ, and nothing may follow a damaged reply.
      if (total > 0 && !replyDamaged && endsReadTransaction) {
        await this.endReadTransaction(cas, generation);
      }
    }
  }

  /** Loads one row of a stream and returns whether that sent a LOB_READ. See streamWindows(). */
  private async loadRowLobs(
    cas: CASConnection,
    generation: number,
    row: Record<string, unknown>,
    cursor?: StreamCursor,
  ): Promise<boolean> {
    const { cells, total } = this.measureLobs([row], "row");

    for (const { name, lob } of cells) {
      assertStreamWanted(cursor);
      setColumn(row, name, decodeLob(name, lob, await this.readLob(cas, generation, name, lob, cursor)));
    }

    return total > 0;
  }

  /** Finds the LOB cells of `rows` and refuses them if their content is over the limit. */
  private measureLobs(
    rows: Record<string, unknown>[],
    scope: "query" | "row",
  ): {
    cells: Array<{ row: Record<string, unknown>; name: string; lob: LobLocator }>;
    total: number;
  } {
    const limit = this.config.maxLobBytes ?? DEFAULT_MAX_LOB_BYTES;
    const cells: Array<{ row: Record<string, unknown>; name: string; lob: LobLocator }> = [];
    let total = 0;

    for (const row of rows) {
      for (const [name, lob] of Object.entries(row)) {
        if (!(lob instanceof LobLocator)) {
          continue;
        }
        total += lob.size;
        if (total > limit) {
          throw new UnsupportedValueError(
            `CUBRID column "${name}" takes this ${scope}'s LOB content to ${total} bytes, ` +
              `over the maxLobBytes limit of ${limit}`,
          );
        }
        cells.push({ row, name, lob });
      }
    }

    return { cells, total };
  }

  private async readLob(
    cas: CASConnection,
    generation: number,
    name: string,
    lob: LobLocator,
    cursor?: StreamCursor,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let received = 0;

    while (received < lob.size) {
      assertStreamWanted(cursor);
      const length = Math.min(lob.size - received, LOB_READ_CHUNK_SIZE);
      const { header, payload } = writeLobRead(lob.handle, received, length, cas.casInfo);
      const response = await cas.sendAndRecvOnSession(generation, header, payload);

      if (response === null) {
        throw new ConnectionLostError("CASConnection is not connected");
      }

      const chunk = parseLobRead(response, length);
      // The reply has now been consumed; cancellation may interrupt before
      // any subsequent LOB_READ or another column, never mid-frame.
      assertStreamWanted(cursor);
      if (chunk.length === 0) {
        throw new UnsupportedValueError(
          `CUBRID column "${name}" holds ${received} of its declared ${lob.size} LOB bytes`,
        );
      }

      chunks.push(chunk);
      received += chunk.length;
    }

    return Buffer.concat(chunks, received);
  }

  /**
   * LOB_READ opens a transaction on the server, so an autocommit session is left
   * with one after its statement finished, and CAS_INFO stops reporting it as
   * releasable: an idle client would keep its CAS. Nothing was changed, so this
   * only ends that. Inside a caller's transaction there is nothing to do.
   */
  private async endReadTransaction(cas: CASConnection, generation: number): Promise<void> {
    if (!this.autoCommit) {
      return;
    }

    try {
      const { header, payload } = writeEndTran(EndTranType.COMMIT, cas.casInfo);
      const responsePayload = await cas.sendAndRecvOnSession(generation, header, payload);

      if (responsePayload) {
        parseSimpleResponse(responsePayload);
      }
    } catch {
      // The rows are complete and must still be returned, but this reply cannot
      // be trusted to have left the stream aligned, so nothing more goes on this
      // session, not even the query handle's release.
      if (cas.isConnected) {
        await cas.discardSession();
      }
    }
  }

  /**
   * Best-effort release on the session that created the handle, so a cleanup
   * failure cannot replace the caller's own error. If that session is gone the
   * server has dropped the handle with it and nothing is sent.
   */
  private async closeQueryHandle(
    cas: CASConnection,
    queryHandle: number,
    generation: number,
  ): Promise<void> {
    try {
      const { header, payload } = writeCloseReqHandle(queryHandle, cas.casInfo);
      const responsePayload = await cas.releaseOnSession(generation, header, payload);

      if (responsePayload) {
        parseSimpleResponse(responsePayload);
      }
    } catch {
      // Best-effort cleanup — ignore errors
    }
  }
}

/**
 * Checks the SQL and encodes the values when a prepared method is called, before
 * it waits for its turn or sends anything: a refused statement must not read the
 * insert id, open a session or be probed. The binds are a snapshot, so changing
 * the array afterwards does not change what is sent.
 */
function bindOrRefuse(sql: string, params: QueryParams | undefined, message: string): PreparedBinds {
  try {
    assertPreparableSql(sql);
    return encodePreparedParams(params ?? []);
  } catch (error) {
    throw mapError("query", error, message);
  }
}

function toColumnInfo(column: ColumnMeta): ColumnInfo {
  const typeName = (id: number): string => TYPE_NAMES[id] ?? `UNKNOWN(${id})`;
  return {
    name: column.name,
    type: typeName(column.type),
    ...(column.elementType === undefined ? {} : { elementType: typeName(column.elementType) }),
    precision: column.precision,
    scale: column.scale,
    nullable: column.isNullable,
  };
}

function decodeLob(name: string, lob: LobLocator, content: Buffer): Buffer | string {
  if (lob.type === CUBRIDDataType.BLOB) {
    return content;
  }

  try {
    return CLOB_DECODER.decode(content);
  } catch (error) {
    throw new UnsupportedValueError(`CUBRID CLOB column "${name}" is not valid UTF-8`, {
      cause: error,
    });
  }
}
