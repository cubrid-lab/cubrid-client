/**
 * Quotes `name` as one CUBRID identifier.
 *
 * A name without `]` is wrapped in brackets as is: `users` becomes `[users]`.
 * A CUBRID bracket identifier ends at the first `]` and has no escape, so a name
 * that contains `]` is wrapped in backticks instead, with each backtick in it
 * doubled: `a]b` becomes `` `a]b` ``. Backticks quote the same way whatever
 * `ansi_quotes` and `no_backslash_escapes` are set to.
 *
 * CUBRID 11.2 and later refuse `[` and `]` in any identifier, so the server
 * rejects such a name there; CUBRID 10.2 and 11.0 accept it.
 */
export function escapeIdentifier(name: string): string {
  if (name.includes("]")) {
    return `\`${name.replace(/`/g, "``")}\``;
  }
  return `[${name}]`;
}

/**
 * Builds a `WHERE` clause that matches every entry of `conditions`. Each key is
 * quoted with {@link escapeIdentifier}; each non-null value becomes a `?` marker
 * and is returned in `params`, and `null` becomes `IS NULL` with no value.
 */
export function buildWhere(conditions: Record<string, unknown>): {
  clause: string;
  params: unknown[];
} {
  const entries = Object.entries(conditions);

  if (entries.length === 0) {
    return { clause: "", params: [] };
  }

  const parts: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of entries) {
    const escaped = escapeIdentifier(key);

    if (value === null) {
      parts.push(`${escaped} IS NULL`);
      continue;
    }

    parts.push(`${escaped} = ?`);
    params.push(value);
  }

  return {
    clause: `WHERE ${parts.join(" AND ")}`,
    params,
  };
}
