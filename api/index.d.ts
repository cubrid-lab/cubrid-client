type QueryParam = string | number | boolean | bigint | Date | Buffer | null;
type QueryParams = readonly QueryParam[];

type QueryResultRow = Record<string, unknown>;

/**
 * TLS/SSL options for connecting to an SSL-enabled CUBRID broker (`SSL=ON`).
 *
 * Pass `ssl: true` to enable TLS with secure defaults, or an options object for
 * finer control. CUBRID ships a self-signed server certificate by default, so
 * verification fails unless you supply `ca` (or set `rejectUnauthorized: false`
 * for development/testing only).
 */
interface ClientSSLOptions {
    /** Verify the server certificate chain. Default: true (secure by default). */
    rejectUnauthorized?: boolean;
    /** PEM CA certificate(s) used to verify the server certificate. */
    ca?: string | Buffer;
    /** Server name for SNI and certificate hostname verification. */
    servername?: string;
}
interface ClientConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    connectionTimeout?: number | undefined;
    readTimeout?: number | undefined;
    maxConnectionRetryCount?: number | undefined;
    ssl?: boolean | ClientSSLOptions | undefined;
    logger?: unknown;
}
interface ClientOptions {
    host: string;
    port?: number;
    database: string;
    user: string;
    password?: string;
    connectionTimeout?: number;
    readTimeout?: number;
    maxConnectionRetryCount?: number;
    ssl?: boolean | ClientSSLOptions;
    logger?: unknown;
    connectionFactory?: ConnectionFactory;
}
interface Queryable {
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
}
interface TransactionClient extends Queryable {
    commit(): Promise<void>;
    rollback(): Promise<void>;
}
type TransactionCallback<T> = (tx: TransactionClient) => Promise<T>;
interface ConnectionLike {
    connect(): Promise<void>;
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
    ping?(): Promise<string>;
}
type ConnectionFactory = (config: ClientConfig) => ConnectionLike | Promise<ConnectionLike>;

declare class CubridClient implements Queryable {
    private readonly config;
    private readonly connectionFactory;
    private sharedConnectionPromise;
    constructor(config: ClientConfig, connectionFactory: ConnectionFactory);
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    transaction<T>(callback: TransactionCallback<T>): Promise<T>;
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
    ping(): Promise<string>;
    private getSharedConnection;
}

declare function createClient(options: ClientOptions): CubridClient;

declare class CubridTransaction implements TransactionClient {
    private readonly connection;
    constructor(connection: ConnectionLike);
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
}

declare class ConnectionError extends Error {
    name: string;
    constructor(message: string, options?: ErrorOptions);
}

declare class QueryError extends Error {
    name: string;
    constructor(message: string, options?: ErrorOptions);
}

declare class ReadTimeoutError extends ConnectionError {
    readonly timeoutMs: number;
    name: string;
    constructor(timeoutMs: number, options?: ErrorOptions);
}

declare class TransactionError extends Error {
    name: string;
    constructor(message: string, options?: ErrorOptions);
}

interface DriverAdapter extends ConnectionLike {
}

/**
 * Native CUBRID adapter — speaks the CAS protocol directly over TCP.
 *
 * Replaces NodeCubridAdapter by eliminating the node-cubrid dependency.
 * Implements the ConnectionLike interface used by CubridClient.
 */

declare class NativeCubridAdapter implements DriverAdapter {
    private readonly config;
    private cas;
    private autoCommit;
    /**
     * Server backslash-escaping mode, negotiated once per physical connection via
     * `SELECT CHAR_LENGTH('\\')`. `null` until negotiated. `true` means the CUBRID
     * default `no_backslash_escapes=yes` (backslash is a literal char); `false`
     * means backslash-escape processing is active. See `negotiateBackslashEscapes`.
     */
    private noBackslashEscapes;
    constructor(config: ClientConfig);
    connect(): Promise<void>;
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
    ping(): Promise<string>;
    private executeQuery;
    private getOrCreateCAS;
    /**
     * Translate the public `ssl` option (boolean | ClientSSLOptions) into the flat
     * TLS fields understood by CASConnectionConfig. Returns an empty object when
     * SSL is disabled so the non-SSL path is untouched.
     */
    private resolveSslConfig;
    /**
     * Return the negotiated backslash-escaping mode for the current connection,
     * running the one-time probe on first use.
     */
    private ensureBackslashMode;
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
    private negotiateBackslashEscapes;
    private fetchRemaining;
    private closeQueryHandle;
}

interface ConnectionConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
}
declare function parseConnectionString(url: string): ConnectionConfig;

declare function escapeIdentifier(name: string): string;
declare function buildWhere(conditions: Record<string, unknown>): {
    clause: string;
    params: unknown[];
};

export { type ClientConfig, type ClientOptions, type ConnectionConfig, ConnectionError, type ConnectionFactory, type ConnectionLike, CubridClient, CubridTransaction, NativeCubridAdapter, QueryError, type QueryParam, type QueryParams, type QueryResultRow, type Queryable, ReadTimeoutError, type TransactionCallback, type TransactionClient, TransactionError, buildWhere, createClient, escapeIdentifier, parseConnectionString };
