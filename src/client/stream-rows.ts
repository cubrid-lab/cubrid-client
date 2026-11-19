import { type ErrorKind, mapError } from "../internals/map-error.js";
import { ARRAY_ROWS_UNSUPPORTED, wantsArrayRows } from "../internals/normalize-config.js";
import { preparedStreamOf } from "../internals/prepared-stream.js";
import type { ConnectionLike, StreamOptions } from "../types/client.js";
import type { QueryParams } from "../types/query.js";

/**
 * Reads the rows of `stream()` from the connection `connect` gives, with typed
 * binds when `options.binding` is `"prepared"`. A failure of `connect` or of a read is a
 * QueryError, or for a transaction the error `kind` names; the reason of the
 * caller's own abort is passed on unchanged. A stream left early is closed on
 * its connection.
 */
export async function* streamRows<T>(
  connect: () => Promise<ConnectionLike>,
  sql: string,
  params: QueryParams | undefined,
  options: StreamOptions | undefined,
  kind: ErrorKind = "query",
  failureMessage = "Query failed.",
): AsyncGenerator<T, void, undefined> {
  const arrays = wantsArrayRows(options);
  // An abort is the caller's own decision, so its reason stays as it is.
  const failure = (error: unknown): unknown =>
    options?.signal?.aborted && error === options.signal.reason
      ? error
      : mapError(kind, error, failureMessage);

  let rows: AsyncIterator<T>;
  try {
    const connection = await connect();
    // The connection never sees `binding`, an option a custom one may not know.
    const { binding, ...forwarded } = options ?? {};
    const connectionOptions = options === undefined ? undefined : forwarded;
    let opened: AsyncIterable<unknown>;
    if (binding === "prepared") {
      // Never a fallback to SQL literals: the values would compare differently.
      const open = preparedStreamOf(connection);
      if (!open) {
        throw new Error(
          'Underlying connection cannot bind on the server, so stream() with binding "prepared" is refused.',
        );
      }
      opened = open(sql, params, connectionOptions);
    } else {
      if (!connection.stream) {
        throw new Error("Underlying connection does not support stream.");
      }
      opened = connection.stream(sql, params, connectionOptions);
    }
    rows = (opened as AsyncIterable<T>)[Symbol.asyncIterator]();
  } catch (error) {
    throw failure(error);
  }

  let exhausted = false;
  try {
    for (;;) {
      let next: IteratorResult<T>;
      try {
        next = await rows.next();
      } catch (error) {
        exhausted = true;
        throw failure(error);
      }

      if (next.done) {
        exhausted = true;
        return;
      }
      if (arrays && !Array.isArray(next.value)) {
        throw failure(new Error(ARRAY_ROWS_UNSUPPORTED));
      }
      yield next.value;
    }
  } finally {
    if (!exhausted) {
      try {
        await rows.return?.();
      } catch (error) {
        // biome-ignore lint/correctness/noUnsafeFinally: a failed cleanup of an unfinished stream is the error the caller must see
        throw failure(error);
      }
    }
  }
}
