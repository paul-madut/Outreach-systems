<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Working in this repo

A local tool that sends Paul's cold email from his own mailboxes.

**The one hard rule: never send a message the tool is not certain it should send.**
A missed email costs a click in the review queue.
A duplicate, or one sent to somebody who already replied or opted out, costs a prospect.
Every decision below follows from that asymmetry.

## Shape

Everything runs on Paul's Mac.
A Next.js dashboard on localhost, a SQLite file on disk, and a worker that launchd wakes every few minutes.
No hosting, no accounts, no deploy.

Sending goes through his existing personal mailboxes over SMTP with app-specific passwords, which is the approach his Python scripts already proved.
Passwords live in the macOS Keychain and never touch the database or a dotfile.

This was deliberately scaled back from a Vercel and Supabase design.
At 20 to 60 emails a day sent during working hours, the only thing the cloud bought was sending with the laptop shut, and it cost two accounts, a deploy, and the whole lease-and-reaper machinery that exists because serverless functions overlap and die.

## Stack

Next.js 16 App Router, TypeScript, no `src/` directory.
pnpm. Tailwind v4 CSS-first with tokens in an `@theme` block in `app/globals.css`, no `tailwind.config`.
SQLite through better-sqlite3. Vitest for tests.

better-sqlite3 is pinned to v11 because v13 requires Node 22 and this machine runs Node 20.

## Layout

| Path | What it is |
|---|---|
| `lib/db/` | `schema.sql` and the connection helper. The schema is idempotent and applied on every open, which is the entire migration story. |
| `lib/template/` | Merge-field rendering, context building, the content linter. Pure. |
| `lib/schedule/` | Send-time slotting and timezone helpers. Pure, with an injectable RNG. |
| `lib/reply/` | Drafting replies to inbound mail. Context assembly and the prompt are pure; only `suggest.ts` calls out. |
| `lib/mail/` | SMTP and IMAP, Keychain, inbound classification, DSN parsing, reply matching, recipient MX lookup, placement testing. The classify, match and placement-parsing halves are pure. |
| `lib/import/` | CSV parsing, column mapping, value normalisation, commit. |
| `lib/worker/` | The lock, the claim, the send tick, the mailbox poller. |
| `tests/` | Vitest. `tests/helpers/db.ts` opens an in-memory database with the real schema. |

## Conventions

**Pure core, thin edges.**
Anything that can be a pure function of its inputs is one, and lives under `lib/` with a test.
This is why the rules that matter most, what counts as a reply and when a message may send, are testable without a network.

**The database is the queue.**
Nothing sleeps between sends.
Every message carries its own `scheduled_at`; the worker asks what is due, sends a little, and exits.
The old scripts slept 20 to 180 seconds between sends, which is why they needed a long-lived process and `caffeinate`.

**Pacing lives on the mailbox, not the campaign.**
Two campaigns can share a mailbox, and it is the mailbox that carries the reputation.
`daily_cap`, `min_gap_seconds` and the window are enforced inside `claimDueMessages`, in one transaction.
Do not re-implement these checks elsewhere and rely on them.

**A new mailbox ramps.**
`daily_cap` is the ceiling, not today's cap.
`lib/schedule/warmup.ts` works out what a mailbox may send today from `warmup_started_on`, and the claim gate calls it.
The dashboard calls the same function, so the two cannot disagree about the number.
A start date in the future means a cap of zero, not the ceiling: "the ramp has not started" is not a reason to send at full rate.
Counting is in the mailbox's own timezone through `daysBetween`, never by adding 24 hours to an instant, for the same DST reason slotting is.

**One worker at a time**, enforced by a PID-aware lock file.
Two workers would each sweep the other's in-flight messages into `uncertain` and both would claim against the same daily cap.
The lock breaks itself if the recorded process is gone, because the previous Python version had no liveness check and a single hard kill wedged the job permanently.

**At-most-once, never at-least-once.**
SMTP and SQLite share no transaction, so a send whose outcome is unknown goes to `uncertain` and waits for a human.
Never add automatic retry to an ambiguous send.
A failure is only safe to retry when it is known to have happened before the server accepted the message: a 4xx reply, or a socket error during connect, EHLO, STARTTLS or AUTH.
Anything at or after DATA is ambiguous.

**Follow-ups are created when the previous step actually sends**, not precomputed at enrollment.
`delay_days` means days after the touch that really happened.

**Timezones.**
Never build a send time by adding 24 hours to an instant.
Always go through `lib/schedule/tz.ts`, which resolves a local calendar date plus a local wall-clock time through an IANA zone.
Across a DST boundary the naive version lands outside the sending window.

**Auto-replies do not stop a sequence.**
Most recipients are `support@` addresses behind a helpdesk.
Treating a ticket acknowledgement as a human reply would kill most sequences after step 1.

**Never state a claim this business cannot back up.**
`lib/template/lint.ts` blocks the specific fabricated claims a previous model produced.
Do not weaken that list, and do not add copy asserting results Paul has not had.

**A section inside a line must not eat the newline after it.**
`ownsItsLine` in `lib/template/render.ts`. A section written on its own lines is structural and dropping it should take its blank line too, but a branch within a sentence - the two halves of a greeting - must leave the following newline alone.
Without the distinction, `{{#first_name}}Hi {{first_name}},{{/first_name}}{{^first_name}}Hello,{{/first_name}}` pulled the next paragraph up onto the greeting's line for every recipient whose name was known.

**Inbound alerts go out after polling, not inside it.**
`lib/worker/notify-inbound.ts`. Polling writes in a transaction and a network call has no business in one.
Slack is sent first and `inbound_messages.notified_at` is set second: dying between the two costs a duplicate ping, dying in the other order costs a reply nobody hears about.
A Slack outage is therefore free - the row keeps its null `notified_at` and the next run retries it.

**A drafted reply is never sent without a person pressing send twice.**
`lib/reply/`. The draft is editable, the Send button asks for confirmation naming the recipient, and nothing in the tool replies on its own - which matters more for text a model wrote than for anything else here.

**The refusals in `blockingReason` are the point of `lib/reply/send.ts`.**
No send without `OUTREACH_LIVE`, none to a suppressed address however well meant, none that fails the content linter, none from a paused mailbox, and none where a reply is already sent or in flight.
The `sent_replies` row is written *before* the send and marked after, so a process that dies mid-flight leaves evidence rather than an invitation to send again.

**A reply is not a `messages` row.**
It belongs to no sequence and has no step, and putting it in that table would place it in front of the follow-up logic.
It answers from the mailbox that started the thread, threading on the inbound message's own Message-ID.

**Reply linting drops the subject rules.**
`lintReplyBody`. A reply carries no subject of its own, so `empty-subject` is noise reported as a blocker. Shared between drafting and sending because the filter was written twice and forgotten once.

**A reroll keeps the drafts it replaced.**
`reply_suggestions` is append-only, one row per attempt. The rejected drafts go into the next prompt, or a reroll returns the same reply with the words moved around, and the earlier attempt stays reachable rather than being regenerated and hoped for.

**A mailbox pausing itself is announced too, and it matters more than a reply.**
`lib/worker/notify-mailbox.ts`, keyed off `mailboxes.pause_notified_at` rather than off the tick's result, so a crashed worker or a Slack outage still delivers it later.
A pause is silent - the queue just stops moving - and the only other way to find out is to go and look.
`setMailboxStatus` clears the marker on resume, or a mailbox that pauses, resumes and pauses again goes quiet the second time.

**`unmatched` inbound is never announced.**
`ALERTED` in `lib/notify/inbound-alert.ts`. That bucket is everything else in the mailbox, and while `jobs` is Paul's personal iCloud address it is his personal mail: 177 Uber receipts, job alerts and DMARC reports against 2 real replies.
Switching the notifier on for the first time needs `markExistingNotified` or the first poll posts the entire history.

**No em dashes, and no en dashes either.**
Paul's global rule, enforced in code: the linter blocks both U+2014 and U+2013 in any outgoing message.

**A follow-up leaves from the mailbox that started its thread.**
`threadMailboxId` in `lib/campaign/index.ts`, used by `lib/enroll/next-step.ts` and respected by `moveCampaign`.
A follow-up carries In-Reply-To pointing at the first message, so a "Re:" from a different address splits the thread in the recipient's client and reads as a stranger joining the conversation.
This is why moving a campaign to a new mailbox leaves open conversations behind.

**Moving a campaign moves its queue with it.**
`messages.mailbox_id` is a snapshot taken when the row is rendered, so changing `campaigns.mailbox_id` alone would leave everything already queued going out from the old address.
`pnpm campaign move` does both. It never rewrites sent, failed or cancelled rows, because those are a record of what actually happened.

**A placement test measures the mail, not a mock of it.**
`pnpm placement test` renders a real sequence step against a real enrolled contact, appends the campaign's real footer, and sends that.
Filtering is a content decision, so a message written for the test would measure something nobody is going to send.
It is found again at the seed by its Message-ID rather than a marker in the subject, so what the seed receives is shaped exactly like what a prospect receives.

**Placement tests ignore `OUTREACH_LIVE`.**
That flag exists to keep drafts away from prospects.
A placement test only ever writes to seed inboxes Paul owns, and gating it would make the check unavailable in exactly the state it is for: before the first campaign goes out.

**Sending and reading a placement test are separate calls.**
The send takes a second and the message can take minutes to appear, so `sendPlacementTest` returns as soon as SMTP accepts and `checkPlacementTest` is called again until nothing is outstanding.
`checkPlacementTest` is idempotent, which is what lets the web app poll it without holding a request open.

**An absent `Authentication-Results` header is not a failure.**
It means no receiver ever ran the checks, which is what happens when the seed is on the same provider as the sender.
`AuthResults.present` carries that distinction so it reads as one fact rather than three failed checks.

## Commands

```
pnpm dev
pnpm test
pnpm lint
pnpm typecheck

pnpm placement seeds
pnpm placement seed-add --label gmail --email you@gmail.com --provider gmail --keychain-service gmail-imap-seed
pnpm placement test --mailbox payments --campaign "processor down" [--dry-run]
pnpm placement history

pnpm campaign move --campaign "high-risk payments" --mailbox pwp-2
pnpm mailbox rename payments jobs
pnpm mailbox unsuppress asicminermarket.com
```

The ramp can be set from Settings as well as the CLI; both go through `validateWarmup` so they cannot drift.

Inbound-mail alerts need `SLACK_WEBHOOK_URL` in `.env.local` (same channel as paymentswithpaul and webflux.ca).
Unset means no alerts; the worker still polls and files everything normally.

**NXDOMAIN is not proof a domain is gone.**
`check-mx` suppresses on it, and that reading can be wrong: asicminermarket.com returned NXDOMAIN on 2026-09-22, was auto-suppressed, and resolved normally with valid GoDaddy MX two days later.
`pnpm mailbox unsuppress` is the way back. Re-run `check-mx` before believing a dead verdict, and treat a single reading as a prompt to look rather than a conclusion.

## Mailbox routing

One address per kind of outreach, so a bad send in one cannot cost the other.

| Mailbox | Address | Sends |
|---|---|---|
| `jobs` | `paul.madut@icloud.com` | `fintech job search`, `fintech generic` |
| `pwp-1` | `paul@paulecom.com` | `payments generic cards on` |
| `pwp-2` | `paul@paulbuildsstores.com` | `high-risk payments`, `payments generic neutral`, `processor down` |

The two payments domains were registered 2026-09-22 and have no sending history, so both start on a ramp: `--from 5 --step 2` against a ceiling of 25.
The split is by volume rather than by vertical because a mailbox binds to a campaign, and every payments campaign carries a mix of peptide, kratom, THCA and adult prospects.

As of 2026-09-24 the routing above is live. `jobs` carries only job outreach, both fintech campaigns active with 31 queued.
The payments campaigns are bound to `pwp-1` and `pwp-2` and all four are paused, so their 92 queued messages wait for the domains to warm.

Twelve payments follow-ups remain on `jobs` and always will: their step 1 went out from iCloud, and `threadMailboxId` pins a reply to the address that started the conversation.
Paul chose to let those finish rather than abandon threads that are already open.

`pwp-1` is registered, authenticating and ramped, but **no campaign is bound to it yet**, because placement testing says it is not ready:

| Receiver | SPF | DKIM | DMARC | Placement |
|---|---|---|---|---|
| Gmail (`mx.google.com`) | pass | pass | pass | Spam |
| iCloud (`dmarc.icloud.com`) | pass | pass | pass | Junk |

Authentication is perfect at both and both filter it anyway, so this is domain reputation and content, not configuration.
`paulecom.com` was registered 2026-09-22 and has never sent anything.
Do not bind the 59-prospect campaign to it until a placement test comes back inbox at Gmail, which is where 54% of the list receives.

`pwp-2` is in the same position, measured 2026-09-24: SPF, DKIM and DMARC all pass at both receivers, INBOX at iCloud, **Spam at Gmail**.
That result also settles the long-open question about `paulbuildsstores.com` DKIM: Google is signing, so the "Start authentication" step in the admin console is done or was never needed.

Run `pnpm lint && pnpm typecheck && pnpm test` before anything that sends.

## Safety rails

- `OUTREACH_LIVE=1` is required before anything is delivered. Without it the worker claims, renders and logs but never opens an SMTP connection.
- `REDIRECT_ALL_TO` reroutes every send to one address, for end-to-end tests against a real mailbox.
- Passwords are app-specific passwords in the Keychain, read through `lib/mail/keychain.ts` with an absolute path to `/usr/bin/security`, because launchd runs with a minimal PATH.

## Pending configuration (ask Paul)

1. An app password for each of `paul@paulecom.com` and `paul@paulbuildsstores.com`, both under Keychain service `gmail-smtp-outreach`, keyed by address.
   Two-step verification has to be on for the account before Google offers one.
2. The physical mailing address for the footer.
   It is the payments campaigns that need it: those are plainly commercial mail.
   The two fintech campaigns are job outreach rather than advertising, which is a different category, so Paul decides whether to put an address on those too.
3. A seed inbox somewhere other than iCloud.
   The only seed today is the sending mailbox's own provider, so no receiver ever authenticates the message and SPF, DKIM and DMARC go unmeasured.
   A Gmail seed and an Outlook seed would make the test say something.
4. Whether Outlook is worth adding. Microsoft has been retiring basic auth, so a personal account may need OAuth rather than an app password. Verify before building it.
