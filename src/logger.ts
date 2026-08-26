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
export function createLogger(logFile: string): Logger {
  return {
    log(event: string, msg: string = "") {
      const line = `[${new Date().toISOString()}] ${event}${msg === "" ? "" : ": " + msg}\n`;
      appendFile(logFile, line).catch(() => {
        // noop: logging must never take the process down
      });
    },
  };
}