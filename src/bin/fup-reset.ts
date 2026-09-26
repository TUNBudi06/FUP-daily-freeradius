/**
 * fup-reset.ts — daily/manual reset. Optionally CoA-restores the normal rate
 * for one user via `--coa`. All logic lives in `ops.ts`; this entrypoint only
 * parses argv, acquires the lock, and calls the shared helpers.
 */
import { loadConfig, parseDebugLevel } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { Lock } from "../lock.ts";
import { createDb } from "../db.ts";
import { resetUsers, validUser } from "../ops.ts";

interface Args {
  username?: string;
  coa: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { coa: false };
  for (const a of argv) {
    if (a === "--coa") args.coa = true;
    else if (!a.startsWith("-") && !args.username) args.username = a;
  }
  return args;
}

async function main(): Promise<void> {
  const { username, coa } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(process.env);
  const logger: Logger = createLogger(cfg.logFile, cfg.debugLevel);
  if (username !== undefined && !validUser(username)) {
    logger.log("ERROR", "fup-reset: invalid username argument");
    console.error("fup-reset: invalid username (1..64 chars of word chars, @, ., -)");
    process.exit(2);
  }
  const lock = new Lock(cfg.lockFile);

  // Concurrency: the lock covers the whole reset. A `false` acquire means another
  // run (e.g. the minute cron) holds it — exit cleanly before rebasing baselines
  // or clearing quotas, so no partial write is possible.
  if (!(await lock.acquire())) {
    logger.log("SKIP", "another run holds the lock; exiting 0");
    process.exit(0);
  }

  const db = createDb(cfg);
  const scope = username ?? "ALL";
  logger.log("START", `fup-reset ${scope}${coa ? " --coa" : ""}`);

  try {
    // CoA-restore (when requested, or for every throttled user on a global
    // reset) happens inside resetUsers BEFORE the bookkeeping is cleared.
    const failed = await resetUsers(cfg, db, logger, username, coa);
    if (username && coa) logger.log(failed.length === 0 ? "COA_RESTORE" : "COA_FAILED", `${username}`);
    logger.log("SUMMARY", `RESET ${scope}${failed.length ? ` restore_failed=${failed.length}` : ""}`);
  } finally {
    await db.close();
    await lock.release();
  }
  process.exit(0);
}

main().catch((err) => {
  const logger: Logger = createLogger(process.env.FUP_LOG_FILE ?? "/tmp/fup.log", parseDebugLevel(process.env.FUP_DEBUG));
  const detail =
    err instanceof Error && (err as { cause?: unknown }).cause instanceof Error
      ? `${(err as { cause: Error }).cause.message}`
      : "";
  const line = `fup-reset aborted: ${err instanceof Error ? err.message : String(err)}${detail ? ` — ${detail}` : ""}`;
  logger.log("ERROR", line);
  // Echo to stderr so cron/terminal always sees the failure reason.
  console.error(line);
  process.exit(1);
});