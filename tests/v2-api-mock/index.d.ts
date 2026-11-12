// Design mock of the proposed cubrid-client 2.0 root entry point ("cubrid-client").
//
// This file is NOT published and NOT built: package.json builds only src/index.ts,
// and `npm run api:check` keeps the 1.x declarations unchanged. It exists so that
// tests/v2-api-mock/consumer.ts can prove, under `npm run typecheck`, that the
// API proposed in docs/design/v2-api.md and ADR 0011 (#249) compiles for typical
// consumer code. Private class members, which the real declarations would carry,
// are left out because they are not part of the consumer contract.
//
// What changes from 1.x, in short:
// - One `binding: "literal" | "prepared"` option replaces queryPrepared(),
//   queryResultPrepared(), executePrepared() and the PreparedQueryable family,
//   and it also selects prepared streaming.
// - The driver SPI (ConnectionLike, ConnectionFactory, ClientConfig,
//   NativeCubridAdapter, CubridTransaction) moves to "cubrid-client/driver",
//   mocked in ./driver.d.ts. Only the `connectionFactory` option still refers
//   to it, as a type.
// - `rowMode` (#255) and `outcomeUnknown` (#254) are shown in the shape their
//   in-progress 1.x work proposes; that work, not this mock, decides them.

import type { Readable } from "node:stream";
import type { ClientConfig, ConnectionFactory } from "./driver.js";

// ---------------------------------------------------------------- parameters

/** How a statement's parameters reach the server. See ADR 0011. */
export type Binding = "literal" | "prepared";

/** A value accepted by both bindings. `undefined` is refused at run time in 2.0. */
export type QueryParam = string | number | boolean | bigint | Date | Buffer | null;
export type QueryParams = readonly QueryParam[];

export type BlobSource = Buffer | Uint8Array | AsyncIterable<Buffer | Uint8Array> | Readable;
export type ClobSource = string | Buffer | AsyncIterable<string | Buffer | Uint8Array> | Readable;

/** Made by blob() or clob(). Accepted only with `binding: "prepared"`. */
export interface LobParam {
  readonly kind: "blob" | "clob";
  readonly source: BlobSource | ClobSource;
}

/** A parameter of query(), queryResult(), execute() and stream(). */
export type StatementParam = QueryParam | LobParam;
export type StatementParams = readonly StatementParam[];
/** @deprecated 1.x name of {@link StatementParam}; removed in 3.0. */
export type PreparedQueryParam = StatementParam;

export declare function blob(source: BlobSource): LobParam;
export declare function clob(source: ClobSource): LobParam;

// ---------------------------------------------------------------- results

export type ZonedDateTimeType = "TIMESTAMPTZ" | "TIMESTAMPLTZ" | "DATETIMETZ" | "DATETIMELTZ";
export interface ZonedDateTimeFields {
  type: ZonedDateTimeType;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  zone: string;
}
export declare class ZonedDateTime {
  readonly type: ZonedDateTimeType;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  readonly zone: string;
  constructor(fields: ZonedDateTimeFields);
  toString(): string;
  toJSON(): string;
}

export type QueryResultRow = Record<string, unknown>;
export type CollectionElement =
  | string
  | number
  | bigint
  | Date
  | ZonedDateTime
  | Buffer
  | null
  | CollectionElement[];
export type CollectionValue = CollectionElement[];

export interface ColumnInfo {
  name: string;
  type: string;
  elementType?: string;
  precision: number;
  scale: number;
  nullable: boolean;
}
export interface QueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  columns: ColumnInfo[];
}
/** queryResult() with `rowMode: "array"` (#255, in progress). */
export interface ArrayQueryResult {
  rows: unknown[][];
  columns: ColumnInfo[];
}

export interface ExecuteResult {
  affectedRows: number;
  lastInsertId?: number | bigint;
}
export interface ExecuteManyResult {
  affectedRows: number;
  results: number[];
}

// ---------------------------------------------------------------- options

/** Options of one statement, the optional last argument of every statement method. */
export interface QueryOptions {
  signal?: AbortSignal;
  readTimeout?: number;
  /** Overrides {@link ClientOptions.binding} for this statement. */
  binding?: Binding;
}
/** query() and queryResult() returning objects keyed by column name, the default. */
export interface ObjectRowOptions extends QueryOptions {
  rowMode?: "object";
}
/** query() and queryResult() returning one array per row, in column order (#255). */
export interface ArrayRowOptions extends QueryOptions {
  rowMode: "array";
}
export interface ExecuteOptions extends QueryOptions {
  generatedKeys?: boolean;
}
/**
 * executeMany() always sends typed binds (EXECUTE_ARRAY), so it takes no
 * `binding`; passing one is a compile error rather than a silent no-op.
 */
export interface ExecuteManyOptions {
  signal?: AbortSignal;
  readTimeout?: number;
}
export interface StreamOptions {
  /** Overrides {@link ClientOptions.binding} for this stream. */
  binding?: Binding;
  fetchSize?: number;
  signal?: AbortSignal;
  consumerTimeout?: number;
  readTimeout?: number;
}

// ---------------------------------------------------------------- statement surface

/** The narrowest structural contract, kept for libraries and test doubles. */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: StatementParams,
    options?: ObjectRowOptions,
  ): Promise<T[]>;
}

/**
 * Every statement method. Replaces 1.x ResultQueryable, Executable,
 * PreparedQueryable, BatchExecutable and Streamable.
 */
export interface StatementClient extends Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: StatementParams,
    options?: ObjectRowOptions,
  ): Promise<T[]>;
  query(
    sql: string,
    params: StatementParams | undefined,
    options: ArrayRowOptions,
  ): Promise<unknown[][]>;
  queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: StatementParams,
    options?: ObjectRowOptions,
  ): Promise<QueryResult<T>>;
  queryResult(
    sql: string,
    params: StatementParams | undefined,
    options: ArrayRowOptions,
  ): Promise<ArrayQueryResult>;
  execute(sql: string, params?: StatementParams, options?: ExecuteOptions): Promise<ExecuteResult>;
  executeMany(
    sql: string,
    paramSets: readonly QueryParams[],
    options?: ExecuteManyOptions,
  ): Promise<ExecuteManyResult>;
  stream<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: StatementParams,
    options?: StreamOptions,
  ): AsyncIterable<T>;
}

/**
 * The `tx` of transaction() and the base of TransactionScope. Replaces 1.x
 * ExecutableTransactionClient, ResultTransactionClient, PreparedTransactionClient
 * and BatchTransactionClient. `stream()` on a transaction is not part of this
 * proposal (1.x has none), so it is omitted.
 */
export interface TransactionClient extends Omit<StatementClient, "stream"> {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
export type TransactionCallback<T> = (tx: TransactionClient) => Promise<T>;
/** Returned by beginTransactionScope(). Do not implement it yourself. */
export interface TransactionScope extends TransactionClient {}

// ---------------------------------------------------------------- configuration

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";
export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  lockTimeout?: number;
}
export type ClientLogLevel = "debug" | "info" | "error";
export interface ClientLogFields {
  operation?: string;
  host?: string;
  port?: number;
  database?: string;
  durationMs?: number;
  paramCount?: number;
  rowCount?: number;
  reason?: string;
  errorName?: string;
  /** The binding the statement used, so logs show what a default resolved to. */
  binding?: Binding;
}
export interface ClientLogger {
  debug?(message: string, fields: ClientLogFields): void;
  info?(message: string, fields: ClientLogFields): void;
  error?(message: string, fields: ClientLogFields): void;
}
/** Exported in 2.0; 1.x references it without exporting it. */
export interface ClientSSLOptions {
  rejectUnauthorized?: boolean;
  ca?: string | Buffer;
  servername?: string;
}

export interface ClientOptions {
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  connectionTimeout?: number;
  readTimeout?: number;
  maxLobBytes?: number;
  maxReplyBytes?: number;
  isolationLevel?: IsolationLevel;
  lockTimeout?: number;
  fetchSize?: number;
  /** Default "utc" in 2.0 (ADR 0010); "local" stays available. */
  timezone?: "local" | "utc";
  charset?: "utf-8" | "iso-8859-1";
  /**
   * Binding of every statement that does not set its own. The 2.0 default is
   * decided by the evidence gate in ADR 0011: "prepared" if it passes before
   * 2.0.0, otherwise "literal".
   */
  binding?: Binding;
  maxConnectionRetryCount?: number;
  ssl?: boolean | ClientSSLOptions;
  logger?: ClientLogger;
  /** A driver from "cubrid-client/driver". The root entry exports no SPI type. */
  connectionFactory?: ConnectionFactory;
}

// ---------------------------------------------------------------- schema

export interface SchemaOptions {
  schema?: string;
}
export interface SchemaTable {
  name: string;
  schema: string;
  type: "table" | "view";
}
export interface SchemaColumn {
  name: string;
  position: number;
  dataType: string;
  precision: number;
  scale: number;
  nullable: boolean;
  defaultValue: string | null;
}
export interface SchemaPrimaryKey {
  name: string;
  columns: string[];
}
export interface SchemaIndexColumn {
  name: string | null;
  expression?: string;
  order: "asc" | "desc";
  prefixLength?: number;
}
export interface SchemaIndex {
  name: string;
  unique: boolean;
  reverse: boolean;
  primaryKey: boolean;
  foreignKey: boolean;
  filter: string | null;
  columns: SchemaIndexColumn[];
}

// ---------------------------------------------------------------- client and pool

export declare class CubridClient implements StatementClient {
  /** Driver-level construction; applications use createClient(). Types from the driver entry. */
  constructor(config: ClientConfig, connectionFactory: ConnectionFactory);
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: StatementParams,
    options?: ObjectRowOptions,
  ): Promise<T[]>;
  query(
    sql: string,
    params: StatementParams | undefined,
    options: ArrayRowOptions,
  ): Promise<unknown[][]>;
  queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: StatementParams,
    options?: ObjectRowOptions,
  ): Promise<QueryResult<T>>;
  queryResult(
    sql: string,
    params: StatementParams | undefined,
    options: ArrayRowOptions,
  ): Promise<ArrayQueryResult>;
  execute(sql: string, params?: StatementParams, options?: ExecuteOptions): Promise<ExecuteResult>;
  executeMany(
    sql: string,
    paramSets: readonly QueryParams[],
    options?: ExecuteManyOptions,
  ): Promise<ExecuteManyResult>;
  stream<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: StatementParams,
    options?: StreamOptions,
  ): AsyncGenerator<T, void, undefined>;
  transaction<T>(callback: TransactionCallback<T>, options?: TransactionOptions): Promise<T>;
  beginTransactionScope(options?: TransactionOptions): Promise<TransactionScope>;
  close(): Promise<void>;
  destroy(): Promise<void>;
  ping(): Promise<string>;
  getServerVersion(): Promise<string>;
  getTables(options?: SchemaOptions): Promise<SchemaTable[]>;
  getColumns(table: string, options?: SchemaOptions): Promise<SchemaColumn[]>;
  getPrimaryKey(table: string, options?: SchemaOptions): Promise<SchemaPrimaryKey | null>;
  getIndexes(table: string, options?: SchemaOptions): Promise<SchemaIndex[]>;
  /**
   * @deprecated Since #112. Kept in this mock because removing it is a separate
   * 2.0 decision, not part of ADR 0011; drizzle-cubrid still calls it.
   */
  beginTransaction(): Promise<void>;
  /** @deprecated See {@link CubridClient.beginTransaction}. */
  commit(): Promise<void>;
  /** @deprecated See {@link CubridClient.beginTransaction}. */
  rollback(): Promise<void>;
}
export declare function createClient(options: ClientOptions): CubridClient;

export interface PoolOptions extends ClientOptions {
  max?: number;
  min?: number;
  acquireTimeoutMs?: number;
  maxWaitingClients?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  validateAfterIdleMs?: number;
}
export interface PoolStats {
  total: number;
  idle: number;
  active: number;
  pending: number;
  waiting: number;
}
/** The leased connection of CubridPool.connection(). */
export interface PoolConnection extends StatementClient {}
export interface PoolConnectionOptions {
  signal?: AbortSignal;
}
export declare class CubridPool implements StatementClient {
  constructor(options: PoolOptions);
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: StatementParams,
    options?: ObjectRowOptions,
  ): Promise<T[]>;
  query(
    sql: string,
    params: StatementParams | undefined,
    options: ArrayRowOptions,
  ): Promise<unknown[][]>;
  queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: StatementParams,
    options?: ObjectRowOptions,
  ): Promise<QueryResult<T>>;
  queryResult(
    sql: string,
    params: StatementParams | undefined,
    options: ArrayRowOptions,
  ): Promise<ArrayQueryResult>;
  execute(sql: string, params?: StatementParams, options?: ExecuteOptions): Promise<ExecuteResult>;
  executeMany(
    sql: string,
    paramSets: readonly QueryParams[],
    options?: ExecuteManyOptions,
  ): Promise<ExecuteManyResult>;
  stream<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: StatementParams,
    options?: StreamOptions,
  ): AsyncGenerator<T, void, undefined>;
  connection<T>(
    fn: (connection: PoolConnection) => Promise<T>,
    options?: PoolConnectionOptions,
  ): Promise<T>;
  transaction<T>(callback: TransactionCallback<T>, options?: TransactionOptions): Promise<T>;
  beginTransactionScope(options?: TransactionOptions): Promise<TransactionScope>;
  ping(): Promise<string>;
  getServerVersion(): Promise<string>;
  getTables(options?: SchemaOptions): Promise<SchemaTable[]>;
  getColumns(table: string, options?: SchemaOptions): Promise<SchemaColumn[]>;
  getPrimaryKey(table: string, options?: SchemaOptions): Promise<SchemaPrimaryKey | null>;
  getIndexes(table: string, options?: SchemaOptions): Promise<SchemaIndex[]>;
  stats(): PoolStats;
  close(): Promise<void>;
}
export declare function createPool(options: PoolOptions): CubridPool;

// ---------------------------------------------------------------- errors

export type CubridErrorKind =
  | "unique-violation"
  | "not-null-violation"
  | "foreign-key-violation"
  | "syntax"
  | "semantic"
  | "deadlock"
  | "lock-timeout"
  | "interrupted"
  | "authentication"
  | "connection-lost"
  | "read-timeout"
  | "stream-busy"
  | "pool-timeout"
  | "pool-full"
  | "pool-closed";
export interface ExecuteManySetFailure {
  index: number;
  code: number;
  origin?: "server" | "cas";
  kind?: CubridErrorKind;
  message: string;
}
export interface ExecuteManyFailure {
  results: ReadonlyArray<number | null>;
  failures: readonly ExecuteManySetFailure[];
  executed: number;
  rolledBack: boolean;
}
export interface CubridErrorDetails {
  code?: number;
  origin?: "server" | "cas";
  sqlState?: string;
  kind?: CubridErrorKind;
  batch?: ExecuteManyFailure;
  /** The statement may have run on the server (#254, in progress). */
  outcomeUnknown?: boolean;
}
export interface CubridErrorOptions extends ErrorOptions, CubridErrorDetails {}

export interface ConnectionError extends Readonly<CubridErrorDetails> {}
export declare class ConnectionError extends Error {
  constructor(message: string, options?: CubridErrorOptions);
}
export declare class ReadTimeoutError extends ConnectionError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, options?: ErrorOptions);
}
export interface QueryError extends Readonly<CubridErrorDetails> {}
export declare class QueryError extends Error {
  constructor(message: string, options?: CubridErrorOptions);
}
export declare class ConstraintError extends QueryError {}
export declare class SqlSyntaxError extends QueryError {}
export declare class DeadlockError extends QueryError {}
export declare class LockTimeoutError extends QueryError {}
export interface TransactionError extends Readonly<CubridErrorDetails> {}
export declare class TransactionError extends Error {
  rollbackError?: Error;
  closeError?: Error;
  constructor(message: string, options?: CubridErrorOptions);
}

// ---------------------------------------------------------------- utilities

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}
export declare function parseConnectionString(url: string): ConnectionConfig;
export declare function escapeIdentifier(name: string): string;
/** 2.0 narrows 1.x `unknown` so the result can be passed to query() without a cast. */
export declare function buildWhere(conditions: Record<string, QueryParam>): {
  clause: string;
  params: QueryParam[];
};
