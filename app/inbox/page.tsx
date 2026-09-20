import Link from "next/link";
import { getDb } from "@/lib/db";
import { listInbox } from "@/lib/queries";
import { Card, Empty, PageHeading, StatusBadge, formatWhen } from "../ui";

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
  const rows = listInbox(getDb(), { classification, limit: 200 });

  return (
    <>
      <PageHeading
        title="Inbox"
        subtitle="What came back, and what the tool did about it. Auto-replies never stop a sequence."
      />

      <div className="mb-4 flex flex-wrap gap-1.5 text-xs">
        {TABS.map((tab) => {
          const active = (classification ?? "") === tab.value;
          return (
            <Link
              key={tab.label}
              href={tab.value ? `/inbox?kind=${tab.value}` : "/inbox"}
              className={
                active
                  ? "rounded border border-ink bg-ink px-2 py-1 text-canvas"
                  : "rounded border border-line px-2 py-1 text-muted hover:bg-raised"
              }
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <Empty
          title="Nothing here yet."
          hint="The poller reads INBOX and Junk each time the worker runs."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Card key={row.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={row.classification} />
                <span className="text-sm font-medium">{row.company ?? row.fromEmail}</span>
                <span className="text-xs text-muted">{row.fromEmail}</span>
                <span className="ml-auto text-xs text-muted">{formatWhen(row.receivedAt)}</span>
              </div>
              {row.subject && <div className="mt-1 text-sm">{row.subject}</div>}
              {row.snippet && (
                <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-muted">
                  {row.snippet}
                </p>
              )}
              <div className="mt-1.5 text-xs text-faint">
                {row.reason}
                {row.matchMethod && ` · matched on ${row.matchMethod.replace(/_/g, " ")}`}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
