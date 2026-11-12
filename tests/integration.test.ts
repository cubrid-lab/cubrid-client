/**
 * Integration tests — real TCP against a live CUBRID server.
 *
 * Requires: a CUBRID broker on 127.0.0.1:33000 with database `testdb`
 * (user `dba`, empty password). Database-dependent cases self-skip when no
 * server is reachable. Set CUBRID_TEST_PORT to use another broker port, and
 * CUBRID_CONCURRENCY_ROUNDS to repeat the overlapping-query tests more often.
 *
 * Run:  npm run test:integration
 */

import assert from "node:assert/strict";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import test, { after, before, describe } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { NativeCubridAdapter } from "../src/adapters/native.js";
import { createClient } from "../src/client/create-client.js";
import { createPool } from "../src/client/pool.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import {
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  QueryError,
  SqlSyntaxError,
} from "../src/errors/query-error.js";
import { ReadTimeoutError } from "../src/errors/read-timeout-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import { CASConnection } from "../src/protocol/connection.js";
import { CASFunctionCode } from "../src/protocol/constants.js";
import {
  type FetchResult,
  type PrepareAndExecuteResult,
  parseFetch,
  parsePrepareAndExecute,
  writeFetch,
  writePrepareAndExecute,
} from "../src/protocol/protocol.js";
import type { ClientLogFields, ExecuteResult, TransactionClient } from "../src/types/client.js";
import { blob, clob } from "../src/types/lob.js";
import type { QueryParam, QueryParams } from "../src/types/query.js";
import { ZonedDateTime } from "../src/types/zoned-date-time.js";
import { buildWhere, escapeIdentifier } from "../src/utils/query.js";
import {
  FIXTURE_ZONES,
  LA_DST,
  LOCAL_DECODED,
  LOCAL_MIDNIGHT_SENT,
  SENT,
  UTC_DECODED,
} from "./fixtures/temporal-zones.js";

const TEST_CONFIG = {
  host: "127.0.0.1",
  port: Number(process.env.CUBRID_TEST_PORT ?? 33000),
  database: "testdb",
  user: "dba",
  password: "",
};

// ---------------------------------------------------------------------------
// Check availability at top level before registering tests
// ---------------------------------------------------------------------------

async function isCubridAvailable(): Promise<boolean> {
  try {
    const adapter = new NativeCubridAdapter({ ...TEST_CONFIG, connectionTimeout: 5000 });
    await adapter.connect();
    await adapter.close();
    return true;
  } catch (err) {
    console.log(
      `CUBRID not available; offline integration tests are skipped: ${(err as Error).message}`,
    );
    return false;
  }
}

const available = await isCubridAvailable();
if (!available && process.env.CUBRID_LIVE_REQUIRED === "1") {
  // Fail before registering the self-skipping suite. A release/CI job
  // cannot claim live verification when a broker was unreachable.
  throw new Error("Live CUBRID integration was required but the broker was unreachable");
}

// ---------------------------------------------------------------------------
// Connection tests (always run)
// ---------------------------------------------------------------------------

test("connect fails with wrong port", async () => {
  const adapter = new NativeCubridAdapter({
    ...TEST_CONFIG,
    port: 19999,
    connectionTimeout: 2000,
  });
  await assert.rejects(
    () => adapter.connect(),
    (err: Error) => {
      assert.ok(err instanceof ConnectionError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Tests that require a running CUBRID instance
// ---------------------------------------------------------------------------

describe("Integration: NativeCubridAdapter against Docker CUBRID", { skip: !available }, () => {
  test("connect to CUBRID", async () => {
    const adapter = new NativeCubridAdapter(TEST_CONFIG);
    await adapter.connect();
    await adapter.close();
  });

  // -------------------------------------------------------------------------
  // DDL & DML
  // -------------------------------------------------------------------------

  test("CREATE TABLE, INSERT, SELECT, UPDATE, DELETE, DROP", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      // Cleanup (ignore if not exists)
      try {
        await client.query("DROP TABLE IF EXISTS integration_test_native");
      } catch {
        // Table might not exist
      }

      // CREATE TABLE
      const createResult = await client.query(
        "CREATE TABLE integration_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(100), cnt INT)",
      );
      assert.deepEqual(createResult, []);

      // INSERT
      const insertResult = await client.query(
        "INSERT INTO integration_test_native (val, cnt) VALUES ('hello', 42)",
      );
      assert.deepEqual(insertResult, []);

      // INSERT with params
      const insertResult2 = await client.query(
        "INSERT INTO integration_test_native (val, cnt) VALUES (?, ?)",
        ["world", 99],
      );
      assert.deepEqual(insertResult2, []);

      // SELECT all
      const rows = await client.query("SELECT val, cnt FROM integration_test_native ORDER BY cnt");
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.val, "hello");
      assert.equal(rows[1]!.val, "world");

      // UPDATE
      const updateResult = await client.query(
        "UPDATE integration_test_native SET cnt = 100 WHERE val = 'hello'",
      );
      assert.deepEqual(updateResult, []);

      // Verify update
      const updated = await client.query(
        "SELECT cnt FROM integration_test_native WHERE val = 'hello'",
      );
      assert.equal(updated.length, 1);
      assert.equal(updated[0]!.cnt, 100);

      // DELETE
      const deleteResult = await client.query(
        "DELETE FROM integration_test_native WHERE val = 'world'",
      );
      assert.deepEqual(deleteResult, []);

      // Verify delete
      const remaining = await client.query("SELECT val FROM integration_test_native");
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]!.val, "hello");

      // DROP TABLE
      const dropResult = await client.query("DROP TABLE integration_test_native");
      assert.deepEqual(dropResult, []);
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // P0 regression: mode-aware string escaping (no silent corruption)
  // -------------------------------------------------------------------------

  test("P0: backslash/quote/newline string params round-trip without corruption", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS p0_escape_native");
      } catch {
        // Table might not exist
      }
      await client.query(
        "CREATE TABLE p0_escape_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(200))",
      );

      const samples = [
        "C:\\temp\\file.txt", // Windows path — backslashes must NOT be doubled
        "back\\slash",
        "O'Brien", // embedded single quote
        "line1\nline2", // newline
        "carriage\rreturn", // carriage return
        "mixed \\ ' end",
        "100%_plain",
      ];

      for (const s of samples) {
        await client.query("INSERT INTO p0_escape_native (val) VALUES (?)", [s]);
      }

      const rows = await client.query<{ val: string }>(
        "SELECT val FROM p0_escape_native ORDER BY id",
      );
      assert.equal(rows.length, samples.length);
      rows.forEach((row, i) => {
        assert.equal(row.val, samples[i], `round-trip mismatch for sample #${i}`);
      });

      await client.query("DROP TABLE p0_escape_native");
    } finally {
      await client.close();
    }
  });

  test("P0: NUL and Ctrl-Z string params are rejected, not silently mutated", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      await assert.rejects(
        () => client.query("SELECT ? AS v", ["a\0b"]),
        (err: Error) => {
          assert.ok(err instanceof QueryError);
          assert.match(((err.cause as Error).cause as Error).message, /null byte/);
          return true;
        },
      );
      await assert.rejects(
        () => client.query("SELECT ? AS v", ["a\x1ab"]),
        (err: Error) => {
          assert.ok(err instanceof QueryError);
          assert.match(((err.cause as Error).cause as Error).message, /Ctrl-Z/);
          return true;
        },
      );
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Data types
  // -------------------------------------------------------------------------

  test("data type round-trips", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS dt_test_native");
      } catch {
        // ignore
      }

      await client.query(`
        CREATE TABLE dt_test_native (
          int_col INT,
          bigint_col BIGINT,
          float_col FLOAT,
          double_col DOUBLE,
          str_col VARCHAR(200),
          date_col DATE,
          datetime_col DATETIME
        )
      `);

      await client.query(
        "INSERT INTO dt_test_native (int_col, bigint_col, float_col, double_col, str_col, date_col, datetime_col) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          42,
          BigInt("9223372036854775807"),
          3.14,
          2.718281828,
          "test string",
          new Date("2025-01-15"),
          new Date("2025-06-15T10:30:00Z"),
        ],
      );

      const rows = await client.query("SELECT * FROM dt_test_native");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.int_col, 42);
      assert.equal(typeof rows[0]!.str_col, "string");
      assert.equal(rows[0]!.str_col, "test string");
      assert.equal(rows[0]!.bigint_col, 9223372036854775807n);
      assert.equal(typeof rows[0]!.bigint_col, "bigint");
      // FLOAT is a 32-bit value; DOUBLE retains approximately 15 decimal digits.
      assert.equal(typeof rows[0]!.float_col, "number");
      assert.ok(Math.abs((rows[0]!.float_col as number) - 3.14) < 1e-5);
      assert.equal(typeof rows[0]!.double_col, "number");
      assert.ok(Math.abs((rows[0]!.double_col as number) - 2.718281828) < 1e-9);
      // CUBRID DATE and DATETIME have no stored timezone. Check each returned
      // SQL wall-clock component rather than claiming stable UTC instants.
      const sqlDate = rows[0]!.date_col;
      const sqlDatetime = rows[0]!.datetime_col;
      assert.ok(sqlDate instanceof Date);
      assert.ok(sqlDatetime instanceof Date);
      assert.equal(sqlDate.getFullYear(), 2025);
      assert.equal(sqlDate.getMonth(), 0);
      assert.equal(sqlDate.getDate(), 15);
      assert.equal(sqlDatetime.getFullYear(), 2025);
      assert.equal(sqlDatetime.getMonth(), 5);
      assert.equal(sqlDatetime.getDate(), 15);
      // The inserted JS Date is formatted using UTC components by this driver.
      const expectedUtc = new Date("2025-06-15T10:30:00Z");
      assert.equal(sqlDatetime.getHours(), expectedUtc.getUTCHours());
      assert.equal(sqlDatetime.getMinutes(), expectedUtc.getUTCMinutes());

      await client.query("DROP TABLE dt_test_native");
    } finally {
      await client.close();
    }
  });

  // #113: timezone "utc" reads the wire fields as UTC, whatever the process TZ.
  test("timezone utc: date and time values are the same instants under any process TZ", async () => {
    const previous = process.env.TZ;
    const client = createClient({ ...TEST_CONFIG, timezone: "utc" });
    const sent = new Date(Date.UTC(2024, 1, 29, 23, 59, 59, 999));

    try {
      for (const zone of ["UTC", "Asia/Seoul", "America/Los_Angeles"]) {
        process.env.TZ = zone;
        const [row] = await client.query(
          "SELECT DATETIME'2025-03-14 10:30:45.123' AS dt, TIMESTAMP'2025-03-14 10:30:45' AS ts, " +
            "DATE'0099-12-31' AS d, TIME'10:30:45' AS t, ? AS sent FROM db_root",
          [sent],
        );

        assert.equal((row!.dt as Date).toISOString(), "2025-03-14T10:30:45.123Z", zone);
        assert.equal((row!.ts as Date).toISOString(), "2025-03-14T10:30:45.000Z", zone);
        assert.equal((row!.d as Date).toISOString(), "0099-12-31T00:00:00.000Z", zone);
        assert.equal((row!.t as Date).toISOString(), "1970-01-01T10:30:45.000Z", zone);
        assert.equal((row!.sent as Date).getTime(), sent.getTime(), zone);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previous;
      }
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Text charsets (#238)
  // -------------------------------------------------------------------------

  describe("text charsets (#238)", () => {
    const CAFE = "caf\u00e9";
    const latin1 = { ...TEST_CONFIG, charset: "iso-8859-1" as const };
    const isIso88591 = async (): Promise<boolean> => {
      const client = createClient(TEST_CONFIG);
      try {
        const [row] = await client.query("SELECT CHARSET('x') AS cs FROM db_root");
        return row?.cs === "iso88591";
      } finally {
        await client.close();
      }
    };

    test("utf-8, the default, keeps UTF-8 bytes on an iso88591 database", async (t) => {
      if (!(await isIso88591())) return t.skip("testdb is not iso88591");
      for (const options of [TEST_CONFIG, { ...TEST_CONFIG, charset: "utf-8" as const }]) {
        const client = createClient(options);
        try {
          await client.execute("DROP TABLE IF EXISTS cc238_text");
          await client.execute("CREATE TABLE cc238_text (id INT, s VARCHAR(40))");
          await client.executePrepared("INSERT INTO cc238_text VALUES (?, ?)", [1, CAFE]);
          await client.execute("INSERT INTO cc238_text VALUES (?, ?)", [2, CAFE]);
          const rows = await client.query(
            "SELECT s, HEX(s) AS h, LENGTH(s) AS l, CHR(233) AS c FROM cc238_text ORDER BY id",
          );
          // The server keeps the UTF-8 bytes as five Latin-1 characters, and the
          // Latin-1 byte E9 is not UTF-8: unchanged 1.x behavior.
          const expected = { s: CAFE, h: "636166C3A9", l: 5, c: "\ufffd" };
          assert.deepEqual(rows, [expected, expected], JSON.stringify(options));
        } finally {
          await client.execute("DROP TABLE IF EXISTS cc238_text").catch(() => {});
          await client.close();
        }
      }
    });

    test("iso-8859-1 writes and reads Latin-1 and decodes each column in its charset", async (t) => {
      if (!(await isIso88591())) return t.skip("testdb is not iso88591");
      const client = createClient(latin1);
      try {
        await client.execute("DROP TABLE IF EXISTS cc238_text");
        await client.execute(
          "CREATE TABLE cc238_text (id INT, s VARCHAR(40), u VARCHAR(40) CHARSET utf8, " +
            `e ENUM('${CAFE}', 'x'), m SET(VARCHAR(10)), c CLOB)`,
        );
        await client.executePrepared("INSERT INTO cc238_text VALUES (?, ?, ?, ?, ?, ?)", [
          1,
          CAFE,
          CAFE,
          CAFE,
          null,
          clob(CAFE),
        ]);
        await client.execute(`INSERT INTO cc238_text (id, s, u, m) VALUES (2, ?, ?, {'${CAFE}'})`, [
          CAFE,
          CAFE,
        ]);
        const rows = await client.query(
          "SELECT s, HEX(s) AS hs, LENGTH(s) AS ls, u, HEX(u) AS hu, e, m, c, " +
            "HEX(CLOB_TO_CHAR(c)) AS hc, CHR(233) AS chr " +
            `FROM cc238_text ORDER BY id`,
        );
        const common = {
          s: CAFE,
          hs: "636166E9",
          ls: 4,
          u: CAFE,
          hu: "636166C3A9",
          chr: CAFE.at(-1),
        };
        assert.deepEqual(rows, [
          { ...common, e: CAFE, m: null, c: CAFE, hc: "636166E9" },
          { ...common, e: null, m: [CAFE], c: null, hc: null },
        ]);

        // A bound `SELECT ?` cell states its own charset; a label is SQL text.
        const result = await client.queryResultPrepared(`SELECT ? AS [${CAFE}]`, [CAFE]);
        assert.deepEqual(result.rows, [{ [CAFE]: CAFE }]);
        assert.equal(result.columns[0]?.name, CAFE);
      } finally {
        await client.execute("DROP TABLE IF EXISTS cc238_text").catch(() => {});
        await client.close();
      }
    });

    test("iso-8859-1 refuses text above U+00FF before sending it", async (t) => {
      if (!(await isIso88591())) return t.skip("testdb is not iso88591");
      const client = createClient(latin1);
      try {
        await client.execute("DROP TABLE IF EXISTS cc238_text");
        await client.execute("CREATE TABLE cc238_text (s VARCHAR(40), c CLOB)");
        const refusals: Array<() => Promise<unknown>> = [
          () => client.execute("INSERT INTO cc238_text (s) VALUES ('\u2603')"),
          () => client.execute("INSERT INTO cc238_text (s) VALUES (?)", ["\u2603"]),
          () => client.executePrepared("INSERT INTO cc238_text (s) VALUES (?)", ["\u2603"]),
        ];
        for (const refused of refusals) {
          await assert.rejects(refused, (error: Error) => {
            assert.ok(error instanceof QueryError);
            assert.match(String((error.cause as Error).cause), /cannot encode/);
            return true;
          });
        }
        // As for clob() content that is not UTF-8 in the default mode: a TypeError.
        await assert.rejects(
          () => client.executePrepared("INSERT INTO cc238_text (c) VALUES (?)", [clob("\u2603")]),
          (error: Error) => error instanceof TypeError && /cannot encode/.test(error.message),
        );
        // COUNT(*) is INTEGER on 10.2 and BIGINT on 11.x.
        const [count] = await client.query("SELECT COUNT(*) AS n FROM cc238_text");
        assert.equal(Number(count?.n), 0);
      } finally {
        await client.execute("DROP TABLE IF EXISTS cc238_text").catch(() => {});
        await client.close();
      }
    });

    // Needs a database created with `cubrid createdb <name> en_US.utf8`.
    const utf8Database = process.env.CUBRID_TEST_UTF8_DATABASE;
    test("on a utf8 database text round-trips as UTF-8 and iso-8859-1 reads utf8 columns as UTF-8", {
      skip: !utf8Database && "set CUBRID_TEST_UTF8_DATABASE",
    }, async () => {
      const text = `${CAFE} \ud55c\uae00 \u2603`;
      const writer = createClient({ ...TEST_CONFIG, database: utf8Database! });
      const reader = createClient({ ...latin1, database: utf8Database! });
      try {
        await writer.execute("DROP TABLE IF EXISTS cc238_text");
        await writer.execute("CREATE TABLE cc238_text (id INT, s VARCHAR(40))");
        await writer.executePrepared("INSERT INTO cc238_text VALUES (?, ?)", [1, text]);
        await writer.execute("INSERT INTO cc238_text VALUES (?, ?)", [2, text]);
        const sql = "SELECT s, LENGTH(s) AS l, CHARSET(s) AS cs FROM cc238_text ORDER BY id";
        const expected = { s: text, l: 9, cs: "utf8" };
        assert.deepEqual(await writer.query(sql), [expected, expected]);
        // The column says utf8, so a Latin-1 client still reads it as UTF-8.
        assert.deepEqual(await reader.query(sql), [expected, expected]);
      } finally {
        await writer.execute("DROP TABLE IF EXISTS cc238_text").catch(() => {});
        await Promise.allSettled([writer.close(), reader.close()]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // NULL handling
  // -------------------------------------------------------------------------

  test("NULL values", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS null_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE null_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))",
      );
      await client.query("INSERT INTO null_test_native (val) VALUES (NULL)");
      await client.query("INSERT INTO null_test_native (val) VALUES ('not null')");

      const rows = await client.query("SELECT val FROM null_test_native ORDER BY id");
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.val, null);
      assert.equal(rows[1]!.val, "not null");

      await client.query("DROP TABLE null_test_native");
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  test("transaction commit", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS tx_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE tx_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))",
      );

      await client.beginTransaction();
      await client.query("INSERT INTO tx_test_native (val) VALUES ('committed')");
      await client.commit();

      const rows = await client.query("SELECT val FROM tx_test_native");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.val, "committed");

      await client.query("DROP TABLE tx_test_native");
    } finally {
      await client.close();
    }
  });

  test("getServerVersion returns the server version and leaves a transaction's row to rollback()", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      const version = await client.getServerVersion();
      assert.match(version, /^\d+\.\d+\.\d+\.\d+$/);
      assert.equal(version, await client.ping());

      await client.query("DROP TABLE IF EXISTS tx_version_test_native");
      await client.query("CREATE TABLE tx_version_test_native (val VARCHAR(50))");

      await client.beginTransaction();
      await client.query("INSERT INTO tx_version_test_native (val) VALUES ('rolled back')");
      assert.equal(await client.getServerVersion(), version);
      await client.rollback();

      assert.deepEqual(await client.query("SELECT val FROM tx_version_test_native"), []);

      await client.query("DROP TABLE tx_version_test_native");
    } finally {
      await client.close();
    }
  });

  test("queryResult reports column metadata, duplicate names and a NULL-only column", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      await client.query("DROP TABLE IF EXISTS cm_a_native");
      await client.query("DROP TABLE IF EXISTS cm_b_native");
      await client.query(
        "CREATE TABLE cm_a_native (id INT NOT NULL PRIMARY KEY, label VARCHAR(20), amount NUMERIC(10,3), ts DATETIME, tags SET(INT))",
      );
      await client.query("CREATE TABLE cm_b_native (id INT)");
      await client.query("INSERT INTO cm_a_native (id, label) VALUES (7, 'seven')");

      const result = await client.queryResult(
        "SELECT a.id, b.id, a.label, a.amount, a.ts, a.tags, NULL AS nothing " +
          "FROM cm_a_native a LEFT JOIN cm_b_native b ON a.id = b.id",
      );

      assert.deepEqual(result.columns, [
        { name: "id", type: "INT", precision: 10, scale: 0, nullable: false },
        { name: "id", type: "INT", precision: 10, scale: 0, nullable: true },
        { name: "label", type: "VARCHAR", precision: 20, scale: 0, nullable: true },
        { name: "amount", type: "NUMERIC", precision: 10, scale: 3, nullable: true },
        { name: "ts", type: "DATETIME", precision: 23, scale: 3, nullable: true },
        { name: "tags", type: "SET", elementType: "INT", precision: 0, scale: 0, nullable: true },
        { name: "nothing", type: "NULL", precision: 0, scale: 0, nullable: true },
      ]);
      // One key per name, as query() returns: the second `id` (NULL here) wins.
      assert.deepEqual(result.rows, [
        { id: null, label: "seven", amount: null, ts: null, tags: null, nothing: null },
      ]);
      assert.deepEqual(
        await client.query(
          "SELECT a.id, b.id FROM cm_a_native a LEFT JOIN cm_b_native b ON a.id = b.id",
        ),
        [{ id: null }],
      );

      assert.deepEqual(await client.queryResult("INSERT INTO cm_b_native VALUES (1)"), {
        rows: [],
        columns: [],
      });

      await client.query("DROP TABLE cm_a_native");
      await client.query("DROP TABLE cm_b_native");
    } finally {
      await client.close();
    }
  });

  test("a ping inside a transaction leaves its row to rollback()", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      await client.query("DROP TABLE IF EXISTS tx_ping_test_native");
      await client.query("CREATE TABLE tx_ping_test_native (val VARCHAR(50))");

      await client.beginTransaction();
      await client.query("INSERT INTO tx_ping_test_native (val) VALUES ('rolled back')");
      assert.match(await client.ping(), /^\d+\.\d+/);
      await client.rollback();

      assert.deepEqual(await client.query("SELECT val FROM tx_ping_test_native"), []);

      await client.query("DROP TABLE tx_ping_test_native");
    } finally {
      await client.close();
    }
  });

  test("transaction rollback", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS tx_rb_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE tx_rb_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))",
      );

      // Insert in auto-commit
      await client.query("INSERT INTO tx_rb_test_native (val) VALUES ('kept')");

      // Start transaction and rollback
      await client.beginTransaction();
      await client.query("INSERT INTO tx_rb_test_native (val) VALUES ('rolled back')");
      await client.rollback();

      const rows = await client.query("SELECT val FROM tx_rb_test_native");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.val, "kept");

      await client.query("DROP TABLE tx_rb_test_native");
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Transaction callback (client.transaction())
  // -------------------------------------------------------------------------

  test("transaction callback with commit", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS tx_cb_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE tx_cb_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))",
      );

      const result = await client.transaction(async (tx) => {
        await tx.query("INSERT INTO tx_cb_test_native (val) VALUES ('via callback')");
        const rows = await tx.query<{ val: string }>("SELECT val FROM tx_cb_test_native");
        return rows[0]!.val;
      });

      assert.equal(result, "via callback");

      const rows = await client.query("SELECT val FROM tx_cb_test_native");
      assert.equal(rows.length, 1);

      await client.query("DROP TABLE tx_cb_test_native");
    } finally {
      await client.close();
    }
  });

  test("transaction callback with rollback on error", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS tx_err_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE tx_err_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))",
      );

      // Pre-insert a row
      await client.query("INSERT INTO tx_err_test_native (val) VALUES ('existing')");

      // Transaction that throws should rollback
      await assert.rejects(
        () =>
          client.transaction(async (tx) => {
            await tx.query("INSERT INTO tx_err_test_native (val) VALUES ('should be rolled back')");
            throw new Error("intentional error");
          }),
        (err: Error) => {
          assert.ok(
            err.message.includes("Transaction failed") || err.message.includes("intentional error"),
          );
          assert.ok(err.cause instanceof Error);
          assert.equal((err.cause as Error).message, "intentional error");
          return true;
        },
      );

      // Only the pre-existing row should remain
      const rows = await client.query("SELECT val FROM tx_err_test_native");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.val, "existing");

      await client.query("DROP TABLE tx_err_test_native");
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // #112: beginTransactionScope() owns its connection on a real server
  // -------------------------------------------------------------------------

  describe("beginTransactionScope() ownership", () => {
    const table = "tx_scope_test_native";

    async function withScopeTable(
      run: (client: ReturnType<typeof createClient>) => Promise<void>,
    ): Promise<void> {
      const client = createClient(TEST_CONFIG);
      try {
        await client.query(`DROP TABLE IF EXISTS ${table}`);
        await client.query(`CREATE TABLE ${table} (val VARCHAR(40))`);
        await run(client);
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
        await client.close();
      }
    }

    const values = async (client: ReturnType<typeof createClient>): Promise<string[]> =>
      (await client.query<{ val: string }>(`SELECT val FROM ${table} ORDER BY val`)).map(
        (row) => row.val,
      );

    test("an unrelated client write during the scope is not rolled back with it", async () => {
      await withScopeTable(async (client) => {
        const tx = await client.beginTransactionScope();

        await Promise.all([
          tx.query(`INSERT INTO ${table} VALUES ('scoped')`),
          client.query(`INSERT INTO ${table} VALUES ('unrelated')`),
        ]);
        await tx.rollback();

        assert.deepEqual(await values(client), ["unrelated"]);
      });
    });

    test("scoped work is invisible to the client until commit, then persists", async () => {
      await withScopeTable(async (client) => {
        const tx = await client.beginTransactionScope({ lockTimeout: 0 });
        await tx.query(`INSERT INTO ${table} VALUES ('scoped')`);

        // The shared connection is another session: it cannot read the
        // uncommitted row without waiting for its lock, so it sees nothing yet.
        const other = createClient(TEST_CONFIG);
        try {
          const seen = await other
            .transaction(async (otx) => {
              await otx.query("SET TRANSACTION LOCK TIMEOUT 0");
              return otx.query(`SELECT val FROM ${table}`);
            })
            .catch(() => "blocked" as const);
          assert.ok(seen === "blocked" || seen.length === 0, `saw ${JSON.stringify(seen)}`);
        } finally {
          await other.close();
        }

        await tx.commit();
        assert.deepEqual(await values(client), ["scoped"]);
        await assert.rejects(tx.query("SELECT 1 FROM db_root"), TransactionError);
      });
    });

    test("close() rolls back a scope nobody ended", async () => {
      const client = createClient(TEST_CONFIG);
      await client.query(`DROP TABLE IF EXISTS ${table}`);
      await client.query(`CREATE TABLE ${table} (val VARCHAR(40))`);
      const tx = await client.beginTransactionScope();
      await tx.query(`INSERT INTO ${table} VALUES ('abandoned')`);
      await client.close();

      const check = createClient(TEST_CONFIG);
      try {
        assert.deepEqual(await values(check), []);
      } finally {
        await check.query(`DROP TABLE IF EXISTS ${table}`);
        await check.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Transaction callback lifecycle: one terminal outcome, nothing after it
  // -------------------------------------------------------------------------

  describe("transaction callback lifecycle", () => {
    const table = "tx_lifecycle_test_native";

    /**
     * A real adapter that counts END_TRAN requests. Failure switches stand in
     * for faults a live broker will not produce on demand; the injected
     * rollback and commit never reach the server, so what the assertions read
     * back is what the server really kept.
     */
    class ObservedAdapter extends NativeCubridAdapter {
      commits = 0;
      rollbacks = 0;
      failCommit = false;
      failRollback = false;
      failClose = false;

      override async commit(): Promise<void> {
        this.commits += 1;
        if (this.failCommit) {
          throw new Error("injected commit failure");
        }
        await super.commit();
      }

      override async rollback(): Promise<void> {
        this.rollbacks += 1;
        if (this.failRollback) {
          throw new Error("injected rollback failure");
        }
        await super.rollback();
      }

      override async close(): Promise<void> {
        await super.close();
        if (this.failClose) {
          throw new Error("injected close failure");
        }
      }
    }

    async function withObservedClient(
      run: (
        client: ReturnType<typeof createClient>,
        observed: ObservedAdapter,
        insertedValues: () => Promise<string[]>,
      ) => Promise<void>,
      configure: (adapter: ObservedAdapter) => void = () => undefined,
    ): Promise<void> {
      const setup = createClient(TEST_CONFIG);
      const observed = new ObservedAdapter(TEST_CONFIG);
      configure(observed);
      const client = createClient({ ...TEST_CONFIG, connectionFactory: () => observed });

      const insertedValues = async () => {
        const rows = await setup.query<{ val: string }>(`SELECT val FROM ${table} ORDER BY id`);
        return rows.map((row) => row.val);
      };

      try {
        await setup.query(`DROP TABLE IF EXISTS ${table}`);
        await setup.query(
          `CREATE TABLE ${table} (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))`,
        );
        await run(client, observed, insertedValues);
      } finally {
        await setup.query(`DROP TABLE IF EXISTS ${table}`);
        await setup.close();
      }
    }

    const insert = (value: string) => `INSERT INTO ${table} (val) VALUES ('${value}')`;

    test("manual commit is the only commit and later statements cannot autocommit", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        const result = await client.transaction(async (tx) => {
          await tx.query(insert("before commit"));
          await tx.commit();
          await assert.rejects(tx.query(insert("after commit")), TransactionError);
          await assert.rejects(tx.commit(), TransactionError);
          await assert.rejects(tx.rollback(), TransactionError);
          return "ok";
        });

        assert.equal(result, "ok");
        assert.equal(observed.commits, 1);
        assert.equal(observed.rollbacks, 0);
        assert.deepEqual(await insertedValues(), ["before commit"]);
      });
    });

    test("manual rollback stops the automatic commit", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        const result = await client.transaction(async (tx) => {
          await tx.query(insert("rolled back"));
          await tx.rollback();
          await assert.rejects(tx.query(insert("after rollback")), TransactionError);
          return "declined";
        });

        assert.equal(result, "declined");
        assert.equal(observed.commits, 0);
        assert.equal(observed.rollbacks, 1);
        assert.deepEqual(await insertedValues(), []);
      });
    });

    test("an error after manual commit rejects and the commit stands", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await assert.rejects(
          client.transaction(async (tx) => {
            await tx.query(insert("kept"));
            await tx.commit();
            throw new Error("after commit");
          }),
          (error: Error) => error instanceof TransactionError && error.cause instanceof Error,
        );

        assert.equal(observed.rollbacks, 0);
        assert.deepEqual(await insertedValues(), ["kept"]);
      });
    });

    test("a tx kept after transaction() returned cannot write", async () => {
      await withObservedClient(async (client, _observed, insertedValues) => {
        let leaked: TransactionClient | undefined;

        await client.transaction(async (tx) => {
          leaked = tx;
          await tx.query(insert("committed"));
        });

        assert.ok(leaked);
        await assert.rejects(leaked.query(insert("leaked")), TransactionError);
        assert.deepEqual(await insertedValues(), ["committed"]);
      });
    });

    test("a bound query the callback did not await still lands inside the transaction", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        // The first bound query on a connection waits for the backslash-mode
        // probe, so its statement would otherwise follow the automatic commit.
        await client.transaction(async (tx) => {
          void tx.query(`INSERT INTO ${table} (val) VALUES (?)`, ["not awaited"]);
        });

        assert.equal(observed.commits, 1);
        assert.deepEqual(await insertedValues(), ["not awaited"]);
      });
    });

    test("a query that fails unawaited rolls back the rest of the transaction", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await assert.rejects(
          client.transaction(async (tx) => {
            await tx.query(insert("must not persist"));
            void tx.query("INSERT INTO tx_lifecycle_no_such_table (val) VALUES ('x')");
          }),
          TransactionError,
        );

        assert.equal(observed.commits, 0);
        assert.equal(observed.rollbacks, 1);
        assert.deepEqual(await insertedValues(), []);
      });
    });

    describe("observed and unobserved statement failures (#244)", () => {
      const missingTable = "INSERT INTO tx_lifecycle_no_such_table (val) VALUES ('x')";

      test("a duplicate key awaited and caught, then an UPDATE, commits both", async () => {
        await withObservedClient(async (client, observed, insertedValues) => {
          await client.query(`INSERT INTO ${table} (id, val) VALUES (1000, 'original')`);

          const result = await client.transaction(async (tx) => {
            await tx.query(insert("kept"));
            try {
              await tx.query(`INSERT INTO ${table} (id, val) VALUES (1000, 'duplicate')`);
            } catch (error) {
              assert.equal((error as TransactionError).kind, "unique-violation");
              await tx.query(`UPDATE ${table} SET val = 'updated' WHERE id = 1000`);
            }
            return "upserted";
          });

          assert.equal(result, "upserted");
          assert.equal(observed.commits, 1);
          assert.equal(observed.rollbacks, 0);
          assert.deepEqual(await insertedValues(), ["kept", "updated"]);
        });
      });

      // Early: a later awaited statement cannot finish before the failed one, which
      // the connection ran first. Late: the callback returns before any reply arrives.
      for (const schedule of ["early", "late"] as const) {
        test(`void tx.query() that fails rolls back the rest (${schedule})`, async () => {
          await withObservedClient(async (client, observed, insertedValues) => {
            let failedBeforeReturn: boolean | undefined;
            let failed = false;

            await assert.rejects(
              client.transaction(async (tx) => {
                await tx.query(insert("not kept"));
                const statement = tx.query(missingTable);
                // Records when it failed without observing it: Promise.prototype.then
                // bypasses the statement promise's own then().
                Promise.prototype.then.call(statement, undefined, () => {
                  failed = true;
                });
                if (schedule === "early") {
                  await tx.query("SELECT 1 FROM db_root");
                }
                failedBeforeReturn = failed;
              }),
              TransactionError,
            );

            assert.equal(failedBeforeReturn, schedule === "early");
            assert.equal(observed.commits, 0);
            assert.equal(observed.rollbacks, 1);
            assert.deepEqual(await insertedValues(), []);
          });
        });

        test(`a detached .catch() observes the failure and the rest commits (${schedule})`, async () => {
          await withObservedClient(async (client, observed, insertedValues) => {
            let failedBeforeReturn: boolean | undefined;
            let failed = false;

            await client.transaction(async (tx) => {
              await tx.query(insert("kept"));
              tx.query(missingTable).catch(() => {
                failed = true;
              });
              if (schedule === "early") {
                await tx.query("SELECT 1 FROM db_root");
              }
              failedBeforeReturn = failed;
            });

            assert.equal(failedBeforeReturn, schedule === "early");
            assert.equal(observed.commits, 1);
            assert.equal(observed.rollbacks, 0);
            assert.deepEqual(await insertedValues(), ["kept"]);
          });
        });
      }

      test("Promise.allSettled observes a failure and commits the statements that succeeded", async () => {
        await withObservedClient(async (client, observed, insertedValues) => {
          const results = await client.transaction((tx) =>
            Promise.allSettled([
              tx.query(insert("one")),
              tx.query(missingTable),
              tx.query(insert("two")),
            ]),
          );

          assert.deepEqual(
            results.map((result) => result.status),
            ["fulfilled", "rejected", "fulfilled"],
          );
          assert.equal(observed.commits, 1);
          assert.deepEqual(await insertedValues(), ["one", "two"]);
        });
      });

      test("a scope commits past an observed failure and refuses an unobserved one", async () => {
        await withObservedClient(async (client, _observed, insertedValues) => {
          const observedScope = await client.beginTransactionScope();
          await observedScope.query(insert("scope kept"));
          await observedScope.query(missingTable).catch(() => undefined);
          await observedScope.commit();

          const unobserved = await client.beginTransactionScope();
          await unobserved.query(insert("scope not kept"));
          void unobserved.query(missingTable);
          await assert.rejects(unobserved.commit(), TransactionError);

          assert.deepEqual(await insertedValues(), ["scope kept"]);
        });
      });
    });

    test("Promise.all of bound statements commits all of them through the queue", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        const values = ["one", "two", "three", "four", "five"];

        await client.transaction((tx) =>
          Promise.all(
            values.map((value) => tx.query(`INSERT INTO ${table} (val) VALUES (?)`, [value])),
          ),
        );

        assert.equal(observed.commits, 1);
        assert.equal(observed.rollbacks, 0);
        assert.deepEqual(await insertedValues(), values);
      });
    });

    test("Promise.all of query, queryResult and execute commits all of them once", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await client.transaction((tx) =>
          Promise.all([
            tx.query(insert("one")),
            tx.queryResult(insert("two")),
            tx.execute(insert("three")),
          ]),
        );

        assert.equal(observed.commits, 1);
        assert.equal(observed.rollbacks, 0);
        assert.deepEqual(await insertedValues(), ["one", "two", "three"]);
      });
    });

    test("an execute() the callback did not await lands inside the transaction", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await client.transaction(async (tx) => {
          void tx.execute(`INSERT INTO ${table} (val) VALUES (?)`, ["not awaited"]);
        });

        assert.equal(observed.commits, 1);
        assert.deepEqual(await insertedValues(), ["not awaited"]);
      });
    });

    test("an execute() that fails unawaited rolls back the rest of the transaction", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await assert.rejects(
          client.transaction(async (tx) => {
            await tx.query(insert("kept out"));
            void tx.execute("INSERT INTO tx_lifecycle_no_such_table (val) VALUES ('x')");
          }),
          TransactionError,
        );

        assert.equal(observed.commits, 0);
        assert.equal(observed.rollbacks, 1);
        assert.deepEqual(await insertedValues(), []);
      });
    });

    test("execute() and queryResult() after a manual commit reject and write nothing", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await client.transaction(async (tx) => {
          await tx.execute(insert("committed"));
          await tx.commit();
          await assert.rejects(tx.execute(insert("late execute")), TransactionError);
          await assert.rejects(tx.queryResult(insert("late queryResult")), TransactionError);
        });

        assert.equal(observed.commits, 1);
        assert.deepEqual(await insertedValues(), ["committed"]);
      });
    });

    test("Promise.all with a failing statement rolls back the statements queued with it", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await assert.rejects(
          client.transaction((tx) =>
            Promise.all([
              tx.query(insert("before the failure")),
              tx.query("INSERT INTO tx_lifecycle_no_such_table (val) VALUES ('x')"),
              tx.query(insert("after the failure")),
            ]),
          ),
          TransactionError,
        );

        assert.equal(observed.commits, 0);
        assert.equal(observed.rollbacks, 1);
        assert.deepEqual(await insertedValues(), []);
      });
    });

    test("a failed commit rolls back on the server and keeps its cause", async () => {
      await withObservedClient(
        async (client, observed, insertedValues) => {
          await assert.rejects(
            client.transaction(async (tx) => {
              await tx.query(insert("not committed"));
            }),
            (error: Error) =>
              error instanceof TransactionError &&
              (error.cause as Error).message === "injected commit failure",
          );

          assert.equal(observed.commits, 1);
          assert.equal(observed.rollbacks, 1);
          assert.deepEqual(await insertedValues(), []);
        },
        (adapter) => {
          adapter.failCommit = true;
        },
      );
    });

    test("rollback and close failures keep the original error and discard the work", async () => {
      await withObservedClient(
        async (client, observed, insertedValues) => {
          const original = new Error("original");

          await assert.rejects(
            client.transaction(async (tx) => {
              await tx.query(insert("never committed"));
              throw original;
            }),
            (error: Error) =>
              error instanceof TransactionError &&
              error.cause === original &&
              error.rollbackError?.message === "injected rollback failure" &&
              error.closeError?.message === "injected close failure",
          );

          assert.equal(observed.commits, 0);
          assert.equal(observed.rollbacks, 1);
          assert.deepEqual(await insertedValues(), []);
        },
        (adapter) => {
          adapter.failRollback = true;
          adapter.failClose = true;
        },
      );
    });

    test("a close failure after commit rejects but the commit is durable", async () => {
      await withObservedClient(
        async (client, observed, insertedValues) => {
          await assert.rejects(
            client.transaction(async (tx) => {
              await tx.query(insert("durable"));
            }),
            (error: Error) => error.message === "injected close failure",
          );

          assert.equal(observed.commits, 1);
          assert.deepEqual(await insertedValues(), ["durable"]);
        },
        (adapter) => {
          adapter.failClose = true;
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Parameterized queries (client-side interpolation)
  // -------------------------------------------------------------------------

  test("parameterized queries with various types", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS param_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE param_test_native (str_val VARCHAR(100), int_val INT, float_val DOUBLE)",
      );

      await client.query(
        "INSERT INTO param_test_native (str_val, int_val, float_val) VALUES (?, ?, ?)",
        ["hello 'world'", 42, 3.14],
      );

      const rows = await client.query(
        "SELECT str_val, int_val FROM param_test_native WHERE int_val = ?",
        [42],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.str_val, "hello 'world'");

      await client.query("DROP TABLE param_test_native");
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Multiple result sets / large result set fetch
  // -------------------------------------------------------------------------

  test("large result set triggers multi-fetch", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS fetch_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE fetch_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(20))",
      );

      // Insert 150 rows to trigger multi-fetch (DEFAULT_FETCH_SIZE is 100)
      for (let i = 0; i < 150; i++) {
        await client.query("INSERT INTO fetch_test_native (val) VALUES (?)", [
          `row_${String(i).padStart(3, "0")}`,
        ]);
      }

      const rows = await client.query("SELECT id, val FROM fetch_test_native ORDER BY id");
      assert.equal(rows.length, 150);
      assert.equal(rows[0]!.val, "row_000");
      assert.equal(rows[149]!.val, "row_149");

      await client.query("DROP TABLE fetch_test_native");
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // close() and transaction() callbacks (#246)
  // -------------------------------------------------------------------------

  describe("close() and running transaction() callbacks (#246)", () => {
    const table = "close_lifecycle_test_native";
    const SLEEP = "SELECT SLEEP(2) AS slept FROM db_root";
    const closedCause = (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof Error &&
      error.cause.message === "Client is closed.";

    async function withTable(run: (values: () => Promise<string[]>) => Promise<void>) {
      const setup = createClient(TEST_CONFIG);
      try {
        await setup.query(`DROP TABLE IF EXISTS ${table}`);
        await setup.query(
          `CREATE TABLE ${table} (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))`,
        );
        await run(async () => {
          const rows = await setup.query<{ val: string }>(`SELECT val FROM ${table} ORDER BY id`);
          return rows.map((row) => row.val);
        });
      } finally {
        await setup.query(`DROP TABLE IF EXISTS ${table}`);
        await setup.close();
      }
    }

    test("close() waits for a callback in SELECT SLEEP(2), which then commits, and refuses new ones", async () => {
      await withTable(async (values) => {
        const client = createClient(TEST_CONFIG);
        const order: string[] = [];
        let running!: () => void;
        const started = new Promise<void>((resolve) => {
          running = resolve;
        });

        const transaction = client
          .transaction(async (tx) => {
            await tx.query(`INSERT INTO ${table} (val) VALUES ('before sleep')`);
            running();
            await tx.query(SLEEP);
            await tx.query(`INSERT INTO ${table} (val) VALUES ('after sleep')`);
            return "committed";
          })
          .then((result) => {
            order.push("transaction");
            return result;
          });
        await started;

        const begun = Date.now();
        const closing = client.close().then(() => {
          order.push("close");
        });
        await assert.rejects(
          client.transaction(async () => undefined),
          closedCause,
        );
        await assert.rejects(client.beginTransactionScope(), closedCause);

        assert.equal(await transaction, "committed");
        await closing;
        const waited = Date.now() - begun;

        assert.deepEqual(order, ["transaction", "close"]);
        assert.ok(waited >= 1000, `close() waited for the sleeping callback (${waited} ms)`);
        // Committed by the time close() resolved, and each row once.
        assert.deepEqual(await values(), ["before sleep", "after sleep"]);
      });
    });

    test("a callback that fails while close() waits is rolled back before close() resolves", async () => {
      await withTable(async (values) => {
        const client = createClient(TEST_CONFIG);
        const failure = new Error("callback failed");
        let running!: () => void;
        const started = new Promise<void>((resolve) => {
          running = resolve;
        });

        const transaction = client.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${table} (val) VALUES ('rolled back')`);
          running();
          await tx.query(SLEEP);
          throw failure;
        });
        await started;
        const closing = client.close();

        await assert.rejects(
          transaction,
          (error: unknown) => error instanceof TransactionError && error.cause === failure,
        );
        await closing;
        assert.deepEqual(await values(), []);
      });
    });

    test("a callback whose connection is still opening when close() runs never starts", async () => {
      await withTable(async (values) => {
        const client = createClient(TEST_CONFIG);
        let started = false;

        const transaction = client.transaction(async (tx) => {
          started = true;
          await tx.query(`INSERT INTO ${table} (val) VALUES ('never')`);
        });
        await client.close();

        await assert.rejects(transaction, closedCause);
        assert.equal(started, false);
        assert.deepEqual(await values(), []);
      });
    });

    test("destroy() ends a close() waiting for SELECT SLEEP(2), and nothing is committed", async () => {
      await withTable(async (values) => {
        const client = createClient(TEST_CONFIG);
        let running!: () => void;
        const started = new Promise<void>((resolve) => {
          running = resolve;
        });

        const transaction = client.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${table} (val) VALUES ('destroyed')`);
          running();
          await tx.query(SLEEP);
        });
        await started;
        const order: string[] = [];
        const closing = client.close().then(() => {
          order.push("close");
        });
        const settled = transaction.then(
          () => order.push("transaction resolved"),
          (error: unknown) => {
            order.push("transaction rejected");
            assert.ok(error instanceof TransactionError);
          },
        );

        await client.destroy();
        await closing;
        // close() resolved on destroy(), not once the SLEEP ended.
        assert.deepEqual(order, ["close"]);
        await settled;
        assert.deepEqual(order, ["close", "transaction rejected"]);

        // The server rolls the session back once its SLEEP ends; poll until it has.
        const deadline = Date.now() + 15000;
        let rows = await values();
        while (rows.length > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          rows = await values();
        }
        assert.deepEqual(rows, []);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Zero dates (#178)
  // -------------------------------------------------------------------------

  describe("zero dates", () => {
    const TABLE = "integration_zero_dates";
    const ZERO_VALUES = [
      { type: "DATE", literal: "DATE'0000-00-00'", wireType: 13, size: 6 },
      { type: "DATETIME", literal: "DATETIME'0000-00-00 00:00:00'", wireType: 22, size: 14 },
      { type: "TIMESTAMP", literal: "TIMESTAMP'0000-00-00 00:00:00'", wireType: 15, size: 12 },
    ];

    for (const { type, literal, wireType, size } of ZERO_VALUES) {
      test(`a zero ${type} rejects with its column and type, and the session stays usable`, async () => {
        const adapter = new NativeCubridAdapter(TEST_CONFIG);
        await adapter.connect();
        const cas = (adapter as unknown as { cas: CASConnection }).cas;
        const generation = cas.connectionGeneration;

        try {
          await assert.rejects(
            adapter.query(`SELECT ${literal} AS zero_value, 'after' AS t`),
            (err: Error) => {
              assert.ok(err instanceof QueryError);
              assert.match(
                (err.cause as Error).message,
                new RegExp(`column "zero_value" \\(wire type ${wireType}, ${size} bytes\\)`),
              );
              return true;
            },
          );

          // Same physical session, and it answers the next statement.
          assert.equal(cas.connectionGeneration, generation);
          assert.deepEqual(await adapter.query("SELECT 1 AS one"), [{ one: 1 }]);
        } finally {
          await adapter.close();
        }
      });
    }

    test("a zero date inside a collection rejects, and the session stays usable", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      const cas = (adapter as unknown as { cas: CASConnection }).cas;
      const generation = cas.connectionGeneration;

      try {
        await assert.rejects(
          adapter.query(
            "SELECT CAST({DATE'0000-00-00', DATE'2020-01-02'} AS SEQUENCE OF DATE) AS c, 'after' AS t",
          ),
          (err: Error) => {
            assert.ok(err instanceof QueryError);
            assert.match((err.cause as Error).message, /column "c" \(wire type 18, 25 bytes\)/);
            return true;
          },
        );
        assert.equal(cas.connectionGeneration, generation);
        assert.deepEqual(await adapter.query("SELECT 1 AS one"), [{ one: 1 }]);
      } finally {
        await adapter.close();
      }
    });

    test("a stored zero date rejects, a valid row beside it still decodes, and a transaction survives", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, d DATE, dt DATETIME, ts TIMESTAMP)`,
        );
        await adapter.beginTransaction();
        await adapter.query(
          `INSERT INTO ${TABLE} VALUES (1, DATE'0000-00-00', DATETIME'0000-00-00 00:00:00', ` +
            `TIMESTAMP'0000-00-00 00:00:00')`,
        );
        await adapter.query(
          `INSERT INTO ${TABLE} VALUES (2, DATE'2020-01-02', DATETIME'2020-01-02 03:04:05', ` +
            `TIMESTAMP'2020-01-02 03:04:05')`,
        );

        for (const column of ["d", "dt", "ts"]) {
          await assert.rejects(
            adapter.query(`SELECT id, ${column} FROM ${TABLE} WHERE id = 1`),
            (err: Error) => {
              assert.ok(err instanceof QueryError);
              assert.match((err.cause as Error).message, new RegExp(`column "${column}"`));
              return true;
            },
          );
        }

        const rows = await adapter.query(`SELECT id, d FROM ${TABLE} WHERE id = 2`);
        assert.equal(rows.length, 1);
        assert.ok(rows[0]!.d instanceof Date);

        // The open transaction is still ours: its rows are visible, and commit works.
        assert.equal((await adapter.query(`SELECT id FROM ${TABLE}`)).length, 2);
        await adapter.commit();
        assert.equal((await adapter.query(`SELECT id FROM ${TABLE}`)).length, 2);
      } finally {
        try {
          await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        } finally {
          await adapter.close();
        }
      }
    });
  });

  describe("years 1 to 99", () => {
    const TABLE = "integration_early_years";

    test("DATE, DATETIME and TIMESTAMP keep their stored year", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, d DATE, dt DATETIME)`);
        await adapter.query(
          `INSERT INTO ${TABLE} VALUES (1, DATE'0050-06-15', DATETIME'0050-06-15 03:04:05.678')`,
        );
        await adapter.query(
          `INSERT INTO ${TABLE} VALUES (2, DATE'0099-12-31', DATETIME'0099-12-31 23:59:59.999')`,
        );
        const rows = await adapter.query(`SELECT id, d, dt FROM ${TABLE} ORDER BY id`);
        assert.equal(rows.length, 2);
        assert.equal((rows[0]!.d as Date).getFullYear(), 50);
        assert.equal((rows[0]!.dt as Date).getFullYear(), 50);
        assert.equal((rows[1]!.d as Date).getFullYear(), 99);
        assert.equal((rows[1]!.dt as Date).getFullYear(), 99);
        assert.equal((rows[0]!.dt as Date).getMilliseconds(), 678);
      } finally {
        try {
          await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        } finally {
          await adapter.close();
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Timezone-aware values and JSON (#111)
  // -------------------------------------------------------------------------

  describe("timezone-aware values and JSON", () => {
    const TABLE = "integration_zoned_values";
    const COLUMNS = ["tstz", "tsltz", "dttz", "dtltz"] as const;

    /** The value of the first column of the only row of `sql`, on a fresh session. */
    async function selectValue(sql: string): Promise<unknown> {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      try {
        const rows = await adapter.query(sql);
        assert.equal(rows.length, 1);
        return Object.values(rows[0] as Record<string, unknown>)[0];
      } finally {
        await adapter.close();
      }
    }

    const LITERALS: Array<{ literal: string; text: string; type: string }> = [
      {
        literal: "TIMESTAMPTZ'2020-01-02 03:04:05 +09:00'",
        text: "2020-01-02 03:04:05 +09:00",
        type: "TIMESTAMPTZ",
      },
      {
        literal: "TIMESTAMPTZ'2020-07-02 03:04:05 -05:30'",
        text: "2020-07-02 03:04:05 -05:30",
        type: "TIMESTAMPTZ",
      },
      {
        literal: "TIMESTAMPTZ'2020-01-02 03:04:05 America/New_York'",
        text: "2020-01-02 03:04:05 America/New_York EST",
        type: "TIMESTAMPTZ",
      },
      {
        literal: "DATETIMETZ'2020-01-02 03:04:05.678 +09:00'",
        text: "2020-01-02 03:04:05.678 +09:00",
        type: "DATETIMETZ",
      },
      {
        literal: "DATETIMETZ'2020-07-02 03:04:05.999 America/New_York EDT'",
        text: "2020-07-02 03:04:05.999 America/New_York EDT",
        type: "DATETIMETZ",
      },
      {
        literal: "DATETIMETZ'0001-01-01 00:00:00.000 +00:00'",
        text: "0001-01-01 00:00:00.000 +00:00",
        type: "DATETIMETZ",
      },
      {
        literal: "DATETIMETZ'9999-12-31 23:59:59.999 +14:00'",
        text: "9999-12-31 23:59:59.999 +14:00",
        type: "DATETIMETZ",
      },
    ];

    for (const { literal, text, type } of LITERALS) {
      test(`${literal} keeps its zone and its fields`, async () => {
        const value = await selectValue(`SELECT ${literal} AS v`);
        assert.ok(value instanceof ZonedDateTime);
        assert.equal(value.type, type);
        assert.equal(String(value), text);
      });

      test(`${literal} round-trips: its text, written back as a literal, reads the same`, async () => {
        const first = (await selectValue(`SELECT ${literal} AS v`)) as ZonedDateTime;
        const again = await selectValue(`SELECT ${first.type}'${first.toString()}' AS v`);
        assert.ok(again instanceof ZonedDateTime);
        assert.deepEqual({ ...again }, { ...first });
      });
    }

    test("leap days decode, and the server refuses a date that does not exist", async () => {
      assert.equal(
        String(await selectValue("SELECT DATETIMETZ'2020-02-29 23:59:59.999 +00:00' AS v")),
        "2020-02-29 23:59:59.999 +00:00",
      );
      assert.equal(
        String(await selectValue("SELECT DATETIMETZ'2000-02-29 00:00:00.000 +00:00' AS v")),
        "2000-02-29 00:00:00.000 +00:00",
      );
      // The decoder also rejects these as malformed, but the server never sends them.
      for (const literal of [
        "DATETIMETZ'2021-02-29 00:00:00.000 +00:00'",
        "DATETIMETZ'1900-02-29 00:00:00.000 +00:00'",
        "DATETIMETZ'10000-01-01 00:00:00.000 +00:00'",
        "TIMESTAMPTZ'2021-04-31 00:00:00 +00:00'",
      ]) {
        await assert.rejects(
          selectValue(`SELECT ${literal} AS v`),
          (error: Error) => {
            assert.ok(error instanceof QueryError, literal);
            assert.match(
              String((error.cause as Error | undefined)?.message),
              /Invalid utime/,
              literal,
            );
            return true;
          },
          literal,
        );
      }
    });

    test("a local-zone value arrives in the session zone and round-trips", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      try {
        // In a transaction the broker keeps the session, and so its time zone.
        await adapter.beginTransaction();
        await adapter.query("SET TIME ZONE 'Asia/Seoul'");
        const [row] = await adapter.query(
          "SELECT TIMESTAMPLTZ'2020-01-02 03:04:05 +09:00' AS a, " +
            "DATETIMELTZ'2020-07-02 03:04:05.5 America/New_York' AS b",
        );
        const a = row?.a as ZonedDateTime;
        const b = row?.b as ZonedDateTime;
        assert.equal(a.type, "TIMESTAMPLTZ");
        assert.equal(String(a), "2020-01-02 03:04:05 Asia/Seoul KST");
        assert.equal(b.type, "DATETIMELTZ");
        assert.equal(String(b), "2020-07-02 16:04:05.500 Asia/Seoul KST");

        const [again] = await adapter.query(
          `SELECT ${a.type}'${a.toString()}' AS a, ${b.type}'${b.toString()}' AS b`,
        );
        assert.deepEqual({ ...(again?.a as ZonedDateTime) }, { ...a });
        assert.deepEqual({ ...(again?.b as ZonedDateTime) }, { ...b });
      } finally {
        await adapter.close();
      }
    });

    test("stored values, NULL and a collection read back exactly, with the type names in the columns", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, tstz TIMESTAMPTZ, tsltz TIMESTAMPLTZ, ` +
            "dttz DATETIMETZ, dtltz DATETIMELTZ, seq SEQUENCE OF TIMESTAMPTZ, j JSON)",
        );
        await client.query(
          `INSERT INTO ${TABLE} VALUES (1, TIMESTAMPTZ'2020-01-02 03:04:05 +09:00', ` +
            "TIMESTAMPLTZ'2020-01-02 03:04:05 +09:00', DATETIMETZ'2020-01-02 03:04:05.678 +09:00', " +
            "DATETIMELTZ'2020-01-02 03:04:05.678 +09:00', " +
            "{TIMESTAMPTZ'2020-01-02 03:04:05 +09:00', TIMESTAMPTZ'2020-07-02 03:04:05 -05:30'}, " +
            `'{"a":[1,2.5,null]}')`,
        );
        await client.query(`INSERT INTO ${TABLE} (id) VALUES (2)`);

        const { rows, columns } = await client.queryResult(`SELECT * FROM ${TABLE} ORDER BY id`);

        assert.deepEqual(
          columns.map((column) => column.type),
          [
            "INT",
            "TIMESTAMPTZ",
            "TIMESTAMPLTZ",
            "DATETIMETZ",
            "DATETIMELTZ",
            "SEQUENCE",
            "VARCHAR",
          ],
        );
        const [first, second] = rows;
        assert.equal(String(first?.tstz), "2020-01-02 03:04:05 +09:00");
        assert.equal(String(first?.dttz), "2020-01-02 03:04:05.678 +09:00");
        for (const column of ["tsltz", "dtltz"] as const) {
          assert.ok(first?.[column] instanceof ZonedDateTime);
        }
        assert.deepEqual((first!.seq as ZonedDateTime[]).map(String), [
          "2020-01-02 03:04:05 +09:00",
          "2020-07-02 03:04:05 -05:30",
        ]);
        for (const column of [...COLUMNS, "seq", "j"]) {
          assert.equal(second?.[column], null, column);
        }

        // JSON is the server's text, not a parsed value, because below protocol 8 the
        // server sends wire type 2 (VARCHAR) instead of 34.
        assert.equal(first?.j, '{"a":[1,2.5,null]}');
        assert.deepEqual(JSON.parse(first?.j as string), { a: [1, 2.5, null] });
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.close();
      }
    });

    for (const { type, literal, wireType, size } of [
      {
        type: "TIMESTAMPTZ",
        literal: "TIMESTAMPTZ'0000-00-00 00:00:00 +00:00'",
        wireType: 29,
        size: 19,
      },
      {
        type: "DATETIMETZ",
        literal: "DATETIMETZ'0000-00-00 00:00:00.000 +00:00'",
        wireType: 31,
        size: 21,
      },
    ]) {
      test(`a zero ${type} rejects with its column and type, and the session stays usable`, async () => {
        const adapter = new NativeCubridAdapter(TEST_CONFIG);
        await adapter.connect();
        const cas = (adapter as unknown as { cas: CASConnection }).cas;
        const generation = cas.connectionGeneration;

        try {
          await assert.rejects(
            adapter.query(`SELECT ${literal} AS zero_value, 'after' AS t`),
            (err: Error) => {
              assert.ok(err instanceof QueryError);
              assert.match(
                (err.cause as Error).message,
                new RegExp(`column "zero_value" \\(wire type ${wireType}, ${size} bytes\\)`),
              );
              return true;
            },
          );

          assert.equal(cas.connectionGeneration, generation);
          assert.deepEqual(await adapter.query("SELECT 1 AS one"), [{ one: 1 }]);
        } finally {
          await adapter.close();
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // Collections (#82)
  // -------------------------------------------------------------------------

  test("db.query() exposes an unsupported value by its name further down the cause chain", async () => {
    const client = createClient(TEST_CONFIG);
    try {
      await assert.rejects(
        client.query("SELECT DATETIME'0000-00-00 00:00:00' AS zeroed"),
        (error: Error) => {
          const failure = (error.cause as Error).cause as Error;
          assert.equal(error.name, "QueryError");
          assert.equal(failure.name, "UnsupportedValueError");
          assert.match(failure.message, /column "zeroed" \(wire type 22, /);
          return true;
        },
      );
      assert.deepEqual(await client.query("SELECT 1 AS one"), [{ one: 1 }]);
    } finally {
      await client.close();
    }
  });

  describe("collection columns", () => {
    const TABLE = "integration_collections";
    const collectionClient = () => createClient(TEST_CONFIG);

    test("SET, MULTISET and SEQUENCE keep their documented semantics and the next column", async () => {
      const client = collectionClient();
      try {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, s SET OF INT, m MULTISET OF VARCHAR(20), ` +
            "q SEQUENCE OF BIGINT, after_collections VARCHAR(10))",
        );
        await client.query(
          `INSERT INTO ${TABLE} VALUES (1, {3,1,2,2}, {'b','a','b'}, {30000000000,1,1}, 'one')`,
        );
        await client.query(`INSERT INTO ${TABLE} VALUES (2, {}, {}, {}, 'two')`);
        await client.query(`INSERT INTO ${TABLE} VALUES (3, NULL, NULL, NULL, 'three')`);
        await client.query(
          `INSERT INTO ${TABLE} VALUES (4, {NULL}, {NULL,'x'}, {NULL,5,NULL}, 'four')`,
        );

        const rows = await client.query(`SELECT * FROM ${TABLE} ORDER BY id`);
        assert.deepEqual(rows, [
          {
            id: 1,
            s: [1, 2, 3],
            m: ["a", "b", "b"],
            q: [30000000000n, 1n, 1n],
            after_collections: "one",
          },
          { id: 2, s: [], m: [], q: [], after_collections: "two" },
          { id: 3, s: null, m: null, q: null, after_collections: "three" },
          { id: 4, s: [null], m: ["x", null], q: [null, 5n, null], after_collections: "four" },
        ]);
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.close();
      }
    });

    test("collection rows decode across more than one FETCH", async () => {
      const client = collectionClient();
      try {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, q SEQUENCE OF INT, label VARCHAR(10))`,
        );
        // 150 rows pass the 100-row fetch size, as in the multi-fetch test above.
        for (let i = 0; i < 150; i++) {
          await client.query(`INSERT INTO ${TABLE} VALUES (${i}, {${i},${i}}, 'row${i}')`);
        }

        const rows = await client.query(`SELECT id, q, label FROM ${TABLE} ORDER BY id`);
        assert.equal(rows.length, 150);
        assert.deepEqual(rows[0], { id: 0, q: [0, 0], label: "row0" });
        assert.deepEqual(rows[149], { id: 149, q: [149, 149], label: "row149" });
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.close();
      }
    });

    test("each supported element type decodes like its scalar column", async () => {
      const client = collectionClient();
      const cases: Array<[string, unknown[]]> = [
        ["CAST({1} AS SEQUENCE OF SMALLINT)", [1]],
        ["CAST({1,2} AS SEQUENCE OF INT)", [1, 2]],
        ["CAST({1.5} AS SEQUENCE OF FLOAT)", [1.5]],
        ["CAST({1.5,2.5} AS SEQUENCE OF DOUBLE)", [1.5, 2.5]],
        ["CAST({1} AS SEQUENCE OF MONETARY)", [1]],
        ["CAST({12.50} AS SEQUENCE OF NUMERIC(6,2))", ["12.50"]],
        ["CAST({'ab'} AS SEQUENCE OF CHAR(4))", ["ab  "]],
        ["CAST({'\ud55c\uae00',''} AS SEQUENCE OF VARCHAR(10))", ["\ud55c\uae00", ""]],
        ["CAST({1,2} AS SET OF ENUM('a','b'))", ["a", "b"]],
        ["CAST({X'0f'} AS SEQUENCE OF BIT VARYING(8))", [Buffer.from([0x0f])]],
        ["CAST({X''} AS SEQUENCE OF BIT VARYING(8))", [Buffer.alloc(0)]],
        ["CAST({DATE'2024-01-02'} AS SEQUENCE OF DATE)", [new Date(2024, 0, 2)]],
        ["CAST({TIME'03:04:05'} AS SEQUENCE OF TIME)", [new Date(1970, 0, 1, 3, 4, 5)]],
        [
          "CAST({TIMESTAMP'2024-01-02 03:04:05'} AS SEQUENCE OF TIMESTAMP)",
          [new Date(2024, 0, 2, 3, 4, 5)],
        ],
        [
          "CAST({DATETIME'2024-01-02 03:04:05.678'} AS SEQUENCE OF DATETIME)",
          [new Date(2024, 0, 2, 3, 4, 5, 678)],
        ],
      ];
      try {
        for (const [expression, expected] of cases) {
          const rows = await client.query(`SELECT ${expression} AS c, 'after' AS t`);
          assert.deepEqual(rows, [{ c: expected, t: "after" }], expression);
        }
      } finally {
        await client.close();
      }
    });

    test("an empty top-level BIT value is an empty Buffer and SQL NULL stays null", async () => {
      const client = collectionClient();
      try {
        assert.deepEqual(
          await client.query(
            "SELECT X'' AS e, CAST(X'' AS BIT VARYING(8)) AS v, CAST(NULL AS BIT VARYING(8)) AS n, " +
              "X'0f' AS b, 'after' AS t",
          ),
          [{ e: Buffer.alloc(0), v: Buffer.alloc(0), n: null, b: Buffer.from([0x0f]), t: "after" }],
        );
      } finally {
        await client.close();
      }
    });

    test("nested collections decode recursively", async () => {
      const client = collectionClient();
      try {
        assert.deepEqual(await client.query("SELECT {{1,2},{'a'}} AS c, 'after' AS t"), [
          { c: [[1, 2], ["a"]], t: "after" },
        ]);
        assert.deepEqual(
          await client.query("SELECT {{},{1}} AS c, {NULL,{1}} AS d, 'after' AS t"),
          [{ c: [[], [1]], d: [null, [1]], t: "after" }],
        );
        assert.deepEqual(await client.query("SELECT {{{1}}} AS c, 'after' AS t"), [
          { c: [[[1]]], t: "after" },
        ]);
      } finally {
        await client.close();
      }
    });

    test("the server sends a mixed-type collection as NULL; a cast reads it", async () => {
      const client = collectionClient();
      try {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, u SET)`);
        await client.query(`INSERT INTO ${TABLE} VALUES (1, {1,'a'})`);
        await client.query(`INSERT INTO ${TABLE} VALUES (2, {2,3})`);

        // The bytes of row 1 equal a genuine NULL, so the driver cannot tell them apart.
        assert.deepEqual(await client.query(`SELECT id, u FROM ${TABLE} ORDER BY id`), [
          { id: 1, u: null },
          { id: 2, u: [2, 3] },
        ]);
        assert.deepEqual(
          await client.query(`SELECT CAST(u AS SET OF VARCHAR(20)) AS u FROM ${TABLE} ORDER BY id`),
          [{ u: ["1", "a"] }, { u: ["2", "3"] }],
        );
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.close();
      }
    });

    test("an unsupported element rejects and leaves the session usable", async () => {
      const client = collectionClient();
      try {
        for (const expression of ["CAST({X'0f'} AS SEQUENCE OF BLOB)"]) {
          await assert.rejects(
            () => client.query(`SELECT ${expression} AS c, 'after' AS t`),
            (error: Error) => {
              assert.ok(error instanceof QueryError);
              return true;
            },
          );
        }
        assert.deepEqual(await client.query("SELECT {1} AS c, 'after' AS t"), [
          { c: [1], t: "after" },
        ]);
      } finally {
        await client.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // SQL syntax error
  // -------------------------------------------------------------------------

  test("SQL syntax error throws QueryError", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      await assert.rejects(
        () => client.query("INVALID SQL STATEMENT"),
        (err: Error) => {
          assert.ok(err instanceof QueryError);
          return true;
        },
      );
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // System queries
  // -------------------------------------------------------------------------

  test("SELECT 1 + 1 works", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      const rows = await client.query("SELECT 1 + 1 AS result");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.result, 2);
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Query handle release (#108)
  // -------------------------------------------------------------------------

  describe("query handle release", () => {
    const TABLE = "integration_test_handles";
    const SELECT_ALL = `SELECT id, val FROM ${TABLE} ORDER BY id`;
    // Only the last row has a zero DATETIME, which has no JavaScript value. Ascending
    // order meets it in a FETCH reply, descending order in the first reply.
    const UNSUPPORTED_IN_FETCH = `SELECT id, zeroed FROM ${TABLE} ORDER BY id`;
    const UNSUPPORTED_IN_FIRST_REPLY = `SELECT id, zeroed FROM ${TABLE} ORDER BY id DESC`;
    const CAS_ER_SRV_HANDLE = -1006;

    /** Enough rows that the first response cannot carry them all. */
    const ROW_COUNT = 1000;

    interface Trace {
      adapter: NativeCubridAdapter;
      cas: CASConnection;
      sent: number[];
      handle: () => number;
    }

    /** Observe every request and let `tamper` replace the response decoded by the adapter. */
    async function open(
      tamper: (functionCode: number, response: Buffer) => Buffer,
    ): Promise<Trace> {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      const cas = (adapter as unknown as { cas: CASConnection }).cas;
      const sent: number[] = [];
      let handle = -1;

      const sendAndRecv = cas.sendAndRecv.bind(cas);
      cas.sendAndRecv = async (header, payload) => {
        sent.push(payload[0]!);
        const response = await sendAndRecv(header, payload);
        if (payload[0] === CASFunctionCode.PREPARE_AND_EXECUTE) {
          handle = response.readInt32BE(0);
        }
        return tamper(payload[0]!, response);
      };

      const sendAndRecvOnSession = cas.sendAndRecvOnSession.bind(cas);
      cas.sendAndRecvOnSession = async (generation, header, payload) => {
        const response = await sendAndRecvOnSession(generation, header, payload);
        if (response) {
          sent.push(payload[0]!);
        }
        return response && tamper(payload[0]!, response);
      };

      const releaseOnSession = cas.releaseOnSession.bind(cas);
      cas.releaseOnSession = async (generation, header, payload) => {
        const response = await releaseOnSession(generation, header, payload);
        if (response) {
          sent.push(payload[0]!);
        }
        return response;
      };

      return { adapter, cas, sent, handle: () => handle };
    }

    /** The server's verdict on `handle`, without the adapter or a reconnect in the way. */
    async function fetchCode(trace: Trace): Promise<number> {
      const { cas } = trace;
      const { header, payload } = writeFetch(trace.handle(), 0, 1, cas.casInfo);
      const response = await cas.sendAndRecvOnSession(cas.connectionGeneration, header, payload);
      assert.ok(response, "the session is still open");
      return response.readInt32BE(0) < 0 ? response.readInt32BE(4) : 0;
    }

    const count = (trace: Trace, functionCode: number): number =>
      trace.sent.filter((code) => code === functionCode).length;

    const truncateFetch = (functionCode: number, response: Buffer): Buffer =>
      functionCode === CASFunctionCode.FETCH ? response.subarray(0, 10) : response;

    const truncateExecute = (functionCode: number, response: Buffer): Buffer =>
      functionCode === CASFunctionCode.PREPARE_AND_EXECUTE ? response.subarray(0, 12) : response;

    test("creates a table large enough to need FETCH", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, val VARCHAR(40), zeroed DATETIME)`,
        );
        await adapter.beginTransaction();
        for (let id = 0; id < ROW_COUNT; id += 1) {
          await adapter.query(`INSERT INTO ${TABLE} (id, val) VALUES (${id}, 'row ${id}')`);
        }
        await adapter.query(
          `UPDATE ${TABLE} SET zeroed = DATETIME'0000-00-00 00:00:00' ` +
            `WHERE id = ${ROW_COUNT - 1}`,
        );
        await adapter.commit();

        const trace = await open((_code, response) => response);
        const rows = await trace.adapter.query(SELECT_ALL);
        assert.equal(rows.length, ROW_COUNT);
        assert.ok(count(trace, CASFunctionCode.FETCH) > 0);
        assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), 1);
        await trace.adapter.close();
      } finally {
        await adapter.close();
      }
    });

    test("releases the handle after an unsupported FETCH value inside a transaction", async () => {
      const trace = await open((_code, response) => response);

      try {
        await trace.adapter.beginTransaction();
        const generation = trace.cas.connectionGeneration;

        await assert.rejects(trace.adapter.query(UNSUPPORTED_IN_FETCH), QueryError);

        assert.ok(count(trace, CASFunctionCode.FETCH) > 0);
        assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), 1);
        assert.equal(trace.cas.connectionGeneration, generation);
        assert.equal(await fetchCode(trace), CAS_ER_SRV_HANDLE);
        await trace.adapter.rollback();
      } finally {
        await trace.adapter.close();
      }
    });

    test("releases the handle on its own session after an autocommit FETCH failure", async () => {
      const trace = await open((_code, response) => response);

      try {
        const generation = trace.cas.connectionGeneration;

        await assert.rejects(trace.adapter.query(UNSUPPORTED_IN_FETCH), QueryError);

        assert.ok(count(trace, CASFunctionCode.FETCH) > 0);
        // The transaction has ended by now. A new session would accept the
        // release and close nothing, and fetchCode() below shows this one did.
        assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), 1);
        assert.equal(trace.cas.connectionGeneration, generation);
        assert.equal(await fetchCode(trace), CAS_ER_SRV_HANDLE);
      } finally {
        await trace.adapter.close();
      }
    });

    test("releases the handle when the first response holds an unsupported value", async () => {
      const trace = await open((_code, response) => response);

      try {
        await trace.adapter.beginTransaction();

        await assert.rejects(trace.adapter.query(UNSUPPORTED_IN_FIRST_REPLY), QueryError);

        assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), 1);
        assert.equal(await fetchCode(trace), CAS_ER_SRV_HANDLE);
        await trace.adapter.rollback();
      } finally {
        await trace.adapter.close();
      }
    });

    /** Whether a separate session sees the row, so only committed work counts. */
    async function rowCommitted(id: number): Promise<boolean> {
      const observer = new NativeCubridAdapter(TEST_CONFIG);
      try {
        return (await observer.query(`SELECT id FROM ${TABLE} WHERE id = ${id}`)).length === 1;
      } finally {
        await observer.close();
      }
    }

    for (const [where, tamper] of [
      ["FETCH", truncateFetch],
      ["first", truncateExecute],
    ] as const) {
      test(`a malformed ${where} reply drops the session and the server undoes its work`, async () => {
        const id = ROW_COUNT + (where === "FETCH" ? 1 : 2);
        let armed = false;
        const trace = await open((code, response) => (armed ? tamper(code, response) : response));

        try {
          await trace.adapter.beginTransaction();
          await trace.adapter.query(`INSERT INTO ${TABLE} (id, val) VALUES (${id}, 'lost')`);
          const closesBefore = count(trace, CASFunctionCode.CLOSE_REQ_HANDLE);
          armed = true;

          await assert.rejects(trace.adapter.query(SELECT_ALL), QueryError);

          assert.equal(trace.cas.isConnected, false);
          assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), closesBefore);

          // A later commit must not report success for work the server dropped.
          armed = false;
          await assert.rejects(trace.adapter.commit(), TransactionError);
          assert.equal(await rowCommitted(id), false);

          // That rejected commit acknowledged the loss, so autocommit work resumes.
          const rows = await trace.adapter.query("SELECT 1 + 1 AS result");
          assert.equal(rows[0]!.result, 2);
        } finally {
          await trace.adapter.close();
        }
      });
    }

    test("attempts no release on a socket lost during FETCH, then recovers", async () => {
      const trace = await open((_code, response) => response);
      const internals = trace.cas as unknown as { socket: { destroy(): void } };
      const sendAndRecvOnSession = trace.cas.sendAndRecvOnSession;
      trace.cas.sendAndRecvOnSession = async (generation, header, payload) => {
        if (payload[0] === CASFunctionCode.FETCH) {
          internals.socket.destroy();
        }
        return sendAndRecvOnSession(generation, header, payload);
      };

      try {
        await assert.rejects(trace.adapter.query(SELECT_ALL), QueryError);

        assert.equal(trace.cas.isConnected, false);
        assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), 0);

        const rows = await trace.adapter.query("SELECT 1 + 1 AS result");
        assert.equal(rows[0]!.result, 2);
      } finally {
        await trace.adapter.close();
      }
    });

    test("does not open a session just to close a handle", async () => {
      const trace = await open((_code, response) => response);

      try {
        const before = trace.cas.connectionGeneration;
        await trace.adapter.query("SELECT 1 + 1 AS result");

        assert.equal(trace.cas.connectionGeneration, before);
      } finally {
        await trace.adapter.close();
      }
    });

    test("drops the table", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await adapter.close();
    });
  });

  // -------------------------------------------------------------------------
  // Overlapping query lifecycles on one connection (#114)
  // -------------------------------------------------------------------------

  describe("overlapping query lifecycles on one connection", () => {
    const TABLE = "integration_test_concurrent";
    const WRITES = "integration_test_concurrent_writes";
    const GROUPS = 6;
    /** With PADDING, too much data for the first reply, whose limit is bytes rather than rows. */
    const ROWS_PER_GROUP = 350;
    const PADDING = "x".repeat(800);
    const ROUNDS = Number(process.env.CUBRID_CONCURRENCY_ROUNDS ?? 3);

    const selectGroup = (group: number): string =>
      `SELECT id, grp, pad FROM ${TABLE} WHERE grp = ${group} ORDER BY id`;

    function assertOwnRows(rows: unknown[], group: number): void {
      const expected = Array.from({ length: ROWS_PER_GROUP }, (_unused, index) => ({
        id: group * ROWS_PER_GROUP + index,
        grp: group,
        pad: PADDING,
      }));
      assert.deepEqual(rows, expected);
    }

    /** A client whose connections count every FETCH they send. */
    function tracedClient(): { client: ReturnType<typeof createClient>; fetches: () => number } {
      let fetches = 0;
      const client = createClient({
        ...TEST_CONFIG,
        connectionFactory: async (config) => {
          const adapter = new NativeCubridAdapter(config);
          await adapter.connect();
          const cas = (adapter as unknown as { cas: CASConnection }).cas;
          const sendAndRecvOnSession = cas.sendAndRecvOnSession.bind(cas);
          cas.sendAndRecvOnSession = (generation, header, payload) => {
            fetches += payload[0] === CASFunctionCode.FETCH ? 1 : 0;
            return sendAndRecvOnSession(generation, header, payload);
          };
          return adapter;
        },
      });
      return { client, fetches: () => fetches };
    }

    test("creates tables whose rows need FETCH", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query(`DROP TABLE IF EXISTS ${WRITES}`);
        await adapter.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, grp INT, pad VARCHAR(1000))`,
        );
        await adapter.query(`CREATE TABLE ${WRITES} (id INT)`);
        await adapter.beginTransaction();
        for (let group = 0; group < GROUPS; group += 1) {
          for (let index = 0; index < ROWS_PER_GROUP; index += 1) {
            const id = group * ROWS_PER_GROUP + index;
            await adapter.query(`INSERT INTO ${TABLE} VALUES (${id}, ${group}, '${PADDING}')`);
          }
        }
        await adapter.commit();
      } finally {
        await adapter.close();
      }
    });

    test("Promise.all SELECTs return exactly their own rows in every round", async () => {
      const { client, fetches } = tracedClient();

      try {
        for (let round = 0; round < ROUNDS; round += 1) {
          const groups = Array.from({ length: GROUPS }, (_unused, group) => group);
          const results = await Promise.all(
            groups.map((group) => client.query(selectGroup(group))),
          );
          for (const group of groups) assertOwnRows(results[group]!, group);
        }
        assert.ok(fetches() > 0, "the test proves nothing unless these rows needed FETCH");
      } finally {
        await client.close();
      }
    });

    test("parameterized Promise.all SELECTs return exactly their own rows", async () => {
      const { client, fetches } = tracedClient();

      try {
        const groups = [0, 1, 2];
        const results = await Promise.all(
          groups.map((group) =>
            client.query(`SELECT id, grp, pad FROM ${TABLE} WHERE grp = ? ORDER BY id`, [group]),
          ),
        );
        for (const group of groups) assertOwnRows(results[group]!, group);
        assert.ok(fetches() > 0);
      } finally {
        await client.close();
      }
    });

    test("DML, a failing statement and a ping leave running SELECTs intact", async () => {
      const { client, fetches } = tracedClient();

      try {
        for (let round = 0; round < ROUNDS; round += 1) {
          const [first, inserted, failed, version, last] = await Promise.allSettled([
            client.query(selectGroup(0)),
            client.query(`INSERT INTO ${WRITES} VALUES (${round})`),
            client.query("SELEC bogus"),
            client.ping(),
            client.query(selectGroup(1)),
          ]);

          assert.equal(first.status, "fulfilled");
          assertOwnRows(first.status === "fulfilled" ? first.value : [], 0);
          assert.equal(inserted.status, "fulfilled");
          assert.equal(failed.status, "rejected");
          assert.equal(version.status, "fulfilled");
          assert.equal(last.status, "fulfilled");
          assertOwnRows(last.status === "fulfilled" ? last.value : [], 1);
        }
        assert.ok(fetches() > 0);
      } finally {
        await client.close();
      }
    });

    test("Promise.all inside transaction() keeps rows and commits every statement", async () => {
      const { client, fetches } = tracedClient();

      try {
        await client.query(`DELETE FROM ${WRITES}`);
        const results = await client.transaction((tx) =>
          Promise.all([
            tx.query(selectGroup(0)),
            tx.query(`INSERT INTO ${WRITES} VALUES (1)`),
            tx.query(selectGroup(1)),
          ]),
        );

        assertOwnRows(results[0], 0);
        assertOwnRows(results[2], 1);
        assert.ok(fetches() > 0);
        const written = await client.query(`SELECT id FROM ${WRITES}`);
        assert.deepEqual(written, [{ id: 1 }]);
      } finally {
        await client.close();
      }
    });

    test("rollback issued alongside queries undoes their writes and cuts off no rows", async () => {
      const { client, fetches } = tracedClient();

      try {
        await client.query(`DELETE FROM ${WRITES}`);
        await client.beginTransaction();
        const [before, , , after] = await Promise.all([
          client.query(selectGroup(0)),
          client.query(`INSERT INTO ${WRITES} VALUES (2)`),
          client.rollback(),
          client.query(selectGroup(1)),
        ]);

        assertOwnRows(before, 0);
        assertOwnRows(after, 1);
        assert.ok(fetches() > 0);
        assert.deepEqual(await client.query(`SELECT id FROM ${WRITES}`), []);
      } finally {
        await client.close();
      }
    });

    test("commit issued alongside queries runs after them", async () => {
      const { client, fetches } = tracedClient();

      try {
        await client.query(`DELETE FROM ${WRITES}`);
        await client.beginTransaction();
        const [rows] = await Promise.all([
          client.query(selectGroup(2)),
          client.query(`INSERT INTO ${WRITES} VALUES (3)`),
          client.commit(),
        ]);

        assertOwnRows(rows, 2);
        assert.ok(fetches() > 0);
        assert.deepEqual(await client.query(`SELECT id FROM ${WRITES}`), [{ id: 3 }]);
      } finally {
        await client.close();
      }
    });

    test("close waits for a query that is still fetching", async () => {
      const { client, fetches } = tracedClient();

      await client.ping();
      const running = client.query(selectGroup(3));
      const closing = client.close();

      assertOwnRows(await running, 3);
      await closing;
      assert.ok(fetches() > 0);
    });

    // The tests below drive the server without the adapter's statement queue,
    // to record what a broker does with several live handles. If one starts to
    // fail on a new server version, the reason for serializing has changed.
    describe("what the server does with several live handles", () => {
      async function openSession(): Promise<{
        cas: CASConnection;
        execute: (sql: string, autoCommit: boolean) => Promise<PrepareAndExecuteResult>;
        fetch: (result: PrepareAndExecuteResult, position: number) => Promise<FetchResult>;
      }> {
        const cas = new CASConnection(TEST_CONFIG);
        await cas.connect();
        const generation = cas.connectionGeneration;

        // sendAndRecvOnSession() because sendAndRecv() would send CHECK_CAS once
        // CAS_INFO reports the transaction ended, which is the moment of interest.
        const exchange = async (request: { header: Buffer; payload: Buffer }): Promise<Buffer> => {
          const response = await cas.sendAndRecvOnSession(
            generation,
            request.header,
            request.payload,
          );
          assert.ok(response, "the session must stay open");
          return response;
        };

        return {
          cas,
          execute: async (sql, autoCommit) =>
            parsePrepareAndExecute(
              await exchange(writePrepareAndExecute(sql, autoCommit, cas.casInfo)),
              cas.protoVersion,
            ),
          fetch: async (result, position) =>
            parseFetch(
              await exchange(writeFetch(result.queryHandle, position, 100, cas.casInfo)),
              result.columns,
            ),
        };
      }

      test("handles of an open transaction interleave FETCHes safely", async () => {
        const { cas, execute, fetch } = await openSession();

        try {
          const groups = [0, 1, 2];
          const results: PrepareAndExecuteResult[] = [];
          for (const group of groups) {
            results.push(await execute(selectGroup(group), false));
          }

          const handles = new Set(results.map((result) => result.queryHandle));
          assert.equal(handles.size, groups.length);
          const rows = results.map((result) => [...result.rows]);
          assert.ok(
            rows.every((own) => own.length < ROWS_PER_GROUP),
            "FETCH must be needed",
          );

          while (rows.some((own) => own.length < ROWS_PER_GROUP)) {
            for (const group of groups) {
              if (rows[group]!.length < ROWS_PER_GROUP) {
                const page = await fetch(results[group]!, rows[group]!.length);
                rows[group]!.push(...page.rows);
              }
            }
          }

          for (const group of groups) assertOwnRows(rows[group]!, group);
        } finally {
          await cas.close();
        }
      });

      test("an autocommit SELECT reaching its last row closes other live handles", async () => {
        const { cas, execute, fetch } = await openSession();

        try {
          const survivor = await execute(selectGroup(0), true);
          const finisher = await execute(selectGroup(1), true);

          let position = finisher.rows.length;
          while (position < ROWS_PER_GROUP) {
            position += (await fetch(finisher, position)).tupleCount;
          }

          await assert.rejects(fetch(survivor, survivor.rows.length), /\(-1012\)/);
        } finally {
          await cas.close();
        }
      });

      test("an autocommit INSERT closes other live handles", async () => {
        const { cas, execute, fetch } = await openSession();

        try {
          const survivor = await execute(selectGroup(0), true);
          await execute(`INSERT INTO ${WRITES} VALUES (4)`, true);

          await assert.rejects(fetch(survivor, survivor.rows.length), /\(-1012\)/);
        } finally {
          await cas.close();
        }
      });

      test("a failing autocommit statement closes other live handles", async () => {
        const { cas, execute, fetch } = await openSession();

        try {
          const survivor = await execute(selectGroup(0), true);
          await assert.rejects(execute("SELEC bogus", true), /\(-493\)/);

          await assert.rejects(fetch(survivor, survivor.rows.length), /\(-1012\)/);
        } finally {
          await cas.close();
        }
      });

      test("a ping closes other live handles", async () => {
        const { cas, execute, fetch } = await openSession();

        try {
          const survivor = await execute(selectGroup(0), true);
          await cas.ping(false);

          await assert.rejects(fetch(survivor, survivor.rows.length), /\(-1012\)/);
        } finally {
          await cas.close();
        }
      });

      test("a handle number means another result on a newer session", async () => {
        const first = await openSession();
        const second = await openSession();

        try {
          const stale = await first.execute(selectGroup(0), true);
          const other = await second.execute(selectGroup(1), true);
          assert.equal(stale.queryHandle, other.queryHandle);

          const page = await second.fetch(stale, stale.rows.length);
          assert.ok(page.rows.length > 0);
          assert.ok(page.rows.every((row) => row.grp === 1));
        } finally {
          await first.cas.close();
          await second.cas.close();
        }
      });
    });

    test("drops the tables", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await adapter.query(`DROP TABLE IF EXISTS ${WRITES}`);
      await adapter.close();
    });
  });

  // -------------------------------------------------------------------------
  // Structured server errors: each of these failures really happens on the server
  // -------------------------------------------------------------------------

  describe("autocommit statements on one session", () => {
    const TABLE = "cc_keep_session";

    function casOf(adapter: NativeCubridAdapter): CASConnection {
      return (adapter as unknown as { cas: CASConnection }).cas;
    }

    test("consecutive autocommit statements share one session and its state", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      const cas = casOf(adapter);
      const generation = cas.connectionGeneration;
      const sessionId = cas.sessionId;

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query("SET @cc_keep_session = 171");
        await adapter.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY)`);
        await adapter.query(`INSERT INTO ${TABLE} VALUES (1)`);
        await assert.rejects(adapter.query(`INSERT INTO ${TABLE} VALUES (1)`), ConstraintError);
        await adapter.query(`UPDATE ${TABLE} SET id = 2`);
        await adapter.ping();
        assert.deepEqual(await adapter.query(`SELECT id FROM ${TABLE}`), [{ id: 2 }]);
        await adapter.beginTransaction();
        await adapter.query(`DELETE FROM ${TABLE}`);
        await adapter.commit();
        assert.deepEqual(await adapter.query(`SELECT id FROM ${TABLE}`), []);

        // A variable is lost with its session, so this shows the server agrees.
        assert.deepEqual(await adapter.query("SELECT CAST(@cc_keep_session AS INT) AS kept"), [
          { kept: 171 },
        ]);
        assert.equal(cas.connectionGeneration, generation);
        assert.equal(cas.sessionId, sessionId);
      } finally {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
        await adapter.close();
      }
    });

    test("a large autocommit SELECT and the statements after it share one session", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      const cas = casOf(adapter);
      const generation = cas.connectionGeneration;

      try {
        await adapter.query("SELECT 1 FROM db_root");
        const rows = await adapter.query(
          "SELECT a.class_name FROM db_class a, db_class b LIMIT 500",
        );
        assert.equal(rows.length, 500);
        await adapter.query("SELECT 1 FROM db_root");
        await adapter.query("SELECT 1 FROM db_root");
        assert.equal(cas.connectionGeneration, generation);
      } finally {
        await adapter.close();
      }
    });

    test("a lock timeout set in autocommit applies to a later transaction", async () => {
      const holder = new NativeCubridAdapter(TEST_CONFIG);
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await holder.connect();
      await adapter.connect();
      let release: NodeJS.Timeout | undefined;

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, n INT)`);
        await adapter.query(`INSERT INTO ${TABLE} VALUES (1, 0)`);

        await holder.beginTransaction();
        await holder.query(`UPDATE ${TABLE} SET n = 1 WHERE id = 1`);

        await adapter.query("SET TRANSACTION LOCK TIMEOUT 1");
        await adapter.beginTransaction();

        // The lock is freed in time for a statement that ignored the setting to
        // finish, so the test ends either way and that statement fails it.
        release = setTimeout(() => void holder.rollback(), 6000);
        await assert.rejects(
          adapter.query(`UPDATE ${TABLE} SET n = 2 WHERE id = 1`),
          LockTimeoutError,
        );
      } finally {
        clearTimeout(release);
        await adapter.rollback().catch(() => {});
        await holder.rollback().catch(() => {});
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
        await adapter.close();
        await holder.close();
      }
    });

    test("execute() on a kept session never reports a value left by an earlier statement", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      const cas = casOf(adapter);
      const keyed = `${TABLE}_keyed`;
      const plain = `${TABLE}_plain`;
      const insertPlain = `INSERT INTO ${plain} VALUES (1)`;
      const insertKeyed = `INSERT INTO ${keyed} (n) VALUES (1)`;

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${keyed}`);
        await adapter.query(`DROP TABLE IF EXISTS ${plain}`);
        await adapter.query(
          `CREATE TABLE ${keyed} (id INT AUTO_INCREMENT(100, 1) PRIMARY KEY, n INT)`,
        );
        await adapter.query(`CREATE TABLE ${plain} (n INT)`);
        const generation = cas.connectionGeneration;

        assert.deepEqual(await adapter.execute(insertKeyed), {
          affectedRows: 1,
          lastInsertId: 100,
        });
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });

        await adapter.query(insertKeyed);
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });

        await adapter.beginTransaction();
        assert.deepEqual(await adapter.execute(insertKeyed), {
          affectedRows: 1,
          lastInsertId: 102,
        });
        await adapter.rollback();
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });

        await adapter.beginTransaction();
        assert.deepEqual(await adapter.execute(insertKeyed), {
          affectedRows: 1,
          lastInsertId: 103,
        });
        await adapter.commit();
        await adapter.beginTransaction();
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });
        await adapter.commit();

        await assert.rejects(
          adapter.execute(`INSERT INTO ${keyed} (id, n) VALUES (103, 1)`),
          ConstraintError,
        );
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });

        await adapter.query(`REPLACE INTO ${keyed} (n) VALUES (1)`);
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });
        assert.deepEqual(await adapter.execute(insertKeyed), {
          affectedRows: 1,
          lastInsertId: 105,
        });

        assert.equal(cas.connectionGeneration, generation);
      } finally {
        await adapter.rollback().catch(() => {});
        await adapter.query(`DROP TABLE IF EXISTS ${keyed}`).catch(() => {});
        await adapter.query(`DROP TABLE IF EXISTS ${plain}`).catch(() => {});
        await adapter.close();
      }
    });

    test("a session cut after an autocommit statement is replaced without running SQL twice", async () => {
      // A relay stands in for a CAS closing its socket, which a test cannot ask
      // of a shared broker.
      const sockets = new Set<Socket>();
      const relay = createServer((client) => {
        const upstream = netConnect(TEST_CONFIG.port, TEST_CONFIG.host);
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
        }
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.pipe(upstream).pipe(client);
      });
      await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
      const { port } = relay.address() as { port: number };
      const adapter = new NativeCubridAdapter({ ...TEST_CONFIG, port });
      const observer = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await adapter.connect();
        await observer.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await observer.query(`CREATE TABLE ${TABLE} (id INT AUTO_INCREMENT PRIMARY KEY, n INT)`);

        const cas = casOf(adapter);
        const generation = cas.connectionGeneration;
        await adapter.query(`INSERT INTO ${TABLE} (n) VALUES (1)`);
        await adapter.query(`INSERT INTO ${TABLE} (n) VALUES (2)`);
        assert.equal(cas.connectionGeneration, generation);

        for (const socket of sockets) {
          socket.destroy();
        }
        await adapter.query(`INSERT INTO ${TABLE} (n) VALUES (3)`);

        assert.equal(cas.connectionGeneration, generation + 1);
        assert.deepEqual(await observer.query(`SELECT n FROM ${TABLE} ORDER BY n`), [
          { n: 1 },
          { n: 2 },
          { n: 3 },
        ]);
      } finally {
        await observer.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
        await observer.close();
        await adapter.close();
        relay.close();
      }
    });
  });

  describe("isolation level and lock timeout options", () => {
    const TABLE = "cc_isolation";
    type Runner = Pick<TransactionClient, "query">;

    function casOf(adapter: NativeCubridAdapter): CASConnection {
      return (adapter as unknown as { cas: CASConnection }).cas;
    }

    /** What the server says. Each read is a statement, so a transaction's snapshot starts here. */
    async function serverSettings(runner: Runner): Promise<{ level: number; timeout: number }> {
      await runner.query("GET TRANSACTION ISOLATION LEVEL TO cc_level");
      await runner.query("GET TRANSACTION LOCK TIMEOUT TO cc_timeout");
      // LEVEL is a reserved word, so the aliases avoid it.
      const rows = await runner.query<{ lvl: number; wait_s: number }>(
        "SELECT cc_level AS lvl, cc_timeout AS wait_s",
      );
      return { level: rows[0]!.lvl, timeout: rows[0]!.wait_s };
    }

    async function withTable(
      rows: string,
      run: (observer: NativeCubridAdapter) => Promise<void>,
    ): Promise<void> {
      const observer = new NativeCubridAdapter(TEST_CONFIG);
      try {
        await observer.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await observer.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, v INT)`);
        await observer.query(`INSERT INTO ${TABLE} VALUES ${rows}`);
        await run(observer);
      } finally {
        await observer.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
        await observer.close();
      }
    }

    /** A relay stands in for a CAS closing its socket, which a test cannot ask of a shared broker. */
    async function withRelay(run: (port: number, cut: () => void) => Promise<void>): Promise<void> {
      const sockets = new Set<Socket>();
      const relay = createServer((client) => {
        const upstream = netConnect(TEST_CONFIG.port, TEST_CONFIG.host);
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
        }
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.pipe(upstream).pipe(client);
      });
      await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
      const { port } = relay.address() as { port: number };

      try {
        await run(port, () => {
          for (const socket of sockets) {
            socket.destroy();
          }
        });
      } finally {
        relay.close();
      }
    }

    const LEVELS = [
      { isolationLevel: "read committed", code: 4, seesConcurrentCommit: true },
      { isolationLevel: "repeatable read", code: 5, seesConcurrentCommit: false },
      { isolationLevel: "serializable", code: 6, seesConcurrentCommit: false },
    ] as const;

    for (const { isolationLevel, code, seesConcurrentCommit } of LEVELS) {
      // `read committed` is the server's default, so each test also runs a client set
      // to another level: a setting that was ignored would show there.
      const other = code === 4 ? "serializable" : "read committed";
      const otherCode = code === 4 ? 6 : 4;

      test(`${isolationLevel} reads back as ${code} from the client and from transaction()`, async () => {
        const client = createClient({ ...TEST_CONFIG, isolationLevel });
        const mixed = createClient({ ...TEST_CONFIG, isolationLevel: other });

        try {
          assert.equal((await serverSettings(client)).level, code);
          assert.equal(
            await client.transaction(async (tx) => (await serverSettings(tx)).level),
            code,
          );
          assert.equal((await serverSettings(mixed)).level, otherCode);
          assert.equal(
            await mixed.transaction(async (tx) => (await serverSettings(tx)).level, {
              isolationLevel,
            }),
            code,
          );
        } finally {
          await client.close();
          await mixed.close();
        }
      });

      test(`${isolationLevel} ${seesConcurrentCommit ? "sees" : "hides"} a concurrent commit`, async () => {
        const client = createClient({ ...TEST_CONFIG, isolationLevel: other });

        try {
          assert.equal((await serverSettings(client)).level, otherCode);
          await withTable("(1, 0)", async (observer) => {
            await client.transaction(
              async (tx) => {
                assert.equal((await serverSettings(tx)).level, code);
                const first = await tx.query(
                  `SELECT v, (SELECT COUNT(*) FROM ${TABLE}) AS n FROM ${TABLE} WHERE id = 1`,
                );
                await observer.query(`UPDATE ${TABLE} SET v = 1 WHERE id = 1`);
                await observer.query(`INSERT INTO ${TABLE} VALUES (2, 0)`);
                const second = await tx.query(
                  `SELECT v, (SELECT COUNT(*) FROM ${TABLE}) AS n FROM ${TABLE} WHERE id = 1`,
                );

                assert.equal(first[0]!.v, 0);
                assert.equal(second[0]!.v, seesConcurrentCommit ? 1 : 0);
                assert.equal(Number(second[0]!.n), seesConcurrentCommit ? 2 : 1);
              },
              { isolationLevel },
            );
          });
        } finally {
          await client.close();
        }
      });
    }

    for (const { isolationLevel, code } of LEVELS.slice(1)) {
      test(`${isolationLevel} reports -1158 for a row changed since its snapshot and stays open`, async () => {
        const client = createClient(TEST_CONFIG);

        try {
          await withTable("(1, 0), (2, 0)", async (observer) => {
            await client.transaction(
              async (tx) => {
                assert.equal((await serverSettings(tx)).level, code);
                await tx.query(`SELECT v FROM ${TABLE}`);
                await observer.query(`UPDATE ${TABLE} SET v = 5 WHERE id = 1`);

                await assert.rejects(
                  tx.query(`UPDATE ${TABLE} SET v = 6 WHERE id = 1`),
                  (error: TransactionError) => {
                    assert.ok(error instanceof TransactionError);
                    assert.equal(error.code, -1158);
                    assert.equal(error.kind, undefined);
                    return true;
                  },
                );

                // Only that statement failed, so the transaction can go on and commit.
                await tx.query(`UPDATE ${TABLE} SET v = 7 WHERE id = 2`);
              },
              { isolationLevel },
            );

            assert.deepEqual(await observer.query(`SELECT id, v FROM ${TABLE} ORDER BY id`), [
              { id: 1, v: 5 },
              { id: 2, v: 7 },
            ]);
          });
        } finally {
          await client.close();
        }
      });
    }

    test("serializable still lets two transactions commit a write skew", async () => {
      const client = createClient({ ...TEST_CONFIG, isolationLevel: "serializable" });

      try {
        await withTable("(1, 0), (2, 0)", async (observer) => {
          // Each transaction checks a total of 0 and changes a different row, so a
          // truly serializable schedule could not commit both.
          const guarded = (id: number) =>
            `UPDATE ${TABLE} SET v = 1 WHERE id = ${id} AND (SELECT SUM(v) FROM ${TABLE}) = 0`;

          await client.transaction(async (first) => {
            assert.equal((await serverSettings(first)).level, 6);
            await first.query(`SELECT v FROM ${TABLE}`);
            await client.transaction(async (second) => {
              await second.query(`SELECT v FROM ${TABLE}`);
              await first.query(guarded(1));
              await second.query(guarded(2));
            });
          });

          assert.deepEqual(await observer.query(`SELECT id, v FROM ${TABLE} ORDER BY id`), [
            { id: 1, v: 1 },
            { id: 2, v: 1 },
          ]);
        });
      } finally {
        await client.close();
      }
    });

    test("a transaction's options end with it and leave the shared connection alone", async () => {
      const client = createClient({ ...TEST_CONFIG, lockTimeout: 2000 });

      try {
        const inside = await client.transaction(async (tx) => serverSettings(tx), {
          isolationLevel: "serializable",
          lockTimeout: 0,
        });
        assert.deepEqual(inside, { level: 6, timeout: 0 });
        assert.deepEqual(await serverSettings(client), { level: 4, timeout: 2 });
        assert.deepEqual(await client.transaction(async (tx) => serverSettings(tx)), {
          level: 4,
          timeout: 2,
        });
      } finally {
        await client.close();
      }
    });

    // A limit that never reached the server would wait for the lock forever.
    test("lockTimeout limits a blocked statement in milliseconds, and 0 does not wait", {
      timeout: 30_000,
    }, async () => {
      const client = createClient(TEST_CONFIG);

      try {
        await withTable("(1, 0)", async (observer) => {
          await observer.beginTransaction();
          await observer.query(`UPDATE ${TABLE} SET v = 1 WHERE id = 1`);

          try {
            for (const [lockTimeout, atLeast, under] of [
              [0, 0, 150],
              [300, 280, 3000],
            ] as const) {
              await client.transaction(
                async (tx) => {
                  const start = performance.now();
                  await assert.rejects(
                    tx.query(`UPDATE ${TABLE} SET v = 2 WHERE id = 1`),
                    (error: TransactionError) => error.kind === "lock-timeout",
                  );
                  const elapsed = performance.now() - start;
                  assert.ok(elapsed >= atLeast && elapsed < under, `waited ${elapsed} ms`);
                },
                { lockTimeout },
              );
            }
          } finally {
            await observer.rollback();
          }
        });
      } finally {
        await client.close();
      }
    });

    test("lockTimeout -1 overrides a finite client setting with an unlimited wait", async () => {
      const client = createClient({ ...TEST_CONFIG, lockTimeout: 1000 });

      try {
        // -1 is also the server's default, so the finite setting must show first.
        assert.equal((await serverSettings(client)).timeout, 1);
        assert.equal(
          (await client.transaction(async (tx) => serverSettings(tx), { lockTimeout: -1 })).timeout,
          -1,
        );
      } finally {
        await client.close();
      }
    });

    test("a replaced session gets the settings back before its first statement", async () => {
      await withRelay(async (port, cut) => {
        const adapter = new NativeCubridAdapter({
          ...TEST_CONFIG,
          port,
          isolationLevel: "repeatable read",
          lockTimeout: 1500,
        });

        try {
          await adapter.connect();
          const cas = casOf(adapter);
          const generation = cas.connectionGeneration;
          assert.deepEqual(await serverSettings(adapter), { level: 5, timeout: 1.5 });

          cut();
          assert.deepEqual(await serverSettings(adapter), { level: 5, timeout: 1.5 });
          assert.equal(cas.connectionGeneration, generation + 1);
        } finally {
          await adapter.close();
        }
      });
    });

    test("a manual transaction after a replaced session runs under the restored settings", async () => {
      await withTable("(1, 0)", async (observer) => {
        await withRelay(async (port, cut) => {
          const adapter = new NativeCubridAdapter({
            ...TEST_CONFIG,
            port,
            isolationLevel: "repeatable read",
          });

          try {
            await adapter.query("SELECT 1 FROM db_root");
            const generation = casOf(adapter).connectionGeneration;
            cut();

            await adapter.beginTransaction();
            const first = await adapter.query(`SELECT v FROM ${TABLE}`);
            await observer.query(`UPDATE ${TABLE} SET v = 1 WHERE id = 1`);

            assert.deepEqual(await adapter.query(`SELECT v FROM ${TABLE}`), first);
            assert.equal(casOf(adapter).connectionGeneration, generation + 1);
            await adapter.rollback();
          } finally {
            await adapter.close();
          }
        });
      });
    });

    test("autocommit carries on across a replaced session that gets its settings back", async () => {
      await withTable("(1, 0)", async (observer) => {
        await withRelay(async (port, cut) => {
          const adapter = new NativeCubridAdapter({ ...TEST_CONFIG, port, lockTimeout: 1000 });

          try {
            await adapter.query(`UPDATE ${TABLE} SET v = 1 WHERE id = 1`);
            cut();
            await adapter.query(`UPDATE ${TABLE} SET v = 2 WHERE id = 1`);

            // The observer reads committed work only, so nothing here needed a commit().
            assert.deepEqual(await observer.query(`SELECT v FROM ${TABLE}`), [{ v: 2 }]);
            assert.equal((await serverSettings(adapter)).timeout, 1);
          } finally {
            await adapter.close();
          }
        });
      });
    });

    test("setTransactionOptions changes the open session and is refused inside a transaction", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await adapter.connect();
        await adapter.setTransactionOptions({ isolationLevel: "serializable" });
        assert.equal((await serverSettings(adapter)).level, 6);

        await adapter.beginTransaction();
        await assert.rejects(
          adapter.setTransactionOptions({ isolationLevel: "read committed" }),
          /inside a transaction/,
        );
        assert.equal((await serverSettings(adapter)).level, 6);
        await adapter.rollback();
      } finally {
        await adapter.close();
      }
    });
  });

  describe("server error details", () => {
    const PARENT = "cc_err_parent";
    const CHILD = "cc_err_child";
    const ROWS = "cc_err_rows";

    /** Resolves with the rejection, and fails the test if `run` succeeds. */
    async function failure<E extends Error = QueryError>(run: () => Promise<unknown>): Promise<E> {
      try {
        await run();
      } catch (error) {
        return error as E;
      }
      throw new Error("expected the statement to fail");
    }

    async function withAdapters(
      run: (first: NativeCubridAdapter, second: NativeCubridAdapter) => Promise<void>,
    ): Promise<void> {
      const first = new NativeCubridAdapter(TEST_CONFIG);
      const second = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await first.connect();
        await second.connect();
        await run(first, second);
      } finally {
        await first.rollback().catch(() => {});
        await second.rollback().catch(() => {});
        await first.close();
        await second.close();
      }
    }

    /**
     * Makes each adapter wait for the row the other has already locked.
     */
    async function deadlock(
      first: NativeCubridAdapter,
      second: NativeCubridAdapter,
      lockTimeoutSeconds?: number,
      beforeDeadlock: () => Promise<unknown> = async () => {},
    ): Promise<PromiseSettledResult<unknown>[]> {
      await first.beginTransaction();
      await second.beginTransaction();

      if (lockTimeoutSeconds !== undefined) {
        await first.query(`SET TRANSACTION LOCK TIMEOUT ${lockTimeoutSeconds}`);
        await second.query(`SET TRANSACTION LOCK TIMEOUT ${lockTimeoutSeconds}`);
      }

      await beforeDeadlock();
      await first.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`);
      await second.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 2`);

      return Promise.allSettled([
        first.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 2`),
        new Promise((resolve) => setTimeout(resolve, 200)).then(() =>
          second.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`),
        ),
      ]);
    }

    const rejections = (results: PromiseSettledResult<unknown>[]): QueryError[] =>
      results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));

    // Hooks rather than tests, so a run filtered by --test-name-pattern still has the tables.
    before(async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${CHILD}`);
        await adapter.query(`DROP TABLE IF EXISTS ${PARENT}`);
        await adapter.query(`DROP TABLE IF EXISTS ${ROWS}`);
        await adapter.query(`CREATE TABLE ${PARENT} (id INT PRIMARY KEY)`);
        await adapter.query(
          `CREATE TABLE ${CHILD} (id INT PRIMARY KEY, parent_id INT, ` +
            `FOREIGN KEY (parent_id) REFERENCES ${PARENT} (id))`,
        );
        await adapter.query(
          `CREATE TABLE ${ROWS} (id INT PRIMARY KEY, label VARCHAR(20) UNIQUE, n INT NOT NULL)`,
        );
        await adapter.query(`INSERT INTO ${PARENT} VALUES (1)`);
        await adapter.query(`INSERT INTO ${CHILD} VALUES (1, 1)`);
        await adapter.query(`INSERT INTO ${ROWS} VALUES (1, 'a', 1), (2, 'b', 2)`);
      } finally {
        await adapter.close();
      }
    });

    test("a duplicate primary key and a duplicate unique column report -670", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        for (const sql of [
          `INSERT INTO ${ROWS} VALUES (1, 'z', 1)`,
          `INSERT INTO ${ROWS} VALUES (9, 'a', 1)`,
          `UPDATE ${ROWS} SET label = 'a' WHERE id = 2`,
        ]) {
          const error = await failure(() => client.query(sql));

          assert.ok(error instanceof ConstraintError);
          assert.ok(error instanceof QueryError);
          assert.equal(error.name, "ConstraintError");
          assert.equal(error.code, -670);
          assert.equal(error.origin, "server");
          assert.equal(error.kind, "unique-violation");
          assert.equal(error.sqlState, undefined);
        }
      } finally {
        await client.close();
      }
    });

    test("a syntax error reports -493", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const error = await failure(() => client.query("SELEC 1"));

        assert.ok(error instanceof SqlSyntaxError);
        assert.ok(error instanceof QueryError);
        assert.equal(error.code, -493);
        assert.equal(error.origin, "server");
        assert.equal(error.kind, "syntax");
      } finally {
        await client.close();
      }
    });

    test("an unknown table is a -493 syntax error, an unknown column a -494", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const table = await failure(() => client.query("SELECT * FROM cc_err_no_such_table"));
        assert.ok(table instanceof SqlSyntaxError);
        assert.equal(table.code, -493);

        const column = await failure(() => client.query(`SELECT nope FROM ${ROWS}`));
        assert.equal(column.constructor, QueryError);
        assert.equal(column.code, -494);
        assert.equal(column.kind, "semantic");
      } finally {
        await client.close();
      }
    });

    test("constraint violations report their own codes", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const notNull = await failure(() =>
          client.query(`INSERT INTO ${ROWS} VALUES (5, 'n', NULL)`),
        );
        assert.ok(notNull instanceof ConstraintError);
        assert.equal(notNull.code, -631);
        assert.equal(notNull.kind, "not-null-violation");

        const noParent = await failure(() => client.query(`INSERT INTO ${CHILD} VALUES (2, 99)`));
        assert.ok(noParent instanceof ConstraintError);
        assert.equal(noParent.code, -922);
        assert.equal(noParent.kind, "foreign-key-violation");

        const hasChild = await failure(() => client.query(`DELETE FROM ${PARENT} WHERE id = 1`));
        assert.ok(hasChild instanceof ConstraintError);
        assert.equal(hasChild.code, -924);
        assert.equal(hasChild.kind, "foreign-key-violation");

        const truncate = await failure(() => client.query(`TRUNCATE ${PARENT}`));
        assert.ok(truncate instanceof ConstraintError);
        assert.ok(truncate.code === -924 || truncate.code === -1284, `got ${truncate.code}`);
        assert.equal(truncate.kind, "foreign-key-violation");
      } finally {
        await client.close();
      }
    });

    test("a server code nobody classified still reaches the caller", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const error = await failure(() => client.query("SELECT CAST('x' AS INT)"));

        assert.equal(error.constructor, QueryError);
        assert.equal(error.code, -181);
        assert.equal(error.origin, "server");
        assert.equal(error.kind, undefined);
      } finally {
        await client.close();
      }
    });

    test("an undecodable value keeps its name and has no server details", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const error = await failure(() =>
          client.query("SELECT DATETIME'0000-00-00 00:00:00' AS zeroed"),
        );
        let current: unknown = error;
        while (current instanceof Error && current.name !== "UnsupportedValueError") {
          current = current.cause;
        }

        assert.ok(current instanceof Error);
        assert.equal(error.constructor, QueryError);
        assert.equal(error.code, undefined);
        assert.equal(error.origin, undefined);
        assert.equal(error.kind, undefined);

        const next = await failure(() => client.query("SELEC 1"));
        assert.ok(next instanceof SqlSyntaxError);
        assert.equal(next.code, -493);
      } finally {
        await client.close();
      }
    });

    test("a failure inside transaction() stays a TransactionError with the same details", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const error = await failure<TransactionError>(() =>
          client.transaction((tx) => tx.query(`INSERT INTO ${ROWS} VALUES (1, 'z', 1)`)),
        );

        assert.ok(error instanceof TransactionError);
        assert.equal(error.code, -670);
        assert.equal(error.kind, "unique-violation");
        assert.equal(error.origin, "server");
      } finally {
        await client.close();
      }
    });

    test("a wrong password and an unknown user report their own codes", async () => {
      const password = new NativeCubridAdapter({ ...TEST_CONFIG, password: "wrong" });
      const passwordError = await failure<ConnectionError>(() => password.connect());
      assert.ok(passwordError instanceof ConnectionError);
      assert.equal(passwordError.code, -171);
      assert.equal(passwordError.origin, "server");
      assert.equal(passwordError.kind, "authentication");
      await password.close().catch(() => {});

      const user = new NativeCubridAdapter({ ...TEST_CONFIG, user: "cc_err_no_such_user" });
      const userError = await failure<ConnectionError>(() => user.connect());
      assert.equal(userError.code, -165);
      assert.equal(userError.kind, "authentication");
      await user.close().catch(() => {});
    });

    test("a server lock timeout on a row is -75 and leaves the transaction open", async () => {
      await withAdapters(async (first, second) => {
        await first.beginTransaction();
        await first.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`);

        await second.beginTransaction();
        await second.query("SET TRANSACTION LOCK TIMEOUT 1");

        const error = await failure(() =>
          second.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`),
        );

        assert.ok(error instanceof LockTimeoutError);
        assert.ok(error instanceof QueryError);
        assert.ok(!(error instanceof ConnectionError));
        assert.equal(error.code, -75);
        assert.equal(error.origin, "server");
        assert.equal(error.kind, "lock-timeout");

        await second.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 2`);
      });
    });

    test("a server lock timeout on a table is -74", async () => {
      await withAdapters(async (first, second) => {
        await first.beginTransaction();
        await first.query(`ALTER TABLE ${ROWS} ADD COLUMN cc_err_extra INT`);

        await second.beginTransaction();
        await second.query("SET TRANSACTION LOCK TIMEOUT 1");

        const error = await failure(() => second.query(`SELECT * FROM ${ROWS}`));

        assert.ok(error instanceof LockTimeoutError);
        assert.equal(error.code, -74);
      });
    });

    test("the client's read timeout stays distinct from a server lock wait", async () => {
      const impatient = new NativeCubridAdapter({ ...TEST_CONFIG, readTimeout: 2000 });
      const holder = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await holder.beginTransaction();
        await holder.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`);
        await impatient.connect();
        await impatient.beginTransaction();

        const error = await failure<ReadTimeoutError>(() =>
          impatient.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`),
        );

        assert.ok(error instanceof ReadTimeoutError);
        assert.ok(!(error instanceof LockTimeoutError));
        assert.equal(error.kind, "read-timeout");
        assert.equal(error.code, undefined);
        assert.equal(error.origin, undefined);
      } finally {
        await holder.rollback().catch(() => {});
        await holder.close();
        await impatient.close().catch(() => {});
      }
    });

    test("a deadlock victim gets -72 and the other transaction proceeds", async () => {
      await withAdapters(async (first, second) => {
        const results = await deadlock(first, second);
        const failed = rejections(results);

        assert.equal(failed.length, 1);
        assert.ok(failed[0] instanceof DeadlockError);
        assert.ok(failed[0] instanceof QueryError);
        assert.equal(failed[0].code, -72);
        assert.equal(failed[0].origin, "server");
        assert.equal(failed[0].kind, "deadlock");
      });
    });

    test("under a finite lock timeout the deadlock victim gets -968", async () => {
      await withAdapters(async (first, second) => {
        const failed = rejections(await deadlock(first, second, 4));
        const codes = failed.map((error) => error.code).sort();

        // The survivor still waits for its own lock until its timeout expires.
        assert.deepEqual(codes, [-75, -968]);
        const victim = failed.find((error) => error.code === -968);
        assert.ok(victim instanceof DeadlockError);
        assert.equal(victim.kind, "deadlock");
      });
    });

    describe("after the server ended the transaction", () => {
      const FIRST_ROW = 201;
      const SECOND_ROW = 301;

      /** Each adapter writes a row, then they deadlock and one fails with `code`. */
      async function deadlockAfterWrites(
        first: NativeCubridAdapter,
        second: NativeCubridAdapter,
        code: number,
        lockTimeoutSeconds?: number,
      ) {
        const results = await deadlock(first, second, lockTimeoutSeconds, () =>
          Promise.all([
            first.query(`INSERT INTO ${ROWS} VALUES (${FIRST_ROW}, 'first', 0)`),
            second.query(`INSERT INTO ${ROWS} VALUES (${SECOND_ROW}, 'second', 0)`),
          ]),
        );
        const firstFailed = rejections(results.slice(0, 1)).some((error) => error.code === code);
        const secondFailed = rejections(results.slice(1)).some((error) => error.code === code);

        assert.ok(firstFailed !== secondFailed, `expected one ${code}`);
        return {
          victim: firstFailed ? first : second,
          survivor: firstFailed ? second : first,
          earlierRow: firstFailed ? FIRST_ROW : SECOND_ROW,
        };
      }

      async function committedRows(): Promise<number[]> {
        const reader = new NativeCubridAdapter(TEST_CONFIG);

        try {
          const rows = await reader.query<{ id: number }>(
            `SELECT id FROM ${ROWS} WHERE id > 200 ORDER BY id`,
          );
          return rows.map((row) => Number(row.id));
        } finally {
          await reader.close();
        }
      }

      async function removeRows(): Promise<void> {
        const cleaner = new NativeCubridAdapter(TEST_CONFIG);

        try {
          await cleaner.query(`DELETE FROM ${ROWS} WHERE id > 200`);
        } finally {
          await cleaner.close();
        }
      }

      async function assertFailsWithAbort(
        run: () => Promise<unknown>,
        type: new (...args: never[]) => Error,
      ): Promise<void> {
        const error = await failure<QueryError>(run);

        assert.ok(error instanceof type);
        assert.equal(error.code, -72);
        assert.equal(error.kind, "deadlock");
      }

      test("no statement commits alone after -72", async () => {
        await withAdapters(async (first, second) => {
          const { victim, survivor, earlierRow } = await deadlockAfterWrites(first, second, -72);

          await assertFailsWithAbort(
            () => victim.query(`INSERT INTO ${ROWS} VALUES (${earlierRow + 1}, 'later', 0)`),
            DeadlockError,
          );
          await assertFailsWithAbort(() => victim.commit(), TransactionError);
          await survivor.rollback();

          assert.deepEqual(await committedRows(), []);
        });
        await removeRows();
      });

      test("rollback() acknowledges -72 and the same adapter can retry the work", async () => {
        await withAdapters(async (first, second) => {
          const { victim, survivor, earlierRow } = await deadlockAfterWrites(first, second, -72);
          await assertFailsWithAbort(() => victim.query("SELECT 1 FROM db_root"), DeadlockError);

          await victim.rollback();
          await survivor.rollback();
          await victim.beginTransaction();
          await victim.query(`INSERT INTO ${ROWS} VALUES (${earlierRow}, 'retried', 0)`);
          await victim.commit();

          assert.deepEqual(await committedRows(), [earlierRow]);
        });
        await removeRows();
      });

      test("a transaction() callback that swallows -72 rejects and commits nothing", async () => {
        await withAdapters(async (first, second) => {
          let bothHoldLocks: () => void = () => undefined;
          let arrived = 0;
          const locksHeld = new Promise<void>((resolve) => {
            bothHoldLocks = resolve;
          });

          // Each callback writes a row, locks its own row, then asks for the other's.
          const contend = (adapter: NativeCubridAdapter, own: number, other: number, row: number) =>
            createClient({ ...TEST_CONFIG, connectionFactory: () => adapter }).transaction(
              async (tx) => {
                await tx.execute(`INSERT INTO ${ROWS} VALUES (${row}, 'row${row}', 0)`);
                await tx.execute(`UPDATE ${ROWS} SET n = n + 1 WHERE id = ${own}`);
                arrived += 1;
                if (arrived === 2) {
                  bothHoldLocks();
                }
                await locksHeld;
                await new Promise((resolve) => setTimeout(resolve, own === 1 ? 0 : 200));

                const updated = await tx
                  .execute(`UPDATE ${ROWS} SET n = n + 1 WHERE id = ${other}`)
                  .then(
                    () => true,
                    () => false,
                  );

                // The survivor gives its work back, so only the victim's outcome is tested.
                if (updated) {
                  await tx.rollback();
                }
              },
            );

          const results = await Promise.allSettled([
            contend(first, 1, 2, FIRST_ROW),
            contend(second, 2, 1, SECOND_ROW),
          ]);
          const failures = rejections(results);

          assert.equal(failures.length, 1);
          assert.ok(failures[0] instanceof TransactionError);
          assert.equal(failures[0].code, -72);
          assert.equal(failures[0].kind, "deadlock");
          assert.deepEqual(await committedRows(), []);
        });
        await removeRows();
      });

      test("-968 keeps the transaction, while a commit() rejected after -72 acknowledges it", async () => {
        // Each round has its own adapters because the lock timeout outlives a transaction.
        await withAdapters(async (first, second) => {
          const { victim, survivor, earlierRow } = await deadlockAfterWrites(
            first,
            second,
            -968,
            4,
          );

          await victim.query(`INSERT INTO ${ROWS} VALUES (${earlierRow + 1}, 'kept', 0)`);
          await victim.commit();
          await survivor.rollback();

          assert.deepEqual(await committedRows(), [earlierRow, earlierRow + 1]);
        });
        await removeRows();

        await withAdapters(async (first, second) => {
          const { victim, survivor, earlierRow } = await deadlockAfterWrites(first, second, -72);
          await assertFailsWithAbort(() => victim.commit(), TransactionError);
          await survivor.rollback();

          // Acknowledged, so this statement runs in autocommit and commits by itself.
          await victim.query(`INSERT INTO ${ROWS} VALUES (${earlierRow}, 'autocommit', 0)`);

          assert.deepEqual(await committedRows(), [earlierRow]);
        });
        await removeRows();
      });
    });

    after(async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${CHILD}`);
        await adapter.query(`DROP TABLE IF EXISTS ${PARENT}`);
        await adapter.query(`DROP TABLE IF EXISTS ${ROWS}`);
      } finally {
        await adapter.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // execute(): affected rows and last insert ID
  // -------------------------------------------------------------------------

  describe("schema introspection", () => {
    const PARENT = "cc_sch_parent";
    const CHILD = "cc_sch_child";
    const VIEW = "cc_sch_view";
    const ODD = "cc_sch Odd Table";
    const DUP = "cc_sch_dup";
    const USER_A = "cc_sch_ua";
    const USER_B = "cc_sch_ub";

    async function serverAtLeast(
      client: ReturnType<typeof createClient>,
      major: number,
      minor: number,
    ) {
      const [maj, min] = (await client.getServerVersion()).split(".").map(Number);
      return maj! > major || (maj === major && min! >= minor);
    }

    async function cleanup(client: ReturnType<typeof createClient>) {
      const owners = await serverAtLeast(client, 11, 2);
      for (const sql of [
        `DROP VIEW IF EXISTS ${VIEW}`,
        `DROP TABLE IF EXISTS ${CHILD}`,
        `DROP TABLE IF EXISTS ${PARENT}`,
        `DROP TABLE IF EXISTS "${ODD}"`,
        // Only 11.2 and later keep one table per owner; older servers own it by DBA.
        ...(owners
          ? [`DROP TABLE IF EXISTS ${USER_A}.${DUP}`, `DROP TABLE IF EXISTS ${USER_B}.${DUP}`]
          : [`DROP TABLE IF EXISTS ${DUP}`]),
      ]) {
        await client.query(sql);
      }
      for (const user of [USER_A, USER_B]) {
        const exists = await client.query("SELECT name FROM db_user WHERE name = ?", [
          user.toUpperCase(),
        ]);
        if (exists.length > 0) {
          await client.query(`DROP USER ${user}`);
        }
      }
    }

    test("create the fixtures", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        await cleanup(client);
        await client.query(`CREATE USER ${USER_A}`);
        await client.query(`CREATE USER ${USER_B}`);
        await client.query(
          `CREATE TABLE ${PARENT} (a INT, b INT, c VARCHAR(10) NOT NULL DEFAULT 'zz', ` +
            `n NUMERIC(8,3), d DATETIME DEFAULT SYS_DATETIME, s SET(INT), p VARCHAR(30), ` +
            `CONSTRAINT pk_cc_sch_parent PRIMARY KEY (b, a))`,
        );
        await client.query(`CREATE UNIQUE INDEX u_cc_sch_c ON ${PARENT} (c)`);
        await client.query(`CREATE INDEX i_cc_sch_ab ON ${PARENT} (a DESC, b)`);
        await client.query(`CREATE REVERSE INDEX r_cc_sch_n ON ${PARENT} (n)`);
        await client.query(`CREATE INDEX i_cc_sch_prefix ON ${PARENT} (p(5))`);
        await client.query(`CREATE INDEX i_cc_sch_lower ON ${PARENT} (LOWER(c))`);
        await client.query(`CREATE INDEX i_cc_sch_filter ON ${PARENT} (d) WHERE d IS NOT NULL`);
        await client.query(
          `CREATE TABLE ${CHILD} (id INT PRIMARY KEY, pa INT, pb INT, ` +
            `FOREIGN KEY fk_cc_sch_child (pb, pa) REFERENCES ${PARENT} (b, a))`,
        );
        await client.query(`CREATE VIEW ${VIEW} AS SELECT a FROM ${PARENT}`);
        await client.query(`CREATE TABLE "${ODD}" ("Odd Col" INT PRIMARY KEY)`);
        await client.query(`GRANT SELECT ON ${PARENT} TO ${USER_A}`);
      } finally {
        await client.close();
      }
    });

    test("getTables lists user tables and views with their owner, and no system classes", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const tables = await client.getTables();
        const byName = new Map(tables.map((table) => [table.name, table]));
        assert.deepEqual(byName.get(PARENT), { name: PARENT, schema: "DBA", type: "table" });
        assert.deepEqual(byName.get(VIEW), { name: VIEW, schema: "DBA", type: "view" });
        assert.equal(byName.get(ODD.toLowerCase())?.type, "table");
        assert.equal(byName.has("db_class"), false);
        assert.equal(byName.has("_db_class"), false);
        assert.deepEqual(await client.getTables({ schema: "nobody_owns_this" }), []);
        assert.ok(
          (await client.getTables({ schema: "dba" })).some((table) => table.name === PARENT),
        );
      } finally {
        await client.close();
      }
    });

    test("getColumns reports position, type, precision, scale, nullability and default", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const columns = await client.getColumns(PARENT);
        assert.deepEqual(
          columns.map((column) => [column.name, column.position, column.dataType, column.nullable]),
          [
            ["a", 1, "INTEGER", false],
            ["b", 2, "INTEGER", false],
            ["c", 3, "STRING", false],
            ["n", 4, "NUMERIC", true],
            ["d", 5, "DATETIME", true],
            ["s", 6, "SET", true],
            ["p", 7, "STRING", true],
          ],
        );
        assert.deepEqual(columns[2], {
          name: "c",
          position: 3,
          dataType: "STRING",
          precision: 10,
          scale: 0,
          nullable: false,
          defaultValue: "zz",
        });
        assert.equal(columns[3]?.precision, 8);
        assert.equal(columns[3]?.scale, 3);
        assert.equal(columns[0]?.defaultValue, null);
        assert.equal(columns[4]?.defaultValue, "SYS_DATETIME");
        assert.deepEqual(
          (await client.getColumns(VIEW)).map((column) => column.name),
          ["a"],
        );
      } finally {
        await client.close();
      }
    });

    test("table names match without regard to case, and a quoted name is given bare", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        assert.equal((await client.getColumns(PARENT.toUpperCase())).length, 7);
        assert.equal((await client.getColumns(PARENT, { schema: "Dba" })).length, 7);
        // CREATE TABLE "cc_sch Odd Table" stores the name and its column in lower case.
        assert.deepEqual(
          (await client.getColumns(ODD)).map((column) => column.name),
          ["odd col"],
        );
        assert.deepEqual(await client.getPrimaryKey(ODD), {
          name: (await client.getPrimaryKey(ODD))?.name,
          columns: ["odd col"],
        });
        // Quotes are not part of the name, so they find nothing.
        await assert.rejects(() => client.getColumns(`"${ODD}"`), QueryError);
      } finally {
        await client.close();
      }
    });

    test("getPrimaryKey returns the key columns in key order, or null", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        assert.deepEqual(await client.getPrimaryKey(PARENT), {
          name: "pk_cc_sch_parent",
          columns: ["b", "a"],
        });
        await client.query("CREATE TABLE cc_sch_nopk (x INT)");
        try {
          assert.equal(await client.getPrimaryKey("cc_sch_nopk"), null);
        } finally {
          await client.query("DROP TABLE cc_sch_nopk");
        }
      } finally {
        await client.close();
      }
    });

    test("getIndexes reports uniqueness, order, prefix, expression, filter and keys", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const indexes = new Map(
          (await client.getIndexes(PARENT)).map((index) => [index.name, index]),
        );
        assert.deepEqual(indexes.get("pk_cc_sch_parent"), {
          name: "pk_cc_sch_parent",
          unique: true,
          reverse: false,
          primaryKey: true,
          foreignKey: false,
          filter: null,
          columns: [
            { name: "b", order: "asc" },
            { name: "a", order: "asc" },
          ],
        });
        assert.equal(indexes.get("u_cc_sch_c")?.unique, true);
        assert.deepEqual(indexes.get("i_cc_sch_ab")?.columns, [
          { name: "a", order: "desc" },
          { name: "b", order: "asc" },
        ]);
        assert.equal(indexes.get("r_cc_sch_n")?.reverse, true);
        assert.deepEqual(indexes.get("i_cc_sch_prefix")?.columns, [
          { name: "p", order: "asc", prefixLength: 5 },
        ]);
        const fn = indexes.get("i_cc_sch_lower")?.columns[0];
        assert.equal(fn?.name, null);
        assert.match(fn?.expression ?? "", /lower/i);
        assert.match(indexes.get("i_cc_sch_filter")?.filter ?? "", /is not null/i);

        const fk = (await client.getIndexes(CHILD)).find((index) => index.foreignKey);
        assert.deepEqual(
          fk?.columns.map((column) => column.name),
          ["pb", "pa"],
        );
        assert.equal(fk?.primaryKey, false);
      } finally {
        await client.close();
      }
    });

    test("a table name is bound, never run as SQL, and an unknown table is a QueryError", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        for (const hostile of [
          `${PARENT}' OR '1'='1`,
          `x'; DROP TABLE ${PARENT}; --`,
          "%",
          "cc_sch_missing",
        ]) {
          await assert.rejects(() => client.getColumns(hostile), QueryError);
          await assert.rejects(() => client.getIndexes(hostile), QueryError);
          await assert.rejects(() => client.getPrimaryKey(hostile), QueryError);
        }
        await assert.rejects(
          () => client.getColumns(PARENT, { schema: "nobody_owns_this" }),
          QueryError,
        );
        assert.equal((await client.getColumns(PARENT)).length, 7);
      } finally {
        await client.close();
      }
    });

    test("a user sees only the tables it may SELECT, and the rest look absent", async () => {
      const granted = createClient({ ...TEST_CONFIG, user: USER_A });
      const denied = createClient({ ...TEST_CONFIG, user: USER_B });

      try {
        assert.equal((await granted.getColumns(PARENT)).length, 7);
        assert.deepEqual(
          (await granted.getTables()).map((table) => table.name),
          [PARENT],
        );
        await assert.rejects(
          () => granted.getColumns(CHILD),
          /was not found, or the connected user may not SELECT/,
        );
        assert.deepEqual(await denied.getTables(), []);
        await assert.rejects(() => denied.getIndexes(PARENT), QueryError);
      } finally {
        await granted.close();
        await denied.close();
      }
    });

    test("several owners of one table name need a schema (CUBRID 11.2 and later)", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        await client.query(`CREATE TABLE ${USER_A}.${DUP} (a_only INT PRIMARY KEY)`);

        if (!(await serverAtLeast(client, 11, 2))) {
          // Older servers keep one table per name and own it by the creator, DBA.
          const found = (await client.getTables()).filter((table) => table.name === DUP);
          assert.deepEqual(found, [{ name: DUP, schema: "DBA", type: "table" }]);
          assert.deepEqual(
            (await client.getColumns(DUP, { schema: "dba" })).map((c) => c.name),
            ["a_only"],
          );
          return;
        }

        await client.query(`CREATE TABLE ${USER_B}.${DUP} (b_only INT, b_two INT)`);
        assert.deepEqual(
          (await client.getTables())
            .filter((table) => table.name === DUP)
            .map((table) => table.schema),
          [USER_A.toUpperCase(), USER_B.toUpperCase()],
        );
        await assert.rejects(
          () => client.getColumns(DUP),
          /owned by several users \(CC_SCH_UA, CC_SCH_UB\)/,
        );
        assert.deepEqual(
          (await client.getColumns(DUP, { schema: USER_A })).map((c) => c.name),
          ["a_only"],
        );
        assert.deepEqual(
          (await client.getColumns(DUP, { schema: USER_B })).map((c) => c.name),
          ["b_only", "b_two"],
        );
        assert.equal((await client.getPrimaryKey(DUP, { schema: USER_A }))?.columns[0], "a_only");
        assert.equal(await client.getPrimaryKey(DUP, { schema: USER_B }), null);
        assert.equal((await client.getIndexes(DUP, { schema: USER_B })).length, 0);
      } finally {
        await client.close();
      }
    });

    test("drop the fixtures", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        await cleanup(client);
      } finally {
        await client.close();
      }
    });
  });

  describe("execute results", () => {
    const AUTO = "cc_exec_auto";
    const PLAIN = "cc_exec_plain";
    const BIG = "cc_exec_big";
    const FRESH_A = "cc_exec_fresh_a";
    const FRESH_B = "cc_exec_fresh_b";
    const ALL = [AUTO, PLAIN, BIG, FRESH_A, FRESH_B];

    test("create the tables", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        for (const table of ALL) {
          await client.query(`DROP TABLE IF EXISTS ${table}`);
        }
        await client.query(`CREATE TABLE ${AUTO} (id INT AUTO_INCREMENT PRIMARY KEY, v INT)`);
        await client.query(`CREATE TABLE ${PLAIN} (id INT, v INT)`);
        for (const table of [FRESH_A, FRESH_B]) {
          await client.query(`CREATE TABLE ${table} (id INT AUTO_INCREMENT PRIMARY KEY, v INT)`);
        }
        await client.query(
          `CREATE TABLE ${BIG} (id BIGINT AUTO_INCREMENT(9007199254740993, 1) PRIMARY KEY, v INT)`,
        );
      } finally {
        await client.close();
      }
    });

    test("INSERT, UPDATE and DELETE report their row counts and the generated id", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        assert.deepEqual(await client.execute(`INSERT INTO ${AUTO} (v) VALUES (?)`, [10]), {
          affectedRows: 1,
          lastInsertId: 1,
        });
        // A multi-row INSERT reports the first id it generated (here 2, 3 and 4).
        assert.deepEqual(await client.execute(`INSERT INTO ${AUTO} (v) VALUES (11), (12), (13)`), {
          affectedRows: 3,
          lastInsertId: 2,
        });
        assert.deepEqual(await client.execute(`UPDATE ${AUTO} SET v = v + 100 WHERE v > 10`), {
          affectedRows: 3,
        });
        assert.deepEqual(await client.execute(`UPDATE ${AUTO} SET v = 0 WHERE v = -1`), {
          affectedRows: 0,
        });
        assert.deepEqual(await client.execute(`DELETE FROM ${AUTO} WHERE v > 100`), {
          affectedRows: 3,
        });
        assert.deepEqual(await client.execute(`DELETE FROM ${AUTO} WHERE v = -1`), {
          affectedRows: 0,
        });
        // The next id continues after the deleted rows.
        assert.deepEqual(await client.execute(`INSERT INTO ${AUTO} (v) VALUES (20)`), {
          affectedRows: 1,
          lastInsertId: 5,
        });
        // The statements were committed, and query() still returns no rows for DML.
        // COUNT(*) is a number on 10.2 and 11.0 and a bigint from 11.2.
        const [counted] = await client.query<{ n: number | bigint }>(
          `SELECT COUNT(*) AS n FROM ${AUTO}`,
        );
        assert.equal(Number(counted?.n), 2);
        assert.deepEqual(await client.query(`INSERT INTO ${AUTO} (v) VALUES (30)`), []);
      } finally {
        await client.close();
      }
    });

    test("an INSERT into a table without AUTO_INCREMENT reports no id, not an earlier one", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const generated = await client.execute(`INSERT INTO ${AUTO} (v) VALUES (1)`);
        assert.equal(typeof generated.lastInsertId, "number");

        const plain = await client.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (1, 1), (2, 2)`);
        assert.deepEqual(plain, { affectedRows: 2 });
      } finally {
        await client.close();
      }
    });

    test("execute adds up the statements of a multi-statement string", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const result = await client.execute(
          `INSERT INTO ${PLAIN} (id, v) VALUES (10, 1); INSERT INTO ${PLAIN} (id, v) VALUES (11, 2), (12, 3)`,
        );
        assert.deepEqual(result, { affectedRows: 3 });
        assert.deepEqual(await client.execute(`DELETE FROM ${PLAIN} WHERE id >= 10`), {
          affectedRows: 3,
        });
      } finally {
        await client.close();
      }
    });

    test("execute reports 0 rows for DDL and for a SELECT", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        assert.deepEqual(await client.execute(`CREATE INDEX cc_exec_idx ON ${PLAIN} (v)`), {
          affectedRows: 0,
        });
        assert.deepEqual(await client.execute(`DROP INDEX cc_exec_idx ON ${PLAIN}`), {
          affectedRows: 0,
        });
        assert.deepEqual(await client.execute(`SELECT * FROM ${AUTO}`), { affectedRows: 0 });
      } finally {
        await client.close();
      }
    });

    test("execute returns a bigint when the id is beyond Number.MAX_SAFE_INTEGER", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const result = await client.execute(`INSERT INTO ${BIG} (v) VALUES (1)`);
        assert.deepEqual(result, { affectedRows: 1, lastInsertId: 9007199254740993n });
      } finally {
        await client.close();
      }
    });

    test("a failing autocommit execute rolls back and leaves the connection usable", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        await client.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (500, 1)`);
        await assert.rejects(
          () => client.execute(`INSERT INTO ${AUTO} (id, v) VALUES (1, 1)`),
          ConstraintError,
        );
        assert.deepEqual(await client.execute(`DELETE FROM ${PLAIN} WHERE id = 500`), {
          affectedRows: 1,
        });
      } finally {
        await client.close();
      }
    });

    test("an autocommit execute is visible to another connection at once", async () => {
      const writer = createClient(TEST_CONFIG);
      const reader = createClient(TEST_CONFIG);

      try {
        await writer.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (600, 6)`);
        assert.deepEqual(await reader.query(`SELECT v FROM ${PLAIN} WHERE id = 600`), [{ v: 6 }]);
        await writer.execute(`DELETE FROM ${PLAIN} WHERE id = 600`);
      } finally {
        await writer.close();
        await reader.close();
      }
    });

    test("tx.execute reports ids, repeats none and honors rollback", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        await client.transaction(async (tx) => {
          const first = await tx.execute(`INSERT INTO ${AUTO} (v) VALUES (41)`);
          const second = await tx.execute(`INSERT INTO ${AUTO} (v) VALUES (42), (43)`);
          assert.equal(typeof first.lastInsertId, "number");
          assert.equal(Number(second.lastInsertId) > Number(first.lastInsertId), true);
          assert.equal(second.affectedRows, 2);

          // The server would answer with `second`'s id again for this INSERT.
          assert.deepEqual(await tx.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (700, 7)`), {
            affectedRows: 1,
          });
          assert.deepEqual(await tx.execute(`DELETE FROM ${PLAIN} WHERE id = 700`), {
            affectedRows: 1,
          });
        });

        const before = await client.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${AUTO}`);
        await assert.rejects(() =>
          client.transaction(async (tx) => {
            await tx.execute(`INSERT INTO ${AUTO} (v) VALUES (50)`);
            throw new Error("abort");
          }),
        );
        assert.deepEqual(await client.query(`SELECT COUNT(*) AS n FROM ${AUTO}`), before);
      } finally {
        await client.close();
      }
    });

    test("an INSERT inside a transaction reports no id after an autocommit INSERT into another table", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);

      try {
        const inserted = await adapter.execute(`INSERT INTO ${AUTO} (v) VALUES (60)`);
        assert.equal(typeof inserted.lastInsertId, "number");

        await adapter.beginTransaction();
        assert.deepEqual(await adapter.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (800, 8)`), {
          affectedRows: 1,
        });
        await adapter.rollback();
      } finally {
        await adapter.close();
      }
    });

    test("tx.execute reports no id after a tx.query INSERT it cannot tell apart", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        await client.transaction(async (tx) => {
          // tx.query generates an id that nobody reads; the table without
          // AUTO_INCREMENT then sees the server still answering with it.
          assert.deepEqual(await tx.query(`INSERT INTO ${AUTO} (v) VALUES (70)`), []);
          assert.deepEqual(await tx.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (900, 9)`), {
            affectedRows: 1,
          });
          // A different generated value is certainly this statement's.
          assert.deepEqual(await tx.execute(`INSERT INTO ${FRESH_A} (v) VALUES (1)`), {
            affectedRows: 1,
            lastInsertId: 1,
          });
          await tx.execute(`DELETE FROM ${PLAIN} WHERE id = 900`);
        });
      } finally {
        await client.close();
      }
    });

    test("tx.execute reports no id when two fresh tables generate the same number", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        // Restart both tables at 1.
        for (const table of [FRESH_A, FRESH_B]) {
          await client.execute(`DROP TABLE ${table}`);
          await client.execute(`CREATE TABLE ${table} (id INT AUTO_INCREMENT PRIMARY KEY, v INT)`);
        }
        await client.transaction(async (tx) => {
          // Both tables generate 1 and the server's answer is the same bytes
          // for each, so the second id cannot be told from the first's: no id.
          assert.deepEqual(await tx.execute(`INSERT INTO ${FRESH_A} (v) VALUES (1)`), {
            affectedRows: 1,
            lastInsertId: 1,
          });
          assert.deepEqual(await tx.execute(`INSERT INTO ${FRESH_B} (v) VALUES (1)`), {
            affectedRows: 1,
          });
        });
      } finally {
        await client.close();
      }
    });

    test("drop the tables", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        for (const table of ALL) {
          await client.query(`DROP TABLE IF EXISTS ${table}`);
        }
      } finally {
        await client.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Generated insert ids (#247)
  // -------------------------------------------------------------------------

  describe("generated insert ids", () => {
    const A = "cc247_a";
    const B = "cc247_b";
    const PLAIN = "cc247_plain";
    const BIG = "cc247_big";
    const SOURCE = "cc247_src";
    const COPY = "cc247_ctas";
    const LOG = "cc247_log";
    const TRIGGERED = "cc247_trg";
    const ALL = [A, B, PLAIN, BIG, SOURCE, COPY, LOG, TRIGGERED];
    const KEYS = { generatedKeys: true } as const;

    /**
     * A generatedKeys result: the expected key, or none. From 11.0 the server
     * sometimes answers GET_GENERATED_KEYS with the row but without its key, mostly
     * for the first INSERTs into a newly created table; it never sent a wrong one.
     */
    const assertKey = (result: ExecuteResult, rows: number, key: number | bigint) => {
      assert.equal(result.affectedRows, rows);
      if (result.lastInsertId !== undefined || version.startsWith("10.")) {
        assert.strictEqual(result.lastInsertId, key);
      }
    };
    let version = "";

    /** PL/CSQL stored routines exist from CUBRID 11.4. */
    const hasPlcsql = () => /^(11\.([4-9]|\d\d)|1[2-9])\./.test(version);

    /** Recreates the tables on `db`, the session the test then uses. */
    const recreate = async (db: { query(sql: string): Promise<unknown> }) => {
      const client = db;
      await client.query("DROP TRIGGER IF EXISTS cc247_trg_ai").catch(() => undefined);
      for (const table of ALL) {
        await client.query(`DROP TABLE IF EXISTS ${table}`);
      }
      for (const table of [A, B, TRIGGERED]) {
        await client.query(`CREATE TABLE ${table} (id INT AUTO_INCREMENT PRIMARY KEY, v INT)`);
      }
      await client.query(`CREATE TABLE ${PLAIN} (id INT PRIMARY KEY, v INT)`);
      await client.query(`CREATE TABLE ${SOURCE} (v INT)`);
      await client.query(`INSERT INTO ${SOURCE} VALUES (1), (2), (3)`);
      await client.query(`CREATE TABLE ${LOG} (id INT AUTO_INCREMENT(800, 1) PRIMARY KEY, n INT)`);
      await client.query(
        `CREATE TABLE ${BIG} (id BIGINT AUTO_INCREMENT(9007199254740991, 1) PRIMARY KEY, v INT)`,
      );
    };

    before(async () => {
      const client = createClient(TEST_CONFIG);
      try {
        version = await client.getServerVersion();
      } finally {
        await client.close();
      }
    });

    after(async () => {
      const client = createClient(TEST_CONFIG);
      try {
        await client.query("DROP TRIGGER IF EXISTS cc247_trg_ai").catch(() => undefined);
        if (hasPlcsql()) {
          await client.query("DROP FUNCTION IF EXISTS cc247_fn").catch(() => undefined);
          await client.query("DROP PROCEDURE IF EXISTS cc247_proc").catch(() => undefined);
        }
        for (const table of ALL) {
          await client.query(`DROP TABLE IF EXISTS ${table}`);
        }
      } finally {
        await client.close();
      }
    });

    test("tables A and B that both generate 1: generatedKeys reports both, the default only A", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        await recreate(client);
        // The session's last insert id is 1 after each, so the default cannot tell
        // B's genuine 1 from A's stale one and reports none.
        assert.deepEqual(await client.execute(`INSERT INTO ${A} (v) VALUES (1)`), {
          affectedRows: 1,
          lastInsertId: 1,
        });
        assert.deepEqual(await client.execute(`INSERT INTO ${B} (v) VALUES (1)`), {
          affectedRows: 1,
        });
        assert.deepEqual(await client.execute(`INSERT INTO ${PLAIN} VALUES (1, 1)`), {
          affectedRows: 1,
        });

        await recreate(client);
        assertKey(await client.execute(`INSERT INTO ${A} (v) VALUES (?)`, [1], KEYS), 1, 1);
        assertKey(await client.executePrepared(`INSERT INTO ${B} (v) VALUES (?)`, [1], KEYS), 1, 1);
        // The session still holds 1, but this INSERT generated nothing.
        assert.deepEqual(await client.execute(`INSERT INTO ${PLAIN} VALUES (2, 2)`, [], KEYS), {
          affectedRows: 1,
        });
        assert.deepEqual(
          await client.executePrepared(`INSERT INTO ${PLAIN} VALUES (?, ?)`, [3, 3], KEYS),
          { affectedRows: 1 },
        );
        // A key the statement supplies is not a generated one.
        assert.deepEqual(
          await client.execute(`INSERT INTO ${A} (id, v) VALUES (50, 1)`, [], KEYS),
          {
            affectedRows: 1,
          },
        );
      } finally {
        await client.close();
      }
    });

    test("multi-row INSERT and INSERT ... SELECT", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        await recreate(client);
        // Both report the first generated value of the statement.
        assert.deepEqual(await client.execute(`INSERT INTO ${A} (v) VALUES (1), (2), (3)`), {
          affectedRows: 3,
          lastInsertId: 1,
        });
        assertKey(
          await client.execute(`INSERT INTO ${A} (v) VALUES (4), (5)`, undefined, KEYS),
          2,
          4,
        );
        // INSERT ... SELECT can run a routine through a view or subquery, so the
        // default reports none; the keys of the statement are exact.
        assert.deepEqual(await client.execute(`INSERT INTO ${B} (v) SELECT v FROM ${SOURCE}`), {
          affectedRows: 3,
        });
        assertKey(
          await client.execute(`INSERT INTO ${B} (v) SELECT v FROM ${SOURCE}`, undefined, KEYS),
          3,
          4,
        );
      } finally {
        await client.close();
      }
    });

    test("a failed INSERT, a rollback and a reconnect leave no stale id behind", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      try {
        await recreate(adapter);
        assert.equal((await adapter.execute(`INSERT INTO ${A} (v) VALUES (1)`)).lastInsertId, 1);
        await assert.rejects(
          () => adapter.execute(`INSERT INTO ${A} (id, v) VALUES (1, 1)`, [], KEYS),
          ConstraintError,
        );
        assert.deepEqual(await adapter.execute(`INSERT INTO ${PLAIN} VALUES (1, 1)`), {
          affectedRows: 1,
        });

        await adapter.beginTransaction();
        // The key is the statement's own, even though the row is rolled back.
        assertKey(await adapter.execute(`INSERT INTO ${A} (v) VALUES (2)`, [], KEYS), 1, 2);
        await adapter.rollback();
        // The server keeps 2 as the session's value through ROLLBACK.
        assert.deepEqual(await adapter.execute(`INSERT INTO ${PLAIN} VALUES (2, 2)`), {
          affectedRows: 1,
        });
        assert.deepEqual(await adapter.execute(`INSERT INTO ${PLAIN} VALUES (3, 3)`, [], KEYS), {
          affectedRows: 1,
        });

        // A new session starts with no value.
        await adapter.close();
        assert.deepEqual(await adapter.execute(`INSERT INTO ${PLAIN} VALUES (4, 4)`), {
          affectedRows: 1,
        });
        assert.deepEqual(await adapter.execute(`INSERT INTO ${B} (v) VALUES (1)`), {
          affectedRows: 1,
          lastInsertId: 1,
        });
      } finally {
        await adapter.close();
      }
    });

    test("a statement that changed no row cannot leave its value to the next INSERT", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        await recreate(client);
        assert.equal((await client.execute(`INSERT INTO ${A} (v) VALUES (1)`)).lastInsertId, 1);
        // Sets the session's value to 700 and reports 0 rows.
        assert.deepEqual(
          await client.execute(
            `CREATE TABLE ${COPY} (id INT AUTO_INCREMENT(700, 1), v INT) AS SELECT v FROM ${SOURCE}`,
          ),
          { affectedRows: 0 },
        );
        assert.deepEqual(await client.execute(`INSERT INTO ${PLAIN} VALUES (1, 1)`), {
          affectedRows: 1,
        });
      } finally {
        await client.close();
      }
    });

    test("number and bigint at the safe-integer boundary", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        await recreate(client);
        assertKey(
          await client.execute(`INSERT INTO ${BIG} (v) VALUES (1)`, [], KEYS),
          1,
          Number.MAX_SAFE_INTEGER,
        );
        assertKey(
          await client.executePrepared(`INSERT INTO ${BIG} (v) VALUES (?)`, [2], KEYS),
          1,
          9007199254740992n,
        );
        assert.deepEqual(await client.execute(`INSERT INTO ${BIG} (v) VALUES (3)`), {
          affectedRows: 1,
          lastInsertId: 9007199254740993n,
        });
      } finally {
        await client.close();
      }
    });

    test("an INSERT trigger: the default reports the row's id, generatedKeys fails from 11.0", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        await recreate(client);
        await client.query(
          `CREATE TRIGGER cc247_trg_ai AFTER INSERT ON ${TRIGGERED} EXECUTE INSERT INTO ${LOG} (n) VALUES (obj.v)`,
        );
        assert.deepEqual(await client.execute(`INSERT INTO ${TRIGGERED} (v) VALUES (1)`), {
          affectedRows: 1,
          lastInsertId: 1,
        });
        const keyed = client.execute(`INSERT INTO ${TRIGGERED} (v) VALUES (2)`, [], KEYS);
        if (version.startsWith("10.")) {
          assertKey(await keyed, 1, 2);
        } else {
          // The server runs this INSERT on the client side, and returning its
          // key fails there: "Instances of a reusable OID class are non-referable."
          await assert.rejects(keyed, QueryError);
        }
        // Only the rows of the successful statements are there.
        const rows = await client.query<{ n: number | bigint }>(
          `SELECT COUNT(*) AS n FROM ${TRIGGERED}`,
        );
        assert.equal(Number(rows[0]?.n), version.startsWith("10.") ? 2 : 1);
      } finally {
        await client.query("DROP TRIGGER IF EXISTS cc247_trg_ai").catch(() => undefined);
        await client.close();
      }
    });

    test("a stored function that inserts: no id by default, the row's own key with generatedKeys", async (t) => {
      if (!hasPlcsql()) {
        t.skip(`PL/CSQL needs CUBRID 11.4 or later; this is ${version}`);
        return;
      }
      const client = createClient(TEST_CONFIG);
      try {
        await recreate(client);
        await client.query(
          `CREATE OR REPLACE FUNCTION cc247_fn() RETURN INT AS BEGIN INSERT INTO ${LOG} (n) VALUES (1); RETURN 1; END;`,
        );
        assert.equal((await client.execute(`INSERT INTO ${A} (v) VALUES (1)`)).lastInsertId, 1);
        // The function sets the session's value to 800.
        assert.deepEqual(await client.query("SELECT cc247_fn() AS f"), [{ f: 1 }]);
        assert.deepEqual(await client.execute(`INSERT INTO ${PLAIN} VALUES (1, 1)`), {
          affectedRows: 1,
        });
        // The row gets 2 and the function's insert 801.
        assert.deepEqual(await client.execute(`INSERT INTO ${A} (v) VALUES (cc247_fn())`), {
          affectedRows: 1,
        });
        assertKey(await client.execute(`INSERT INTO ${A} (v) VALUES (cc247_fn())`, [], KEYS), 1, 3);
      } finally {
        await client.query("DROP FUNCTION IF EXISTS cc247_fn").catch(() => undefined);
        await client.close();
      }
    });

    test("known limit: a trigger that calls a routine can set the default's value", async (t) => {
      if (!hasPlcsql()) {
        t.skip(`PL/CSQL needs CUBRID 11.4 or later; this is ${version}`);
        return;
      }
      const client = createClient(TEST_CONFIG);
      try {
        await recreate(client);
        await client.query(
          `CREATE OR REPLACE PROCEDURE cc247_proc(x INT) AS BEGIN INSERT INTO ${LOG} (n) VALUES (x); END;`,
        );
        await client.query(
          `CREATE TRIGGER cc247_trg_ai AFTER INSERT ON ${TRIGGERED} EXECUTE CALL cc247_proc(obj.v)`,
        );
        // Nothing in the statement's text shows the routine, and the session's
        // value is the routine's 800, not the row's 1. docs/API_REFERENCE.md
        // documents this; generatedKeys would refuse the INSERT here instead.
        assert.deepEqual(await client.execute(`INSERT INTO ${TRIGGERED} (v) VALUES (1)`), {
          affectedRows: 1,
          lastInsertId: 800,
        });
      } finally {
        await client.query("DROP TRIGGER IF EXISTS cc247_trg_ai").catch(() => undefined);
        await client.query("DROP PROCEDURE IF EXISTS cc247_proc").catch(() => undefined);
        await client.close();
      }
    });

    test("after DDL on the table the keys may be missing, never wrong", async () => {
      const ddl = createClient(TEST_CONFIG);
      const client = createClient(TEST_CONFIG);
      const seen: Array<number | bigint | undefined> = [];
      try {
        for (const layout of [
          "(id INT AUTO_INCREMENT PRIMARY KEY, v INT)",
          "(v INT, w INT, id INT AUTO_INCREMENT(500, 1) PRIMARY KEY)",
        ]) {
          await ddl.query(`DROP TABLE IF EXISTS ${A}`);
          await ddl.query(`CREATE TABLE ${A} ${layout}`);
          for (let i = 0; i < 2; i++) {
            const { lastInsertId } = await client.execute(
              `INSERT INTO ${A} (v) VALUES (1)`,
              [],
              KEYS,
            );
            const [{ m }] = (await client.query(`SELECT MAX(id) AS m FROM ${A}`)) as [
              { m: number },
            ];
            assert.ok(
              lastInsertId === undefined || Number(lastInsertId) === m,
              String(lastInsertId),
            );
            seen.push(lastInsertId);
          }
        }
        if (version.startsWith("10.")) {
          assert.equal(seen.includes(undefined), false);
        }
      } finally {
        await ddl.close();
        await client.close();
      }
    });

    test("pool.execute passes generatedKeys on", async () => {
      const pool = createPool({ ...TEST_CONFIG, max: 1 });
      try {
        await recreate(pool);
        assertKey(await pool.execute(`INSERT INTO ${A} (v) VALUES (1)`, [], KEYS), 1, 1);
        assertKey(await pool.execute(`INSERT INTO ${B} (v) VALUES (1)`, [], KEYS), 1, 1);
        if (!version.startsWith("10.")) {
          // Only the flag the option sends makes 11.x refuse a triggered INSERT.
          await pool.query(
            `CREATE TRIGGER cc247_trg_ai AFTER INSERT ON ${TRIGGERED} EXECUTE INSERT INTO ${LOG} (n) VALUES (obj.v)`,
          );
          await assert.rejects(
            pool.execute(`INSERT INTO ${TRIGGERED} (v) VALUES (1)`, [], KEYS),
            QueryError,
          );
          await pool.query("DROP TRIGGER cc247_trg_ai");
        }
      } finally {
        await pool.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // BLOB and CLOB content
  // -------------------------------------------------------------------------

  describe("BLOB and CLOB columns", () => {
    const TABLE = "cc93_lob";

    /** More than one LOB_READ reply holds, which is 81908 bytes on all four versions. */
    const LARGE_BLOB = Buffer.alloc(250_000);
    for (let i = 0; i < LARGE_BLOB.length; i++) {
      LARGE_BLOB[i] = i % 251;
    }
    /** Three-byte characters after one ASCII byte, so a reply boundary splits one. */
    const LARGE_CLOB = `x${"\ud55c".repeat(100_000)}`;

    async function withLobTable(
      use: (client: ReturnType<typeof createClient>) => Promise<void>,
      options: { maxLobBytes?: number } = {},
    ): Promise<void> {
      const client = createClient({ ...TEST_CONFIG, ...options });
      try {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, b BLOB, c CLOB)`);
        await use(client);
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.close();
      }
    }

    const causes = (error: unknown): string => {
      const messages: string[] = [];
      for (let e = error; e instanceof Error; e = e.cause) {
        messages.push(`${e.name}: ${e.message}`);
      }
      return messages.join(" | ");
    };

    test("content, empty values and NULL read back as written", async () => {
      await withLobTable(async (client) => {
        await client.query(`INSERT INTO ${TABLE} VALUES (?, ?, ?)`, [
          1,
          Buffer.from([0, 1, 2, 255]),
          "hello \ud55c\uae00",
        ]);
        await client.query(`INSERT INTO ${TABLE} VALUES (2, X'', '')`);
        await client.query(`INSERT INTO ${TABLE} VALUES (3, NULL, NULL)`);

        assert.deepEqual(await client.query(`SELECT id, b, c FROM ${TABLE} ORDER BY id`), [
          { id: 1, b: Buffer.from([0, 1, 2, 255]), c: "hello \ud55c\uae00" },
          { id: 2, b: Buffer.alloc(0), c: "" },
          { id: 3, b: null, c: null },
        ]);
      });
    });

    test("content over several LOB_READ replies is complete, split characters included", async () => {
      await withLobTable(async (client) => {
        await client.query(`INSERT INTO ${TABLE} VALUES (?, ?, ?)`, [1, LARGE_BLOB, LARGE_CLOB]);

        const [row] = await client.query<{ b: Buffer; c: string }>(`SELECT b, c FROM ${TABLE}`);

        assert.ok(LARGE_BLOB.equals(row!.b));
        assert.equal(row!.c, LARGE_CLOB);
      });
    });

    test("rows delivered by FETCH load too, and overlapping queries take their turns", async () => {
      await withLobTable(async (client) => {
        const rows = Array.from({ length: 150 }, (_, i) => `(${i}, X'0a', 'v${i}')`);
        await client.query(`INSERT INTO ${TABLE} VALUES ${rows.join(",")}`);

        const results = await Promise.all(
          [0, 1, 2, 3].map(() =>
            client.query<{ id: number; c: string }>(`SELECT id, b, c FROM ${TABLE} ORDER BY id`),
          ),
        );

        for (const result of results) {
          assert.equal(result.length, 150);
          assert.deepEqual(result[149], { id: 149, b: Buffer.from([10]), c: "v149" });
        }
      });
    });

    test("over the limit, the query rejects by name and the connection stays usable", async () => {
      await withLobTable(
        async (client) => {
          await client.query(`INSERT INTO ${TABLE} VALUES (1, ?, 'short')`, [LARGE_BLOB]);

          await assert.rejects(
            () => client.query(`SELECT b FROM ${TABLE}`),
            (error: Error) => {
              assert.ok(error instanceof QueryError);
              assert.match(
                causes(error),
                /UnsupportedValueError: CUBRID column "b" .* 250000 bytes, over the maxLobBytes limit of 100000/,
              );
              return true;
            },
          );

          // Under the limit on the same connection, in the same table.
          assert.deepEqual(await client.query(`SELECT c FROM ${TABLE}`), [{ c: "short" }]);
        },
        { maxLobBytes: 100_000 },
      );
    });

    test("over the limit in a transaction, the transaction stays open", async () => {
      await withLobTable(
        async (client) => {
          await client.transaction(async (tx) => {
            await tx.query(`INSERT INTO ${TABLE} VALUES (1, X'0102', 'kept')`);
            await assert.rejects(() => tx.query(`SELECT b FROM ${TABLE}`), TransactionError);
            await tx.query(`INSERT INTO ${TABLE} VALUES (2, NULL, 'too')`);
          });

          // Both rows committed; `c` is left out because it is over this client's limit.
          assert.deepEqual(await client.query(`SELECT id FROM ${TABLE} ORDER BY id`), [
            { id: 1 },
            { id: 2 },
          ]);
        },
        { maxLobBytes: 1 },
      );
    });

    test("a transaction reads its own uncommitted row, and a rollback removes it", async () => {
      await withLobTable(async (client) => {
        // Read inside and asserted outside: a failed assertion in the callback
        // would itself roll back and look like the planned failure.
        let seen: unknown;
        await assert.rejects(
          () =>
            client.transaction(async (tx) => {
              await tx.query(`INSERT INTO ${TABLE} VALUES (1, X'0a0b', 'uncommitted')`);
              seen = await tx.query(`SELECT b, c FROM ${TABLE}`);
              throw new Error("roll it back");
            }),
          TransactionError,
        );

        assert.deepEqual(seen, [{ b: Buffer.from([10, 11]), c: "uncommitted" }]);
        assert.deepEqual(await client.query(`SELECT b FROM ${TABLE}`), []);
      });
    });

    test("a LOB made by the statement reads in a transaction, not after autocommit removed it", async () => {
      await withLobTable(async (client) => {
        await client.transaction(async (tx) => {
          assert.deepEqual(await tx.query("SELECT CHAR_TO_CLOB('temp') AS c"), [{ c: "temp" }]);
        });

        // The temporary file is already deleted when the autocommit reply arrives.
        await assert.rejects(
          () => client.query("SELECT CHAR_TO_CLOB('temp') AS c"),
          (error: Error) => {
            assert.ok(error instanceof QueryError);
            assert.match(causes(error), /CUBRID LOB read failed \(-1020\)/);
            return true;
          },
        );
        assert.deepEqual(await client.query("SELECT 'after' AS t"), [{ t: "after" }]);
      });
    });

    test("a CLOB that is not UTF-8 rejects by name and CLOB_TO_CHAR still reads it", async () => {
      await withLobTable(async (client) => {
        // The test databases use the iso88591 charset, where CHR(233) is one byte.
        await client.query(`INSERT INTO ${TABLE} VALUES (1, NULL, CHAR_TO_CLOB(CHR(233)))`);

        await assert.rejects(
          () => client.query(`SELECT c FROM ${TABLE}`),
          (error: Error) => {
            assert.match(
              causes(error),
              /UnsupportedValueError: CUBRID CLOB column "c" is not valid UTF-8/,
            );
            return true;
          },
        );

        const [row] = await client.query<{ text: string }>(
          `SELECT CLOB_TO_CHAR(c) AS text FROM ${TABLE}`,
        );
        assert.equal(typeof row!.text, "string");
      });
    });

    test("columns aliased __proto__ stay ordinary columns, LOBs included", async () => {
      await withLobTable(async (client) => {
        await client.query(`INSERT INTO ${TABLE} VALUES (1, X'0a0b', 'c')`);

        const [lob] = await client.query(`SELECT b AS "__proto__" FROM ${TABLE}`);
        const [scalar] = await client.query(`SELECT 7 AS "__proto__", 'after' AS t`);
        const [nullValue] = await client.query(`SELECT NULL AS "__proto__", 'after' AS t`);

        assert.deepEqual(
          Object.getOwnPropertyDescriptor(lob, "__proto__")?.value,
          Buffer.from([10, 11]),
        );
        assert.equal(Object.getOwnPropertyDescriptor(scalar, "__proto__")?.value, 7);
        assert.equal(Object.getOwnPropertyDescriptor(nullValue, "__proto__")?.value, null);
        assert.deepEqual(Object.keys(nullValue!), ["__proto__", "t"]);
        for (const row of [lob, scalar, nullValue]) {
          assert.equal(Object.getPrototypeOf(row), Object.prototype);
        }
      });
    });

    test("an autocommit read does not leave the session in a transaction", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, b BLOB, c CLOB)`);
        await adapter.query(`INSERT INTO ${TABLE} VALUES (1, X'0a', 'c')`);

        assert.deepEqual(await adapter.query(`SELECT b FROM ${TABLE}`), [{ b: Buffer.from([10]) }]);

        // CAS_INFO[0] is 1 while a transaction is open, and LOB_READ opens one.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.equal((adapter as any).cas.casInfo[0], 0);
      } finally {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Close behavior
  // -------------------------------------------------------------------------

  describe("prepared binding", () => {
    const TYPES = "cc_prep_types";
    const ROWS = "cc_prep_rows";
    const AI = "cc_prep_ai";
    const CAS_ER_SRV_HANDLE = -1006;
    const WHEN = new Date(Date.UTC(2024, 1, 29, 13, 45, 56, 789));
    const COLUMNS = [
      "c_short",
      "c_int",
      "c_big",
      "c_float",
      "c_double",
      "c_money",
      "c_num",
      "c_char",
      "c_var",
      "c_nchar",
      "c_date",
      "c_time",
      "c_dt",
      "c_ts",
      "c_bit",
      "c_vbit",
      "c_enum",
    ];
    const INSERT_TYPES = `INSERT INTO ${TYPES} (k, ${COLUMNS.join(", ")}) VALUES (?, ${COLUMNS.map(() => "?").join(", ")})`;

    interface Trace {
      adapter: NativeCubridAdapter;
      cas: CASConnection;
      sent: number[];
      handle: () => number;
    }

    /** Observe every request and let `tamper` replace the response decoded by the adapter. */
    async function open(
      tamper: (functionCode: number, response: Buffer) => Buffer = (_code, response) => response,
    ): Promise<Trace> {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      const cas = (adapter as unknown as { cas: CASConnection }).cas;
      const sent: number[] = [];
      let handle = -1;

      const sendAndRecv = cas.sendAndRecv.bind(cas);
      cas.sendAndRecv = async (header, payload) => {
        sent.push(payload[0]!);
        const response = await sendAndRecv(header, payload);
        if (payload[0] === CASFunctionCode.PREPARE && response.readInt32BE(0) >= 0) {
          handle = response.readInt32BE(0);
        }
        return tamper(payload[0]!, response);
      };

      const sendAndRecvOnSession = cas.sendAndRecvOnSession.bind(cas);
      cas.sendAndRecvOnSession = async (generation, header, payload) => {
        const response = await sendAndRecvOnSession(generation, header, payload);
        if (response) {
          sent.push(payload[0]!);
        }
        return response && tamper(payload[0]!, response);
      };

      const releaseOnSession = cas.releaseOnSession.bind(cas);
      cas.releaseOnSession = async (generation, header, payload) => {
        const response = await releaseOnSession(generation, header, payload);
        if (response) {
          sent.push(payload[0]!);
        }
        return response;
      };

      return { adapter, cas, sent, handle: () => handle };
    }

    /** The server's verdict on the last handle, without the adapter in the way. */
    async function fetchCode(trace: Trace): Promise<number> {
      const { cas } = trace;
      const { header, payload } = writeFetch(trace.handle(), 0, 1, cas.casInfo);
      const response = await cas.sendAndRecvOnSession(cas.connectionGeneration, header, payload);
      assert.ok(response, "the session is still open");
      return response.readInt32BE(0) < 0 ? response.readInt32BE(4) : 0;
    }

    /** Whether `run` succeeds or fails, the handle it prepared must be gone from the server. */
    async function assertReleasedAfter(trace: Trace, run: () => Promise<unknown>): Promise<void> {
      const prepares = trace.sent.filter((code) => code === CASFunctionCode.PREPARE).length;
      await run().catch(() => undefined);
      assert.equal(
        trace.sent.filter((code) => code === CASFunctionCode.PREPARE).length,
        prepares + 1,
        "the statement was prepared",
      );
      assert.equal(await fetchCode(trace), CAS_ER_SRV_HANDLE);
    }

    test("create the tables", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        for (const table of [TYPES, ROWS, AI]) {
          await client.query(`DROP TABLE IF EXISTS ${table}`);
        }
        await client.query(`CREATE TABLE ${TYPES} (
          k INT, c_short SMALLINT, c_int INT, c_big BIGINT, c_float FLOAT, c_double DOUBLE,
          c_money MONETARY, c_num NUMERIC(38,4), c_char CHAR(12), c_var VARCHAR(80),
          c_nchar NCHAR VARYING(40), c_date DATE, c_time TIME, c_dt DATETIME, c_ts TIMESTAMP,
          c_bit BIT(16), c_vbit BIT VARYING(64), c_enum ENUM('a', 'b'))`);
        await client.query(`CREATE TABLE ${ROWS} (id INT PRIMARY KEY, n INT, big NUMERIC(38,0))`);
        await client.query(`CREATE TABLE ${AI} (id INT AUTO_INCREMENT PRIMARY KEY, v INT)`);
      } finally {
        await client.close();
      }
    });

    test("every supported column type stores the same value as the literal path", async () => {
      const client = createClient(TEST_CONFIG);
      const buffer = Buffer.from([0xab, 0xcd]);
      const cases: QueryParams[] = [
        [
          12,
          1234,
          9007199254740993n,
          1.5,
          0.1,
          19.99,
          12345.6789,
          "abc",
          "text",
          null,
          WHEN,
          WHEN,
          WHEN,
          WHEN,
          buffer,
          buffer,
          "a",
        ],
        [
          -12,
          -1234,
          -5000000000,
          -2.25,
          -1e300,
          -1,
          -0.5,
          "",
          "",
          null,
          WHEN,
          WHEN,
          WHEN,
          WHEN,
          buffer,
          buffer,
          "b",
        ],
        [true, false, 42, 42, 42, 42, 42, 42, 42, null, WHEN, WHEN, WHEN, WHEN, buffer, buffer, 1],
        COLUMNS.map(() => null),
      ];

      try {
        for (const [index, values] of cases.entries()) {
          await client.query(`DELETE FROM ${TYPES}`);
          await client.query(INSERT_TYPES, [1, ...values]);
          await client.queryPrepared(INSERT_TYPES, [2, ...values]);
          const rows = await client.query<Record<string, unknown>>(
            `SELECT ${COLUMNS.join(", ")} FROM ${TYPES} ORDER BY k`,
          );

          assert.equal(rows.length, 2, `case ${index}`);
          assert.deepEqual(rows[1], rows[0], `case ${index}`);
        }
      } finally {
        await client.close();
      }
    });

    test("text cannot be bound to NCHAR on either path", async () => {
      const client = createClient(TEST_CONFIG);
      const insert = `INSERT INTO ${TYPES} (k, c_nchar) VALUES (?, ?)`;
      const code = (error: unknown): unknown => (error as QueryError).code;
      try {
        const literal = await client.query(insert, [1, "abc"]).catch(code);
        const prepared = await client.queryPrepared(insert, [1, "abc"]).catch(code);
        assert.equal(literal, -494);
        assert.equal(prepared, literal);
      } finally {
        await client.close();
      }
    });

    test("a NULL bind is SQL NULL in every column and in a comparison", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        await client.query(`DELETE FROM ${TYPES}`);
        await client.queryPrepared(INSERT_TYPES, [1, ...COLUMNS.map(() => null)]);
        const nulls = COLUMNS.map((column) => `${column} IS NULL AS ${column}`).join(", ");
        const [row] = await client.query<Record<string, unknown>>(`SELECT ${nulls} FROM ${TYPES}`);

        assert.ok(row);
        assert.deepEqual(new Set(Object.values(row)), new Set([1]));
        assert.deepEqual(
          await client.queryPrepared(`SELECT k FROM ${TYPES} WHERE c_int = ?`, [null]),
          [],
        );
      } finally {
        await client.close();
      }
    });

    test("BLOB and CLOB columns hold the same bytes as the literal path", async () => {
      const client = createClient(TEST_CONFIG);
      const table = "cc_prep_lob";
      try {
        await client.query(`DROP TABLE IF EXISTS ${table}`);
        await client.query(`CREATE TABLE ${table} (k INT, b BLOB, c CLOB)`);
        const insert = `INSERT INTO ${table} VALUES (?, ?, ?)`;
        await client.query(insert, [1, Buffer.from([1, 2, 3]), "clob text"]);
        await client.queryPrepared(insert, [2, Buffer.from([1, 2, 3]), "clob text"]);

        const rows = await client.query<{ b: string; c: string }>(
          `SELECT TO_CHAR(BIT_LENGTH(BLOB_TO_BIT(b))) AS b, CLOB_TO_CHAR(c) AS c FROM ${table} ORDER BY k`,
        );
        assert.deepEqual(rows[1], rows[0]);
        assert.deepEqual(rows[0], { b: "24", c: "clob text" });
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${table}`);
        await client.close();
      }
    });

    test("text binds arrive unchanged, whatever SQL they look like", async () => {
      const client = createClient(TEST_CONFIG);
      const values = [
        "it's",
        'double"quote',
        "back\\slash",
        "\\'",
        "line\nbreak\r",
        "한글",
        "",
        "ab  ",
        "100%_",
        "?",
        "-- comment",
        "/* comment */",
        "'; DROP TABLE cc_prep_rows; --",
      ];
      try {
        for (const value of values) {
          await client.query(`DELETE FROM ${TYPES}`);
          await client.queryPrepared(`INSERT INTO ${TYPES} (k, c_var) VALUES (?, ?)`, [1, value]);

          const rows = await client.queryPrepared<{ c_var: string }>(
            `SELECT c_var FROM ${TYPES} WHERE c_var = ?`,
            [value],
          );
          assert.deepEqual(rows, [{ c_var: value }]);
        }
        // COUNT(*) is INT before 11.4 and BIGINT from 11.4 on.
        const [count] = await client.query<{ n: number | bigint }>(
          `SELECT COUNT(*) AS n FROM ${ROWS}`,
        );
        assert.equal(Number(count?.n), 0);
      } finally {
        await client.close();
      }
    });

    test("a marker with no type at PREPARE returns each value in its own type", async () => {
      const client = createClient(TEST_CONFIG);
      const select = async (value: QueryParam): Promise<unknown> =>
        (await client.queryPrepared<{ v: unknown }>("SELECT ? AS v FROM db_root", [value]))[0]?.v;
      try {
        assert.equal(await select(7), 7);
        assert.equal(await select(true), 1);
        assert.equal(await select(12345678901), 12345678901n);
        assert.equal(await select(12345678901n), 12345678901n);
        assert.equal(await select(1.5), 1.5);
        assert.equal(await select("x"), "x");
        assert.equal(await select(""), "");
        assert.equal(await select(null), null);
        assert.deepEqual(await select(Buffer.from([1, 2])), Buffer.from([1, 2]));
        assert.equal(await select(10n ** 38n - 1n), String(10n ** 38n - 1n));
        assert.equal(await select(1n - 10n ** 38n), String(1n - 10n ** 38n));
        assert.ok((await select(WHEN)) instanceof Date);
      } finally {
        await client.close();
      }
    });

    test("number and bigint limits keep their value", async () => {
      const client = createClient(TEST_CONFIG);
      const largest = 10n ** 38n - 1n;
      try {
        await client.query(`DELETE FROM ${ROWS}`);
        const insert = `INSERT INTO ${ROWS} (id, big) VALUES (?, ?)`;
        await client.queryPrepared(insert, [1, largest]);
        await client.queryPrepared(insert, [2, -largest]);
        await client.queryPrepared(insert, [3, 2n ** 63n]);
        assert.deepEqual(await client.query(`SELECT big FROM ${ROWS} ORDER BY id`), [
          { big: String(largest) },
          { big: String(-largest) },
          { big: "9223372036854775808" },
        ]);

        await client.query(`DELETE FROM ${TYPES}`);
        const sum = 0.1 + 0.2;
        await client.queryPrepared(`INSERT INTO ${TYPES} (k, c_double, c_big) VALUES (?, ?, ?)`, [
          1,
          sum,
          2 ** 60,
        ]);
        assert.deepEqual(await client.query(`SELECT c_double, c_big FROM ${TYPES}`), [
          { c_double: sum, c_big: 2n ** 60n },
        ]);
      } finally {
        await client.close();
      }
    });

    test("every statement of a multi-statement string runs, as on the literal path", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        await client.query(`DELETE FROM ${ROWS}`);
        const result = await client.executePrepared(
          `INSERT INTO ${ROWS} (id, n) VALUES (?, ?); INSERT INTO ${ROWS} (id, n) VALUES (?, ?)`,
          [1, 10, 2, 20],
        );

        assert.equal(result.affectedRows, 2);
        assert.deepEqual(await client.query(`SELECT id, n FROM ${ROWS} ORDER BY id`), [
          { id: 1, n: 10 },
          { id: 2, n: 20 },
        ]);
        const multiSelect = "SELECT 1 AS a FROM db_root; SELECT 2 AS b FROM db_root";
        assert.deepEqual(await client.queryPrepared(multiSelect), await client.query(multiSelect));
      } finally {
        await client.close();
      }
    });

    test("rows past the first reply arrive by FETCH with the same column metadata", async () => {
      const client = createClient(TEST_CONFIG);
      const count = 1000;
      try {
        await client.query(`DELETE FROM ${ROWS}`);
        const values = Array.from({ length: count }, (_, i) => `(${i}, ${i})`).join(", ");
        await client.query(`INSERT INTO ${ROWS} (id, n) VALUES ${values}`);
        const sql = `SELECT id, n FROM ${ROWS} WHERE id >= ? ORDER BY id`;

        const prepared = await client.queryResultPrepared(sql, [0]);
        const literal = await client.queryResult(sql, [0]);

        assert.equal(prepared.rows.length, count);
        assert.deepEqual(prepared, literal);
      } finally {
        await client.close();
      }
    });

    test("an autocommit statement is committed at once, and a failed one leaves nothing", async () => {
      const client = createClient(TEST_CONFIG);
      const observer = createClient(TEST_CONFIG);
      try {
        await client.query(`DELETE FROM ${ROWS}`);
        await client.queryPrepared(`INSERT INTO ${ROWS} (id, n) VALUES (?, ?)`, [1, 1]);
        assert.equal((await observer.query(`SELECT id FROM ${ROWS}`)).length, 1);

        await assert.rejects(
          client.executePrepared(
            `INSERT INTO ${ROWS} (id, n) VALUES (?, ?); INSERT INTO ${ROWS} (id, n) VALUES (?, ?)`,
            [2, 2, 1, 1],
          ),
          ConstraintError,
        );
        assert.equal((await observer.query(`SELECT id FROM ${ROWS}`)).length, 1);
      } finally {
        await client.close();
        await observer.close();
      }
    });

    test("executePrepared reports the row count and the generated id", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        const first = await client.executePrepared(`INSERT INTO ${AI} (v) VALUES (?)`, [1]);
        const second = await client.executePrepared(`INSERT INTO ${AI} (v) VALUES (?)`, [2]);
        assert.equal(first.affectedRows, 1);
        assert.equal(typeof first.lastInsertId, "number");
        assert.equal(second.lastInsertId, Number(first.lastInsertId) + 1);

        const update = await client.executePrepared(`UPDATE ${AI} SET v = ? WHERE v > ?`, [9, 0]);
        assert.equal(update.affectedRows, 2);
        assert.equal(update.lastInsertId, undefined);
      } finally {
        await client.close();
      }
    });

    test("a transaction keeps prepared statements until it commits or rolls back", async () => {
      const client = createClient(TEST_CONFIG);
      const observer = createClient(TEST_CONFIG);
      try {
        await client.query(`DELETE FROM ${ROWS}`);
        await client.transaction(async (tx) => {
          await tx.executePrepared(`INSERT INTO ${ROWS} (id) VALUES (?)`, [1]);
          assert.deepEqual(await observer.query(`SELECT id FROM ${ROWS}`), []);
          assert.deepEqual(await tx.queryPrepared(`SELECT id FROM ${ROWS} WHERE id = ?`, [1]), [
            { id: 1 },
          ]);
        });
        assert.equal((await observer.query(`SELECT id FROM ${ROWS}`)).length, 1);

        await assert.rejects(
          client.transaction(async (tx) => {
            await tx.queryPrepared(`INSERT INTO ${ROWS} (id) VALUES (?)`, [2]);
            throw new Error("undo");
          }),
          TransactionError,
        );
        assert.equal((await observer.query(`SELECT id FROM ${ROWS}`)).length, 1);
      } finally {
        await client.close();
        await observer.close();
      }
    });

    test("the handle is gone from the server after every way a statement can end", async () => {
      const trace = await open();
      const { adapter } = trace;
      try {
        await adapter.query(`DELETE FROM ${ROWS}`);
        await adapter.beginTransaction();
        await adapter.query(`INSERT INTO ${ROWS} (id, n) VALUES (1, 1), (2, 2)`);
        const big = Array.from({ length: 1000 }, (_, i) => `(${i + 10}, ${i})`).join(", ");
        await adapter.query(`INSERT INTO ${ROWS} (id, n) VALUES ${big}`);

        for (const run of [
          () => adapter.queryPrepared("SELECT ? AS v FROM db_root", [1]),
          () => adapter.queryPrepared(`SELECT id FROM ${ROWS} WHERE id >= ?`, [0]),
          () => adapter.executePrepared(`UPDATE ${ROWS} SET n = ? WHERE id = ?`, [5, 1]),
          // The value fails at EXECUTE.
          () => adapter.queryPrepared("SELECT CAST(? AS INT) AS v FROM db_root", ["abc"]),
          // The statement fails at EXECUTE, after a successful PREPARE.
          () => adapter.executePrepared(`INSERT INTO ${ROWS} (id) VALUES (?)`, [1]),
          // Too few values: refused between PREPARE and EXECUTE.
          () => adapter.queryPrepared("SELECT ?, ? FROM db_root", [1]),
          // Too many values.
          () => adapter.queryPrepared("SELECT 1 FROM db_root", [1]),
          // A value that cannot be decoded: the zero date has no Date.
          () =>
            adapter.queryPrepared("SELECT CAST(? AS DATETIME) AS z FROM db_root", [
              "0000-00-00 00:00:00",
            ]),
        ]) {
          await assertReleasedAfter(trace, run);
        }
      } finally {
        await adapter.rollback().catch(() => undefined);
        await adapter.close();
      }
    });

    test("an autocommit statement releases its handle and ends its transaction", async () => {
      const trace = await open();
      try {
        await trace.adapter.queryPrepared("SELECT ? AS v FROM db_root", [1]);
        assert.deepEqual(trace.sent, [
          CASFunctionCode.PREPARE,
          CASFunctionCode.EXECUTE,
          CASFunctionCode.END_TRAN,
          CASFunctionCode.CLOSE_REQ_HANDLE,
        ]);
        assert.equal(trace.cas.casInfo[0], 0);
      } finally {
        await trace.adapter.close();
      }
    });

    test("a failed PREPARE leaves no transaction open on an autocommit connection", async () => {
      const trace = await open();
      try {
        await assert.rejects(trace.adapter.queryPrepared("SELEC ?", [1]), SqlSyntaxError);
        assert.deepEqual(trace.sent, [CASFunctionCode.PREPARE, CASFunctionCode.END_TRAN]);
        assert.equal(trace.cas.casInfo[0], 0);
      } finally {
        await trace.adapter.close();
      }
    });

    test("a refused value sends nothing", async () => {
      const trace = await open();
      try {
        for (const value of [
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Buffer.alloc(0),
          "a\0b",
          "a\x1ab",
          10n ** 38n,
          new Date(Number.NaN),
          new Date("0000-06-01T00:00:00Z"),
        ]) {
          await assert.rejects(
            trace.adapter.queryPrepared("SELECT ? FROM db_root", [value]),
            QueryError,
          );
        }
        assert.deepEqual(trace.sent, []);
      } finally {
        await trace.adapter.close();
      }
    });

    test("the next statement after a replaced session prepares again and reuses nothing", async () => {
      const trace = await open();
      const internals = trace.cas as unknown as { socket: { destroy(): void } };
      try {
        await trace.adapter.queryPrepared("SELECT ? AS v FROM db_root", [1]);
        internals.socket.destroy();
        await new Promise((resolve) => setImmediate(resolve));
        const sent = trace.sent.length;

        assert.deepEqual(await trace.adapter.queryPrepared("SELECT ? AS v FROM db_root", [2]), [
          { v: 2 },
        ]);
        assert.equal(trace.sent[sent], CASFunctionCode.PREPARE);
      } finally {
        await trace.adapter.close();
      }
    });

    test("a socket lost at EXECUTE sends no release, and the next statement recovers", async () => {
      const trace = await open();
      const internals = trace.cas as unknown as { socket: { destroy(): void } };
      const sendOnSession = trace.cas.sendAndRecvOnSession;
      trace.cas.sendAndRecvOnSession = async (generation, header, payload) => {
        if (payload[0] === CASFunctionCode.EXECUTE) {
          internals.socket.destroy();
        }
        return sendOnSession(generation, header, payload);
      };

      try {
        await assert.rejects(
          trace.adapter.queryPrepared("SELECT ? AS v FROM db_root", [1]),
          QueryError,
        );
        assert.equal(trace.sent.includes(CASFunctionCode.CLOSE_REQ_HANDLE), false);

        trace.cas.sendAndRecvOnSession = sendOnSession;
        assert.deepEqual(await trace.adapter.queryPrepared("SELECT ? AS v FROM db_root", [2]), [
          { v: 2 },
        ]);
      } finally {
        await trace.adapter.close();
      }
    });

    test("a malformed EXECUTE reply drops the session, so the statement cannot commit", async () => {
      const trace = await open((code, response) =>
        code === CASFunctionCode.EXECUTE ? response.subarray(0, 6) : response,
      );
      const observer = createClient(TEST_CONFIG);
      try {
        await observer.query(`DELETE FROM ${ROWS}`);
        await assert.rejects(
          trace.adapter.executePrepared(`INSERT INTO ${ROWS} (id) VALUES (?)`, [1]),
          QueryError,
        );

        assert.equal(trace.cas.isConnected, false);
        assert.deepEqual(await observer.query(`SELECT id FROM ${ROWS}`), []);
      } finally {
        await trace.adapter.close();
        await observer.close();
      }
    });

    test("a transaction that lost its session refuses prepared statements", async () => {
      const trace = await open();
      const internals = trace.cas as unknown as { socket: { destroy(): void } };
      const observer = createClient(TEST_CONFIG);
      try {
        await observer.query(`DELETE FROM ${ROWS}`);
        await trace.adapter.beginTransaction();
        await trace.adapter.executePrepared(`INSERT INTO ${ROWS} (id) VALUES (?)`, [1]);
        internals.socket.destroy();
        await new Promise((resolve) => setImmediate(resolve));

        await assert.rejects(
          trace.adapter.executePrepared(`INSERT INTO ${ROWS} (id) VALUES (?)`, [2]),
          (error: QueryError) => error.kind === "connection-lost",
        );
        await assert.rejects(trace.adapter.commit(), TransactionError);
        assert.deepEqual(await observer.query(`SELECT id FROM ${ROWS}`), []);
      } finally {
        await trace.adapter.close();
        await observer.close();
      }
    });

    test("a deadlock victim at EXECUTE blocks later statements until rollback", async () => {
      const seed = createClient(TEST_CONFIG);
      const first = new NativeCubridAdapter(TEST_CONFIG);
      const second = new NativeCubridAdapter(TEST_CONFIG);
      const update = `UPDATE ${ROWS} SET n = n + 1 WHERE id = ?`;
      try {
        await seed.query(`DELETE FROM ${ROWS}`);
        await seed.query(`INSERT INTO ${ROWS} (id, n) VALUES (1, 0), (2, 0)`);
        await first.connect();
        await second.connect();
        await first.beginTransaction();
        await second.beginTransaction();
        await first.executePrepared(update, [1]);
        await second.executePrepared(update, [2]);

        const results = await Promise.allSettled([
          first.executePrepared(update, [2]),
          new Promise((resolve) => setTimeout(resolve, 200)).then(() =>
            second.executePrepared(update, [1]),
          ),
        ]);
        const failed = results.findIndex((result) => result.status === "rejected");
        const victim = failed === 0 ? first : second;
        const reason = (results[failed] as PromiseRejectedResult).reason as QueryError;

        assert.ok(reason instanceof DeadlockError);
        assert.equal(reason.code, -72);
        await assert.rejects(victim.executePrepared(update, [1]), DeadlockError);
        await victim.rollback();
      } finally {
        await first.rollback().catch(() => undefined);
        await second.rollback().catch(() => undefined);
        await first.close();
        await second.close();
        await seed.close();
      }
    });

    test("a read timeout at EXECUTE stays a ReadTimeoutError and drops the session", async () => {
      const impatient = new NativeCubridAdapter({ ...TEST_CONFIG, readTimeout: 2000 });
      const holder = new NativeCubridAdapter(TEST_CONFIG);
      const update = `UPDATE ${ROWS} SET n = n + 1 WHERE id = ?`;
      try {
        await holder.beginTransaction();
        await holder.executePrepared(update, [1]);
        await impatient.connect();
        await impatient.beginTransaction();

        await assert.rejects(impatient.executePrepared(update, [1]), ReadTimeoutError);
        await assert.rejects(impatient.executePrepared(update, [1]), QueryError);
      } finally {
        await holder.rollback().catch(() => undefined);
        await holder.close();
        await impatient.rollback().catch(() => undefined);
        await impatient.close().catch(() => undefined);
      }
    });

    test("overlapping prepared and literal statements return exactly their own rows", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            i % 2 === 0
              ? client.queryPrepared<{ v: number }>("SELECT ? AS v FROM db_root", [i])
              : client.query<{ v: number }>("SELECT ? AS v FROM db_root", [i]),
          ),
        );
        assert.deepEqual(
          results.map((rows) => rows[0]?.v),
          results.map((_, i) => i),
        );
      } finally {
        await client.close();
      }
    });

    test("drop the tables", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        for (const table of [TYPES, ROWS, AI]) {
          await client.query(`DROP TABLE IF EXISTS ${table}`);
        }
      } finally {
        await client.close();
      }
    });
  });

  test("close is safe to call multiple times", async () => {
    const client = createClient(TEST_CONFIG);
    await client.query("SELECT 1");
    await client.close();
    await client.close(); // Should not throw
  });
});

// ---------------------------------------------------------------------------
// maxConnectionRetryCount against a live broker, reached through a TCP relay
// that starts late and counts connections.
// ---------------------------------------------------------------------------

describe("Integration: maxConnectionRetryCount", { skip: !available }, () => {
  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise((resolve) => probe.close(resolve));
    return port;
  }

  function relay(port: number, counter: { connections: number }): Promise<Server> {
    const server = createServer((client) => {
      counter.connections += 1;
      const upstream = netConnect(TEST_CONFIG.port, TEST_CONFIG.host);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
  }

  test("a client retries until the broker answers, then queries normally", async () => {
    const port = await freePort();
    const counter = { connections: 0 };
    let server: Server | undefined;
    const late = setTimeout(() => void relay(port, counter).then((s) => (server = s)), 300);
    const client = createClient({ ...TEST_CONFIG, port, maxConnectionRetryCount: 6 });

    try {
      const rows = await client.query<{ n: number }>("SELECT 1 AS n FROM db_root");
      assert.equal(rows[0]?.n, 1);
      assert.equal(counter.connections, 1);
    } finally {
      clearTimeout(late);
      await client.close();
      server?.close();
    }
  });

  test("wrong credentials fail at once without a retry", async () => {
    const port = await freePort();
    const counter = { connections: 0 };
    const server = await relay(port, counter);
    const client = createClient({
      ...TEST_CONFIG,
      port,
      password: "definitely-wrong",
      maxConnectionRetryCount: 5,
    });

    try {
      await assert.rejects(() => client.query("SELECT 1 FROM db_root"), QueryError);
      assert.equal(counter.connections, 1);
    } finally {
      await client.close();
      server.close();
    }
  });
});

describe("stream()", { skip: !available }, () => {
  const TABLE = "cc87_stream";
  /** Several server replies of rows, which hold about 16 KiB each. */
  const ROWS = 2000;
  const PADDING = "x".repeat(200);

  async function fillTable(client: ReturnType<typeof createClient>, rows: number): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, pad VARCHAR(2000), b BLOB)`);
    await client.query(
      `INSERT INTO ${TABLE} (id, pad) SELECT ROWNUM, '${PADDING}' ` +
        `FROM db_attribute a, db_attribute b, db_attribute c LIMIT ${rows}`,
    );
  }

  before(async () => {
    const client = createClient(TEST_CONFIG);
    await fillTable(client, ROWS);
    await client.close();
  });

  after(async () => {
    const client = createClient(TEST_CONFIG);
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await client.close();
  });

  async function withStreamTable(
    use: (client: ReturnType<typeof createClient>) => Promise<void>,
    options: { maxLobBytes?: number } = {},
  ): Promise<void> {
    const client = createClient({ ...TEST_CONFIG, ...options });
    try {
      await use(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  /** A lock conflict fails fast here, instead of waiting for the server's default. */
  async function assertTableUnlocked(): Promise<void> {
    const other = createClient(TEST_CONFIG);
    const ddl = other.transaction(async (tx) => {
      await tx.query("SET TRANSACTION LOCK TIMEOUT 3");
      await tx.query(`ALTER TABLE ${TABLE} ADD COLUMN probe${Date.now()} INT`);
    });
    try {
      await ddl;
    } finally {
      await other.close();
    }
  }

  test("reads the same rows as query() across several replies, in order", async () => {
    await withStreamTable(async (client) => {
      const sql = `SELECT id, pad FROM ${TABLE} WHERE id > ? ORDER BY id`;
      const rows: unknown[] = [];

      for await (const row of client.stream(sql, [10])) {
        rows.push(row);
      }

      assert.equal(rows.length, ROWS - 10);
      assert.deepEqual(rows, await client.query(sql, [10]));
    });
  });

  test("the server answers FETCH by reply size, so fetchSize 1 still reads many rows per FETCH", async () => {
    let fetches = 0;
    const client = createClient({
      ...TEST_CONFIG,
      connectionFactory: async (config) => {
        const adapter = new NativeCubridAdapter(config);
        await adapter.connect();
        const cas = (adapter as unknown as { cas: CASConnection }).cas;
        const sendAndRecvOnSession = cas.sendAndRecvOnSession.bind(cas);
        cas.sendAndRecvOnSession = (generation, header, payload) => {
          fetches += payload[0] === CASFunctionCode.FETCH ? 1 : 0;
          return sendAndRecvOnSession(generation, header, payload);
        };
        return adapter;
      },
    });

    try {
      let read = 0;
      for await (const row of client.stream(`SELECT id, pad FROM ${TABLE}`, undefined, {
        fetchSize: 1,
      })) {
        assert.ok(row);
        read += 1;
      }

      assert.equal(read, ROWS);
      // About 16 KiB of 200-byte rows per reply: dozens of rows, not one, per FETCH.
      assert.ok(fetches > 0 && fetches < ROWS / 20, `${fetches} FETCHes for ${ROWS} rows`);
    } finally {
      await client.close();
    }
  });

  test("a break releases the handle and the table lock of the autocommit transaction", async () => {
    await withStreamTable(async (client) => {
      for await (const row of client.stream(`SELECT id FROM ${TABLE} ORDER BY id`)) {
        assert.ok(row);
        break;
      }

      await assertTableUnlocked();
      assert.deepEqual(await client.query("SELECT 1 AS one FROM db_root"), [{ one: 1 }]);
    });
  });

  // #214: query() reads every row, so the server's SELECT stays IN_TRAN until a
  // FETCH fails partway. A FETCH naming a handle the server does not hold is
  // rejected with the reply stream intact, as a real mid-result failure would be.
  test("query(): a FETCH that fails partway releases the table lock of the autocommit transaction", async () => {
    let forged = 0;
    const client = createClient({
      ...TEST_CONFIG,
      fetchSize: 1,
      connectionFactory: async (config) => {
        const adapter = new NativeCubridAdapter(config);
        await adapter.connect();
        const cas = (adapter as unknown as { cas: CASConnection }).cas;
        const sendAndRecvOnSession = cas.sendAndRecvOnSession.bind(cas);
        cas.sendAndRecvOnSession = (generation, header, payload) => {
          if (payload[0] === CASFunctionCode.FETCH) {
            forged += 1;
            const bogus = writeFetch(0x7ffffff0, 1, 1, cas.casInfo);
            return sendAndRecvOnSession(generation, bogus.header, bogus.payload);
          }
          return sendAndRecvOnSession(generation, header, payload);
        };
        return adapter;
      },
    });

    try {
      await assert.rejects(client.query(`SELECT id, pad FROM ${TABLE} ORDER BY id`));
      assert.equal(forged, 1);

      await assertTableUnlocked();
      assert.deepEqual(await client.query("SELECT 1 AS one FROM db_root"), [{ one: 1 }]);
    } finally {
      await client.close();
    }
  });

  test("a throw from the loop body releases the table lock too", async () => {
    await withStreamTable(async (client) => {
      const failure = new Error("the consumer failed");

      await assert.rejects(
        async () => {
          for await (const row of client.stream(`SELECT id FROM ${TABLE} ORDER BY id`)) {
            assert.ok(row);
            throw failure;
          }
        },
        (error) => error === failure,
      );

      await assertTableUnlocked();
    });
  });

  test("an abort releases the table lock while the consumer is away", async () => {
    await withStreamTable(async (client) => {
      const controller = new AbortController();
      const rows = client.stream(`SELECT id FROM ${TABLE} ORDER BY id`, undefined, {
        signal: controller.signal,
      });
      await rows.next();

      controller.abort();
      await client.ping();

      await assertTableUnlocked();
      await assert.rejects(() => rows.next(), { name: "AbortError" });
    });
  });

  test("a live cursor keeps its turn, so no statement closes it with -1012", async () => {
    await withStreamTable(async (client) => {
      let read = 0;
      const others: Array<Promise<unknown>> = [];

      for await (const row of client.stream(`SELECT id FROM ${TABLE} ORDER BY id`)) {
        read += 1;
        assert.equal(row.id, read);
        if (read % 400 === 1) {
          others.push(client.ping(), client.query("SELECT 1 AS one FROM db_root"));
        }
      }

      await Promise.all(others);
      assert.equal(read, ROWS);
    });
  });

  test("a query awaited inside the loop rejects, and the connection keeps working", async () => {
    await withStreamTable(async (client) => {
      await assert.rejects(
        async () => {
          for await (const row of client.stream(`SELECT id FROM ${TABLE}`, undefined, {
            consumerTimeout: 50,
          })) {
            await client.query(`SELECT ${String(row.id)} AS id FROM db_root`);
          }
        },
        (error: QueryError) => error instanceof QueryError && error.kind === "stream-busy",
      );

      await assertTableUnlocked();
      assert.deepEqual(await client.query("SELECT 1 AS one FROM db_root"), [{ one: 1 }]);
    });
  });

  test("transaction() can run inside the loop, on its own connection", async () => {
    await withStreamTable(async (client) => {
      const counts: unknown[] = [];

      for await (const row of client.stream(`SELECT id FROM ${TABLE} ORDER BY id`)) {
        if (row.id === 5) {
          counts.push(await client.transaction((tx) => tx.query("SELECT 1 AS one FROM db_root")));
        }
      }

      assert.deepEqual(counts, [[{ one: 1 }]]);
    });
  });

  test("inside a transaction, a break leaves its work open for the commit", async () => {
    await withStreamTable(async (client) => {
      await client.beginTransaction();
      await client.query(`UPDATE ${TABLE} SET pad = 'changed' WHERE id = 1`);

      for await (const row of client.stream(`SELECT id, pad FROM ${TABLE} ORDER BY id`)) {
        assert.equal(row.pad, "changed");
        break;
      }

      await client.rollback();
      assert.deepEqual(await client.query(`SELECT pad FROM ${TABLE} WHERE id = 1`), [
        { pad: PADDING },
      ]);
    });
  });

  test("LOB content across several replies, without the read closing the cursor", async () => {
    await withStreamTable(async (client) => {
      await client.query(`UPDATE ${TABLE} SET b = BIT_TO_BLOB(X'0102') WHERE id <= 500`);
      let read = 0;

      for await (const row of client.stream(
        `SELECT id, b FROM ${TABLE} WHERE id <= 500 ORDER BY id`,
      )) {
        read += 1;
        assert.equal(row.id, read);
        assert.deepEqual(row.b, Buffer.from([1, 2]));
      }

      assert.equal(read, 500);
      await assertTableUnlocked();
    });
  });

  test("maxLobBytes limits one row, and a row over it fails with the connection usable", async () => {
    await withStreamTable(
      async (client) => {
        await client.query(`UPDATE ${TABLE} SET b = BIT_TO_BLOB(X'0102') WHERE id <= 500`);
        await client.query(`UPDATE ${TABLE} SET b = BIT_TO_BLOB(X'010203') WHERE id = 5`);
        const sql = `SELECT id, b FROM ${TABLE} WHERE id <= 5 ORDER BY id`;
        await assert.rejects(() => client.query(sql), QueryError);
        let read = 0;

        await assert.rejects(
          async () => {
            for await (const row of client.stream(sql)) {
              assert.ok(row);
              read += 1;
            }
          },
          (error: QueryError) => (error.cause as Error).cause instanceof Error,
        );

        assert.equal(read, 4);
        await assertTableUnlocked();
        assert.deepEqual(await client.query("SELECT 1 AS one FROM db_root"), [{ one: 1 }]);
      },
      { maxLobBytes: 2 },
    );
  });

  test("a break after LOB reads releases the table lock", async () => {
    await withStreamTable(async (client) => {
      await client.query(`UPDATE ${TABLE} SET b = BIT_TO_BLOB(X'0102') WHERE id <= 500`);

      for await (const row of client.stream(`SELECT id, b FROM ${TABLE} ORDER BY id`)) {
        assert.deepEqual(row.b, Buffer.from([1, 2]));
        break;
      }

      await assertTableUnlocked();
    });
  });

  test("a failed statement rejects the first read and the connection keeps working", async () => {
    await withStreamTable(async (client) => {
      await assert.rejects(() => client.stream("SELECT nope FROM nowhere").next(), QueryError);
      assert.deepEqual(await client.query("SELECT 1 AS one FROM db_root"), [{ one: 1 }]);
    });
  });

  test("memory stays bounded on a result much larger than the limit asserted", async () => {
    setFlagsFromString("--expose-gc");
    const collectGarbage = runInNewContext("gc") as () => void;
    const LARGE = 200_000;
    const WIDE = "y".repeat(1000);
    const HEAP_GROWTH_LIMIT = 16 * 1024 * 1024;

    await withStreamTable(async (client) => {
      await fillTable(client, LARGE);
      await client.query(`UPDATE ${TABLE} SET pad = '${WIDE}'`);
      collectGarbage();
      const baseline = process.memoryUsage().heapUsed;
      let peak = 0;
      let read = 0;
      let bytes = 0;

      for await (const row of client.stream(`SELECT id, pad FROM ${TABLE}`)) {
        read += 1;
        bytes += String(row.pad).length;
        if (read % 20_000 === 0) {
          collectGarbage();
          peak = Math.max(peak, process.memoryUsage().heapUsed - baseline);
        }
      }

      assert.equal(read, LARGE);
      assert.ok(bytes > 10 * HEAP_GROWTH_LIMIT);
      assert.ok(peak < HEAP_GROWTH_LIMIT, `heap grew by ${peak} bytes`);
    });
  });
});

// ---------------------------------------------------------------------------
// Per-query options: AbortSignal and readTimeout (#150)
// ---------------------------------------------------------------------------

describe("Integration: per-query AbortSignal and readTimeout (#150)", { skip: !available }, () => {
  const SLOW = "SELECT SLEEP(3) AS slept FROM db_root";
  const QUICK = "SELECT 1 AS one FROM db_root";

  function abortAfter(ms: number, reason: unknown): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(reason), ms);
    return controller.signal;
  }

  test("an abort stops a slow statement quickly, and the next query on the client works", async () => {
    const client = createClient(TEST_CONFIG);
    const reason = new Error("stopped by the test");

    try {
      await client.query(QUICK);
      const started = Date.now();
      await assert.rejects(
        client.query(SLOW, [], { signal: abortAfter(100, reason) }),
        (error) => error === reason,
      );
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms`);

      assert.deepEqual(await client.query(QUICK), [{ one: 1 }]);
    } finally {
      await client.close();
    }
  });

  test("a per-query readTimeout stops a slow statement, and the next query works", async () => {
    const client = createClient({ ...TEST_CONFIG, readTimeout: 10_000 });

    try {
      const started = Date.now();
      await assert.rejects(
        client.query(SLOW, [], { readTimeout: 300 }),
        (error: unknown) => error instanceof ReadTimeoutError && error.timeoutMs === 300,
      );
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms`);

      assert.deepEqual(await client.query(QUICK), [{ one: 1 }]);
    } finally {
      await client.close();
    }
  });

  test("an abort while queued sends nothing and leaves the running statement alone", async () => {
    const client = createClient(TEST_CONFIG);
    const reason = new Error("not needed any more");
    const controller = new AbortController();

    try {
      const running = client.query("SELECT SLEEP(1) AS slept FROM db_root");
      const queued = client.query(QUICK, [], { signal: controller.signal });
      controller.abort(reason);

      await assert.rejects(queued, (error) => error === reason);
      assert.deepEqual(await running, [{ slept: 0 }]);
      assert.deepEqual(await client.query(QUICK), [{ one: 1 }]);
    } finally {
      await client.close();
    }
  });

  test("an abort inside a transaction scope loses the transaction's work", async () => {
    const TABLE = "cc_query_abort";
    const client = createClient(TEST_CONFIG);
    const reason = new Error("stopped by the test");

    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await client.query(`CREATE TABLE ${TABLE} (id INT)`);

      const scope = await client.beginTransactionScope();
      await scope.execute(`INSERT INTO ${TABLE} VALUES (1)`);
      await assert.rejects(
        scope.query(SLOW, [], { signal: abortAfter(100, reason) }),
        (error) => error === reason,
      );
      await assert.rejects(scope.query(QUICK), TransactionError);
      await scope.rollback().catch(() => undefined);

      // COUNT(*) is a BIGINT on 11.x and an INT on 10.2.
      const [row] = await client.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
      assert.equal(Number(row?.n), 0);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
      await client.close();
    }
  });
});

describe("Integration: executeMany (#86)", { skip: !available }, () => {
  const TABLE = "cc_exec_many";
  const INSERT = `INSERT INTO ${TABLE} (id, v) VALUES (?, ?)`;

  async function withTable<T>(
    columns: string,
    run: (client: ReturnType<typeof createClient>) => Promise<T>,
  ): Promise<T> {
    const client = createClient(TEST_CONFIG);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await client.query(`CREATE TABLE ${TABLE} (${columns})`);
      return await run(client);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
      await client.close();
    }
  }

  /** Counted on a separate client, so only committed rows are seen. */
  async function committedRows(where = ""): Promise<number> {
    const other = createClient(TEST_CONFIG);
    try {
      // COUNT(*) is a BIGINT on 11.x and an INT on 10.2.
      const [row] = await other.query(`SELECT COUNT(*) AS n FROM ${TABLE} ${where}`);
      return Number(row?.n);
    } finally {
      await other.close();
    }
  }

  const sets = (from: number, to: number): Array<[number, string]> =>
    Array.from({ length: to - from + 1 }, (_, index) => [from + index, `v${from + index}`]);

  test("inserts 1000 rows in one batch and commits them", async () => {
    await withTable("id INT PRIMARY KEY, v VARCHAR(20)", async (client) => {
      const result = await client.executeMany(INSERT, sets(1, 1000));

      assert.equal(result.affectedRows, 1000);
      assert.equal(result.results.length, 1000);
      assert.ok(result.results.every((count) => count === 1));
      assert.equal(await committedRows(), 1000);
      const [row] = await client.query(`SELECT SUM(id) AS s, MAX(v) AS m FROM ${TABLE}`);
      assert.equal(Number(row?.s), 500_500);
    });
  });

  test("a unique violation at one row rolls back the whole autocommit batch", async () => {
    await withTable("id INT PRIMARY KEY, v VARCHAR(20)", async (client) => {
      await client.execute(`INSERT INTO ${TABLE} VALUES (500, 'existing')`);

      await assert.rejects(client.executeMany(INSERT, sets(1, 1000)), (error: unknown) => {
        assert.ok(error instanceof ConstraintError);
        assert.equal(error.kind, "unique-violation");
        assert.equal(error.batch?.rolledBack, true);
        assert.equal(error.batch?.executed, 1000);
        assert.deepEqual(
          error.batch?.failures.map(({ index, code }) => [index, code]),
          [[499, error.code]],
        );
        assert.equal(error.batch?.results[499], null);
        assert.equal(error.batch?.results[500], 1);
        return true;
      });

      assert.equal(await committedRows(), 1);
      // The shared connection is in autocommit again and nothing of the batch was left behind.
      await client.execute(`INSERT INTO ${TABLE} VALUES (1, 'after')`);
      assert.equal(await committedRows(), 2);
    });
  });

  test("inside a scope a failed set leaves the transaction, and its other sets, to the caller", async () => {
    await withTable("id INT PRIMARY KEY, v VARCHAR(20)", async (client) => {
      const scope = await client.beginTransactionScope();
      await scope.execute(`INSERT INTO ${TABLE} VALUES (0, 'first')`);

      await assert.rejects(
        scope.executeMany(INSERT, [
          [1, "a"],
          [0, "dup"],
          [2, "b"],
        ]),
        (error: unknown) => {
          assert.ok(error instanceof TransactionError);
          assert.equal(error.kind, "unique-violation");
          assert.equal(error.batch?.rolledBack, false);
          assert.deepEqual(error.batch?.results, [1, null, 1]);
          assert.equal(error.batch?.failures[0]?.index, 1);
          return true;
        },
      );

      // The transaction is still open and holds every set that succeeded.
      const [inside] = await scope.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
      assert.equal(Number(inside?.n), 3);
      assert.equal(await committedRows(), 0);

      await scope.commit();
      assert.equal(await committedRows(), 3);
    });
  });

  test("transaction() rolls back a callback that lets a failed batch through", async () => {
    await withTable("id INT PRIMARY KEY, v VARCHAR(20)", async (client) => {
      await assert.rejects(
        client.transaction(async (tx) => {
          await tx.executeMany(INSERT, sets(1, 10));
          await tx.executeMany(INSERT, sets(10, 20));
        }),
        (error: unknown) => error instanceof TransactionError && error.batch !== undefined,
      );
      assert.equal(await committedRows(), 0);
    });
  });

  test("binds mixed types and NULL in every set", async () => {
    await withTable(
      "id INT PRIMARY KEY, b BIGINT, d DOUBLE, s VARCHAR(50), t DATETIME, n NUMERIC(30,0), x BIT VARYING(64)",
      async (client) => {
        const when = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6));
        const result = await client.executeMany(
          `INSERT INTO ${TABLE} (id, b, d, s, t, n, x) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            [
              1,
              9007199254740991,
              1.5,
              "한글 text",
              when,
              12345678901234567890123n,
              Buffer.from("abcd", "hex"),
            ],
            [2, null, null, null, null, null, null],
            [3, -1n, -0.25, "", when, -5n, Buffer.from([1])],
          ],
        );
        assert.deepEqual(result, { affectedRows: 3, results: [1, 1, 1] });

        const utc = createClient({ ...TEST_CONFIG, timezone: "utc" });
        try {
          const rows = await utc.query(`SELECT * FROM ${TABLE} ORDER BY id`);
          assert.equal(rows.length, 3);
          assert.equal(rows[0]?.b, 9007199254740991n);
          assert.equal(rows[0]?.d, 1.5);
          assert.equal(rows[0]?.s, "한글 text");
          assert.deepEqual(rows[0]?.t, when);
          assert.equal(String(rows[0]?.n), "12345678901234567890123");
          assert.deepEqual(rows[0]?.x, Buffer.from("abcd", "hex"));
          assert.deepEqual(
            Object.entries(rows[1] ?? {}).filter(([key, value]) => key !== "id" && value !== null),
            [],
          );
          assert.equal(rows[2]?.b, -1n);
          assert.equal(rows[2]?.s, "");
          assert.equal(String(rows[2]?.n), "-5");
        } finally {
          await utc.close();
        }
      },
    );
  });

  test("a batch over the request size is split, committed together or not at all", async () => {
    await withTable("id INT PRIMARY KEY, v STRING", async (client) => {
      const big = (from: number, count: number): Array<[number, string]> =>
        Array.from({ length: count }, (_, index) => [from + index, "x".repeat(330_000)]);

      assert.deepEqual(await client.executeMany(INSERT, big(1, 7)), {
        affectedRows: 7,
        results: [1, 1, 1, 1, 1, 1, 1],
      });
      assert.equal(await committedRows(), 7);

      // Set 4 of 6 is in the second request; the first request's sets are rolled back too.
      await assert.rejects(
        client.executeMany(INSERT, [...big(100, 4), [1, "dup"], ...big(200, 1)]),
        (error: unknown) => {
          assert.ok(error instanceof ConstraintError);
          assert.equal(error.batch?.failures[0]?.index, 4);
          assert.deepEqual(error.batch?.results, [1, 1, 1, 1, null, 1]);
          return true;
        },
      );
      assert.equal(await committedRows(), 7);
    });
  });

  test("updates report each set's own count", async () => {
    await withTable("id INT PRIMARY KEY, v VARCHAR(20)", async (client) => {
      await client.executeMany(INSERT, sets(1, 5));
      assert.deepEqual(
        await client.executeMany(`UPDATE ${TABLE} SET v = ? WHERE id > ?`, [
          ["x", 3],
          ["y", 99],
          ["z", 0],
        ]),
        { affectedRows: 7, results: [2, 0, 5] },
      );
    });
  });

  test("refuses a SELECT, a second statement and a wrong marker count, then works", async () => {
    await withTable("id INT PRIMARY KEY, v VARCHAR(20)", async (client) => {
      for (const [sql, paramSets, pattern] of [
        [`SELECT v FROM ${TABLE} WHERE id = ?`, [[1], [2]], /SELECT/],
        [`${INSERT}; DELETE FROM ${TABLE}`, [[1, "a"]], /more than one/],
        [INSERT, [[1]], /Parameter count mismatch/],
        [INSERT, [[1, "a", "extra"]], /Parameter count mismatch/],
        [`INSERT INTO ${TABLE} VALUES (1, 'a')`, [[]], /marker/],
      ] as const) {
        await assert.rejects(
          client.executeMany(sql, paramSets as unknown as QueryParams[]),
          (error: unknown) => {
            assert.ok(error instanceof QueryError);
            let root: unknown = error;
            while (root instanceof Error && root.cause instanceof Error) {
              root = root.cause;
            }
            assert.match((root as Error).message, pattern);
            return true;
          },
        );
      }
      assert.equal(await committedRows(), 0);

      assert.deepEqual(await client.executeMany(`${INSERT};`, [[1, "a"]]), {
        affectedRows: 1,
        results: [1],
      });
      assert.deepEqual(await client.executeMany(INSERT, []), { affectedRows: 0, results: [] });
    });
  });

  test("execute() still reports the right lastInsertId after a batch", async () => {
    await withTable("id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(20)", async (client) => {
      await client.execute(`INSERT INTO ${TABLE} (v) VALUES ('first')`);
      await client.executeMany(`INSERT INTO ${TABLE} (v) VALUES (?)`, [["a"], ["b"], ["c"]]);
      const result = await client.execute(`INSERT INTO ${TABLE} (v) VALUES ('last')`);
      assert.equal(result.lastInsertId, 5);
    });
  });

  test("an abort while a set waits for a lock commits nothing", async () => {
    await withTable("id INT PRIMARY KEY, v VARCHAR(20)", async (client) => {
      await client.executeMany(INSERT, sets(1, 2));
      const holder = await client.beginTransactionScope();
      await holder.execute(`UPDATE ${TABLE} SET v = 'held' WHERE id = 2`);
      const reason = new Error("stopped by the test");
      const controller = new AbortController();
      setTimeout(() => controller.abort(reason), 300);

      try {
        await assert.rejects(
          client.executeMany(
            `UPDATE ${TABLE} SET v = ? WHERE id = ?`,
            [
              ["batch", 1],
              ["batch", 2],
            ],
            { signal: controller.signal },
          ),
          (error) => error === reason,
        );
      } finally {
        await holder.rollback();
      }

      assert.equal(await committedRows("WHERE v = 'batch'"), 0);
      assert.deepEqual(await client.executeMany(INSERT, [[3, "c"]]), {
        affectedRows: 1,
        results: [1],
      });
    });
  });
});

describe("Integration: writing BLOB and CLOB with LOB_NEW and LOB_WRITE (#103)", {
  skip: !available,
}, () => {
  const TABLE = "cc103_lob_write";
  const INSERT = `INSERT INTO ${TABLE} (id, b, c) VALUES (?, ?, ?)`;
  const MIB8 = 8 * 1024 * 1024;
  const CHUNK = 128 * 1024;

  /** Bytes that differ at every offset of a 251-byte cycle, so a misplaced chunk shows. */
  function pattern(length: number): Buffer {
    const bytes = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
      bytes[i] = i % 251;
    }
    return bytes;
  }

  /** `content` in pieces of `size` bytes, as a file stream would yield them. */
  function piecesOf(content: Buffer, size: number): Readable {
    const pieces: Buffer[] = [];
    for (let at = 0; at < content.length; at += size) {
      pieces.push(content.subarray(at, at + size));
    }
    return Readable.from(pieces);
  }

  async function withLobTable<T>(
    run: (client: ReturnType<typeof createClient>) => Promise<T>,
  ): Promise<T> {
    const client = createClient(TEST_CONFIG);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, b BLOB, c CLOB)`);
      return await run(client);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
      await client.close();
    }
  }

  /** Whether any error in the cause chain of `error` has `message`. */
  function causedBy(error: unknown, message: string): boolean {
    for (let e = error; e instanceof Error; e = e.cause) {
      if (e.message === message) {
        return true;
      }
    }
    return false;
  }

  /** Counted on a separate client, so only committed rows are seen. */
  async function committedIds(): Promise<number[]> {
    const other = createClient(TEST_CONFIG);
    try {
      return (await other.query<{ id: number }>(`SELECT id FROM ${TABLE} ORDER BY id`)).map(
        (row) => row.id,
      );
    } finally {
      await other.close();
    }
  }

  test("an 8 MiB BLOB from a Buffer and from a Readable reads back byte for byte", async () => {
    await withLobTable(async (client) => {
      const content = pattern(MIB8);
      await client.executePrepared(INSERT, [1, blob(content), null]);
      await client.executePrepared(INSERT, [2, blob(piecesOf(content, 65_536 + 7)), null]);

      const rows = await client.query<{ id: number; b: Buffer }>(
        `SELECT id, b FROM ${TABLE} ORDER BY id`,
      );
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.b.length, MIB8);
        assert.ok(row.b.equals(content), `row ${row.id} differs`);
      }
      // The server measures the stored size itself.
      const [sizes] = await client.query<{ n: number }>(
        `SELECT MIN(BIT_LENGTH(b)) AS n FROM ${TABLE}`,
      );
      assert.equal(Number(sizes?.n), MIB8 * 8);
    });
  });

  test("a CLOB with 3- and 4-byte characters across the 128 KiB boundary reads back unchanged", async () => {
    await withLobTable(async (client) => {
      // Each variant puts a different byte of a multibyte character on the boundary.
      const texts = [1, 2, 3].map(
        (lead) => `${"a".repeat(CHUNK - lead)}\uD55C\u{1F600}\uAE00\u{20000}${"z".repeat(5)}`,
      );
      for (const [index, text] of texts.entries()) {
        const source =
          index === 2 ? clob(Readable.from(text.match(/[\s\S]{1,999}/gu) ?? [])) : clob(text);
        await client.executePrepared(INSERT, [index + 1, null, source]);
      }
      await client.executePrepared(INSERT, [4, null, clob(Buffer.from(texts[0]!, "utf-8"))]);

      const rows = await client.query<{ c: string }>(`SELECT c FROM ${TABLE} ORDER BY id`);
      assert.deepEqual(
        rows.map((row) => row.c),
        [...texts, texts[0]],
      );
      // The server stored the UTF-8 bytes, not a converted or truncated text.
      const [length] = await client.query<{ n: number }>(
        `SELECT OCTET_LENGTH(CLOB_TO_CHAR(c)) AS n FROM ${TABLE} WHERE id = 1`,
      );
      assert.equal(Number(length?.n), Buffer.byteLength(texts[0]!, "utf-8"));
    });
  });

  test("blob() of an empty Buffer is an empty BLOB, and null is NULL", async () => {
    await withLobTable(async (client) => {
      await client.executePrepared(INSERT, [1, blob(Buffer.alloc(0)), clob("")]);
      await client.executePrepared(INSERT, [2, null, null]);

      assert.deepEqual(await client.query(`SELECT id, b, c FROM ${TABLE} ORDER BY id`), [
        { id: 1, b: Buffer.alloc(0), c: "" },
        { id: 2, b: null, c: null },
      ]);
      assert.deepEqual(await client.query(`SELECT id FROM ${TABLE} WHERE b IS NULL ORDER BY id`), [
        { id: 2 },
      ]);
    });
  });

  test("an autocommit statement that fails after a LOB_WRITE rolls back and the session is reused", async () => {
    await withLobTable(async (client) => {
      await client.executePrepared(INSERT, [1, blob(pattern(10)), null]);

      // The upload completes, then EXECUTE fails on the duplicate key.
      await assert.rejects(
        client.executePrepared(INSERT, [1, blob(pattern(3 * CHUNK)), null]),
        (error: unknown) => error instanceof ConstraintError,
      );
      // The source fails after its first chunk was written.
      async function* failing(): AsyncGenerator<Buffer> {
        yield pattern(CHUNK);
        throw new Error("source failed");
      }
      await assert.rejects(
        client.executePrepared(INSERT, [2, blob(failing()), null]),
        (error: unknown) => error instanceof QueryError && causedBy(error, "source failed"),
      );

      assert.deepEqual(await committedIds(), [1]);
      await client.executePrepared(INSERT, [3, blob(pattern(5)), clob("after")]);
      assert.deepEqual(await client.query(`SELECT id, b, c FROM ${TABLE} WHERE id = 3`), [
        { id: 3, b: pattern(5), c: "after" },
      ]);
      assert.deepEqual(await committedIds(), [1, 3]);
    });
  });

  test("scope.rollback() leaves no row and no LOB behind", async () => {
    await withLobTable(async (client) => {
      const scope = await client.beginTransactionScope();
      await scope.executePrepared(INSERT, [1, blob(pattern(2 * CHUNK)), clob("rolled back")]);
      assert.equal((await scope.query(`SELECT id FROM ${TABLE}`)).length, 1);
      await scope.rollback();

      assert.deepEqual(await committedIds(), []);
    });
  });

  test("an abort partway through the upload rejects with its reason and stores nothing", async () => {
    await withLobTable(async (client) => {
      const controller = new AbortController();
      const reason = new Error("upload stopped by the test");
      async function* slow(): AsyncGenerator<Buffer> {
        yield pattern(CHUNK);
        yield pattern(CHUNK);
        controller.abort(reason);
        // A source that never yields again: only the signal can end the wait.
        await new Promise(() => undefined);
      }

      const started = Date.now();
      await assert.rejects(
        client.executePrepared(INSERT, [1, blob(slow()), null], { signal: controller.signal }),
        (error: unknown) => error === reason,
      );
      assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);

      assert.deepEqual(await committedIds(), []);
      await client.executePrepared(INSERT, [2, blob(pattern(4)), null]);
      assert.deepEqual(await committedIds(), [2]);
    });
  });

  test("an abort while a LOB_WRITE is in flight retires the socket and the client recovers", async () => {
    await withLobTable(async (client) => {
      const controller = new AbortController();
      const reason = new Error("aborted mid-write");
      const content = pattern(MIB8);
      // Abort as soon as the upload has been running for a moment.
      setTimeout(() => controller.abort(reason), 20);

      await assert.rejects(
        client.executePrepared(INSERT, [1, blob(content), null], { signal: controller.signal }),
        (error: unknown) => error === reason,
      );

      assert.deepEqual(await committedIds(), []);
      await client.executePrepared(INSERT, [2, blob(pattern(4)), null]);
      assert.deepEqual(await committedIds(), [2]);
    });
  });

  test("a failed upload inside a transaction leaves the transaction to the caller, who commits", async () => {
    await withLobTable(async (client) => {
      async function* failing(): AsyncGenerator<Buffer> {
        yield pattern(CHUNK);
        throw new Error("source failed");
      }

      await client.transaction(async (tx) => {
        await tx.executePrepared(INSERT, [1, blob(pattern(CHUNK + 1)), clob("kept")]);
        await assert.rejects(tx.executePrepared(INSERT, [2, blob(failing()), null]), (error) =>
          causedBy(error, "source failed"),
        );
        await tx.executePrepared(INSERT, [3, null, clob("also kept")]);
      });

      assert.deepEqual(await committedIds(), [1, 3]);
      const rows = await client.query<{ id: number; b: Buffer | null; c: string }>(
        `SELECT id, b, c FROM ${TABLE} ORDER BY id`,
      );
      assert.ok(rows[0]!.b?.equals(pattern(CHUNK + 1)));
      assert.deepEqual(
        rows.map((row) => row.c),
        ["kept", "also kept"],
      );
    });
  });

  test("blob() on a literal method is refused with a TypeError and nothing is stored", async () => {
    await withLobTable(async (client) => {
      await assert.rejects(
        client.query(INSERT, [1, blob(pattern(3)) as never, null]),
        (error: unknown) => error instanceof TypeError,
      );
      assert.deepEqual(await committedIds(), []);
    });
  });
});

describe("Integration: negative literal parameters (#242)", { skip: !available }, () => {
  const TABLE = "cc_literal_242";

  async function withRows<T>(run: (client: ReturnType<typeof createClient>) => Promise<T>) {
    const client = createClient(TEST_CONFIG);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, b INT)`);
      await client.query(`INSERT INTO ${TABLE} VALUES (1, 10), (2, 10), (3, 10)`);
      return await run(client);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
      await client.close();
    }
  }

  async function rows(client: ReturnType<typeof createClient>): Promise<Array<[number, number]>> {
    const result = await client.query<{ id: number; b: number }>(
      `SELECT id, b FROM ${TABLE} ORDER BY id`,
    );
    return result.map((row) => [row.id, row.b]);
  }

  test("an UPDATE with b-? and a trailing WHERE changes only the matching row", async () => {
    for (const value of [-1, -1n]) {
      await withRows(async (client) => {
        // With `b--1` the rest of the line, WHERE included, would be a comment.
        const result = await client.execute(`UPDATE ${TABLE} SET b = b-? WHERE id = ?`, [value, 2]);
        assert.equal(result.affectedRows, 1);
        assert.deepEqual(await rows(client), [
          [1, 10],
          [2, 11],
          [3, 10],
        ]);

        await client.query(`UPDATE ${TABLE} SET b = b-? WHERE id = ?`, [value, 3]);
        assert.deepEqual(await rows(client), [
          [1, 10],
          [2, 11],
          [3, 11],
        ]);
      });
    }
  });

  test("a DELETE with id > 0-? and a trailing condition deletes only the matching row", async () => {
    for (const value of [-1, -1n]) {
      await withRows(async (client) => {
        // `id > 0--1 AND id = ?` would read `id > 0` and delete every row.
        const result = await client.execute(`DELETE FROM ${TABLE} WHERE id > 0-? AND id = ?`, [
          value,
          2,
        ]);
        assert.equal(result.affectedRows, 1);
        assert.deepEqual(await rows(client), [
          [1, 10],
          [3, 10],
        ]);
      });
    }
  });

  test("unary and binary minus next to a negative value compute what was written", async () => {
    const client = createClient(TEST_CONFIG);
    try {
      for (const [value, expected] of [
        [-1, { a: 6, b: 1, c: 0, d: 5, e: -5 }],
        [-1n, { a: 6, b: 1, c: 0, d: 5, e: -5 }],
        [-2.5, { a: 7.5, b: 2.5, c: 0, d: 12.5, e: -2 }],
      ] as const) {
        const [row] = await client.query(
          "SELECT 5-? AS a, -? AS b, ?-? AS c, 5*-? AS d, 5/? AS e FROM db_root",
          [value, value, value, value, value, value],
        );
        assert.deepEqual(
          Object.fromEntries(Object.entries(row!).map(([key, v]) => [key, Number(v)])),
          expected,
        );
      }
      const [min] = await client.query("SELECT ? AS v FROM db_root", [-(2n ** 63n)]);
      assert.equal(BigInt(String(min!.v)), -(2n ** 63n));
    } finally {
      await client.close();
    }
  });

  test("NaN, Infinity, an invalid Date, arrays and objects are refused and change nothing", async () => {
    await withRows(async (client) => {
      for (const value of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        new Date(Number.NaN),
        [1, 2],
        { toString: () => "0 OR 1=1" },
      ]) {
        await assert.rejects(
          client.execute(`DELETE FROM ${TABLE} WHERE id = ?`, [value as unknown as QueryParam]),
          QueryError,
        );
        await assert.rejects(
          client.query(`UPDATE ${TABLE} SET b = ? WHERE id = 1`, [value as unknown as QueryParam]),
          QueryError,
        );
      }
      assert.deepEqual(await rows(client), [
        [1, 10],
        [2, 10],
        [3, 10],
      ]);
    });
  });
});

describe("Integration: where a ? is a marker (#243)", { skip: !available }, () => {
  const TABLE = "cc_lexer_243";
  type Client = ReturnType<typeof createClient>;

  async function withRows<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const client = createClient(TEST_CONFIG);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, v VARCHAR(100))`);
      await client.query(`INSERT INTO ${TABLE} VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
      return await run(client);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
      await client.close();
    }
  }

  async function rows(client: Client): Promise<Array<[number, string]>> {
    const result = await client.query<{ id: number; v: string }>(
      `SELECT id, v FROM ${TABLE} ORDER BY id`,
    );
    return result.map((row) => [row.id, row.v]);
  }

  const UNCHANGED: Array<[number, string]> = [
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ];

  function rootCause(error: unknown): Error {
    let current = error as Error;
    while (current.cause instanceof Error) {
      current = current.cause;
    }
    return current;
  }

  /** `true` with the CUBRID default no_backslash_escapes=yes. */
  async function noBackslashEscapes(client: Client): Promise<boolean> {
    const [row] = await client.query("SELECT CHAR_LENGTH('\\\\') AS n FROM db_root");
    return Number(row?.n) === 2;
  }

  test("an UPDATE with ? in comments and quotes before its WHERE changes only that row", async () => {
    await withRows(async (client) => {
      const result = await client.execute(
        `UPDATE ${TABLE} SET v = ? /* ? */ WHERE id = ? AND v <> '?' // ?\n AND v <> ?`,
        ["x", 2, "zzz"],
      );
      assert.equal(result.affectedRows, 1);
      assert.deepEqual(await rows(client), [
        [1, "a"],
        [2, "x"],
        [3, "c"],
      ]);

      // CR ends the comment on the server too, so the last ? is bound.
      await client.execute(`UPDATE ${TABLE} SET v = ? WHERE id = ? -- note ?\r AND v <> ?`, [
        "y",
        3,
        "zzz",
      ]);
      assert.deepEqual(await rows(client), [
        [1, "a"],
        [2, "x"],
        [3, "y"],
      ]);
    });
  });

  test("a DELETE with a trailing WHERE and an injection payload deletes only what it names", async () => {
    await withRows(async (client) => {
      const payload = "x' OR 1=1 --";
      const none = await client.execute(`DELETE FROM ${TABLE} WHERE v = ? -- ?`, [payload]);
      assert.equal(none.affectedRows, 0);
      assert.deepEqual(await rows(client), UNCHANGED);

      const one = await client.execute(
        `DELETE FROM ${TABLE} WHERE v = 'b' AND id = ? /* /* ? */ AND 1 = ?`,
        [2, 1],
      );
      assert.equal(one.affectedRows, 1);
      assert.deepEqual(await rows(client), [
        [1, "a"],
        [3, "c"],
      ]);
    });
  });

  test("too few or too many values are refused and change nothing", async () => {
    await withRows(async (client) => {
      for (const [sql, params] of [
        [`DELETE FROM ${TABLE} WHERE id = ?`, [1, 2]],
        [`UPDATE ${TABLE} SET v = ? WHERE id = ?`, ["z"]],
        [`DELETE FROM ${TABLE} WHERE id = 1 // ?`, [1]],
        [`DELETE FROM ${TABLE} WHERE v = '?'`, [1]],
        ["SELECT ? FROM db_root", [1, 2]],
      ] as const) {
        await assert.rejects(client.execute(sql, params), (error: unknown) => {
          assert.ok(error instanceof QueryError);
          assert.match(rootCause(error).message, /Parameter count mismatch/, sql);
          return true;
        });
      }
      assert.deepEqual(await rows(client), UNCHANGED);
    });
  });

  test("'it\\'s' with an injection payload follows the server's backslash mode", async () => {
    await withRows(async (client) => {
      const payload = "x' OR 1=1 --";
      const sql = `SELECT 'it\\'s' AS a, ? AS b FROM ${TABLE} WHERE id = 1`;
      if (await noBackslashEscapes(client)) {
        // 'it\' is a string and s' ... another: no marker for the value. The server
        // agrees that the text is not one valid statement.
        await assert.rejects(client.query(sql, [payload]), (error: unknown) => {
          assert.ok(error instanceof QueryError);
          assert.match(rootCause(error).message, /Parameter count mismatch/);
          return true;
        });
        await assert.rejects(client.query(sql.replace("?", "'x'")), (error: unknown) => {
          assert.ok(error instanceof SqlSyntaxError);
          assert.equal(error.code, -493);
          return true;
        });
      } else {
        const [row] = await client.query(sql, [payload]);
        assert.deepEqual(row, { a: "it's", b: payload });
        // "a\" is an identifier with ansi_quotes=yes and an unterminated string with
        // ansi_quotes=no, which the client cannot see, so it refuses to guess.
        await assert.rejects(
          client.query(`DELETE FROM ${TABLE} WHERE v = "a\\" OR id = ?`, [1]),
          (error: unknown) => {
            assert.ok(error instanceof QueryError);
            assert.match(rootCause(error).message, /ansi_quotes/);
            return true;
          },
        );
      }
      assert.deepEqual(await rows(client), UNCHANGED);
    });
  });

  test("doubled delimiters, nested-looking comments, // comments and UTF-8 bind only real markers", async () => {
    const client = createClient(TEST_CONFIG);
    try {
      const [row] = await client.query(
        "// leading ?\nSELECT 'it''s ?' AS a, ? AS b, 1 AS \"x\"\"y\", 1 AS `y``z`, " +
          "/* /* ? */ ? AS c, '한글 ?' AS 이름 FROM db_root -- ?",
        ["값 ?", -1],
      );
      assert.deepEqual(
        Object.fromEntries(Object.entries(row!).map(([key, value]) => [key, String(value)])),
        { a: "it's ?", b: "값 ?", 'x"y': "1", "y`z": "1", c: "-1", 이름: "한글 ?" },
      );

      // The broker counts a ? inside a quoted identifier as a host variable of its
      // own (-1007, bind count), although the grammar reads it as part of the name.
      for (const name of ['"x""?"', "`y``?`", "[z?]"]) {
        await assert.rejects(client.query(`SELECT ? AS ${name} FROM db_root`, [1]), {
          code: -1007,
        });
      }
    } finally {
      await client.close();
    }
  });

  test("a session that changes no_backslash_escapes is measured again before the next value", async () => {
    const adapter = new NativeCubridAdapter(TEST_CONFIG);
    const value = "\\' OR 1=1 -- ";
    try {
      for (const mode of ["no", "yes", "no"]) {
        // The first statement measures the mode; SET then changes it on this session.
        assert.deepEqual(await adapter.query("SELECT ? AS v FROM db_root", [value]), [
          { v: value },
        ]);
        await adapter.query(`SET SYSTEM PARAMETERS 'no_backslash_escapes=${mode}'`);
        assert.deepEqual(await adapter.query("SELECT ? AS v FROM db_root", [value]), [
          { v: value },
        ]);
      }
    } finally {
      await adapter.close();
    }
  });

  test("buildWhere keeps a ? in an identifier and binds only the value", async () => {
    await withRows(async (client) => {
      const { clause, params } = buildWhere({ "v?": "b" });
      assert.equal(clause, "WHERE [v?] = ?");
      // The broker counts the ? inside [v?] as a host variable (-1007): the client
      // bound only the value, and nothing runs.
      await assert.rejects(
        client.execute(`DELETE FROM ${TABLE} ${clause}`, params as QueryParam[]),
        {
          code: -1007,
        },
      );
      assert.deepEqual(await rows(client), UNCHANGED);

      const plain = buildWhere({ v: "b" });
      const result = await client.execute(
        `DELETE FROM ${TABLE} ${plain.clause}`,
        plain.params as QueryParam[],
      );
      assert.equal(result.affectedRows, 1);
    });
  });
});

describe("Integration: escapeIdentifier and buildWhere quoting (#259)", {
  skip: !available,
}, () => {
  const TABLE = "cc_ident_259";
  type Client = ReturnType<typeof createClient>;

  /** Creates a table with one column `name`, rows (1, 1) and (2, 2), and runs `run`. */
  async function withColumn(client: Client, name: string, run: () => Promise<void>): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
    try {
      await client.query(`CREATE TABLE ${TABLE} (id INT, ${escapeIdentifier(name)} INT)`);
      await client.query(`INSERT INTO ${TABLE} VALUES (1, 1), (2, 2)`);
      await run();
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
    }
  }

  async function idsWhere(client: Client, conditions: Record<string, unknown>): Promise<number[]> {
    const { clause, params } = buildWhere(conditions);
    const rows = await client.query<{ id: number }>(
      `SELECT id FROM ${TABLE} ${clause} ORDER BY id`,
      params as QueryParam[],
    );
    return rows.map((row) => row.id);
  }

  async function columnNames(client: Client): Promise<string[]> {
    const rows = await client.query<{ attr_name: string }>(
      `SELECT attr_name FROM db_attribute WHERE class_name = '${TABLE}' ORDER BY def_order`,
    );
    return rows.map((row) => row.attr_name);
  }

  test("a name with a backtick, a double quote or a space keeps its bracket form", async () => {
    const client = createClient(TEST_CONFIG);
    try {
      for (const name of ["c`d", 'e"f', "i j", "a\\b"]) {
        assert.equal(escapeIdentifier(name), `[${name}]`);
        await withColumn(client, name, async () => {
          assert.deepEqual(await columnNames(client), ["id", name]);
          for (const mode of ["no", "yes"]) {
            await client.query(`SET SYSTEM PARAMETERS 'no_backslash_escapes=${mode}'`);
            assert.deepEqual(await idsWhere(client, { [name]: 2 }), [2], `${name} (${mode})`);
          }
        });
      }
    } finally {
      await client.close();
    }
  });

  test("a name with ] is backtick-quoted: 10.2 resolves it and 11.x refuses it", async () => {
    const client = createClient(TEST_CONFIG);
    const major = Number((await client.getServerVersion()).split(".")[0]);
    try {
      for (const name of ["a]b", "a]`b", 'a]"b', "a] b", "a]\\", "id] or 1=1 --"]) {
        if (major >= 11) {
          // 11.x: "Identifier name ... cannot contain '[' or ']'", in any quoting.
          await assert.rejects(
            client.query(`CREATE TABLE ${TABLE} (${escapeIdentifier(name)} INT)`),
            { code: -493 },
          );
          await assert.rejects(idsWhere(client, { [name]: 2 }), { code: -493 });
          continue;
        }
        await withColumn(client, name, async () => {
          assert.deepEqual(await columnNames(client), ["id", name]);
          for (const mode of ["no", "yes"]) {
            await client.query(`SET SYSTEM PARAMETERS 'no_backslash_escapes=${mode}'`);
            assert.deepEqual(await idsWhere(client, { [name]: 2 }), [2], `${name} (${mode})`);
            assert.deepEqual(await idsWhere(client, { [name]: null }), [], `${name} (${mode})`);
          }
          // The value stays bound: the comment in the name does not hide the marker.
          const { clause, params } = buildWhere({ [name]: 1 });
          const result = await client.execute(
            `DELETE FROM ${TABLE} ${clause}`,
            params as QueryParam[],
          );
          assert.equal(result.affectedRows, 1);
          assert.deepEqual(await idsWhere(client, {}), [2]);
        });
      }
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
      await client.close();
    }
  });

  test("a ? in a backtick-quoted name binds only the value and nothing runs", async () => {
    const client = createClient(TEST_CONFIG);
    const major = Number((await client.getServerVersion()).split(".")[0]);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await client.query(`CREATE TABLE ${TABLE} (id INT)`);
      await client.query(`INSERT INTO ${TABLE} VALUES (1), (2)`);
      const { clause, params } = buildWhere({ "a]?": 1 });
      assert.equal(clause, "WHERE `a]?` = ?");
      // 10.2: the broker counts the ? inside the backticks as a host variable
      // (-1007), as it does inside brackets. 11.x refuses the name first (-493).
      await assert.rejects(
        client.execute(`DELETE FROM ${TABLE} ${clause}`, params as QueryParam[]),
        { code: major >= 11 ? -493 : -1007 },
      );
      assert.deepEqual(await idsWhere(client, {}), [1, 2]);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
      await client.close();
    }
  });
});

describe("Integration: connection pool (#92)", { skip: !available }, () => {
  const TABLE = "cc92_pool";
  const SLOW = "SELECT SLEEP(1) AS slept FROM db_root";

  function poolWithEvents(options: Parameters<typeof createPool>[0]) {
    const events: ClientLogFields[] = [];
    const record = (_message: string, fields: ClientLogFields): void => {
      if (fields.operation?.startsWith("pool.")) {
        events.push(fields);
      }
    };
    const pool = createPool({ ...options, logger: { info: record, error: record } });
    const count = (operation: string): number =>
      events.filter((event) => event.operation === operation).length;
    return { pool, events, count };
  }

  before(async () => {
    const client = createClient(TEST_CONFIG);
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, pad VARCHAR(400))`);
    await client.query(
      `INSERT INTO ${TABLE} (id, pad) SELECT ROWNUM, '${"p".repeat(300)}' ` +
        "FROM db_attribute a, db_attribute b LIMIT 1500",
    );
    await client.close();
  });

  after(async () => {
    const client = createClient(TEST_CONFIG);
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await client.close();
  });

  test("concurrent statements never use more sessions than max", async () => {
    const { pool, count } = poolWithEvents({ ...TEST_CONFIG, max: 3 });
    let peak = 0;
    try {
      const started = Date.now();
      await Promise.all(
        Array.from({ length: 9 }, async () => {
          const rows = await pool.query(SLOW);
          peak = Math.max(peak, pool.stats().total);
          return rows;
        }),
      );
      // Nine one-second statements on three sessions take three rounds.
      assert.ok(Date.now() - started >= 2900, `took ${Date.now() - started}ms`);
      assert.ok(peak <= 3, `peak ${peak}`);
      assert.equal(count("pool.create"), 3);
    } finally {
      await pool.close();
    }
  });

  test("a clean session is reused, session variables included", async () => {
    const { pool, count } = poolWithEvents({ ...TEST_CONFIG, max: 1 });
    try {
      await pool.query("SET @cc92_reused = 7");
      assert.deepEqual(await pool.query("SELECT @cc92_reused AS v FROM db_root"), [{ v: 7 }]);
      assert.equal(count("pool.create"), 1);
      assert.equal(count("pool.destroy"), 0);
    } finally {
      await pool.close();
    }
  });

  test("a session left in a transaction is never reused", async () => {
    const { pool, events, count } = poolWithEvents({ ...TEST_CONFIG, max: 1 });
    const reason = new Error("stopped by the test");
    const controller = new AbortController();
    try {
      await pool.execute(`DELETE FROM ${TABLE} WHERE id = 99999`);
      await assert.rejects(
        pool.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${TABLE} (id, pad) VALUES (99999, 'uncommitted')`);
          await tx.query("SET @cc92_marker = 42");
          setTimeout(() => controller.abort(reason), 200);
          // Aborted on the wire: the outcome is unknown and the transaction is lost.
          await tx.query(SLOW, [], { signal: controller.signal });
        }),
      );

      const destroyed = events.filter((event) => event.operation === "pool.destroy");
      assert.equal(destroyed.length, 1);
      assert.ok(
        ["failed-exchange", "in-transaction"].includes(destroyed[0]?.reason ?? ""),
        `reason ${destroyed[0]?.reason}`,
      );

      // The next lease is a new session: the session variable is not defined
      // there (-1070), and the uncommitted row is gone.
      await assert.rejects(
        pool.query("SELECT @cc92_marker AS v FROM db_root"),
        (error: unknown) => error instanceof QueryError && error.code === -1070,
      );
      assert.deepEqual(await pool.query(`SELECT id FROM ${TABLE} WHERE id = 99999`), []);
      assert.equal(count("pool.create"), 2);
    } finally {
      await pool.close();
    }
  });

  test("a scope the pool discards on close() leaves nothing behind", async () => {
    const { pool } = poolWithEvents({ ...TEST_CONFIG, max: 2 });
    const scope = await pool.beginTransactionScope();
    await scope.execute(`INSERT INTO ${TABLE} (id, pad) VALUES (99998, 'discarded')`);
    await pool.close();

    const client = createClient(TEST_CONFIG);
    try {
      assert.deepEqual(await client.query(`SELECT id FROM ${TABLE} WHERE id = 99998`), []);
    } finally {
      await client.close();
    }
  });

  test("a stream holds its session while queries inside the loop use another", async () => {
    const { pool, count } = poolWithEvents({ ...TEST_CONFIG, max: 2 });
    try {
      let rows = 0;
      for await (const row of pool.stream<{ id: number }>(
        `SELECT id, pad FROM ${TABLE} WHERE id <= 1500 ORDER BY id`,
      )) {
        rows += 1;
        if (row.id % 500 === 0) {
          const [found] = await pool.query<{ id: number }>(`SELECT id FROM ${TABLE} WHERE id = ?`, [
            row.id,
          ]);
          assert.equal(found?.id, row.id);
          assert.equal(pool.stats().active, 1);
        }
      }
      assert.equal(rows, 1500);
      assert.equal(count("pool.create"), 2);
      assert.deepEqual(pool.stats(), { total: 2, idle: 2, active: 0, pending: 0, waiting: 0 });
    } finally {
      await pool.close();
    }
  });

  test("executePrepared() with blob() writes through a leased session that is then reused", async () => {
    const { pool, count } = poolWithEvents({ ...TEST_CONFIG, max: 1 });
    const table = "cc92_pool_lob";
    const content = Buffer.alloc(300 * 1024, 0x5a);
    try {
      await pool.execute(`DROP TABLE IF EXISTS ${table}`);
      await pool.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, b BLOB)`);
      assert.deepEqual(
        await pool.executePrepared(`INSERT INTO ${table} (id, b) VALUES (?, ?)`, [
          1,
          blob(content),
        ]),
        { affectedRows: 1 },
      );
      await pool.transaction(async (tx) => {
        await tx.executePrepared(`INSERT INTO ${table} (id, b) VALUES (?, ?)`, [
          2,
          blob(content.subarray(0, 10)),
        ]);
      });

      const rows = await pool.query<{ id: number; b: Buffer }>(
        `SELECT id, b FROM ${table} ORDER BY id`,
      );
      assert.equal(rows.length, 2);
      assert.ok(rows[0]?.b.equals(content));
      assert.ok(rows[1]?.b.equals(content.subarray(0, 10)));
      await assert.rejects(
        pool.execute(`INSERT INTO ${table} (id, b) VALUES (?, ?)`, [3, blob(content) as never]),
        (error: unknown) => error instanceof TypeError,
      );
      assert.equal(count("pool.create"), 1);
      assert.equal(count("pool.destroy"), 0);
    } finally {
      await pool.execute(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
      await pool.close();
    }
  });

  test("close() waits for running statements, then closes every session", async () => {
    const { pool, count } = poolWithEvents({ ...TEST_CONFIG, max: 2 });
    await pool.query(`SELECT 1 FROM db_root`);
    const running = pool.query(SLOW);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const closing = pool.close();
    await assert.rejects(pool.query("SELECT 1 FROM db_root"), (error: unknown) => {
      return error instanceof ConnectionError && error.kind === "pool-closed";
    });
    assert.deepEqual(await running, [{ slept: 0 }]);
    await closing;
    assert.equal(count("pool.destroy"), count("pool.create"));
    assert.deepEqual(pool.stats(), { total: 0, idle: 0, active: 0, pending: 0, waiting: 0 });
  });
});

describe("Integration: pool close() inside transaction() callbacks (#268)", {
  skip: !available,
}, () => {
  const table = "cc268_pool_close";

  test("two callbacks that each await close() both commit, and close() from outside waits", async () => {
    const setup = createClient(TEST_CONFIG);
    const pool = createPool({ ...TEST_CONFIG, max: 2 });
    // Holds "b" after its close(), so the outside close() has a callback to wait for.
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    try {
      await setup.query(`DROP TABLE IF EXISTS ${table}`);
      await setup.query(`CREATE TABLE ${table} (val VARCHAR(20))`);
      const order: string[] = [];
      let running = 0;
      let bothRunning!: () => void;
      const together = new Promise<void>((resolve) => {
        bothRunning = resolve;
      });
      const run = (val: string) =>
        pool
          .transaction(async (tx) => {
            await tx.execute(`INSERT INTO ${table} (val) VALUES (?)`, [val]);
            running += 1;
            if (running === 2) {
              bothRunning();
            }
            await together;
            await pool.close();
            if (val === "b") {
              await gateB;
            }
            // The session is still this callback's after close() resolved.
            await tx.execute(`INSERT INTO ${table} (val) VALUES (?)`, [`${val} after`]);
            return val;
          })
          .then((result) => {
            order.push(result);
            return result;
          });
      const a = run("a");
      const b = run("b");
      await together;
      const outside = pool.close().then(() => {
        order.push("close");
      });

      assert.equal(await a, "a");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(order, ["a"], "the outside close() waits for the held callback");
      releaseB();
      assert.equal(await b, "b");
      await outside;
      assert.deepEqual(order, ["a", "b", "close"]);
      assert.deepEqual(pool.stats(), { total: 0, idle: 0, active: 0, pending: 0, waiting: 0 });
      const rows = await setup.query<{ val: string }>(`SELECT val FROM ${table} ORDER BY val`);
      assert.deepEqual(
        rows.map((row) => row.val),
        ["a", "a after", "b", "b after"],
      );
    } finally {
      releaseB();
      await pool.close();
      await setup.query(`DROP TABLE IF EXISTS ${table}`);
      await setup.close();
    }
  });
});

// #252: the CAS writes a NUL into byte 31 of each 32-byte OpenDatabase field
// (src/broker/cas.c), so 31 bytes is the longest database, user or password it
// reads intact. Before the fix a 32-byte value was cut to its first 31 bytes, on
// the client or on the broker, and logged in as whoever those 31 bytes named.
describe("Integration: OpenDatabase credential byte limits", { skip: !available }, () => {
  const USER_31 = `cc252_${"u".repeat(25)}`;
  const PASSWORD_31 = `${"p".repeat(30)}z`;
  const USER_MB = "cc252_mb";
  // 15 two-byte characters and one ASCII byte: 31 bytes in 16 characters.
  const PASSWORD_MB_31 = `${"é".repeat(15)}z`;

  async function dropUsers(client: ReturnType<typeof createClient>): Promise<void> {
    for (const user of [USER_31, USER_MB]) {
      const exists = await client.query("SELECT name FROM db_user WHERE name = ?", [
        user.toUpperCase(),
      ]);
      if (exists.length > 0) {
        await client.query(`DROP USER ${user}`);
      }
    }
  }

  async function currentUser(user: string, password: string): Promise<unknown> {
    const client = createClient({ ...TEST_CONFIG, user, password });
    try {
      const [row] = await client.query<{ u: string }>("SELECT CURRENT_USER AS u");
      return row?.u;
    } finally {
      await client.close();
    }
  }

  before(async () => {
    assert.equal(Buffer.byteLength(USER_31), 31);
    assert.equal(Buffer.byteLength(PASSWORD_31), 31);
    assert.equal(Buffer.byteLength(PASSWORD_MB_31), 31);
    const client = createClient(TEST_CONFIG);
    try {
      await dropUsers(client);
      await client.query(`CREATE USER ${USER_31} PASSWORD '${PASSWORD_31}'`);
      await client.query(`CREATE USER ${USER_MB} PASSWORD '${PASSWORD_MB_31}'`);
    } finally {
      await client.close();
    }
  });

  after(async () => {
    const client = createClient(TEST_CONFIG);
    try {
      await dropUsers(client);
    } finally {
      await client.close();
    }
  });

  test("the server itself refuses a 32-byte user name and a 32-byte password", async () => {
    const client = createClient(TEST_CONFIG);
    try {
      await assert.rejects(client.query(`CREATE USER cc252_${"v".repeat(26)}`), QueryError);
      await assert.rejects(
        client.query(`CREATE USER cc252_pw32 PASSWORD '${"q".repeat(32)}'`),
        QueryError,
      );
      const created = await client.query("SELECT name FROM db_user WHERE name LIKE 'CC252_PW32'");
      assert.deepEqual(created, []);
    } finally {
      await client.close();
    }
  });

  test("a 31-byte user with a 31-byte password logs in as that user", async () => {
    assert.equal(await currentUser(USER_31, PASSWORD_31), USER_31.toUpperCase());
  });

  test("a 31-byte multibyte password logs in", async () => {
    assert.equal(await currentUser(USER_MB, PASSWORD_MB_31), USER_MB.toUpperCase());
  });

  test("the password is checked: one byte short is refused by the server", async () => {
    const adapter = new NativeCubridAdapter({
      ...TEST_CONFIG,
      user: USER_31,
      password: PASSWORD_31.slice(0, 30),
    });
    try {
      await assert.rejects(adapter.connect(), (error: unknown) => {
        assert.ok(error instanceof ConnectionError);
        assert.match(String((error.cause as Error).message), /-171/);
        return true;
      });
    } finally {
      await adapter.close();
    }
  });

  test("32 and 33-byte credentials are refused before connecting, not cut to 31", () => {
    for (const options of [
      { user: USER_31, password: `${PASSWORD_31}X` },
      { user: USER_31, password: `${PASSWORD_31}XY` },
      { user: `${USER_31}X`, password: PASSWORD_31 },
      { user: USER_MB, password: `${PASSWORD_MB_31}é` },
      { database: `${"t".repeat(31)}X` },
    ]) {
      const config = { ...TEST_CONFIG, ...options };
      assert.throws(() => createClient(config), RangeError);
      assert.throws(() => new NativeCubridAdapter(config), RangeError);
    }
  });
});

describe("Integration: destroy() (#245)", { skip: !available }, () => {
  const TABLE = "cc245_destroy";
  const LOG = "cc245_destroy_log";
  const SLOW = "SELECT SLEEP(5) AS slept FROM db_root";
  const QUICK = "SELECT 1 AS one FROM db_root";
  // The statement must be on the wire before destroy(); the host may be loaded.
  const SENT_MS = 1000;
  const PROMPT_MS = 3000;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  before(async () => {
    const client = createClient(TEST_CONFIG);
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await client.query(`DROP TABLE IF EXISTS ${LOG}`);
    await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, v INT)`);
    await client.query(`CREATE TABLE ${LOG} (id INT)`);
    await client.close();
  });

  after(async () => {
    const client = createClient(TEST_CONFIG);
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await client.query(`DROP TABLE IF EXISTS ${LOG}`);
    await client.close();
  });

  function assertLost(error: unknown): boolean {
    assert.equal((error as { kind?: string }).kind, "connection-lost", String(error));
    return true;
  }

  test("destroy() during SELECT SLEEP(5) settles at once, and a new client works", {
    timeout: 60_000,
  }, async () => {
    const client = createClient(TEST_CONFIG);
    await client.query(QUICK);
    const running = client.query(SLOW);
    const queued = client.query(QUICK);
    const closing = client.close();
    await sleep(SENT_MS);

    const started = Date.now();
    await client.destroy();
    await assert.rejects(running, assertLost);
    await assert.rejects(queued, assertLost);
    await closing;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < PROMPT_MS, `settled ${elapsed}ms after destroy()`);

    const next = createClient(TEST_CONFIG);
    try {
      assert.deepEqual(await next.query(QUICK), [{ one: 1 }]);
    } finally {
      await next.close();
    }
  });

  test("destroy() inside a scope rolls its work back on the server and frees its locks", {
    timeout: 60_000,
  }, async () => {
    const client = createClient(TEST_CONFIG);
    const scope = await client.beginTransactionScope();
    await scope.execute(`INSERT INTO ${TABLE} (id, v) VALUES (1, 1)`);
    const running = scope.query(SLOW);
    await sleep(SENT_MS);

    await client.destroy();
    await assert.rejects(running, assertLost);
    await assert.rejects(scope.commit(), TransactionError);

    // The server rolls the transaction back once its CAS notices the client is
    // gone, after SLEEP(5) returns, so wait for the row lock rather than fail.
    const next = createClient({ ...TEST_CONFIG, lockTimeout: 30_000 });
    try {
      await next.execute(`INSERT INTO ${TABLE} (id, v) VALUES (1, 2)`);
      assert.deepEqual(await next.query(`SELECT id, v FROM ${TABLE} ORDER BY id`), [
        { id: 1, v: 2 },
      ]);
    } finally {
      await next.query(`DELETE FROM ${TABLE}`).catch(() => undefined);
      await next.close();
    }
  });

  test("an autocommit INSERT destroyed mid-statement runs at most once", {
    timeout: 60_000,
  }, async () => {
    const client = createClient(TEST_CONFIG);
    await client.query(QUICK);
    const running = client.execute(`INSERT INTO ${LOG} (id) SELECT SLEEP(5) FROM db_root`);
    await sleep(SENT_MS);

    await client.destroy();
    await assert.rejects(running, assertLost);

    // Its outcome is unknown, but it is never sent again: wait past the sleep.
    await sleep(6000);
    const next = createClient(TEST_CONFIG);
    try {
      const [row] = await next.query(`SELECT COUNT(*) AS n FROM ${LOG}`);
      const count = Number(row?.n);
      assert.ok(count === 0 || count === 1, `the INSERT ran ${count} times`);
    } finally {
      await next.query(`DELETE FROM ${LOG}`).catch(() => undefined);
      await next.close();
    }
  });

  test("destroy() of an idle client and repeated destroy() and close() calls settle", {
    timeout: 60_000,
  }, async () => {
    const client = createClient(TEST_CONFIG);
    assert.deepEqual(await client.query(QUICK), [{ one: 1 }]);

    await client.destroy();
    await client.destroy();
    await client.close();
    await assert.rejects(client.query(QUICK));
  });
});

describe("Integration: maxReplyBytes (#251)", { skip: !available }, () => {
  const TABLE = "cc251_reply";
  const MIB = 1024 * 1024;
  // Two 600 KiB values make one row, and so one FETCH reply, of about 1.2 MiB.
  const WIDE = "w".repeat(600 * 1024);
  const NARROW = "n".repeat(512 * 1024);
  const LOB = Buffer.alloc(3 * MIB, 0x5c);

  before(async () => {
    const client = createClient(TEST_CONFIG);
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, a VARCHAR, b VARCHAR, l BLOB)`);
    const insert = `INSERT INTO ${TABLE} (id, a, b, l) VALUES (?, ?, ?, ?)`;
    await client.executePrepared(insert, [1, WIDE, WIDE, null]);
    await client.executePrepared(insert, [2, NARROW, "", null]);
    await client.executePrepared(insert, [3, "", "", blob(LOB)]);
    await client.close();
  });

  after(async () => {
    const client = createClient(TEST_CONFIG);
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await client.close();
  });

  function overLimit(error: unknown): boolean {
    for (let e = error; e instanceof Error; e = e.cause) {
      if (/over the maxReplyBytes limit of 1048576 bytes/.test(e.message)) {
        return true;
      }
    }
    assert.fail(`not a maxReplyBytes rejection: ${String(error)}`);
  }

  test("a row under the limit reads intact; a row over it rejects and the session is replaced", async () => {
    const adapter = new NativeCubridAdapter({ ...TEST_CONFIG, maxReplyBytes: MIB });
    await adapter.connect();
    const cas = (adapter as unknown as { cas: CASConnection }).cas;

    try {
      const [narrow] = await adapter.query<{ a: string }>(`SELECT a FROM ${TABLE} WHERE id = 2`);
      assert.equal(narrow?.a, NARROW);
      const generation = cas.connectionGeneration;

      await assert.rejects(adapter.query(`SELECT a, b FROM ${TABLE} WHERE id = 1`), (error) => {
        assert.ok(error instanceof QueryError);
        return overLimit(error);
      });
      assert.equal(cas.isConnected, false);

      // The next statement opens a new session; nothing of the rejected reply is read.
      const [row] = await adapter.query<{ one: number }>("SELECT 1 AS one FROM db_root");
      assert.equal(row?.one, 1);
      assert.equal(cas.connectionGeneration, generation + 1);

      // Each value alone fits, so the same data reads in two statements.
      const [a] = await adapter.query<{ a: string }>(`SELECT a FROM ${TABLE} WHERE id = 1`);
      const [b] = await adapter.query<{ b: string }>(`SELECT b FROM ${TABLE} WHERE id = 1`);
      assert.equal(a?.a, WIDE);
      assert.equal(b?.b, WIDE);
    } finally {
      await adapter.close();
    }
  });

  test("inside a transaction an over-limit reply loses the transaction, which rolls back", async () => {
    const client = createClient({ ...TEST_CONFIG, maxReplyBytes: MIB });

    try {
      await assert.rejects(
        client.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${TABLE} (id, a) VALUES (100, 'uncommitted')`);
          await tx.query(`SELECT a, b FROM ${TABLE} WHERE id = 1`);
        }),
        (error) => {
          assert.ok(error instanceof TransactionError);
          return overLimit(error);
        },
      );

      const rows = await client.query(`SELECT id FROM ${TABLE} WHERE id = 100`);
      assert.deepEqual(rows, []);
    } finally {
      await client.close();
    }
  });

  test("BLOB content is not bounded by maxReplyBytes: a 3 MiB BLOB reads under a 1 MiB limit", async () => {
    const client = createClient({ ...TEST_CONFIG, maxReplyBytes: MIB, maxLobBytes: 4 * MIB });

    try {
      const [row] = await client.query<{ l: Buffer }>(`SELECT l FROM ${TABLE} WHERE id = 3`);
      assert.ok(row?.l.equals(LOB));

      const streamed: Buffer[] = [];
      for await (const each of client.stream<{ l: Buffer }>(
        `SELECT l FROM ${TABLE} WHERE id = 3`,
      )) {
        streamed.push(each.l);
      }
      assert.equal(streamed.length, 1);
      assert.ok(streamed[0]?.equals(LOB));
    } finally {
      await client.close();
    }
  });

  test("the default limit reads a 64 MiB VARCHAR row as one reply (reports memory use)", async (t) => {
    const size = 64 * MIB;
    const client = createClient(TEST_CONFIG);
    let largest = 0;
    const big = createClient({
      ...TEST_CONFIG,
      connectionFactory: async (config) => {
        const adapter = new NativeCubridAdapter(config);
        await adapter.connect();
        const cas = (adapter as unknown as { cas: CASConnection }).cas;
        const recv = cas.recv.bind(cas);
        cas.recv = async () => {
          const reply = await recv();
          largest = Math.max(largest, reply.length);
          return reply;
        };
        return adapter;
      },
    });

    try {
      await client.executePrepared(`INSERT INTO ${TABLE} (id, a) VALUES (?, ?)`, [
        200,
        "m".repeat(size),
      ]);

      const before = process.memoryUsage();
      const [row] = await big.query<{ a: string }>(`SELECT a FROM ${TABLE} WHERE id = 200`);
      const afterRead = process.memoryUsage();

      assert.equal(row?.a.length, size);
      // One reply carries the whole row: the value plus a few bytes of header.
      assert.ok(largest >= size && largest < size + 4096, `largest reply ${largest} bytes`);
      const grown = (n: number) => `${((n / MIB) | 0).toString()} MiB`;
      t.diagnostic(
        `64 MiB row: largest reply ${largest} bytes; rss +${grown(afterRead.rss - before.rss)}, ` +
          `arrayBuffers +${grown(afterRead.arrayBuffers - before.arrayBuffers)}`,
      );
    } finally {
      await client.query(`DELETE FROM ${TABLE} WHERE id = 200`).catch(() => undefined);
      await client.close();
      await big.close();
    }
  });
});

// ---------------------------------------------------------------------------
// #250: the fixtures of tests/fixtures/temporal-zones.ts against a live server,
// for the 1.x default and for the proposed 2.0 default (docs/adr/0010).
// ---------------------------------------------------------------------------

describe("Integration: temporal values under TZ=UTC, Asia/Seoul and America/Los_Angeles (#250)", {
  skip: !available,
}, () => {
  const TABLE = "cc_tz_250";

  /** Run `run` under each fixture zone, restoring the process TZ afterwards. */
  async function eachZone(run: (zone: (typeof FIXTURE_ZONES)[number]) => Promise<void>) {
    const previous = process.env.TZ;
    try {
      for (const zone of FIXTURE_ZONES) {
        process.env.TZ = zone;
        await run(zone);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previous;
      }
    }
  }

  test("a Date written to DATE, TIME, TIMESTAMP and DATETIME reads back as the fixtures", async () => {
    const local = createClient(TEST_CONFIG);
    const utc = createClient({ ...TEST_CONFIG, timezone: "utc" });
    try {
      await local.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await local.query(
        `CREATE TABLE ${TABLE} (id INT, d DATE, t TIME, ts TIMESTAMP, dt DATETIME)`,
      );
      // The literal path and the prepared path both send the UTC fields.
      await local.query(`INSERT INTO ${TABLE} VALUES (1, ?, ?, ?, ?)`, [SENT, SENT, SENT, SENT]);
      await local.executePrepared(`INSERT INTO ${TABLE} VALUES (2, ?, ?, ?, ?)`, [
        SENT,
        SENT,
        SENT,
        SENT,
      ]);
      const read = async (client: typeof local) => {
        const rows = await client.query(`SELECT d, t, ts, dt FROM ${TABLE} ORDER BY id`);
        assert.equal(rows.length, 2);
        return rows.map((row) => ({
          datetime: (row.dt as Date).toISOString(),
          timestamp: (row.ts as Date).toISOString(),
          date: (row.d as Date).toISOString(),
          time: (row.t as Date).toISOString(),
        }));
      };

      await eachZone(async (zone) => {
        // 1.x default: a different instant per process TZ.
        assert.deepEqual(await read(local), [LOCAL_DECODED[zone], LOCAL_DECODED[zone]], zone);
        // Proposed 2.0 default: the same instants everywhere, and DATETIME is SENT again.
        const fromUtc = await read(utc);
        assert.deepEqual(fromUtc, [UTC_DECODED, UTC_DECODED], zone);
        assert.equal(fromUtc[0]?.datetime, SENT.toISOString(), zone);
      });
    } finally {
      await local.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
      await local.close();
      await utc.close();
    }
  });

  test("a local-midnight Date names the day before in a DATE column east of UTC", async () => {
    const client = createClient(TEST_CONFIG);
    try {
      await eachZone(async (zone) => {
        const [row] = await client.query<{ ymd: number }>(
          "SELECT YEAR(d) * 10000 + MONTH(d) * 100 + DAY(d) AS ymd " +
            "FROM (SELECT CAST(? AS DATE) AS d FROM db_root) x",
          [new Date(2025, 5, 15)],
        );
        assert.equal(row?.ymd, LOCAL_MIDNIGHT_SENT[zone].storedDay, zone);
      });
    } finally {
      await client.close();
    }
  });

  test("a TIMESTAMP in a DST overlap cannot tell its two instants apart", async () => {
    const adapter = new NativeCubridAdapter({ ...TEST_CONFIG, timezone: "utc" });
    try {
      // In a transaction the broker keeps the session, and so its time zone.
      await adapter.beginTransaction();
      await adapter.query("SET TIME ZONE 'America/Los_Angeles'");
      const [pdt, pst] = LA_DST.overlap.instants.map(
        (iso) => `TIMESTAMPTZ'${iso.slice(0, 10)} ${iso.slice(11, 19)} +00:00'`,
      );
      const [row] = await adapter.query(
        `SELECT CAST(${pdt} AS TIMESTAMP) AS a, CAST(${pst} AS TIMESTAMP) AS b, ` +
          `UNIX_TIMESTAMP(${pdt}) AS ua, UNIX_TIMESTAMP(${pst}) AS ub FROM db_root`,
      );
      // Two instants an hour apart ...
      assert.equal(Number(row?.ub) - Number(row?.ua), 3600);
      // ... are the same session wall-clock fields, so the same Date in either mode.
      assert.equal((row?.a as Date | undefined)?.toISOString(), LA_DST.overlap.utcIso);
      assert.equal((row?.b as Date | undefined)?.toISOString(), LA_DST.overlap.utcIso);
      await adapter.rollback();
    } finally {
      await adapter.close();
    }
  });

  test("a Date written to a zone-aware column takes the session zone, not UTC", async () => {
    const adapter = new NativeCubridAdapter({ ...TEST_CONFIG, timezone: "utc" });
    try {
      await adapter.beginTransaction();
      await adapter.query("SET TIME ZONE 'Asia/Seoul'");
      const [row] = await adapter.query(
        "SELECT CAST(? AS DATETIMETZ) AS tz, UNIX_TIMESTAMP(CAST(? AS DATETIMETZ)) AS u FROM db_root",
        [SENT, SENT],
      );
      const tz = row?.tz as ZonedDateTime;
      assert.ok(tz instanceof ZonedDateTime);
      // The UTC fields of SENT, labelled with the session zone: nine hours early.
      assert.deepEqual(
        [tz.year, tz.month, tz.day, tz.hour, tz.minute, tz.second, tz.millisecond],
        [2025, 6, 14, 23, 30, 45, 678],
      );
      assert.match(tz.zone, /^Asia\/Seoul/);
      assert.equal(Number(row?.u) * 1000, Math.floor(SENT.getTime() / 1000) * 1000 - 9 * 3_600_000);
      await adapter.rollback();
    } finally {
      await adapter.close();
    }
  });
});

// ---------------------------------------------------------------------------
// outcomeUnknown (#254)
// ---------------------------------------------------------------------------

describe("Integration: outcomeUnknown on uncertain outcomes (#254)", { skip: !available }, () => {
  const TABLE = "outcome_unknown_254_t";
  const SLEEP = "SELECT SLEEP(2) AS slept FROM db_root";
  const setup = createClient(TEST_CONFIG);

  before(async () => {
    await setup.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await setup.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, v VARCHAR(20))`);
  });

  after(async () => {
    await setup.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await setup.close();
  });

  async function count(id: number): Promise<number> {
    const [row] = await setup.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${TABLE} WHERE id = ?`,
      [id],
    );
    return Number(row?.n);
  }

  test("a syntax error has a known outcome", async () => {
    const client = createClient(TEST_CONFIG);
    try {
      await assert.rejects(client.query("SELEC 1"), (error: unknown) => {
        assert.ok(error instanceof SqlSyntaxError);
        assert.equal(error.code, -493);
        assert.equal(error.outcomeUnknown, false);
        return true;
      });
    } finally {
      await client.close();
    }
  });

  test("destroy() during SELECT SLEEP(2) leaves the outcome unknown", async () => {
    const client = createClient(TEST_CONFIG);
    await client.ping();
    const running = client.query(SLEEP);
    await new Promise((resolve) => setTimeout(resolve, 300));
    client.destroy();

    await assert.rejects(running, (error: unknown) => {
      assert.ok(error instanceof QueryError);
      assert.equal(error.kind, "connection-lost");
      assert.equal(error.outcomeUnknown, true);
      return true;
    });
  });

  test("a duplicate key in transaction() is known; the rollback leaves no row", async () => {
    await setup.query(`INSERT INTO ${TABLE} (id, v) VALUES (1, 'first')`);
    const client = createClient(TEST_CONFIG);
    try {
      await assert.rejects(
        client.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${TABLE} (id, v) VALUES (2, 'tx')`);
          await tx.query(`INSERT INTO ${TABLE} (id, v) VALUES (1, 'dup')`);
        }),
        (error: unknown) => {
          assert.ok(error instanceof TransactionError);
          assert.equal(error.kind, "unique-violation");
          assert.equal(error.outcomeUnknown, false);
          return true;
        },
      );
      assert.equal(await count(2), 0);
    } finally {
      await client.close();
    }
  });

  test("an aborted transaction statement is unknown, and reconciling by key never duplicates", async () => {
    const client = createClient(TEST_CONFIG);
    const controller = new AbortController();
    try {
      const transaction = client.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${TABLE} (id, v) VALUES (3, 'maybe')`);
        await tx.query(SLEEP, [], { signal: controller.signal });
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      controller.abort();

      await assert.rejects(transaction, (error: unknown) => {
        assert.ok(error instanceof TransactionError);
        assert.equal((error.cause as Error).name, "AbortError");
        assert.equal(error.outcomeUnknown, true);
        return true;
      });

      // The documented reconciliation: read the row by its key before writing again.
      // The server rolls the dropped session back once its SLEEP ends; poll for it.
      const deadline = Date.now() + 15000;
      while ((await count(3)) !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if ((await count(3)) === 0) {
        await client.query(`INSERT INTO ${TABLE} (id, v) VALUES (3, 'retried')`);
      }
      assert.equal(await count(3), 1);
    } finally {
      await client.close();
    }
  });

  test("a readTimeout on SELECT SLEEP(2) is unknown, and the next statement runs once", async () => {
    const client = createClient({ ...TEST_CONFIG, readTimeout: 500 });
    try {
      await assert.rejects(client.query(SLEEP), (error: unknown) => {
        assert.ok(error instanceof ReadTimeoutError);
        assert.equal(error.outcomeUnknown, true);
        return true;
      });
      // A new session may wait for a free CAS while the old one still sleeps.
      await client.query(`INSERT INTO ${TABLE} (id, v) VALUES (4, 'after')`, [], {
        readTimeout: 0,
      });
      assert.equal(await count(4), 1);
    } finally {
      await client.close();
    }
  });
});
