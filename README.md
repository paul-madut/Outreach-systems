# Outreach-systems

Cold outreach for business and job opportunities, sent from my own mailboxes, run entirely on my Mac.

Replaces the throwaway Python scripts and a full cold-email tool like Instantly.
The thing those scripts could not do is follow up safely: nothing read the inbox, so a second touch risked emailing somebody who had already replied.

## How it works

A SQLite file holds everything.
A worker wakes every ten minutes, sends whatever is due, and reads the mailbox for replies.
A dashboard on localhost is where drafts get reviewed and results get read.

```
Google Sheet ──(CSV export)──► import ──► outreach.db ◄── dashboard (localhost:3000)
                                              ▲
                                              │
                          launchd ──► worker ─┤─► SMTP  (send what is due)
                            (10 min)          └─► IMAP  (read replies, stop sequences)
```

Nothing sends unless `OUTREACH_LIVE=1`.
Without it the whole pipeline runs except the network call.

## Setup

```bash
pnpm install
cp .env.example .env.local
```

Store an app-specific password in the Keychain, then register the mailbox.
Both iCloud and Gmail need two-factor turned on before they will issue one.

```bash
security add-generic-password -s icloud-smtp-outreach -a you@icloud.com -w

pnpm mailbox add --label payments --provider icloud \
  --from "Your Name <you@icloud.com>" \
  --keychain-service icloud-smtp-outreach

pnpm mailbox check      # proves the password reads back
```

Seed the do-not-contact list, then import a sheet:

```bash
pnpm seed:suppressions                       # defaults to the existing exclude list
pnpm import:csv ~/Downloads/prospects.csv    # dry run, prints the column mapping
pnpm import:csv ~/Downloads/prospects.csv --commit
```

Run the dashboard, and schedule the worker:

```bash
pnpm dev                 # localhost:3000
pnpm schedule install    # launchd, every 10 minutes while the Mac is awake
```

## Importing sheets

Export one tab at a time from Google Sheets, then run `pnpm import:csv`.

Every column is mapped to something.
Recognised ones become typed fields; everything else becomes a merge field usable in a template straight away, so a column added to the sheet tomorrow needs no code change.

**Re-importing an expanded sheet updates rather than duplicates.**
Prospects key on domain, falling back to a slug of the company name for sheets without one.
Contacts key on email.
Row position is never used, so sorting or inserting rows changes nothing.
A blank cell never clears a value already stored, because the tool learns things the sheet does not know.

Both sheet shapes work with no configuration: one contact per row, or two per row via `Contact 1` / `C1 email` / `Contact 2` / `C2 email`.

## Templates

`{{field}}` resolves against the contact, the prospect, and every imported column.
`{{first_name|there}}` gives a fallback for role addresses.

An unresolved field fails the render rather than sending a placeholder.

A step whose templates are literally `{{subject}}` and `{{body}}` sends the message written per row in the sheet, so step 1 can be bespoke while steps 2 and 3 share a template.

Every rendered message is checked before it can be approved.
Em dashes, en dashes, unresolved fields, suppressed recipients and unbacked claims block sending.
Length, exclamation marks, semicolons and stock openers warn.

## Daily use

1. Research prospects in the sheet, export the tab, `pnpm import:csv --commit`.
2. Enrol contacts into a campaign. Each gets a jittered send time inside the sending window.
3. Review the drafts at `/queue` and approve in bulk.
4. The worker sends them, then queues each follow-up once the previous step actually goes out.
5. Replies, bounces and opt-outs stop sequences on their own. Read them at `/inbox`.

## Rules worth knowing

**At-most-once.**
SMTP and SQLite share no transaction, so a send whose outcome cannot be determined is parked as `uncertain` and waits for you rather than being retried.
A missed email costs a click. A duplicate costs a prospect.

**Auto-replies do not stop a sequence.**
Most recipients are `support@` addresses behind a helpdesk, and a ticket acknowledgement is not a human saying no.

**Pacing belongs to the mailbox, not the campaign.**
Two campaigns sharing a mailbox share its daily cap.

**A hard bounce suppresses the address. A soft bounce does not.**
Three hard bounces in a day pauses the mailbox.

**A reply stops that contact and their colleagues at the same company.**

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dashboard on localhost:3000 |
| `pnpm worker` | One pass: send what is due, then poll for replies |
| `pnpm import:csv <file>` | Import a sheet export. Add `--commit` to write |
| `pnpm mailbox list\|add\|check\|pause\|resume` | Manage sending identities |
| `pnpm campaign list\|create\|step\|preview\|enroll\|activate\|pause` | Build and run a sequence |

`campaign preview` and `campaign enroll` take `--match` and `--not-match`, which filter prospects by a regex over their research text. That is how a segment like "their processor is down right now" gets selected, since the state lives in free text rather than in a column. See `templates/processor-down/README.md`.
| `pnpm seed:suppressions [file]` | Load a domain exclude list |
| `pnpm schedule install\|status\|uninstall` | The launchd job |
| `pnpm demo:seed` | Fill a throwaway database so the dashboard has something in it |
| `pnpm test` / `pnpm lint` / `pnpm typecheck` | Checks |

## Limits

Sends only while the Mac is awake. `caffeinate` keeps it from sleeping mid-send but will not wake a closed laptop, so a scheduled morning send needs the lid open.

One worker at a time, enforced by a PID-aware lock that breaks itself if the recorded process is gone.

Plain text only. No open or click tracking, and no HTML.

Outlook is not supported yet: Microsoft has been retiring basic auth and a personal account may need OAuth rather than an app password.
