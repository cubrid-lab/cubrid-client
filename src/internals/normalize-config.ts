import type {
  ClientConfig,
  ClientOptions,
  StreamOptions,
  TransactionOptions,
} from "../types/client.js";

/** Largest delay Node.js timers support. */
const MAX_READ_TIMEOUT = 2 ** 31 - 1;

/** FETCH carries its size as a signed 32-bit int. */
const MAX_FETCH_SIZE = 2 ** 31 - 1;

/** Largest lock timeout the server's int32 parameter holds, in milliseconds. */
const MAX_LOCK_TIMEOUT = 2 ** 31 - 1;

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

export function normalizeConfig(options: ClientOptions): ClientConfig {
  const { readTimeout, maxLobBytes, fetchSize, timezone } = options;

  // A value that quietly disabled the timeout would leave queries able to hang.
  if (
    readTimeout !== undefined &&
    !(Number.isFinite(readTimeout) && readTimeout >= 0 && readTimeout <= MAX_READ_TIMEOUT)
  ) {
    throw new RangeError(`readTimeout must be between 0 and ${MAX_READ_TIMEOUT} milliseconds.`);
  }

  assertValidRetryCount(options.maxConnectionRetryCount);
  assertValidMaxLobBytes(maxLobBytes);
  assertValidFetchSize(fetchSize);
  assertValidTimezone(timezone);
  assertValidTransactionOptions(options);

  return {
    host: options.host,
    port: options.port ?? 33000,
    database: options.database,
    user: options.user,
    password: options.password ?? "",
    connectionTimeout: options.connectionTimeout,
    ...(readTimeout !== undefined && { readTimeout }),
    ...(maxLobBytes !== undefined && { maxLobBytes }),
    ...(fetchSize !== undefined && { fetchSize }),
    ...(timezone !== undefined && { timezone }),
    ...pickTransactionOptions(options),
    maxConnectionRetryCount: options.maxConnectionRetryCount,
    ssl: options.ssl,
    logger: options.logger,
  };
}
