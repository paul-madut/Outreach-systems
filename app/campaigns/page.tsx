import Link from "next/link";
import { getDb } from "@/lib/db";
import { listCampaigns, listMailboxes, getCampaignDetail } from "@/lib/queries";
import { Badge, Card, Empty, LinkButton, PageHeading, Stat, StatusBadge, formatWhen } from "../ui";

export const dynamic = "force-dynamic";

/**
 * Every campaign, with the thing that is wrong with it stated on its face.
 *
 * A campaign can be perfectly valid and still send nothing: it is in draft, or
 * its mailbox is paused, or it has no step 1. Those are the three questions
 * that otherwise take a support conversation, so each one is answered here
 * rather than left to be inferred from a status word.
 */
export default function CampaignsPage() {
  const db = getDb();
  const campaigns = listCampaigns(db);
  const mailboxes = listMailboxes(db);
  const details = new Map(campaigns.map((c) => [c.id, getCampaignDetail(db, c.id)]));

  return (
    <>
      <PageHeading
        title="Campaigns"
        subtitle="A campaign is up to three emails, sent from one mailbox, to prospects you choose."
        right={
          mailboxes.length > 0 ? (
            <LinkButton href="/campaigns/new" variant="primary" size="md">
              New campaign
            </LinkButton>
          ) : undefined
        }
      />

      {campaigns.length === 0 ? (
        <Empty
          title="No campaigns yet."
          hint={
            mailboxes.length > 0
              ? "Creating one takes a name, a mailbox, and the first email. You can change all of it afterwards."
              : "Add a mailbox first. Nothing can send without one."
          }
          action={
            mailboxes.length > 0 ? (
              <LinkButton href="/campaigns/new" variant="primary" size="md">
                Create the first one
              </LinkButton>
            ) : (
              <LinkButton href="/settings" size="md">
                Go to settings
              </LinkButton>
            )
          }
          command={
            mailboxes.length === 0
              ? 'pnpm mailbox add --label payments --provider icloud --from "You <you@icloud.com>"'
              : undefined
          }
        />
      ) : (
        <div className="space-y-2.5">
          {campaigns.map((campaign, index) => {
            const detail = details.get(campaign.id);
            const steps = detail?.steps.length ?? 0;

            // Ranked by what blocks sending soonest, so only the first is shown.
            const blocker =
              steps === 0
                ? "No steps written yet, so there is nothing to send."
                : campaign.mailboxStatus === "paused"
                  ? `${campaign.mailbox} is paused, so nothing goes out from it.`
                  : campaign.status === "draft"
                    ? "Still a draft. Activate it when you are ready for it to send."
                    : campaign.status === "paused"
                      ? "Paused. Approved messages stay put until you resume it."
                      : campaign.enrolled === 0
                        ? "Nobody is enrolled yet."
                        : null;

            return (
              <div
                key={campaign.id}
                className="rise"
                style={{ animationDelay: `${Math.min(index, 6) * 30}ms` }}
              >
                <Card interactive className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/campaigns/${campaign.id}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {campaign.name}
                        </Link>
                        <StatusBadge status={campaign.status} />
                        <Badge>{steps === 1 ? "1 step" : `${steps} steps`}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        from <span className="font-mono">{campaign.mailbox}</span>
                        {detail && ` · ${detail.windowStart} to ${detail.windowEnd}`}
                        {detail && ` · up to ${detail.newPerDay} new a day`}
                        {campaign.nextSendAt && ` · next ${formatWhen(campaign.nextSendAt)}`}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {campaign.drafts > 0 && (
                        <LinkButton
                          href={`/queue?campaign=${campaign.id}&status=draft`}
                          variant="primary"
                        >
                          Review {campaign.drafts}
                        </LinkButton>
                      )}
                      <LinkButton href={`/campaigns/${campaign.id}`}>Open</LinkButton>
                    </div>
                  </div>

                  {blocker && (
                    <p className="mt-3 rounded-sm bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
                      {blocker}
                    </p>
                  )}

                  <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-6">
                    <Stat label="enrolled" value={campaign.enrolled} hint="Prospects in this sequence." />
                    <Stat label="drafts" value={campaign.drafts} hint="Waiting for you to approve." />
                    <Stat label="queued" value={campaign.scheduled} hint="Approved and waiting." />
                    <Stat label="sent" value={campaign.sent} />
                    <Stat
                      label="replied"
                      value={campaign.replied}
                      tone={campaign.replied > 0 ? "ok" : undefined}
                      hint="A human wrote back. Their follow-ups were cancelled."
                    />
                    <Stat
                      label="bounced"
                      value={campaign.bounced}
                      tone={campaign.bounced > 0 ? "danger" : undefined}
                    />
                  </div>
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
