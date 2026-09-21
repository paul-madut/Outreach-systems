"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CampaignDetail, CampaignSummary, MergeField } from "@/lib/queries";
import { setCampaignState } from "../../actions";
import { Card, LinkButton, Stat, StatusBadge, buttonClass, formatWhen } from "../../ui";
import { EnrollPanel } from "./enroll-panel";
import { SettingsPanel } from "./settings-panel";
import { StepsPanel } from "./steps-panel";
import { cn } from "@/lib/utils";

type Tab = "steps" | "enrol" | "settings";

/**
 * One campaign, and everything you can do to it.
 *
 * Three tabs in the order the work happens: write the emails, choose who gets
 * them, then adjust how they go out. The banner above says in one sentence
 * why the campaign is or is not sending, which is the question this page
 * exists to answer.
 */
export function CampaignTabs({
  campaign,
  summary,
  fields,
  nextSendAt,
}: {
  campaign: CampaignDetail;
  summary: CampaignSummary;
  fields: MergeField[];
  nextSendAt: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(campaign.steps.length === 0 ? "steps" : "enrol");
  const [pending, startTransition] = useTransition();

  const noSteps = campaign.steps.length === 0;

  // One sentence, ranked by what stops sending first.
  const blocker = noSteps
    ? "There are no steps, so there is nothing to send."
    : campaign.mailboxStatus === "paused"
      ? `${campaign.mailbox} is paused, so nothing goes out from it until you resume it in Settings.`
      : campaign.status === "draft"
        ? "This is still a draft. Approved messages will wait until you activate it."
        : campaign.status === "paused"
          ? "Paused. Everything approved stays where it is until you resume."
          : campaign.status === "archived"
            ? "Archived. It will not send anything else."
            : summary.enrolled === 0
              ? "Nobody is enrolled yet."
              : null;

  function setStatus(status: "active" | "paused") {
    startTransition(async () => {
      await setCampaignState(campaign.id, status);
      toast.success(status === "active" ? "Activated" : "Paused", {
        description:
          status === "active"
            ? `Approved messages send between ${campaign.windowStart} and ${campaign.windowEnd}.`
            : "Nothing more will go out until you resume it.",
      });
      router.refresh();
    });
  }

  const TABS: { id: Tab; label: string; hint: string }[] = [
    { id: "steps", label: "Emails", hint: "What gets sent" },
    { id: "enrol", label: "Prospects", hint: "Who gets it" },
    { id: "settings", label: "Settings", hint: "When and how" },
  ];

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <StatusBadge status={campaign.status} />
        <span className="text-[12px] text-muted">
          from <span className="font-mono">{campaign.mailboxEmail}</span> ·{" "}
          {campaign.windowStart} to {campaign.windowEnd} {campaign.timezone} ·{" "}
          {campaign.newPerDay} new a day
        </span>

        <div className="ml-auto flex items-center gap-2">
          {summary.drafts > 0 && (
            <LinkButton
              href={`/queue?campaign=${campaign.id}&status=draft`}
              variant="primary"
            >
              Review {summary.drafts}
            </LinkButton>
          )}

          {campaign.status === "active" ? (
            <button
              type="button"
              onClick={() => setStatus("paused")}
              disabled={pending}
              className={buttonClass("secondary")}
            >
              Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStatus("active")}
              disabled={pending || noSteps}
              title={noSteps ? "Write step 1 first." : undefined}
              className={cn(buttonClass("primary"), "active:scale-[0.97]")}
            >
              Activate
            </button>
          )}
        </div>
      </div>

      {blocker && (
        <p className="mb-5 rounded-md border border-line border-l-2 border-l-warn bg-surface px-4 py-3 text-[13px]">
          {blocker}
        </p>
      )}

      <Card className="mb-5 px-5 py-4">
        <div className="grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-6">
          <Stat label="enrolled" value={summary.enrolled} hint="Prospects in this sequence." />
          <Stat label="drafts" value={summary.drafts} hint="Waiting for you to approve." />
          <Stat label="queued" value={summary.scheduled} hint="Approved, waiting for its time." />
          <Stat label="sent" value={summary.sent} />
          <Stat
            label="replied"
            value={summary.replied}
            tone={summary.replied > 0 ? "ok" : undefined}
            hint="A human wrote back. Their follow-ups were cancelled."
          />
          <Stat
            label="bounced"
            value={summary.bounced}
            tone={summary.bounced > 0 ? "danger" : undefined}
          />
        </div>
        {nextSendAt && (
          <p className="mt-3 border-t border-line pt-2.5 text-[11px] text-muted">
            Next one goes out {formatWhen(nextSendAt)}.
          </p>
        )}
      </Card>

      <div className="mb-5 flex gap-1 border-b border-line">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={cn(
              "group relative px-3 py-2 text-[13px]",
              "transition-colors duration-150 ease-[var(--ease-out-quick)]",
              tab === entry.id ? "text-ink" : "text-muted hover:text-ink"
            )}
          >
            {entry.label}
            <span className="ml-1.5 text-[11px] text-faint">{entry.hint}</span>
            {tab === entry.id && (
              <span className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent" />
            )}
          </button>
        ))}
      </div>

      <div key={tab} className="rise">
        {tab === "steps" && <StepsPanel campaign={campaign} fields={fields} />}
        {tab === "enrol" && (
          <EnrollPanel
            campaignId={campaign.id}
            canSend={!noSteps}
            blocker={
              noSteps
                ? "Write step 1 first. There is nothing to enrol anybody into yet."
                : null
            }
          />
        )}
        {tab === "settings" && <SettingsPanel campaign={campaign} />}
      </div>
    </>
  );
}
