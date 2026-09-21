"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CampaignDetail } from "@/lib/queries";
import { setCampaignState, updateCampaignAction } from "../../actions";
import { Card, buttonClass } from "../../ui";
import { DayPicker, Field, inputClass } from "../form-bits";
import { cn } from "@/lib/utils";

/**
 * Changing how a campaign sends, after it exists.
 *
 * The window and the daily count only affect messages that have not been
 * slotted yet. Anything already scheduled keeps the time it was given, which
 * the panel says outright, because silently leaving a hundred messages on the
 * old schedule would be the kind of surprise that costs trust in the tool.
 */
export function SettingsPanel({ campaign }: { campaign: CampaignDetail }) {
  const router = useRouter();
  const [name, setName] = useState(campaign.name);
  const [description, setDescription] = useState(campaign.description ?? "");
  const [windowStart, setWindowStart] = useState(campaign.windowStart);
  const [windowEnd, setWindowEnd] = useState(campaign.windowEnd);
  const [sendDays, setSendDays] = useState(campaign.sendDays);
  const [newPerDay, setNewPerDay] = useState(campaign.newPerDay);
  const [footer, setFooter] = useState(campaign.footerTemplate ?? "");
  const [pending, startTransition] = useTransition();

  const windowValid = windowStart < windowEnd;
  const dirty =
    name !== campaign.name ||
    description !== (campaign.description ?? "") ||
    windowStart !== campaign.windowStart ||
    windowEnd !== campaign.windowEnd ||
    newPerDay !== campaign.newPerDay ||
    footer !== (campaign.footerTemplate ?? "") ||
    sendDays.join() !== campaign.sendDays.join();

  function save() {
    startTransition(async () => {
      try {
        await updateCampaignAction({
          campaignId: campaign.id,
          name: name.trim(),
          description: description.trim(),
          windowStart,
          windowEnd,
          sendDays,
          newPerDay,
          footer: footer.trim(),
        });
        toast.success("Saved", {
          description: "Applies to prospects enrolled from now on.",
        });
        router.refresh();
      } catch (error) {
        toast.error("Not saved", { description: (error as Error).message });
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Card className="space-y-4 p-4">
        <h2 className="text-[12px] uppercase tracking-wide text-faint">Name</h2>

        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Note" hint="Optional. What this campaign is for.">
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className={inputClass}
          />
        </Field>
      </Card>

      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-[12px] uppercase tracking-wide text-faint">When it sends</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            Times are {campaign.timezone}. Changing these does not move anything already
            scheduled, only what gets slotted next.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="From">
            <input
              type="time"
              value={windowStart}
              onChange={(event) => setWindowStart(event.target.value)}
              className={cn(inputClass, "nums")}
            />
          </Field>
          <Field label="Until">
            <input
              type="time"
              value={windowEnd}
              onChange={(event) => setWindowEnd(event.target.value)}
              className={cn(inputClass, "nums", !windowValid && "border-danger")}
            />
          </Field>
          <Field
            label="New prospects a day"
            hint={`${campaign.mailbox} caps everything at ${campaign.dailyCap}.`}
          >
            <input
              type="number"
              min={1}
              value={newPerDay}
              onChange={(event) => setNewPerDay(Math.max(1, Number(event.target.value) || 1))}
              className={cn(inputClass, "nums")}
            />
          </Field>
        </div>

        {!windowValid && (
          <p className="rounded-sm bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">
            The end of the window has to be after the start.
          </p>
        )}

        <Field label="Days">
          <DayPicker value={sendDays} onChange={setSendDays} />
        </Field>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="text-[12px] uppercase tracking-wide text-faint">Footer</h2>
        <Field
          label="Added to the bottom of every email"
          hint="This carries the opt-out line. It is excluded from the word count."
        >
          <textarea
            value={footer}
            onChange={(event) => setFooter(event.target.value)}
            rows={4}
            className={cn(inputClass, "resize-y font-mono text-[12px]")}
          />
        </Field>
      </Card>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty || !windowValid}
          className={cn(buttonClass("primary", "md"), "active:scale-[0.97]")}
        >
          {pending ? "Saving..." : "Save changes"}
        </button>
        {dirty && <span className="text-[12px] text-muted">Unsaved changes.</span>}
      </div>

      <Card className="p-4">
        <h2 className="text-[12px] uppercase tracking-wide text-faint">Archive</h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
          Archiving hides the campaign and stops it sending. Everything it has already sent, and
          every reply to it, is kept.
        </p>
        <button
          type="button"
          disabled={pending || campaign.status === "archived"}
          onClick={() =>
            startTransition(async () => {
              await setCampaignState(campaign.id, "archived");
              toast("Archived", { description: "It will not send anything else." });
              router.refresh();
            })
          }
          className={cn(buttonClass("secondary"), "mt-3")}
        >
          {campaign.status === "archived" ? "Already archived" : "Archive this campaign"}
        </button>
      </Card>
    </div>
  );
}
