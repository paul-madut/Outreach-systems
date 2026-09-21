import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load `.env.local` for anything that is not the Next.js server.
 *
 * Next loads that file itself, so the dashboard has always seen it. The
 * worker did not: launchd starts it with almost no environment, and nothing
 * in the process read the file. The result was the worst possible failure,
 * a silent one. `OUTREACH_LIVE=1` sat in `.env.local` exactly where the
 * installer said to put it, every scheduled run claimed and rendered and
 * logged as though it were working, and no email was ever delivered.
 *
 * Called at the top of each script so both halves read the same file.
 */
export function loadLocalEnv(cwd = process.cwd()): void {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;

    try {
      process.loadEnvFile(path);
    } catch {
      // A malformed file should not stop the worker from running its dry
      // pass. Whatever is missing shows up as a setting that is simply off.
    }
  }
}
