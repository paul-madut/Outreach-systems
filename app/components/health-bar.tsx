"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import type { HealthStatus } from "@/lib/queries";
import { runWorkerNow } from "../actions";
import { Dot, buttonClass, timeAgo } from "../ui";
import { cn } from "@/lib/utils";

/**
 * Is this thing running, and is anything wrong.
 *
 * A worker that has quietly died looks exactly like a quiet day, which is the
 * single most dangerous failure this tool has: you believe email is going out
 * and it is not. So the last send and the last poll are always on screen, and
 * they turn amber when they are older than the schedule should allow.
 *
 * The Run now button is here rather than buried in settings because "make it
 * go" is the first thing anyone tries when they suspect nothing is happening.
 */
export function HealthBar({ health }: { health: HealthStatus }) {
  const [pending, startTransition] = useTransition();

  const sendAge = ageInMinutes(health.lastSendAt);
  const pollAge = ageInMinutes(health.lastPollAt);

  // The launchd job runs every ten minutes, so a gap much wider than that
  // while work is waiting means it is not running.
  const sendStale = health.dueNow > 0 && (sendAge === null || sendAge > 25);
  const pollStale = health.lastSendAt !== null && (pollAge === null || pollAge > 60);

  function runNow() {
    startTransition(async () => {
      const promise = runWorkerNow();
      toast.promise(promise, {
        loading: "Running the worker...",
        success: (result) =>
          result.live
            ? `Sent ${result.sent}, ${result.replies} came back.`
            : `Dry run: ${result.claimed} would have sent. Set OUTREACH_LIVE=1 to send for real.`,
        error: (error) => `Worker failed: ${(error as Error).message}`,
      });
    });
  }

  return (
    <div className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-1.5 px-5 py-2">
        <Metric
          label="last send"
          value={timeAgo(health.lastSendAt)}
          stale={sendStale}
          hint={
            sendStale
              ? "Work is due but nothing has sent recently. The worker may not be running."
              : "When a message last left the mailbox."
          }
        />
        <Metric
          label="last check for replies"
          value={timeAgo(health.lastPollAt)}
          stale={pollStale}
          hint={
            pollStale
              ? "The inbox has not been read in a while, so replies may not have stopped their sequences yet."
              : "When the mailbox was last read."
          }
        />
        <Metric label="due now" value={String(health.dueNow)} hint="Approved and past its send time." />
        <Metric label="queued" value={String(health.scheduled)} hint="Approved, waiting for its time." />

        <button
          type="button"
          onClick={runNow}
          disabled={pending}
          className={cn(buttonClass("secondary"), "ml-auto")}
          title="Send anything due, then read the mailbox for replies"
        >
          {pending ? "Running..." : "Run now"}
        </button>
      </div>

      {health.pausedMailboxes.length > 0 && (
        <div className="border-t border-line bg-warn-soft">
          <div className="mx-auto max-w-6xl px-5 py-2 text-xs text-warn">
            {health.pausedMailboxes.map((mailbox) => (
              <div key={mailbox.label}>
                <strong className="font-medium">{mailbox.label} is paused.</strong>{" "}
                {mailbox.reason} Nothing will send from it until you resume it in Settings.
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  stale,
}: {
  label: string;
  value: string;
  hint: string;
  stale?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted" title={hint}>
      {stale && <Dot tone="warn" />}
      {label}
      <span className={cn("nums text-[11px]", stale ? "text-warn" : "text-ink")}>{value}</span>
    </span>
  );
}

function ageInMinutes(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}
