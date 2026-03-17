import test from "node:test";
import assert from "node:assert/strict";

import { parseConnectionString } from "../src/utils/connection-string.js";

test("parseConnectionString parses full URL", () => {
  const config = parseConnectionString("cubrid://dba:secret@localhost:33000/demodb");

  assert.deepEqual(config, {
    host: "localhost",
    port: 33000,
    database: "demodb",
    user: "dba",
    password: "secret",
  });
});

test("parseConnectionString applies default port when omitted", () => {
  const config = parseConnectionString("cubrid://dba:secret@localhost/demodb");

  assert.equal(config.port, 33000);
});

test("parseConnectionString supports missing password", () => {
  const config = parseConnectionString("cubrid://dba@localhost/demodb");

  assert.equal(config.user, "dba");
  assert.equal(config.password, "");
});

test("parseConnectionString supports missing auth", () => {
  const config = parseConnectionString("cubrid://localhost/demodb");

  assert.equal(config.user, "");
  assert.equal(config.password, "");
});

test("parseConnectionString decodes encoded credentials", () => {
  const config = parseConnectionString("cubrid://dba:p%40ss%3Aword%2Fok@localhost/demodb");

  assert.equal(config.password, "p@ss:word/ok");
});

test("parseConnectionString rejects invalid protocol", () => {
  assert.throws(
    () => parseConnectionString("mysql://dba:secret@localhost/demodb"),
    /cubrid:\/\//,
  );
});

test("parseConnectionString rejects URL without database", () => {
  assert.throws(
    () => parseConnectionString("cubrid://dba:secret@localhost"),
    /database name/,
  );
});

test("parseConnectionString rejects invalid URL text", () => {
  assert.throws(
    () => parseConnectionString("not-a-url"),
    /Invalid CUBRID connection URL/,
  );
});
