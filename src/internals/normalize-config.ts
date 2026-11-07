import type { ClientConfig, ClientOptions } from "../types/client.js";

/** Largest delay Node.js timers support. */
const MAX_READ_TIMEOUT = 2 ** 31 - 1;

/**
 * NaN or Infinity would retry forever, so the adapter, which is public and skips
 * normalizeConfig(), checks this too.
 */
export function assertValidRetryCount(count: number | undefined): void {
  if (count !== undefined && !(Number.isInteger(count) && count >= 0)) {
    throw new RangeError("maxConnectionRetryCount must be a non-negative integer.");
  }
}

export function normalizeConfig(options: ClientOptions): ClientConfig {
  const { readTimeout } = options;

  // A value that quietly disabled the timeout would leave queries able to hang.
  if (
    readTimeout !== undefined &&
    !(Number.isFinite(readTimeout) && readTimeout >= 0 && readTimeout <= MAX_READ_TIMEOUT)
  ) {
    throw new RangeError(
      `readTimeout must be between 0 and ${MAX_READ_TIMEOUT} milliseconds.`,
    );
  }

  assertValidRetryCount(options.maxConnectionRetryCount);

  return {
    host: options.host,
    port: options.port ?? 33000,
    database: options.database,
    user: options.user,
    password: options.password ?? "",
    connectionTimeout: options.connectionTimeout,
    ...(readTimeout !== undefined && { readTimeout }),
    maxConnectionRetryCount: options.maxConnectionRetryCount,
    ssl: options.ssl,
    logger: options.logger,
  };
}
