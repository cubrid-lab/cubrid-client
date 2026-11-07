type QueryParam = string | number | boolean | bigint | Date | Buffer | null;
type QueryParams = readonly QueryParam[];

type QueryResultRow = Record<string, unknown>;
/** One decoded SET, MULTISET or SEQUENCE element. */
type CollectionElement = string | number | bigint | Date | Buffer | null | CollectionElement[];
/**
 * A decoded SET, MULTISET or SEQUENCE column value, in the order the server sent
 * it. SET values arrive without duplicates and MULTISET values keep them; both
 * use a server-defined order, and only SEQUENCE keeps the stored order.
 */
type CollectionValue = CollectionElement[];

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
type ClientLogLevel = "debug" | "info" | "error";
/**
 * Redacted fields passed to a logger. They never contain SQL text, bound
 * parameter values, row data, credentials or error messages.
 */
interface ClientLogFields {
    /** `connection`, `connect`, `query`, `beginTransaction`, `commit`, `rollback`, `close` or `ping`. */
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
interface ClientLogger {
    debug?(message: string, fields: ClientLogFields): void;
    info?(message: string, fields: ClientLogFields): void;
    error?(message: string, fields: ClientLogFields): void;
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

/**
 * What a failure was, without parsing its message. Each server-reported value
 * was observed from a live broker; a code that was not observed has no kind.
 *
 * - `unique-violation`, `not-null-violation`, `foreign-key-violation`: a
 *   constraint rejected the statement.
 * - `syntax`: the server could not parse the statement. CUBRID also reports an
 *   unknown table this way.
 * - `semantic`: the statement parsed but cannot run, such as an unknown column,
 *   a missing privilege or a constant division by zero.
 * - `deadlock`: the server picked this transaction as the deadlock victim.
 * - `lock-timeout`: a server-side lock wait expired. This is not `read-timeout`.
 * - `interrupted`: the server stopped the statement, for example `cubrid killtran`.
 * - `authentication`: the broker refused the user or password.
 * - `connection-lost`: the connection went away, or the server process died and
 *   took the transaction with it. The outcome of a request in flight is unknown.
 * - `read-timeout`: the client gave up waiting, see `ReadTimeoutError`.
 */
type CubridErrorKind = "unique-violation" | "not-null-violation" | "foreign-key-violation" | "syntax" | "semantic" | "deadlock" | "lock-timeout" | "interrupted" | "authentication" | "connection-lost" | "read-timeout";
interface CubridErrorDetails {
    /** Numeric error code of the CAS error reply. Absent for client-side failures. */
    code?: number;
    /**
     * Who assigned `code`: `server` for a database error code, `cas` for one from
     * the CAS process. The two number ranges overlap, so compare a code only
     * together with its origin: `-1012` is a different error in each.
     */
    origin?: "server" | "cas";
    /**
     * Five-character SQLSTATE. CAS error replies do not carry one and CUBRID
     * documents no mapping from its codes, so this driver never sets it. It is
     * kept for a custom connection that has a real value to report.
     */
    sqlState?: string;
    /** Classification of a known failure. Absent when the failure is not classified. */
    kind?: CubridErrorKind;
}
interface CubridErrorOptions extends ErrorOptions, CubridErrorDetails {
}

interface ConnectionError extends Readonly<CubridErrorDetails> {
}
declare class ConnectionError extends Error {
    name: string;
    constructor(message: string, options?: CubridErrorOptions);
}

interface QueryError extends Readonly<CubridErrorDetails> {
}
declare class QueryError extends Error {
    name: string;
    constructor(message: string, options?: CubridErrorOptions);
}
/** A unique, NOT NULL or foreign key constraint rejected the statement; see `kind`. */
declare class ConstraintError extends QueryError {
    name: string;
}
/** The server could not parse the statement, or it names an unknown table. */
declare class SqlSyntaxError extends QueryError {
    name: string;
}
/**
 * The server chose this transaction as a deadlock victim. With code `-72` it
 * already rolled the whole transaction back; with `-967` or `-968`, reported
 * under a finite lock timeout, only the statement failed and the transaction
 * stays open. Either way, roll back and retry the transaction from its start.
 */
declare class DeadlockError extends QueryError {
    name: string;
}
/**
 * A server-side lock wait expired. Only the statement failed, and the
 * transaction stays open. This is not the client-side `ReadTimeoutError`.
 */
declare class LockTimeoutError extends QueryError {
    name: string;
}

declare class ReadTimeoutError extends ConnectionError {
    readonly timeoutMs: number;
    name: string;
    constructor(timeoutMs: number, options?: ErrorOptions);
}

interface TransactionError extends Readonly<CubridErrorDetails> {
}
declare class TransactionError extends Error {
    name: string;
    constructor(message: string, options?: CubridErrorOptions);
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

export { type ClientConfig, type ClientLogFields, type ClientLogLevel, type ClientLogger, type ClientOptions, type CollectionElement, type CollectionValue, type ConnectionConfig, ConnectionError, type ConnectionFactory, type ConnectionLike, ConstraintError, CubridClient, type CubridErrorDetails, type CubridErrorKind, type CubridErrorOptions, CubridTransaction, DeadlockError, LockTimeoutError, NativeCubridAdapter, QueryError, type QueryParam, type QueryParams, type QueryResultRow, type Queryable, ReadTimeoutError, SqlSyntaxError, type TransactionCallback, type TransactionClient, TransactionError, buildWhere, createClient, escapeIdentifier, parseConnectionString };
