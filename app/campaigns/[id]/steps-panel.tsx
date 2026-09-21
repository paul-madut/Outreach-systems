"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CampaignDetail, MergeField, StepDetail } from "@/lib/queries";
import { referencedFields } from "@/lib/template/render";
import { deleteStepAction, saveStepAction } from "../../actions";
import { Badge, Card, buttonClass } from "../../ui";
import { Field, MergeFields, StepFields, inputClass } from "../form-bits";
import { cn } from "@/lib/utils";

/**
 * The sequence, one card per step.
 *
 * Follow-ups are not scheduled when a prospect is enrolled. Step 2 is created
 * only when step 1 has actually been sent, and its delay counts from that real
 * send, so a paused campaign can never produce a follow-up that arrives before
 * the email it follows up on. The card says so, because "+3 days" is otherwise
 * ambiguous and the difference matters.
 */
export function StepsPanel({
  campaign,
  fields,
}: {
  campaign: CampaignDetail;
  fields: MergeField[];
}) {
  const nextNumber = (campaign.steps.at(-1)?.stepNumber ?? 0) + 1;
  const [adding, setAdding] = useState(false);

  const used = useMemo(
    () =>
      new Set(
        campaign.steps.flatMap((step) => referencedFields(`${step.subject}\n${step.body}`))
      ),
    [campaign.steps]
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
      <div className="space-y-3">
        {campaign.steps.length === 0 && !adding && (
          <Card className="px-6 py-10 text-center">
            <p className="text-sm font-medium">No steps yet.</p>
            <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-muted">
              A campaign with no step 1 accepts nobody, because there is nothing to send them.
            </p>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className={cn(buttonClass("primary", "md"), "mt-4")}
            >
              Write step 1
            </button>
          </Card>
        )}

        {campaign.steps.map((step) => (
          <StepCard key={step.stepNumber} campaign={campaign} step={step} fields={fields} />
        ))}

        {adding && (
          <StepCard
            campaign={campaign}
            fields={fields}
            step={{
              id: 0,
              stepNumber: nextNumber,
              delayDays: nextNumber === 1 ? 0 : 3,
              subject: nextNumber === 1 ? "" : campaign.steps[0]?.subject ?? "",
              body: "",
              sameThread: nextNumber > 1,
              fields: [],
              unknownFields: [],
              sent: 0,
              drafts: 0,
              scheduled: 0,
            }}
            startOpen
            onCancel={() => setAdding(false)}
          />
        )}

        {!adding && campaign.steps.length > 0 && campaign.steps.length < 3 && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={cn(
              "w-full rounded-md border border-dashed border-line px-4 py-3 text-[13px] text-muted",
              "transition-colors duration-150 hover:border-line-strong hover:bg-raised/40 hover:text-ink"
            )}
          >
            Add step {nextNumber}
            <span className="ml-2 text-[11px] text-faint">
              sent only to prospects who never replied
            </span>
          </button>
        )}

        {campaign.steps.length >= 3 && (
          <p className="px-1 text-[11px] text-faint">
            Three is the limit. A fourth email to someone who has ignored three is not a
            follow-up.
          </p>
        )}
      </div>

      <aside className="lg:sticky lg:top-[110px] lg:self-start">
        <MergeFields fields={fields} used={used} />
      </aside>
    </div>
  );
}

function StepCard({
  campaign,
  step,
  fields,
  startOpen,
  onCancel,
}: {
  campaign: CampaignDetail;
  step: StepDetail;
  fields: MergeField[];
  startOpen?: boolean;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(Boolean(startOpen));
  const [subject, setSubject] = useState(step.subject);
  const [body, setBody] = useState(step.body);
  const [delayDays, setDelayDays] = useState(step.delayDays);
  const [pending, startTransition] = useTransition();

  const dirty =
    subject !== step.subject || body !== step.body || delayDays !== step.delayDays;

  const known = useMemo(() => new Set(fields.map((field) => field.key)), [fields]);
  const unknown = useMemo(
    () => referencedFields(`${subject}\n${body}`).filter((field) => !known.has(field)),
    [subject, body, known]
  );

  function save() {
    if (!subject.trim() || !body.trim()) {
      toast.error("A step needs a subject and a body");
      return;
    }

    startTransition(async () => {
      try {
        await saveStepAction({
          campaignId: campaign.id,
          stepNumber: step.stepNumber,
          subject: subject.trim(),
          body: body.trimEnd(),
          delayDays,
          sameThread: step.stepNumber > 1,
        });
        toast.success(`Step ${step.stepNumber} saved`, {
          description:
            step.drafts > 0
              ? `${step.drafts} drafts already written keep their old wording. Cancel them to re-render.`
              : "It applies to everyone enrolled from now on.",
        });
        setOpen(false);
        onCancel?.();
        router.refresh();
      } catch (error) {
        toast.error("Not saved", { description: (error as Error).message });
      }
    });
  }

  function remove() {
    startTransition(async () => {
      try {
        await deleteStepAction(campaign.id, step.stepNumber);
        toast.success(`Step ${step.stepNumber} removed`);
        router.refresh();
      } catch (error) {
        toast.error("Kept", { description: (error as Error).message });
      }
    });
  }

  return (
    <Card className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">Step {step.stepNumber}</span>

        <Badge>
          {step.stepNumber === 1
            ? "first touch"
            : `${step.delayDays} days after step ${step.stepNumber - 1} actually sends`}
        </Badge>

        {step.stepNumber > 1 && <Badge>same thread</Badge>}

        {step.sent > 0 && (
          <span className="nums text-[11px] text-muted">sent {step.sent}</span>
        )}
        {step.drafts > 0 && (
          <span className="nums text-[11px] text-muted">{step.drafts} in review</span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {step.unknownFields.length > 0 && !open && (
            <span className="text-[11px] text-warn">
              {step.unknownFields.length} unknown field
              {step.unknownFields.length === 1 ? "" : "s"}
            </span>
          )}
          <button
            type="button"
            onClick={() => (open && onCancel ? onCancel() : setOpen((value) => !value))}
            className={buttonClass("secondary")}
          >
            {open ? (dirty ? "Discard" : "Close") : "Edit"}
          </button>
          {!open && step.sent === 0 && step.id !== 0 && (
            <button type="button" onClick={remove} className={buttonClass("ghost")}>
              Remove
            </button>
          )}
        </div>
      </div>

      {!open && (
        <div className="mt-2">
          <div className="font-mono text-[12px]">{step.subject || "no subject yet"}</div>
          <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap font-mono text-[11px] leading-[1.6] text-muted">
            {step.body}
          </p>
        </div>
      )}

      {open && (
        <div className="rise mt-3 space-y-3">
          {step.stepNumber > 1 && (
            <Field
              label="Wait this many days"
              hint="Counted from when the previous step really sent, not from enrollment."
            >
              <input
                type="number"
                min={1}
                max={30}
                value={delayDays}
                onChange={(event) => setDelayDays(Math.max(1, Number(event.target.value) || 1))}
                className={cn(inputClass, "nums w-28")}
              />
            </Field>
          )}

          <StepFields
            subject={subject}
            body={body}
            onSubject={setSubject}
            onBody={setBody}
            maxWords={campaign.maxWords}
          />

          {unknown.length > 0 && (
            <p className="rounded-sm bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
              Nothing in your data fills {unknown.map((field) => `{{${field}}}`).join(", ")}.
              Prospects without it are left out by name rather than sent a gap.
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending || !dirty}
              className={cn(buttonClass("primary"), "active:scale-[0.97]")}
            >
              {pending ? "Saving..." : "Save"}
            </button>
            {step.sent > 0 && (
              <span className="text-[11px] text-muted">
                The {step.sent} already sent are not changed.
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
