import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getProspect } from "@/lib/queries";
import { toTemplateKey } from "@/lib/template/context";
import { Badge, Card, PageHeading, StatusBadge, Table, Td, Th, formatWhen } from "../../ui";
import { HoldBanner, ResearchFields } from "./prospect-actions";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ProspectPage({ params }: PageProps<"/prospects/[id]">) {
  const { id } = await params;
  const prospect = getProspect(getDb(), Number(id));
  if (!prospect) notFound();

  const research = Object.entries(prospect.custom)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
    .map(([label, value]) => ({
      key: toTemplateKey(label),
      label,
      value: String(value),
    }));

  // One sentence on whether this prospect can be emailed, and why not.
  const blocker = prospect.holdReason
    ? null // The banner below says it in full.
    : prospect.suppressed > 0
      ? "On the do-not-contact list, so it will never be enrolled."
      : prospect.emailable === 0
        ? "No email address. Reachable another way, if at all."
        : null;

  return (
    <>
      <PageHeading
        title={prospect.company}
        subtitle={[prospect.domain, prospect.vertical].filter(Boolean).join(" · ")}
        back={{ href: "/prospects", label: "All prospects" }}
        right={
          <div className="flex items-center gap-2">
            {prospect.grade && <Badge>grade {prospect.grade}</Badge>}
            {prospect.enrollmentStatus && <StatusBadge status={prospect.enrollmentStatus} />}
          </div>
        }
      />

      {prospect.holdReason && (
        <HoldBanner prospectId={prospect.id} reason={prospect.holdReason} />
      )}

      {blocker && (
        <Card className="mb-4 border-l-2 border-l-warn px-4 py-3 text-[13px] text-warn">
          {blocker}
        </Card>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card className="px-4 py-3">
          <h2 className="mb-2.5 text-[12px] uppercase tracking-wide text-faint">Contacts</h2>
          {prospect.contactRows.length === 0 ? (
            <p className="text-[13px] text-muted">None recorded.</p>
          ) : (
            <ul className="space-y-2.5">
              {prospect.contactRows.map((contact) => (
                <li key={contact.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "text-[13px] font-medium",
                        !contact.name && "font-mono text-[12px]"
                      )}
                    >
                      {contact.name ?? contact.email ?? "no address"}
                    </span>
                    <Badge tone={contact.channel === "email" ? "neutral" : "warn"}>
                      {contact.channel.replace("_", " ")}
                    </Badge>
                  </div>
                  {contact.email && contact.name && (
                    <div className="font-mono text-[11px] text-muted">{contact.email}</div>
                  )}
                  {contact.title && <div className="text-[11px] text-muted">{contact.title}</div>}
                  {contact.channelDetail && (
                    <div className="text-[11px] text-faint">{contact.channelDetail}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="px-4 py-3">
          <h2 className="mb-2.5 text-[12px] uppercase tracking-wide text-faint">
            Research, from the sheet
          </h2>
          {research.length === 0 ? (
            <p className="text-[13px] text-muted">Nothing imported.</p>
          ) : (
            <ResearchFields entries={research} />
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <h2 className="px-4 pt-3 pb-2.5 text-[12px] uppercase tracking-wide text-faint">
          Every message, ever
        </h2>
        {prospect.history.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted">Nothing sent yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Subject</Th>
                <Th>Campaign</Th>
                <Th className="text-center">Step</Th>
                <Th>Status</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {prospect.history.map((message) => (
                <tr key={message.id}>
                  <Td>
                    <div className="text-[13px]">{message.subject}</div>
                    <div className="font-mono text-[11px] text-muted">{message.toEmail}</div>
                  </Td>
                  <Td className="text-muted">{message.campaign}</Td>
                  <Td className="nums text-center">{message.stepNumber}</Td>
                  <Td>
                    <StatusBadge status={message.status} />
                  </Td>
                  <Td className="text-xs text-muted">
                    {formatWhen(message.sentAt ?? message.scheduledAt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
