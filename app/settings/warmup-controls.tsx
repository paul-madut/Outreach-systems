"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setWarmup } from "../actions";
import { buttonClass } from "../ui";
import { cn } from "@/lib/utils";

/**
 * Setting a mailbox's ramp from the dashboard.
 *
 * A new domain that opens at its full daily cap is the fastest way to burn it,
 * and until now the ramp could only be set from the command line. The number
 * on this page was one nobody could change from this page.
 */

const field = cn(
  "w-16 rounded-sm border border-line bg-surface px-1.5 py-1 text-[12px] tabular-nums",
  "focus:border-accent focus:outline-none"
);

export function WarmupControls({
  mailboxId,
  startOn,
  startCap,
  dailyIncrement,
  ceiling,
}: {
  mailboxId: number;
  startOn: string | null;
  startCap: number;
  dailyIncrement: number;
  ceiling: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [start, setStart] = useState(startOn ?? new Date().toISOString().slice(0, 10));
  const [from, setFrom] = useState(String(startCap));
  const [step, setStep] = useState(String(dailyIncrement));

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass("ghost")}>
        {startOn ? "Edit ramp" : "Add ramp"}
      </button>
    );
  }

  const save = (settings: Parameters<typeof setWarmup>[1]) =>
    startTransition(async () => {
      try {
        await setWarmup(mailboxId, settings);
        toast.success(settings ? "Ramp set" : "Ramp removed", {
          description: settings
            ? `Starts at ${settings.startCap} a day, up ${settings.dailyIncrement} a day to ${ceiling}.`
            : `This mailbox now sends at its full ${ceiling} a day.`,
        });
        setOpen(false);
        router.refresh();
      } catch (error) {
        toast.error("Could not save", { description: (error as Error).message });
      }
    });

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        <label className="flex items-center gap-1">
          day 1 cap
          <input
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            inputMode="numeric"
            className={field}
          />
        </label>
        <label className="flex items-center gap-1">
          then +
          <input
            value={step}
            onChange={(event) => setStep(event.target.value)}
            inputMode="numeric"
            className={field}
          />
          a day
        </label>
      </div>

      <label className="flex items-center gap-1 text-[11px] text-muted">
        starting
        <input
          type="date"
          value={start}
          onChange={(event) => setStart(event.target.value)}
          className={cn(field, "w-[8.5rem]")}
        />
      </label>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            save({ startOn: start, startCap: Number(from), dailyIncrement: Number(step) })
          }
          className={buttonClass("primary")}
        >
          {pending ? "..." : "Save"}
        </button>
        {startOn && (
          <button
            type="button"
            disabled={pending}
            onClick={() => save(null)}
            className={buttonClass("danger")}
          >
            Remove
          </button>
        )}
        <button type="button" onClick={() => setOpen(false)} className={buttonClass("ghost")}>
          Cancel
        </button>
      </div>
    </div>
  );
}
