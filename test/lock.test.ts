import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Lock } from "../src/lock.ts";

describe("Lock", () => {
  test("acquire then release round-trips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fup-lock-"));
    const path = join(dir, "fup.lock");
    try {
      const lock = new Lock(path);
      expect(await lock.acquire()).toBe(true);
      // guard directory should now exist
      expect((await readdir(dir)).includes("fup.lock")).toBe(true);
      await lock.release();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a second acquire while held returns false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fup-lock-"));
    const path = join(dir, "fup.lock");
    try {
      const first = new Lock(path);
      const second = new Lock(path);
      expect(await first.acquire()).toBe(true);
      expect(await second.acquire()).toBe(false);
      await first.release();
      expect(await second.acquire()).toBe(true);
      await second.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("release is idempotent when lock was never held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fup-lock-"));
    const path = join(dir, "fup.lock");
    try {
      const lock = new Lock(path);
      await expect(lock.release()).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});