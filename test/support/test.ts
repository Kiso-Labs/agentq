import { expect, vi } from "vitest";

export { afterEach, beforeEach, describe, expect, test } from "vitest";

export const mock = vi.fn;

expect.extend({
  toBeTrue(received: unknown) {
    return {
      pass: received === true,
      message: () => `expected ${String(received)} to be true`,
    };
  },
  toBeFalse(received: unknown) {
    return {
      pass: received === false,
      message: () => `expected ${String(received)} to be false`,
    };
  },
  toBeNumber(received: unknown) {
    return {
      pass: typeof received === "number",
      message: () => `expected ${String(received)} to be a number`,
    };
  },
  toBeString(received: unknown) {
    return {
      pass: typeof received === "string",
      message: () => `expected ${String(received)} to be a string`,
    };
  },
  toStartWith(received: unknown, prefix: string) {
    return {
      pass: typeof received === "string" && received.startsWith(prefix),
      message: () => `expected ${String(received)} to start with ${prefix}`,
    };
  },
});

export function setDefaultTimeout(milliseconds: number): void {
  vi.setConfig({ testTimeout: milliseconds, hookTimeout: milliseconds });
}

declare module "vitest" {
  interface Assertion<T> {
    toBeTrue(): T;
    toBeFalse(): T;
    toBeNumber(): T;
    toBeString(): T;
    toStartWith(prefix: string): T;
  }
}
