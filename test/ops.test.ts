import { describe, expect, test } from "bun:test";
import { asBig, computeDelta, isQuotaReached } from "../src/fup.ts";
import {
  loadThrottledJoin,
  quotaReached,
  redact,
  resetGraceElapsed,
  validUser,
} from "../src/ops.ts";
import type { Db } from "../src/db.ts";

/** Minimal fake Db: `execute` resolves to the mysql2 `[rows, fields]` tuple,
 *  which is exactly the shape `unwrapRows` in ops.ts unwraps. */
function fakeDb(rows: unknown[]): Db {
  return {
    query: { execute: () => Promise.resolve([rows, []]) },
    close: () => Promise.resolve(),
  } as unknown as Db;
}

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

describe("unthrottle / FUP-Reset-Time grace", () => {
  test("loadThrottledJoin maps DB snake_case rows to camelCase fields", async () => {
    const at = new Date("2026-09-01T10:00:00Z");
    const db = fakeDb([
      {
        acctuniqueid: "sess-1",
        framedipaddress: "10.6.7.20",
        throttled_at: at,
        throttled_rate: "512k/512k",
      },
    ]);
    const join = await loadThrottledJoin(db, "alice");
    expect(join).toHaveLength(1);
    expect(join[0].acctuniqueid).toBe("sess-1");
    expect(join[0].framedipaddress).toBe("10.6.7.20");
    // The regression: the consumer needs a real Date, not `undefined`.
    expect(join[0].throttledAt).toBeInstanceOf(Date);
    expect(join[0].throttledAt.getTime()).toBe(at.getTime());
    expect(join[0].throttledRate).toBe("512k/512k");
  });

  test("loadThrottledJoin coerces string timestamps to Date", async () => {
    const db = fakeDb([
      {
        acctuniqueid: "sess-2",
        framedipaddress: "10.6.7.21",
        throttled_at: "2026-09-01T10:00:00Z",
        throttled_rate: "1M/1M",
      },
    ]);
    const join = await loadThrottledJoin(db, "bob");
    expect(join[0].throttledAt).toBeInstanceOf(Date);
    expect(join[0].throttledAt.getTime()).toBe(Date.parse("2026-09-01T10:00:00Z"));
  });

  test("a device inside its grace window is NOT restored", () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    const throttled = new Date(now - 29 * 60_000); // 29 min ago
    expect(resetGraceElapsed(throttled, 30, now)).toBe(false);
  });

  test("a device whose grace has elapsed IS restored", () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    expect(resetGraceElapsed(new Date(now - 30 * 60_000), 30, now)).toBe(true);
    expect(resetGraceElapsed(new Date(now - 90 * 60_000), 30, now)).toBe(true);
  });

  test("an unparseable timestamp does not pin a user throttled forever", () => {
    expect(resetGraceElapsed(new Date("nonsense"), 30, Date.now())).toBe(true);
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
describe("day boundary + rate safety", () => {
  test("normalizeDay treats Date and string days identically", async () => {
    const { normalizeDay } = await import("../src/ops.ts");
    expect(normalizeDay("2026-09-26")).toBe("2026-09-26");
    expect(normalizeDay("2026-09-26 00:00:00")).toBe("2026-09-26");
    expect(normalizeDay(new Date(2026, 8, 26))).toBe("2026-09-26"); // local getters
    expect(normalizeDay(new Date("nope"))).toBeNull();
    expect(normalizeDay(null)).toBeNull();
  });

  test("isSafeRateString allows burst syntax, rejects injection", async () => {
    const { isSafeRateString } = await import("../src/declare.ts");
    expect(isSafeRateString("5M/5M")).toBe(true);
    expect(isSafeRateString("10M/10M 20M/20M 8M/8M 8/8")).toBe(true);
    expect(isSafeRateString('5M/5M"\nUser-Name = "x')).toBe(false);
    expect(isSafeRateString("")).toBe(false);
  });

  test("sendCoa refuses unsafe input without spawning radclient", async () => {
    const { sendCoa } = await import("../src/coa.ts");
    const { defaultAppConfig } = await import("../src/config.ts");
    const logger = { log() {}, detail() {} };
    const cfg = { ...defaultAppConfig(), radclientPath: "/nonexistent/radclient" };
    const r = await sendCoa(cfg, logger, "alice", "10.0.0.1", '5M/5M"\nX = "1', "throttle");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("refused");
    expect((await sendCoa(cfg, logger, 'a"b', "10.0.0.1", "5M/5M", "throttle")).detail).toContain("refused");
  });
});

describe("prod-readiness logging", () => {
  test("coaEventName: ACK/TIMEOUT/FAILED are distinguished", async () => {
    const { coaEventName } = await import("../src/ops.ts");
    expect(coaEventName({ channel: "throttle", ok: true, detail: "" })).toBe("COA_ACK");
    expect(coaEventName({ channel: "throttle", ok: false, detail: "", timedOut: true })).toBe("COA_TIMEOUT");
    expect(coaEventName({ channel: "throttle", ok: false, detail: "" })).toBe("COA_FAILED");
  });

  test("safeConfigSummary never includes the DB password or NAS secret", async () => {
    const { defaultAppConfig, safeConfigSummary } = await import("../src/config.ts");
    const cfg = defaultAppConfig();
    const summary = safeConfigSummary(cfg);
    expect(summary).not.toContain(cfg.db.password);
    expect(summary).not.toContain(cfg.nas.secret);
    expect(summary).toContain(cfg.nas.host);
    expect(summary).toContain(cfg.db.host);
    expect(summary).toContain(String(cfg.debugLevel));
  });
});
