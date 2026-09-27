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
import { ATTR, DEFAULT_FUP_RATE, isSafeRateString } from "./declare.ts";
import { asBig, computeDelta, isQuotaReached, validUser } from "./fup.ts";
import { sendCoa, type CoaResult } from "./coa.ts";

/** Truthy values accepted for the FUP-Per-Device attribute. Case-insensitive
 *  and trim-tolerant. Anything else (including "0", "false", blank, unset)
 *  is treated as off. */
function isPerDeviceTruthy(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

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

export { validUser };

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
  perDevice: boolean; // FUP-Per-Device: quota evaluated per session, not per user
}

/**
 * Unwrap the row list from a raw query result. For plain `sql\`...\`` queries
 * (no drizzle field metadata), the mysql2 driver returns the `[rows, fields]`
 * tuple untouched — the actual rows are always at index 0. `fields` is
 * per-query metadata and is never a row list; callers must never iterate it.
 */
function unwrapRows(r: unknown): unknown[] {
  if (Array.isArray(r)) {
    // mysql2 tuple [rows, fields]; rows may itself be an array of RowDataPacket.
    if (r.length === 2 && Array.isArray(r[0])) return r[0] as unknown[];
    return r;
  }
  return [r];
}

/** Run a query and unwrap its first row (or undefined when empty). */
async function first<T>(db: Db, q: ReturnType<typeof db.query.execute>): Promise<T | undefined> {
  const rows = await q;
  return unwrapRows(rows)[0] as T | undefined;
}

/** Run a query and unwrap the full result array. */
async function rows<T>(db: Db, q: ReturnType<typeof db.query.execute>): Promise<T[]> {
  const r = await q;
  return unwrapRows(r) as T[];
}

// ----------------------------- day boundary -----------------------------

/**
 * Normalise a DATE-ish driver value to `YYYY-MM-DD`. mysql2 hands back a
 * `Date` (in process-local time) for DATE columns and a string for VARCHAR
 * ones; comparing either against a plain string must never spuriously differ.
 */
export function normalizeDay(v: unknown): string | null {
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) return null;
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${v.getFullYear()}-${m}-${d}`;
  }
  if (typeof v === "string") {
    const m = /^\d{4}-\d{2}-\d{2}/.exec(v.trim());
    return m ? m[0] : null;
  }
  return null;
}

/**
 * "Today" as the DATABASE sees it. The reset cron stamps rows with SQL
 * `CURRENT_DATE` (DB timezone); deriving the day from JS `toISOString()` (UTC)
 * disagrees for hours every night on a non-UTC server, which made every check
 * cycle treat the day as rolled over and wipe usage/throttle state.
 */
export async function dbToday(db: Db): Promise<string> {
  const r = await first<{ d: unknown }>(
    db,
    db.query.execute(sql`SELECT DATE_FORMAT(CURRENT_DATE, '%Y-%m-%d') AS d`),
  );
  return normalizeDay(r?.d) ?? normalizeDay(new Date())!;
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
export async function updateSessionState(db: Db, s: SessionState, todayArg?: string): Promise<void> {
  const today = todayArg ?? (await dbToday(db));

  const prior = await first<{ last_input: unknown; last_output: unknown; daily_input: unknown; daily_output: unknown; usage_date: unknown }>(
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
  const usageDate = normalizeDay(prior?.usage_date) || today;

  if (usageDate !== today) {
    // NEW_DAY: rebase baseline and zero today's usage.
    dailyInput = 0n;
    dailyOutput = 0n;
  } else {
    dailyInput += computeDelta(s.input, lastInput);
    dailyOutput += computeDelta(s.output, lastOutput);
  }

  if (prior) {
    // Plain UPDATE: does not depend on a UNIQUE key on acctuniqueid existing
    // (an upsert without one would insert a duplicate row every cycle).
    await db.query.execute(sql`
      UPDATE fup_session_state
      SET last_input = ${s.input}, last_output = ${s.output},
          usage_date = ${today}, daily_input = ${dailyInput}, daily_output = ${dailyOutput},
          last_seen = NOW(), closed = 0
      WHERE acctuniqueid = ${s.acctuniqueid}
    `);
    return;
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
 * Rebase ONE session to its live octet counters and zero its daily usage.
 * Used when a single throttled device is restored so it is not instantly
 * re-throttled by usage it already paid for.
 */
export async function rebaseSession(db: Db, acctuniqueid: string): Promise<void> {
  await db.query.execute(sql`
    UPDATE fup_session_state fss
    JOIN radacct ra ON ra.acctuniqueid = fss.acctuniqueid
    SET fss.last_input = COALESCE(ra.acctinputoctets, 0),
        fss.last_output = COALESCE(ra.acctoutputoctets, 0),
        fss.daily_input = 0,
        fss.daily_output = 0,
        fss.usage_date = CURRENT_DATE,
        fss.last_seen = NOW()
    WHERE fss.acctuniqueid = ${acctuniqueid}
  `);
}

/**
 * Rebase open sessions to current octet counters and zero today's usage; zero
 * every remaining row regardless of session state. Called at midnight and at
 * quota reset so a fresh daily quota starts from zero for every user, even
 * those whose radacct session is closed or unmatched. Mirrors the Bash reset
 * block.
 */
export async function rebaseSessionBaselines(db: Db, username?: string): Promise<void> {
  const userCond = username ? sql`WHERE fss.username = ${username}` : sql``;
  // 1) Open sessions: rebase the baseline to the router's live counters so the
  //    next cycle's delta continues from the current position, and zero daily.
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
  // 2) Every row that did not match an open session (closed/mismatched/ghost):
  //    zero the daily counters unconditionally. A reset must bring ALL users
  //    back to 0, not just those with a live radacct join.
  await db.query.execute(sql`
    UPDATE fup_session_state
    SET daily_input = 0, daily_output = 0, usage_date = CURRENT_DATE
    ${username ? sql`WHERE username = ${username}` : sql``}
  `);
  // 3) Per-device join table: a daily reset clears ALL throttled device
  //    slots for the user (or globally). Per-device rows are tied to
  //    daily usage; a new day means a fresh slate. The user-level
  //    fup_state.throttled flag will be recomputed via
  //    recomputeUserThrottleFlag on the next runPerDeviceCheck, or set
  //    directly here when resetting globally (no username given).
  if (username) {
    await db.query.execute(sql`
      DELETE FROM fup_state_throttled WHERE username = ${username}
    `);
  } else {
    await db.query.execute(sql`DELETE FROM fup_state_throttled`);
    await db.query.execute(sql`
      UPDATE fup_state SET throttled = 0, throttled_at = NULL, last_updated = NOW()
    `);
  }
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
  // The configured attribute wins so a plan change (10M -> 20M) is picked up;
  // the value saved in fup_state is only a fallback (e.g. attribute removed
  // while the user was throttled).
  const fromAttr = (await resolveAttr(db, username, ATTR.RATE))?.trim();
  if (fromAttr && isSafeRateString(fromAttr)) return fromAttr;
  const fromState = await first<{ normal_rate: string }>(
    db,
    db.query.execute(sql`
      SELECT normal_rate FROM fup_state
      WHERE username = ${username} AND normal_rate IS NOT NULL
        AND normal_rate <> '' AND normal_rate <> '0' LIMIT 1
    `),
  );
  const saved = fromState?.normal_rate?.trim();
  return saved && isSafeRateString(saved) ? saved : null;
}

/** Read a user's daily quota, enforce rate, and optional reset time. */
export async function resolveUserPlan(db: Db, username: string): Promise<UserPlan> {
  const maxDaily = await resolveAttr(db, username, ATTR.MAX_DAILY);
  const fupRate = await resolveAttr(db, username, ATTR.FUP_RATE);
  const resetMin = await resolveAttr(db, username, ATTR.FUP_RESET_TIME);
  const perDeviceRaw = await resolveAttr(db, username, ATTR.FUP_PER_DEVICE);
  const quota = asBig(maxDaily);
  const normalRate = await resolveNormalRate(db, username);
  const fupRateTrim = fupRate?.trim();
  return {
    quota,
    // An unsafe (quote/newline/etc.) value can never reach radclient's stdin.
    fupRate: fupRateTrim && fupRateTrim !== "0" && isSafeRateString(fupRateTrim) ? fupRateTrim : DEFAULT_FUP_RATE,
    resetMinutes: resetMin && /^\d+$/.test(resetMin.trim()) ? Number(resetMin.trim()) : null,
    normalRate: normalRate ?? "",
    perDevice: isPerDeviceTruthy(perDeviceRaw),
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
 * Log event name for a CoA outcome: ACK on success, TIMEOUT when our own
 * deadline fired (usually an unreachable NAS — an infra signal, not a config
 * one), FAILED for anything else (NAK, spawn failure, refused input).
 */
export function coaEventName(res: CoaResult): string {
  if (res.ok) return "COA_ACK";
  return res.timedOut ? "COA_TIMEOUT" : "COA_FAILED";
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
    const res = await sendCoa(cfg, logger, username, ip, rate, "throttle");
    logger.log(
      coaEventName(res),
      redact(`${username} IP=${ip} -> ${rate} (${res.detail})`, secrets),
    );
    if (res.ok) ack = true;
  }
  return ack;
}

/**
 * Restore a user by CoA'ing their normal rate, then clear throttle and rebase
 * their session baselines so the next daily quota starts from zero. Shared by
 * the reset entrypoint, the FUP-Reset-Time auto-unthrottle and day rollover.
 *
 * Returns true when the user is no longer throttled (restored, or nothing to
 * restore because they have no live session). Returns false — leaving the
 * throttle flag intact so the next cycle retries — when a CoA was needed and
 * failed, or no normal rate is known.
 */
export async function unthrottleUser(
  cfg: AppConfig,
  db: Db,
  logger: Logger,
  username: string,
): Promise<boolean> {
  const plan = await resolveUserPlan(db, username);

  // Per-device: restore each throttled device independently. Operator intent
  // for "reset this user" is "clear every device", not just one — so we
  // iterate the join table and CoA each IP back to the normal rate.
  if (plan.perDevice) {
    await clearStaleJoinRows(db, username, logger);
    const join = await loadThrottledJoin(db, username);
    if (join.length === 0) {
      // Nothing to restore per-device, but the user-level flag may still
      // be set from a previous run. Self-heal so subsequent cycles start
      // clean.
      await selfHealThrottleFlag(db, logger, username);
      return true;
    }
    const normal = plan.normalRate || (await resolveNormalRate(db, username)) || "";
    if (!normal) {
      logger.log("ERROR", `no normal rate for ${username}`);
      return false;
    }
    let restored = 0;
    for (const j of join) {
      if (await unthrottleOne(cfg, db, logger, username, j.acctuniqueid, j.framedipaddress, normal, true)) {
        restored++;
      }
    }
    return restored > 0;
  }

  // Offline user: nothing is throttled on the NAS (a new session starts at the
  // RADIUS-provided normal rate), so just clear our bookkeeping.
  const ips = await activeSessionIps(db, username);
  if (ips.length > 0) {
    const normal = await resolveNormalRate(db, username);
    if (!normal) {
      logger.log("ERROR", `no normal rate for ${username}`);
      return false;
    }
    // A failed CoA must NOT clear the flag: the user would stay throttled on
    // the router with nothing left to ever restore them.
    if (!(await coaFanOut(cfg, db, logger, username, normal))) return false;
    logger.log("RESTORE", `${username} -> ${normal}`);
  }
  await resetQuota(db, username);
  await rebaseSessionBaselines(db, username);
  return true;
}

/**
 * Reset quota state. With a username, optionally CoA-restore that user first
 * (CoA must run BEFORE the bookkeeping is wiped: per-device restore needs the
 * join rows the rebase deletes). Without a username (the daily rollover), every
 * currently-throttled user is CoA-restored first — clearing the flag alone
 * would leave them stuck at the throttled rate on the router with nothing left
 * that would ever restore them.
 * Returns the users whose CoA restore failed (still throttled on the NAS).
 */
export async function resetUsers(
  cfg: AppConfig,
  db: Db,
  logger: Logger,
  username: string | undefined,
  coa: boolean,
): Promise<string[]> {
  const failed: string[] = [];
  if (username !== undefined && !validUser(username)) {
    throw new Error(`invalid username ${JSON.stringify(username)}`);
  }
  let targets: string[] = [];
  if (username !== undefined) {
    if (coa) targets = [username];
  } else {
    const r = await rows<{ username: string }>(
      db,
      db.query.execute(sql`
        SELECT username FROM fup_state WHERE throttled = 1
        UNION
        SELECT username FROM fup_state_throttled
      `),
    );
    targets = r.map((x) => x.username);
    if (targets.length > 0) {
      logger.log("RESET_TARGETS", `${targets.length} throttled user(s) to restore before the daily rollover`);
    }
  }
  for (const u of targets) {
    if (!validUser(u)) {
      logger.log("SKIP", `invalid username ${u}`);
      continue;
    }
    if (!(await unthrottleUser(cfg, db, logger, u))) {
      failed.push(u);
      logger.log("COA_FAILED", `${u} - restore failed; may still be throttled on the NAS`);
    }
  }
  // Single-user restore that failed: keep the throttle state so the operator
  // (or the next cycle) can retry instead of orphaning a throttled session.
  if (username !== undefined && failed.length > 0) return failed;
  await resetQuota(db, username);
  await rebaseSessionBaselines(db, username);
  return failed;
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

// --------------------------- per-device FUP mode ---------------------------

/** One open session in the per-device loop: fup_session_state row joined
 *  to radacct for the live IP and stop-null check. */
interface PerDeviceRow {
  acctuniqueid: string;
  framedipaddress: string;
  dailyInput: bigint;
  dailyOutput: bigint;
}

/** A throttled-session row from `fup_state_throttled`. */
export interface ThrottledJoinRow {
  acctuniqueid: string;
  framedipaddress: string;
  throttledAt: Date;
  throttledRate: string;
}

/** Load open sessions for a user from fup_session_state + radacct. The CoA
 *  target is always the live IP from radacct; fup_session_state.framedipaddress
 *  is only a stale cache. Sessions missing a valid IP or already closed on
 *  the NAS are filtered out so we never CoA a dead session. */
async function loadPerDeviceRows(db: Db, username: string): Promise<PerDeviceRow[]> {
  const res = await rows<{
    acctuniqueid: string;
    framedipaddress: string;
    daily_input: unknown;
    daily_output: unknown;
  }>(
    db,
    db.query.execute(sql`
      SELECT fss.acctuniqueid, ra.framedipaddress,
             fss.daily_input, fss.daily_output
      FROM fup_session_state fss
      JOIN radacct ra ON ra.acctuniqueid = fss.acctuniqueid
      WHERE fss.username = ${username}
        AND ra.acctstoptime IS NULL
        AND ra.framedipaddress IS NOT NULL AND ra.framedipaddress <> ''
    `),
  );
  const out: PerDeviceRow[] = [];
  for (const r of res) {
    if (!isValidIp(r.framedipaddress)) continue;
    out.push({
      acctuniqueid: r.acctuniqueid,
      framedipaddress: r.framedipaddress,
      dailyInput: asBig(r.daily_input),
      dailyOutput: asBig(r.daily_output),
    });
  }
  return out;
}

/**
 * True when a throttled session's own FUP-Reset-Time grace has elapsed and it
 * is therefore eligible for restore. An unparseable timestamp counts as
 * elapsed so bad data can never pin a user throttled forever — if they are
 * still over quota the next per-device check simply re-throttles them.
 */
export function resetGraceElapsed(
  throttledAt: Date | string,
  resetMinutes: number,
  now: number = Date.now(),
): boolean {
  const ms = throttledAt instanceof Date ? throttledAt.getTime() : Date.parse(throttledAt);
  if (!Number.isFinite(ms)) return true;
  return now - ms >= resetMinutes * 60_000;
}

/** Load currently throttled (user, session) join rows for one user. Maps the
 *  DB snake_case columns to the camelCase `ThrottledJoinRow` shape. */
export async function loadThrottledJoin(db: Db, username: string): Promise<ThrottledJoinRow[]> {
  const res = await rows<{
    acctuniqueid: string;
    framedipaddress: string;
    throttled_at: Date | string;
    throttled_rate: string;
  }>(
    db,
    db.query.execute(sql`
      SELECT acctuniqueid, framedipaddress, throttled_at, throttled_rate
      FROM fup_state_throttled WHERE username = ${username}
    `),
  );
  return res.map((r) => ({
    acctuniqueid: r.acctuniqueid,
    framedipaddress: r.framedipaddress,
    throttledAt: r.throttled_at instanceof Date ? r.throttled_at : new Date(r.throttled_at),
    throttledRate: r.throttled_rate,
  }));
}

/** Self-heal: if fup_state says throttled=1 but the per-device table is
 *  empty (or has no live sessions left), clear the user-level flag. Runs
 *  every per-device cycle, so it only logs when it actually changes a row —
 *  otherwise every clean cycle for every per-device user would spam SELF_HEAL. */
async function selfHealThrottleFlag(db: Db, logger: Logger, username: string): Promise<boolean> {
  const r = await first<{ hasRows: unknown }>(
    db,
    db.query.execute(sql`
      SELECT COUNT(*) > 0 AS hasRows
      FROM fup_state_throttled WHERE username = ${username}
    `),
  );
  if (asBig(r?.hasRows) === 0n) {
    const res = await db.query.execute(sql`
      UPDATE fup_state
      SET throttled = 0, throttled_at = NULL, last_updated = NOW()
      WHERE username = ${username} AND throttled = 1
    `);
    const affected = Number((res as { affectedRows?: number })?.affectedRows ?? 0);
    if (affected > 0) {
      logger.log("SELF_HEAL", `${username} throttled flag cleared (no matching fup_state_throttled rows)`);
    }
    return true;
  }
  return false;
}

/** Stale-clear: drop join rows whose radacct session is no longer open. */
async function clearStaleJoinRows(db: Db, username: string, logger: Logger): Promise<number> {
  const res = await db.query.execute(sql`
    DELETE t FROM fup_state_throttled t
    LEFT JOIN radacct ra ON ra.acctuniqueid = t.acctuniqueid
    WHERE t.username = ${username}
      AND (ra.acctuniqueid IS NULL OR ra.acctstoptime IS NOT NULL)
  `);
  // mysql2 OkPacket has `affectedRows` on success.
  const affected = Number((res as { affectedRows?: number })?.affectedRows ?? 0);
  if (affected > 0) logger.log("STALE_THROTTLE_CLEARED", `${username} removed=${affected}`);
  return affected;
}

/** Recompute the user-level throttled/throttled_at from the join table. */
async function recomputeUserThrottleFlag(db: Db, username: string): Promise<void> {
  await db.query.execute(sql`
    UPDATE fup_state fs
    LEFT JOIN (
      SELECT username, MIN(throttled_at) AS min_at, COUNT(*) AS cnt
      FROM fup_state_throttled GROUP BY username
    ) t ON t.username = fs.username
    SET fs.throttled = CASE WHEN COALESCE(t.cnt, 0) > 0 THEN 1 ELSE 0 END,
        fs.throttled_at = t.min_at,
        fs.last_updated = NOW()
    WHERE fs.username = ${username}
  `);
}

/** CoA a single (user, IP) to the normal rate; on ACK, delete the matching
 *  join row and recompute the user-level flag. Returns true on ACK. */
export async function unthrottleOne(
  cfg: AppConfig,
  db: Db,
  logger: Logger,
  username: string,
  acctuniqueid: string,
  ip: string,
  normalRate: string,
  resetUsage = false,
): Promise<boolean> {
  if (!isValidIp(ip)) {
    logger.log("SKIP", `${username} invalid IP ${ip} (unthrottleOne)`);
    return false;
  }
  const res = await sendCoa(cfg, logger, username, ip, normalRate, "restore");
  const secrets = [cfg.nas.secret, cfg.db.password];
  logger.log(
    coaEventName(res),
    redact(`${username} acct=${acctuniqueid} IP=${ip} -> ${normalRate} (${res.detail})`, secrets),
  );
  if (!res.ok) return false;
  await db.query.execute(sql`
    DELETE FROM fup_state_throttled
    WHERE username = ${username} AND acctuniqueid = ${acctuniqueid}
  `);
  // Grace-period/reset restores start a fresh quota for the device; otherwise
  // its unchanged over-quota usage would re-throttle it on the very next cycle.
  if (resetUsage) await rebaseSession(db, acctuniqueid);
  await recomputeUserThrottleFlag(db, username);
  logger.log("RESTORE", `${username} ${ip} -> ${normalRate} (per_device)`);
  return true;
}

/**
 * Per-device check loop. Each session's own daily_input+daily_output is
 * compared against the quota; only the specific IP that crosses the cap is
 * CoA-throttled. In-cycle unthrottle restores a session whose usage has
 * dropped (e.g. daily reset zeroed the join row's siblings).
 */
export async function runPerDeviceCheck(
  cfg: AppConfig,
  db: Db,
  logger: Logger,
  username: string,
  plan: UserPlan,
): Promise<{ throttled: number; restored: number }> {
  let throttled = 0;
  let restored = 0;

  // Edge 10: fup_state says throttled but no join rows. Clear and log.
  await selfHealThrottleFlag(db, logger, username);
  // Edge 3: drop join rows whose radacct session is no longer open.
  await clearStaleJoinRows(db, username, logger);

  const live = await loadPerDeviceRows(db, username);
  const liveByAcct = new Map(live.map((r) => [r.acctuniqueid, r]));
  const join = await loadThrottledJoin(db, username);

  for (const r of live) {
    logger.detail(2, "DEVICE_USAGE", `${username} ip=${r.framedipaddress || "<unset>"} acct=${r.acctuniqueid || "unknown"} daily=${r.dailyInput + r.dailyOutput} quota=${plan.quota}`);
  }
  for (const j of join) {
    const at = j.throttledAt instanceof Date && Number.isFinite(j.throttledAt.getTime())
      ? j.throttledAt.toISOString()
      : "unknown";
    logger.detail(2, "DEVICE_THROTTLED", `${username} ip=${j.framedipaddress || "<unset>"} acct=${j.acctuniqueid || "unknown"} since=${at} rate=${j.throttledRate || "<unset>"}`);
  }

  // Step A: in-cycle unthrottle for join rows whose session is now under quota
  // (or whose session is gone — stale-cleared above).
  for (const j of join) {
    const live2 = liveByAcct.get(j.acctuniqueid);
    const use = live2 ? live2.dailyInput + live2.dailyOutput : 0n;
    // No live row OR under quota: restore.
    if (!live2 || !isQuotaReached(use, plan.quota)) {
      const normal = plan.normalRate || (await resolveNormalRate(db, username)) || "";
      if (!normal) continue;
      if (await unthrottleOne(cfg, db, logger, username, j.acctuniqueid, j.framedipaddress, normal)) {
        restored++;
      }
    }
  }

  // Reload join rows after the unthrottle pass.
  const joinAfter = new Set((await loadThrottledJoin(db, username)).map((j) => j.acctuniqueid));

  // Step B: per-row throttle. A session trips if its own daily use >= quota
  // and it is not already in the join table.
  for (const row of live) {
    if (joinAfter.has(row.acctuniqueid)) continue;
    const use = row.dailyInput + row.dailyOutput;
    if (!isQuotaReached(use, plan.quota)) continue;

    logger.log("FUP_REACHED", `${username} ${row.framedipaddress} (usage=${use} >= quota=${plan.quota})`);
    // Save normal_rate and stamp today's fup_date (so day rollover does not
    // mistake this throttle for a stale one). The throttled flag is left
    // alone: it is recomputed from the join table, and forcing it to 0 here
    // would hide sibling devices that are already throttled if this CoA fails.
    await db.query.execute(sql`
      UPDATE fup_state
      SET normal_rate = ${plan.normalRate}, fup_date = CURRENT_DATE, last_updated = NOW()
      WHERE username = ${username}
    `);
    const res = await sendCoa(cfg, logger, username, row.framedipaddress, plan.fupRate, "throttle");
    const secrets = [cfg.nas.secret, cfg.db.password];
    logger.log(
      coaEventName(res),
      redact(`${username} IP=${row.framedipaddress} -> ${plan.fupRate} (${res.detail})`, secrets),
    );
    if (!res.ok) {
      logger.log("COA_FAILED", `${username} ${row.framedipaddress} - will retry next cycle`);
      continue;
    }
    await db.query.execute(sql`
      INSERT INTO fup_state_throttled
        (username, acctuniqueid, framedipaddress, throttled_at, throttled_rate)
      VALUES
        (${username}, ${row.acctuniqueid}, ${row.framedipaddress}, NOW(), ${plan.fupRate})
      ON DUPLICATE KEY UPDATE
        framedipaddress = VALUES(framedipaddress),
        throttled_at = VALUES(throttled_at),
        throttled_rate = VALUES(throttled_rate)
    `);
    await recomputeUserThrottleFlag(db, username);
    throttled++;
    logger.log("THROTTLED", `${username} ${row.framedipaddress} -> ${plan.fupRate} (reason=per_device_quota)`);
  }

  return { throttled, restored };
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
  const today = await dbToday(db);

  // Pick up any user that has an open radacct session but no fup_session_state
  // row yet. Without this, a brand-new active user is invisible to the rest of
  // the cycle (aggregateUsage only returns rows from fup_session_state), so
  // their first cycle is silently skipped. Baselines start at the current
  // counters with zero daily usage, so pre-existing traffic is not billed.
  await db.query.execute(sql`
    INSERT IGNORE INTO fup_session_state
      (username, acctuniqueid, acctsessionid, framedipaddress,
       last_input, last_output, usage_date, daily_input, daily_output, last_seen, closed)
    SELECT
      ra.username, ra.acctuniqueid, ra.username, '0.0.0.0',
      COALESCE(ra.acctinputoctets, 0), COALESCE(ra.acctoutputoctets, 0),
      CURRENT_DATE, 0, 0, NOW(), 0
    FROM radacct ra
    WHERE ra.acctstoptime IS NULL
      AND ra.username IS NOT NULL AND ra.username <> ''
      AND ra.framedipaddress IS NOT NULL AND ra.framedipaddress <> ''
      AND ra.acctuniqueid IS NOT NULL AND ra.acctuniqueid <> ''
      AND NOT EXISTS (
        SELECT 1 FROM fup_session_state fss
        WHERE fss.acctuniqueid = ra.acctuniqueid
      )
  `);

  // Ensure a fup_state row exists for every known user.
  await db.query.execute(sql`
    INSERT INTO fup_state (username, normal_rate, fup_date, throttled, last_updated)
    SELECT username, NULL, ${today}, 0, NOW() FROM fup_session_state
    GROUP BY username
    ON DUPLICATE KEY UPDATE username = username
  `);

  // NEW_DAY rollover (in case the daily reset cron missed or has not run yet).
  // A user still flagged from a previous day must be CoA-restored, not just
  // un-flagged — clearing the flag alone strands them at the throttled rate.
  const stale = await rows<{ username: string }>(
    db,
    db.query.execute(sql`
      SELECT username FROM fup_state
      WHERE throttled = 1 AND fup_date IS NOT NULL AND fup_date <> ${today}
    `),
  );
  for (const { username } of stale) {
    if (!validUser(username)) continue;
    try {
      logger.log("NEW_DAY", `${username} throttle from a previous day; restoring`);
      await unthrottleUser(cfg, db, logger, username);
    } catch (e) {
      logger.log("ERROR", `new-day restore ${username}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await db.query.execute(sql`
    UPDATE fup_state SET fup_date = ${today}, last_updated = NOW()
    WHERE throttled = 0 AND (fup_date IS NULL OR fup_date <> ${today})
  `);

  // Refresh per-session counters so today's deltas are accurate (handles
  // counter-reset cases via computeDelta inside updateSessionState).
  const active = await fetchActiveSessions(db);
  // Visible at the default log level (unlike the per-session SESSION detail
  // lines below) so a healthy cron run is confirmable from the log alone —
  // e.g. a sudden drop to 0 active sessions usually means radacct/NAS trouble,
  // not that everyone disconnected.
  logger.log("ACTIVE_SESSIONS", String(active.length));
  for (const s of active) {
    logger.detail(2, "SESSION", `user=${s.username || "<unset>"} acct=${s.acctuniqueid || "unknown"} in=${s.input} out=${s.output}`);
    await updateSessionState(db, s, today);
  }

  // Only today's rows count: stale rows from earlier days (closed sessions, a
  // missed daily reset) must not inflate today's total.
  const daily = await aggregateUsage(db, undefined, today);

  let examined = 0;
  let throttled = 0;

  for (const [username, use] of daily) {
    examined++;
    if (!validUser(username)) {
      logger.log("SKIP", `invalid username ${username}`);
      continue;
    }
    // One bad user (DB hiccup, odd row) must not abort everyone else's cycle.
    try {
      const plan = await resolveUserPlan(db, username);
      if (plan.quota <= 0n) continue;
      logger.log("DAILY_USAGE", `${username} = ${use.dailyInput + use.dailyOutput} bytes (quota=${plan.quota})`);

      if (plan.perDevice) {
        // Per-device mode: each session evaluated independently. The aggregate
        // in `use` is informational; the actual decision is row-by-row inside.
        logger.log("PER_DEVICE_ACTIVE", `${username} (quota=${plan.quota} per device)`);
        const r = await runPerDeviceCheck(cfg, db, logger, username, plan);
        throttled += r.throttled;
        continue;
      }

      // Edge 2: user transitioned from per-device to per-user mode. Drop any
      // join rows; the aggregate path below re-throttles the user as a whole
      // if still over quota.
      await db.query.execute(sql`
        DELETE FROM fup_state_throttled WHERE username = ${username}
      `);

      const state = await fetchThrottleState(db, username);
      if (state.throttled) continue;
      if (!isQuotaReached(use.dailyInput + use.dailyOutput, plan.quota)) continue;

      // Offline user over quota: nothing to throttle now. Don't spam
      // COA_FAILED every minute; they are re-evaluated when a session opens.
      if ((await activeSessionIps(db, username)).length === 0) {
        logger.detail(2, "SKIP", `${username} over quota but has no active session`);
        continue;
      }

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
    } catch (e) {
      logger.log("ERROR", `check ${username}: ${e instanceof Error ? e.message : String(e)}`);
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
    try {
      const plan = await resolveUserPlan(db, username);
      if (plan.resetMinutes == null || plan.resetMinutes <= 0) continue;
      const resetMinutes = plan.resetMinutes;

      if (plan.perDevice) {
        // Per-device: FUP-Reset-Time applies to each device's own throttle
        // timestamp. A device whose throttled_at + resetMinutes <= now is
        // restored independently (and gets a fresh quota).
        const join = await loadThrottledJoin(db, username);
        if (join.length === 0) {
          // Stale flag without rows: clear and move on.
          await selfHealThrottleFlag(db, logger, username);
          continue;
        }
        const normal = plan.normalRate || (await resolveNormalRate(db, username)) || "";
        if (!normal) {
          logger.log("ERROR", `no normal rate for ${username}`);
          continue;
        }
        let userRecovered = false;
        for (const j of join) {
          if (!resetGraceElapsed(j.throttledAt, resetMinutes)) continue;
          logger.log("RESET", `${username} ${j.framedipaddress} FUP-Reset-Time elapsed; restoring`);
          if (await unthrottleOne(cfg, db, logger, username, j.acctuniqueid, j.framedipaddress, normal, true)) {
            userRecovered = true;
          }
        }
        if (userRecovered) recovered++;
        continue;
      }

      // A NULL throttled_at (flag set before the column existed) is treated as
      // elapsed so such a user cannot be pinned throttled forever.
      if (throttled_at == null || resetGraceElapsed(throttled_at, resetMinutes)) {
        logger.log("RESET", `${username} FUP-Reset-Time elapsed; restoring`);
        if (await unthrottleUser(cfg, db, logger, username)) recovered++;
      }
    } catch (e) {
      logger.log("ERROR", `recover ${username}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return recovered;
}

/**
 * Sum today's accumulated daily usage per user from `fup_session_state`.
 * This is what `fup-check.ts` compares against each user's quota.
 */
export async function aggregateUsage(db: Db, username?: string, today?: string): Promise<Map<string, UserUsage>> {
  const res = await rows<{ username: string; daily_input: unknown; daily_output: unknown }>(
    db,
    db.query.execute(sql`
      SELECT username,
             SUM(COALESCE(daily_input, 0)) AS daily_input,
             SUM(COALESCE(daily_output, 0)) AS daily_output
      FROM fup_session_state
      WHERE 1 = 1
        ${username ? sql`AND username = ${username}` : sql``}
        ${today ? sql`AND usage_date = ${today}` : sql``}
      GROUP BY username
    `),
  );
  const out = new Map<string, UserUsage>();
  for (const r of res) {
    out.set(r.username, { dailyInput: asBig(r.daily_input), dailyOutput: asBig(r.daily_output) });
  }
  return out;
}