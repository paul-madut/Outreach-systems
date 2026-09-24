import type { TemplateContext } from "./context";

/**
 * Strict template rendering.
 *
 * `{{field}}` must resolve to a non-empty value or the render fails.
 * `{{field|fallback}}` uses the fallback when the value is missing or blank,
 * which is what role addresses need: `{{first_name|there}}` covers a
 * `support@` inbox with no name attached.
 *
 * Failure is returned, not thrown, so the review queue can show every problem
 * in a message at once instead of one per save.
 */

const FIELD = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\}\}/g;

/**
 * Conditional sections.
 *
 *   {{#quote}}Your page says "{{quote}}".{{/quote}}   include when present
 *   {{^quote}}...{{/quote}}                            include when absent
 *
 * Research is uneven. Some prospects have a damning verbatim quote, others
 * only have a payment list, and a line that reads well with a quote reads
 * broken without one. Without sections the only options are a template that
 * fails to render for half the list, or one so generic it says nothing.
 */
const SECTION = /\{\{([#^])\s*([a-zA-Z0-9_]+)\s*\}\}(\n?)([\s\S]*?)\{\{\/\s*\2\s*\}\}(\n?)/g;

/**
 * Whether a section owns the lines it sits on.
 *
 * A section written on its own lines is structural: dropping it should take
 * its blank line with it, or the template grows a gap. A section sitting
 * inside a line is not - it is a branch within a sentence, like the two
 * halves of a greeting:
 *
 *   {{#first_name}}Hi {{first_name}},{{/first_name}}{{^first_name}}Hello,{{/first_name}}
 *
 * Swallowing the newline after the losing branch there pulls the next
 * paragraph up onto the greeting's line.
 */
function ownsItsLine(whole: string, offset: number, length: number, trailingNewline: string): boolean {
  const startsLine = offset === 0 || whole[offset - 1] === "\n";
  const endsLine = trailingNewline === "\n" || offset + length === whole.length;
  return startsLine && endsLine;
}

/** Nesting is allowed, so this runs until nothing changes. */
function expandSections(template: string, context: TemplateContext): string {
  let output = template;

  for (let pass = 0; pass < 10; pass += 1) {
    const next = output.replace(
      SECTION,
      (
        match: string,
        kind: string,
        key: string,
        openNewline: string,
        inner: string,
        closeNewline: string,
        offset: number,
        whole: string
      ) => {
        const present = Boolean(context[key]?.trim());
        const keep = kind === "#" ? present : !present;
        const standalone = ownsItsLine(whole, offset, match.length, closeNewline);

        if (!keep) return standalone ? "" : closeNewline;
        return standalone ? inner : openNewline + inner + closeNewline;
      }
    );

    if (next === output) break;
    output = next;
  }

  return output;
}

/**
 * A dropped section leaves the blank lines that surrounded it. Three or more
 * newlines never mean anything in a plain text email, so they collapse to a
 * paragraph break.
 */
function tidyWhitespace(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface RenderOk {
  ok: true;
  text: string;
}

export interface RenderFailure {
  ok: false;
  /** Field names that had no value and no fallback, in first-seen order. */
  missing: string[];
}

export type RenderResult = RenderOk | RenderFailure;

export function render(template: string, context: TemplateContext): RenderResult {
  const missing: string[] = [];

  // Sections first. A field inside a section that was dropped must not count
  // as missing, or a template would fail for exactly the prospects it was
  // written to handle gracefully.
  const expanded = expandSections(template, context);

  const text = expanded.replace(FIELD, (_match, rawKey: string, fallback?: string) => {
    const key = rawKey.trim();
    const value = context[key];

    if (value !== undefined && value !== "") {
      return value;
    }
    if (fallback !== undefined) {
      return fallback.trim();
    }

    if (!missing.includes(key)) {
      missing.push(key);
    }
    return "";
  });

  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, text: tidyWhitespace(text) };
}

/** Every field a template references, whether or not it resolves. */
export function referencedFields(template: string): string[] {
  const fields: string[] = [];
  for (const match of template.matchAll(FIELD)) {
    const key = match[1].trim();
    if (!fields.includes(key)) fields.push(key);
  }
  return fields;
}

/** Fields used only to switch a section on or off. */
export function sectionFields(template: string): string[] {
  const fields: string[] = [];
  for (const match of template.matchAll(/\{\{[#^]\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const key = match[1];
    if (!fields.includes(key)) fields.push(key);
  }
  return fields;
}

/**
 * Render subject and body together.
 *
 * They are reported as one unit because a message is only sendable when both
 * resolve, and Paul fixes them in the same edit.
 */
export function renderMessage(
  subjectTemplate: string,
  bodyTemplate: string,
  context: TemplateContext
): { ok: true; subject: string; body: string } | { ok: false; missing: string[] } {
  const subject = render(subjectTemplate, context);
  const body = render(bodyTemplate, context);

  if (!subject.ok || !body.ok) {
    const missing = [
      ...(subject.ok ? [] : subject.missing),
      ...(body.ok ? [] : body.missing),
    ];
    return { ok: false, missing: [...new Set(missing)] };
  }

  return { ok: true, subject: subject.text, body: body.text };
}
