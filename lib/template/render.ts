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

  const text = template.replace(FIELD, (_match, rawKey: string, fallback?: string) => {
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
  return { ok: true, text };
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
