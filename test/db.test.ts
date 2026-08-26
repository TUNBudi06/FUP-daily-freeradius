import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { createDb } from "../src/db.ts";

const enabled = Boolean(process.env.FUP_TEST_DB);

// Requires a real DB; skipped entirely unless FUP_TEST_DB is set.
describe.skipIf(!enabled)("db (gated)", () => {
  test("connect round-trips against real DB", async () => {
    const cfg = loadConfig({
      FUP_DB_HOST: process.env.FUP_TEST_DB_HOST ?? "localhost",
      FUP_DB_PORT: process.env.FUP_TEST_DB_PORT ?? "3306",
      FUP_DB_NAME: process.env.FUP_TEST_DB_NAME ?? "raddb",
      FUP_DB_USER: process.env.FUP_TEST_DB_USER ?? "raduser",
      FUP_DB_PASSWORD: process.env.FUP_TEST_DB_PASSWORD ?? "pw",
      FUP_NAS_IP: "10.6.7.1",
      FUP_NAS_COA_PORT: "3799",
      FUP_NAS_SECRET: "secret",
      FUP_LOG_FILE: "/tmp/fup.log",
      FUP_LOCK_FILE: "/tmp/fup.lock",
      FUP_RADCLIENT: "/usr/bin/radclient",
      FUP_RADCLIENT_DICT: "/usr/share/freeradius",
      FUP_RADCLIENT_DICT_DIR: "/etc/freeradius/3.0",
    });
    const db = createDb(cfg);
    try {
      const result = await db.query.execute(sql`SELECT 1 AS n`);
      const rows = Array.isArray(result) ? result : [result];
      expect((rows[0] as { n?: number }).n).toBe(1);
    } finally {
      await db.close();
    }
  });
});