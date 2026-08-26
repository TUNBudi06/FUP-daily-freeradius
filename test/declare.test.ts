import { describe, expect, test } from "bun:test";
import {
  ATTR,
  DEFAULT_FUP_RATE,
  RATE_RESOLUTION_ORDER,
  isMikrotikRate,
  validRate,
} from "../src/declare.ts";

describe("declare.ts", () => {
  test("exposes canonical attribute names", () => {
    expect(ATTR.MAX_DAILY).toBe("Max-Daily-Traffic");
    expect(ATTR.RATE).toBe("Mikrotik-Rate-Limit");
    expect(ATTR.FUP_RATE).toBe("FUP-Rate-Limit");
    expect(ATTR.FUP_RESET_TIME).toBe("FUP-Reset-Time");
  });

  test("resolution order: entry+group, check before reply", () => {
    expect(RATE_RESOLUTION_ORDER).toEqual([
      "radcheck",
      "radreply",
      "radgroupcheck",
      "radgroupreply",
    ]);
  });

  test("default FUP rate", () => {
    expect(DEFAULT_FUP_RATE).toBe("5M/5M");
  });

  test("isMikrotikRate accepts valid and rejects junk", () => {
    expect(isMikrotikRate("10M/10M")).toBe(true);
    expect(isMikrotikRate("5k/1K")).toBe(true);
    expect(isMikrotikRate("0")).toBe(false);
    expect(isMikrotikRate("abc")).toBe(false);
    expect(isMikrotikRate("")).toBe(false);
  });

  test("validRate mirrors isMikrotikRate", () => {
    expect(validRate("2M/2M")).toBe(true);
    expect(validRate("nope")).toBe(false);
  });
});