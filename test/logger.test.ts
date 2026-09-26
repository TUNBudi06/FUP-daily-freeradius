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

  test("level 0 writes to file but does not echo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fup-log-"));
    const logPath = join(dir, "fup.log");
    const orig = console.error;
    const echoed: string[] = [];
    console.error = (line: string) => echoed.push(line);
    try {
      const log = createLogger(logPath, 0);
      log.log("START", "quiet");
      log.detail(2, "SESSION", "user=alice");
      await new Promise((r) => setTimeout(r, 20));
      expect(echoed).toEqual([]);
      const file = await readFile(logPath, "utf8");
      // detail() always reaches the file even when it is not echoed.
      expect(file).toContain("SESSION: user=alice");
    } finally {
      console.error = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("level 1 echoes log() but not detail(2)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fup-log-"));
    const logPath = join(dir, "fup.log");
    const orig = console.error;
    const echoed: string[] = [];
    console.error = (line: string) => echoed.push(line);
    try {
      const log = createLogger(logPath, 1);
      log.log("START", "loud");
      log.detail(2, "SESSION", "user=alice");
      log.detail(1, "DETAIL", "level1");
      expect(echoed).toHaveLength(2);
      expect(echoed[0]).toContain("START: loud");
      expect(echoed[1]).toContain("DETAIL: level1");
    } finally {
      console.error = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("level 2 echoes detail(2), and a boolean true still means level 1", () => {
    const dir = tmpdir();
    const logPath = join(dir, `fup-boolean-${process.pid}-${Date.now()}.log`);
    const orig = console.error;
    const echoed: string[] = [];
    console.error = (line: string) => echoed.push(line);
    try {
      createLogger(logPath, 2).detail(2, "SESSION", "user=alice");
      createLogger(logPath, true).log("START", "legacy");
      createLogger(logPath, true).detail(2, "SESSION", "user=bob");
      expect(echoed).toHaveLength(2);
      expect(echoed[0]).toContain("SESSION: user=alice");
      expect(echoed[1]).toContain("START: legacy");
    } finally {
      console.error = orig;
    }
  });
});