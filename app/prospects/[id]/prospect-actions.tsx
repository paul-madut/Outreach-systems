"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { clearHold } from "../../actions";
import { Card, buttonClass } from "../../ui";
import { cn } from "@/lib/utils";

/**
 * A hold is a flag set during research: "check this before contacting".
 *
 * It blocks enrollment, and until now the only way to release one was SQL.
 * Clearing it is a judgement, so the reason stays on screen while the button
 * is pressed rather than being replaced by a confirmation.
 */
export function HoldBanner({
  prospectId,
  reason,
}: {
  prospectId: number;
  reason: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Card className="mb-4 flex flex-wrap items-start gap-4 border-l-2 border-l-warn px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-warn">On hold, so it cannot be enrolled.</p>
        <p className="mt-0.5 text-[13px] text-muted">{reason}</p>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await clearHold(prospectId);
            toast.success("Hold cleared", { description: "It can be enrolled now." });
            router.refresh();
          })
        }
        className={cn(buttonClass("secondary"), "shrink-0")}
      >
        {pending ? "Clearing..." : "Clear the hold"}
      </button>
    </Card>
  );
}

/**
 * The imported columns, each labelled with the token that reads it.
 *
 * This is where you find out that a column called "Verbatim quote (the hook)"
 * is written {{verbatim_quote_the_hook}}. Clicking copies the token, because
 * transcribing it by hand is how a typo ends up in every message at once.
 */
export function ResearchFields({
  entries,
}: {
  entries: { key: string; label: string; value: string }[];
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(key: string) {
    try {
      await navigator.clipboard.writeText(`{{${key}}}`);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
    } catch {
      // Clipboard access can be refused; the token is on screen either way.
    }
  }

  return (
    <dl className="space-y-3">
      {entries.map((entry) => (
        <div key={entry.key}>
          <dt className="flex items-baseline gap-2">
            <span className="text-[11px] text-muted">{entry.label}</span>
            <button
              type="button"
              onClick={() => copy(entry.key)}
              title="Copy the merge field"
              className="font-mono text-[10px] text-faint transition-colors hover:text-accent"
            >
              {copied === entry.key ? "copied" : `{{${entry.key}}}`}
            </button>
          </dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed">
            {entry.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
