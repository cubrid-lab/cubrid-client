// Compile test for the proposed 1.x "binding bridge" MINOR (#249, ADR 0011).
//
// It uses the real 1.x types from src/index.ts and declares the bridge's
// additions as extensions of them, then checks that code written for 1.x still
// compiles against the extended shapes: the bridge must be a MINOR. Compiled by
// `npm run typecheck`; nothing here runs, and nothing in src/ changes.

import type {
  ConnectionLike,
  ExecuteOptions,
  PreparedQueryParam,
  Queryable,
  QueryOptions,
  QueryParams,
  QueryResultRow,
  StreamOptions,
} from "../../src/index.js";
import { blob } from "../../src/index.js";

type Binding = "literal" | "prepared";

// The bridge adds an optional `binding` to the statement options.
interface BridgeQueryOptions extends QueryOptions {
  binding?: Binding;
}
interface BridgeExecuteOptions extends ExecuteOptions {
  binding?: Binding;
}
interface BridgeStreamOptions extends StreamOptions {
  binding?: Binding;
}
// executeMany() gets its own options type, equal to QueryOptions plus binding in 1.x.
type BridgeExecuteManyOptions = BridgeQueryOptions;

// The bridge widens the parameters of query(), queryResult(), execute() and
// stream() from QueryParams to readonly PreparedQueryParam[], for blob() and clob().
interface BridgeQueryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: BridgeQueryOptions,
  ): Promise<T[]>;
}
interface BridgeExecutable {
  execute(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: BridgeExecuteOptions,
  ): Promise<{ affectedRows: number }>;
}

// 1. Every 1.x options object is still a valid bridge options object.
export function oldOptionsStillFit(q: QueryOptions, e: ExecuteOptions, s: StreamOptions) {
  const a: BridgeQueryOptions = q;
  const b: BridgeExecuteOptions = e;
  const c: BridgeStreamOptions = s;
  const d: BridgeExecuteManyOptions = q;
  return [a, b, c, d];
}

// 2. A 1.x implementer of Queryable (for example a test double typed with
// QueryParams) still satisfies the widened interface, because method parameters
// are compared bivariantly.
class OneXTestDouble implements Queryable {
  async query<T extends QueryResultRow = QueryResultRow>(
    _sql: string,
    _params?: QueryParams,
    _options?: QueryOptions,
  ): Promise<T[]> {
    return [];
  }
}
export const widenedAcceptsOldImplementer: BridgeQueryable = new OneXTestDouble();

// 3. 1.x calls compile unchanged, and a LOB statement can move off executePrepared().
export async function callers(db: BridgeQueryable & BridgeExecutable): Promise<void> {
  const params: QueryParams = [1, "a", null];
  await db.query("SELECT ?, ?, ?", params);
  await db.query("SELECT 1", [], { signal: new AbortController().signal });
  await db.execute("INSERT INTO docs (body) VALUES (?)", [blob(Buffer.from("x"))], {
    binding: "prepared",
  });
}

// 4. The SPI does not change in the bridge: a 1.x custom connection with only
// the required members still compiles as a ConnectionLike.
export const minimalOneXConnection: ConnectionLike = {
  connect: async () => {},
  query: async () => [],
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
  close: async () => {},
};
