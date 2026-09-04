import { mkdir, rm, readFile, writeFile } from "node:fs/promises";

/** Return true only if `pid` is an existing process. */
function isAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

/**
 * Filesystem exclusive lock based on an atomic `mkdir` guard. `mkdir` fails
 * with EEXIST if the directory already exists, so at most one process can hold
 * the lock at a time — no shell, no races, works across any filesystem.
 * Stale locks (dead PID) are reclaimed so a crashed process does not block
 * the next cron run forever.
 */
export class Lock {
  #dir: string;

  constructor(lockPath: string) {
    this.#dir = lockPath;
  }

  /** True if this process won the lock, false if it is already held by a live process. */
  async acquire(): Promise<boolean> {
    try {
      await mkdir(this.#dir);
      await writeFile(`${this.#dir}/pid`, String(process.pid));
      return true;
    } catch {
      // mkdir failed (likely EEXIST) — check for a stale lock.
      try {
        const pid = Number(await readFile(`${this.#dir}/pid`, "utf8"));
        if (pid > 0 && !isAlive(pid)) {
          await rm(this.#dir, { recursive: true, force: true });
          return this.acquire(); // retry once
        }
      } catch {
        // pid file unreadable or missing — do NOT steal the lock.
      }
      return false;
    }
  }

  async release(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true });
  }
}