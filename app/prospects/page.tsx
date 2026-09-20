import Link from "next/link";
import { getDb } from "@/lib/db";
import { listProspects } from "@/lib/queries";
import { Badge, Card, Empty, PageHeading, Table, Td, Th, formatWhen } from "../ui";

export const dynamic = "force-dynamic";

export default async function ProspectsPage({ searchParams }: PageProps<"/prospects">) {
  const params = await searchParams;
  const search = typeof params.q === "string" ? params.q : undefined;
  const grade = typeof params.grade === "string" ? params.grade : undefined;

  const rows = listProspects(getDb(), { search, grade, limit: 300 });

  return (
    <>
      <PageHeading
        title="Prospects"
        subtitle={`${rows.length} shown. Import more with pnpm import:csv.`}
      />

      <form className="mb-4 flex flex-wrap gap-2 text-sm" action="/prospects">
        <input
          name="q"
          defaultValue={search}
          placeholder="Search company or domain"
          className="w-64 rounded border border-line bg-surface px-2 py-1"
        />
        <select
          name="grade"
          defaultValue={grade ?? ""}
          className="rounded border border-line bg-surface px-2 py-1"
        >
          <option value="">Any grade</option>
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
        </select>
        <button type="submit" className="rounded bg-ink px-3 py-1 text-xs text-canvas">
          Filter
        </button>
      </form>

      {rows.length === 0 ? (
        <Empty title="No prospects match." hint="Try clearing the filters." />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Company</Th>
                <Th>Vertical</Th>
                <Th className="text-center">Grade</Th>
                <Th className="text-center">Contacts</Th>
                <Th>Status</Th>
                <Th>Last sent</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <Td>
                    <Link href={`/prospects/${row.id}`} className="font-medium hover:underline">
                      {row.company}
                    </Link>
                    {row.domain && <div className="text-xs text-muted">{row.domain}</div>}
                  </Td>
                  <Td className="text-muted">{row.vertical ?? "-"}</Td>
                  <Td className="text-center">{row.grade ?? "-"}</Td>
                  <Td className="nums text-center">
                    {row.emailable}/{row.contacts}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {row.holdReason && <Badge tone="warn">on hold</Badge>}
                      {row.suppressed > 0 && <Badge tone="danger">suppressed</Badge>}
                      {row.enrollmentStatus && <Badge>{row.enrollmentStatus}</Badge>}
                      {row.emailable === 0 && !row.holdReason && <Badge>no email</Badge>}
                    </div>
                  </Td>
                  <Td className="text-xs text-muted">{formatWhen(row.lastSentAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
