import { describe, expect, test } from "bun:test";
import { isValidIp, loadConfig, parseDebugLevel } from "../src/config.ts";

const base = {
  FUP_DB_HOST: "db.lan",
  FUP_DB_PORT: "3306",
  FUP_DB_NAME: "raddb",
  FUP_DB_USER: "raduser",
  FUP_DB_PASSWORD: "pw",
  FUP_NAS_IP: "10.6.7.1",
  FUP_NAS_COA_PORT: "3799",
  FUP_NAS_SECRET: "secret",
  FUP_LOG_FILE: "/tmp/fup.log",
  FUP_LOCK_FILE: "/tmp/fup.lock",
  FUP_RADCLIENT: "/usr/bin/radclient",
  FUP_RADCLIENT_DICT: "/usr/share/freeradius",
  FUP_RADCLIENT_DICT_DIR: "/etc/freeradius/3.0",
};

describe("config", () => {
  test("builds a typed config from env", () => {
    const c = loadConfig(base);
    expect(c.db.host).toBe("db.lan");
    expect(c.db.port).toBe(3306);
    expect(c.nas.host).toBe("10.6.7.1");
    expect(c.nas.coaPort).toBe(3799);
    expect(c.radclientDict).toBe("/usr/share/freeradius");
  });

  test("rejects missing DB password", () => {
    expect(() => loadConfig({ ...base, FUP_DB_PASSWORD: "" })).toThrow(/FUP_DB_PASSWORD/);
  });

  test("rejects invalid NAS IP", () => {
    expect(() => loadConfig({ ...base, FUP_NAS_IP: "not-an-ip" })).toThrow(/FUP_NAS_IP/);
  });

  test("rejects invalid port", () => {
    expect(() => loadConfig({ ...base, FUP_NAS_COA_PORT: "abc" })).toThrow(/FUP_NAS_COA_PORT/);
  });

  test("isValidIp validates IPv4 bounds", () => {
    expect(isValidIp("10.0.0.1")).toBe(true);
    expect(isValidIp("256.1.1.1")).toBe(false);
    expect(isValidIp("10.0.0")).toBe(false);
  });

  test("debug level defaults to 0 and accepts 0/1/2", () => {
    expect(loadConfig(base).debugLevel).toBe(0);
    expect(loadConfig({ ...base, FUP_DEBUG: "0" }).debugLevel).toBe(0);
    expect(loadConfig({ ...base, FUP_DEBUG: "1" }).debugLevel).toBe(1);
    expect(loadConfig({ ...base, FUP_DEBUG: "2" }).debugLevel).toBe(2);
  });

  test("debug level tolerates surrounding whitespace", () => {
    expect(parseDebugLevel(" 1 ")).toBe(1);
    expect(parseDebugLevel("\t2\n")).toBe(2);
  });

  test("debug level clamps above 2 and falls back to 0 otherwise", () => {
    expect(parseDebugLevel("3")).toBe(2);
    expect(parseDebugLevel("99")).toBe(2);
    expect(parseDebugLevel(undefined)).toBe(0);
    expect(parseDebugLevel("")).toBe(0);
    expect(parseDebugLevel("   ")).toBe(0);
    expect(parseDebugLevel("abc")).toBe(0);
    expect(parseDebugLevel("1.5")).toBe(0);
    expect(parseDebugLevel("-1")).toBe(0);
    expect(parseDebugLevel("NaN")).toBe(0);
    expect(parseDebugLevel("1e2")).toBe(0);
  });
});