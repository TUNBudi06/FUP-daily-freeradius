import { mysqlTable, timestamp, varchar, int, bigint, index } from "drizzle-orm/mysql-core";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import type { AppConfig } from "./config.ts";

/**
 * `fup_state` — one row per accounting user. `throttled_at` records the moment
 * the throttle was applied; FUP-Reset-Time auto-unthrottle compares the wall
 * clock against `throttled_at + resetMinutes`.
 */
export const fupState = mysqlTable("fup_state", {
  username: varchar("username", { length: 64 }).primaryKey(),
  normalRate: varchar("normal_rate", { length: 64 }),
  fupDate: varchar("fup_date", { length: 10 }),
  throttled: int("throttled"),
  throttledAt: timestamp("throttled_at"),
  lastUpdated: varchar("last_updated", { length: 20 }),
});

/** `fup_session_state` — per accounting session counters. Columns pinned to the existing table. */
export const fupSessionState = mysqlTable(
  "fup_session_state",
  {
    id: int("id").primaryKey().autoincrement(),
    username: varchar("username", { length: 64 }).notNull(),
    acctuniqueid: varchar("acctuniqueid", { length: 64 }).notNull(),
    acctsessionid: varchar("acctsessionid", { length: 64 }),
    framedipaddress: varchar("framedipaddress", { length: 64 }),
    lastInput: bigint("last_input", { mode: "number" }),
    lastOutput: bigint("last_output", { mode: "number" }),
    usageDate: varchar("usage_date", { length: 10 }),
    dailyInput: bigint("daily_input", { mode: "number" }),
    dailyOutput: bigint("daily_output", { mode: "number" }),
    lastSeen: varchar("last_seen", { length: 20 }),
    closed: int("closed"),
  },
  (t) => [index("idx_session_username").on(t.username)]
);

const dbSchema = { fupState, fupSessionState };

/** Typed Drizzle session plus the underlying pool so it can be closed. */
export interface Db {
  query: MySql2Database<typeof dbSchema>;
  close(): Promise<void>;
}

/** Open a typed Drizzle connection backed by a mysql2 pool. */
export function createDb(cfg: AppConfig): Db {
  const pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
  });
  return {
    query: drizzle(pool, { schema: dbSchema, mode: "default" }),
    close: () => pool.end(),
  };
}