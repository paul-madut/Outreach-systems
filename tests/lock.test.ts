import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockHeldError, acquireLock, withLock } from "@/lib/worker/lock";

let dir: string | null = null;

function lockPath(): string {
  dir = mkdtempSync(join(tmpdir(), "outreach-lock-"));
  return join(dir, "worker.lock");
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("acquireLock", () => {
  it("creates the lock and records this process", () => {
    const path = lockPath();
    const lock = acquireLock(path);

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));

    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a second worker while the first is alive", () => {
    const path = lockPath();
    const first = acquireLock(path);

    // The running process is this one, so the lock must be honoured.
    expect(() => acquireLock(path)).toThrow(LockHeldError);

    first.release();
    expect(() => acquireLock(path).release()).not.toThrow();
  });

  it("breaks a stale lock left by a dead process", () => {
    // The failure this fixes: the old scheduled_send.py wrote a lock with no
    // liveness check, so one hard kill wedged the job permanently.
    const path = lockPath();
    writeFileSync(path, "999999"); // a pid that cannot be running

    const lock = acquireLock(path);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    lock.release();
  });

  it("breaks a lock whose contents are garbage", () => {
    const path = lockPath();
    writeFileSync(path, "not-a-pid");

    const lock = acquireLock(path);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    lock.release();
  });

  it("breaks an empty lock file", () => {
    const path = lockPath();
    writeFileSync(path, "");

    const lock = acquireLock(path);
    lock.release();
  });

  it("creates the parent directory if it is missing", () => {
    const base = mkdtempSync(join(tmpdir(), "outreach-lock-"));
    dir = base;
    const path = join(base, "nested", "deeper", "worker.lock");

    const lock = acquireLock(path);
    expect(existsSync(path)).toBe(true);
    lock.release();
  });
});

describe("withLock", () => {
  it("releases after the callback resolves", async () => {
    const path = lockPath();
    const result = await withLock(path, async () => "done");

    expect(result).toBe("done");
    expect(existsSync(path)).toBe(false);
  });

  it("releases even when the callback throws", async () => {
    // A send that blows up must not leave the worker locked out forever.
    const path = lockPath();

    await expect(
      withLock(path, async () => {
        throw new Error("smtp exploded");
      })
    ).rejects.toThrow("smtp exploded");

    expect(existsSync(path)).toBe(false);
  });
});
