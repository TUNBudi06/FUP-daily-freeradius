import { mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";

/** A lock dir with no readable pid this old was left by a crashed acquire. */
const PIDLESS_STALE_MS = 60_000;

/** Return true only if `pid` is an existing process. */
function isAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (e) {
    // EPERM: the process exists but belongs to another user — it is alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
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
  #reclaimed = false;
  #reclaimedFrom: number | "pidless" | undefined;

  constructor(lockPath: string) {
    this.#dir = lockPath;
  }

  /**
   * True once `acquire()` won the lock only after clearing a stale one left
   * by a crashed run. A fresh `Lock` starts false; check this right after a
   * successful `acquire()` to log/alert on it — a stale lock usually means
   * the previous cycle was killed (OOM, `kill -9`, host reboot) rather than
   * exiting cleanly.
   */
  get reclaimedStaleLock(): boolean {
    return this.#reclaimed;
  }

  /** The dead PID (or `"pidless"` if the pid file was missing) that owned the
   *  lock this `acquire()` reclaimed, or undefined if nothing was reclaimed. */
  get reclaimedFrom(): number | "pidless" | undefined {
    return this.#reclaimedFrom;
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
          this.#reclaimed = true;
          this.#reclaimedFrom = pid;
          await rm(this.#dir, { recursive: true, force: true });
          return this.acquire(); // retry once
        }
      } catch {
        // pid file unreadable or missing: normally another process is between
        // mkdir and writing its pid, so do not steal — unless the directory is
        // old enough that the owner must have crashed in that window.
        try {
          const age = Date.now() - (await stat(this.#dir)).mtimeMs;
          if (age > PIDLESS_STALE_MS) {
            this.#reclaimed = true;
            this.#reclaimedFrom = "pidless";
            await rm(this.#dir, { recursive: true, force: true });
            return this.acquire();
          }
        } catch {
          // lock vanished or unreadable — treat as held.
        }
      }
      return false;
    }
  }

  async release(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true });
  }
}