import { getDb } from "@/lib/db";
import { countInboxByKind, listInbox } from "@/lib/queries";
import { Empty, FilterPills, PageHeading } from "../ui";
import { InboxCard } from "./inbox-row";

export const dynamic = "force-dynamic";

const TABS = [
  { value: "", label: "Everything" },
  { value: "reply", label: "Replies" },
  { value: "auto_reply", label: "Auto" },
  { value: "bounce", label: "Bounces" },
  { value: "unsubscribe", label: "Opt-outs" },
  { value: "unmatched", label: "Unmatched" },
];

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const params = await searchParams;
  const classification = typeof params.kind === "string" ? params.kind : undefined;

  const db = getDb();
  const rows = listInbox(db, { classification, limit: 200 });
  const counts = countInboxByKind(db);

  return (
    <>
      <PageHeading
        title="Inbox"
        subtitle="What came back, and what the tool already did about it. An auto-reply never stops a sequence, because most of these addresses sit behind a helpdesk."
      />

      <FilterPills
        active={classification ?? ""}
        href={(value) => (value ? `/inbox?kind=${value}` : "/inbox")}
        options={TABS.map((tab) => ({ ...tab, count: counts[tab.value] ?? 0 }))}
      />

      {rows.length === 0 ? (
        <Empty
          title={classification ? "Nothing of that kind." : "Nothing has come back yet."}
          hint={
            classification
              ? "Try another tab."
              : "The mailbox is read each time the worker runs, INBOX and Junk both."
          }
        />
      ) : (
        <div className="space-y-2">
          {rows.map((row, index) => (
            <InboxCard key={row.id} row={row} index={index} />
          ))}
        </div>
      )}
    </>
  );
}
