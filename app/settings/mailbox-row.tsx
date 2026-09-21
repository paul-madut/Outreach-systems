"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setMailbox } from "../actions";
import { buttonClass } from "../ui";
import { cn } from "@/lib/utils";

/**
 * Pausing and resuming a mailbox.
 *
 * The health bar tells you a paused mailbox is resumed here, so here is where
 * the button has to be. Pausing asks for a reason, because a mailbox found
 * paused a week later with no note is a mystery that gets resolved by
 * resuming it blindly, which is the opposite of what pausing was for.
 */
export function MailboxControls({
  mailboxId,
  status,
}: {
  mailboxId: number;
  status: string;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  if (status === "paused") {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await setMailbox(mailboxId, "active", null);
            toast.success("Resumed", { description: "Anything due will go out on the next run." });
            router.refresh();
          })
        }
        className={buttonClass("primary")}
      >
        {pending ? "Resuming..." : "Resume"}
      </button>
    );
  }

  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className={buttonClass("secondary")}
      >
        Pause
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why?"
        autoFocus
        onKeyDown={(event) => event.key === "Escape" && setAsking(false)}
        className={cn(
          "w-36 rounded-sm border border-line bg-surface px-2 py-1 text-[12px]",
          "focus:border-accent focus:outline-none"
        )}
      />
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await setMailbox(mailboxId, "paused", reason.trim() || "Paused by hand");
            toast("Paused", { description: "Nothing will send from it." });
            setAsking(false);
            router.refresh();
          })
        }
        className={buttonClass("secondary")}
      >
        {pending ? "..." : "Pause"}
      </button>
      <button type="button" onClick={() => setAsking(false)} className={buttonClass("ghost")}>
        Esc
      </button>
    </div>
  );
}
