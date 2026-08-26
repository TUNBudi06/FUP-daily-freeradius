import { describe, expect, test } from "bun:test";
import { asBig, computeDelta, isQuotaReached } from "../src/fup.ts";
import { quotaReached } from "../src/ops.ts";

describe("fup pure math (consumed by ops.ts)", () => {
  test("computeDelta: monotonic counter takes the difference", () => {
    expect(computeDelta(120n, 100n)).toBe(20n);
    expect(computeDelta(0n, 0n)).toBe(0n);
  });

  test("computeDelta: counter reset takes the full current value", () => {
    // 90 < 100 => NAS rebooted/reset => the whole 90 counts this cycle.
    expect(computeDelta(90n, 100n)).toBe(90n);
  });

  test("asBig: guards NULL and malformed values, keeps valid bigints", () => {
    expect(asBig(null)).toBe(0n);
    expect(asBig(undefined)).toBe(0n);
    expect(asBig("")).toBe(0n);
    expect(asBig("abc")).toBe(0n);
    expect(asBig("12345")).toBe(12345n);
    expect(asBig(42)).toBe(42n);
    expect(asBig(9007199254740993n)).toBe(9007199254740993n);
  });
});

describe("quota decision", () => {
  test("isQuotaReached / quotaReached only trip at or above a positive quota", () => {
    expect(isQuotaReached(500n, 1000n)).toBe(false);
    expect(isQuotaReached(1000n, 1000n)).toBe(true);
    expect(isQuotaReached(1001n, 1000n)).toBe(true);
    expect(isQuotaReached(99999n, 0n)).toBe(false); // unlimited
  });

  test("ops.re-exported quotaReached matches the pure one", () => {
    expect(quotaReached(5n, 10n)).toBe(false);
    expect(quotaReached(10n, 10n)).toBe(true);
  });
});