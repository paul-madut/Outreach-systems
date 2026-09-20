import { toTemplateKey } from "@/lib/template/context";

/**
 * Column mapping.
 *
 * Two sheets with different shapes feed this tool: the payments prospects
 * sheet has one contact per row, the fintech job sheet has two. Rather than
 * hardcode either, every column is mapped to a target, and anything not
 * recognised becomes a merge field. That way a column added to a sheet later
 * is usable in a template the moment it is imported, with no schema change.
 *
 * Auto-detection is a starting point that the import screen can override, and
 * the chosen mapping is saved so the next export of the same tab reuses it.
 */

export type ProspectField = "company" | "domain" | "vertical" | "grade" | "hold_reason";
export type ContactField = "email" | "name" | "title" | "linkedin" | "channel";

export type FieldTarget =
  | { kind: "ignore" }
  | { kind: "prospect"; field: ProspectField }
  | { kind: "contact"; slot: number; field: ContactField }
  | { kind: "prospect_custom"; key: string }
  | { kind: "contact_custom"; slot: number; key: string };

/** Header name to target. Serialised into the `imports` table as JSON. */
export type ColumnMapping = Record<string, FieldTarget>;

function normalise(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Strip the parenthetical notes the research sheets carry, so
 * "Subject (agent fills)" matches the same rule as "Subject".
 */
function withoutNotes(header: string): string {
  return normalise(header).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

const PROSPECT_RULES: { field: ProspectField; names: string[] }[] = [
  { field: "company", names: ["company", "store", "store name", "company name", "brand", "merchant"] },
  // Deliberately narrow. "Finding URL", "Apply / role URL" and "Second URL"
  // point at a page, not at the company's own domain, and treating one as an
  // identity key would merge unrelated prospects that share an ATS host.
  { field: "domain", names: ["domain", "website", "web site", "site", "homepage"] },
  { field: "vertical", names: ["vertical", "segment", "category", "industry", "niche"] },
  { field: "grade", names: ["grade", "tier"] },
  { field: "hold_reason", names: ["review before contacting", "hold", "hold reason", "do not contact"] },
];

const CONTACT_RULES: { field: ContactField; names: string[] }[] = [
  { field: "email", names: ["email", "e-mail", "email address", "contact email", "primary contact"] },
  { field: "name", names: ["contact", "contact name", "name", "person"] },
  // Deliberately NOT "role title". In the fintech sheet that column holds the
  // job opening Paul would apply to, not the contact's own job title, and
  // letting it claim this field pushes the real "C1 title" out to a merge field.
  { field: "title", names: ["title", "job title", "position"] },
  { field: "linkedin", names: ["linkedin", "linkedin url", "linkedin profile"] },
  { field: "channel", names: ["channel", "contact channel"] },
];

/**
 * Slot-prefixed headers, as used by the fintech sheet:
 *   "Contact 1", "C1 title", "C1 LinkedIn", "C1 email"
 *   "Contact 2", "C2 title", "C2 LinkedIn", "C2 email"
 */
const SLOT_PREFIX = /^(?:c|contact)\s*(\d+)\b\s*(.*)$/;

function matchSlot(header: string): { slot: number; rest: string } | null {
  const match = SLOT_PREFIX.exec(withoutNotes(header));
  if (!match) return null;

  const slot = Number.parseInt(match[1], 10);
  if (!Number.isFinite(slot) || slot < 1) return null;

  return { slot, rest: match[2].trim() };
}

/**
 * Draft columns become merge fields under stable names, so a step whose
 * templates are literally `{{subject}}` and `{{body}}` sends the message that
 * was written per row in the sheet. Slugging them would give
 * `{{subject_agent_fills}}`, which ties the template to one sheet's wording.
 */
const DRAFT_RULES: { key: string; names: string[] }[] = [
  { key: "subject", names: ["subject", "subject line", "draft subject", "email subject"] },
  { key: "body", names: ["body", "draft", "draft body", "message", "email body", "draft message"] },
];

export function detectTarget(header: string): FieldTarget {
  const bare = withoutNotes(header);
  if (!bare) return { kind: "ignore" };

  // Slot-prefixed contact columns first, so "C1 title" is not read as the
  // prospect's own title.
  const slotted = matchSlot(header);
  if (slotted) {
    if (!slotted.rest) {
      // Bare "Contact 1" holds the person's name.
      return { kind: "contact", slot: slotted.slot, field: "name" };
    }
    for (const rule of CONTACT_RULES) {
      if (rule.names.includes(slotted.rest)) {
        return { kind: "contact", slot: slotted.slot, field: rule.field };
      }
    }
    return { kind: "contact_custom", slot: slotted.slot, key: toTemplateKey(slotted.rest) };
  }

  for (const rule of DRAFT_RULES) {
    if (rule.names.includes(bare)) return { kind: "prospect_custom", key: rule.key };
  }

  for (const rule of PROSPECT_RULES) {
    if (rule.names.includes(bare)) return { kind: "prospect", field: rule.field };
  }

  for (const rule of CONTACT_RULES) {
    if (rule.names.includes(bare)) return { kind: "contact", slot: 1, field: rule.field };
  }

  // Everything else is kept and addressable as a merge field. This is what
  // makes a column added to the sheet tomorrow usable without a code change.
  return { kind: "prospect_custom", key: toTemplateKey(header) };
}

export function autoMap(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const claimed = new Set<string>();

  // Slot-prefixed headers are resolved first. "C1 title" says exactly which
  // contact it belongs to, so it must win the field over a bare "Title"
  // appearing earlier in the sheet, whatever the column order happens to be.
  const ordered = [...headers].sort((a, b) => {
    const aSlotted = matchSlot(a) ? 0 : 1;
    const bSlotted = matchSlot(b) ? 0 : 1;
    return aSlotted - bSlotted;
  });

  for (const header of ordered) {
    const target = detectTarget(header);

    // Only one column may own a given typed field. A second candidate keeps
    // its data as a merge field rather than silently overwriting the first.
    if (target.kind === "prospect" || target.kind === "contact") {
      const key =
        target.kind === "prospect"
          ? `prospect:${target.field}`
          : `contact:${target.slot}:${target.field}`;

      if (claimed.has(key)) {
        mapping[header] = { kind: "prospect_custom", key: toTemplateKey(header) };
        continue;
      }
      claimed.add(key);
    }

    mapping[header] = target;
  }

  return mapping;
}

export interface MappingProblem {
  severity: "block" | "warn";
  message: string;
}

/**
 * A mapping has to produce something identifiable. Without a company or a
 * domain there is no stable key, so a re-import would duplicate every row
 * instead of updating it.
 */
export function validateMapping(mapping: ColumnMapping): MappingProblem[] {
  const problems: MappingProblem[] = [];
  const targets = Object.values(mapping);

  const hasCompany = targets.some((t) => t.kind === "prospect" && t.field === "company");
  const hasDomain = targets.some((t) => t.kind === "prospect" && t.field === "domain");

  if (!hasCompany && !hasDomain) {
    problems.push({
      severity: "block",
      message:
        "Map a column to Company or Domain. Without one there is no stable key, " +
        "so re-importing this sheet would duplicate every row rather than update it.",
    });
  }

  const emailSlots = targets.filter((t) => t.kind === "contact" && t.field === "email");
  if (emailSlots.length === 0) {
    problems.push({
      severity: "warn",
      message:
        "No column is mapped to a contact email. Prospects will import, but none " +
        "of them can be enrolled in an email campaign.",
    });
  }

  if (!hasDomain) {
    problems.push({
      severity: "warn",
      message:
        "No domain column. Prospects will be deduped on company name instead, " +
        "which is less reliable if the sheet spells a company two ways.",
    });
  }

  return problems;
}

/** Contact slots referenced by a mapping, ascending. */
export function contactSlots(mapping: ColumnMapping): number[] {
  const slots = new Set<number>();
  for (const target of Object.values(mapping)) {
    if (target.kind === "contact" || target.kind === "contact_custom") {
      slots.add(target.slot);
    }
  }
  return [...slots].sort((a, b) => a - b);
}
