import { appendFile } from "node:fs/promises";

export interface Logger {
  log(event: string, msg?: string): void;
}

/**
 * Append-only file logger. Every line is timestamped (ISO 8601) and prefixed
 * with a machine-readable event name so logs are grep-able. Writes are
 * fire-and-forget; a full queue is worse than a dropped line in this context.
 * Callers must never pass secrets into `msg`.
 */
/** Expand a leading `~/` to $HOME. `.env` values are literally passed, so the shell
 *  would otherwise create a file literally named `~`. */
export function resolveLogPath(logFile: string): string {
  return logFile.startsWith("~/") ? `${process.env.HOME ?? "/root"}${logFile.slice(1)}` : logFile;
}

export function createLogger(logFile: string, verbose: boolean = false): Logger {
  const resolved = resolveLogPath(logFile);
  return {
    log(event: string, msg: string = "") {
      const line = `[${new Date().toISOString()}] ${event}${msg === "" ? "" : ": " + msg}`;
      appendFile(resolved, line + "\n").catch(() => {
        // noop: logging must never take the process down
      });
      if (verbose) {
        console.error(line);
      }
    },
  };
}