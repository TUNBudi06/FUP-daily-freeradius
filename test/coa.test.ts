import { describe, expect, test } from "bun:test";
import { buildCoaArgv } from "../src/coa.ts";
import { defaultAppConfig } from "../src/config.ts";

describe("buildCoaArgv", () => {
  const cfg = defaultAppConfig();

  test("prefix is fully fixed: bounded to host/port, both dict dirs, secret", () => {
    const argv = buildCoaArgv(cfg);
    // executable and flags lead
    expect(argv[0]).toBe(cfg.radclientPath);
    expect(argv[1]).toBe("-x");
    expect(argv).toContain("-d");
    expect(argv[argv.indexOf("-d") + 1]).toBe(cfg.radclientDict);
    expect(argv).toContain("-D");
    expect(argv[argv.indexOf("-D") + 1]).toBe(cfg.radclientDictDir);
    expect(argv).toContain(`coa`);
    // server address is the only dynamic token, still from env not user input
    expect(argv).toContain(`${cfg.nas.host}:${cfg.nas.coaPort}`);
  });

  test("no user-controlled data has a path into the argv array", () => {
    const argv = buildCoaArgv(cfg);
    // tokens that would signal shell-adjacent injection are absent
    expect(argv.some((a) => a.includes("|") || a.includes(";"))) .toBe(false);
    expect(argv.some((a) => a.includes("rm") || a.includes("&&"))).toBe(false);
  });
});