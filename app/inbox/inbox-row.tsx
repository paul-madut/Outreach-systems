"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import type { InboxRow } from "@/lib/queries";
import { markInboundHandled } from "../actions";
import { STATUS, Card, StatusBadge, buttonClass, formatWhen } from "../ui";
import { ReplyDraft } from "./reply-draft";
import { cn } from "@/lib/utils";

/**
 * One thing that came back.
 *
 * The row says what the tool did about it, not just what it was. "Reply" is
 * a classification; "their sequence stopped" is the consequence, and the
 * consequence is what you need to know before deciding whether to step in.
 *
 * Only the kinds that need a person can be marked handled. An auto-reply was
 * filed and needs nothing, so offering a button for it would train you to
 * clear things without reading them.
 */
const NEEDS_A_PERSON = new Set(["reply", "unsubscribe", "unmatched"]);

/** Where drafting a reply makes sense. An opt-out gets silence, not a reply. */
const WORTH_REPLYING_TO = new Set(["reply", "unmatched"]);

export function InboxCard({ row, index }: { row: InboxRow; index: number }) {
  const [handled, setHandled] = useState(row.handled === 1);
  const [pending, startTransition] = useTransition();

  const meta = STATUS[row.classification];
  const actionable = NEEDS_A_PERSON.has(row.classification);

  return (
    <div className="rise" style={{ animationDelay: `${Math.min(index, 8) * 25}ms` }}>
      <Card
        className={cn(
          "px-4 py-3 transition-opacity duration-150",
          handled && "opacity-55"
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={row.classification} />
          {/*
            The company is only known when the message matched something we
            sent. Without it the address is the identity, so printing it as
            the title and again underneath just says it twice.
          */}
          {row.company ? (
            <>
              <span className="text-[13px] font-medium">{row.company}</span>
              <span className="font-mono text-[11px] text-muted">{row.fromEmail}</span>
            </>
          ) : (
            <span className="font-mono text-[12px] font-medium">{row.fromEmail}</span>
          )}
          <span className="nums ml-auto text-[11px] text-faint">
            {formatWhen(row.receivedAt)}
          </span>
        </div>

        {row.subject && <div className="mt-1.5 text-[13px]">{row.subject}</div>}

        {row.snippet && (
          <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap font-mono text-[12px] leading-[1.6] text-muted">
            {row.snippet}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-faint">
            {meta?.means ?? row.reason}
            {row.matchMethod && ` Matched on ${row.matchMethod.replace(/_/g, " ")}.`}
          </span>

          {actionable && (
            <button
              type="button"
              disabled={pending || handled}
              onClick={() => {
                setHandled(true);
                startTransition(async () => {
                  await markInboundHandled(row.id);
                  toast("Marked handled", {
                    description: "It stops counting against the Inbox badge.",
                  });
                });
              }}
              className={cn(buttonClass("ghost"), "ml-auto")}
            >
              {handled ? "Handled" : "Mark handled"}
            </button>
          )}
        </div>

        {/*
          Only where a person is actually going to write back. A bounce needs
          a suppression, not a reply, and an auto-reply needs nothing at all.
        */}
        {WORTH_REPLYING_TO.has(row.classification) && (
          <div className="mt-2 flex">
            <ReplyDraft
              inboundId={row.id}
              toEmail={row.fromEmail}
              alreadySent={row.replySent === 1}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
