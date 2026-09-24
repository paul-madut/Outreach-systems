#!/usr/bin/env tsx
/**
 * Create and run campaigns.
 *
 * Usage:
 *   pnpm campaign list
 *   pnpm campaign create --name "high-risk payments" --mailbox payments
 *   pnpm campaign step --campaign "high-risk payments" --step 1 \
 *       --subject "Quick question" --body-file step1.txt
 *   pnpm campaign preview --campaign "high-risk payments"
 *   pnpm campaign enroll  --campaign "high-risk payments" [--grade A] [--limit 20] [--commit]
 *   pnpm campaign activate|pause --campaign "high-risk payments"
 *   pnpm campaign move --campaign "high-risk payments" --mailbox pwp-1
 *
 * A step whose subject and body are literally {{subject}} and {{body}} sends
 * the draft written per row in the sheet. Anything else is a shared template.
 */
import { readFileSync } from "node:fs";
import { getDb } from "@/lib/db";
import {
  createCampaign,
  getCampaign,
  moveCampaign,
  listSteps,
  setCampaignStatus,
  upsertStep,
} from "@/lib/campaign";
import { INELIGIBLE_LABEL, dryRender, enrollContacts, previewEnrollment } from "@/lib/enroll";
import { selectContacts } from "@/lib/enroll/select";
import { listCampaigns } from "@/lib/queries";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Select contacts by what the research says about them.
 *
 * The rules live in `lib/enroll/select.ts` so the dashboard and this script
 * pick the same people. Returns null when no filter was given, which means
 * "every eligible contact" rather than "none".
 */
function contactsMatching(
  match: string | undefined,
  notMatch: string | undefined,
  grade: string | undefined,
  limit: number | undefined
): { ids: number[]; rows: { company: string; excerpt: string }[] } | null {
  if (!match && !notMatch && !grade && !limit) return null;

  const selection = selectContacts(getDb(), { match, exclude: notMatch, grade, limit });
  if (selection.error) {
    console.error(`Bad pattern: ${selection.error}`);
    process.exit(1);
  }

  return {
    ids: selection.contacts.map((contact) => contact.contactId),
    rows: selection.contacts.map((contact) => ({
      company: contact.company,
      excerpt: contact.excerpt,
    })),
  };
}

function campaignIdFor(name: string): number {
  const row = getDb().prepare("select id from campaigns where name = ?").get(name) as
    | { id: number }
    | undefined;
  if (!row) {
    console.error(`No campaign called "${name}". Run: pnpm campaign list`);
    process.exit(1);
  }
  return row.id;
}

function list(): void {
  const rows = listCampaigns(getDb());
  if (rows.length === 0) {
    console.log("No campaigns yet. Create one with: pnpm campaign create --help");
    return;
  }

  for (const row of rows) {
    console.log(`\n${row.name}  (${row.status})  sends from ${row.mailbox}`);
    console.log(
      `  enrolled ${row.enrolled}  drafts ${row.drafts}  scheduled ${row.scheduled}  ` +
        `sent ${row.sent}  replied ${row.replied}  bounced ${row.bounced}`
    );
    const steps = listSteps(getDb(), row.id);
    if (steps.length === 0) {
      console.log("  no steps yet - nothing can be enrolled until step 1 exists");
    }
    for (const step of steps) {
      const delay = step.step_number === 1 ? "immediately" : `+${step.delay_days}d`;
      console.log(`  step ${step.step_number} (${delay}): ${step.subject_template}`);
    }
  }
}

function create(args: string[]): void {
  const name = flag(args, "name");
  const mailboxLabel = flag(args, "mailbox");

  if (!name || !mailboxLabel) {
    console.error("Need --name and --mailbox.");
    process.exit(1);
  }

  const mailbox = getDb().prepare("select id from mailboxes where label = ?").get(mailboxLabel) as
    | { id: number }
    | undefined;

  if (!mailbox) {
    console.error(`No mailbox called "${mailboxLabel}". Run: pnpm mailbox list`);
    process.exit(1);
  }

  const id = createCampaign(getDb(), {
    mailboxId: mailbox.id,
    name,
    timezone: flag(args, "timezone") ?? "America/Toronto",
    windowStart: flag(args, "window-start") ?? "09:00",
    windowEnd: flag(args, "window-end") ?? "16:00",
    newPerDay: Number(flag(args, "per-day") ?? 10),
    autoApprove: args.includes("--auto-approve"),
    footerTemplate: flag(args, "footer-file")
      ? readFileSync(flag(args, "footer-file")!, "utf8").trim()
      : null,
  });

  console.log(`Created campaign "${name}" (id ${id}), status draft.`);
  console.log("Add step 1, then activate it:");
  console.log(`  pnpm campaign step --campaign "${name}" --step 1 --subject "..." --body-file body.txt`);
}

function step(args: string[]): void {
  const name = flag(args, "campaign");
  const stepNumber = Number(flag(args, "step") ?? 1);
  const subject = flag(args, "subject");
  const bodyFile = flag(args, "body-file");
  const body = bodyFile ? readFileSync(bodyFile, "utf8").trimEnd() : flag(args, "body");

  if (!name || !subject || !body) {
    console.error("Need --campaign, --subject and one of --body or --body-file.");
    process.exit(1);
  }

  upsertStep(getDb(), {
    campaignId: campaignIdFor(name),
    stepNumber,
    subjectTemplate: subject,
    bodyTemplate: body,
    delayDays: Number(flag(args, "delay") ?? (stepNumber === 1 ? 0 : 3)),
  });

  console.log(`Saved step ${stepNumber} on "${name}".`);
  if (stepNumber > 1) {
    console.log("Follow-ups thread onto step 1, so their subject is set to Re: <step 1 subject>.");
  }
}

/** Show who would be enrolled and what they would receive, without writing. */
function preview(args: string[]): void {
  const name = flag(args, "campaign");
  if (!name) {
    console.error("Need --campaign.");
    process.exit(1);
  }

  const db = getDb();
  const campaignId = campaignIdFor(name);

  const selection = contactsMatching(
    flag(args, "match"),
    flag(args, "not-match"),
    flag(args, "grade"),
    flag(args, "limit") ? Number(flag(args, "limit")) : undefined
  );

  if (selection) {
    console.log(`\n${selection.ids.length} match the filter:`);
    for (const row of selection.rows) {
      console.log(`  ${row.company.slice(0, 30).padEnd(30)} ...${row.excerpt}...`);
    }
  }

  const { eligible, ineligible } = previewEnrollment(db, campaignId, selection?.ids);

  console.log(`\n${eligible.length} eligible, ${ineligible.length} not.`);

  const reasons = new Map<string, number>();
  for (const row of ineligible) {
    const key = INELIGIBLE_LABEL[row.kind];
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${reason}`);
  }

  if (eligible.length === 0) return;

  const render = dryRender(db, campaignId, eligible.slice(0, Number(flag(args, "show") ?? 3)));

  if (render.failed.length > 0) {
    console.log(`\n${render.failed.length} would not render:`);
    for (const row of render.failed.slice(0, 5)) {
      console.log(`  ${row.company}: missing ${row.missing.join(", ")}`);
    }
  }
  if (render.blocked.length > 0) {
    console.log(`\n${render.blocked.length} blocked by the content check:`);
    for (const row of render.blocked.slice(0, 5)) {
      console.log(`  ${row.company}: ${row.findings.map((f) => f.message).join(" ")}`);
    }
  }

  for (const message of render.rendered.slice(0, 2)) {
    console.log(`\n--- ${message.company} <${message.email}> ---`);
    console.log(`Subject: ${message.subject}\n`);
    console.log(message.body);
    for (const finding of message.findings) {
      console.log(`  [${finding.severity}] ${finding.message}`);
    }
  }
}

function enroll(args: string[]): void {
  const name = flag(args, "campaign");
  if (!name) {
    console.error("Need --campaign.");
    process.exit(1);
  }

  const db = getDb();
  const campaignId = campaignIdFor(name);
  const grade = flag(args, "grade");
  const limit = flag(args, "limit") ? Number(flag(args, "limit")) : undefined;
  const commit = args.includes("--commit");

  const selection = contactsMatching(
    flag(args, "match"),
    flag(args, "not-match"),
    grade,
    limit
  );
  const contactIds = selection?.ids;

  if (selection) {
    console.log(`${selection.ids.length} contacts match the filter.`);
  }

  const result = enrollContacts(db, campaignId, { contactIds, dryRun: !commit });

  console.log(`\n${commit ? "Enrolled" : "Would enrol"} ${result.enrolled}.`);
  console.log(`  ${result.drafted} waiting for review, ${result.scheduled} scheduled directly`);
  console.log(`  ${result.skipped.length} skipped, ${result.failed.length} would not render, ${result.blocked.length} blocked`);

  if (result.firstSendAt) {
    console.log(`  first send ${result.firstSendAt.toISOString()}`);
    console.log(`  last send  ${result.lastSendAt!.toISOString()}`);
  }

  for (const row of result.blocked.slice(0, 5)) {
    console.log(`  BLOCKED ${row.company}: ${row.findings.map((f) => f.message).join(" ")}`);
  }

  const campaign = getCampaign(db, campaignId);
  if (commit && campaign.status === "draft") {
    console.log(`\nThe campaign is still a draft, so nothing will send. Activate it:`);
    console.log(`  pnpm campaign activate --campaign "${name}"`);
  }
  if (!commit) console.log("\nNothing was written. Re-run with --commit.");
}

function setStatus(args: string[], status: "active" | "paused"): void {
  const name = flag(args, "campaign");
  if (!name) {
    console.error("Need --campaign.");
    process.exit(1);
  }

  const db = getDb();
  const campaignId = campaignIdFor(name);

  if (status === "active" && listSteps(db, campaignId).length === 0) {
    console.error("This campaign has no steps, so there is nothing to send.");
    process.exit(1);
  }

  setCampaignStatus(db, campaignId, status);
  console.log(`Campaign "${name}" is now ${status}.`);
}

/**
 * Send a campaign from a different mailbox.
 *
 * Queued mail moves with it, because `messages.mailbox_id` is fixed when the
 * row is rendered and would otherwise keep going out from the old address.
 * Anything belonging to a conversation that has already started stays put.
 */
function move(args: string[]): void {
  const name = flag(args, "campaign");
  const label = flag(args, "mailbox");
  if (!name || !label) {
    console.error("Need --campaign and --mailbox.");
    process.exit(1);
  }

  const db = getDb();
  const campaignId = campaignIdFor(name);

  const mailbox = db
    .prepare("select id, from_email from mailboxes where label = ?")
    .get(label) as { id: number; from_email: string } | undefined;
  if (!mailbox) {
    console.error(`No mailbox labelled "${label}". Run pnpm mailbox list.`);
    process.exit(1);
  }

  const result = moveCampaign(db, campaignId, mailbox.id);

  console.log(`"${name}" now sends from ${label} <${mailbox.from_email}>.`);
  console.log(`  ${plural(result.moved, "queued message")} moved with it.`);
  if (result.keptOnThread > 0) {
    console.log(
      `  ${plural(result.keptOnThread, "follow-up")} stayed behind: the thread started from the`
    );
    console.log(`  old address, and a reply from a new one would read as a stranger.`);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "list":
  case undefined:
    list();
    break;
  case "create":
    create(args);
    break;
  case "step":
    step(args);
    break;
  case "preview":
    preview(args);
    break;
  case "enroll":
    enroll(args);
    break;
  case "activate":
    setStatus(args, "active");
    break;
  case "pause":
    setStatus(args, "paused");
    break;
  case "move":
    move(args);
    break;
  default:
    console.error(
      `Unknown command "${command}". Try list, create, step, preview, enroll, activate, pause or move.`
    );
    process.exit(1);
}
