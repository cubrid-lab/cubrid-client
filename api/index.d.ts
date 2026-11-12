import { Readable } from 'node:stream';

type QueryParam = string | number | boolean | bigint | Date | Buffer | null;
type QueryParams = readonly QueryParam[];

/** Content for {@link blob}: bytes, or a stream of byte chunks read once. */
type BlobSource = Buffer | Uint8Array | AsyncIterable<Buffer | Uint8Array> | Readable;
/**
 * Content for {@link clob}: text, UTF-8 bytes, or a stream of either read once.
 * Bytes must be valid UTF-8 and text must not hold a lone surrogate.
 */
type ClobSource = string | Buffer | AsyncIterable<string | Buffer | Uint8Array> | Readable;
/**
 * A BLOB or CLOB parameter, made by {@link blob} or {@link clob}. The prepared
 * methods upload its content with LOB_NEW and LOB_WRITE before the statement
 * runs; every other method refuses it with a TypeError before anything is sent.
 */
interface LobParam {
    readonly kind: "blob" | "clob";
    readonly source: BlobSource | ClobSource;
}
/** A parameter of `queryPrepared()`, `queryResultPrepared()` and `executePrepared()`. */
type PreparedQueryParam = QueryParam | LobParam;
/**
 * A BLOB parameter for the prepared methods. A Buffer or Uint8Array is sent as
 * it is and can be used again; an empty one is an empty BLOB, not NULL. An
 * AsyncIterable or Readable is read once, chunk by chunk, while the statement
 * runs. A plain Buffer parameter, without blob(), still binds as VARBIT.
 */
declare function blob(source: BlobSource): LobParam;
/**
 * A CLOB parameter for the prepared methods, stored as UTF-8. A string is
 * encoded, a Buffer must already be UTF-8, and an AsyncIterable or Readable may
 * yield either and is read once. Content that is not valid UTF-8 or text with a
 * lone surrogate fails the statement with a TypeError, and nothing is stored.
 */
declare function clob(source: ClobSource): LobParam;

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
    /** `connection`, `connect`, `query`, `queryResult`, `execute`, `queryPrepared`, `queryResultPrepared`, `executePrepared`, `executeMany`, `stream`, `beginTransaction`, `commit`, `rollback`, `close`, `ping` or `destroy`, and for a pool `pool.create`, `pool.destroy` or `pool.acquire-timeout`. */
    operation?: string;
    host?: string;
    port?: number;
    database?: string;
    /** Elapsed milliseconds of the operation. */
    durationMs?: number;
    /**
     * Number of bound parameters of a `query`, not their values. For `executeMany`,
     * the values of all its parameter sets together.
     */
    paramCount?: number;
    /** Number of rows a successful `query` returned, or a `stream` handed to its consumer. */
    rowCount?: number;
    /**
     * Why a pool closed a connection (`pool.destroy`): `in-transaction`, `busy`,
     * `failed-exchange`, `options`, `lifetime`, `idle`, `validation`, `error` or
     * `closed`. See `docs/API_REFERENCE.md`.
     */
    reason?: string;
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
/**
 * The isolation levels CUBRID 10.2 to 11.4 accept. Every other server level is
 * refused, so no level reads uncommitted rows. `serializable` behaved like
 * `repeatable read` on all four and still allows write skew.
 */
type IsolationLevel = "read committed" | "repeatable read" | "serializable";
/** Settings for a whole transaction, applied before it starts. */
interface TransactionOptions {
    isolationLevel?: IsolationLevel;
    /**
     * Longest one statement waits for a lock, in milliseconds. `0` does not wait
     * and `-1` has no limit. Must be an integer from `-1` to `2147483647`.
     */
    lockTimeout?: number;
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
    /** See {@link ClientOptions.fetchSize}. */
    fetchSize?: number | undefined;
    /** See {@link ClientOptions.timezone}. */
    timezone?: "local" | "utc" | undefined;
    /** See {@link ClientOptions.isolationLevel}. */
    isolationLevel?: IsolationLevel | undefined;
    /** See {@link ClientOptions.lockTimeout}. */
    lockTimeout?: number | undefined;
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
     * `stream()` applies the same limit to each row instead, see {@link StreamOptions}.
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
    /**
     * Rows asked for in each FETCH by `query()`, `queryResult()` and `stream()`.
     * CUBRID 10.2 to 11.4 ignore this number and answer every FETCH with about
     * 16 KiB of rows, or one row when a row is larger, so it changes neither the
     * round trips nor the memory used on those servers. Must be an integer from 1
     * to 2147483647. Default: 100.
     */
    fetchSize?: number;
    /**
     * The time zone DATE, TIME, TIMESTAMP and DATETIME values are decoded in. Those
     * SQL types carry no zone, so their fields must be read in some zone to become a
     * `Date` instant:
     *
     * - `"local"` (default, the 1.x behavior): the Node.js process's zone, so the
     *   same stored value is a different instant under a different `TZ`.
     * - `"utc"`: UTC, the zone `Date` parameters are already encoded in, so a `Date`
     *   written and read back is the same instant on every host. Read the fields
     *   with `getUTCFullYear()`, `getUTCHours()` and so on.
     *
     * The zone-aware types (TIMESTAMPTZ and the like) are not affected; they return
     * `ZonedDateTime`. `"utc"` is a candidate default for 2.0.
     */
    timezone?: "local" | "utc";
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
/**
 * Options of one statement, the optional last argument of `query()`,
 * `queryResult()`, `execute()`, their `Prepared` forms and `executeMany()`.
 *
 * After an abort or a timeout while the statement was on the wire, its outcome
 * on the server is unknown: it may have run, and in autocommit mode it may be
 * committed. Verify before running it again. See `docs/API_REFERENCE.md`.
 */
interface QueryOptions {
    /**
     * Cancels this statement. Already aborted: it rejects at once with
     * `signal.reason` and nothing is sent. Aborted while it waits behind other
     * statements: it leaves the queue, nothing is sent and the session is kept.
     * Aborted once sent: the connection is discarded so a late reply can never
     * answer another statement, it rejects with `signal.reason`, and it is never
     * retried. Inside a transaction that loses the transaction.
     */
    signal?: AbortSignal;
    /**
     * {@link ClientOptions.readTimeout} for this statement only, including its
     * FETCH, LOB and END_TRAN requests: the same inactivity limit and
     * `ReadTimeoutError`. 0 means no timeout for this statement. Must be from 0 to
     * 2147483647.
     */
    readTimeout?: number;
}
interface Queryable {
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<T[]>;
}
/** Runs a statement and reports its rows with their column metadata. */
interface ResultQueryable {
    queryResult<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<QueryResult<T>>;
}
/**
 * Options of `stream()`.
 *
 * LOB limit: `maxLobBytes` applies to each row of a stream, not to the whole
 * result as in `query()`. A row's BLOB and CLOB content is read when that row is
 * reached, so one row's content is the most a stream holds at once.
 */
interface StreamOptions {
    /** Rows asked for in each FETCH. Default: {@link ClientOptions.fetchSize}. */
    fetchSize?: number;
    /**
     * Stops the stream. The next read rejects with `signal.reason`, the query handle
     * is released and the statement's turn ends, even if the consumer is not reading.
     * A reply already awaited is not interrupted: the stream stops when it arrives,
     * so `readTimeout` limits how long that takes. The session stays usable.
     */
    signal?: AbortSignal;
    /**
     * Milliseconds a statement issued on this connection waits while the consumer
     * asks for no row, before it rejects with `kind: "stream-busy"`. Such a statement
     * may be the consumer's own, which could never run. Other statements wait as long
     * as the consumer keeps reading. 0 refuses them at once while the stream holds
     * the connection. This limit cannot be disabled. Default: 5000.
     */
    consumerTimeout?: number;
}
/**
 * Runs a statement and reads its rows one at a time, without holding the whole
 * result in memory. See the `stream()` method of `CubridClient`.
 */
interface Streamable {
    stream<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: StreamOptions): AsyncIterable<T>;
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
interface ExecuteResult {
    affectedRows: number;
    lastInsertId?: number | bigint;
}
/** Runs a statement and reports its {@link ExecuteResult} instead of rows. */
interface Executable {
    execute(sql: string, params?: QueryParams, options?: QueryOptions): Promise<ExecuteResult>;
}
/**
 * Runs statements with server-side prepared binding: the values travel as typed
 * binds, never as SQL text. Each call prepares, executes and releases its own
 * handle, so nothing is reused between calls. The results match `query()`,
 * `queryResult()` and `execute()`; the differences in how values convert are in
 * docs/TYPES.md. The methods without `Prepared` keep rendering SQL literals.
 */
interface PreparedQueryable {
    queryPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<T[]>;
    queryResultPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<QueryResult<T>>;
    executePrepared(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<ExecuteResult>;
}
/**
 * Outcome of `executeMany()`. Reported only when every set ran without error.
 */
interface ExecuteManyResult {
    /** Rows changed by all sets together. */
    affectedRows: number;
    /** Rows each set changed, in the order of `paramSets`. */
    results: number[];
}
/**
 * Runs one INSERT, UPDATE, DELETE or MERGE once per parameter set, with
 * server-side prepared binding: one PREPARE and EXECUTE_ARRAY requests instead
 * of a round trip per set. See `docs/API_REFERENCE.md` for the failure semantics:
 * in autocommit mode the batch is all or nothing, and inside a transaction a
 * failure leaves the transaction to the caller.
 */
interface BatchExecutable {
    executeMany(sql: string, paramSets: readonly QueryParams[], options?: QueryOptions): Promise<ExecuteManyResult>;
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
/**
 * The transaction client `CubridClient.transaction()` passes in: a
 * {@link TransactionClient} that can also run a statement over many parameter
 * sets. Kept apart from `TransactionClient` so 1.x code that implements that
 * interface keeps compiling.
 */
interface BatchTransactionClient extends TransactionClient, BatchExecutable {
}
/**
 * A manual transaction returned by `CubridClient.beginTransactionScope()`. It owns
 * a dedicated connection, so statements issued on the client meanwhile never join
 * it. Exactly one `commit()` or `rollback()` ends it and closes that connection;
 * every later call rejects without reaching the server.
 *
 * This describes a value the client returns. Members may be added to it in a
 * minor release, so do not implement it in your own classes.
 */
interface TransactionScope extends ResultTransactionClient, ExecutableTransactionClient, PreparedTransactionClient, BatchTransactionClient {
}
interface ConnectionLike {
    connect(): Promise<void>;
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<T[]>;
    /**
     * Optional so 1.x connection factories keep compiling. `queryResult()` on a
     * client or transaction fails when its connection does not provide it.
     */
    queryResult?<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<QueryResult<T>>;
    /**
     * Optional so 1.x connection factories keep compiling. `execute()` on a
     * client or transaction fails when its connection does not provide it.
     */
    execute?(sql: string, params?: QueryParams, options?: QueryOptions): Promise<ExecuteResult>;
    /**
     * Optional so 1.x connection factories keep compiling. The prepared methods
     * on a client or transaction fail when their connection does not provide
     * them, rather than falling back to SQL literals.
     */
    queryPrepared?<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<T[]>;
    queryResultPrepared?<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<QueryResult<T>>;
    executePrepared?(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<ExecuteResult>;
    /**
     * Optional so 1.x connection factories keep compiling. `executeMany()` on a
     * client or transaction fails when its connection does not provide it, rather
     * than running the sets one by one.
     */
    executeMany?(sql: string, paramSets: readonly QueryParams[], options?: QueryOptions): Promise<ExecuteManyResult>;
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
    /**
     * Optional so 1.x connection factories keep compiling. `stream()` on a client
     * fails on its first read when its connection does not provide it.
     */
    stream?<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: StreamOptions): AsyncIterable<T>;
    ping?(): Promise<string>;
    /**
     * Tears the connection down at once, without waiting for the statement in
     * flight, and makes every pending and later call reject. Synchronous and
     * idempotent; `close()` afterwards resolves. Optional so 1.x connection
     * factories keep compiling: `CubridClient.destroy()` falls back to `close()`,
     * without waiting for it, on a connection that does not provide it.
     */
    destroy?(): void;
}
type ConnectionFactory = (config: ClientConfig) => ConnectionLike | Promise<ConnectionLike>;

/**
 * Key of the internal method through which a connection tells the pool whether
 * its session may be handed to another caller. It is a symbol, not a member of
 * `ConnectionLike`, so it adds nothing to the public interface; a custom
 * connection without it is reused only after a lease in which every call
 * succeeded.
 */
declare const SESSION_STATE: unique symbol;

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
    /** The CAS a running close() took out of `cas`, so destroy() can still reach it. */
    private closingCas;
    /** Set by destroy(); this adapter never opens a session again. */
    private destroyed;
    private autoCommit;
    /** What every session of this connection must hold. See setTransactionOptions(). */
    private transactionOptions;
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
     * statement rather than by beginTransaction(): a CAS that went away between
     * transactions is legitimately replaced on that first statement, before there
     * is any work to lose.
     */
    private transactionGeneration;
    /**
     * `cas.outOfTransactionReplies` just before the transaction's first statement,
     * or null with no statement sent yet. See transactionEnded().
     */
    private transactionEndReplies;
    /**
     * The reply that said the server rolled back the open transaction on its own.
     * The session is still healthy, but its next statement would start a new
     * server transaction, and a commit would persist that statement alone. So
     * until the caller acknowledges it, this counts as a lost transaction.
     */
    private transactionAbort;
    /**
     * The session's last generated AUTO_INCREMENT value as this adapter last saw
     * it: `undefined` for none, `null` when a statement may have changed it unseen.
     * See readExecuteResult().
     */
    private insertIdBaseline;
    /** Session (`connectionGeneration`) that `insertIdBaseline` describes. */
    private insertIdGeneration;
    /**
     * Tail of the statement queue; see inTurn(). It never rejects, so one failed
     * statement cannot block the ones behind it.
     */
    private statementQueue;
    /** Statements behind the running one, which a stalled stream can make refuse. */
    private readonly waitingStatements;
    /** Every stream between its first read and its end, so close() can stop them. */
    private readonly openCursors;
    /** The stream whose turn is waiting for its consumer to ask for more rows. */
    private heldBy;
    /** Timer of the next possible refusal. See watchHeldTurn(). */
    private refusalTimer;
    /** See ClientOptions.timezone. */
    private readonly utcDates;
    constructor(config: ClientConfig);
    connect(): Promise<void>;
    /**
     * See {@link QueryOptions} for `signal` and a per-statement `readTimeout`. An
     * invalid option rejects before anything is queued or sent.
     */
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<T[]>;
    queryResult<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<QueryResult<T>>;
    /**
     * Reads a result one server reply at a time. See `CubridClient.stream()` for the
     * contract. The statement is issued by the first read, like any other statement
     * in the queue, and keeps its turn until it has released its query handle.
     */
    stream<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: StreamOptions): AsyncGenerator<T, void, undefined>;
    private streamRows;
    execute(sql: string, params?: QueryParams, options?: QueryOptions): Promise<ExecuteResult>;
    queryPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<T[]>;
    queryResultPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<QueryResult<T>>;
    executePrepared(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<ExecuteResult>;
    /**
     * Runs one INSERT, UPDATE, DELETE or MERGE once per set in `paramSets`: one
     * PREPARE, then EXECUTE_ARRAY requests on that handle, split by size, each
     * carrying as many sets as fit. See `CubridClient.executeMany()` for the contract.
     *
     * The SQL and every value are checked and encoded when this is called, before
     * anything is queued or sent; an empty `paramSets` resolves without sending.
     */
    executeMany(sql: string, paramSets: readonly QueryParams[], options?: QueryOptions): Promise<ExecuteManyResult>;
    private executeManyNow;
    /**
     * Sends the sets on the handle in a PREPARE reply, on the session that prepared
     * it. A SELECT, a statement without markers and a set whose size differs from
     * the server's marker count are refused before any set runs: the CAS would run a
     * SELECT for nothing, run nothing at all without a marker, and split values into
     * sets by the marker count without checking that they fill them.
     *
     * After a request with a failed set, the rest are not sent: the batch has failed.
     */
    private executeArray;
    private executeNow;
    private queryNow;
    private streamNow;
    private queryFailure;
    /**
     * Keep these settings on every session of this connection, in place of what was
     * set before and leaving any option not given as it is. close() goes back to
     * the configured values, so an adapter reused after a transaction inherits none.
     *
     * Refused inside a transaction: the server would apply it to the running
     * transaction at once, so reads before and after it could follow different
     * levels, while the caller believes the whole transaction ran under one.
     */
    setTransactionOptions(options: TransactionOptions): Promise<void>;
    private setTransactionOptionsNow;
    beginTransaction(): Promise<void>;
    private beginTransactionNow;
    commit(): Promise<void>;
    private commitNow;
    rollback(): Promise<void>;
    private rollbackNow;
    close(): Promise<void>;
    private closeNow;
    /**
     * Tear the connection down now, without waiting for the statement running on
     * it: its socket closes at once and nothing more is sent, not even CON_CLOSE.
     * The server then ends the session and rolls back its open transaction.
     *
     * The running statement rejects with kind `connection-lost`; its outcome on the
     * server is unknown and it is never retried. Every statement waiting behind it
     * and every later call rejects the same way without sending anything, and an
     * open stream ends with that error. This adapter never opens another session;
     * close() afterwards resolves. Synchronous and idempotent.
     */
    destroy(): void;
    ping(): Promise<string>;
    /**
     * For the pool: whether this session may go to another caller. Read
     * synchronously when a lease ends, so nothing queued can change it meanwhile.
     * See docs/adr/0008-pool-reuse-invariant.md.
     */
    private [SESSION_STATE];
    private pingNow;
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
     *
     * `options` belong to the statement (#150). A signal already aborted rejects
     * at once, and one aborted while the statement waits takes it out of the
     * queue; either way nothing is sent. Once its turn comes, see runScoped().
     */
    private inTurn;
    /**
     * Runs a statement whose turn has come with its own limits on every request
     * it sends, FETCH, LOB_READ and END_TRAN included. An abort once a request is
     * written retires the socket, as a read timeout does: the reply may still
     * come, and it must never answer another request. The statement then rejects
     * with the signal's reason, whatever else failed, and is never sent again.
     * Its outcome on the server is unknown; inside a transaction the transaction
     * is lost, which the next statement reports.
     */
    private runScoped;
    private queueStatement;
    /**
     * Arms the timer that refuses statements stuck behind a held stream, at the
     * earliest moment one of them could have waited `consumerTimeout` with no sign of
     * the consumer. Reading only the timestamps here keeps a row's cost at one
     * assignment: a consumer that is still reading just moves the deadline.
     */
    private watchHeldTurn;
    /** Hands rows over and, while more can follow, waits for the consumer to ask for them. */
    private offerRows;
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
    private streamWindows;
    /** An INSERT executed by a query path can invalidate the insert-ID baseline. */
    private forgetInsertIdAfterQuery;
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
    private runStatement;
    /**
     * The session and transaction handling of runStatement(). It sends PREPARE when
     * `prepared`, otherwise PREPARE_AND_EXECUTE, and `run` gets the reply while its
     * handle is open, with the session generation every follow-up request must reach.
     */
    private runOnSession;
    /**
     * Sends EXECUTE for the handle in a PREPARE reply. It must reach the session
     * that prepared it: on any other session the same number is another statement
     * or nothing. The CAS ignores extra values, so the count is checked against
     * the server's here.
     */
    private executeHandle;
    /**
     * Uploads every blob() and clob() parameter of `binds` on the session that
     * prepared the statement, after PREPARE so bad SQL fails before any upload, and
     * returns the binds with each LOB's handle in place. The LOBs belong to the
     * statement's transaction: runOnSession() commits or rolls back an autocommit
     * statement, and a caller's transaction stays the caller's. A handle is never
     * reused: each statement creates its own.
     */
    private uploadLobs;
    /**
     * LOB_NEW, then one LOB_WRITE per LOB_WRITE_CHUNK_SIZE bytes, each checked to
     * have stored everything sent. The source is read only as fast as the writes
     * are answered, and the handle EXECUTE gets states the size written.
     */
    private uploadLob;
    private exchangeOnSession;
    /** Ends the transaction of a statement run by runStatement(commitAfter), on its own session. */
    private endStatementTransaction;
    /** Sends GET_LAST_INSERT_ID and returns the session's value, or undefined if it has none. */
    private fetchLastInsertId;
    /** A new session starts with no value, whatever the last one held. */
    private followInsertIdSession;
    /** The statement that just ran or failed may have changed the session's value. */
    private forgetInsertId;
    /**
     * When the baseline is unknown, read the server's value before a statement that
     * may ask for it. REPLACE replies as an INSERT, and no other SQL text does.
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
     *
     * The same goes for a transaction the server reports as over. See
     * transactionEnded().
     */
    private bindTransactionSession;
    /**
     * Whether any reply since the transaction's first statement, END_TRAN aside,
     * said no transaction is open. Every reply inside a transaction says IN_TRAN on
     * CUBRID 10.2 to 11.4, even after -72, so this would mean the earlier statements
     * are gone and the next one would start over on a healthy session. It covers
     * FETCH, handle releases and pings too, because any later reply overwrites the
     * status, and a later statement would make it look open again.
     */
    private transactionEnded;
    /** Dropping the session turns this into a lost transaction, which everything checks. */
    private dropSessionIfTransactionEnded;
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
    /** Sends one FETCH for the rows after the first `fetched`, and returns its rows. */
    private fetchWindow;
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
    private loadLobs;
    /** Loads one row of a stream and returns whether that sent a LOB_READ. See streamWindows(). */
    private loadRowLobs;
    /** Finds the LOB cells of `rows` and refuses them if their content is over the limit. */
    private measureLobs;
    private readLob;
    /**
     * LOB_READ opens a transaction on the server, so an autocommit session is left
     * with one after its statement finished, and CAS_INFO stops reporting it as
     * releasable: an idle client would keep its CAS. Nothing was changed, so this
     * only ends that. Inside a caller's transaction there is nothing to do.
     */
    private endReadTransaction;
    /**
     * Best-effort release on the session that created the handle, so a cleanup
     * failure cannot replace the caller's own error. If that session is gone the
     * server has dropped the handle with it and nothing is sent.
     */
    private closeQueryHandle;
}

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

declare class CubridClient implements Queryable, ResultQueryable, Executable, PreparedQueryable, BatchExecutable, Streamable {
    private readonly config;
    private readonly connectionFactory;
    private sharedConnectionPromise;
    /** The shared connection as soon as the factory returns it, before it is ready. */
    private sharedConnection;
    /** Where transaction() and beginTransactionScope() open their own connections. */
    private readonly source;
    private closed;
    private destroyed;
    /** Connections of transaction() and beginTransactionScope() not ended yet, for destroy(). */
    private readonly dedicated;
    private readonly schemaOperations;
    private readonly openScopes;
    /** beginTransactionScope() calls still opening a connection, so close() can wait for them. */
    private readonly beginningScopes;
    constructor(config: ClientConfig, connectionFactory: ConnectionFactory);
    /**
     * Run a statement and return its rows. See {@link QueryOptions} for `signal`
     * and a per-statement `readTimeout`.
     *
     * @throws RangeError or TypeError (as a rejection, before anything is sent)
     * when an option is invalid.
     */
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<T[]>;
    queryResult<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<QueryResult<T>>;
    execute(sql: string, params?: QueryParams, options?: QueryOptions): Promise<ExecuteResult>;
    queryPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<T[]>;
    queryResultPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<QueryResult<T>>;
    executePrepared(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<ExecuteResult>;
    /**
     * Run one INSERT, UPDATE, DELETE or MERGE once per parameter set, with
     * server-side prepared binding: one PREPARE, then one EXECUTE_ARRAY request
     * for every set (several for a batch over about 1 MiB of values), instead of
     * a round trip per set. `results` holds each set's affected rows, in order.
     *
     * On this client, which runs in autocommit mode, the batch is all or nothing:
     * it is committed only when every set succeeded. Otherwise it is rolled back
     * and rejects with a `QueryError` whose `batch` reports every set's outcome.
     * An empty `paramSets` resolves `{ affectedRows: 0, results: [] }` and sends
     * nothing. A SELECT, SQL holding more than one statement, a statement without
     * a `?` marker and a set whose size is not the statement's marker count are
     * refused. Nothing is retried. See `docs/API_REFERENCE.md`.
     */
    executeMany(sql: string, paramSets: readonly QueryParams[], options?: QueryOptions): Promise<ExecuteManyResult>;
    /**
     * Run a statement and read its rows one at a time with `for await`, holding at
     * most one server reply of rows in memory. Nothing is sent before the first read.
     *
     * The open cursor holds this connection's turn until the rows run out or the
     * stream closes. A `break`, a throw or a failed read closes it and releases the
     * query handle; code that drives the iterator by hand must call `return()`.
     * Statements issued on this client meanwhile wait, so one awaited inside the loop
     * can never run: it rejects with `kind: "stream-busy"` after
     * {@link StreamOptions.consumerTimeout}. Use `transaction()`, which has its own
     * connection, or another client. See `docs/API_REFERENCE.md`.
     *
     * @throws RangeError at once when an option is invalid.
     */
    stream<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: StreamOptions): AsyncGenerator<T, void, undefined>;
    transaction<T>(callback: TransactionCallback<T, ResultTransactionClient & ExecutableTransactionClient & PreparedTransactionClient & BatchTransactionClient>, options?: TransactionOptions): Promise<T>;
    /**
     * Start a manual transaction on its own connection and return the handle that
     * owns it. Statements belong to the transaction only when sent through the
     * handle; `client.query()` and the rest keep using the shared connection in
     * autocommit, so concurrent callers can never join it (#112).
     *
     * End it with exactly one `commit()` or `rollback()`, which also closes its
     * connection; later calls on the handle reject without reaching the server.
     * `close()` rolls back a handle that was never ended.
     *
     * @throws RangeError at once when an option is invalid.
     */
    beginTransactionScope(options?: TransactionOptions): Promise<TransactionScope>;
    private openScope;
    /**
     * Start a manual transaction on the shared connection.
     *
     * @deprecated This 1.x method has no ownership token: any other call on this
     * client while the transaction is open, including an unrelated caller's,
     * joins the same server transaction. Use {@link beginTransactionScope}, or
     * `transaction(async (tx) => ...)`, which own a dedicated connection. Kept,
     * with its behavior unchanged, for all of 1.x. See issue #112.
     */
    beginTransaction(): Promise<void>;
    /**
     * Commit the manual transaction started by {@link beginTransaction}.
     *
     * @deprecated Use the `commit()` of a {@link beginTransactionScope} handle. See issue #112.
     */
    commit(): Promise<void>;
    /**
     * Roll back the manual transaction started by {@link beginTransaction}.
     *
     * @deprecated Use the `rollback()` of a {@link beginTransactionScope} handle. See issue #112.
     */
    rollback(): Promise<void>;
    close(): Promise<void>;
    private closeSharedConnection;
    /**
     * Tear down every connection of this client now, without waiting for anything
     * on them: the shared connection, `beginTransactionScope()` handles and
     * `transaction()` callbacks, even mid-handshake once the connection factory has
     * returned the connection. For when `close()` would wait
     * too long, such as a server that stopped answering or a process shutting down.
     *
     * Like `close()`, it stops new calls first. A statement in flight rejects with
     * kind `connection-lost`; its outcome on the server is unknown, it is never
     * retried, and the server rolls back its open transaction. Every statement
     * still waiting rejects the same way without being sent. No COMMIT is sent
     * after destroy(): a `transaction()` callback that goes on fails, and a commit
     * already in flight has an unknown outcome. Open scopes are discarded and open
     * streams end with that error. Resolves at once; calling `destroy()` or `close()` again
     * resolves too.
     *
     * A custom connection without `destroy()` is closed instead, without waiting
     * for its `close()`.
     */
    destroy(): Promise<void>;
    ping(): Promise<string>;
    /**
     * Return the CUBRID server version, for example `11.4.6.1963`. It sends the
     * same requests as `ping()` and shares its transaction and reconnect behavior;
     * only the failure message differs.
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
    /** Run catalog inspections on a captured shared connection until completion. */
    private runSchemaOperation;
    /**
     * getSharedConnection() for a method that renders SQL literals, refusing blob()
     * and clob() first. Not async: an extra await would let a statement issued later
     * take the connection's turn first.
     */
    private literalConnection;
    private getSharedConnection;
    private prepareSharedConnection;
}

declare function createClient(options: ClientOptions): CubridClient;

/**
 * Options of `createPool()`: every {@link ClientOptions} setting, applied to
 * each connection the pool opens, and the pool's own limits. An invalid value
 * throws a `RangeError` from `createPool()`.
 */
interface PoolOptions extends ClientOptions {
    /**
     * Most connections open at once, counting those still being opened. An
     * integer of at least 1. Default: 10.
     */
    max?: number;
    /**
     * Connections the pool keeps open even when idle, opened in the background
     * after `createPool()` and after a connection is closed. A failure to open one
     * is only logged. An integer from 0 to `max`. Default: 0.
     */
    min?: number;
    /**
     * Longest a caller waits for a connection, in milliseconds, before it rejects
     * with a `ConnectionError` of kind `pool-timeout`. The wait does not count
     * towards `readTimeout`. An integer from 1 to 2147483647. Default: 30000.
     */
    acquireTimeoutMs?: number;
    /**
     * Most callers waiting for a connection at once. One more rejects at once with
     * kind `pool-full`. A non-negative integer or `Infinity`. Default: `Infinity`.
     */
    maxWaitingClients?: number;
    /**
     * Milliseconds a connection may stay idle before the pool closes it, never
     * going below `min`. `0` keeps idle connections open. An integer from 0 to
     * 2147483647. Default: 30000.
     */
    idleTimeoutMs?: number;
    /**
     * Age, in milliseconds, after which a connection is closed instead of being
     * reused. Checked when a lease ends and while the connection is idle, never
     * during a lease; each connection's limit is up to 10% shorter, so connections
     * opened together do not all close together. An integer from 1 to 2147483647.
     * Default: no limit.
     */
    maxLifetimeMs?: number;
    /**
     * A connection idle for at least this many milliseconds is checked with
     * `ping()` before it is leased; one that fails is closed and the caller gets
     * another. `0` checks before every lease. An integer from 0 to 2147483647.
     * Default: no check.
     */
    validateAfterIdleMs?: number;
}
/** A snapshot of the pool, from `CubridPool.stats()`. */
interface PoolStats {
    /** Connections open or being opened: `idle + active + pending`. */
    total: number;
    /** Open connections nobody holds. */
    idle: number;
    /** Connections held by a statement, stream, transaction or `connection()` callback. */
    active: number;
    /** Connections being opened. */
    pending: number;
    /** Callers waiting for a connection. */
    waiting: number;
}
/**
 * The connection `CubridPool.connection()` lends its callback. It runs in
 * autocommit mode, so it has no transaction methods: use `pool.transaction()`.
 * It is valid only while the callback runs; afterwards every call rejects
 * without reaching the server.
 *
 * This describes a value the pool passes in. Members may be added to it in a
 * minor release, so do not implement it in your own classes.
 */
interface PoolConnection extends Queryable, ResultQueryable, Executable, PreparedQueryable, BatchExecutable, Streamable {
}
/** Options of `CubridPool.connection()`. */
interface PoolConnectionOptions {
    /** Cancels the wait for a connection. It does not apply to the callback's statements. */
    signal?: AbortSignal;
}

/**
 * Create a pool of connections to one database. Nothing waits here: `min`
 * connections are opened in the background, and every other one when a caller
 * needs it.
 *
 * @throws RangeError or TypeError when an option is invalid.
 */
declare function createPool(options: PoolOptions): CubridPool;
/**
 * A pool of connections to one database. Each statement method leases a
 * connection for that statement only; `stream()` holds its lease until the
 * stream ends; `transaction()`, `beginTransactionScope()` and `connection()`
 * hold one until they end. A connection goes back to the pool only when its
 * session is clean: no open transaction, nothing still running, no request
 * with an unknown outcome and no transaction settings other than the pool's.
 * Otherwise it is closed. See `docs/API_REFERENCE.md` and ADR 0008.
 */
declare class CubridPool implements Queryable, ResultQueryable, Executable, PreparedQueryable, BatchExecutable, Streamable {
    private closed;
    private closing;
    private readonly idle;
    private readonly active;
    private pending;
    /** Callers waiting in line, in arrival order. */
    private readonly waiting;
    /** Every caller that has not been given a connection or an error yet. */
    private readonly unsettled;
    private readonly leases;
    private readonly opening;
    private readonly closings;
    private readonly openScopes;
    private readonly beginningScopes;
    private readonly statements;
    /** The callback lease running in this async context, so close() never waits for itself. */
    private readonly callbackLease;
    private readonly emit;
    private readonly config;
    private readonly connectionFactory;
    private readonly settings;
    /** Same as {@link createPool}. */
    constructor(options: PoolOptions);
    /** Run a statement on a leased connection and return its rows. See {@link QueryOptions}. */
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<T[]>;
    queryResult<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<QueryResult<T>>;
    execute(sql: string, params?: QueryParams, options?: QueryOptions): Promise<ExecuteResult>;
    queryPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<T[]>;
    queryResultPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<QueryResult<T>>;
    executePrepared(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<ExecuteResult>;
    /** `executeMany()` of the client, on one leased connection, in autocommit mode. */
    executeMany(sql: string, paramSets: readonly QueryParams[], options?: QueryOptions): Promise<ExecuteManyResult>;
    /**
     * Read a statement's rows one at a time with `for await`. The stream holds its
     * connection from the first read until it ends, so a statement awaited inside
     * the loop runs on another connection of the pool, or waits for one.
     *
     * @throws RangeError at once when an option is invalid.
     */
    stream<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: StreamOptions): AsyncGenerator<T, void, undefined>;
    /**
     * Run `fn` with one connection of the pool, in autocommit mode, and release it
     * when `fn` settles. The connection rejects every call made after that.
     * `options.signal` cancels the wait for the connection.
     */
    connection<T>(fn: (connection: PoolConnection) => Promise<T>, options?: PoolConnectionOptions): Promise<T>;
    /**
     * `transaction()` of the client, on a leased connection. The connection goes
     * back to the pool only when the transaction ended cleanly.
     */
    transaction<T>(callback: TransactionCallback<T, ResultTransactionClient & ExecutableTransactionClient & PreparedTransactionClient & BatchTransactionClient>, options?: TransactionOptions): Promise<T>;
    /**
     * `beginTransactionScope()` of the client, on a leased connection held until
     * `commit()` or `rollback()`. `close()` discards a scope nobody ended.
     *
     * @throws RangeError at once when an option is invalid.
     */
    beginTransactionScope(options?: TransactionOptions): Promise<TransactionScope>;
    /** Check one leased connection, as `CubridClient.ping()` does. */
    ping(): Promise<string>;
    /** Return the CUBRID server version, for example `11.4.6.1963`. */
    getServerVersion(): Promise<string>;
    /** See `CubridClient.getTables()`. */
    getTables(options?: SchemaOptions): Promise<SchemaTable[]>;
    /** See `CubridClient.getColumns()`. */
    getColumns(table: string, options?: SchemaOptions): Promise<SchemaColumn[]>;
    /** See `CubridClient.getPrimaryKey()`. */
    getPrimaryKey(table: string, options?: SchemaOptions): Promise<SchemaPrimaryKey | null>;
    /** See `CubridClient.getIndexes()`. */
    getIndexes(table: string, options?: SchemaOptions): Promise<SchemaIndex[]>;
    /** Counts of connections and waiting callers at this moment. */
    stats(): PoolStats;
    /**
     * Stop leasing and close every connection. In order: new calls and waiting
     * callers reject with kind `pool-closed`; idle connections close; open streams
     * end, as their connections close; statements, `connection()` callbacks and
     * `transaction()` callbacks run to their end and their connections close.
     * Scopes nobody ended are discarded meanwhile, not after: a statement may be
     * waiting for a lock that only such a scope holds. Calling it again returns the
     * same promise.
     */
    close(): Promise<void>;
    private drain;
    private total;
    /** Connections open now, leaving out those still opening. */
    private open;
    private canServe;
    private sourceFor;
    private runStatement;
    private streamOnLease;
    private pingLeased;
    /** A catalog inspection runs all its queries on one lease. */
    private runSchemaOperation;
    /**
     * Lease a connection: an idle one, a new one while fewer than `max` exist, or
     * the next one released, in the order callers arrived. Rejects with the
     * signal's reason when it aborts, and with a ConnectionError of kind
     * `pool-closed`, `pool-full` or `pool-timeout`, or the failure to open the
     * connection opened for this caller.
     */
    private acquire;
    /** Serves `waiter` now; only call it when canServe(). */
    private serve;
    private takeIdle;
    /** Gives `pooled`, already counted as active, to `waiter`, or back if it gave up. */
    private deliver;
    /** `waiter` was being served when its connection had to be closed. */
    private retry;
    /** Serves waiting callers while there is a connection or room for one. */
    private dispatch;
    /** An unused connection: to the first waiting caller, else idle. */
    private putBack;
    private lease;
    /**
     * Ends a lease: the connection goes back to the pool, or is closed when its
     * session is not clean (ADR 0008). Never throws.
     */
    private release;
    /** Why the connection of an ended lease must not be reused, if it must not. */
    private evictionReason;
    /** Closes a connection counted as active that no lease holds. */
    private discard;
    private destroy;
    /** Opens connections in the background until `min` exist. Failures are only logged. */
    private fillMin;
    /** Opens and sets up one connection: connected, with the pool's transaction settings. */
    private create;
    /** close() waits for connections being opened or validated. */
    private track;
    /** Arms the timer that closes an idle connection when it expires or idles too long. */
    private armIdleTimer;
    private onIdleTimer;
    private endpoint;
}

declare class CubridTransaction implements ResultTransactionClient, ExecutableTransactionClient, PreparedTransactionClient, BatchTransactionClient {
    private readonly connection;
    constructor(connection: ConnectionLike);
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<T[]>;
    queryResult<T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams, options?: QueryOptions): Promise<QueryResult<T>>;
    execute(sql: string, params?: QueryParams, options?: QueryOptions): Promise<ExecuteResult>;
    queryPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<T[]>;
    queryResultPrepared<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<QueryResult<T>>;
    executePrepared(sql: string, params?: readonly PreparedQueryParam[], options?: QueryOptions): Promise<ExecuteResult>;
    /**
     * `executeMany()` inside this transaction. A failed set rejects with every
     * set's outcome in `batch` and leaves the transaction as it is: the sets that
     * succeeded are still part of it, and the caller decides to roll back or not.
     */
    executeMany(sql: string, paramSets: readonly QueryParams[], options?: QueryOptions): Promise<ExecuteManyResult>;
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
 * - `stream-busy`: the client refused a statement that waited behind a `stream()`
 *   whose consumer stopped asking for rows. Nothing was sent.
 * - `pool-timeout`: a pool had no connection to lease within `acquireTimeoutMs`.
 *   Nothing was sent.
 * - `pool-full`: a pool already had `maxWaitingClients` callers waiting for a
 *   connection. Nothing was sent.
 * - `pool-closed`: the pool was closed before a connection could be leased.
 *   Nothing was sent.
 */
type CubridErrorKind = "unique-violation" | "not-null-violation" | "foreign-key-violation" | "syntax" | "semantic" | "deadlock" | "lock-timeout" | "interrupted" | "authentication" | "connection-lost" | "read-timeout" | "stream-busy" | "pool-timeout" | "pool-full" | "pool-closed";
/** One parameter set of an `executeMany()` call that the server reported as failed. */
interface ExecuteManySetFailure {
    /** Position of the set in `paramSets`. */
    index: number;
    /** The server's error code for this set. */
    code: number;
    /** Who assigned `code`; see {@link CubridErrorDetails.origin}. */
    origin?: "server" | "cas";
    /** Classification of `code`; see {@link CubridErrorKind}. */
    kind?: CubridErrorKind;
    /** The server's message for this set. */
    message: string;
}
/**
 * What became of each parameter set when `executeMany()` rejected because the
 * server reported one or more sets as failed.
 */
interface ExecuteManyFailure {
    /**
     * One entry per set in `paramSets`, in order: the rows the set changed when it
     * ran without error, and `null` when it failed or never ran. A count is what
     * the server reported before the outcome below, never a committed change.
     */
    results: ReadonlyArray<number | null>;
    /** Every failed set, in order. The error's own `code` and `kind` are the first one's. */
    failures: readonly ExecuteManySetFailure[];
    /** Number of sets the server ran, with or without error; the rest never ran. */
    executed: number;
    /**
     * `true` in autocommit mode: the client rolled the whole batch back, so no set
     * was committed. `false` inside a transaction: the sets that succeeded are still
     * part of it, uncommitted, and the caller decides whether to roll it back.
     */
    rolledBack: boolean;
}
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
    /**
     * Per-set outcome of an `executeMany()` that failed because the server reported
     * a parameter set as failed. Absent for every other failure.
     */
    batch?: ExecuteManyFailure;
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
     * Set by `CubridClient.transaction()`, and by the `commit()` of a
     * `beginTransactionScope()` handle, when rolling back also failed. `cause`
     * still holds the failure that started it. The connection is closed
     * afterwards, so the server discards the uncommitted work either way.
     */
    rollbackError?: Error;
    /**
     * Set by `CubridClient.transaction()`, and when a `beginTransactionScope()`
     * handle failed to end, when closing its connection also failed.
     */
    closeError?: Error;
    constructor(message: string, options?: CubridErrorOptions);
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

export { type BatchExecutable, type BatchTransactionClient, type BlobSource, type ClientConfig, type ClientLogFields, type ClientLogLevel, type ClientLogger, type ClientOptions, type ClobSource, type CollectionElement, type CollectionValue, type ColumnInfo, type ConnectionConfig, ConnectionError, type ConnectionFactory, type ConnectionLike, ConstraintError, CubridClient, type CubridErrorDetails, type CubridErrorKind, type CubridErrorOptions, CubridPool, CubridTransaction, DeadlockError, type Executable, type ExecutableTransactionClient, type ExecuteManyFailure, type ExecuteManyResult, type ExecuteManySetFailure, type ExecuteResult, type IsolationLevel, type LobParam, LockTimeoutError, NativeCubridAdapter, type PoolConnection, type PoolConnectionOptions, type PoolOptions, type PoolStats, type PreparedQueryParam, type PreparedQueryable, type PreparedTransactionClient, QueryError, type QueryOptions, type QueryParam, type QueryParams, type QueryResult, type QueryResultRow, type Queryable, ReadTimeoutError, type ResultQueryable, type ResultTransactionClient, type SchemaColumn, type SchemaIndex, type SchemaIndexColumn, type SchemaOptions, type SchemaPrimaryKey, type SchemaTable, SqlSyntaxError, type StreamOptions, type Streamable, type TransactionCallback, type TransactionClient, TransactionError, type TransactionOptions, type TransactionScope, ZonedDateTime, type ZonedDateTimeFields, type ZonedDateTimeType, blob, buildWhere, clob, createClient, createPool, escapeIdentifier, parseConnectionString };
