import test from "node:test";
import assert from "node:assert/strict";

import { createClient } from "../src/client/create-client.js";
import { QueryError } from "../src/errors/query-error.js";
import type { ConnectionLike } from "../src/types/client.js";
import type { QueryParams } from "../src/types/query.js";

type Row = Record<string, unknown>;

/** Answers each catalog view with scripted rows and records every statement it receives. */
class CatalogConnection implements ConnectionLike {
  statements: Array<{ sql: string; params: QueryParams | undefined }> = [];
  views: Record<string, Row[]> = {};

  async connect(): Promise<void> {}

  async query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<T[]> {
    this.statements.push({ sql, params });
    const view = /FROM (db_\w+)/.exec(sql)?.[1] ?? "";
    return (this.views[view] ?? []) as T[];
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async close(): Promise<void> {}
}

function clientWith(connection: CatalogConnection) {
  return createClient({
    host: "localhost",
    database: "demodb",
    user: "dba",
    connectionFactory: () => connection,
  });
}

test("getTables maps class types, keeps one owner on request, and binds nothing", async () => {
  const connection = new CatalogConnection();
  connection.views.db_class = [
    { class_name: "athlete", owner_name: "DBA", class_type: "CLASS" },
    { class_name: "v_athlete", owner_name: "DBA", class_type: "VCLASS" },
    { class_name: "notes", owner_name: "APP_U", class_type: "CLASS" },
  ];
  const client = clientWith(connection);

  assert.deepEqual(await client.getTables(), [
    { name: "athlete", schema: "DBA", type: "table" },
    { name: "v_athlete", schema: "DBA", type: "view" },
    { name: "notes", schema: "APP_U", type: "table" },
  ]);
  assert.deepEqual(await client.getTables({ schema: "app_u" }), [
    { name: "notes", schema: "APP_U", type: "table" },
  ]);
  assert.match(connection.statements[0]?.sql ?? "", /is_system_class = 'NO'/);
  assert.equal(connection.statements[0]?.params, undefined);
});

test("getColumns binds the table name and numbers columns from 1", async () => {
  const connection = new CatalogConnection();
  connection.views.db_class = [{ class_name: "t", owner_name: "DBA" }];
  connection.views.db_attribute = [
    { attr_name: "id", def_order: 0, data_type: "INTEGER", prec: 10, scale: 0, is_nullable: "NO", default_value: null },
    { attr_name: "v", def_order: 1, data_type: "STRING", prec: 5, scale: 0, is_nullable: "YES", default_value: "zz" },
  ];
  const client = clientWith(connection);
  const hostile = "t' OR '1'='1";

  assert.deepEqual(await client.getColumns(hostile), [
    { name: "id", position: 1, dataType: "INTEGER", precision: 10, scale: 0, nullable: false, defaultValue: null },
    { name: "v", position: 2, dataType: "STRING", precision: 5, scale: 0, nullable: true, defaultValue: "zz" },
  ]);
  // The name reaches the server only as a bound parameter, never inside the SQL text.
  assert.deepEqual(connection.statements[0]?.params, [hostile]);
  assert.equal(connection.statements.some((s) => s.sql.includes(hostile)), false);
  assert.deepEqual(connection.statements[1]?.params, ["t"]);
  assert.doesNotMatch(connection.statements[1]?.sql ?? "", /owner_name = \?/);
});

test("an unknown or inaccessible table rejects with a QueryError", async () => {
  const client = clientWith(new CatalogConnection());

  await assert.rejects(() => client.getColumns("missing"), (error: unknown) => {
    assert.ok(error instanceof QueryError);
    assert.match(error.message, /Table missing was not found, or the connected user may not SELECT/);
    return true;
  });
  await assert.rejects(() => client.getIndexes("missing", { schema: "u" }), /Table u\.missing was not found/);
  await assert.rejects(() => client.getPrimaryKey("missing"), QueryError);
});

test("several owners need a schema, and the owner then scopes the follow-up queries", async () => {
  const connection = new CatalogConnection();
  connection.views.db_class = [
    { class_name: "dup", owner_name: "UA" },
    { class_name: "dup", owner_name: "UB" },
  ];
  connection.views.db_attribute = [
    { attr_name: "x", def_order: 0, data_type: "INTEGER", prec: 10, scale: 0, is_nullable: "YES", default_value: null },
  ];
  const client = clientWith(connection);

  await assert.rejects(() => client.getColumns("dup"), /owned by several users \(UA, UB\); pass schema/);
  assert.equal(connection.statements.length, 1);

  assert.equal((await client.getColumns("dup", { schema: "ub" })).length, 1);
  const scoped = connection.statements[2];
  assert.match(scoped?.sql ?? "", /class_name = \? AND owner_name = \?/);
  assert.deepEqual(scoped?.params, ["dup", "UB"]);
});

test("getPrimaryKey returns the key columns in key order, or null", async () => {
  const connection = new CatalogConnection();
  connection.views.db_class = [{ class_name: "t", owner_name: "DBA" }];
  connection.views.db_index = [
    { index_name: "i_x", is_unique: "NO", is_reverse: "NO", is_primary_key: "NO", is_foreign_key: "NO", filter_expression: null },
    { index_name: "pk_t", is_unique: "YES", is_reverse: "NO", is_primary_key: "YES", is_foreign_key: "NO", filter_expression: null },
  ];
  connection.views.db_index_key = [
    { index_name: "i_x", key_attr_name: "x", key_order: 0, asc_desc: "ASC", key_prefix_length: -1, func: null },
    { index_name: "pk_t", key_attr_name: "b", key_order: 0, asc_desc: "ASC", key_prefix_length: -1, func: null },
    { index_name: "pk_t", key_attr_name: "a", key_order: 1, asc_desc: "ASC", key_prefix_length: -1, func: null },
  ];
  const client = clientWith(connection);

  assert.deepEqual(await client.getPrimaryKey("t"), { name: "pk_t", columns: ["b", "a"] });

  connection.views.db_index = connection.views.db_index.slice(0, 1);
  assert.equal(await client.getPrimaryKey("t"), null);
});

test("getIndexes maps flags, descending keys, prefixes, expressions and filters", async () => {
  const connection = new CatalogConnection();
  connection.views.db_class = [{ class_name: "t", owner_name: "DBA" }];
  connection.views.db_index = [
    { index_name: "i_all", is_unique: "YES", is_reverse: "YES", is_primary_key: "NO", is_foreign_key: "YES", filter_expression: " [t].d is not null " },
  ];
  connection.views.db_index_key = [
    { index_name: "i_all", key_attr_name: "c", key_order: 0, asc_desc: "DESC", key_prefix_length: 5, func: null },
    { index_name: "i_all", key_attr_name: null, key_order: 1, asc_desc: "ASC", key_prefix_length: -1, func: " lower([t].[c])" },
  ];

  assert.deepEqual(await clientWith(connection).getIndexes("t"), [
    {
      name: "i_all",
      unique: true,
      reverse: true,
      primaryKey: false,
      foreignKey: true,
      filter: "[t].d is not null",
      columns: [
        { name: "c", order: "desc", prefixLength: 5 },
        { name: null, order: "asc", expression: "lower([t].[c])" },
      ],
    },
  ]);
});

test("empty table or schema names are rejected before any query", async () => {
  const connection = new CatalogConnection();
  const client = clientWith(connection);

  await assert.rejects(() => client.getColumns(""), TypeError);
  await assert.rejects(() => client.getIndexes("t", { schema: "" }), TypeError);
  await assert.rejects(() => client.getTables({ schema: "" }), TypeError);
  assert.equal(connection.statements.length, 0);
});

test("a closed client rejects schema calls and opens no connection", async () => {
  let opened = 0;
  const client = createClient({
    host: "localhost",
    database: "demodb",
    user: "dba",
    connectionFactory: () => {
      opened += 1;
      return new CatalogConnection();
    },
  });
  await client.close();

  await assert.rejects(() => client.getTables(), QueryError);
  assert.equal(opened, 0);
});

// Schema lookup can start before close() but issue further catalog requests later.
for (const method of ["getColumns", "getIndexes", "getPrimaryKey"] as const) {
  test(`close() waits for in-flight ${method}`, async () => {
    const connection = new CatalogConnection();
    connection.views.db_class = [{ class_name: "t", owner_name: "DBA" }];
    let firstQueryStarted!: () => void;
    let releaseFirstQuery!: () => void;
    const started = new Promise<void>((resolve) => { firstQueryStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirstQuery = resolve; });
    const query = connection.query.bind(connection);
    const requests: string[] = [];
    let closedCount = 0;
    connection.query = async <T extends Row = Row>(sql: string, params?: QueryParams): Promise<T[]> => {
      requests.push(sql);
      const rows = await query<T>(sql, params);
      if (sql.includes("FROM db_class")) {
        firstQueryStarted();
        await gate;
      }
      return rows;
    };
    connection.close = async () => { closedCount += 1; };
    const client = clientWith(connection);
    const ongoing = client[method]("t");
    await started;
    let closeCompleted = false;
    const closing = client.close().then(() => { closeCompleted = true; });
    await Promise.resolve();
    assert.equal(closedCount, 0);
    assert.equal(closeCompleted, false);
    await assert.rejects(() => client.getTables(), QueryError);
    releaseFirstQuery();
    await ongoing;
    await closing;
    assert.equal(closedCount, 1);
    assert.equal(requests.length, method === "getColumns" ? 2 : 3);
    await assert.rejects(() => client[method]("t"), QueryError);
  });
}
