import type { Db } from "@/lib/db";

/**
 * Everything a reply draft should know about.
 *
 * Assembled as data and rendered as a prompt separately, so what gets sent to
 * the model can be asserted on in a test without calling anything.
 */

export interface ReplyContext {
  /** What they wrote back, quoted history already stripped. */
  inboundBody: string;
  inboundSubject: string | null;
  fromEmail: string;
  classification: string;

  /** The campaign's angle, which is what the reply has to stay consistent with. */
  campaignName: string | null;
  /** Step 1's template: Paul's own writing, and the best voice sample there is. */
  campaignTemplate: string | null;

  /** The exact message they are replying to. */
  sentSubject: string | null;
  sentBody: string | null;

  company: string | null;
  vertical: string | null;
  /** Free-text research notes from the import, minus anything empty. */
  research: Record<string, string>;

  /** Earlier drafts, so a reroll does not repeat itself. */
  priorAttempts: string[];
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Drop the quoted original, which is Paul's own email coming back at him. */
export function withoutQuotedTail(text: string): string {
  const cut = text.search(/^\s*(>|On .{0,80}wrote:|-{2,}\s*Original Message)/m);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

export function buildReplyContext(db: Db, inboundId: number): ReplyContext {
  const row = db
    .prepare(
      `select i.snippet, i.subject, i.from_email, i.classification,
              m.subject as sent_subject, m.body as sent_body,
              c.name as campaign_name,
              s.body_template as campaign_template,
              p.company, p.vertical, p.custom as prospect_custom,
              ct.custom as contact_custom
         from inbound_messages i
         left join messages m on m.id = i.matched_message_id
         left join enrollments e on e.id = m.enrollment_id
         left join campaigns c on c.id = e.campaign_id
         left join sequence_steps s on s.campaign_id = c.id and s.step_number = 1
         left join contacts ct on ct.id = e.contact_id
         left join prospects p on p.id = ct.prospect_id
        where i.id = ?`
    )
    .get(inboundId) as Record<string, unknown> | undefined;

  if (!row) throw new Error(`No inbound message with id ${inboundId}`);

  const research: Record<string, string> = {};
  for (const source of [parseJson(row.prospect_custom), parseJson(row.contact_custom)]) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string" && value.trim() !== "") research[key] = value.trim();
    }
  }

  const priorAttempts = (
    db
      .prepare("select body from reply_suggestions where inbound_id = ? order by attempt")
      .all(inboundId) as { body: string }[]
  ).map((r) => r.body);

  return {
    inboundBody: withoutQuotedTail(String(row.snippet ?? "")),
    inboundSubject: (row.subject as string) ?? null,
    fromEmail: String(row.from_email),
    classification: String(row.classification),
    campaignName: (row.campaign_name as string) ?? null,
    campaignTemplate: (row.campaign_template as string) ?? null,
    sentSubject: (row.sent_subject as string) ?? null,
    sentBody: (row.sent_body as string) ?? null,
    company: (row.company as string) ?? null,
    vertical: (row.vertical as string) ?? null,
    research,
    priorAttempts,
  };
}
