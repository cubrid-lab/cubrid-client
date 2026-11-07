export type QueryResultRow = Record<string, unknown>;

/** One decoded SET, MULTISET or SEQUENCE element. */
export type CollectionElement =
  | string
  | number
  | bigint
  | Date
  | Buffer
  | null
  | CollectionElement[];

/**
 * A decoded SET, MULTISET or SEQUENCE column value, in the order the server sent
 * it. SET values arrive without duplicates and MULTISET values keep them; both
 * use a server-defined order, and only SEQUENCE keeps the stored order.
 */
export type CollectionValue = CollectionElement[];
