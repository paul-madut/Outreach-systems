"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { MailboxOption, MergeField } from "@/lib/queries";
import { referencedFields } from "@/lib/template/render";
import { createCampaignAction } from "../../actions";
import { Card, LinkButton } from "../../ui";
import { cn } from "@/lib/utils";
import {
  DayPicker,
  Field,
  FieldGroup,
  MergeFields,
  StepFields,
  SubmitButton,
  inputClass,
} from "../form-bits";

export interface Starter {
  name: string;
  body: string;
  footer: string | null;
}

/**
 * Creating a campaign.
 *
 * Step 1 is part of this form rather than a later screen, because a campaign
 * without it is inert and the only way to find that out is to try to enrol
 * somebody. Everything on this page can be changed afterwards, which the
 * subtitle says, so the form never has to feel like a commitment.
 */
export function NewCampaignForm({
  mailboxes,
  fields,
  starters,
}: {
  mailboxes: MailboxOption[];
  fields: MergeField[];
  starters: Starter[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [mailboxId, setMailboxId] = useState(mailboxes[0].id);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("16:00");
  const [sendDays, setSendDays] = useState([1, 2, 3, 4, 5]);
  const [newPerDay, setNewPerDay] = useState(10);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");

  const mailbox = mailboxes.find((box) => box.id === mailboxId)!;
  const used = useMemo(
    () => new Set(referencedFields(`${subject}\n${body}`)),
    [subject, body]
  );

  const known = useMemo(() => new Set(fields.map((field) => field.key)), [fields]);
  const unknown = [...used].filter((field) => !known.has(field));

  const ready = name.trim() && subject.trim() && body.trim();
  const windowValid = windowStart < windowEnd;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || !windowValid) return;

    startTransition(async () => {
      try {
        const { campaignId } = await createCampaignAction({
          mailboxId,
          name: name.trim(),
          description: description.trim(),
          windowStart,
          windowEnd,
          sendDays,
          newPerDay,
          subject: subject.trim(),
          body: body.trimEnd(),
          footer: footer.trim(),
        });

        toast.success(`Created "${name.trim()}"`, {
          description: "Nothing sends yet. Enrol some prospects, then activate it.",
        });
        router.push(`/campaigns/${campaignId}`);
      } catch (error) {
        toast.error("Could not create it", { description: (error as Error).message });
      }
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-5 lg:grid-cols-[1fr_260px]">
      <div className="space-y-5">
        <Card className="space-y-4 p-4">
          <h2 className="text-[12px] uppercase tracking-wide text-faint">What and where from</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="Only you see this.">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="high-risk payments"
                className={inputClass}
                autoFocus
              />
            </Field>

            <Field
              label="Send from"
              hint={`${mailbox.fromEmail} · up to ${mailbox.dailyCap} a day across every campaign`}
            >
              <select
                value={mailboxId}
                onChange={(event) => setMailboxId(Number(event.target.value))}
                className={inputClass}
              >
                {mailboxes.map((box) => (
                  <option key={box.id} value={box.id}>
                    {box.label} ({box.fromEmail})
                    {box.status !== "active" ? ` - ${box.status}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Note" hint="Optional. What this campaign is for, in your own words.">
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Stores whose card payments are currently off"
              className={inputClass}
            />
          </Field>
        </Card>

        <Card className="space-y-4 p-4">
          <h2 className="text-[12px] uppercase tracking-wide text-faint">When it sends</h2>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="From" hint={mailbox.timezone}>
              <input
                type="time"
                value={windowStart}
                onChange={(event) => setWindowStart(event.target.value)}
                className={cn(inputClass, "nums")}
              />
            </Field>
            <Field label="Until">
              <input
                type="time"
                value={windowEnd}
                onChange={(event) => setWindowEnd(event.target.value)}
                className={cn(inputClass, "nums", !windowValid && "border-danger")}
              />
            </Field>
            <Field label="New prospects a day" hint="Spread at random inside the window.">
              <input
                type="number"
                min={1}
                max={mailbox.dailyCap}
                value={newPerDay}
                onChange={(event) => setNewPerDay(Math.max(1, Number(event.target.value) || 1))}
                className={cn(inputClass, "nums")}
              />
            </Field>
          </div>

          {!windowValid && (
            <p className="rounded-sm bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">
              The end of the window has to be after the start.
            </p>
          )}

          {newPerDay > mailbox.dailyCap && (
            <p className="rounded-sm bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
              {mailbox.label} is capped at {mailbox.dailyCap} a day, so the rest will spill into the
              following day.
            </p>
          )}

          <FieldGroup label="Days">
            <DayPicker value={sendDays} onChange={setSendDays} />
          </FieldGroup>
        </Card>

        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[12px] uppercase tracking-wide text-faint">The first email</h2>
            {starters.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted">
                start from
                {starters.map((starter) => (
                  <button
                    key={starter.name}
                    type="button"
                    onClick={() => {
                      setBody(starter.body);
                      if (starter.footer) setFooter(starter.footer);
                      if (!name) setName(starter.name.replace(/-/g, " "));
                      toast(`Loaded ${starter.name}`, {
                        description: "From templates/ on disk. Edit it here freely.",
                      });
                    }}
                    className="rounded-xs border border-line px-1.5 py-0.5 font-mono text-[11px] transition-colors hover:border-line-strong hover:bg-raised"
                  >
                    {starter.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <StepFields
            subject={subject}
            body={body}
            onSubject={setSubject}
            onBody={setBody}
            maxWords={120}
          />

          {unknown.length > 0 && (
            <p className="rounded-sm bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
              Nothing in your data fills {unknown.map((field) => `{{${field}}}`).join(", ")}. Any
              prospect without it will be left out, by name, before anything sends.
            </p>
          )}

          <Field
            label="Footer"
            hint="Added to every email. This is where the opt-out line and your address go."
          >
            <textarea
              value={footer}
              onChange={(event) => setFooter(event.target.value)}
              rows={3}
              className={cn(inputClass, "resize-y font-mono text-[12px]")}
            />
          </Field>
        </Card>

        <div className="flex items-center gap-2">
          <SubmitButton pending={pending} pendingLabel="Creating..." disabled={!ready || !windowValid}>
            Create campaign
          </SubmitButton>
          <LinkButton href="/campaigns" size="md">
            Cancel
          </LinkButton>
          {!ready && (
            <span className="text-[12px] text-muted">
              Needs a name, a subject and a body.
            </span>
          )}
        </div>
      </div>

      <aside className="lg:sticky lg:top-[110px] lg:self-start">
        <MergeFields fields={fields} used={used} />
      </aside>
    </form>
  );
}
