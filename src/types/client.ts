import type { QueryParams } from "./query.js";
import type { QueryResultRow } from "./result.js";

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

export interface ClientConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeout?: number | undefined;
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
  maxConnectionRetryCount?: number;
  ssl?: boolean | ClientSSLOptions;
  logger?: unknown;
  connectionFactory?: ConnectionFactory;
}

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]>;
}

export interface TransactionClient extends Queryable {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export type TransactionCallback<T> = (tx: TransactionClient) => Promise<T>;

export interface ConnectionLike {
  connect(): Promise<void>;
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  ping?(): Promise<string>;
}

export type ConnectionFactory = (
  config: ClientConfig,
) => ConnectionLike | Promise<ConnectionLike>;
