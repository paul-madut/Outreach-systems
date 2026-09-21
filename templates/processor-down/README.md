# Processor down

A separate campaign for stores whose payments are broken right now, rather than stores that never took cards.

The distinction matters more than any vertical. These prospects are not being sold on the idea of card payments, they already had them and lost them. They are losing orders today, they are probably already looking for a fix, and their real fear is that the replacement gets pulled too. So the pitch is speed plus durability, not persuasion.

## Building the segment

The state only exists in the free text of the research columns, so it is selected by matching against it:

```bash
DOWN='temporarily unavailable|currently unavailable|currently down|unable to accept orders|not currently accepting|cannot accept debit or credit|suspended our account|has suspended|switched our reserve|working on getting this resolved|while we upgrade|looking to have a new payment processor'
NOTDOWN='processing online payments again|accepting cards again'

pnpm campaign preview --campaign "processor down" --match "$DOWN" --not-match "$NOTDOWN"
pnpm campaign enroll  --campaign "processor down" --match "$DOWN" --not-match "$NOTDOWN" --commit
```

**Always preview first.** The pattern is a guess about language, and it gets things wrong in both directions.

`--not-match` is doing real work here. Searching for "unavailable" also finds the store announcing it is "processing online payments again", which is the opposite situation and the worst possible email to send them.

The match pattern is deliberately narrow on one point. An early version used a bare "unable to accept", which pulled in a kratom store whose page said "Kratom companies are considered High Risk, therefore unable to accept credit and debit like other companies". That is a permanent category statement, not an outage, and it belongs in the main campaign. Outages carry a temporal marker (temporarily, currently, while we, at this time) or name a specific event (suspended our account, switched our reserve). The pattern only matches those.

## Setup

```bash
pnpm campaign create --name "processor down" --mailbox payments --per-day 5 \
  --footer-file templates/processor-down/footer.txt

pnpm campaign step --campaign "processor down" --step 1 \
  --subject "{{company_short}} checkout" --body-file templates/processor-down/step1.txt

pnpm campaign step --campaign "processor down" --step 2 --delay 3 \
  --subject threaded --body-file templates/processor-down/step2.txt

pnpm campaign step --campaign "processor down" --step 3 --delay 5 \
  --subject threaded --body-file templates/processor-down/step3.txt
```

`--per-day 5` rather than 10. The segment is small and worth watching closely.

Follow-ups are 3 and 5 days rather than 4 and 6, because the situation resolves one way or another quickly. A follow-up two weeks later is about something that is already over.

## Why "if that is still up"

Research goes stale. A store that was down when it was looked at may be fixed by the time the email lands, and asserting it is still broken would be both wrong and insulting.

The conditional is honest, it keeps the urgency, and a reply of "we fixed it last week" is still a reply from someone who now knows who you are.

## Known rough edge

Cenexa Labs matches on "switched our reserve from 10% to 100%", which is a different problem: they are still processing, they just are not being paid. The line "every day of it is orders you do not get back" does not fit them. Worth hand-editing in the review queue, or moving to the main campaign.
