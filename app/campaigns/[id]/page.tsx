import { notFound } from "next/navigation";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { getCampaignDetail, listCampaigns, listMergeFields } from "@/lib/queries";
import { PageHeading } from "../../ui";
import { CampaignTabs } from "./campaign-tabs";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params }: PageProps<"/campaigns/[id]">) {
  const { id } = await params;
  const campaignId = Number(id);
  if (!Number.isInteger(campaignId)) notFound();

  const db = getDb();
  const campaign = getCampaignDetail(db, campaignId);
  if (!campaign) notFound();

  const summary = listCampaigns(db).find((row) => row.id === campaignId);
  if (!summary) notFound();

  return (
    <>
      <PageHeading
        title={campaign.name}
        subtitle={
          campaign.description ?? (
            <Link href="/campaigns" className="hover:text-ink">
              All campaigns
            </Link>
          )
        }
      />
      <CampaignTabs
        campaign={campaign}
        summary={summary}
        fields={listMergeFields(db)}
        nextSendAt={summary.nextSendAt}
      />
    </>
  );
}
