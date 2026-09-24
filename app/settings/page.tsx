import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getDb } from "@/lib/db";
import { keychainEntryExists } from "@/lib/mail/keychain";
import { warmupState } from "@/lib/schedule/warmup";
import type { PlacementReport } from "@/lib/mail/placement";
import { Badge, Card, Dot, PageHeading, StatusBadge, Table, Td, Th, formatWhen } from "../ui";
import { MailboxControls } from "./mailbox-row";
import { latestTestId, placementReport } from "@/lib/mail/placement-run";
import { PlacementPanel } from "./placement-panel";
import { WarmupControls } from "./warmup-controls";

export const dynamic = "force-dynamic";

const LAUNCHD_PLIST = resolve(
  homedir(),
  "Library/LaunchAgents/com.paulmadut.outreach.worker.plist"
);

interface SeedView {
  id: number;
  label: string;
  email: string;
  keychain_service: string;
  keychain_account: string;
  status: string;
}

interface MailboxView {
  id: number;
  label: string;
  from_email: string;
  provider: string;
  status: string;
  paused_reason: string | null;
  daily_cap: number;
  warmup_started_on: string | null;
  warmup_start_cap: number;
  warmup_daily_increment: number;
  min_gap_seconds: number;
  timezone: string;
  keychain_service: string;
  keychain_account: string;
  append_to_sent: number;
}

/**
 * The state that decides whether anything can leave this machine.
 *
 * Three things have to be true and each one fails silently: the password has
 * to be in the Keychain, the scheduled job has to be installed, and
 * OUTREACH_LIVE has to be set. Without that last one the worker claims,
 * renders and logs exactly as it would in earnest, and opens no connection.
 * That is the correct default and the most confusing possible symptom, so it
 * is stated at the top rather than left to be discovered.
 */
export default function SettingsPage() {
  const db = getDb();

  const mailboxes = db.prepare("select * from mailboxes order by id").all() as MailboxView[];

  const suppressions = db.prepare("select count(*) as n from suppressions").get() as {
    n: number;
  };

  const imports = db
    .prepare("select label, row_count, created_at from imports order by id desc limit 5")
    .all() as { label: string; row_count: number; created_at: string }[];

  const seeds = db
    .prepare("select id, label, email, keychain_service, keychain_account, status from seed_inboxes order by id")
    .all() as SeedView[];

  // Only campaigns with something to render from can produce a test message,
  // so offering the others would only ever fail at the send.
  const testableCampaigns = db
    .prepare(
      `select c.id, c.name from campaigns c
        where exists (select 1 from sequence_steps s where s.campaign_id = c.id)
          and exists (
            select 1 from enrollments e join contacts ct on ct.id = e.contact_id
             where e.campaign_id = c.id and ct.channel = 'email'
          )
        order by c.name`
    )
    .all() as { id: number; name: string }[];

  // The last answer per mailbox, so closing the tab does not lose it. A result
  // from weeks ago is still the most recent thing known, and it is dated.
  const lastPlacement: Record<number, { report: PlacementReport; when: string | null }> = {};
  for (const mailbox of mailboxes) {
    const testId = latestTestId(db, mailbox.id);
    if (testId === null) continue;
    const when = db
      .prepare("select sent_at from placement_tests where id = ?")
      .get(testId) as { sent_at: string | null };
    lastPlacement[mailbox.id] = { report: placementReport(db, testId), when: when.sent_at };
  }

  const live = process.env.OUTREACH_LIVE === "1";
  const redirect = process.env.REDIRECT_ALL_TO ?? null;
  const scheduled = existsSync(LAUNCHD_PLIST);

  return (
    <>
      <PageHeading
        title="Settings"
        subtitle="Everything sends from your own mailboxes. Passwords stay in the Keychain and are never stored here."
      />

      <Card className="mb-5 px-4 py-3.5">
        <h2 className="mb-3 text-[12px] uppercase tracking-wide text-faint">
          Can anything actually send
        </h2>

        <div className="space-y-2.5">
          <Check
            ok={live}
            label={live ? "Live sending is on." : "Live sending is off."}
            detail={
              live
                ? "Approved messages really go out at their scheduled time."
                : "The worker will claim, render and log exactly as it would in earnest, and open no connection. Nothing reaches anybody. Put OUTREACH_LIVE=1 in .env.local to change that. Both this page and the scheduled worker read that file."
            }
          />

          <Check
            ok={scheduled}
            label={scheduled ? "The scheduled job is installed." : "No scheduled job."}
            detail={
              scheduled
                ? "launchd wakes the worker every ten minutes while you are logged in."
                : "Nothing runs on its own. Use Run now, or install the job with pnpm schedule install."
            }
          />

          <Check
            ok={mailboxes.some((mailbox) => mailbox.status === "active")}
            label={
              mailboxes.length === 0
                ? "No mailbox registered."
                : mailboxes.some((mailbox) => mailbox.status === "active")
                  ? "A mailbox is active."
                  : "Every mailbox is paused."
            }
            detail={
              mailboxes.length === 0
                ? "Add one with pnpm mailbox add."
                : "Pacing and the daily cap belong to the mailbox, not the campaign."
            }
          />
        </div>

        {redirect && (
          <p className="mt-3 rounded-sm bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
            Every message is being redirected to{" "}
            <span className="font-mono">{redirect}</span>, whoever it is addressed to. That is
            REDIRECT_ALL_TO, meant for testing.
          </p>
        )}
      </Card>

      <Card className="mb-5">
        <h2 className="px-4 pt-3 pb-2.5 text-[12px] uppercase tracking-wide text-faint">
          Mailboxes
        </h2>
        {mailboxes.length === 0 ? (
          <div className="px-4 pb-4">
            <p className="text-[13px] text-muted">
              None yet. Store an app-specific password in the Keychain first, then register it.
            </p>
            <code className="mt-2 block w-fit rounded-sm bg-sunken px-2 py-1 font-mono text-[11px] text-muted">
              pnpm mailbox add --label payments --provider icloud --from &quot;You
              &lt;you@icloud.com&gt;&quot;
            </code>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Mailbox</Th>
                <Th>Status</Th>
                <Th className="text-center">Cap</Th>
                <Th>Password</Th>
                <Th>How it behaves</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {mailboxes.map((mailbox) => {
                const hasPassword = keychainEntryExists(
                  mailbox.keychain_service,
                  mailbox.keychain_account
                );
                // The ramp is what the worker actually enforces, so the number
                // shown here has to be today's cap and not the ceiling.
                const ramp = warmupState(mailbox, new Date());

                return (
                  <tr key={mailbox.id}>
                    <Td>
                      <div className="text-[13px] font-medium">{mailbox.label}</div>
                      <div className="font-mono text-[11px] text-muted">{mailbox.from_email}</div>
                    </Td>
                    <Td>
                      <StatusBadge status={mailbox.status} />
                      {mailbox.paused_reason && (
                        <div className="mt-1 text-[11px] text-warn">{mailbox.paused_reason}</div>
                      )}
                    </Td>
                    <Td className="nums text-center">
                      {ramp.cap}
                      <div className="text-[11px] text-muted">a day</div>
                      {ramp.pending && (
                        <div className="mt-1 text-[11px] text-warn">
                          ramp starts {ramp.fullOn}
                        </div>
                      )}
                      {!ramp.pending && ramp.day !== null && !ramp.complete && (
                        <div className="mt-1 text-[11px] text-warn">
                          day {ramp.day} of ramp
                          <div className="text-muted">
                            {ramp.ceiling} from {ramp.fullOn ?? "never"}
                          </div>
                        </div>
                      )}
                      <div className="mt-1.5">
                        <WarmupControls
                          mailboxId={mailbox.id}
                          startOn={mailbox.warmup_started_on}
                          startCap={mailbox.warmup_start_cap}
                          dailyIncrement={mailbox.warmup_daily_increment}
                          ceiling={mailbox.daily_cap}
                        />
                      </div>
                    </Td>
                    <Td>
                      {hasPassword ? (
                        <Badge tone="ok">in the Keychain</Badge>
                      ) : (
                        <Badge tone="danger">not found</Badge>
                      )}
                      <div className="mt-1 font-mono text-[11px] text-muted">
                        {mailbox.keychain_service}
                      </div>
                    </Td>
                    <Td className="text-[11px] text-muted">
                      {mailbox.timezone} · at least {mailbox.min_gap_seconds}s between sends
                      <div>
                        {/*
                          append_to_sent means the TOOL has to file the copy,
                          because the provider does not. iCloud does not file
                          one for SMTP; Gmail does, and appending there would
                          put every sent message in twice.
                        */}
                        {mailbox.append_to_sent
                          ? "Sent copy filed by this tool"
                          : `Sent copy filed by ${mailbox.provider}`}
                      </div>
                    </Td>
                    <Td>
                      <MailboxControls mailboxId={mailbox.id} status={mailbox.status} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mb-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2.5">
          <h2 className="text-[12px] uppercase tracking-wide text-faint">Where your mail lands</h2>
          {seeds.length > 0 && (
            <span className="text-[11px] text-faint">
              {seeds.length === 1 ? "1 seed inbox" : `${seeds.length} seed inboxes`}
              {": "}
              {seeds.map((seed) => seed.email).join(", ")}
            </span>
          )}
        </div>

        {seeds.some((seed) => !keychainEntryExists(seed.keychain_service, seed.keychain_account)) && (
          <p className="mx-4 mb-3 rounded-sm bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
            {seeds
              .filter((seed) => !keychainEntryExists(seed.keychain_service, seed.keychain_account))
              .map((seed) => seed.label)
              .join(", ")}{" "}
            has no password in the Keychain, so its folder cannot be read.
          </p>
        )}

        <PlacementPanel
          mailboxes={mailboxes.map((mailbox) => ({
            id: mailbox.id,
            label: mailbox.label,
            from_email: mailbox.from_email,
          }))}
          campaigns={testableCampaigns}
          seedCount={seeds.filter((seed) => seed.status === "active").length}
          lastPlacement={lastPlacement}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="px-4 py-3.5">
          <h2 className="text-[12px] uppercase tracking-wide text-faint">Do-not-contact list</h2>
          <p className="nums mt-1.5 text-2xl">{suppressions.n}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            Addresses and domains that will never be emailed, whatever a campaign says. Seeded
            from your exclude list, and added to on its own after a hard bounce or an opt-out.
          </p>
        </Card>

        <Card className="px-4 py-3.5">
          <h2 className="text-[12px] uppercase tracking-wide text-faint">Recent imports</h2>
          {imports.length === 0 ? (
            <p className="mt-1.5 text-[13px] text-muted">None yet.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {imports.map((row, index) => (
                <li key={index} className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="truncate">{row.label}</span>
                  <span className="nums shrink-0 text-[11px] text-muted">
                    {row.row_count} rows · {formatWhen(row.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
            The column mapping is saved, so re-importing an expanded sheet reuses it and updates
            the rows it already has.
          </p>
        </Card>
      </div>
    </>
  );
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-1.5">
        <Dot tone={ok ? "ok" : "warn"} />
      </span>
      <div>
        <p className="text-[13px] font-medium">{label}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{detail}</p>
      </div>
    </div>
  );
}
