/**
 * Real SSL=ON CUBRID broker tests. The workflow provisions the broker and
 * installs a short-lived CA; normal offline runs may skip this opt-in suite.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "../src/client/create-client.js";

const required = process.env.CUBRID_TLS_REQUIRED === "1";
const caFile = process.env.CUBRID_TLS_CA_FILE;
if (required && !caFile) {
  throw new Error("TLS live test required, but CUBRID_TLS_CA_FILE is missing");
}

const available = Boolean(caFile);
const base = {
  host: "localhost",
  port: Number(process.env.CUBRID_TLS_PORT ?? "33000"),
  database: "testdb",
  user: "dba",
  password: "",
  connectionTimeout: 5000,
  readTimeout: 5000,
};
const ca = caFile ? readFileSync(caFile, "utf8") : "";

test("real CUBRID SSL=ON: verified certificate and SQL round trip", {
  skip: !available,
}, async () => {
  const client = createClient({
    ...base,
    ssl: { ca, servername: "localhost" },
  });
  try {
    const rows = await client.query("SELECT 1 AS result");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.result, 1);
    const version = await client.ping();
    assert.ok(version.length > 0);
  } finally {
    await client.close();
  }
});

test("real CUBRID SSL=ON: self-signed certificate is rejected without its CA", {
  skip: !available,
}, async () => {
  const client = createClient({ ...base, ssl: true });
  try {
    await assert.rejects(client.query("SELECT 1 AS result"));
  } finally {
    await client.close();
  }
});

test("real CUBRID SSL=ON: valid CA cannot bypass hostname verification", {
  skip: !available,
}, async () => {
  const client = createClient({ ...base, ssl: { ca, servername: "not-the-broker.invalid" } });
  try {
    await assert.rejects(client.query("SELECT 1 AS result"));
  } finally {
    await client.close();
  }
});
