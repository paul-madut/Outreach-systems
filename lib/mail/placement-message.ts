import type { Database } from "better-sqlite3";
import type { MailboxRow } from "@/lib/campaign";
import { getStep } from "@/lib/campaign";
import { buildContext } from "@/lib/template/context";
import { renderMessage } from "@/lib/template/render";

/**
 * The message a placement test sends.
 *
 * A real sequence step, rendered against a real enrolled contact, with the
 * campaign's real footer. Filtering is a content decision, so a message
 * written for the test would measure something nobody is going to send.
 */

export interface TestMessage {
  subject: string;
  body: string;
  /** Who it was rendered against, so the reader knows what was measured. */
  renderedFor: string;
}

interface CampaignRow {
  id: number;
  footer_template: string | null;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildTestMessage(
  db: Database,
  campaignId: number,
  stepNumber: number,
  mailbox: MailboxRow,
  /**
   * Which enrolled contact to render against.
   *
   * Repeat runs must not send byte-identical mail to the same seed. A
   * provider treats a message it has already filed as a duplicate and files
   * the next copy the same way or worse, so consecutive tests stop being
   * independent samples - the second run tells you about the first run rather
   * than about the domain. Rotating the contact keeps every test a real
   * campaign message while making each one different.
   */
  offset = 0
): TestMessage {
  const campaign = db
    .prepare("select id, footer_template from campaigns where id = ?")
    .get(campaignId) as CampaignRow | undefined;
  if (!campaign) throw new Error(`No campaign with id ${campaignId}.`);

  const step = getStep(db, campaign.id, stepNumber);
  if (!step) throw new Error(`That campaign has no step ${stepNumber}.`);

  const contact = db
    .prepare(
      `select c.*, p.company, p.domain, p.vertical, p.grade, p.custom as prospect_custom
         from contacts c
         join prospects p on p.id = c.prospect_id
         join enrollments e on e.contact_id = c.id
        where e.campaign_id = ? and c.channel = 'email'
        order by c.id
        limit 1 offset ?`
    )
    .get(campaign.id, offset) as Record<string, unknown> | undefined;

  if (!contact) {
    throw new Error(
      offset === 0
        ? "That campaign has no enrolled email contact to render from."
        : `That campaign has fewer than ${offset + 1} enrolled email contacts to rotate through.`
    );
  }

  const context = buildContext({
    contact: {
      email: String(contact.email),
      name: (contact.name as string) ?? null,
      title: (contact.title as string) ?? null,
      linkedin: (contact.linkedin as string) ?? null,
      custom: parseJson(contact.custom),
    },
    prospect: {
      company: (contact.company as string) ?? null,
      domain: (contact.domain as string) ?? null,
      vertical: (contact.vertical as string) ?? null,
      grade: (contact.grade as string) ?? null,
      custom: parseJson(contact.prospect_custom),
    },
    sender: { name: mailbox.from_name, email: mailbox.from_email },
  });

  const rendered = renderMessage(step.subject_template, step.body_template, context);
  if (!rendered.ok) {
    throw new Error(
      `Template needs fields this contact has no value for: ${rendered.missing.join(", ")}`
    );
  }

  // The footer is appended at send time, not by the renderer, and it is real
  // content: an opt-out line is one of the clearest bulk-mail signals a filter
  // reads. A test without it would be testing a different message.
  const footer = campaign.footer_template?.trim();
  const body = footer ? `${rendered.body.trimEnd()}\n\n${footer}` : rendered.body;

  return {
    subject: rendered.subject,
    body,
    renderedFor: String(contact.company ?? contact.email),
  };
}
