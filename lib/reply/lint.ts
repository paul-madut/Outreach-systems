import { lintMessage, type LintFinding } from "@/lib/template/lint";

/**
 * The content checks that apply to a reply.
 *
 * The same linter every outgoing message passes, minus the subject rules: a
 * reply carries no subject of its own, so `empty-subject` is noise reported
 * as a blocker. Shared rather than repeated, because the filter was written
 * twice and forgotten once.
 */
export function lintReplyBody(body: string): LintFinding[] {
  return lintMessage("", body).filter((finding) => finding.rule !== "empty-subject");
}
