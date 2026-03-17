export function escapeIdentifier(name: string): string {
  return `[${name.replace(/\]/g, "]]" )}]`;
}

export function buildWhere(
  conditions: Record<string, unknown>,
): { clause: string; params: unknown[] } {
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
