export type SlackResult = { ok: true } | { ok: false; reason: string };

/**
 * Posts a message to the ops Slack channel via its incoming webhook.
 *
 * Carried over from paymentswithpaul's `lib/slack.ts`, same channel, same
 * contract: never throws. A Slack outage must not take down the worker that
 * is polling mailboxes and sending mail.
 */
export async function sendSlack(text: string): Promise<SlackResult> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { ok: false, reason: "SLACK_WEBHOOK_URL is not set" };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Unfurls off so a prospect's domain does not turn into a preview card.
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
