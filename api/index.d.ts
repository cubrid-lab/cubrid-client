type QueryParam = string | number | boolean | bigint | Date | Buffer | null;
type QueryParams = readonly QueryParam[];

/** The CUBRID type a {@link ZonedDateTime} was read from. */
type ZonedDateTimeType = "TIMESTAMPTZ" | "TIMESTAMPLTZ" | "DATETIMETZ" | "DATETIMELTZ";
/** The fields of a {@link ZonedDateTime}. */
interface ZonedDateTimeFields {
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
/**
 * A TIMESTAMPTZ, TIMESTAMPLTZ, DATETIMETZ or DATETIMELTZ value: the wall-clock
 * fields the server sent and the zone they are in, exactly as sent.
 *
 * It is not a `Date`. A `Date` is an instant and cannot say which zone the
 * value was stored in, and for a region zone the instant depends on the zone
 * rules of the day. The server's own zone text is kept in `zone`: an offset
 * such as `+09:00`, or a region and abbreviation such as `Asia/Seoul KST`.
 * For a TIMESTAMPLTZ or DATETIMELTZ value the server sends the fields in the
 * zone of the session that read it.
 *
 * `month` runs from 1 to 12, unlike `Date#getMonth`. `millisecond` is always 0
 * for TIMESTAMPTZ and TIMESTAMPLTZ, which have no fractional seconds.
 */
declare class ZonedDateTime {
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
    /**
     * The value as SQL literal text, `YYYY-MM-DD HH:MM:SS[.mmm] <zone>`; the
     * fraction is written for DATETIMETZ and DATETIMELTZ only.
     */
    toString(): string;
    /** The same text as {@link ZonedDateTime.toString}, so `JSON.stringify` keeps the zone. */
    toJSON(): string;
}

type QueryResultRow = Record<string, unknown>;
/** One decoded SET, MULTISET or SEQUENCE element. */
type CollectionElement = string | number | bigint | Date | ZonedDateTime | Buffer | null | CollectionElement[];
/**
 * A decoded SET, MULTISET or SEQUENCE column value, in the order the server sent
 * it. SET values arrive without duplicates and MULTISET values keep them; both
 * use a server-defined order, and only SEQUENCE keeps the stored order.
 */
type CollectionValue = CollectionElement[];
/**
 * One column of a result set, in select-list order.
 *
 * `type` is the CUBRID type name, for example `INT`, `VARCHAR` or `DATETIME`,
 * or `UNKNOWN(<id>)` for a wire type id this driver does not name. A SET,
 * MULTISET or SEQUENCE column has that kind as `type` and its declared element
 * type as `elementType`; `elementType` is `NULL` for a collection without one
 * domain. `precision` and `scale` are the values the server reports for the
 * column, which depend on the type (for example the length of a `VARCHAR` or
 * the digits of a `NUMERIC`).
 */
interface ColumnInfo {
    /** The column label: its alias, or its name when it has none. */
    name: string;
    type: string;
    elementType?: string;
    precision: number;
    scale: number;
    /** `false` only when the server reports the column as NOT NULL. */
    nullable: boolean;
}
/**
 * Rows together with the columns that produced them.
 *
 * `columns` has one entry for every select-list column, so a column that holds
 * only NULL still has its type, and a name that appears twice (for example
 * `SELECT a.id, b.id`) appears twice. Each row object is keyed by column name,
 * exactly as `query()` returns it, so for a repeated name the value of the last
 * such column is the one in the row. A statement that returns no result set
 * has no rows and no columns.
 */
interface QueryResult<T extends QueryResultRow = QueryResultRow> {
    rows: T[];
    columns: ColumnInfo[];
}

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
    /** See {@link ClientOptions.readTimeout}. */
    readTimeout?: number | undefined;
    /** See {@link ClientOptions.maxLobBytes}. */
    maxLobBytes?: number | undefined;
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
interface Queryable {
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
}
/** Runs a statement and reports its rows with their column metadata. */
interface ResultQueryable {
    queryResult<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
}
/**
 * Outcome of a statement run with `execute()`.
 *
 * `affectedRows` is the number of rows an INSERT, UPDATE, DELETE or MERGE
 * changed, added over every statement of a multi-statement string. It is 0 for
 * DDL and SELECT, and 0 when an UPDATE or DELETE matched nothing.
 *
 * `lastInsertId` is set only when an INSERT ran and the session then holds a
 * generated AUTO_INCREMENT value: a `number` while it is a safe integer and a
 * `bigint` beyond that, so no precision is lost. It is absent otherwise.
 */
interface ExecuteResult {
    affectedRows: number;
    lastInsertId?: number | bigint;
}
/** Runs a statement and reports its {@link ExecuteResult} instead of rows. */
interface Executable {
    execute(sql: string, params?: QueryParams): Promise<ExecuteResult>;
}
/**
 * Runs statements with server-side prepared binding: the values travel as typed
 * binds, never as SQL text. Each call prepares, executes and releases its own
 * handle, so nothing is reused between calls. The results match `query()`,
 * `queryResult()` and `execute()`; the differences in how values convert are in
 * docs/TYPES.md. The methods without `Prepared` keep rendering SQL literals.
 */
interface PreparedQueryable {
    queryPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    queryResultPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    executePrepared(sql: string, params?: QueryParams): Promise<ExecuteResult>;
}
interface TransactionClient extends Queryable {
    commit(): Promise<void>;
    rollback(): Promise<void>;
}
/**
 * The transaction client `CubridClient.transaction()` hands to its callback: a
 * {@link TransactionClient} that can also `execute()`. A separate type keeps
 * `TransactionClient` as it was, so 1.x classes and test doubles implementing
 * it still compile.
 */
interface ExecutableTransactionClient extends TransactionClient, Executable {
}
type TransactionCallback<T, Tx extends TransactionClient = TransactionClient> = (tx: Tx) => Promise<T>;
/**
 * The transaction client `CubridClient.transaction()` passes in: a
 * {@link TransactionClient} that can also return column metadata. Kept apart
 * from `TransactionClient` so 1.x code that implements that interface, such as
 * a test double, keeps compiling. A callback written against
 * `TransactionClient` is still accepted.
 */
interface ResultTransactionClient extends TransactionClient, ResultQueryable {
}
/**
 * The transaction client `CubridClient.transaction()` passes in: a
 * {@link TransactionClient} that can also bind on the server. Kept apart from
 * `TransactionClient` so 1.x code that implements that interface keeps compiling.
 */
interface PreparedTransactionClient extends TransactionClient, PreparedQueryable {
}
interface ConnectionLike {
    connect(): Promise<void>;
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    /**
     * Optional so 1.x connection factories keep compiling. `queryResult()` on a
     * client or transaction fails when its connection does not provide it.
     */
    queryResult?<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
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
    queryPrepared?<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    queryResultPrepared?<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    executePrepared?(sql: string, params?: QueryParams): Promise<ExecuteResult>;
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
    ping?(): Promise<string>;
}
type ConnectionFactory = (config: ClientConfig) => ConnectionLike | Promise<ConnectionLike>;

/** Selects the owner (CUBRID calls it the schema) of the table to inspect. */
interface SchemaOptions {
    /**
     * Owner of the table, for example `DBA`, matched without regard to case. It
     * is needed only when several visible users own a table with the same name,
     * which CUBRID 11.2 and later allow. When omitted and the name is ambiguous,
     * the call rejects with a `QueryError` that lists the owners.
     */
    schema?: string;
}
/** A table or view returned by `getTables()`. */
interface SchemaTable {
    /** The table name as the catalog stores it: CUBRID folds identifiers to lower case. */
    name: string;
    /** The owner of the table, as the catalog stores it, for example `DBA`. */
    schema: string;
    type: "table" | "view";
}
/** A column returned by `getColumns()`. */
interface SchemaColumn {
    name: string;
    /** 1-based position in the table. */
    position: number;
    /** The catalog's type name, for example `INTEGER`, `STRING` (VARCHAR) or `NUMERIC`. */
    dataType: string;
    /** The catalog's precision: the length of a string or the digits of a `NUMERIC`. */
    precision: number;
    scale: number;
    nullable: boolean;
    /** The default as the catalog's text, for example `zz` or `SYS_DATETIME`; `null` when none. */
    defaultValue: string | null;
}
/** A primary key returned by `getPrimaryKey()`. */
interface SchemaPrimaryKey {
    name: string;
    /** Column names in key order. */
    columns: string[];
}
/** One key column of an index. */
interface SchemaIndexColumn {
    /** `null` for an expression of a function-based index; see `expression`. */
    name: string | null;
    /** The expression text of a function-based index key. */
    expression?: string;
    order: "asc" | "desc";
    /** The prefix length of a prefix index such as `c(5)`. */
    prefixLength?: number;
}
/** An index returned by `getIndexes()`. Primary and foreign keys are indexes too. */
interface SchemaIndex {
    name: string;
    unique: boolean;
    reverse: boolean;
    primaryKey: boolean;
    foreignKey: boolean;
    /** The condition of a filtered index; `null` when the index covers every row. */
    filter: string | null;
    columns: SchemaIndexColumn[];
}

declare class CubridClient implements Queryable, ResultQueryable, Executable, PreparedQueryable {
    private readonly config;
    private readonly connectionFactory;
    private sharedConnectionPromise;
    private closed;
    private readonly schemaOperations;
    constructor(config: ClientConfig, connectionFactory: ConnectionFactory);
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    queryResult<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    execute(sql: string, params?: QueryParams): Promise<ExecuteResult>;
    queryPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    queryResultPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    executePrepared(sql: string, params?: QueryParams): Promise<ExecuteResult>;
    transaction<T>(callback: TransactionCallback<T, ResultTransactionClient & ExecutableTransactionClient & PreparedTransactionClient>): Promise<T>;
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
    ping(): Promise<string>;
    /**
     * Return the CUBRID server version, for example `11.4.6.1963`. It is the same
     * single GET_DB_VERSION request as `ping()` and shares its transaction and
     * reconnect behavior; only the failure message differs.
     */
    getServerVersion(): Promise<string>;
    /**
     * List the user tables and views the connected user may SELECT from, ordered
     * by owner and name. See {@link SchemaOptions} to list one owner only.
     */
    getTables(options?: SchemaOptions): Promise<SchemaTable[]>;
    /** List the columns of a table or view in table order. */
    getColumns(table: string, options?: SchemaOptions): Promise<SchemaColumn[]>;
    /** Return the primary key of a table, or `null` when it has none. */
    getPrimaryKey(table: string, options?: SchemaOptions): Promise<SchemaPrimaryKey | null>;
    /** List the indexes of a table, including its primary and foreign keys. */
    getIndexes(table: string, options?: SchemaOptions): Promise<SchemaIndex[]>;
    private runSchemaOperation;
    private getSharedConnection;
}

declare function createClient(options: ClientOptions): CubridClient;

declare class CubridTransaction implements ResultTransactionClient, ExecutableTransactionClient, PreparedTransactionClient {
    private readonly connection;
    constructor(connection: ConnectionLike);
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    queryResult<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    execute(sql: string, params?: QueryParams): Promise<ExecuteResult>;
    queryPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    queryResultPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    executePrepared(sql: string, params?: QueryParams): Promise<ExecuteResult>;
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
 * already rolled the whole transaction back, so later statements and `commit()`
 * on this connection reject until `rollback()` or a rejected `commit()`
 * acknowledges that. With `-967` or `-968`, reported under a finite lock timeout,
 * only the statement failed and the transaction stays open. Either way, roll back
 * and retry the transaction from its start.
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

/**
 * The server sent nothing for `timeoutMs` milliseconds while a response was
 * awaited. The connection has been discarded, so a late response can never be
 * mistaken for the next operation's. The request's outcome on the server is
 * unknown: it may still have run, and a COMMIT may have succeeded.
 * Applications must verify the outcome; a timed-out COMMIT is never retried
 * automatically by the driver.
 */
declare class ReadTimeoutError extends ConnectionError {
    readonly timeoutMs: number;
    name: string;
    constructor(timeoutMs: number, options?: ErrorOptions);
}

interface TransactionError extends Readonly<CubridErrorDetails> {
}
declare class TransactionError extends Error {
    name: string;
    /**
     * Set by `CubridClient.transaction()` when rolling back also failed. `cause`
     * still holds the failure that started it. The connection is closed
     * afterwards, so the server discards the uncommitted work either way.
     */
    rollbackError?: Error;
    /** Set by `CubridClient.transaction()` when closing its connection also failed. */
    closeError?: Error;
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
     * Server backslash-escaping mode, negotiated once per physical session via
     * `SELECT CHAR_LENGTH('\\')`. `null` until negotiated. `true` means the CUBRID
     * default `no_backslash_escapes=yes` (backslash is a literal char); `false`
     * means backslash-escape processing is active. See `negotiateBackslashEscapes`.
     */
    private noBackslashEscapes;
    /** Session (`connectionGeneration`) that `noBackslashEscapes` was measured on. */
    private backslashModeGeneration;
    /**
     * Session that holds the open transaction's statements. Set by the first
     * statement rather than by beginTransaction(): a released CAS legitimately
     * reconnects on that first statement, before there is any work to lose.
     */
    private transactionGeneration;
    /**
     * The reply that said the server rolled back the open transaction on its own.
     * The session is still healthy, but its next statement would start a new
     * server transaction, and a commit would persist that statement alone. So
     * until the caller acknowledges it, this counts as a lost transaction.
     */
    private transactionAbort;
    /**
     * The server's last generated AUTO_INCREMENT value as this adapter last saw it
     * inside the open transaction: `undefined` for none, `null` when a query()
     * INSERT may have changed it unseen. See readExecuteResult().
     */
    private insertIdBaseline;
    /**
     * Tail of the statement queue; see inTurn(). It never rejects, so one failed
     * statement cannot block the ones behind it.
     */
    private statementQueue;
    constructor(config: ClientConfig);
    connect(): Promise<void>;
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    queryResult<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    execute(sql: string, params?: QueryParams): Promise<ExecuteResult>;
    queryPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<T[]>;
    queryResultPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    executePrepared(sql: string, params?: QueryParams): Promise<ExecuteResult>;
    private executeNow;
    private queryNow;
    beginTransaction(): Promise<void>;
    private beginTransactionNow;
    commit(): Promise<void>;
    private commitNow;
    rollback(): Promise<void>;
    private rollbackNow;
    close(): Promise<void>;
    private closeNow;
    ping(): Promise<string>;
    private pingNow;
    /**
     * Run `statement` after every statement issued before it has settled.
     *
     * One query is several CAS requests (execute, FETCHes, handle release), and
     * CASConnection only keeps those frames apart. A statement that ran between
     * them would be unsafe: on CUBRID 10.2 to 11.4 the end of a transaction closes
     * every other cursor on the session, and in autocommit mode that end comes
     * with DML, an error, a ping or another query's last row. The CAS_INFO status
     * of that reply then sends the next FETCH to a new session, where the same
     * handle number can be another query's result. So at most one query
     * lifecycle is live at a time. Autocommit could not do better; an open
     * transaction could, but its commit and rollback would still have to wait.
     *
     * Nothing runs here but this adapter's own statements, so a statement can
     * never wait on its own turn. Waiting does not count towards readTimeout.
     */
    private inTurn;
    private executeQuery;
    /**
     * Counts a statement's affected rows and, after an INSERT, asks for the
     * session's last generated AUTO_INCREMENT value. See ExecuteResult.
     */
    private readExecuteResult;
    /**
     * Sends one statement and hands its decoded reply to `use` while the handle
     * is open.
     *
     * `commitAfter` runs an autocommit statement as a transaction that ends only
     * after `use`: the server forgets the generated AUTO_INCREMENT value when it
     * commits, so a statement sent with the autocommit flag could never be asked
     * for it (verified on CUBRID 10.2, 11.0, 11.2 and 11.4). The statement is
     * then committed with END_TRAN, or rolled back if anything failed.
     */
    private runStatement;
    /** Ends the transaction of a statement run by runStatement(commitAfter), on its own session. */
    private endStatementTransaction;
    /** Sends GET_LAST_INSERT_ID and returns the session's value, or undefined if it has none. */
    private fetchLastInsertId;
    /**
     * After a query() INSERT inside a transaction the baseline is unknown, so read
     * the server's value before the next execute() statement to have one.
     */
    private readInsertIdBaseline;
    /**
     * Run `use`, then release the query handle held by `response` however `use`
     * ended. The handle is read first because decoding the response can fail
     * after the server has already allocated it. A discarded session has no
     * handle left to release, and closeQueryHandle() sends nothing on it.
     */
    private withQueryHandle;
    /** True when an open transaction's session is gone, or the server rolled it back. */
    private isTransactionSessionLost;
    /** Nothing was lost if this adapter never held a transaction on a session. */
    private notConnectedError;
    private assertTransactionSession;
    /**
     * Called after a statement ran. If the session changed underneath it, that
     * statement is open on the new session, so drop the session rather than
     * let a later autocommit query persist work reported here as failed.
     */
    private bindTransactionSession;
    /** Retain a failed first statement's session so reconnection cannot hide it. */
    private bindSessionLostByFirstStatement;
    private recordTransactionAbort;
    private endTransaction;
    /** The server discarded the work, so there is nothing left to end. */
    private endTransactionIfSessionLost;
    private getOrCreateCAS;
    /**
     * Translate the public `ssl` option (boolean | ClientSSLOptions) into the flat
     * TLS fields understood by CASConnectionConfig. Returns an empty object when
     * SSL is disabled so the non-SSL path is untouched.
     */
    private resolveSslConfig;
    /**
     * Return the negotiated backslash-escaping mode for the current connection,
     * probing again whenever the session has changed since it was measured.
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
    /**
     * Replace every LOB locator in `rows` with its content: a Buffer for a BLOB and
     * a string for a CLOB. A row never leaves the driver holding a locator.
     *
     * This runs inside the query's own turn because a locator cannot be kept: on
     * CUBRID 10.2 to 11.4 a later commit of a DELETE or UPDATE, or a rollback,
     * deletes the file it names, and there is no request that holds it or releases
     * it. The session is pinned for the same reason a query handle's release is:
     * sendAndRecv() would open a new session after an autocommit reply.
     *
     * The sizes are checked before the first read, so a result over the limit
     * costs no LOB transfer and no memory.
     */
    private loadLobs;
    private readLob;
    /**
     * LOB_READ opens a transaction on the server, so an autocommit session is left
     * with one after its statement finished, and CAS_INFO stops reporting it as
     * releasable: an idle client would keep its CAS. Nothing was changed, so this
     * only ends that. Inside a caller's transaction there is nothing to do.
     */
    private endLobReadTransaction;
    /**
     * Best-effort release on the session that created the handle, so a cleanup
     * failure cannot replace the caller's own error. If that session is gone the
     * server has dropped the handle with it and nothing is sent.
     */
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

export { type ClientConfig, type ClientLogFields, type ClientLogLevel, type ClientLogger, type ClientOptions, type CollectionElement, type CollectionValue, type ColumnInfo, type ConnectionConfig, ConnectionError, type ConnectionFactory, type ConnectionLike, ConstraintError, CubridClient, type CubridErrorDetails, type CubridErrorKind, type CubridErrorOptions, CubridTransaction, DeadlockError, type Executable, type ExecutableTransactionClient, type ExecuteResult, LockTimeoutError, NativeCubridAdapter, type PreparedQueryable, type PreparedTransactionClient, QueryError, type QueryParam, type QueryParams, type QueryResult, type QueryResultRow, type Queryable, ReadTimeoutError, type ResultQueryable, type ResultTransactionClient, type SchemaColumn, type SchemaIndex, type SchemaIndexColumn, type SchemaOptions, type SchemaPrimaryKey, type SchemaTable, SqlSyntaxError, type TransactionCallback, type TransactionClient, TransactionError, ZonedDateTime, type ZonedDateTimeFields, type ZonedDateTimeType, buildWhere, createClient, escapeIdentifier, parseConnectionString };
