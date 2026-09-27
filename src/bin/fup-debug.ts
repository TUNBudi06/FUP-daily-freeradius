/**
 * fup-debug.ts — standalone debug console for the CoA command path.
 *
 * Unlike the minute cron (fup-check.ts), which only exercises radclient when a
 * throttle decision fires, this tool ALWAYS runs the real command against the
 * real NAS so the operator can see the exact argv, the CoA body, and the full
 * radclient stdout+stderr — including a parsed NAK reason — directly in the
 * terminal. Config is read from the same env vars as the cron; radio-secret
 * and DB password are redacted. Always runs at debug level 2, regardless of
 * FUP_DEBUG.
 *
 * Usage:
 *   bun run src/bin/fup-debug.ts <username> [ip]
 *
 * Examples:
 *   bun run src/bin/fup-debug.ts alice             # throttle alice's active IPs
 *   bun run src/bin/fup-debug.ts alice 1.2.3.4     # throttle alice on this IP only
 */
import { loadConfig, isValidIp, parseDebugLevel, type AppConfig } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { createDb } from "../db.ts";
import {
  activeSessionIps,
  fetchActiveSessions,
  resolveNormalRate,
  resolveUserPlan,
  validUser,
  redact,
  coaEventName,
} from "../ops.ts";
import { sendCoa } from "../coa.ts";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  // The debug console is explicitly a verbose tool: run it at level 2 so the
  // operator sees COA_DEBUG argv/body plus per-session detail live, without
  // having to remember FUP_DEBUG=2.
  const logger: Logger = createLogger(cfg.logFile, 2);

  const [username, onlyIp] = process.argv.slice(2);
  if (!username || !validUser(username)) {
    logger.log("DEBUG_ERR", `usage: fup-debug <username> [ip]`);
    logger.log("DEBUG_ERR", `       (username must be 1..64 safe word chars)`);
    process.exit(2);
  }

  const db = createDb(cfg);
  const secretRedactor = [cfg.nas.secret, cfg.db.password];

  // Resolve the real plan (quota, fup rate, per-device flag) exactly as the
  // cycle would, and the open sessions+IPs radclient fan-out would target.
  const plan = await resolveUserPlan(db, username);
  const normalRate = await resolveNormalRate(db, username);
  const sessions = await fetchActiveSessions(db, username);
  const ips = (onlyIp ? [onlyIp] : await activeSessionIps(db, username)).filter(isValidIp);
  if (ips.length === 0) {
    logger.log("DEBUG_ERR", `${username}: no active session IPs (and no valid [ip] argument)`);
    await db.close();
    process.exit(3);
  }

  const shown = (v: string) => (v && v !== "0" ? v : "<unset>");
  console.log("── fup-debug ─────────────────────────────────────────────");
  console.log(`  username   : ${username}`);
  console.log(`  plan       : quota=${shown(String(plan.quota))} bytes  fupRate=${shown(plan.fupRate)}  normalRate=${shown(normalRate ?? "")}  perDevice=${plan.perDevice}`);
  console.log(`  sessions   : ${sessions.length} open radacct row(s)`);
  console.log(`  targets    : ${ips.length} IP(s) -> ${ips.join(", ")}`);
  console.log("──────────────────────────────────────────────────────────");
  console.log("");

  // Run the SAME code path the cycle uses, at level 2 so the argv + body +
  // full radclient output appear on stderr, live. `cfg` itself is left
  // untouched — only this local copy is forced verbose.
  const debugCfg: AppConfig = { ...cfg, debugLevel: 2 };
  const results: string[] = [];
  let allAck = true;
  for (const ip of ips) {
    const res = await sendCoa(debugCfg, logger, username, ip, plan.fupRate, "throttle");
    if (!res.ok) allAck = false;
    // Unlike the cron (coaFanOut), this tool calls sendCoa directly, so it must
    // log the outcome itself — sendCoa only ever logs COA_DEBUG/COA_DETAIL.
    const event = coaEventName(res);
    logger.log(event, redact(`${username} IP=${ip} -> ${plan.fupRate} (${res.detail})`, secretRedactor));
    const mark = res.ok ? "✓ ACK" : res.timedOut ? "✗ TIMEOUT" : "✗ FAILED";
    results.push(`  IP ${ip} -> ${plan.fupRate}: ${mark}  ${redact(res.detail, secretRedactor)}`);
  }

  console.log("");
  console.log("── results ────────────────────────────────────────────────");
  for (const r of results) console.log(r);
  console.log("(COA_DEBUG / COA_ACK / COA_TIMEOUT / COA_FAILED lines also went to the log)");

  await db.close();
  if (allAck) process.exit(0);
  process.exit(1);
}

main().catch(async (err) => {
  const logger: Logger = createLogger(process.env.FUP_LOG_FILE ?? "/tmp/fup.log", parseDebugLevel(process.env.FUP_DEBUG));
  const detail =
    err instanceof Error && (err as { cause?: unknown }).cause instanceof Error
      ? ` — ${(err as { cause: Error }).cause.message}`
      : "";
  const line = `fup-debug aborted: ${err instanceof Error ? err.message : String(err)}${detail}`;
  logger.log("DEBUG_ERR", line);
  console.error(line);
  process.exit(1);
});