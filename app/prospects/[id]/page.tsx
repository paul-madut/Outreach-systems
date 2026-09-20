import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getProspect } from "@/lib/queries";
import { Badge, Card, PageHeading, StatusBadge, Table, Td, Th, formatWhen } from "../../ui";

export const dynamic = "force-dynamic";

export default async function ProspectPage({ params }: PageProps<"/prospects/[id]">) {
  const { id } = await params;
  const prospect = getProspect(getDb(), Number(id));
  if (!prospect) notFound();

  const customEntries = Object.entries(prospect.custom).filter(([, value]) => value);

  return (
    <>
      <PageHeading
        title={prospect.company}
        subtitle={[prospect.domain, prospect.vertical].filter(Boolean).join(" · ")}
      />

      {prospect.holdReason && (
        <Card className="mb-4 bg-warn-soft px-4 py-3 text-sm text-warn">
          On hold: {prospect.holdReason}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="px-4 py-3">
          <h2 className="mb-2 text-sm font-medium">Contacts</h2>
          {prospect.contactRows.length === 0 ? (
            <p className="text-sm text-muted">None recorded.</p>
          ) : (
            <ul className="space-y-2">
              {prospect.contactRows.map((contact) => (
                <li key={contact.id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{contact.name ?? contact.email ?? "unnamed"}</span>
                    <Badge>{contact.channel.replace("_", " ")}</Badge>
                  </div>
                  {contact.email && <div className="text-xs text-muted">{contact.email}</div>}
                  {contact.title && <div className="text-xs text-muted">{contact.title}</div>}
                  {contact.channelDetail && (
                    <div className="text-xs text-faint">{contact.channelDetail}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="px-4 py-3">
          <h2 className="mb-2 text-sm font-medium">Research</h2>
          {customEntries.length === 0 ? (
            <p className="text-sm text-muted">Nothing imported.</p>
          ) : (
            <dl className="space-y-2 text-sm">
              {customEntries.map(([key, value]) => (
                <div key={key}>
                  <dt className="text-xs text-muted">
                    {key} · usable as {"{{"}
                    {key}
                    {"}}"}
                  </dt>
                  <dd className="whitespace-pre-wrap">{String(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <h2 className="px-4 py-3 text-sm font-medium">History</h2>
        {prospect.history.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted">Nothing sent yet.</p>
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
                    <div>{message.subject}</div>
                    <div className="text-xs text-muted">{message.toEmail}</div>
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
