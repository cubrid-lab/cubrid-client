import test from "node:test";
import assert from "node:assert/strict";
import { publicDeclarationSurface } from "../scripts/api-public-surface.mjs";

const baseline = `
  /** Documentation */
  declare class Client {
    private connection;
    query<T>(sql: string): Promise<T[]>;
    protected reconnect(): Promise<void>;
  }
  export { Client };
`;

test("ignores private fields, methods and explanatory comments", () => {
  const changed = `
    /** Changed documentation */
    declare class Client {
      private connection;
      private generation;
      /** Internal only */
      private reset(): void;
      query<T>(sql: string): Promise<T[]>;
      protected reconnect(): Promise<void>;
    }
    export { Client };
  `;
  assert.equal(publicDeclarationSurface(changed), publicDeclarationSurface(baseline));
});

test("detects public runtime and TypeScript contract changes", () => {
  const changes = [
    baseline.replace("query<T>(sql: string)", "query<T>(sql: number)"),
    baseline.replace("Promise<T[]>", "Promise<T | null>"),
    baseline.replace("protected reconnect()", "private reconnect()"),
    baseline.replace("export { Client }", "export { Client as DatabaseClient }"),
    baseline.replace("query<T>(sql: string): Promise<T[]>;", ""),
  ];
  for (const contents of changes) {
    assert.notEqual(publicDeclarationSurface(contents), publicDeclarationSurface(baseline));
  }
});

test("normalizes line endings and declaration comments", () => {
  assert.equal(publicDeclarationSurface(baseline.replaceAll("\n", "\r\n")), publicDeclarationSurface(baseline));
});
