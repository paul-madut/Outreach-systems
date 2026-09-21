import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalEnv } from "@/lib/env";

/**
 * The worker reads its own `.env.local`.
 *
 * Next loads that file for the dashboard, so the two halves used to disagree
 * about whether sending was live: launchd starts the worker with almost no
 * environment, and nothing read the file. Every scheduled run then did the
 * whole job except the network call and reported success.
 */

// A name no other test or the real environment would use.
const KEY = "OUTREACH_TEST_FLAG";

function withEnvFile(contents: string, name = ".env.local"): string {
  const dir = mkdtempSync(join(tmpdir(), "outreach-env-"));
  writeFileSync(join(dir, name), contents);
  return dir;
}

afterEach(() => {
  delete process.env[KEY];
});

describe("loadLocalEnv", () => {
  it("reads a value out of .env.local", () => {
    expect(process.env[KEY]).toBeUndefined();

    loadLocalEnv(withEnvFile(`${KEY}=1\n`));

    expect(process.env[KEY]).toBe("1");
  });

  it("falls back to .env when there is no .env.local", () => {
    loadLocalEnv(withEnvFile(`${KEY}=from-env\n`, ".env"));

    expect(process.env[KEY]).toBe("from-env");
  });

  it("does nothing when there is no file, rather than throwing", () => {
    const empty = mkdtempSync(join(tmpdir(), "outreach-env-"));

    expect(() => loadLocalEnv(empty)).not.toThrow();
    expect(process.env[KEY]).toBeUndefined();

    rmSync(empty, { recursive: true, force: true });
  });

  it("survives a malformed file, because a dry pass is better than no pass", () => {
    expect(() => loadLocalEnv(withEnvFile("this is not = a = valid\x00line\n"))).not.toThrow();
  });
});
