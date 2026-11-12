import { QueryError } from "../errors/query-error.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResultRow } from "../types/result.js";
import type {
  SchemaColumn,
  SchemaIndex,
  SchemaIndexColumn,
  SchemaOptions,
  SchemaPrimaryKey,
  SchemaTable,
} from "../types/schema.js";

export type SchemaQuery = (sql: string, params?: QueryParams) => Promise<QueryResultRow[]>;

/**
 * Schema introspection reads the catalog views (`db_class`, `db_attribute`,
 * `db_index`, `db_index_key`) with ordinary bound queries instead of the CAS
 * SCHEMA_INFO request: the views answer the same way on CUBRID 10.2 to 11.4,
 * run on the session's connection and transaction, and need no result handle
 * to consume or close. Names are only ever bound as parameters. The views list
 * only what the connected user may SELECT, so an inaccessible table looks absent.
 */

export async function getTables(
  query: SchemaQuery,
  options?: SchemaOptions,
): Promise<SchemaTable[]> {
  const schema = checkSchema(options);
  const rows = await query(
    "SELECT class_name, owner_name, class_type FROM db_class " +
      "WHERE is_system_class = 'NO' ORDER BY owner_name, class_name",
  );

  return rows
    .filter((row) => schema === undefined || sameName(row.owner_name, schema))
    .map((row) => ({
      name: String(row.class_name),
      schema: String(row.owner_name),
      type: row.class_type === "VCLASS" ? "view" : "table",
    }));
}

export async function getColumns(
  query: SchemaQuery,
  table: string,
  options?: SchemaOptions,
): Promise<SchemaColumn[]> {
  const scope = await resolveTable(query, table, options);
  const rows = await query(
    "SELECT attr_name, def_order, data_type, prec, scale, is_nullable, default_value " +
      `FROM db_attribute WHERE class_name = ?${scope.sql} AND attr_type = 'INSTANCE' ` +
      "ORDER BY def_order",
    scope.params,
  );

  return rows.map((row) => ({
    name: String(row.attr_name),
    position: Number(row.def_order) + 1,
    dataType: String(row.data_type),
    precision: Number(row.prec),
    scale: Number(row.scale),
    nullable: row.is_nullable === "YES",
    defaultValue: row.default_value == null ? null : String(row.default_value),
  }));
}

export async function getPrimaryKey(
  query: SchemaQuery,
  table: string,
  options?: SchemaOptions,
): Promise<SchemaPrimaryKey | null> {
  const primary = (await getIndexes(query, table, options)).find((index) => index.primaryKey);

  return primary
    ? { name: primary.name, columns: primary.columns.map((column) => column.name ?? "") }
    : null;
}

export async function getIndexes(
  query: SchemaQuery,
  table: string,
  options?: SchemaOptions,
): Promise<SchemaIndex[]> {
  const scope = await resolveTable(query, table, options);
  const indexes = await query(
    "SELECT index_name, is_unique, is_reverse, is_primary_key, is_foreign_key, filter_expression " +
      `FROM db_index WHERE class_name = ?${scope.sql} ORDER BY index_name`,
    scope.params,
  );
  const keys = await query(
    "SELECT index_name, key_attr_name, key_order, asc_desc, key_prefix_length, func " +
      `FROM db_index_key WHERE class_name = ?${scope.sql} ORDER BY index_name, key_order`,
    scope.params,
  );

  return indexes.map((index) => ({
    name: String(index.index_name),
    unique: index.is_unique === "YES",
    reverse: index.is_reverse === "YES",
    primaryKey: index.is_primary_key === "YES",
    foreignKey: index.is_foreign_key === "YES",
    filter: typeof index.filter_expression === "string" ? index.filter_expression.trim() : null,
    columns: keys.filter((key) => key.index_name === index.index_name).map(toIndexColumn),
  }));
}

function toIndexColumn(key: QueryResultRow): SchemaIndexColumn {
  const column: SchemaIndexColumn = {
    name: typeof key.key_attr_name === "string" ? key.key_attr_name : null,
    order: key.asc_desc === "DESC" ? "desc" : "asc",
  };

  if (typeof key.func === "string") {
    column.expression = key.func.trim();
  }

  // The catalog reports -1 when the key has no prefix length.
  if (Number(key.key_prefix_length) > 0) {
    column.prefixLength = Number(key.key_prefix_length);
  }

  return column;
}

/**
 * Finds the one table `table` names. The catalog folds identifiers to lower
 * case and stores them without quotes, so the bare name is compared without
 * regard to case. Since CUBRID 11.2 several users may own a table with the
 * same name and the per-table views do not say which owner a row belongs to
 * unless asked, so the owner is added to the follow-up queries only then;
 * older servers have no such column and never need it.
 */
async function resolveTable(
  query: SchemaQuery,
  table: string,
  options?: SchemaOptions,
): Promise<{ sql: string; params: QueryParams }> {
  if (typeof table !== "string" || table === "") {
    throw new TypeError("table must be a non-empty string.");
  }

  const schema = checkSchema(options);
  const named = await query(
    "SELECT class_name, owner_name FROM db_class WHERE LOWER(class_name) = LOWER(?)",
    [table],
  );
  const found = named.filter((row) => schema === undefined || sameName(row.owner_name, schema));
  const label = schema === undefined ? table : `${schema}.${table}`;

  if (found.length === 0) {
    throw new QueryError(
      `Table ${label} was not found, or the connected user may not SELECT from it.`,
      { outcomeUnknown: false },
    );
  }

  if (found.length > 1) {
    const owners = found.map((row) => String(row.owner_name)).join(", ");
    throw new QueryError(`Table ${table} is owned by several users (${owners}); pass schema.`, {
      outcomeUnknown: false,
    });
  }

  const [row] = found;
  const name = String(row?.class_name);

  if (named.length === 1) {
    return { sql: "", params: [name] };
  }

  return { sql: " AND owner_name = ?", params: [name, String(row?.owner_name)] };
}

function checkSchema(options: SchemaOptions | undefined): string | undefined {
  const schema = options?.schema;

  if (schema !== undefined && (typeof schema !== "string" || schema === "")) {
    throw new TypeError("schema must be a non-empty string.");
  }

  return schema;
}

function sameName(actual: unknown, expected: string): boolean {
  return String(actual).toLowerCase() === expected.toLowerCase();
}
