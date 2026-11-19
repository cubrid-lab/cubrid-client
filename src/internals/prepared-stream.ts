import type { ConnectionLike, StreamOptions } from "../types/client.js";
import type { QueryParams } from "../types/query.js";

/**
 * Key of the internal method through which a connection streams with typed
 * binds, for `stream()` with `binding: "prepared"` (ADR 0011). It is a symbol,
 * not a member of `ConnectionLike`, so it adds nothing to the public interface: a
 * custom connection has none and such a stream is refused, never run as literals.
 */
export const PREPARED_STREAM: unique symbol = Symbol("cubrid-client.preparedStream");

export type PreparedStreamOpener = (
  sql: string,
  params: QueryParams | undefined,
  options: StreamOptions | undefined,
) => AsyncIterable<unknown>;

/** The connection's own prepared stream, bound to it, or undefined when it has none. */
export function preparedStreamOf(connection: ConnectionLike): PreparedStreamOpener | undefined {
  const open: unknown = (connection as unknown as Record<symbol, unknown>)[PREPARED_STREAM];
  return typeof open === "function"
    ? (sql, params, options) =>
        open.call(connection, sql, params, options) as AsyncIterable<unknown>
    : undefined;
}
