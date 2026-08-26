import { describe, expect, test } from "bun:test";
import { asBig, computeDelta, isQuotaReached } from "../src/fup.ts";
import { quotaReached, redact, validUser } from "../src/ops.ts";

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

  test("bigint counters survive large values without precision loss", () => {
    const a = 9_007_199_254_740_993n; // 2^53 + 1
    const b = 9_007_199_254_740_993n;
    expect(a + b).toBe(18_014_398_509_481_986n);
    expect(asBig(a)).toBe(a);
  });
});

describe("hardening: input validation + redaction", () => {
  test("validUser accepts word chars, @, ., - and rejects control chars", () => {
    expect(validUser("alice")).toBe(true);
    expect(validUser("alice@isp.net-1")).toBe(true);
    expect(validUser("")).toBe(false);
    expect(validUser("a".repeat(65))).toBe(false);
    expect(validUser("bad\u0007user")).toBe(false);
    expect(validUser("bad\u0000user")).toBe(false);
    expect(validUser("bad\u007fuser")).toBe(false);
    expect(validUser("has space")).toBe(false);
    expect(validUser("slash/invalid")).toBe(false);
  });

  test("redact masks every secret occurrence, including regex metachars", () => {
    expect(redact("secret is h3110", ["h3110"])).toBe("secret is ***");
    expect(redact("pass*word", ["pass*word"])).toBe("***");
    expect(redact("xxpass*wordyy", ["pass*word"])).toBe("xx***yy");
    expect(redact("a:b", [])).toBe("a:b");
    expect(redact("x", ["x", "x"])).toBe("***");
    expect(redact("", ["anything"])).toBe("");
  });
});