import assert from "node:assert/strict";
import test from "node:test";

import { findPlaceholders, interpolateParams } from "../src/protocol/protocol.js";
import { buildWhere, escapeIdentifier } from "../src/utils/query.js";

test("escapeIdentifier wraps names in brackets", () => {
  assert.equal(escapeIdentifier("users"), "[users]");
});

test("escapeIdentifier escapes closing brackets", () => {
  assert.equal(escapeIdentifier("a]b"), "[a]]b]");
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

test("buildWhere escapes suspicious identifier input", () => {
  const result = buildWhere({ "id] OR 1=1 --": 7 });

  assert.equal(result.clause, "WHERE [id]] OR 1=1 --] = ?");
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

test("a key that closes its bracket cannot hide the marker behind a comment", () => {
  // CUBRID ends [id] at the first ]: ]] is not an escape, so the server reads a
  // stray ] (a syntax error) and the client finds no marker for the value.
  const { clause, params } = buildWhere({ "id] OR 1=1 --": 7 });

  assert.deepEqual(findPlaceholders(clause, true), []);
  assert.throws(() => interpolateParams(clause, params, true), /Parameter count mismatch/);
});
