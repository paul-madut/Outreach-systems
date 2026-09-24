/**
 * What an inbound email looks like in Slack.
 *
 * Pure, so the wording is testable without a webhook.
 */

export interface AlertableInbound {
  id: number;
  classification: string;
  from_email: string;
  subject: string | null;
  snippet: string | null;
  received_at: string;
  mailbox_label: string;
  company: string | null;
  campaign: string | null;
}

/**
 * Which classifications are worth a notification.
 *
 * Deliberately not `unmatched`. That bucket is everything else that lands in
 * the mailbox, and while `jobs` is Paul's personal iCloud address it is his
 * personal mail: Uber receipts, job alerts, newsletters, DMARC reports. There
 * were 177 of them against 2 real replies when this was written, so alerting
 * on the bucket would bury the thing it exists to surface.
 */
export const ALERTED: ReadonlySet<string> = new Set([
  "reply",
  "bounce",
  "unsubscribe",
  "auto_reply",
]);

const HEADINGS: Record<string, string> = {
  reply: "Reply",
  bounce: "Bounce",
  unsubscribe: "Opt-out",
  auto_reply: "Auto-reply",
};

const MAX_SNIPPET_CHARS = 400;

/** Slack reads these three as markup, so they have to be escaped first. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncate(text: string, max = MAX_SNIPPET_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}...` : trimmed;
}

/**
 * Strip a quoted original from the snippet.
 *
 * A one-word answer above four hundred characters of quoted history reads in
 * Slack as a wall of Paul's own email with the actual reply lost at the top.
 */
export function withoutQuotedTail(text: string): string {
  const cut = text.search(/^\s*(>|On .{0,80}wrote:|-{2,}\s*Original Message)/m);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

export function alertText(row: AlertableInbound): string {
  const heading = HEADINGS[row.classification] ?? row.classification;
  const who = escapeSlack(row.from_email);
  const context = [row.company, row.campaign]
    .filter((value): value is string => Boolean(value))
    .map(escapeSlack)
    .join(" - ");

  const lines = [`*${heading}* from ${who}${context ? ` (${context})` : ""}`];
  if (row.subject) lines.push(`_${escapeSlack(truncate(row.subject, 120))}_`);

  const body = truncate(withoutQuotedTail(row.snippet ?? ""));
  if (body) {
    // Every line quoted so a multi-paragraph reply stays one visual unit.
    lines.push(
      escapeSlack(body)
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n")
    );
  }

  lines.push(`_via ${escapeSlack(row.mailbox_label)}_`);
  return lines.join("\n");
}
