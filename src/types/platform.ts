// Environment types for the public declarations (#309). The published .d.ts
// must compile without Node's types or the DOM lib, so it names neither
// `Buffer` nor `AbortSignal`. Each type below resolves to the real Node or DOM
// type when the consumer has it, so Node users see exactly the type they saw
// before, and to a minimal structural type otherwise.

/**
 * Bytes: Node's `Buffer` when the program has Node's types (`@types/node`),
 * otherwise `Uint8Array`, which `Buffer` extends. At run time the client always
 * returns a `Buffer`.
 */
export type CubridBytes = typeof globalThis extends {
  Buffer: { isBuffer(value: unknown): value is infer B };
}
  ? B
  : Uint8Array;

/**
 * The members of an abort signal that the client uses. Only the fallback of
 * {@link CubridAbortSignal} when neither Node's types nor the DOM lib are present.
 */
interface AbortSignalShape {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/**
 * An abort signal: the global `AbortSignal` when the program has Node's types or
 * the DOM lib, otherwise a structural type with the members the client uses. At
 * run time a `signal` option must still be a real `AbortSignal`; any other object
 * is refused with a `TypeError`.
 */
export type CubridAbortSignal = typeof globalThis extends {
  AbortSignal: { prototype: infer S };
}
  ? S
  : AbortSignalShape;
