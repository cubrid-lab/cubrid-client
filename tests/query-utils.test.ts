import assert from "node:assert/strict";
import test from "node:test";

import { findPlaceholders, interpolateParams } from "../src/protocol/protocol.js";
import { buildWhere, escapeIdentifier } from "../src/utils/query.js";

test("escapeIdentifier wraps names in brackets", () => {
  assert.equal(escapeIdentifier("users"), "[users]");
});

test("escapeIdentifier keeps brackets for every name without ]", () => {
  for (const name of ["users", "a`b", 'a"b', "a?b", "a b", "a[b", "a\\b", ""]) {
    assert.equal(escapeIdentifier(name), `[${name}]`);
  }
});

test("escapeIdentifier quotes a name with ] in backticks, doubling its backticks", () => {
  // A CUBRID bracket identifier ends at the first ]: [a]]b] is a syntax error.
  assert.equal(escapeIdentifier("a]b"), "`a]b`");
  assert.equal(escapeIdentifier("a]`b"), "`a]``b`");
  assert.equal(escapeIdentifier("]`"), "`]```");
  assert.equal(escapeIdentifier('a]"b'), '`a]"b`');
  assert.equal(escapeIdentifier("a]\\"), "`a]\\`");
});

test("the lexer reads every escapeIdentifier result as one span without markers", () => {
  const names = ["a?", "a]?", "a]`?", "a]`` ?", "`?", "]", "a] OR 1=1 --", "a]` = ? --", "a]\\` ?"];
  for (const name of names) {
    const sql = `SELECT ${escapeIdentifier(name)} FROM t WHERE x = ?`;
    for (const mode of [true, false]) {
      assert.deepEqual(findPlaceholders(sql, mode), [sql.length - 1], `${name} (${mode})`);
    }
    assert.deepEqual(findPlaceholders(sql), [sql.length - 1], name);
  }
});

test("buildWhere returns empty clause for empty input", () => {
  const result = buildWhere({});

  assert.deepEqual(result, { clause: "", params: [] });
});

test("buildWhere builds placeholders and params", () => {
  const result = buildWhere({ id: 1, name: "Alice", active: true });

  assert.equal(result.clause, "WHERE [id] = ? AND [name] = ? AND [active] = ?");
  assert.deepEqual(result.params, [1, "Alice", true]);
});

test("buildWhere uses IS NULL and omits param for null", () => {
  const result = buildWhere({ deleted_at: null, name: "A" });

  assert.equal(result.clause, "WHERE [deleted_at] IS NULL AND [name] = ?");
  assert.deepEqual(result.params, ["A"]);
});

test("buildWhere quotes a key with ] in backticks", () => {
  const result = buildWhere({ "id] OR 1=1 --": 7, "a]`b": null });

  assert.equal(result.clause, "WHERE `id] OR 1=1 --` = ? AND `a]``b` IS NULL");
  assert.deepEqual(result.params, [7]);
});

test("buildWhere keeps values parameterized against SQL injection", () => {
  const payload = "x' OR 1=1 --";
  const result = buildWhere({ name: payload });

  assert.equal(result.clause, "WHERE [name] = ?");
  assert.deepEqual(result.params, [payload]);
});

test("a ? in a buildWhere identifier is not a marker: only the value is bound", () => {
  const { clause, params } = buildWhere({ "a?": 42 });

  assert.equal(clause, "WHERE [a?] = ?");
  for (const mode of [true, false]) {
    assert.equal(interpolateParams(clause, params, mode), "WHERE [a?] = 42");
  }
});

test("a key that would close its bracket keeps its marker and binds its value", () => {
  const { clause, params } = buildWhere({ "id] OR 1=1 --": 7 });

  for (const mode of [true, false]) {
    assert.deepEqual(findPlaceholders(clause, mode), [clause.length - 1]);
    assert.equal(interpolateParams(clause, params, mode), "WHERE `id] OR 1=1 --` = 7");
  }
});
