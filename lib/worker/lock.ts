import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Single-worker lock.
 *
 * Only one worker may run at a time. Two would each sweep the other's
 * in-flight messages into 'uncertain' at startup, and both would claim against
 * the same daily cap.
 *
 * The old `scheduled_send.py` used a check-then-create lock with no liveness
 * check, so a hard kill left a stale file that wedged the job permanently.
 * This uses O_EXCL for the create, and treats a lock whose PID is gone as
 * stale rather than as a running worker.
 */

export class LockHeldError extends Error {
  constructor(public readonly pid: number) {
    super(`Another worker is running (pid ${pid}).`);
    this.name = "LockHeldError";
  }
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence and permission without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Lock {
  release: () => void;
}

export function acquireLock(path: string): Lock {
  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // 'wx' fails if the file already exists, which makes the create atomic.
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);

      return {
        release: () => {
          try {
            unlinkSync(path);
          } catch {
            // Already gone. Nothing to do.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const pid = readLockPid(path);

      // A missing or unparsable pid, or a dead one, means the previous worker
      // died without cleaning up. Clear it and retry once.
      if (pid === null || !processAlive(pid)) {
        try {
          unlinkSync(path);
        } catch {
          // Someone else cleared it first, which is fine.
        }
        continue;
      }

      throw new LockHeldError(pid);
    }
  }

  throw new Error(`Could not acquire the worker lock at ${path}.`);
}

function readLockPid(path: string): number | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Run `fn` holding the lock, releasing it even if `fn` throws. */
export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = acquireLock(path);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
