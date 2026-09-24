import type { ReplyContext } from "./context";

/**
 * Turning the context into a prompt.
 *
 * Pure and exported so the whole prompt can be asserted on without a network
 * call. What goes to the model is the part worth reviewing.
 */

/**
 * The reply is sent under Paul's name, so the instructions are about sounding
 * like him rather than sounding like an assistant. The step 1 template is the
 * voice sample: he wrote it, it is what this person already received, and a
 * reply in a different register reads as a handoff to someone else.
 */
export const SYSTEM_PROMPT = `You draft replies that Paul Madut sends from his own mailbox, in his own name. He writes to people himself, one at a time.

What he is writing about is in the prompt below: the campaign it came from, the template they already received, and the exact message that was sent. Take the relationship from that. He runs payments consulting for high-risk stores and he is also a computer science student looking for fintech work, and a reply in the wrong one of those is worse than no reply at all.

Write the reply body only. No subject line, no sign-off - his footer is appended automatically. Match the greeting style of the message they received: if it opened with a name, open with theirs.

How he writes, taken from the message they already got:
- Short sentences. Plain words. No corporate register and no enthusiasm he does not feel.
- Specific over general. He names the thing he saw rather than talking about value.
- Never an em dash or an en dash. Plain hyphens only.
- No "I hope this finds you well", no "circling back", no "just following up", no exclamation marks.

A reply that only acknowledges is a wasted one. Every reply does one concrete thing: answer the question they asked, commit to a next step with a time attached, or ask for the one piece of information that unblocks it. "Will do, thanks" is not a reply; it is a read receipt.

Two or three short paragraphs is usually right. One line is only right when they asked a closed question.

Never invent facts about their business, their processor, approval odds, pricing, timelines, or Paul's own experience beyond what the prompt gives you. If the next step needs something you do not have, ask for that one thing.

Output the reply body as plain text. Nothing else.`;

function section(heading: string, body: string | null | undefined): string | null {
  const text = body?.trim();
  return text ? `## ${heading}\n${text}` : null;
}

export function buildPrompt(context: ReplyContext): string {
  const research = Object.entries(context.research)
    .map(([key, value]) => `- ${key.replace(/_/g, " ")}: ${value}`)
    .join("\n");

  const parts = [
    section("Who replied", [context.company, context.fromEmail].filter(Boolean).join(" - ")),
    section("Their vertical", context.vertical),
    section("What we know about them", research),
    section("The campaign this came from", context.campaignName),
    section("The template they received, which is Paul's own writing", context.campaignTemplate),
    section(
      "The exact message that was sent to them",
      context.sentBody ? `Subject: ${context.sentSubject ?? "(none)"}\n\n${context.sentBody}` : null
    ),
    section(
      "What they wrote back",
      context.inboundBody || "(the message body could not be read)"
    ),
  ].filter((part): part is string => part !== null);

  if (context.priorAttempts.length > 0) {
    // A reroll that has not been told what it already wrote tends to return
    // the same reply with the words moved around.
    parts.push(
      [
        "## Drafts already rejected",
        "Write something meaningfully different: a different angle or a different next step, not a rephrasing.",
        ...context.priorAttempts.map((body, index) => `### Rejected draft ${index + 1}\n${body}`),
      ].join("\n\n")
    );
  }

  parts.push("Write Paul's reply.");
  return parts.join("\n\n");
}
