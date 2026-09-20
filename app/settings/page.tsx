import { getDb } from "@/lib/db";
import { keychainEntryExists } from "@/lib/mail/keychain";
import { Badge, Card, PageHeading, StatusBadge, Table, Td, Th } from "../ui";

export const dynamic = "force-dynamic";

interface MailboxView {
  id: number;
  label: string;
  from_email: string;
  provider: string;
  status: string;
  paused_reason: string | null;
  daily_cap: number;
  min_gap_seconds: number;
  timezone: string;
  keychain_service: string;
  keychain_account: string;
  append_to_sent: number;
}

export default function SettingsPage() {
  const db = getDb();
  const mailboxes = db
    .prepare("select * from mailboxes order by id")
    .all() as MailboxView[];

  const suppressions = db
    .prepare("select count(*) as n from suppressions")
    .get() as { n: number };
  const imports = db
    .prepare("select label, row_count, created_at from imports order by id desc limit 5")
    .all() as { label: string; row_count: number; created_at: string }[];

  return (
    <>
      <PageHeading
        title="Settings"
        subtitle="Mailboxes send from your own accounts. Passwords live in the Keychain, never here."
      />

      <Card className="mb-4">
        <h2 className="px-4 py-3 text-sm font-medium">Mailboxes</h2>
        {mailboxes.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted">
            None yet. Add one with pnpm mailbox:add.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Mailbox</Th>
                <Th>Status</Th>
                <Th className="text-center">Cap</Th>
                <Th>Keychain</Th>
                <Th>Notes</Th>
              </tr>
            </thead>
            <tbody>
              {mailboxes.map((mailbox) => {
                const hasPassword = keychainEntryExists(
                  mailbox.keychain_service,
                  mailbox.keychain_account
                );
                return (
                  <tr key={mailbox.id}>
                    <Td>
                      <div className="font-medium">{mailbox.label}</div>
                      <div className="text-xs text-muted">{mailbox.from_email}</div>
                    </Td>
                    <Td>
                      <StatusBadge status={mailbox.status} />
                      {mailbox.paused_reason && (
                        <div className="mt-1 text-xs text-warn">{mailbox.paused_reason}</div>
                      )}
                    </Td>
                    <Td className="nums text-center">
                      {mailbox.daily_cap}
                      <div className="text-xs text-muted">/day</div>
                    </Td>
                    <Td>
                      {hasPassword ? (
                        <Badge tone="ok">found</Badge>
                      ) : (
                        <Badge tone="danger">missing</Badge>
                      )}
                      <div className="mt-1 font-mono text-xs text-muted">
                        {mailbox.keychain_service}
                      </div>
                    </Td>
                    <Td className="text-xs text-muted">
                      {mailbox.timezone} · {mailbox.min_gap_seconds}s gap
                      <div>
                        {mailbox.append_to_sent
                          ? "files its own Sent copy"
                          : "provider files Sent"}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="px-4 py-3">
          <h2 className="text-sm font-medium">Suppression list</h2>
          <p className="nums mt-1 text-xl font-semibold">{suppressions.n}</p>
          <p className="mt-1 text-sm text-muted">
            Addresses and domains that will never be emailed. Seeded from your exclude list,
            and added to automatically on a hard bounce or an opt-out.
          </p>
        </Card>

        <Card className="px-4 py-3">
          <h2 className="text-sm font-medium">Recent imports</h2>
          {imports.length === 0 ? (
            <p className="mt-1 text-sm text-muted">None yet.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {imports.map((row, index) => (
                <li key={index} className="flex justify-between gap-2">
                  <span className="truncate">{row.label}</span>
                  <span className="nums text-muted">{row.row_count} rows</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
