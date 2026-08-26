import { describe, expect, test } from "bun:test";
import { isValidIp, loadConfig } from "../src/config.ts";

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
});