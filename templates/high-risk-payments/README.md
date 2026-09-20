# High-risk payments campaign

Built on a pattern-interrupt structure: name the pain before saying who you are, ask whether it is actually their situation, then make a small ask.

```bash
pnpm campaign create --name "high-risk payments" --mailbox payments \
  --footer-file templates/high-risk-payments/footer.txt

pnpm campaign step --campaign "high-risk payments" --step 1 \
  --subject "Quick question about {{company}}" \
  --body-file templates/high-risk-payments/step1.txt

pnpm campaign step --campaign "high-risk payments" --step 2 --delay 4 \
  --subject "threaded" --body-file templates/high-risk-payments/step2.txt

pnpm campaign step --campaign "high-risk payments" --step 3 --delay 6 \
  --subject "threaded" --body-file templates/high-risk-payments/step3.txt

pnpm campaign preview --campaign "high-risk payments"
```

Steps 2 and 3 thread onto step 1, so their subject is replaced with `Re: <step 1 subject>` and the one given here is ignored.

## What changed from the source template, and why

The original had "the last 5 {jobtitle} I've connected with mentioned how they {painpoint}".
That is social proof, and it is not true: those conversations have not happened.
`COLD-EMAIL-BRIEF.md` lists exactly this kind of invented proof under "What he must never say", and the linter blocks the specific phrases that came out of the last rewrite.

What is true is that roughly 150 of these stores have been researched, and nearly all of them are running without a card rail.
So the line became "nearly every {{vertical}} store I look at is running without a card rail", which does the same work and survives being questioned.

The ask also changed. The original offers a short video. There is no video.
The close that actually earned a reply in September was an offer to go through the rest of the site and report what an underwriter would flag, which costs nothing to promise and is worth something to receive.

## The research line

The quote is the proof the email rests on, so it is included when it exists and dropped cleanly when it does not:

```
{{#verbatim_quote_the_hook_first}}
Your own page is what made me look. It says "{{verbatim_quote_the_hook_first}}".
{{/verbatim_quote_the_hook_first}}
```

`_first` is a derived field holding the first sentence or two of a long value, cut at a sentence boundary and marked with an ellipsis.
The newer research quotes run to 400 characters, and dropping one in whole pushed these emails past 190 words.
Using the shortened form took the number over the length target from 11 of 17 down to 4.

The inverted section after it falls back to the full quote when there is nothing to shorten.

## Length

The target is 120 words, not counting the footer.
Prospects with a long quote still go over, and that warning is the signal to trim the quote in the review queue rather than something to switch off.
