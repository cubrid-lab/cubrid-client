import { AsyncLocalStorage } from "node:async_hooks";

import { NativeCubridAdapter } from "../adapters/native.js";
import { ConnectionError } from "../errors/connection-error.js";
import type { CubridErrorKind } from "../errors/error-details.js";
import { createEmit, withLogging } from "../internals/log-connection.js";
import { isAbortReason, mapError } from "../internals/map-error.js";
import {
  assertValidQueryOptions,
  assertValidStreamOptions,
  assertValidTransactionOptions,
  normalizeConfig,
  pickTransactionOptions,
} from "../internals/normalize-config.js";
import { type SessionState, sessionStateReader } from "../internals/session-state.js";
import type {
  BatchExecutable,
  BatchTransactionClient,
  ClientConfig,
  ClientLogFields,
  ClientLogLevel,
  ConnectionFactory,
  ConnectionLike,
  Executable,
  ExecutableTransactionClient,
  ExecuteManyResult,
  ExecuteOptions,
  ExecuteResult,
  PreparedQueryable,
  PreparedTransactionClient,
  Queryable,
  QueryOptions,
  ResultQueryable,
  ResultTransactionClient,
  Streamable,
  StreamOptions,
  TransactionCallback,
  TransactionOptions,
  TransactionScope,
} from "../types/client.js";
import { type PreparedQueryParam, refuseLobParams } from "../types/lob.js";
import type {
  PoolConnection,
  PoolConnectionOptions,
  PoolOptions,
  PoolStats,
} from "../types/pool.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResult, QueryResultRow } from "../types/result.js";
import type {
  SchemaColumn,
  SchemaIndex,
  SchemaOptions,
  SchemaPrimaryKey,
  SchemaTable,
} from "../types/schema.js";
import { streamRows } from "./client.js";
import {
  applyTransactionOptions,
  beginScope,
  type ConnectionSource,
  type ConnectionVerdict,
  runTransaction,
} from "./connection-source.js";
import * as schema from "./schema.js";
import type { ScopedTransaction } from "./transaction.js";

/** Largest delay Node.js timers support. */
const MAX_TIMER = 2 ** 31 - 1;

/** Share of `maxLifetimeMs` by which a connection's own limit may be shorter. */
const LIFETIME_JITTER = 0.1;

/** Why the pool closed a connection, reported as `reason` of `pool.destroy`. */
type DestroyReason =
  | "in-transaction"
  | "busy"
  | "failed-exchange"
  | "options"
  | "lifetime"
  | "idle"
  | "validation"
  | "error"
  | "closed";

interface PoolSettings {
  max: number;
  min: number;
  acquireTimeoutMs: number;
  maxWaitingClients: number;
  idleTimeoutMs: number;
  maxLifetimeMs: number | undefined;
  validateAfterIdleMs: number | undefined;
}

/** One open connection the pool owns. */
interface Pooled {
  connection: ConnectionLike;
  readState: (() => SessionState) | undefined;
  /** When it must no longer be reused; Infinity without `maxLifetimeMs`. */
  expiresAt: number;
  idleSince: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Closed or being closed; nothing may use it again. */
  destroyed: boolean;
}

type LeaseKind = "statement" | "stream" | "connection" | "transaction" | "scope";

/** One caller's hold on a connection, from delivery to release. */
interface Lease {
  pooled: Pooled;
  kind: LeaseKind;
  /** What the holder calls: the connection, refusing calls once the lease ended. */
  connection: ConnectionLike;
  failedExchangesAtStart: number;
  /** Calls not yet settled, and streams not yet finished. */
  inFlight: number;
  /** A call rejected. Decides reuse only for a connection that cannot report its state. */
  failed: boolean;
  /** Transaction settings other than the pool's were applied; they cannot be undone. */
  changedOptions: boolean;
  ended: boolean;
  done: Promise<void>;
  markDone: () => void;
}

/** A caller waiting for a connection. */
/** The lease a `connection()` or `transaction()` callback runs on, once known. */
interface LeaseSlot {
  lease?: Lease;
}

interface Waiter {
  kind: LeaseKind;
  settled: boolean;
  /** Hands over `pooled`; false when the caller already gave up. */
  deliver: (pooled: Pooled) => boolean;
  fail: (error: unknown) => void;
}

/** The lease of a `connection()` or `transaction()` call, whose callback may await close(). */
function isCallbackLease(lease: Lease): boolean {
  return lease.kind === "connection" || lease.kind === "transaction";
}

function poolError(kind: CubridErrorKind, message: string): ConnectionError {
  return new ConnectionError(message, { kind, outcomeUnknown: false });
}

function releasedError(): ConnectionError {
  return new ConnectionError(
    "This pool connection was released when its callback settled, so nothing was sent.",
    { outcomeUnknown: false },
  );
}

function assertInteger(name: string, value: number, min: number, max: number): void {
  if (!(Number.isInteger(value) && value >= min && value <= max)) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  }
}

function resolvePoolSettings(options: PoolOptions): PoolSettings {
  const {
    max = 10,
    min = 0,
    acquireTimeoutMs = 30_000,
    maxWaitingClients = Number.POSITIVE_INFINITY,
    idleTimeoutMs = 30_000,
    maxLifetimeMs,
    validateAfterIdleMs,
  } = options;

  if (!(Number.isSafeInteger(max) && max >= 1)) {
    throw new RangeError("max must be an integer of at least 1.");
  }
  assertInteger("min", min, 0, max);
  assertInteger("acquireTimeoutMs", acquireTimeoutMs, 1, MAX_TIMER);
  if (
    maxWaitingClients !== Number.POSITIVE_INFINITY &&
    !(Number.isSafeInteger(maxWaitingClients) && maxWaitingClients >= 0)
  ) {
    throw new RangeError("maxWaitingClients must be a non-negative integer or Infinity.");
  }
  assertInteger("idleTimeoutMs", idleTimeoutMs, 0, MAX_TIMER);
  if (maxLifetimeMs !== undefined) {
    assertInteger("maxLifetimeMs", maxLifetimeMs, 1, MAX_TIMER);
  }
  if (validateAfterIdleMs !== undefined) {
    assertInteger("validateAfterIdleMs", validateAfterIdleMs, 0, MAX_TIMER);
  }

  return {
    max,
    min,
    acquireTimeoutMs,
    maxWaitingClients,
    idleTimeoutMs,
    maxLifetimeMs,
    validateAfterIdleMs,
  };
}

/**
 * Create a pool of connections to one database. Nothing waits here: `min`
 * connections are opened in the background, and every other one when a caller
 * needs it.
 *
 * @throws RangeError or TypeError when an option is invalid.
 */
export function createPool(options: PoolOptions): CubridPool {
  return new CubridPool(options);
}

type Runner = <R>(
  options: QueryOptions | undefined,
  failureMessage: string,
  run: (connection: ConnectionLike) => Promise<R>,
) => Promise<R>;

type StreamOpener = <T extends QueryResultRow>(
  sql: string,
  params: QueryParams | undefined,
  options: StreamOptions | undefined,
) => AsyncGenerator<T, void, undefined>;

/**
 * The statement methods, on whatever connection `run` provides: a new lease per
 * call for the pool, the callback's lease for `connection()`.
 */
class PoolStatements implements PoolConnection {
  constructor(
    private readonly run: Runner,
    private readonly openStream: StreamOpener,
  ) {}

  /**
   * A method that renders SQL literals refuses blob() and clob() before it
   * leases anything, as the client does.
   */
  private runLiteral<R>(
    params: QueryParams | undefined,
    options: QueryOptions | undefined,
    failureMessage: string,
    run: (connection: ConnectionLike) => Promise<R>,
  ): Promise<R> {
    try {
      refuseLobParams(params);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.run(options, failureMessage, run);
  }

  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.runLiteral(params, options, "Query failed.", (connection) =>
      connection.query<T>(sql, params, options),
    );
  }

  queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return this.runLiteral(params, options, "Query failed.", (connection) => {
      if (!connection.queryResult) {
        throw new Error("Underlying connection does not support queryResult.");
      }
      return connection.queryResult<T>(sql, params, options);
    });
  }

  execute(sql: string, params?: QueryParams, options?: ExecuteOptions): Promise<ExecuteResult> {
    return this.runLiteral(params, options, "Statement failed.", (connection) => {
      if (!connection.execute) {
        throw new Error("Underlying connection does not support execute.");
      }
      return connection.execute(sql, params, options);
    });
  }

  queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.run(options, "Query failed.", (connection) => {
      if (!connection.queryPrepared) {
        throw new Error("Underlying connection does not support queryPrepared.");
      }
      return connection.queryPrepared<T>(sql, params, options);
    });
  }

  queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return this.run(options, "Query failed.", (connection) => {
      if (!connection.queryResultPrepared) {
        throw new Error("Underlying connection does not support queryResultPrepared.");
      }
      return connection.queryResultPrepared<T>(sql, params, options);
    });
  }

  executePrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return this.run(options, "Statement failed.", (connection) => {
      if (!connection.executePrepared) {
        throw new Error("Underlying connection does not support executePrepared.");
      }
      return connection.executePrepared(sql, params, options);
    });
  }

  executeMany(
    sql: string,
    paramSets: readonly QueryParams[],
    options?: QueryOptions,
  ): Promise<ExecuteManyResult> {
    return this.run(options, "Statement failed.", (connection) => {
      if (!connection.executeMany) {
        throw new Error("Underlying connection does not support executeMany.");
      }
      return connection.executeMany(sql, paramSets, options);
    });
  }

  stream<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: StreamOptions,
  ): AsyncGenerator<T, void, undefined> {
    assertValidStreamOptions(options);
    refuseLobParams(params);
    return this.openStream<T>(sql, params, options);
  }
}

/**
 * Wraps a stream so the lease counts it as in flight until it ends, and records
 * a failed read.
 */
function trackStream<T>(lease: Lease, rows: AsyncIterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = rows[Symbol.asyncIterator]();
      let open = true;
      lease.inFlight += 1;
      const finish = (failed: boolean): void => {
        if (failed) {
          lease.failed = true;
        }
        if (open) {
          open = false;
          lease.inFlight -= 1;
        }
      };

      return {
        next: async () => {
          try {
            const next = await iterator.next();
            if (next.done) {
              finish(false);
            }
            return next;
          } catch (error) {
            finish(true);
            throw error;
          }
        },
        return: async (value?: unknown) => {
          try {
            const result = (await iterator.return?.(value)) ?? { done: true, value: undefined };
            finish(false);
            return result as IteratorResult<T>;
          } catch (error) {
            finish(true);
            throw error;
          }
        },
      };
    },
  };
}

/**
 * The connection a lease holder calls. It counts the calls still running,
 * records a failed one and refuses every call once the lease has ended, so a
 * reference kept past its lease can never reach the next holder's session.
 */
function leasedConnection(lease: Lease): ConnectionLike {
  const target = lease.pooled.connection;
  return new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value !== "function" || typeof property === "symbol") {
        return value;
      }

      return (...args: unknown[]): unknown => {
        if (lease.ended) {
          return property === "stream"
            ? (async function* refused() {
                yield* [];
                throw releasedError();
              })()
            : Promise.reject(releasedError());
        }

        const result: unknown = value.apply(object, args);
        if (property === "stream") {
          return trackStream(lease, result as AsyncIterable<unknown>);
        }
        if (!(result instanceof Promise)) {
          return result;
        }

        lease.inFlight += 1;
        return result.then(
          (settled: unknown) => {
            lease.inFlight -= 1;
            return settled;
          },
          (error: unknown) => {
            lease.inFlight -= 1;
            lease.failed = true;
            throw error;
          },
        );
      };
    },
  });
}

/**
 * A pool of connections to one database. Each statement method leases a
 * connection for that statement only; `stream()` holds its lease until the
 * stream ends; `transaction()`, `beginTransactionScope()` and `connection()`
 * hold one until they end. A connection goes back to the pool only when its
 * session is clean: no open transaction, nothing still running, no request
 * with an unknown outcome and no transaction settings other than the pool's.
 * Otherwise it is closed. See `docs/API_REFERENCE.md` and ADR 0008.
 */
export class CubridPool
  implements Queryable, ResultQueryable, Executable, PreparedQueryable, BatchExecutable, Streamable
{
  private closed = false;
  /** Everything close() waits for but callbacks; started by the first close(). */
  private draining: Promise<void> | undefined;
  /** The leases of `connection()` and `transaction()` calls when close() was first called. */
  private closingCallbacks: Lease[] = [];
  /** close() for every caller outside a running callback, returned to each of them. */
  private closing: Promise<void> | undefined;
  private readonly idle: Pooled[] = [];
  private readonly active = new Set<Pooled>();
  private pending = 0;
  /** Callers waiting in line, in arrival order. */
  private readonly waiting: Waiter[] = [];
  /** Every caller that has not been given a connection or an error yet. */
  private readonly unsettled = new Set<Waiter>();
  private readonly leases = new Map<ConnectionLike, Lease>();
  private readonly opening = new Set<Promise<unknown>>();
  private readonly closings = new Set<Promise<void>>();
  private readonly openScopes = new Set<ScopedTransaction>();
  private readonly beginningScopes = new Set<Promise<unknown>>();
  private readonly statements: PoolStatements;
  /** Leases whose `connection()` or `transaction()` callback is running now. */
  private readonly runningCallbacks = new Set<Lease>();
  /** The callback leases enclosing this async context, so close() never waits for itself. */
  private readonly enclosingCallbacks = new AsyncLocalStorage<ReadonlySet<Lease>>();
  private readonly emit: (level: ClientLogLevel, message: string, fields: ClientLogFields) => void;
  private readonly config: ClientConfig;
  private readonly connectionFactory: ConnectionFactory;
  private readonly settings: PoolSettings;

  /** Same as {@link createPool}. */
  constructor(options: PoolOptions) {
    const config = normalizeConfig(options);
    this.settings = resolvePoolSettings(options);
    const baseFactory =
      options.connectionFactory ?? ((clientConfig) => new NativeCubridAdapter(clientConfig));
    this.connectionFactory =
      config.logger === undefined ? baseFactory : withLogging(baseFactory, config.logger);
    this.config = config;
    this.emit = createEmit(config.logger);
    this.statements = new PoolStatements(
      (options, failureMessage, run) => this.runStatement(options, failureMessage, run),
      (sql, params, options) => this.streamOnLease(sql, params, options),
    );
    this.fillMin();
  }

  /** Run a statement on a leased connection and return its rows. See {@link QueryOptions}. */
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.statements.query<T>(sql, params, options);
  }

  queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return this.statements.queryResult<T>(sql, params, options);
  }

  execute(sql: string, params?: QueryParams, options?: ExecuteOptions): Promise<ExecuteResult> {
    return this.statements.execute(sql, params, options);
  }

  queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.statements.queryPrepared<T>(sql, params, options);
  }

  queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return this.statements.queryResultPrepared<T>(sql, params, options);
  }

  executePrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return this.statements.executePrepared(sql, params, options);
  }

  /** `executeMany()` of the client, on one leased connection, in autocommit mode. */
  executeMany(
    sql: string,
    paramSets: readonly QueryParams[],
    options?: QueryOptions,
  ): Promise<ExecuteManyResult> {
    return this.statements.executeMany(sql, paramSets, options);
  }

  /**
   * Read a statement's rows one at a time with `for await`. The stream holds its
   * connection from the first read until it ends, so a statement awaited inside
   * the loop runs on another connection of the pool, or waits for one.
   *
   * @throws RangeError at once when an option is invalid.
   */
  stream<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: StreamOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.statements.stream<T>(sql, params, options);
  }

  /**
   * Run `fn` with one connection of the pool, in autocommit mode, and release it
   * when `fn` settles. The connection rejects every call made after that.
   * `options.signal` cancels the wait for the connection.
   */
  async connection<T>(
    fn: (connection: PoolConnection) => Promise<T>,
    options?: PoolConnectionOptions,
  ): Promise<T> {
    if (options?.signal !== undefined && !(options.signal instanceof AbortSignal)) {
      throw new TypeError("signal must be an AbortSignal.");
    }
    options?.signal?.throwIfAborted();

    const lease = await this.acquire("connection", options?.signal);
    const handle = new PoolStatements(
      async (statementOptions, failureMessage, run) => {
        assertValidQueryOptions(statementOptions);
        statementOptions?.signal?.throwIfAborted();
        if (lease.ended) {
          throw releasedError();
        }
        try {
          return await run(lease.connection);
        } catch (error) {
          if (isAbortReason(error, statementOptions?.signal)) {
            throw error;
          }
          throw mapError("query", error, failureMessage);
        }
      },
      async function* openStream<R extends QueryResultRow>(
        sql: string,
        params: QueryParams | undefined,
        streamOptions: StreamOptions | undefined,
      ): AsyncGenerator<R, void, undefined> {
        if (lease.ended) {
          throw releasedError();
        }
        yield* streamRows<R>(async () => lease.connection, sql, params, streamOptions);
      },
    );

    try {
      return await this.runCallback(lease, () => fn(handle));
    } finally {
      this.release(lease);
    }
  }

  /**
   * `transaction()` of the client, on a leased connection. The connection goes
   * back to the pool only when the transaction ended cleanly.
   */
  transaction<T>(
    callback: TransactionCallback<
      T,
      ResultTransactionClient &
        ExecutableTransactionClient &
        PreparedTransactionClient &
        BatchTransactionClient
    >,
    options?: TransactionOptions,
  ): Promise<T> {
    try {
      assertValidTransactionOptions(options);
    } catch (error) {
      return Promise.reject(error);
    }
    const slot: LeaseSlot = {};
    return runTransaction(
      this.sourceFor("transaction", slot),
      async (tx) => {
        // close() ran while the transaction options were applied or BEGIN was sent:
        // the callback never starts, and the transaction is rolled back and its
        // connection closed, as CubridClient.transaction() does.
        if (this.closed) {
          throw poolError("pool-closed", "Pool is closed.");
        }
        return this.runCallback(slot.lease, () => callback(tx));
      },
      options,
    );
  }

  /**
   * `beginTransactionScope()` of the client, on a leased connection held until
   * `commit()` or `rollback()`. `close()` discards a scope nobody ended.
   *
   * @throws RangeError at once when an option is invalid.
   */
  async beginTransactionScope(options?: TransactionOptions): Promise<TransactionScope> {
    assertValidTransactionOptions(options);

    const beginning = beginScope(
      this.sourceFor("scope"),
      options,
      () => this.closed,
      "Pool is closed.",
      this.openScopes,
    );
    this.beginningScopes.add(beginning);
    try {
      return await beginning;
    } finally {
      this.beginningScopes.delete(beginning);
    }
  }

  /** Check one leased connection, as `CubridClient.ping()` does. */
  ping(): Promise<string> {
    return this.pingLeased("Health check failed.", "Underlying connection does not support ping.");
  }

  /** Return the CUBRID server version, for example `11.4.6.1963`. */
  getServerVersion(): Promise<string> {
    return this.pingLeased(
      "Failed to get the server version.",
      "Underlying connection does not support querying the server version.",
    );
  }

  /** See `CubridClient.getTables()`. */
  getTables(options?: SchemaOptions): Promise<SchemaTable[]> {
    return this.runSchemaOperation((query) => schema.getTables(query, options));
  }

  /** See `CubridClient.getColumns()`. */
  getColumns(table: string, options?: SchemaOptions): Promise<SchemaColumn[]> {
    return this.runSchemaOperation((query) => schema.getColumns(query, table, options));
  }

  /** See `CubridClient.getPrimaryKey()`. */
  getPrimaryKey(table: string, options?: SchemaOptions): Promise<SchemaPrimaryKey | null> {
    return this.runSchemaOperation((query) => schema.getPrimaryKey(query, table, options));
  }

  /** See `CubridClient.getIndexes()`. */
  getIndexes(table: string, options?: SchemaOptions): Promise<SchemaIndex[]> {
    return this.runSchemaOperation((query) => schema.getIndexes(query, table, options));
  }

  /** Counts of connections and waiting callers at this moment. */
  stats(): PoolStats {
    return {
      total: this.total(),
      idle: this.idle.length,
      active: this.active.size,
      pending: this.pending,
      waiting: this.waiting.length,
    };
  }

  /**
   * Stop leasing and close every connection. In order: new calls and waiting
   * callers reject with kind `pool-closed`; idle connections close; open streams
   * end, as their connections close; statements, `connection()` callbacks and
   * `transaction()` callbacks run to their end and their connections close.
   * Scopes nobody ended are discarded meanwhile, not after: a statement may be
   * waiting for a lock that only such a scope holds. A `transaction()` whose
   * callback has not started yet is rolled back without running it. Calling it
   * again outside every callback returns the same promise. Awaited inside a
   * running `connection()` or `transaction()` callback, it waits for no callback,
   * since it would wait for itself (#268).
   */
  close(): Promise<void> {
    if (!this.draining) {
      this.closingCallbacks = [...this.leases.values()].filter(isCallbackLease);
      this.draining = this.drain();
    }

    // A callback awaiting close() would wait for itself, and two of them for each
    // other, so inside a running callback close() waits for no callback. Only
    // while it runs: a timer it set that calls close() after it returned waits.
    const own = this.enclosingCallbacks.getStore();
    if (own && [...own].some((lease) => this.runningCallbacks.has(lease))) {
      return this.draining;
    }
    this.closing ??= this.waitForCallbacks();
    return this.closing;
  }

  /** `draining`, then the callbacks running when close() was first called, and their connections. */
  private async waitForCallbacks(): Promise<void> {
    await Promise.allSettled([this.draining, ...this.closingCallbacks.map((lease) => lease.done)]);
    await this.settleConnections();
  }

  /** Runs a `connection()` or `transaction()` callback, known to close() while it runs. */
  private async runCallback<T>(lease: Lease | undefined, run: () => Promise<T>): Promise<T> {
    const chain = new Set(this.enclosingCallbacks.getStore());
    if (lease) {
      chain.add(lease);
      this.runningCallbacks.add(lease);
    }
    try {
      return await this.enclosingCallbacks.run(chain, run);
    } finally {
      if (lease) {
        this.runningCallbacks.delete(lease);
      }
    }
  }

  /** Never rejects. */
  private async drain(): Promise<void> {
    // Before the first await, so no call made after close() can lease.
    this.closed = true;

    for (const waiter of [...this.unsettled]) {
      waiter.fail(poolError("pool-closed", "Pool is closed."));
    }
    this.waiting.length = 0;
    for (const pooled of this.idle.splice(0)) {
      this.destroy(pooled, "closed");
    }

    // Closing the connection is what stops a stream its consumer no longer reads.
    const leases = [...this.leases.values()];
    for (const lease of leases) {
      if (lease.kind === "stream") {
        this.active.delete(lease.pooled);
        this.destroy(lease.pooled, "closed");
      }
    }

    const scopes = Promise.allSettled([
      ...this.beginningScopes,
      ...[...this.openScopes].map((scope) => scope.discard()),
    ]);
    // A stream is not awaited: its consumer may never read again. Callbacks are
    // waited for by close() itself, alongside this.
    await Promise.allSettled(
      leases
        .filter(
          (lease) => lease.kind !== "scope" && lease.kind !== "stream" && !isCallbackLease(lease),
        )
        .map((lease) => lease.done),
    );
    await scopes;
    await this.settleConnections();
  }

  /** Waits for the connections being opened or closed now. */
  private async settleConnections(): Promise<void> {
    // A connection still being opened is closed as soon as it opens.
    while (this.opening.size > 0 || this.closings.size > 0) {
      await Promise.allSettled([...this.opening, ...this.closings]);
    }
  }

  private total(): number {
    return this.idle.length + this.active.size + this.pending;
  }

  /** Connections open now, leaving out those still opening. */
  private open(): number {
    return this.idle.length + this.active.size;
  }

  private canServe(): boolean {
    return this.idle.length > 0 || this.total() < this.settings.max;
  }

  private sourceFor(kind: "transaction" | "scope", slot: LeaseSlot = {}): ConnectionSource {
    return {
      open: async () => {
        slot.lease = await this.acquire(kind);
        return slot.lease.connection;
      },
      applyOptions: async (connection, options) => {
        const wanted = pickTransactionOptions(options);
        const differs = (Object.keys(wanted) as Array<keyof TransactionOptions>).some(
          (key) => wanted[key] !== this.config[key],
        );
        if (!differs) {
          return;
        }

        const lease = this.leases.get(connection);
        if (lease) {
          // Before sending: a failed change leaves the settings unknown too.
          lease.changedOptions = true;
        }
        await applyTransactionOptions(connection, {
          ...pickTransactionOptions(this.config),
          ...wanted,
        });
      },
      end: async (connection, verdict) => {
        const lease = this.leases.get(connection);
        if (lease) {
          this.release(lease, verdict);
        }
      },
    };
  }

  private async runStatement<R>(
    options: QueryOptions | undefined,
    failureMessage: string,
    run: (connection: ConnectionLike) => Promise<R>,
  ): Promise<R> {
    assertValidQueryOptions(options);
    options?.signal?.throwIfAborted();

    // A failure to lease is already a ConnectionError, or the caller's own abort.
    const lease = await this.acquire("statement", options?.signal);
    try {
      return await run(lease.connection);
    } catch (error) {
      if (isAbortReason(error, options?.signal)) {
        throw error;
      }
      throw mapError("query", error, failureMessage);
    } finally {
      this.release(lease);
    }
  }

  private async *streamOnLease<T extends QueryResultRow>(
    sql: string,
    params: QueryParams | undefined,
    options: StreamOptions | undefined,
  ): AsyncGenerator<T, void, undefined> {
    options?.signal?.throwIfAborted();
    const lease = await this.acquire("stream", options?.signal);
    try {
      yield* streamRows<T>(async () => lease.connection, sql, params, options);
    } finally {
      this.release(lease);
    }
  }

  private async pingLeased(failureMessage: string, unsupported: string): Promise<string> {
    const lease = await this.acquire("statement");
    try {
      if (!lease.connection.ping) {
        throw new Error(unsupported);
      }
      return await lease.connection.ping();
    } catch (error) {
      throw mapError("connection", error, failureMessage);
    } finally {
      this.release(lease);
    }
  }

  /** A catalog inspection runs all its queries on one lease. */
  private async runSchemaOperation<T>(
    operation: (query: schema.SchemaQuery) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire("statement");
    try {
      return await operation(async (sql, params) => {
        try {
          return await lease.connection.query(sql, params);
        } catch (error) {
          throw mapError("query", error, "Query failed.");
        }
      });
    } finally {
      this.release(lease);
    }
  }

  /**
   * Lease a connection: an idle one, a new one while fewer than `max` exist, or
   * the next one released, in the order callers arrived. Rejects with the
   * signal's reason when it aborts, and with a ConnectionError of kind
   * `pool-closed`, `pool-full` or `pool-timeout`, or the failure to open the
   * connection opened for this caller.
   */
  private acquire(kind: LeaseKind, signal?: AbortSignal): Promise<Lease> {
    if (this.closed) {
      return Promise.reject(poolError("pool-closed", "Pool is closed."));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    return new Promise<Lease>((resolve, reject) => {
      const start = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (): boolean => {
        if (waiter.settled) {
          return false;
        }
        waiter.settled = true;
        this.unsettled.delete(waiter);
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) {
          this.waiting.splice(index, 1);
        }
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        return true;
      };
      const waiter: Waiter = {
        kind,
        settled: false,
        deliver: (pooled) => {
          if (!settle()) {
            return false;
          }
          resolve(this.lease(pooled, kind));
          return true;
        },
        fail: (error) => {
          if (settle()) {
            reject(error);
          }
        },
      };
      const onAbort = (): void => {
        waiter.fail(signal?.reason);
      };

      if (this.waiting.length === 0 && this.canServe()) {
        this.unsettled.add(waiter);
        this.serve(waiter);
        if (waiter.settled) {
          return;
        }
      } else if (this.waiting.length >= this.settings.maxWaitingClients) {
        reject(
          poolError(
            "pool-full",
            `Pool already has ${this.settings.maxWaitingClients} callers waiting for a connection.`,
          ),
        );
        return;
      } else {
        this.unsettled.add(waiter);
        this.waiting.push(waiter);
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (waiter.settled) {
          return;
        }
        this.emit("error", "cubrid-client: pool acquire timed out", {
          operation: "pool.acquire-timeout",
          ...this.endpoint(),
          durationMs: Date.now() - start,
        });
        waiter.fail(
          poolError(
            "pool-timeout",
            `No pool connection became available within ${this.settings.acquireTimeoutMs} ms.`,
          ),
        );
      }, this.settings.acquireTimeoutMs);
    });
  }

  /** Serves `waiter` now; only call it when canServe(). */
  private serve(waiter: Waiter): void {
    const pooled = this.idle.pop();
    if (pooled) {
      this.takeIdle(pooled, waiter);
      return;
    }

    this.pending += 1;
    this.create().then(
      (created) => {
        this.pending -= 1;
        this.active.add(created);
        this.deliver(created, waiter);
      },
      (error: unknown) => {
        this.pending -= 1;
        // Only the caller this connection was opened for learns of the failure.
        waiter.fail(error);
        this.dispatch();
      },
    );
  }

  private takeIdle(pooled: Pooled, waiter: Waiter): void {
    clearTimeout(pooled.timer);
    pooled.timer = undefined;
    this.active.add(pooled);

    if (Date.now() >= pooled.expiresAt) {
      this.discard(pooled, "lifetime");
      this.retry(waiter);
      return;
    }

    const { validateAfterIdleMs } = this.settings;
    const ping = pooled.connection.ping?.bind(pooled.connection);
    if (
      validateAfterIdleMs === undefined ||
      Date.now() - pooled.idleSince < validateAfterIdleMs ||
      !ping
    ) {
      this.deliver(pooled, waiter);
      return;
    }

    // A custom ping() may throw instead of rejecting.
    const validation = Promise.resolve()
      .then(ping)
      .then(
        () => {
          this.deliver(pooled, waiter);
        },
        () => {
          this.discard(pooled, "validation");
          this.retry(waiter);
        },
      );
    this.track(validation);
  }

  /** Gives `pooled`, already counted as active, to `waiter`, or back if it gave up. */
  private deliver(pooled: Pooled, waiter: Waiter): void {
    if (pooled.destroyed || this.closed) {
      this.active.delete(pooled);
      this.destroy(pooled, "closed");
      waiter.fail(poolError("pool-closed", "Pool is closed."));
      return;
    }
    if (!waiter.deliver(pooled)) {
      this.active.delete(pooled);
      this.putBack(pooled);
    }
  }

  /** `waiter` was being served when its connection had to be closed. */
  private retry(waiter: Waiter): void {
    if (waiter.settled) {
      this.dispatch();
    } else if (this.canServe()) {
      this.serve(waiter);
    } else {
      // It was the first in line, so it stays first.
      this.waiting.unshift(waiter);
    }
  }

  /** Serves waiting callers while there is a connection or room for one. */
  private dispatch(): void {
    while (this.waiting.length > 0 && this.canServe()) {
      const waiter = this.waiting.shift();
      if (waiter) {
        this.serve(waiter);
      }
    }
  }

  /** An unused connection: to the first waiting caller, else idle. */
  private putBack(pooled: Pooled): void {
    if (this.closed || pooled.destroyed) {
      this.destroy(pooled, "closed");
      return;
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      this.active.add(pooled);
      this.deliver(pooled, waiter);
      return;
    }

    pooled.idleSince = Date.now();
    this.idle.push(pooled);
    this.armIdleTimer(pooled);
  }

  private lease(pooled: Pooled, kind: LeaseKind): Lease {
    let markDone = (): void => {};
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    const lease: Lease = {
      pooled,
      kind,
      connection: pooled.connection,
      failedExchangesAtStart: pooled.readState?.().failedExchanges ?? 0,
      inFlight: 0,
      failed: false,
      changedOptions: false,
      ended: false,
      done,
      markDone,
    };
    lease.connection = leasedConnection(lease);
    this.leases.set(lease.connection, lease);
    return lease;
  }

  /**
   * Ends a lease: the connection goes back to the pool, or is closed when its
   * session is not clean (ADR 0008). Never throws.
   */
  private release(lease: Lease, verdict: ConnectionVerdict = "reuse"): void {
    if (lease.ended) {
      return;
    }
    lease.ended = true;
    this.leases.delete(lease.connection);
    lease.markDone();

    const { pooled } = lease;
    this.active.delete(pooled);
    if (pooled.destroyed) {
      this.dispatch();
      return;
    }

    const reason = this.closed ? "closed" : this.evictionReason(lease, verdict);
    if (reason) {
      this.destroy(pooled, reason);
      this.dispatch();
      this.fillMin();
      return;
    }
    this.putBack(pooled);
  }

  /** Why the connection of an ended lease must not be reused, if it must not. */
  private evictionReason(lease: Lease, verdict: ConnectionVerdict): DestroyReason | undefined {
    if (verdict !== "reuse") {
      return verdict;
    }
    if (lease.inFlight > 0) {
      return "busy";
    }

    const state = lease.pooled.readState?.();
    if (state) {
      if (state.inTransaction) {
        return "in-transaction";
      }
      if (state.busy) {
        return "busy";
      }
      if (state.failedExchanges !== lease.failedExchangesAtStart) {
        return "failed-exchange";
      }
      if (!state.connected) {
        return "error";
      }
    } else if (lease.failed) {
      // A custom connection cannot say whether a failure left its session clean.
      return "error";
    }

    if (lease.changedOptions) {
      return "options";
    }
    if (Date.now() >= lease.pooled.expiresAt) {
      return "lifetime";
    }
    return undefined;
  }

  /** Closes a connection counted as active that no lease holds. */
  private discard(pooled: Pooled, reason: DestroyReason): void {
    this.active.delete(pooled);
    this.destroy(pooled, reason);
    this.fillMin();
  }

  private destroy(pooled: Pooled, reason: DestroyReason): void {
    if (pooled.destroyed) {
      return;
    }
    pooled.destroyed = true;
    clearTimeout(pooled.timer);
    pooled.timer = undefined;

    this.emit("info", "cubrid-client: pool connection closed", {
      operation: "pool.destroy",
      ...this.endpoint(),
      reason,
    });
    // A custom close() may throw instead of rejecting; release() must not.
    const closing = Promise.resolve()
      .then(() => pooled.connection.close())
      .catch(() => {
        // The connection is gone either way; the close is logged by withLogging.
      })
      .finally(() => {
        this.closings.delete(closing);
      });
    this.closings.add(closing);
  }

  /** Opens connections in the background until `min` exist. Failures are only logged. */
  private fillMin(): void {
    while (!this.closed && this.total() < this.settings.min) {
      this.pending += 1;
      this.create().then(
        (created) => {
          this.pending -= 1;
          this.putBack(created);
        },
        () => {
          this.pending -= 1;
          // Logged by withLogging when a logger is set. Not retried until a
          // connection closes, so a database that is down is not hammered.
          this.dispatch();
        },
      );
    }
  }

  /** Opens and sets up one connection: connected, with the pool's transaction settings. */
  private create(): Promise<Pooled> {
    const creation = (async (): Promise<Pooled> => {
      let connection: ConnectionLike | undefined;
      try {
        connection = await this.connectionFactory(this.config);
        await connection.connect();
        await applyTransactionOptions(connection, pickTransactionOptions(this.config));
      } catch (error) {
        await connection?.close().catch(() => {
          // The failure to open is the one to report.
        });
        throw mapError("connection", error, "Failed to open a pool connection.");
      }

      this.emit("info", "cubrid-client: pool connection created", {
        operation: "pool.create",
        ...this.endpoint(),
      });
      const now = Date.now();
      const { maxLifetimeMs } = this.settings;
      return {
        connection,
        readState: sessionStateReader(connection),
        expiresAt:
          maxLifetimeMs === undefined
            ? Number.POSITIVE_INFINITY
            : now + maxLifetimeMs * (1 - LIFETIME_JITTER * Math.random()),
        idleSince: now,
        timer: undefined,
        destroyed: false,
      };
    })();

    this.track(creation);
    return creation;
  }

  /** close() waits for connections being opened or validated. */
  private track(opening: Promise<unknown>): void {
    this.opening.add(opening);
    const forget = (): void => {
      this.opening.delete(opening);
    };
    opening.then(forget, forget);
  }

  /** Arms the timer that closes an idle connection when it expires or idles too long. */
  private armIdleTimer(pooled: Pooled): void {
    const { idleTimeoutMs } = this.settings;
    const deadlines: number[] = [];
    if (pooled.expiresAt !== Number.POSITIVE_INFINITY) {
      deadlines.push(pooled.expiresAt);
    }
    // At `min`, idling is no reason to close it; only its lifetime is. Connections
    // still opening are not counted: their open may fail.
    if (idleTimeoutMs > 0 && this.open() > this.settings.min) {
      deadlines.push(pooled.idleSince + idleTimeoutMs);
    }
    if (deadlines.length === 0) {
      return;
    }

    const delay = Math.min(Math.max(Math.min(...deadlines) - Date.now(), 0), MAX_TIMER);
    pooled.timer = setTimeout(() => {
      this.onIdleTimer(pooled);
    }, delay);
    pooled.timer.unref?.();
  }

  private onIdleTimer(pooled: Pooled): void {
    pooled.timer = undefined;
    const index = this.idle.indexOf(pooled);
    if (index < 0) {
      return;
    }

    const now = Date.now();
    const { idleTimeoutMs, min } = this.settings;
    if (now >= pooled.expiresAt) {
      this.idle.splice(index, 1);
      this.destroy(pooled, "lifetime");
      this.fillMin();
    } else if (idleTimeoutMs > 0 && now - pooled.idleSince >= idleTimeoutMs && this.open() > min) {
      this.idle.splice(index, 1);
      this.destroy(pooled, "idle");
    } else {
      this.armIdleTimer(pooled);
    }
  }

  private endpoint(): ClientLogFields {
    return { host: this.config.host, port: this.config.port, database: this.config.database };
  }
}
