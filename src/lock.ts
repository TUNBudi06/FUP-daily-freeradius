import { mkdir, rm } from "node:fs/promises";

/**
 * Filesystem exclusive lock based on an atomic `mkdir` guard. `mkdir` fails
 * with EEXIST if the directory already exists, so at most one process can hold
 * the lock at a time — no shell, no races, works across any filesystem.
 */
export class Lock {
  #dir: string;

  constructor(lockPath: string) {
    this.#dir = lockPath;
  }

  /** True if this process won the lock, false if it is already held. */
  async acquire(): Promise<boolean> {
    try {
      await mkdir(this.#dir);
      return true;
    } catch {
      return false; // already held by another run -> caller exits cleanly
    }
  }

  async release(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true });
  }
}