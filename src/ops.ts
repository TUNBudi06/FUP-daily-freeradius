/**
 * ops.ts — the DRY core. Every operation the two entrypoints (`fup-check.ts`
 * and `fup-reset.ts`) share lives here exactly once. The entrypoints only wire
 * config, lock, logger, db, and these functions together; they never re-implement
 * attribute resolution, session delta accounting, rebase, quota reset, or CoA
 * fan-out. This mirrors the behaviour of `fup-coa-check.sh` / `fup-coa-reset.sh`.
 */
import type { AppConfig } from "./config.ts";
import { isValidIp } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { Db } from "./db.ts";
import { sql } from "drizzle-orm";
import { ATTR, DEFAULT_FUP_RATE } from "./declare.ts";
import { asBig, computeDelta, isQuotaReached } from "./fup.ts";
import { sendCoa } from "./coa.ts";

/** Word-chars plus the few safe separators allowed in a radius username. */
const reUser = /^[\w@.\-]+$/;

/**
 * Redact every occurrence of any secret with `***`. Split/join (not regex) so
 * secret content containing regex metacharacters is still fully replaced.
 * Call this before any value reaches `logger.log`.
 */
export function redact(value: string, secrets: string[]): string {
  let out = value;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("***");
  }
  return out;
}

/**
 * True when `u` is a safe radius username: 1..64 chars, no control characters,
 * and only word chars plus `@`, `.`, `-`. Used to skip malformed rows before
 * any logging or CoA.
 */
export function validUser(u: string): boolean {
  if (!u || u.length > 64 || u.length === 0) return false;
  const first = u.charCodeAt(0);
  if (first < 0x20 || first === 0x7f) return false;
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return reUser.test(u);
}

/** One active accounting session pulled from `radacct`. */
export interface SessionState {
  acctuniqueid: string;
  username: string;
  input: bigint;
  output: bigint;
}

/** Per-user accumulated today's throughput. */
export interface UserUsage {
  dailyInput: bigint;
  dailyOutput: bigint;
}

/** The resolved FUP decision for a user, from RADIUS attributes. */
export interface UserPlan {
  quota: bigint; // Max-Daily-Traffic bytes; 0 = unlimited
  fupRate: string; // rate to enforce when throttled
  resetMinutes: number | null; // FUP-Reset-Time minutes; null = no auto-reset
  normalRate: string; // rate to restore on reset
}

/** Run a query and unwrap its first row (or undefined when empty). */
async function first<T>(db: Db, q: ReturnType<typeof db.query.execute>): Promise<T | undefined> {
  const rows = await q;
  const arr = Array.isArray(rows) ? rows : [rows];
  return arr[0] as T | undefined;
}

/** Run a query and unwrap the full result array. */
async function rows<T>(db: Db, q: ReturnType<typeof db.query.execute>): Promise<T[]> {
  const r = await q;
  return (Array.isArray(r) ? r : [r]) as T[];
}

// ----------------------------- radacct reads -----------------------------

/** Active (open) sessions: no stop time, valid username + framed IP. */
export async function fetchActiveSessions(db: Db, username?: string): Promise<SessionState[]> {
  const res = await rows<{ acctuniqueid: string; username: string; input: unknown; output: unknown }>(
    db,
    db.query.execute(sql`
      SELECT acctuniqueid, username,
             COALESCE(acctinputoctets, 0) AS input,
             COALESCE(acctoutputoctets, 0) AS output
      FROM radacct
      WHERE acctstoptime IS NULL
        AND username IS NOT NULL AND username <> ''
        AND framedipaddress IS NOT NULL AND framedipaddress <> ''
        AND acctuniqueid IS NOT NULL AND acctuniqueid <> ''
        ${username ? sql`AND username = ${username}` : sql``}
    `),
  );
  return res.map((r) => ({
    acctuniqueid: r.acctuniqueid,
    username: r.username,
    input: asBig(r.input),
    output: asBig(r.output),
  }));
}

/** Open session IPs for a user, validated (used to fan out CoAs). */
export async function activeSessionIps(db: Db, username: string): Promise<string[]> {
  const res = await rows<{ ip: string }>(
    db,
    db.query.execute(sql`
      SELECT DISTINCT framedipaddress AS ip
      FROM radacct
      WHERE username = ${username}
        AND acctstoptime IS NULL
        AND framedipaddress IS NOT NULL AND framedipaddress <> ''
    `),
  );
  return res.map((r) => r.ip).filter((ip) => isValidIp(ip));
}

// ----------------------------- session state -----------------------------

/**
 * Upsert one session's per-cycle counters and daily accumulation. The delta is
 * counter-reset aware (see `computeDelta`). On a new day the daily counters are
 * zeroed so today's usage starts fresh. Mirrors the Bash UPSERT block.
 */
export async function updateSessionState(db: Db, s: SessionState): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD usage_date

  const prior = await first<{ last_input: unknown; last_output: unknown; daily_input: unknown; daily_output: unknown; usage_date: string }>(
    db,
    db.query.execute(sql`
      SELECT last_input, last_output, daily_input, daily_output, usage_date
      FROM fup_session_state WHERE acctuniqueid = ${s.acctuniqueid} LIMIT 1
    `),
  );

  const lastInput = prior ? asBig(prior.last_input) : 0n;
  const lastOutput = prior ? asBig(prior.last_output) : 0n;
  let dailyInput = prior ? asBig(prior.daily_input) : 0n;
  let dailyOutput = prior ? asBig(prior.daily_output) : 0n;
  const usageDate = prior?.usage_date || today;

  if (usageDate !== today) {
    // NEW_DAY: rebase baseline and zero today's usage.
    dailyInput = 0n;
    dailyOutput = 0n;
  } else {
    dailyInput += computeDelta(s.input, lastInput);
    dailyOutput += computeDelta(s.output, lastOutput);
  }

  await db.query.execute(sql`
    INSERT INTO fup_session_state
      (username, acctuniqueid, acctsessionid, framedipaddress,
       last_input, last_output, usage_date, daily_input, daily_output, last_seen, closed)
    VALUES
      (${s.username}, ${s.acctuniqueid}, ${s.username}, '0.0.0.0',
       ${s.input}, ${s.output}, ${today}, ${dailyInput}, ${dailyOutput}, NOW(), 0)
    ON DUPLICATE KEY UPDATE
      last_input = VALUES(last_input),
      last_output = VALUES(last_output),
      usage_date = VALUES(usage_date),
      daily_input = VALUES(daily_input),
      daily_output = VALUES(daily_output),
      last_seen = NOW(),
      closed = 0
  `);
}

/**
 * Rebase open sessions to current octet counters and zero today's usage; zero
 * closed sessions. Called at midnight and at quota reset so a fresh daily quota
 * starts from zero. Mirrors the Bash reset block.
 */
export async function rebaseSessionBaselines(db: Db, username?: string): Promise<void> {
  const userCond = username ? sql`AND fss.username = ${username}` : sql``;
  await db.query.execute(sql`
    UPDATE fup_session_state fss
    JOIN radacct ra ON ra.acctuniqueid = fss.acctuniqueid AND ra.acctstoptime IS NULL
    SET fss.last_input = COALESCE(ra.acctinputoctets, 0),
        fss.last_output = COALESCE(ra.acctoutputoctets, 0),
        fss.daily_input = 0,
        fss.daily_output = 0,
        fss.usage_date = CURRENT_DATE,
        fss.last_seen = NOW(),
        fss.closed = 0
    ${userCond}
  `);
  await db.query.execute(sql`
    UPDATE fup_session_state
    SET daily_input = 0, daily_output = 0, usage_date = CURRENT_DATE
    WHERE closed = 1 ${username ? sql`AND username = ${username}` : sql``}
  `);
}

// ----------------------------- attribute resolution -----------------------------

/**
 * Resolve an attribute by fallback order (radcheck -> radreply ->
 * radgroupcheck -> radgroupreply), mirroring the Bash `COALESCE` chains.
 * Table names come from a fixed constant (safe to interpolate); attr values are
 * bound as parameters.
 */
async function resolveAttr(db: Db, username: string, attr: string): Promise<string | undefined> {
  const order = [
    { table: "radcheck", grouped: false },
    { table: "radreply", grouped: false },
    { table: "radgroupcheck", grouped: true },
    { table: "radgroupreply", grouped: true },
  ] as const;

  for (const { table, grouped } of order) {
    const qs = grouped
      ? sql`
          SELECT gc.value AS value
          FROM radusergroup ug JOIN ${sql.raw(table)} gc
            ON gc.groupname = ug.groupname AND gc.attribute = ${attr}
          WHERE ug.username = ${username} ORDER BY ug.priority ASC LIMIT 1
        `
      : sql`
          SELECT value FROM ${sql.raw(table)}
          WHERE username = ${username} AND attribute = ${attr}
          ORDER BY id DESC LIMIT 1
        `;
    const row = await first<{ value?: string }>(db, db.query.execute(qs));
    if (row?.value) return row.value;
  }
  return undefined;
}

/** Normal (un-throttled) rate for a user, or null when none is configured. */
export async function resolveNormalRate(db: Db, username: string): Promise<string | null> {
  // Prefer what we last enforced and saved in fup_state.
  const fromState = await first<{ normal_rate: string }>(
    db,
    db.query.execute(sql`
      SELECT normal_rate FROM fup_state
      WHERE username = ${username} AND normal_rate IS NOT NULL
        AND normal_rate <> '' AND normal_rate <> '0' LIMIT 1
    `),
  );
  if (fromState?.normal_rate) return fromState.normal_rate;
  // Fall back to the checked attribute (radcheck/radreply).
  return (await resolveAttr(db, username, ATTR.RATE).then((v) => v ?? null)) ?? null;
}

/** Read a user's daily quota, enforce rate, and optional reset time. */
export async function resolveUserPlan(db: Db, username: string): Promise<UserPlan> {
  const maxDaily = await resolveAttr(db, username, ATTR.MAX_DAILY);
  const fupRate = await resolveAttr(db, username, ATTR.FUP_RATE);
  const resetMin = await resolveAttr(db, username, ATTR.FUP_RESET_TIME);
  const quota = asBig(maxDaily);
  const normalRate = await resolveNormalRate(db, username);
  return {
    quota,
    fupRate: fupRate && fupRate !== "0" ? fupRate : DEFAULT_FUP_RATE,
    resetMinutes: resetMin && /^\d+$/.test(resetMin) ? Number(resetMin) : null,
    normalRate: normalRate ?? "",
  };
}

// ----------------------------- throttle / restore -----------------------------

/** Flip the throttled flag; record throttled_at when enabling (drives reset-time). */
export async function setThrottled(db: Db, username: string, throttled: boolean): Promise<void> {
  await db.query.execute(sql`
    UPDATE fup_state
    SET throttled = ${throttled ? 1 : 0},
        throttled_at = ${throttled ? sql`CURRENT_TIMESTAMP` : sql`NULL`},
        last_updated = NOW()
    WHERE username = ${username}
  `);
}

/** Clear throttle flags and `throttled_at`, and advance the reset day. */
export async function resetQuota(db: Db, username?: string): Promise<void> {
  await db.query.execute(sql`
    UPDATE fup_state
    SET fup_date = CURRENT_DATE, throttled = 0, throttled_at = NULL, last_updated = NOW()
    ${username ? sql`WHERE username = ${username}` : sql``}
  `);
}

/**
 * Send the enforced rate to every active IP of a user. Any ACK counts as
 * success; a partial failure still leaves the flag set (retried next cycle).
 */
export async function coaFanOut(
  cfg: AppConfig,
  db: Db,
  logger: Logger,
  username: string,
  rate: string,
): Promise<boolean> {
  const ips = await activeSessionIps(db, username);
  if (ips.length === 0) return false;
  let ack = false;
  const secrets = [cfg.nas.secret, cfg.db.password];
  for (const ip of ips) {
    // Only CoA a validated address — never touch a malformed one.
    if (!isValidIp(ip)) {
      logger.log("SKIP", `${username} invalid IP ${ip}`);
      continue;
    }
    const res = await sendCoa(cfg, username, ip, rate, "throttle");
    logger.log(
      res.ok ? "COA_ACK" : "COA_FAILED",
      redact(`${username} IP=${ip} -> ${rate} (${res.detail})`, secrets),
    );
    if (res.ok) ack = true;
  }
  return ack;
}

/**
 * Restore a user by CoA'ing their normal rate, then clear throttle and rebase
 * their session baselines so the next daily quota starts from zero. Shared by
 * the reset entrypoint and the FUP-Reset-Time auto-unthrottle.
 */
export async function unthrottleUser(
  cfg: AppConfig,
  db: Db,
  logger: Logger,
  username: string,
): Promise<boolean> {
  const normal = await resolveNormalRate(db, username);
  if (!normal) {
    logger.log("ERROR", `no normal rate for ${username}`);
    return false;
  }
  const ack = await coaFanOut(cfg, db, logger, username, normal);
  await resetQuota(db, username);
  await rebaseSessionBaselines(db, username);
  if (ack) logger.log("RESTORE", `${username} -> ${normal}`);
  return ack;
}

/** Reached-quota predicate, re-exported so entrypoints stay thin. */
export function quotaReached(daily: bigint, quota: bigint): boolean {
  return isQuotaReached(daily, quota);
}

/** Throttle/state row for one user from `fup_state`. */
export interface ThrottleState {
  throttled: boolean;
  fupDate: string | null;
  throttledAt: Date | null;
}

/**
 * Read a user's throttle flag, active FUP day, and throttled_at timestamp.
 * Missing rows default to unthrottled/current-day/no-throttle-time, matching
 * the Bash `COALESCE` defaults.
 */
export async function fetchThrottleState(db: Db, username: string): Promise<ThrottleState> {
  const row = await first<{ throttled: unknown; fup_date: string | null; throttled_at: Date | null }>(
    db,
    db.query.execute(sql`
      SELECT COALESCE(throttled, 0) AS throttled,
             COALESCE(fup_date, CURRENT_DATE) AS fup_date,
             throttled_at
      FROM fup_state WHERE username = ${username} LIMIT 1
    `),
  );
  return {
    throttled: asBig(row?.throttled) === 1n,
    fupDate: row?.fup_date ?? null,
    throttledAt: row?.throttled_at ?? null,
  };
}

/**
 * Run one full check cycle (mirrors `fup-coa-check.sh`): ensure a `fup_state`
 * row and day rollover, then for each user past quota and not throttled, CoA
 * the FUP rate and mark throttled on an ACK. Returns per-user counters for the
 * SUMMARY log.
 */
export async function runCheckCycle(
  cfg: AppConfig,
  db: Db,
  logger: Logger,
): Promise<{ examined: number; throttled: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const daily = await aggregateUsage(db);

  // Ensure a fup_state row exists and roll a stale day over (NEW_DAY reset).
  await db.query.execute(sql`
    INSERT INTO fup_state (username, normal_rate, fup_date, throttled, last_updated)
    SELECT username, NULL, ${today}, 0, NOW() FROM fup_session_state
    GROUP BY username
    ON DUPLICATE KEY UPDATE username = username
  `);
  await db.query.execute(sql`
    UPDATE fup_state SET throttled = 0, last_updated = NOW()
    WHERE fup_date IS NOT NULL AND fup_date <> ${today}
  `);

  let examined = 0;
  let throttled = 0;

  for (const [username, use] of daily) {
    examined++;
    if (!validUser(username)) {
      logger.log("SKIP", `invalid username ${username}`);
      continue;
    }
    const plan = await resolveUserPlan(db, username);
    if (plan.quota <= 0n) continue;
    logger.log("DAILY_USAGE", `${username} = ${use.dailyInput +use.dailyOutput} bytes (quota=${plan.quota})`);
    const state = await fetchThrottleState(db, username);
    if (state.throttled) continue;
    if (!isQuotaReached(use.dailyInput + use.dailyOutput, plan.quota)) continue;

    logger.log("FUP_REACHED", `${username} (usage=${use.dailyInput + use.dailyOutput} >= quota=${plan.quota})`);
    // Save normal rate + prime throttled=0 before the CoA attempt (Bash pre-write).
    await db.query.execute(sql`
      UPDATE fup_state
      SET normal_rate = ${plan.normalRate}, fup_date = ${today}, throttled = 0, last_updated = NOW()
      WHERE username = ${username}
    `);
    const ack = await coaFanOut(cfg, db, logger, username, plan.fupRate);
    if (ack) {
      await setThrottled(db, username, true);
      throttled++;
      logger.log("THROTTLED", `${username} -> ${plan.fupRate}`);
    } else {
      logger.log("COA_FAILED", `${username} - will retry next cycle`);
    }
  }

  return { examined, throttled };
}

/**
 * Auto-unthrottle any throttled user whose FUP-Reset-Time grace has elapsed.
 * Uses `throttled_at + resetMinutes <= now`, per the FUP-Reset-Time decision.
 */
export async function recoverResetTimeUsers(
  cfg: AppConfig,
  db: Db,
  logger: Logger,
): Promise<number> {
  const throttled = await rows<{ username: string; throttled_at: Date | null }>(
    db,
    db.query.execute(sql`
      SELECT username, throttled_at FROM fup_state WHERE throttled = 1
    `),
  );
  let recovered = 0;
  for (const { username, throttled_at } of throttled) {
    if (!validUser(username)) {
      logger.log("SKIP", `invalid username ${username}`);
      continue;
    }
    const plan = await resolveUserPlan(db, username);
    if (plan.resetMinutes == null || throttled_at == null) continue;
    const graceMs = plan.resetMinutes * 60_000;
    if (Date.now() - throttled_at.getTime() >= graceMs) {
      logger.log("RESET", `${username} FUP-Reset-Time elapsed; restoring`);
      if (await unthrottleUser(cfg, db, logger, username)) recovered++;
    }
  }
  return recovered;
}

/**
 * Sum today's accumulated daily usage per user from `fup_session_state`.
 * This is what `fup-check.ts` compares against each user's quota.
 */
export async function aggregateUsage(db: Db, username?: string): Promise<Map<string, UserUsage>> {
  const res = await rows<{ username: string; daily_input: unknown; daily_output: unknown }>(
    db,
    db.query.execute(sql`
      SELECT username,
             SUM(COALESCE(daily_input, 0)) AS daily_input,
             SUM(COALESCE(daily_output, 0)) AS daily_output
      FROM fup_session_state
      ${username ? sql`WHERE username = ${username}` : sql``}
      GROUP BY username
    `),
  );
  const out = new Map<string, UserUsage>();
  for (const r of res) {
    out.set(r.username, { dailyInput: asBig(r.daily_input), dailyOutput: asBig(r.daily_output) });
  }
  return out;
}