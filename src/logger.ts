import { appendFileSync } from "node:fs";

export interface Logger {
  log(event: string, msg?: string): void;
  /**
   * Extra detail that only matters when debugging at level >= `minLevel`.
   * Always written to the file; echoed to stderr only when the configured
   * debug level reaches `minLevel`. Use for per-session/per-IP/attribute
   * dumps so a normal run's log stays readable. Callers must never pass
   * secrets into `msg`.
   */
  detail(minLevel: number, event: string, msg?: string): void;
}

/**
 * Append-only file logger. Every line is timestamped (ISO 8601) and prefixed
 * with a machine-readable event name so logs are grep-able. Write failures
 * are swallowed; a dropped line is better than a crashed cycle.
 * Callers must never pass secrets into `msg`.
 */
/** Expand a leading `~/` to $HOME. `.env` values are literally passed, so the shell
 *  would otherwise create a file literally named `~`. */
export function resolveLogPath(logFile: string): string {
  return logFile.startsWith("~/") ? `${process.env.HOME ?? "/root"}${logFile.slice(1)}` : logFile;
}

/** Coerce anything (old boolean call sites included) to a 0..2 debug level. */
function normalizeLevel(level: number | boolean): number {
  if (level === true) return 1;
  if (level === false || !Number.isFinite(level)) return 0;
  return level < 0 ? 0 : level > 2 ? 2 : level;
}

export function createLogger(logFile: string, debugLevel: number | boolean = 0): Logger {
  const resolved = resolveLogPath(logFile);
  const level = normalizeLevel(debugLevel);
  const emit = (event: string, msg: string, echo: boolean) => {
    const line = `[${new Date().toISOString()}] ${event}${msg === "" ? "" : ": " + msg}`;
    // Synchronous on purpose: the entrypoints call process.exit() right after
    // the final log line, which would drop a pending async append.
    try {
      appendFileSync(resolved, line + "\n");
    } catch {
      // noop: logging must never take the process down
    }
    if (echo) console.error(line);
  };
  return {
    log(event: string, msg: string = "") {
      emit(event, msg, level >= 1);
    },
    detail(minLevel: number, event: string, msg: string = "") {
      emit(event, msg, level >= minLevel);
    },
  };
}