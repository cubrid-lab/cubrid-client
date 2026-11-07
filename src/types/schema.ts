/** Selects the owner (CUBRID calls it the schema) of the table to inspect. */
export interface SchemaOptions {
  /**
   * Owner of the table, for example `DBA`, matched without regard to case. It
   * is needed only when several visible users own a table with the same name,
   * which CUBRID 11.2 and later allow. When omitted and the name is ambiguous,
   * the call rejects with a `QueryError` that lists the owners.
   */
  schema?: string;
}

/** A table or view returned by `getTables()`. */
export interface SchemaTable {
  /** The table name as the catalog stores it: CUBRID folds identifiers to lower case. */
  name: string;
  /** The owner of the table, as the catalog stores it, for example `DBA`. */
  schema: string;
  type: "table" | "view";
}

/** A column returned by `getColumns()`. */
export interface SchemaColumn {
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
export interface SchemaPrimaryKey {
  name: string;
  /** Column names in key order. */
  columns: string[];
}

/** One key column of an index. */
export interface SchemaIndexColumn {
  /** `null` for an expression of a function-based index; see `expression`. */
  name: string | null;
  /** The expression text of a function-based index key. */
  expression?: string;
  order: "asc" | "desc";
  /** The prefix length of a prefix index such as `c(5)`. */
  prefixLength?: number;
}

/** An index returned by `getIndexes()`. Primary and foreign keys are indexes too. */
export interface SchemaIndex {
  name: string;
  unique: boolean;
  reverse: boolean;
  primaryKey: boolean;
  foreignKey: boolean;
  /** The condition of a filtered index; `null` when the index covers every row. */
  filter: string | null;
  columns: SchemaIndexColumn[];
}
