# Fintech job search

Cold outreach to fintech companies about engineering roles, from Paul's own
address. Separate from the payments campaigns in every way except the mailbox,
which they share along with its 20-a-day cap.

## How this campaign is built

Step 1 is literally `{{subject}}` and `{{body}}`. There is no shared template,
because a job email that could have been sent to anyone gets deleted. Each
prospect carries its own rendered copy, written against research on that one
company, and step 1 just emits it.

That means **a draft must be fully literal**. A merge field left inside a
stored body is not resolved a second time; it reaches the linter as an
unresolved field and blocks the send. Found the hard way.

Step 2 is shared, because a follow-up should be short and say nothing new.
Seven days, threaded, one only. That is Paul's own rule from
`~/Desktop/job-hunt-2027/templates.md`, which also sets the rest of the shape:
name the exact role, stay under 90 words, ask one specific thing, and never
ask for a job. The ask is a conversation or a referral.

## Writing a batch

1. Research each company first, and verify every fact against a primary source.
   Half of the first 24 turned out to be unsendable: roles that were 410 Gone,
   a PERM immigration posting, a business line that had been sold, a job board
   returning an empty array, and four that were US-only.
2. Write the copy. No em or en dashes, no stock openers, no merge fields.
3. Save it as a CSV with `Company,Subject,Body` and import it. The importer
   matches on company name and updates rather than duplicating, so the drafts
   land on the existing prospects.
4. Enrol the addresses, read what rendered, then approve.

`drafts-2026-09-21.csv` is the first batch, kept so the wording and the
research that produced it stay together.
