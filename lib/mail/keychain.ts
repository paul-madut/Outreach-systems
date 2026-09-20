import { execFileSync } from "node:child_process";

/**
 * Mailbox passwords, read from the macOS Keychain.
 *
 * Carried over from `~/Desktop/peptide-outreach/send.py`, which has been doing
 * this successfully since September. Two details from that script matter:
 *
 *   - The path is absolute. launchd runs with a minimal PATH, and the earlier
 *     version that called a bare `security` worked from a terminal and failed
 *     as a scheduled job.
 *   - These are app-specific passwords, not account passwords. iCloud and
 *     Gmail both issue them, and both require two-factor to be on first.
 *
 * Storing one, for reference:
 *
 *   security add-generic-password -s icloud-smtp-outreach \
 *     -a paul.madut@icloud.com -w
 */

const SECURITY = "/usr/bin/security";

export class KeychainError extends Error {
  constructor(
    message: string,
    public readonly service: string,
    public readonly account: string
  ) {
    super(message);
    this.name = "KeychainError";
  }
}

export function readKeychainPassword(service: string, account: string): string {
  let raw: string;

  try {
    raw = execFileSync(SECURITY, ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8",
      // Reading the Keychain can prompt for access the first time. Fail rather
      // than let a scheduled run hang on a dialog nobody is there to answer.
      timeout: 10_000,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new KeychainError(
      `No password in the Keychain for service "${service}", account "${account}". ` +
        `Store one with: security add-generic-password -s ${service} -a ${account} -w` +
        (stderr ? `\n${stderr}` : ""),
      service,
      account
    );
  }

  const password = raw.trim();
  if (!password) {
    throw new KeychainError(
      `The Keychain entry for "${service}" / "${account}" is empty.`,
      service,
      account
    );
  }

  return password;
}

/** Whether an entry exists, without returning it. Used by the settings page. */
export function keychainEntryExists(service: string, account: string): boolean {
  try {
    execFileSync(SECURITY, ["find-generic-password", "-s", service, "-a", account], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}
