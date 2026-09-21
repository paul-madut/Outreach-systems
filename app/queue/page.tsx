import { getDb } from "@/lib/db";
import { countQueueByStatus, listCampaigns, listQueue } from "@/lib/queries";
import { Card, Empty, FilterPills, LinkButton, PageHeading, StatusBadge, formatWhen } from "../ui";
import { QueueList } from "./queue-list";

export const dynamic = "force-dynamic";

const FILTERS = [
  { value: "", label: "Everything waiting" },
  { value: "draft", label: "Drafts" },
  { value: "scheduled", label: "Queued" },
  { value: "uncertain", label: "Unknown outcome" },
  { value: "failed", label: "Failed" },
  { value: "sent", label: "Sent" },
];

export default async function QueuePage({
  searchParams,
}: PageProps<"/queue">) {
  const params = await searchParams;
  const campaignId = params.campaign ? Number(params.campaign) : undefined;
  const status = typeof params.status === "string" ? params.status : undefined;

  const db = getDb();
  const rows = listQueue(db, { campaignId, status, limit: 300 });
  const campaigns = listCampaigns(db);
  const campaign = campaigns.find((c) => c.id === campaignId);
  const counts = countQueueByStatus(db, campaignId);

  const query = (next: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    if (campaignId) search.set("campaign", String(campaignId));
    if (status) search.set("status", status);
    for (const [key, value] of Object.entries(next)) {
      if (value) search.set(key, value);
      else search.delete(key);
    }
    return `/queue${search.toString() ? `?${search}` : ""}`;
  };

  return (
    <>
      <PageHeading
        title="Queue"
        subtitle={
          campaign
            ? `${campaign.name}, sending from ${campaign.mailbox}`
            : "Drafts waiting for review, and what is scheduled to go out."
        }
        back={campaign ? { href: `/campaigns/${campaign.id}`, label: campaign.name } : undefined}
        right={
          campaignId ? (
            <LinkButton href={query({ campaign: undefined })}>Show every campaign</LinkButton>
          ) : undefined
        }
      />

      <FilterPills
        active={status ?? ""}
        href={(value) => query({ status: value || undefined })}
        options={FILTERS.map((filter) => ({
          ...filter,
          count: counts[filter.value] ?? 0,
        }))}
      />

      {rows.length === 0 ? (
        <Empty
          title="Nothing here."
          hint={
            status === "draft"
              ? "Drafts appear once contacts are enrolled in a campaign."
              : "Enrol some contacts, or change the filter above."
          }
        />
      ) : status === "sent" ? (
        <Card>
          <table className="w-full border-collapse text-sm">
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="border-b border-line px-3 py-2">
                    <div className="font-medium">{row.company}</div>
                    <div className="text-xs text-muted">{row.toEmail}</div>
                  </td>
                  <td className="border-b border-line px-3 py-2 text-muted">{row.subject}</td>
                  <td className="border-b border-line px-3 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="nums border-b border-line px-3 py-2 text-right text-xs text-muted">
                    step {row.stepNumber} · {formatWhen(row.scheduledAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <QueueList rows={rows} />
      )}
    </>
  );
}
