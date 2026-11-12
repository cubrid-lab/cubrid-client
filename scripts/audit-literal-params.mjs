// Runs the literal-parameter fixtures from docs/advisories/literal-parameters-1.4.0.md
// against one installed cubrid-client package, on a disposable CUBRID database.
//
//   mkdir v1.3.0 && (cd v1.3.0 && npm init -y && npm i cubrid-client@1.3.0)
//   CUBRID_PORT=33000 node scripts/audit-literal-params.mjs ./v1.3.0
//
// 0.x and 1.0.0 also need `node-cubrid@^11` installed next to the package.
// The script creates and drops the table `audit_lit_params`. Never point it at a
// database that holds data you care about.
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
if (!dir) {
  console.error(
    "usage: node scripts/audit-literal-params.mjs <dir with node_modules/cubrid-client>",
  );
  process.exit(2);
}
const entry = path.resolve(dir, "node_modules/cubrid-client/dist/index.js");
const { createClient } = await import(pathToFileURL(entry).href);
const client = createClient({
  host: process.env.CUBRID_HOST ?? "127.0.0.1",
  port: Number(process.env.CUBRID_PORT ?? 33000),
  database: process.env.CUBRID_DATABASE ?? "testdb",
  user: process.env.CUBRID_USER ?? "dba",
  password: process.env.CUBRID_PASSWORD ?? "",
});

const T = "audit_lit_params";
async function dropTable() {
  try {
    await client.query(`DROP TABLE ${T}`);
  } catch {
    // The table does not exist yet.
  }
}
async function reset() {
  await dropTable();
  await client.query(
    `CREATE TABLE ${T} (id INT PRIMARY KEY, bal INT, flag INT, note VARCHAR(200))`,
  );
  for (const id of [1, 2, 3]) {
    await client.query(`INSERT INTO ${T} VALUES (${id}, 10, 0, 'n${id}')`);
  }
}
// Rows as id:bal/flag, read back from the database.
async function rows() {
  const result = await client.query(`SELECT id, bal, flag FROM ${T} ORDER BY id`);
  return result.map((r) => `${r.id}:${r.bal}/${r.flag}`).join(" ");
}

const cases = [
  // Safe: "1:10/0 2:11/1 3:10/0". Affected: every row gets flag 1.
  [
    "C1 negative number after minus (UPDATE)",
    async () => {
      await reset();
      await client.query(`UPDATE ${T} SET flag = 1, bal = bal-? WHERE id = ?`, [-1, 2]);
      return rows();
    },
  ],
  [
    "C1b negative bigint after minus (UPDATE)",
    async () => {
      await reset();
      await client.query(`UPDATE ${T} SET flag = 1, bal = bal-? WHERE id = ?`, [-1n, 2]);
      return rows();
    },
  ],
  // Safe: "1:10/0 3:10/0".
  [
    "C1c negative number after minus (DELETE)",
    async () => {
      await reset();
      await client.query(`DELETE FROM ${T} WHERE bal-? > 0 AND id = ?`, [-1, 2]);
      return rows();
    },
  ],
  // Safe: "1:10/0 2:11/1 3:10/0". Affected: no error, bal stays 10 on row 2.
  [
    "C1d negative number after minus, WHERE on next line",
    async () => {
      await reset();
      await client.query(`UPDATE ${T} SET flag = 1, bal = bal-?\nWHERE id = ?`, [-1, 2]);
      return rows();
    },
  ],
  // Safe: {"id":2,"adj":11}. Affected: wrong value under another column name.
  [
    "C1e negative number after minus in SELECT list",
    async () => {
      await reset();
      const [row] = await client.query(`SELECT id, bal-? AS adj\nFROM ${T} WHERE id = ?`, [-1, 2]);
      return JSON.stringify(row);
    },
  ],
  // Safe: no row changes.
  [
    "C2 quote payload in a string",
    async () => {
      await reset();
      await client.query(`UPDATE ${T} SET flag = 1 WHERE note = ?`, ["x' OR 1=1 --"]);
      return rows();
    },
  ],
  [
    "C2b backslash-quote payload in a string",
    async () => {
      await reset();
      await client.query(`UPDATE ${T} SET flag = 1 WHERE note = ?`, ["x\\' OR 1=1 --"]);
      return rows();
    },
  ],
  // Safe: "intact".
  [
    "C3 backslash and newline round-trip",
    async () => {
      await reset();
      const value = "a\\b\nc";
      await client.query(`UPDATE ${T} SET note = ? WHERE id = 1`, [value]);
      const [row] = await client.query(`SELECT note FROM ${T} WHERE id = 1`);
      return row.note === value ? "intact" : `altered ${JSON.stringify(row.note)}`;
    },
  ],
  // Safe: {"s":"a\\","p":"z"} on a server with no_backslash_escapes=yes (the default).
  [
    "C4 literal ending in a backslash, then ?",
    async () => {
      const [row] = await client.query(`SELECT 'a\\' AS s, ? AS p FROM db_root`, ["z"]);
      return JSON.stringify(row);
    },
  ],
  // Safe: rejected, or "1:10/0 2:10/1 3:10/0". Affected: every row gets flag 1.
  [
    "C5 ? inside a // comment, value with a newline",
    async () => {
      await reset();
      await client.query(`UPDATE ${T} SET flag = 1 WHERE id = ? // note ?\n`, [2, "\nOR 1=1 --"]);
      return rows();
    },
  ],
  // Safe: rejected before any SQL is sent.
  [
    "C6 more values than placeholders",
    async () => {
      const [row] = await client.query("SELECT ? AS p FROM db_root", [1, 2]);
      return `accepted ${JSON.stringify(row)}`;
    },
  ],
  // Safe: rejected before any SQL is sent.
  [
    "C7 ? inside a [bracket identifier]",
    async () => {
      const [row] = await client.query("SELECT ? AS [x?] FROM db_root", ["v", "w"]);
      return `accepted ${JSON.stringify(row)}`;
    },
  ],
];

const results = {};
for (const [name, run] of cases) {
  try {
    results[name] = await run();
  } catch (error) {
    const detail = error?.cause?.message ?? error?.message ?? String(error);
    results[name] = `error ${error?.name}: ${detail.slice(0, 100)}`;
  }
}
await dropTable();
await client.close?.();
for (const [name, outcome] of Object.entries(results)) {
  console.log(`${name.padEnd(48)} ${outcome}`);
}
process.exit(0);
