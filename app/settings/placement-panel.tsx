"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { PlacementReport } from "@/lib/mail/placement";
import { warnings } from "@/lib/mail/placement";
import {
  closePlacementTestAction,
  refreshPlacementTest,
  startPlacementTest,
} from "../actions";
import { Badge, buttonClass, formatWhen, type Tone } from "../ui";
import { cn } from "@/lib/utils";

/**
 * Running a placement test from the interface.
 *
 * The send and the wait are separate calls, so no request is held open for
 * the minutes a message can take to arrive. Once a test is running this polls
 * every fifteen seconds and stops on its own when every seed has reported or
 * the window closes, because a spinner nobody ever looks at again is how a
 * test ends up recorded as missing when it actually landed.
 */

const WINDOW_MS = 4 * 60 * 1000;
const POLL_MS = 15_000;

export interface PlacementCampaign {
  id: number;
  name: string;
}

const PLACEMENT_TONE: Record<string, Tone> = {
  inbox: "ok",
  spam: "danger",
  missing: "warn",
};

export function PlacementPanel({
  mailboxes,
  campaigns,
  seedCount,
  lastPlacement,
}: {
  mailboxes: { id: number; label: string; from_email: string }[];
  campaigns: PlacementCampaign[];
  seedCount: number;
  /** The most recent finished test per mailbox, shown until a new one runs. */
  lastPlacement: Record<number, { report: PlacementReport; when: string | null }>;
}) {
  const router = useRouter();
  const [mailboxId, setMailboxId] = useState(mailboxes[0]?.id ?? 0);
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? 0);
  const [testId, setTestId] = useState<number | null>(null);
  const [report, setReport] = useState<PlacementReport | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [pending, startTransition] = useTransition();
  const startedAt = useRef(0);

  useEffect(() => {
    if (!waiting || testId === null) return;

    const timer = setInterval(async () => {
      const { outstanding, report: next } = await refreshPlacementTest(testId);
      setReport(next);

      if (outstanding === 0) {
        setWaiting(false);
        router.refresh();
        return;
      }

      if (Date.now() - startedAt.current > WINDOW_MS) {
        await closePlacementTestAction(testId);
        const closed = await refreshPlacementTest(testId);
        setReport(closed.report);
        setWaiting(false);
        router.refresh();
      }
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [waiting, testId, router]);

  if (mailboxes.length === 0 || campaigns.length === 0) return null;

  const blocked = seedCount === 0;

  // A live run wins. Otherwise fall back to whatever this mailbox last did,
  // which is the answer somebody reopening this page came for.
  const stored = lastPlacement[mailboxId];
  const shown = report
    ? { report, when: null }
    : stored
      ? { report: stored.report, when: stored.when }
      : null;

  return (
    <div className="px-4 pb-4">
      <p className="mb-3 max-w-2xl text-[13px] text-muted">
        Sends one real message - a live template rendered against a real contact, footer and all
        - from a mailbox to every seed inbox, then reads which folder it landed in and what the
        receiving provider concluded about SPF, DKIM and DMARC. It goes out whether or not live
        sending is on, because it only ever writes to your own seeds.
      </p>

      {blocked ? (
        <div className="text-[13px] text-muted">
          No seed inboxes yet. A seed is a mailbox you own that only receives.
          <code className="mt-2 block w-fit rounded-sm bg-sunken px-2 py-1 font-mono text-[11px]">
            pnpm placement seed-add --label gmail --email you@gmail.com --provider gmail
            --keychain-service gmail-imap-seed
          </code>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={mailboxId}
            onChange={(event) => setMailboxId(Number(event.target.value))}
            className={selectClass}
          >
            {mailboxes.map((mailbox) => (
              <option key={mailbox.id} value={mailbox.id}>
                {mailbox.label}
              </option>
            ))}
          </select>

          <span className="text-[12px] text-faint">sending</span>

          <select
            value={campaignId}
            onChange={(event) => setCampaignId(Number(event.target.value))}
            className={selectClass}
          >
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={pending || waiting}
            onClick={() =>
              startTransition(async () => {
                try {
                  const started = await startPlacementTest(mailboxId, campaignId);
                  setTestId(started.testId);
                  setReport(null);
                  startedAt.current = Date.now();
                  setWaiting(true);
                  toast.success("Sent", {
                    description: `"${started.subject}", rendered against ${started.renderedFor}.`,
                  });
                } catch (error) {
                  toast.error("Could not send", {
                    description: (error as Error).message,
                  });
                }
              })
            }
            className={buttonClass("primary")}
          >
            {waiting ? "Waiting for delivery..." : pending ? "Sending..." : "Run placement test"}
          </button>

          {waiting && (
            <button
              type="button"
              onClick={() =>
                startTransition(async () => {
                  if (testId === null) return;
                  await closePlacementTestAction(testId);
                  setReport((await refreshPlacementTest(testId)).report);
                  setWaiting(false);
                  router.refresh();
                })
              }
              className={buttonClass("ghost")}
            >
              Stop waiting
            </button>
          )}
        </div>
      )}

      {shown && <Report report={shown.report} waiting={waiting} when={shown.when} />}
    </div>
  );
}

const selectClass = cn(
  "h-7 rounded-sm border border-line-strong bg-surface px-2 text-[12px] text-ink",
  "focus:border-accent focus:outline-none"
);

function Report({
  report,
  waiting,
  when,
}: {
  report: PlacementReport;
  waiting: boolean;
  when: string | null;
}) {
  const lines = waiting ? [] : warnings(report);

  return (
    <div className="mt-4 border-t border-line pt-3">
      {when && (
        <p className="mb-1.5 text-[11px] text-faint">Last tested {formatWhen(when)}</p>
      )}
      {report.outcomes.map((outcome) => {
        // While the window is open, nothing has failed yet - it just has not
        // shown up. Calling that "missing" before the deadline would read as a
        // delivery failure that has not happened.
        const settled = !waiting || outcome.folder !== null;
        const tone: Tone = settled ? PLACEMENT_TONE[outcome.placement] : "neutral";

        return (
          <div
            key={outcome.seedEmail}
            className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 py-1.5"
          >
            <Badge tone={tone}>{settled ? outcome.placement : "in flight"}</Badge>
            <span className="text-[13px] text-ink">{outcome.seedLabel}</span>
            {/* "inbox INBOX" says one thing twice. The folder only earns its
                own slot when it is not simply the placement's own name. */}
            {outcome.folder && outcome.folder.toLowerCase() !== outcome.placement && (
              <span className="font-mono text-[11px] text-faint">{outcome.folder}</span>
            )}
            {outcome.deliverySeconds !== null && (
              <span className="text-[11px] text-faint">{outcome.deliverySeconds}s</span>
            )}
            {outcome.auth?.present && (
              <span className="text-[11px] text-muted">
                spf {outcome.auth.spf} &middot; dkim {outcome.auth.dkim} &middot; dmarc{" "}
                {outcome.auth.dmarc}
                {outcome.auth.verifier && ` (per ${outcome.auth.verifier})`}
              </span>
            )}
          </div>
        );
      })}

      {lines.map((line) => (
        <p key={line} className="mt-2 rounded-sm bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
          {line}
        </p>
      ))}
    </div>
  );
}
