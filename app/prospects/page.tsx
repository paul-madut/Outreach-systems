import Link from "next/link";
import { getDb } from "@/lib/db";
import { countProspects, listProspects } from "@/lib/queries";
import {
  Badge,
  Card,
  Empty,
  FilterPills,
  PageHeading,
  Table,
  Td,
  Th,
  formatWhen,
} from "../ui";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const GRADES = [
  { value: "", label: "Any grade" },
  { value: "A", label: "A" },
  { value: "B", label: "B" },
  { value: "C", label: "C" },
];

/**
 * Everyone imported, and whether they can be emailed.
 *
 * The status column is the reason this page exists. A prospect that cannot be
 * enrolled looks identical to one that can until you try, and the three
 * reasons (on hold, suppressed, no email) each need a different response.
 */
export default async function ProspectsPage({ searchParams }: PageProps<"/prospects">) {
  const params = await searchParams;
  const search = typeof params.q === "string" ? params.q : undefined;
  const grade = typeof params.grade === "string" ? params.grade : undefined;

  const db = getDb();
  const rows = listProspects(db, { search, grade, limit: 300 });
  const total = countProspects(db);

  const filtered = Boolean(search || grade);
  const href = (value: string) => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (value) query.set("grade", value);
    return `/prospects${query.toString() ? `?${query}` : ""}`;
  };

  return (
    <>
      <PageHeading
        title="Prospects"
        subtitle={
          filtered
            ? `${rows.length} of ${total} match.`
            : `${total} imported. Re-importing an expanded sheet updates these rather than duplicating them.`
        }
      />

      <form
        className="mb-3 flex flex-wrap items-center gap-2"
        action="/prospects"
      >
        <input
          name="q"
          defaultValue={search}
          placeholder="Search company or domain"
          className={cn(
            "w-72 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-[13px]",
            "transition-colors duration-150 hover:border-line-strong",
            "focus:border-accent focus:outline-none"
          )}
        />
        {grade && <input type="hidden" name="grade" value={grade} />}
        <button
          type="submit"
          className="h-8 rounded-sm border border-line-strong bg-surface px-3 text-[13px] hover:bg-raised active:scale-[0.97]"
        >
          Search
        </button>
        {filtered && (
          <Link href="/prospects" className="text-xs text-muted hover:text-ink">
            Clear
          </Link>
        )}
      </form>

      <FilterPills options={GRADES} active={grade ?? ""} href={href} />

      {rows.length === 0 ? (
        <Empty
          title="Nothing matches."
          hint={
            total === 0
              ? "Export a tab from your sheet as CSV and import it. Every column is kept and becomes usable in a template."
              : "Try a different search, or clear the filters."
          }
          command={total === 0 ? "pnpm import:csv ~/Downloads/prospects.csv --commit" : undefined}
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Company</Th>
                <Th>Vertical</Th>
                <Th className="text-center">Grade</Th>
                <Th className="text-center">Emailable</Th>
                <Th>Can it be enrolled</Th>
                <Th>Last sent</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="transition-colors duration-150 hover:bg-raised/40">
                  <Td>
                    <Link
                      href={`/prospects/${row.id}`}
                      className="font-medium hover:underline"
                    >
                      {row.company}
                    </Link>
                    {row.domain && (
                      <div className="font-mono text-[11px] text-muted">{row.domain}</div>
                    )}
                  </Td>
                  <Td className="text-muted">{row.vertical ?? "-"}</Td>
                  <Td className="text-center">{row.grade ?? "-"}</Td>
                  <Td className="nums text-center" >
                    <span title={`${row.emailable} of ${row.contacts} contacts have an email address`}>
                      {row.emailable}/{row.contacts}
                    </span>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {row.holdReason && (
                        <Badge tone="warn">on hold</Badge>
                      )}
                      {row.suppressed > 0 && <Badge tone="danger">do not contact</Badge>}
                      {row.emailable === 0 && !row.holdReason && <Badge>no email</Badge>}
                      {row.enrollmentStatus && <Badge>{row.enrollmentStatus}</Badge>}
                      {!row.holdReason &&
                        row.suppressed === 0 &&
                        row.emailable > 0 &&
                        !row.enrollmentStatus && (
                          <span className="text-[11px] text-muted">yes</span>
                        )}
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
