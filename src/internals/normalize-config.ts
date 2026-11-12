import { assertValidCharset } from "../protocol/charset.js";
import { assertValidCredentials } from "../protocol/protocol.js";
import type {
  ClientConfig,
  ClientOptions,
  ExecuteOptions,
  QueryOptions,
  StreamOptions,
  TransactionOptions,
} from "../types/client.js";

/** Largest delay Node.js timers support. */
const MAX_READ_TIMEOUT = 2 ** 31 - 1;

/** FETCH carries its size as a signed 32-bit int. */
const MAX_FETCH_SIZE = 2 ** 31 - 1;

/** Largest lock timeout the server's int32 parameter holds, in milliseconds. */
const MAX_LOCK_TIMEOUT = 2 ** 31 - 1;

/**
 * Metadata and LOB_READ replies of up to 161 KiB occur in normal use, so no limit
 * goes below 1 MiB. Rows and executeMany() results can be far larger.
 */
const MIN_MAX_REPLY_BYTES = 1024 * 1024;

/** DATA_LENGTH is a signed 32-bit int, so no reply can be longer. */
const MAX_MAX_REPLY_BYTES = 2 ** 31 - 1;

const ISOLATION_LEVELS: readonly unknown[] = ["read committed", "repeatable read", "serializable"];

/**
 * NaN or Infinity would retry forever, so the adapter, which is public and skips
 * normalizeConfig(), checks this too.
 */
export function assertValidRetryCount(count: number | undefined): void {
  if (count !== undefined && !(Number.isInteger(count) && count >= 0)) {
    throw new RangeError("maxConnectionRetryCount must be a non-negative integer.");
  }
}

/**
 * NaN compares false against every size, which would turn the limit off, so the
 * adapter, which is public and skips normalizeConfig(), checks this too.
 */
export function assertValidMaxLobBytes(limit: number | undefined): void {
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) {
    throw new RangeError("maxLobBytes must be a positive integer number of bytes.");
  }
}

/**
 * NaN compares false against every length, which would turn the limit off, so
 * the adapter, which is public and skips normalizeConfig(), checks this too.
 */
export function assertValidMaxReplyBytes(limit: number | undefined): void {
  if (
    limit !== undefined &&
    !(Number.isInteger(limit) && limit >= MIN_MAX_REPLY_BYTES && limit <= MAX_MAX_REPLY_BYTES)
  ) {
    throw new RangeError(
      `maxReplyBytes must be an integer from ${MIN_MAX_REPLY_BYTES} to ${MAX_MAX_REPLY_BYTES} bytes.`,
    );
  }
}

/**
 * The server reads any negative lock timeout as "no limit", so a typo such as -2
 * would quietly remove the limit, and an unknown level has no wire value. Every
 * public way in checks this: createClient(), CubridClient, the adapter and
 * transaction(). A TypeScript caller can still pass any value from JavaScript.
 */
export function assertValidTransactionOptions(
  options: { [K in keyof TransactionOptions]?: TransactionOptions[K] | undefined } | undefined,
): void {
  const { isolationLevel, lockTimeout } = options ?? {};

  if (isolationLevel !== undefined && !ISOLATION_LEVELS.includes(isolationLevel)) {
    throw new RangeError(
      'isolationLevel must be "read committed", "repeatable read" or "serializable".',
    );
  }

  if (
    lockTimeout !== undefined &&
    !(Number.isInteger(lockTimeout) && lockTimeout >= -1 && lockTimeout <= MAX_LOCK_TIMEOUT)
  ) {
    throw new RangeError(
      `lockTimeout must be an integer from -1 to ${MAX_LOCK_TIMEOUT} milliseconds.`,
    );
  }
}

/** The settings among `options`, leaving out the ones not given. */
export function pickTransactionOptions(
  options: { [K in keyof TransactionOptions]?: TransactionOptions[K] | undefined } | undefined,
): TransactionOptions {
  const { isolationLevel, lockTimeout } = options ?? {};
  return {
    ...(isolationLevel !== undefined && { isolationLevel }),
    ...(lockTimeout !== undefined && { lockTimeout }),
  };
}

/** The adapter, which is public and skips normalizeConfig(), checks this too. */
export function assertValidFetchSize(size: number | undefined): void {
  if (size !== undefined && !(Number.isInteger(size) && size > 0 && size <= MAX_FETCH_SIZE)) {
    throw new RangeError(`fetchSize must be an integer between 1 and ${MAX_FETCH_SIZE}.`);
  }
}

/**
 * Any other value would silently decode in local time, so it is refused. The
 * adapter, which is public and skips normalizeConfig(), checks this too.
 */
export function assertValidTimezone(timezone: unknown): void {
  if (timezone !== undefined && timezone !== "local" && timezone !== "utc") {
    throw new RangeError('timezone must be "local" or "utc".');
  }
}

/** Disabling the limit is not offered: that is what would let a nested statement hang. */
export function assertValidStreamOptions(options: StreamOptions | undefined): void {
  assertValidFetchSize(options?.fetchSize);
  const consumerTimeout = options?.consumerTimeout;

  if (
    consumerTimeout !== undefined &&
    !(
      Number.isInteger(consumerTimeout) &&
      consumerTimeout >= 0 &&
      consumerTimeout <= MAX_READ_TIMEOUT
    )
  ) {
    throw new RangeError(
      `consumerTimeout must be an integer between 0 and ${MAX_READ_TIMEOUT} milliseconds.`,
    );
  }
}

/** A value that quietly disabled the timeout would leave queries able to hang. */
function assertValidReadTimeout(readTimeout: unknown): void {
  if (
    readTimeout !== undefined &&
    !(
      typeof readTimeout === "number" &&
      Number.isFinite(readTimeout) &&
      readTimeout >= 0 &&
      readTimeout <= MAX_READ_TIMEOUT
    )
  ) {
    throw new RangeError(`readTimeout must be between 0 and ${MAX_READ_TIMEOUT} milliseconds.`);
  }
}

/**
 * Checked by the client, its transactions and the adapter before anything is
 * queued or sent. A signal that is not an AbortSignal could never cancel.
 */
export function assertValidQueryOptions(options: QueryOptions | undefined): void {
  if (options === undefined) {
    return;
  }

  if (options === null || typeof options !== "object") {
    throw new TypeError("Query options must be an object.");
  }

  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal.");
  }

  assertValidReadTimeout(options.readTimeout);
}

/** assertValidQueryOptions() for execute() and executePrepared(). */
export function assertValidExecuteOptions(options: ExecuteOptions | undefined): void {
  assertValidQueryOptions(options);
  const generatedKeys = options?.generatedKeys;
  if (generatedKeys !== undefined && typeof generatedKeys !== "boolean") {
    throw new TypeError("generatedKeys must be a boolean.");
  }
}

export function normalizeConfig(options: ClientOptions): ClientConfig {
  const { readTimeout, maxLobBytes, maxReplyBytes, fetchSize, timezone, charset } = options;
  const password = options.password ?? "";

  assertValidCredentials({ database: options.database, user: options.user, password });
  assertValidReadTimeout(readTimeout);
  assertValidRetryCount(options.maxConnectionRetryCount);
  assertValidMaxLobBytes(maxLobBytes);
  assertValidMaxReplyBytes(maxReplyBytes);
  assertValidFetchSize(fetchSize);
  assertValidTimezone(timezone);
  assertValidCharset(charset);
  assertValidTransactionOptions(options);

  return {
    host: options.host,
    port: options.port ?? 33000,
    database: options.database,
    user: options.user,
    password,
    connectionTimeout: options.connectionTimeout,
    ...(readTimeout !== undefined && { readTimeout }),
    ...(maxLobBytes !== undefined && { maxLobBytes }),
    ...(maxReplyBytes !== undefined && { maxReplyBytes }),
    ...(fetchSize !== undefined && { fetchSize }),
    ...(timezone !== undefined && { timezone }),
    ...(charset !== undefined && { charset }),
    ...pickTransactionOptions(options),
    maxConnectionRetryCount: options.maxConnectionRetryCount,
    ssl: options.ssl,
    logger: options.logger,
  };
}
