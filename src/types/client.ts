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
  /** `connection`, `connect`, `query`, `queryResult`, `beginTransaction`, `commit`, `rollback`, `close` or `ping`. */
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

export interface ClientConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeout?: number | undefined;
  /** See {@link ClientOptions.readTimeout}. */
  readTimeout?: number | undefined;
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

export interface TransactionClient extends Queryable {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

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
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  ping?(): Promise<string>;
}

export type ConnectionFactory = (
  config: ClientConfig,
) => ConnectionLike | Promise<ConnectionLike>;
