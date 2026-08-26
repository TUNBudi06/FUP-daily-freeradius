/**
 * fup-reset.ts — daily/manual reset. Optionally CoA-restores the normal rate
 * for one user via `--coa`. All logic lives in `ops.ts`; this entrypoint only
 * parses argv, acquires the lock, and calls the shared helpers.
 */
import { loadConfig } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { Lock } from "../lock.ts";
import { createDb } from "../db.ts";
import { resetQuota, rebaseSessionBaselines, unthrottleUser } from "../ops.ts";

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
  const logger: Logger = createLogger(cfg.logFile);
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
    await resetQuota(db, username);
    await rebaseSessionBaselines(db, username);

    if (coa && username) {
      const restored = await unthrottleUser(cfg, db, logger, username);
      logger.log(restored ? "COA_RESTORE" : "COA_FAILED", `${username}`);
    }
    logger.log("SUMMARY", `RESET ${scope}`);
  } finally {
    await db.close();
    await lock.release();
  }
  process.exit(0);
}

main().catch((err) => {
  const logger: Logger = createLogger(process.env.FUP_LOG_FILE ?? "/tmp/fup.log");
  logger.log("ERROR", `fup-reset aborted: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});