import Link from "next/link";
import { getDb } from "@/lib/db";
import { listCampaigns } from "@/lib/queries";
import { Badge, Card, Empty, PageHeading, Stat, StatusBadge, formatWhen } from "./ui";

export const dynamic = "force-dynamic";

export default function CampaignsPage() {
  const campaigns = listCampaigns(getDb());

  return (
    <>
      <PageHeading
        title="Campaigns"
        subtitle="Each one sends from a single mailbox. The mailbox owns the daily cap."
      />

      {campaigns.length === 0 ? (
        <Empty
          title="No campaigns yet."
          hint="Import a sheet with pnpm import:csv, then add a mailbox and a campaign from Settings."
        />
      ) : (
        <div className="space-y-3">
          {campaigns.map((campaign) => (
            <Card key={campaign.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/queue?campaign=${campaign.id}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {campaign.name}
                    </Link>
                    <StatusBadge status={campaign.status} />
                    {campaign.mailboxStatus === "paused" && (
                      <Badge tone="warn">mailbox paused</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    sends from {campaign.mailbox}
                    {campaign.nextSendAt && ` · next ${formatWhen(campaign.nextSendAt)}`}
                  </p>
                </div>

                {campaign.drafts > 0 && (
                  <Link
                    href={`/queue?campaign=${campaign.id}&status=draft`}
                    className="rounded border border-line-strong px-2.5 py-1 text-xs hover:bg-raised"
                  >
                    Review {campaign.drafts} draft{campaign.drafts === 1 ? "" : "s"}
                  </Link>
                )}
              </div>

              <div className="mt-4 grid grid-cols-3 gap-4 sm:grid-cols-6">
                <Stat label="enrolled" value={campaign.enrolled} />
                <Stat label="scheduled" value={campaign.scheduled} />
                <Stat label="sent" value={campaign.sent} />
                <Stat label="replied" value={campaign.replied} />
                <Stat label="bounced" value={campaign.bounced} tone={campaign.bounced ? "danger" : undefined} />
                <Stat
                  label="needs a look"
                  value={campaign.uncertain + campaign.failed}
                  tone={campaign.uncertain + campaign.failed ? "warn" : undefined}
                />
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
