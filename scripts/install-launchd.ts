#!/usr/bin/env tsx
/**
 * Install or remove the launchd job that wakes the worker.
 *
 * Usage:
 *   pnpm schedule install     # every 10 minutes while the Mac is awake
 *   pnpm schedule uninstall
 *   pnpm schedule status
 *
 * Two details carried over from the previous Python job:
 *
 * - launchd runs with a minimal PATH, so every path in the plist is absolute.
 *   The earlier version called a bare `security` and worked from a terminal
 *   while failing as a scheduled job.
 * - The job lives here in the repo rather than under ~/Desktop. macOS blocks
 *   launchd-spawned processes from reading Desktop, Documents and Downloads,
 *   which is what made the first scheduled run fail with "Operation not
 *   permitted". If this repo is ever moved under one of those, the job needs
 *   Full Disk Access or a different home.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const LABEL = "com.paulmadut.outreach.worker";
const PLIST_PATH = resolve(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const REPO = process.cwd();
const LOG_DIR = resolve(REPO, "logs");
const INTERVAL_SECONDS = 600;

const PROTECTED = ["/Desktop/", "/Documents/", "/Downloads/"];

function plist(pnpmPath: string, nodeDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <!-- caffeinate -i keeps the Mac from sleeping mid-send. It does not wake
         it up, so a closed laptop still sends nothing until it is opened. -->
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>${pnpmPath}</string>
    <string>worker</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd starts with almost no PATH, so node has to be findable. -->
    <key>PATH</key>
    <string>${nodeDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>

  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/worker.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/worker.err</string>
</dict>
</plist>
`;
}

function which(command: string): string {
  return execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim();
}

function install(): void {
  for (const folder of PROTECTED) {
    if (REPO.includes(folder)) {
      console.error(
        `\nThis repo is inside ${folder.replaceAll("/", "")}, which macOS blocks launchd from reading.\n` +
          `A scheduled run would fail with "Operation not permitted".\n` +
          `Move the repo somewhere else, or grant Full Disk Access to launchd.\n`
      );
      process.exit(1);
    }
  }

  const pnpmPath = which("pnpm");
  const nodeDir = dirname(which("node"));

  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, plist(pnpmPath, nodeDir));

  // bootout first so a reinstall replaces rather than stacks.
  execFileSync("/bin/launchctl", ["bootout", `gui/${process.getuid?.()}/${LABEL}`], {
    stdio: "ignore",
  });
  execFileSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid?.()}`, PLIST_PATH]);

  console.log(`Installed ${LABEL}.`);
  console.log(`  runs        every ${INTERVAL_SECONDS / 60} minutes while the Mac is awake`);
  console.log(`  working dir ${REPO}`);
  console.log(`  logs        ${LOG_DIR}/worker.log`);
  console.log(
    `\nNothing is delivered until OUTREACH_LIVE=1 is in ${REPO}/.env.local.` +
      `\nThe worker reads that file itself, so no relaunch of anything else is needed.`
  );
}

function uninstall(): void {
  execFileSync("/bin/launchctl", ["bootout", `gui/${process.getuid?.()}/${LABEL}`], {
    stdio: "ignore",
  });
  if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
  console.log(`Removed ${LABEL}.`);
}

function status(): void {
  if (!existsSync(PLIST_PATH)) {
    console.log("Not installed. Run: pnpm schedule install");
    return;
  }
  try {
    const output = execFileSync("/bin/launchctl", ["print", `gui/${process.getuid?.()}/${LABEL}`], {
      encoding: "utf8",
    });
    const state = /state = (\S+)/.exec(output)?.[1] ?? "unknown";
    const lastExit = /last exit code = (\S+)/.exec(output)?.[1] ?? "none yet";
    console.log(`Installed. state ${state}, last exit code ${lastExit}.`);
    console.log(`Logs: ${LOG_DIR}/worker.log`);
  } catch {
    console.log("The plist exists but launchd does not have it loaded. Re-run install.");
  }
}

const command = process.argv[2] ?? "status";

switch (command) {
  case "install":
    install();
    break;
  case "uninstall":
    uninstall();
    break;
  case "status":
    status();
    break;
  default:
    console.error('Usage: pnpm schedule <install|uninstall|status>');
    process.exit(1);
}
