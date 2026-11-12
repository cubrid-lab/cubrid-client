// Design mock of the proposed "cubrid-client/driver" subpath in 2.0 (#249).
//
// NOT published and NOT built; see ./index.d.ts. The driver service provider
// interface (SPI) is what a custom `connectionFactory` implements and what the
// client, the pool and transactions call. It leaves the root entry point so the
// application API does not carry it, and it is reviewed as its own contract.
//
// Every type here is imported from the root mock rather than declared again: the
// real build must likewise emit one declaration per type, shared by both entry
// points, so `QueryError` or `QueryResult` from either path are the same type.
//
// Compared with 1.x ConnectionLike, the six statement methods (query, queryResult,
// execute and their Prepared forms) become two that take a DriverStatement with an
// explicit `binding`, and ten optional capabilities become five.

import type {
  Binding,
  ClientLogger,
  ClientSSLOptions,
  ColumnInfo,
  ExecuteManyOptions,
  ExecuteManyResult,
  ExecuteResult,
  IsolationLevel,
  QueryParams,
  QueryResultRow,
  StatementParams,
  TransactionClient,
  TransactionOptions,
} from "./index.js";

export type { Binding } from "./index.js";

/** The normalized options the client hands a connection factory. */
export interface ClientConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeout?: number | undefined;
  readTimeout?: number | undefined;
  maxLobBytes?: number | undefined;
  maxReplyBytes?: number | undefined;
  fetchSize?: number | undefined;
  timezone?: "local" | "utc" | undefined;
  charset?: "utf-8" | "iso-8859-1" | undefined;
  isolationLevel?: IsolationLevel | undefined;
  lockTimeout?: number | undefined;
  maxConnectionRetryCount?: number | undefined;
  ssl?: boolean | ClientSSLOptions | undefined;
  logger?: ClientLogger | undefined;
}

/**
 * One statement as the client resolved it. `binding` is never left to the
 * connection: the client applies the per-call option, then ClientOptions.binding,
 * then the library default, and checks it against `capabilities.bindings` before
 * calling, so a connection never has to fall back silently.
 */
export interface DriverStatement {
  readonly sql: string;
  readonly params: StatementParams;
  readonly binding: Binding;
}

export interface DriverStatementOptions {
  signal?: AbortSignal;
  readTimeout?: number;
}
export interface DriverQueryOptions extends DriverStatementOptions {
  /** #255 (in progress) decides whether the SPI or the client builds array rows. */
  rowMode?: "object" | "array";
}
export interface DriverExecuteOptions extends DriverStatementOptions {
  generatedKeys?: boolean;
}
/** Defaults are resolved by the client, so every limit arrives set. */
export interface DriverStreamOptions extends DriverStatementOptions {
  fetchSize: number;
  consumerTimeout: number;
}

export type DriverQueryResult =
  | { rowMode?: "object"; rows: QueryResultRow[]; columns: ColumnInfo[] }
  | { rowMode: "array"; rows: unknown[][]; columns: ColumnInfo[] };

/** What a connection declares it supports. Absent means `{ bindings: ["literal"] }`. */
export interface DriverCapabilities {
  readonly bindings: readonly Binding[];
}

export interface ConnectionLike {
  readonly capabilities?: DriverCapabilities;
  connect(): Promise<void>;
  /** Rows and columns; the client's query() returns only the rows. */
  query(statement: DriverStatement, options: DriverQueryOptions): Promise<DriverQueryResult>;
  execute(statement: DriverStatement, options: DriverExecuteOptions): Promise<ExecuteResult>;
  /** Always typed binds. Without it, executeMany() fails instead of looping. */
  executeMany?(
    sql: string,
    paramSets: readonly QueryParams[],
    options: ExecuteManyOptions,
  ): Promise<ExecuteManyResult>;
  /** Without it, stream() fails on its first read. */
  stream?(statement: DriverStatement, options: DriverStreamOptions): AsyncIterable<QueryResultRow>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  /** Called only when a setting is in effect; without it such a client fails. */
  setTransactionOptions?(options: TransactionOptions): Promise<void>;
  ping?(): Promise<string>;
  /** Without it, CubridClient.destroy() falls back to close() without waiting. */
  destroy?(): void;
}

export type ConnectionFactory = (config: ClientConfig) => ConnectionLike | Promise<ConnectionLike>;

/** The built-in CAS connection, for wrapping in a custom factory. */
export declare class NativeCubridAdapter implements ConnectionLike {
  readonly capabilities: { readonly bindings: readonly ["literal", "prepared"] };
  constructor(config: ClientConfig);
  connect(): Promise<void>;
  query(statement: DriverStatement, options: DriverQueryOptions): Promise<DriverQueryResult>;
  execute(statement: DriverStatement, options: DriverExecuteOptions): Promise<ExecuteResult>;
  executeMany(
    sql: string,
    paramSets: readonly QueryParams[],
    options: ExecuteManyOptions,
  ): Promise<ExecuteManyResult>;
  stream(
    statement: DriverStatement,
    options: DriverStreamOptions,
  ): AsyncGenerator<QueryResultRow, void, undefined>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  setTransactionOptions(options: TransactionOptions): Promise<void>;
  ping(): Promise<string>;
  destroy(): void;
}

/**
 * Wraps a connection the caller already holds in a transaction client. Moved here
 * from the root entry point: it is a driver-level building block, and unlike the
 * `tx` of transaction() it does not guard against use after commit.
 */
export interface CubridTransaction extends TransactionClient {}
export declare class CubridTransaction {
  constructor(connection: ConnectionLike);
}
