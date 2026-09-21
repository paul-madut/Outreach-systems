import Link from "next/link";
import { getDb } from "@/lib/db";
import { getHealth, getNextActions, listCampaigns, type NextAction } from "@/lib/queries";
import { Card, Empty, LinkButton, PageHeading, Stat, StatusBadge, formatWhen } from "./ui";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * The overview answers one question: what should I do now.
 *
 * A wall of counts does not answer it. So the top of the page is an ordered
 * list of the things actually worth doing, drawn from real state, with setup
 * gaps ranked above daily work because nothing else functions without them.
 * Counts sit underneath, for when you want them.
 */
export default function OverviewPage() {
  const db = getDb();
  const health = getHealth(db);
  const campaigns = listCampaigns(db);
  const actions = getNextActions(health);

  return (
    <>
      <PageHeading
        title="Overview"
        subtitle="Everything runs on this machine. Nothing sends unless you approve it first."
        right={
          campaigns.length > 0 ? (
            <LinkButton href="/campaigns/new" variant="primary">
              New campaign
            </LinkButton>
          ) : undefined
        }
      />

      {actions.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2.5 text-[11px] uppercase tracking-wide text-faint">Next</h2>
          <div className="space-y-2">
            {actions.map((action, index) => (
              <ActionRow key={action.title} action={action} index={index} />
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-2.5 flex items-baseline justify-between">
          <h2 className="text-[11px] uppercase tracking-wide text-faint">Campaigns</h2>
          {campaigns.length > 0 && (
            <Link href="/campaigns" className="text-xs text-muted hover:text-ink">
              Manage
            </Link>
          )}
        </div>

        {campaigns.length === 0 ? (
          <Empty
            title="No campaigns yet."
            hint="A campaign is a sequence of up to three emails, sent from one mailbox, to prospects you pick."
            action={
              health.mailboxes > 0 ? (
                <LinkButton href="/campaigns/new" variant="primary" size="md">
                  Create the first one
                </LinkButton>
              ) : (
                <span className="text-xs text-muted">Add a mailbox first.</span>
              )
            }
          />
        ) : (
          <div className="space-y-2.5">
            {campaigns.map((campaign, index) => (
              <div
                key={campaign.id}
                className="rise"
                /* Staggered so the page arrives rather than blinking in, capped
                   so a long list does not crawl. */
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
                      {campaign.mailboxStatus === "paused" && (
                        <StatusBadge status="paused" size="xs" />
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      from <span className="font-mono">{campaign.mailbox}</span>
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

                <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-6">
                  <Stat label="enrolled" value={campaign.enrolled} hint="Prospects in this sequence." />
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
                  <Stat
                    label="needs you"
                    value={campaign.uncertain + campaign.failed}
                    tone={campaign.uncertain + campaign.failed > 0 ? "warn" : undefined}
                    hint="Unknown outcome or failed."
                  />
                </div>
              </Card>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

const ACTION_TONE = {
  ok: "border-l-ok",
  warn: "border-l-warn",
  danger: "border-l-danger",
  info: "border-l-info",
} as const;

function ActionRow({ action, index }: { action: NextAction; index: number }) {
  const body = (
    <>
      <div className="flex-1">
        <p className="text-[13px] font-medium">{action.title}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{action.detail}</p>
        {action.command && (
          <code className="mt-2 block w-fit rounded-sm bg-sunken px-2 py-1 font-mono text-[11px] text-muted">
            {action.command}
          </code>
        )}
      </div>
      {action.href && !action.done && (
        <span className="mt-0.5 shrink-0 text-xs text-muted transition-transform duration-150 ease-[var(--ease-out-quick)] group-hover:translate-x-0.5">
          →
        </span>
      )}
    </>
  );

  const className = cn(
    "rise group flex gap-3 rounded-md border border-line border-l-2 bg-surface px-4 py-3",
    ACTION_TONE[action.tone],
    action.href && "transition-colors duration-150 hover:border-line-strong hover:bg-raised/40"
  );

  const style = { animationDelay: `${Math.min(index, 6) * 40}ms` };

  return action.href ? (
    <Link href={action.href} className={className} style={style}>
      {body}
    </Link>
  ) : (
    <div className={className} style={style}>
      {body}
    </div>
  );
}
