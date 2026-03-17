import test from "node:test";
import assert from "node:assert/strict";

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
