import type { ZonedDateTime } from "./zoned-date-time.js";

export type QueryResultRow = Record<string, unknown>;

/** One decoded SET, MULTISET or SEQUENCE element. */
export type CollectionElement =
  | string
  | number
  | bigint
  | Date
  | ZonedDateTime
  | Buffer
  | null
  | CollectionElement[];

/**
 * A decoded SET, MULTISET or SEQUENCE column value, in the order the server sent
 * it. SET values arrive without duplicates and MULTISET values keep them; both
 * use a server-defined order, and only SEQUENCE keeps the stored order.
 */
export type CollectionValue = CollectionElement[];

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
export interface ColumnInfo {
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
 * such column is the one in the row, at the position of the first. Give such
 * columns distinct aliases, or use `rowMode: "array"` ({@link ArrayQueryResult}),
 * to keep every value. A statement that returns no result set has no rows and
 * no columns.
 */
export interface QueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  columns: ColumnInfo[];
}

/**
 * Rows as arrays, together with the columns that produced them: what
 * `queryResult()` and `queryResultPrepared()` return with `rowMode: "array"`.
 *
 * Every row holds one value per select-list column, in select-list order, and
 * `columns[i]` describes the value at index `i` of each row. Columns with the
 * same name, an empty name or names that differ only in case each keep their
 * own value. A statement that returns no result set has no rows and no columns.
 *
 * `T` describes each row at compile time, for example `[number, string | null]`;
 * as with object rows, it is not checked at runtime.
 */
export interface ArrayQueryResult<T extends readonly unknown[] = unknown[]> {
  rows: T[];
  columns: ColumnInfo[];
}
