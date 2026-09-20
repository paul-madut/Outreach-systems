#!/usr/bin/env tsx
/**
 * The worker. One pass, then exit.
 *
 * Usage:
 *   pnpm worker              # send what is due, then poll for replies
 *   pnpm worker --send-only
 *   pnpm worker --poll-only
 *   pnpm worker --limit 3
 *
 * Nothing is delivered unless OUTREACH_LIVE=1. Without it the whole pipeline
 * runs except the network call, so a dry pass is safe at any time.
 *
 * Designed to be woken by launchd every few minutes rather than to stay
 * running. Each message already carries its own scheduled_at, so there is
 * nothing to keep in memory between passes.
 */
import { resolve } from "node:path";
import { getDb, databasePath } from "@/lib/db";
import { withLock, LockHeldError } from "@/lib/worker/lock";
import { sweepOrphans } from "@/lib/worker/claim";
import { isLive, runSendTick } from "@/lib/worker/send-tick";
import { pollAllMailboxes } from "@/lib/worker/poll-mailbox";

const LOCK_PATH = resolve(process.cwd(), ".worker.lock");

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(line: string): void {
  console.log(`${stamp()} ${line}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sendOnly = args.includes("--send-only");
  const pollOnly = args.includes("--poll-only");
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 5;

  const db = getDb();
  log(`database ${databasePath()}`);
  if (!isLive()) log("OUTREACH_LIVE is not 1, so nothing will actually be sent.");

  // Safe only while the lock is held: at this moment no send is in flight, so
  // anything still marked 'sending' was left by a worker that died.
  const orphans = sweepOrphans(db);
  if (orphans > 0) {
    log(`${orphans} message(s) left mid-send by a previous run marked uncertain.`);
  }

  if (!pollOnly) {
    const result = await runSendTick(db, { limit });
    log(
      `send: claimed ${result.claimed}, sent ${result.sent}, requeued ${result.released}, ` +
        `uncertain ${result.uncertain}, failed ${result.failed}, follow-ups ${result.followUpsCreated}`
    );
    for (const note of result.notes) log(`  ${note}`);
    for (const mailbox of result.mailboxesPaused) {
      log(`  MAILBOX PAUSED: ${mailbox}. Nothing more will send from it until you resume it.`);
    }
  }

  if (!sendOnly) {
    const results = await pollAllMailboxes(db);
    for (const result of results) {
      log(
        `poll ${result.mailbox}: ${result.fetched} new, ${result.replies} replies, ` +
          `${result.autoReplies} auto, ${result.bounces} bounces, ` +
          `${result.unsubscribes} opt-outs, ${result.unmatched} unmatched, ` +
          `${result.stopped} sequence(s) stopped`
      );
      for (const note of result.notes) log(`  ${note}`);
    }
  }
}

withLock(LOCK_PATH, main).catch((error) => {
  if (error instanceof LockHeldError) {
    // Normal when a previous pass is still running. Not a failure.
    log(error.message);
    process.exit(0);
  }
  console.error(`${stamp()} worker failed: ${(error as Error).message}`);
  process.exit(1);
});
