import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger, resolveLogPath } from "../src/logger.ts";

describe("logger", () => {
  test("appends timestamped lines with event and message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fup-log-"));
    const logPath = join(dir, "fup.log");
    try {
      const log = createLogger(logPath);
      log.log("START", "check run");
      log.log("NEW_DAY");
      // give the async append a beat to flush
      await new Promise((r) => setTimeout(r, 20));

      const content = await readFile(logPath, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);

      // each line is ISO timestamped and prefixed with the event name
      expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*\] START: check run$/);
      expect(lines[1]).toMatch(/\] NEW_DAY$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("survives a missing directory (writes are fire-and-forget)", () => {
    const log = createLogger("/nonexistent-dir/fup.log");
    expect(() => log.log("START", "boom")).not.toThrow();
  });

  test("resolveLogPath expands ~/ to $HOME and leaves other paths alone", () => {
    expect(resolveLogPath("~/script-FUP/fup.log")).toBe(`${process.env.HOME}/script-FUP/fup.log`);
    expect(resolveLogPath("/var/log/fup.log")).toBe("/var/log/fup.log");
    expect(resolveLogPath("relative/path.log")).toBe("relative/path.log");
  });
});