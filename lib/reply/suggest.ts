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

/**
 * The only models allowed to draft a message.
 *
 * Paul's rule, kept in code rather than in a habit. Drafting a reply is a
 * small, well-scoped job against context that is already assembled, so the
 * larger models buy nothing here and cost real money per reroll.
 */
export const REPLY_MODELS = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
} as const;

export type ReplyModelName = keyof typeof REPLY_MODELS;

const DEFAULT_MODEL: ReplyModelName = "sonnet";
const MAX_TOKENS = 1024;

export class DisallowedModelError extends Error {
  constructor(requested: string) {
    super(
      `REPLY_MODEL is "${requested}". Only ${Object.keys(REPLY_MODELS).join(" or ")} may draft messages.`
    );
  }
}

/**
 * Resolve REPLY_MODEL to an id, refusing anything outside the allowlist.
 *
 * Accepts either the short name or the full id, and throws rather than
 * silently falling back, because a typo quietly reverting to the default is
 * how a setting stops meaning anything.
 */
export function resolveModel(requested = process.env.REPLY_MODEL): string {
  const name = requested?.trim();
  if (!name) return REPLY_MODELS[DEFAULT_MODEL];

  if (name in REPLY_MODELS) return REPLY_MODELS[name as ReplyModelName];
  if ((Object.values(REPLY_MODELS) as string[]).includes(name)) return name;

  throw new DisallowedModelError(name);
}

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

  const model = resolveModel();
  const context = buildReplyContext(db, inboundId);

  // An API key that is not scoped to a workspace has to name one per request.
  // Optional, because a workspace-scoped key carries it already.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  const client = new Anthropic({
    apiKey,
    ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}),
  });

  const response = await readableErrors(() =>
    client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPrompt(context) }],
    })
  );

  const body = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!body) throw new Error("The model returned nothing.");

  const attempt = context.priorAttempts.length + 1;

  db.prepare(
    "insert into reply_suggestions (inbound_id, attempt, body, model) values (?, ?, ?, ?)"
  ).run(inboundId, attempt, body, model);

  // Run the draft through the same linter as any outgoing message. An em dash
  // from a model is exactly as unwelcome as one from a template.
  return { attempt, body, model, findings: lintMessage("", body) };
}

/**
 * Turn an SDK error into one sentence.
 *
 * The raw errors arrive as a wall of JSON with a stack attached, which lands
 * in a toast as noise. The two that actually happen in practice are a key
 * that names no workspace and a key that is wrong, and both have a fix worth
 * stating.
 */
async function readableErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("anthropic-workspace-id")) {
      throw new Error(
        "That API key is not scoped to a workspace. Either set ANTHROPIC_WORKSPACE_ID, or make a workspace-scoped key in the console.",
        { cause: error }
      );
    }
    if (message.includes("authentication_error") || message.includes("401")) {
      throw new Error("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.", {
        cause: error,
      });
    }
    if (message.includes("rate_limit") || message.includes("429")) {
      throw new Error("Anthropic rate limit hit. Try the reroll again in a moment.", {
        cause: error,
      });
    }
    if (message.includes("credit") || message.includes("billing")) {
      throw new Error("The Anthropic account has no credit. Top it up in the console.", {
        cause: error,
      });
    }

    throw new Error(message.split("\n")[0].slice(0, 300), { cause: error });
  }
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
