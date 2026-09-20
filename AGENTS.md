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
| `lib/mail/` | SMTP and IMAP, Keychain, inbound classification, DSN parsing, reply matching. The classify and match halves are pure. |
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

**No em dashes, and no en dashes either.**
Paul's global rule, enforced in code: the linter blocks both U+2014 and U+2013 in any outgoing message.

## Commands

```
pnpm dev
pnpm test
pnpm lint
pnpm typecheck
```

Run `pnpm lint && pnpm typecheck && pnpm test` before anything that sends.

## Safety rails

- `OUTREACH_LIVE=1` is required before anything is delivered. Without it the worker claims, renders and logs but never opens an SMTP connection.
- `REDIRECT_ALL_TO` reroutes every send to one address, for end-to-end tests against a real mailbox.
- Passwords are app-specific passwords in the Keychain, read through `lib/mail/keychain.ts` with an absolute path to `/usr/bin/security`, because launchd runs with a minimal PATH.

## Pending configuration (ask Paul)

1. The Gmail app password, stored in the Keychain alongside the iCloud one.
2. The physical mailing address for the footer.
3. Whether Outlook is worth adding. Microsoft has been retiring basic auth, so a personal account may need OAuth rather than an app password. Verify before building it.
