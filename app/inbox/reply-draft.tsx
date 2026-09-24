"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import type { LintFinding } from "@/lib/template/lint";
import { suggestReplyAction } from "../actions";
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

export function ReplyDraft({ inboundId }: { inboundId: number }) {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [shown, setShown] = useState(0);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();

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
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(draft);
            toast.success("Copied", { description: "Paste it into your reply." });
          }}
          className={buttonClass("primary")}
        >
          Copy
        </button>

        <button
          type="button"
          disabled={pending}
          onClick={generate}
          className={buttonClass("secondary")}
        >
          {pending ? "Rerolling..." : "Reroll"}
        </button>

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
          Edit it before you send. Nothing here sends itself.
        </span>
      </div>
    </div>
  );
}
