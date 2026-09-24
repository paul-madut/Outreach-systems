import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@/lib/db";
import { lintMessage, type LintFinding } from "@/lib/template/lint";
import { buildReplyContext } from "./context";
import { buildPrompt, SYSTEM_PROMPT } from "./prompt";

/**
 * Drafting a reply with Claude.
 *
 * The draft is a starting point, never something that sends itself. It is
 * stored, shown, and edited by a person before it goes anywhere - the tool's
 * rule about never sending a message it is not certain it should send applies
 * with more force to text a model wrote.
 */

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;

export class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set, so replies cannot be drafted.");
  }
}

export interface Suggestion {
  attempt: number;
  body: string;
  model: string;
  /** The same content checks every outgoing message gets, run on the draft. */
  findings: LintFinding[];
}

export async function suggestReply(db: Db, inboundId: number): Promise<Suggestion> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();

  const context = buildReplyContext(db, inboundId);
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPrompt(context) }],
  });

  const body = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!body) throw new Error("The model returned nothing.");

  const attempt = context.priorAttempts.length + 1;

  db.prepare(
    "insert into reply_suggestions (inbound_id, attempt, body, model) values (?, ?, ?, ?)"
  ).run(inboundId, attempt, body, MODEL);

  // Run the draft through the same linter as any outgoing message. An em dash
  // from a model is exactly as unwelcome as one from a template.
  return { attempt, body, model: MODEL, findings: lintMessage("", body) };
}

export interface StoredSuggestion {
  attempt: number;
  body: string;
  model: string;
  created_at: string;
}

/** Every draft written for a message, oldest first. */
export function listSuggestions(db: Db, inboundId: number): StoredSuggestion[] {
  return db
    .prepare(
      "select attempt, body, model, created_at from reply_suggestions where inbound_id = ? order by attempt"
    )
    .all(inboundId) as StoredSuggestion[];
}
