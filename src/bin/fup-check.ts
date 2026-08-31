/**
 * fup-check.ts — the minute cron. This entrypoint only wires the shared ops;
 * every attribute resolution, session delta, throttle decision, CoA fan-out,
 * and FUP-Reset-Time recovery lives in `ops.ts` exactly once.
 */
import { loadConfig } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { Lock } from "../lock.ts";
import { createDb } from "../db.ts";
import { runCheckCycle, recoverResetTimeUsers } from "../ops.ts";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const logger: Logger = createLogger(cfg.logFile, cfg.verbose);
  const lock = new Lock(cfg.lockFile);

  // Concurrency: the lock is held for the whole cycle. A `false` acquire means
  // another run already holds it — exit cleanly before touching any state so
  // no partial write can happen (CoA fan-out / daily counters stay consistent).
  if (!(await lock.acquire())) {
    logger.log("SKIP", "another run holds the lock; exiting 0");
    process.exit(0);
  }

  const db = createDb(cfg);
  logger.log("START", "fup-check minute cron");

  try {
    const { examined, throttled } = await runCheckCycle(cfg, db, logger);
    const recovered = await recoverResetTimeUsers(cfg, db, logger);
    logger.log(
      "SUMMARY",
      `Processed ${examined} users, throttled=${throttled}, recovered=${recovered}`,
    );
  } finally {
    await db.close();
    await lock.release();
  }
  logger.log("END", "fup-check");
  process.exit(0);
}

main().catch((err) => {
  // Reaching here means config/lock/db failed before try/finally ran. Drizzle
  // wraps mysql2 errors: the query is in `message`, the real cause (e.g.
  // "Table 'x.fup_state' doesn't exist") is on `cause` — surface both so the
  // actual failure is never hidden.
  const logger: Logger = createLogger(process.env.FUP_LOG_FILE ?? "/tmp/fup.log", (process.env.FUP_DEBUG ?? "0") === "1");
  const detail =
    err instanceof Error && (err as { cause?: unknown }).cause instanceof Error
      ? `${(err as { cause: Error }).cause.message}`
      : "";
  const line = `fup-check aborted: ${err instanceof Error ? err.message : String(err)}${detail ? ` — ${detail}` : ""}`;
  logger.log("ERROR", line);
  // Echo to stderr so cron/terminal always sees the failure reason.
  console.error(line);
  process.exit(1);
});