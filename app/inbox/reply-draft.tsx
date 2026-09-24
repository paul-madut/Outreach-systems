"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import type { LintFinding } from "@/lib/template/lint";
import { listSuggestionsAction, sendReplyAction, suggestReplyAction } from "../actions";
import { buttonClass } from "../ui";
import { cn } from "@/lib/utils";

/**
 * A drafted reply, and the option to ask for a different one.
 *
 * The draft is editable in place and never sends itself. Rerolling keeps the
 * earlier attempts, so going back to the first one is a matter of stepping
 * through them rather than regenerating and hoping.
 */

interface Attempt {
  attempt: number;
  body: string;
  findings: LintFinding[];
}

export function ReplyDraft({
  inboundId,
  toEmail,
  alreadySent,
}: {
  inboundId: number;
  toEmail: string;
  /** A reply already went to this message, so the box is read-only. */
  alreadySent?: boolean;
}) {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [shown, setShown] = useState(0);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState(Boolean(alreadySent));

  // Drafts outlive the page they were written on. Without this, a reload
  // hides work that is still in the database and the only way back to it is
  // to pay for it again.
  useEffect(() => {
    let live = true;
    void listSuggestionsAction(inboundId).then((stored) => {
      if (!live || stored.length === 0) return;
      setAttempts(stored.map((row) => ({ ...row, findings: [] })));
      setShown(stored.length - 1);
      setDraft(stored[stored.length - 1].body);
    });
    return () => {
      live = false;
    };
  }, [inboundId]);

  const generate = () =>
    startTransition(async () => {
      try {
        const next = await suggestReplyAction(inboundId);
        setAttempts((previous) => {
          const all = [...previous, next];
          setShown(all.length - 1);
          setDraft(next.body);
          return all;
        });
      } catch (error) {
        toast.error("Could not draft a reply", { description: (error as Error).message });
      }
    });

  if (attempts.length === 0) {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={generate}
        className={cn(buttonClass("secondary"), "ml-auto")}
      >
        {pending ? "Drafting..." : "Draft a reply"}
      </button>
    );
  }

  const current = attempts[shown];
  const blocking = current.findings.filter((finding) => finding.severity === "block");

  const send = () =>
    startTransition(async () => {
      try {
        const result = await sendReplyAction(inboundId, draft);
        setSent(true);
        setConfirming(false);
        toast.success("Reply sent", {
          description: `To ${result.to} from ${result.from}.`,
        });
      } catch (error) {
        setConfirming(false);
        toast.error("Not sent", { description: (error as Error).message });
      }
    });

  const step = (delta: number) => {
    const next = Math.min(attempts.length - 1, Math.max(0, shown + delta));
    setShown(next);
    setDraft(attempts[next].body);
  };

  return (
    <div className="mt-2 w-full rounded-sm border border-line bg-sunken p-2.5">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        readOnly={sent}
        rows={Math.min(16, Math.max(6, draft.split("\n").length + 1))}
        className={cn(
          "w-full resize-y rounded-sm border border-line bg-surface px-2.5 py-2",
          "font-mono text-[12px] leading-[1.65] text-ink",
          "focus:border-accent focus:outline-none"
        )}
      />

      {blocking.length > 0 && (
        <p className="mt-1.5 rounded-sm bg-danger-soft px-2 py-1 text-[11px] text-danger">
          {blocking.map((finding) => finding.message).join(" ")}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {/*
          Sending asks twice. It is the one control here that reaches a real
          person, and it cannot be taken back.
        */}
        {sent ? (
          <span className="text-[11px] text-ok">Sent. This thread is answered.</span>
        ) : confirming ? (
          <>
            <span className="text-[11px] text-warn">Send this to {toEmail}?</span>
            <button
              type="button"
              disabled={pending}
              onClick={send}
              className={buttonClass("primary")}
            >
              {pending ? "Sending..." : "Yes, send it"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={buttonClass("ghost")}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(true)}
            className={buttonClass("primary")}
          >
            Send
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(draft);
            toast.success("Copied", { description: "Paste it into your reply." });
          }}
          className={buttonClass("secondary")}
        >
          Copy
        </button>

        {!sent && (
          <button
            type="button"
            disabled={pending}
            onClick={generate}
            className={buttonClass("secondary")}
          >
            {pending ? "Rerolling..." : "Reroll"}
          </button>
        )}

        {attempts.length > 1 && (
          <span className="flex items-center gap-1 text-[11px] text-muted">
            <button
              type="button"
              disabled={shown === 0}
              onClick={() => step(-1)}
              className={buttonClass("ghost")}
            >
              &larr;
            </button>
            draft {current.attempt} of {attempts.length}
            <button
              type="button"
              disabled={shown === attempts.length - 1}
              onClick={() => step(1)}
              className={buttonClass("ghost")}
            >
              &rarr;
            </button>
          </span>
        )}

        <span className="ml-auto text-[11px] text-faint">
          {sent ? "Recorded, and the thread is marked handled." : "Edit it before you send."}
        </span>
      </div>
    </div>
  );
}
