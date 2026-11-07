import type { QueryParams } from "./query.js";
import type { QueryResult, QueryResultRow } from "./result.js";

/**
 * TLS/SSL options for connecting to an SSL-enabled CUBRID broker (`SSL=ON`).
 *
 * Pass `ssl: true` to enable TLS with secure defaults, or an options object for
 * finer control. CUBRID ships a self-signed server certificate by default, so
 * verification fails unless you supply `ca` (or set `rejectUnauthorized: false`
 * for development/testing only).
 */
export interface ClientSSLOptions {
  /** Verify the server certificate chain. Default: true (secure by default). */
  rejectUnauthorized?: boolean;
  /** PEM CA certificate(s) used to verify the server certificate. */
  ca?: string | Buffer;
  /** Server name for SNI and certificate hostname verification. */
  servername?: string;
}

export type ClientLogLevel = "debug" | "info" | "error";

/**
 * Redacted fields passed to a logger. They never contain SQL text, bound
 * parameter values, row data, credentials or error messages.
 */
export interface ClientLogFields {
  /** `connection`, `connect`, `query`, `queryResult`, `execute`, `queryPrepared`, `queryResultPrepared`, `executePrepared`, `beginTransaction`, `commit`, `rollback`, `close` or `ping`. */
  operation?: string;
  host?: string;
  port?: number;
  database?: string;
  /** Elapsed milliseconds of the operation. */
  durationMs?: number;
  /** Number of bound parameters of a `query`, not their values. */
  paramCount?: number;
  /** Number of rows a successful `query` returned. */
  rowCount?: number;
  /**
   * Class of the error of a failed operation: one of this library's error
   * classes or a standard `Error` subclass, otherwise `Error`. A custom
   * `name` is never reported.
   */
  errorName?: string;
}

/**
 * Console-compatible logger accepted by {@link ClientOptions.logger}. Every
 * method is optional and receives `(message, fields)`.
 */
export interface ClientLogger {
  debug?(message: string, fields: ClientLogFields): void;
  info?(message: string, fields: ClientLogFields): void;
  error?(message: string, fields: ClientLogFields): void;
}

/**
 * The isolation levels CUBRID 10.2 to 11.4 accept. Every other server level is
 * refused, so no level reads uncommitted rows. `serializable` behaved like
 * `repeatable read` on all four and still allows write skew.
 */
export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

/** Settings for a whole transaction, applied before it starts. */
export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  /**
   * Longest one statement waits for a lock, in milliseconds. `0` does not wait
   * and `-1` has no limit. Must be an integer from `-1` to `2147483647`.
   */
  lockTimeout?: number;
}

export interface ClientConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeout?: number | undefined;
  /** See {@link ClientOptions.readTimeout}. */
  readTimeout?: number | undefined;
  /** See {@link ClientOptions.maxLobBytes}. */
  maxLobBytes?: number | undefined;
  /** See {@link ClientOptions.isolationLevel}. */
  isolationLevel?: IsolationLevel | undefined;
  /** See {@link ClientOptions.lockTimeout}. */
  lockTimeout?: number | undefined;
  maxConnectionRetryCount?: number | undefined;
  ssl?: boolean | ClientSSLOptions | undefined;
  logger?: unknown;
}

export interface ClientOptions {
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  connectionTimeout?: number;
  /**
   * Discard the connection and reject with `ReadTimeoutError` when the server
   * sends nothing for this many milliseconds while a response is awaited. This
   * limits inactivity, not total query time, so it must exceed the longest time
   * the server may spend executing a statement before its first response byte.
   * Undefined or 0 means no timeout.
   */
  readTimeout?: number;
  /**
   * Largest total of BLOB and CLOB content, in bytes, that one query may load.
   * `query()` returns BLOB columns as `Buffer` and CLOB columns as `string`, all
   * in memory, so this bounds what a row of large objects can cost. A query over
   * the limit rejects with a `QueryError` before any content is read, and the
   * connection stays usable. Must be a positive integer. Default: 64 MiB.
   */
  maxLobBytes?: number;
  /**
   * Isolation level of every session this client opens, on the shared connection
   * and on each `transaction()` connection. A session that replaces one gets it
   * before its first statement, or that statement fails. Unset leaves the
   * server's default. A `transaction()` option overrides it for that transaction.
   */
  isolationLevel?: IsolationLevel;
  /**
   * Longest a statement waits for a lock, in milliseconds, on every session this
   * client opens and with the same guarantee as `isolationLevel`. `0` does not
   * wait and `-1` has no limit. Unset leaves the server's default.
   */
  lockTimeout?: number;
  maxConnectionRetryCount?: number;
  ssl?: boolean | ClientSSLOptions;
  /**
   * Receives redacted diagnostics: `info` when a connection is created,
   * `debug` for each successful operation and `error` for each failed one (see
   * {@link ClientLogFields}). Use a {@link ClientLogger}, `console` or any
   * object with those methods; other values are ignored. A logger that throws
   * never affects a request. Declared `unknown` so 1.x code keeps compiling.
   */
  logger?: unknown;
  connectionFactory?: ConnectionFactory;
}

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]>;
}

/** Runs a statement and reports its rows with their column metadata. */
export interface ResultQueryable {
  queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>>;
}

/**
 * Outcome of a statement run with `execute()`.
 *
 * `affectedRows` is the number of rows an INSERT, UPDATE, DELETE or MERGE
 * changed, added over every statement of a multi-statement string. It is 0 for
 * DDL and SELECT, and 0 when an UPDATE or DELETE matched nothing.
 *
 * `lastInsertId` is set only when an INSERT ran and the session then holds a
 * new generated AUTO_INCREMENT value: a `number` while it is a safe integer and
 * a `bigint` beyond that, so no precision is lost. It is absent otherwise,
 * including when the value equals the one seen before the statement.
 */
export interface ExecuteResult {
  affectedRows: number;
  lastInsertId?: number | bigint;
}

/** Runs a statement and reports its {@link ExecuteResult} instead of rows. */
export interface Executable {
  execute(sql: string, params?: QueryParams): Promise<ExecuteResult>;
}

/**
 * Runs statements with server-side prepared binding: the values travel as typed
 * binds, never as SQL text. Each call prepares, executes and releases its own
 * handle, so nothing is reused between calls. The results match `query()`,
 * `queryResult()` and `execute()`; the differences in how values convert are in
 * docs/TYPES.md. The methods without `Prepared` keep rendering SQL literals.
 */
export interface PreparedQueryable {
  queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]>;
  queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>>;
  executePrepared(sql: string, params?: QueryParams): Promise<ExecuteResult>;
}

export interface TransactionClient extends Queryable {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * The transaction client `CubridClient.transaction()` hands to its callback: a
 * {@link TransactionClient} that can also `execute()`. A separate type keeps
 * `TransactionClient` as it was, so 1.x classes and test doubles implementing
 * it still compile.
 */
export interface ExecutableTransactionClient extends TransactionClient, Executable {}

export type TransactionCallback<
  T,
  Tx extends TransactionClient = TransactionClient,
> = (tx: Tx) => Promise<T>;

/**
 * The transaction client `CubridClient.transaction()` passes in: a
 * {@link TransactionClient} that can also return column metadata. Kept apart
 * from `TransactionClient` so 1.x code that implements that interface, such as
 * a test double, keeps compiling. A callback written against
 * `TransactionClient` is still accepted.
 */
export interface ResultTransactionClient extends TransactionClient, ResultQueryable {}

/**
 * The transaction client `CubridClient.transaction()` passes in: a
 * {@link TransactionClient} that can also bind on the server. Kept apart from
 * `TransactionClient` so 1.x code that implements that interface keeps compiling.
 */
export interface PreparedTransactionClient extends TransactionClient, PreparedQueryable {}

export interface ConnectionLike {
  connect(): Promise<void>;
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]>;
  /**
   * Optional so 1.x connection factories keep compiling. `queryResult()` on a
   * client or transaction fails when its connection does not provide it.
   */
  queryResult?<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>>;
  /**
   * Optional so 1.x connection factories keep compiling. `execute()` on a
   * client or transaction fails when its connection does not provide it.
   */
  execute?(sql: string, params?: QueryParams): Promise<ExecuteResult>;
  /**
   * Optional so 1.x connection factories keep compiling. The prepared methods
   * on a client or transaction fail when their connection does not provide
   * them, rather than falling back to SQL literals.
   */
  queryPrepared?<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]>;
  queryResultPrepared?<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>>;
  executePrepared?(sql: string, params?: QueryParams): Promise<ExecuteResult>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  /**
   * Keeps these settings on every session of this connection, leaving any option
   * not given as it is. Optional so 1.x connection factories keep compiling, and
   * called only when a setting is in effect. Without it such a client or
   * transaction fails, because running without the setting would hide that.
   */
  setTransactionOptions?(options: TransactionOptions): Promise<void>;
  ping?(): Promise<string>;
}

export type ConnectionFactory = (
  config: ClientConfig,
) => ConnectionLike | Promise<ConnectionLike>;
