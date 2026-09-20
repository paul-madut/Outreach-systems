import type { Db } from "@/lib/db";
import { parseJson } from "@/lib/db";
import { findSuppression } from "@/lib/suppressions";
import type { ColumnMapping, ContactField, ProspectField } from "./mapping";
import { contactSlots } from "./mapping";
import {
  companyKey,
  normalizeDomain,
  normalizeEmail,
  normalizeGrade,
  normalizeVertical,
  looksLikeInbox,
  parseChannel,
  parseHoldReason,
} from "./normalize";

/**
 * Committing an import.
 *
 * Paul keeps expanding these sheets and re-exporting them, so this has to be
 * safe to run repeatedly on an overlapping file. Identity is:
 *
 *   prospect -> normalised domain, falling back to a slug of the company name
 *   contact  -> lowercased email
 *
 * Row position is never used. The previous Python sender keyed on a sheet row
 * number, which broke the moment rows were sorted or inserted, and crashed
 * outright on any file that did not carry one.
 *
 * A blank cell never clears a value that is already stored. The tool learns
 * things the sheet does not know - a bounce, a reply, a hold set by hand - and
 * a re-import must not wipe them.
 */

export interface ImportRowResult {
  rowNumber: number;
  company: string | null;
  prospectId: number | null;
  action: "created" | "updated" | "skipped";
  contactsCreated: number;
  contactsUpdated: number;
  notes: string[];
}

export interface ImportReport {
  rows: number;
  prospectsCreated: number;
  prospectsUpdated: number;
  contactsCreated: number;
  contactsUpdated: number;
  skipped: number;
  suppressed: number;
  onHold: number;
  warnings: string[];
  perRow: ImportRowResult[];
}

interface StagedContact {
  slot: number;
  email: string | null;
  name: string | null;
  title: string | null;
  linkedin: string | null;
  channel: string | null;
  channelDetail: string | null;
  custom: Record<string, string>;
}

interface StagedRow {
  company: string | null;
  domain: string | null;
  vertical: string | null;
  grade: string | null;
  holdReason: string | null;
  custom: Record<string, string>;
  contacts: StagedContact[];
}

/** Turn one CSV row into the shape the database wants, applying the mapping. */
export function stageRow(row: Record<string, string>, mapping: ColumnMapping): StagedRow {
  const prospect: Partial<Record<ProspectField, string>> = {};
  const custom: Record<string, string> = {};
  const bySlot = new Map<number, StagedContact>();

  const slotFor = (slot: number): StagedContact => {
    let contact = bySlot.get(slot);
    if (!contact) {
      contact = {
        slot,
        email: null,
        name: null,
        title: null,
        linkedin: null,
        channel: null,
        channelDetail: null,
        custom: {},
      };
      bySlot.set(slot, contact);
    }
    return contact;
  };

  for (const [header, target] of Object.entries(mapping)) {
    const value = (row[header] ?? "").trim();
    if (!value || target.kind === "ignore") continue;

    switch (target.kind) {
      case "prospect":
        prospect[target.field] = value;
        break;
      case "prospect_custom":
        custom[target.key] = value;
        break;
      case "contact": {
        const contact = slotFor(target.slot);
        const field: ContactField = target.field;
        if (field === "channel") {
          const parsed = parseChannel(value);
          contact.channel = parsed.channel;
          contact.channelDetail = parsed.detail;
        } else {
          contact[field] = value;
        }
        break;
      }
      case "contact_custom":
        slotFor(target.slot).custom[target.key] = value;
        break;
    }
  }

  for (const slot of contactSlots(mapping)) slotFor(slot);

  return {
    company: prospect.company ?? null,
    domain: normalizeDomain(prospect.domain),
    vertical: normalizeVertical(prospect.vertical),
    grade: normalizeGrade(prospect.grade),
    holdReason: parseHoldReason(prospect.hold_reason),
    custom,
    contacts: [...bySlot.values()].sort((a, b) => a.slot - b.slot),
  };
}

function mergeCustom(
  existing: string | null,
  incoming: Record<string, string>
): string {
  const current = parseJson<Record<string, unknown>>(existing, {});
  return JSON.stringify({ ...current, ...incoming });
}


export interface CommitOptions {
  /** Parse and report without writing. */
  dryRun?: boolean;
  label?: string;
  sourceName?: string;
}

export function commitImport(
  db: Db,
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  options: CommitOptions = {}
): ImportReport {
  const { dryRun = false, label = "Import", sourceName = null } = options;

  const report: ImportReport = {
    rows: rows.length,
    prospectsCreated: 0,
    prospectsUpdated: 0,
    contactsCreated: 0,
    contactsUpdated: 0,
    skipped: 0,
    suppressed: 0,
    onHold: 0,
    warnings: [],
    perRow: [],
  };

  const run = db.transaction(() => {
    // Within one file, two rows can name the same company. Tracking what this
    // run has already touched keeps the second from counting as an update of
    // something that did not exist a moment ago.
    const seenProspects = new Map<string, number>();

    rows.forEach((raw, index) => {
      const rowNumber = index + 2; // +1 for zero-index, +1 for the header row
      const staged = stageRow(raw, mapping);
      const result: ImportRowResult = {
        rowNumber,
        company: staged.company,
        prospectId: null,
        action: "skipped",
        contactsCreated: 0,
        contactsUpdated: 0,
        notes: [],
      };

      const key = staged.domain ?? companyKey(staged.company);
      if (!key) {
        result.notes.push("No company or domain, so there is nothing to key on.");
        report.skipped += 1;
        report.perRow.push(result);
        return;
      }

      const existing = staged.domain
        ? (db.prepare("select id, custom from prospects where domain = ?").get(staged.domain) as
            | { id: number; custom: string }
            | undefined)
        : (db
            .prepare("select id, custom from prospects where domain is null and company_key = ?")
            .get(key) as { id: number; custom: string } | undefined);

      let prospectId: number;

      if (existing) {
        prospectId = existing.id;
        result.action = seenProspects.has(key) ? "updated" : "updated";

        if (!dryRun) {
          db.prepare(
            `update prospects
                set company = coalesce(nullif(?, ''), company),
                    vertical = coalesce(?, vertical),
                    grade = coalesce(?, grade),
                    hold_reason = coalesce(?, hold_reason),
                    custom = ?
              where id = ?`
          ).run(
            staged.company ?? "",
            staged.vertical,
            staged.grade,
            staged.holdReason,
            mergeCustom(existing.custom, staged.custom),
            prospectId
          );
        }
        if (!seenProspects.has(key)) report.prospectsUpdated += 1;
      } else if (seenProspects.has(key)) {
        // A duplicate inside this same file.
        prospectId = seenProspects.get(key)!;
        result.action = "updated";
        result.notes.push("Same company appears earlier in this file; merged into that row.");
        if (!dryRun) {
          const current = db.prepare("select custom from prospects where id = ?").get(prospectId) as {
            custom: string;
          };
          db.prepare("update prospects set custom = ? where id = ?").run(
            mergeCustom(current.custom, staged.custom),
            prospectId
          );
        }
      } else {
        result.action = "created";
        report.prospectsCreated += 1;

        if (dryRun) {
          prospectId = -1;
        } else {
          const inserted = db
            .prepare(
              `insert into prospects (company, company_key, domain, vertical, grade, hold_reason, custom)
               values (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              staged.company ?? key,
              companyKey(staged.company) ?? key,
              staged.domain,
              staged.vertical,
              staged.grade,
              staged.holdReason,
              JSON.stringify(staged.custom)
            );
          prospectId = Number(inserted.lastInsertRowid);
        }
      }

      seenProspects.set(key, prospectId);
      result.prospectId = prospectId;

      if (staged.holdReason) {
        report.onHold += 1;
        result.notes.push(`On hold: ${staged.holdReason}`);
      }

      for (const contact of staged.contacts) {
        const email = normalizeEmail(contact.email);
        const channel = contact.channel ?? (email ? "email" : "none");

        // A row with no address is still worth a contact row when the sheet
        // says how else to reach them. Nineteen of the payments prospects are
        // contact-form or phone only, and dropping them here would leave those
        // companies in the database with no recorded way in at all.
        const reachable = channel !== "none";
        if (!email && !contact.name && !contact.linkedin && !reachable) continue;

        // A shared mailbox is not a person. Keeping the label but clearing the
        // name stops `{{first_name}}` from greeting a company by its own name.
        const isInbox = looksLikeInbox(contact.name, contact.title);
        const personName = isInbox ? null : contact.name;
        if (isInbox && contact.name) {
          contact.custom.contact_label = contact.name;
          result.notes.push(`"${contact.name}" looks like a shared inbox, not a person.`);
        }

        if (email) {
          const suppression = findSuppression(db, email);
          if (suppression) {
            report.suppressed += 1;
            result.notes.push(
              `${email} is suppressed by ${suppression.kind} "${suppression.value}".`
            );
          }
        }

        const existingContact = email
          ? (db.prepare("select id, custom from contacts where lower(email) = ?").get(email) as
              | { id: number; custom: string }
              | undefined)
          : undefined;

        if (existingContact) {
          result.contactsUpdated += 1;
          report.contactsUpdated += 1;
          if (!dryRun) {
            db.prepare(
              `update contacts
                  set prospect_id = ?,
                      name = coalesce(nullif(?, ''), name),
                      title = coalesce(nullif(?, ''), title),
                      linkedin = coalesce(nullif(?, ''), linkedin),
                      channel = ?,
                      channel_detail = coalesce(?, channel_detail),
                      custom = ?
                where id = ?`
            ).run(
              prospectId,
              personName ?? "",
              contact.title ?? "",
              contact.linkedin ?? "",
              channel,
              contact.channelDetail,
              mergeCustom(existingContact.custom, contact.custom),
              existingContact.id
            );
          }
        } else {
          result.contactsCreated += 1;
          report.contactsCreated += 1;
          if (!dryRun) {
            db.prepare(
              `insert into contacts
                 (prospect_id, email, name, title, linkedin, channel, channel_detail, custom)
               values (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              prospectId,
              email,
              personName,
              contact.title,
              contact.linkedin,
              channel,
              contact.channelDetail,
              JSON.stringify(contact.custom)
            );
          }
        }
      }

      report.perRow.push(result);
    });

    if (!dryRun) {
      db.prepare(
        `insert into imports
           (label, source_name, mapping, row_count, created_prospects, created_contacts, skipped, report)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        label,
        sourceName,
        JSON.stringify(mapping),
        report.rows,
        report.prospectsCreated,
        report.contactsCreated,
        report.skipped,
        JSON.stringify({
          prospectsUpdated: report.prospectsUpdated,
          contactsUpdated: report.contactsUpdated,
          suppressed: report.suppressed,
          onHold: report.onHold,
        })
      );
    }
  });

  run();
  return report;
}

/** The most recently saved mapping for a source, so a re-export reuses it. */
export function lastMappingFor(db: Db, sourceName: string): ColumnMapping | null {
  const row = db
    .prepare("select mapping from imports where source_name = ? order by id desc limit 1")
    .get(sourceName) as { mapping: string } | undefined;

  return row ? parseJson<ColumnMapping>(row.mapping, {}) : null;
}
