"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { enrollAction, previewEnrollAction } from "../../actions";
import { Card, buttonClass, formatWhen } from "../../ui";
import { Field, inputClass } from "../form-bits";
import { cn } from "@/lib/utils";

type Preview = Awaited<ReturnType<typeof previewEnrollAction>>;

/**
 * Adding prospects to a campaign.
 *
 * Enrolling is the one action in this app that commits to emailing real
 * people, so it is deliberately two steps. The filter shows who it caught and
 * the text that caught them, the render shows the email one of them would
 * actually receive, and only then does the button say how many are going in.
 *
 * The exclude box is not an afterthought. Searching the research for
 * "unavailable" finds the stores whose card payments are down and also the one
 * announcing it is "processing payments again", which is the opposite
 * situation and the worst possible person to send this to.
 */
export function EnrollPanel({
  campaignId,
  canSend,
  blocker,
}: {
  campaignId: number;
  canSend: boolean;
  blocker: string | null;
}) {
  const router = useRouter();
  const [match, setMatch] = useState("");
  const [exclude, setExclude] = useState("");
  const [grade, setGrade] = useState("");
  const [limit, setLimit] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showSample, setShowSample] = useState(false);
  const [pending, startTransition] = useTransition();

  const filter = () => ({
    match: match.trim() || undefined,
    exclude: exclude.trim() || undefined,
    grade: grade || undefined,
    limit: limit ? Number(limit) : undefined,
  });

  function runPreview() {
    startTransition(async () => {
      const result = await previewEnrollAction(campaignId, filter());
      setPreview(result);
      if (result.error) toast.error("That pattern is not valid", { description: result.error });
    });
  }

  function commit() {
    if (!preview || preview.eligible === 0) return;

    startTransition(async () => {
      try {
        const result = await enrollAction(campaignId, filter());
        setPreview(null);
        toast.success(`Enrolled ${result.enrolled}`, {
          description: result.drafted
            ? `${result.drafted} drafts are waiting in the queue for you to approve.`
            : `Queued, first one ${formatWhen(result.firstSendAt)}.`,
        });
        router.push(`/queue?campaign=${campaignId}&status=draft`);
      } catch (error) {
        toast.error("Nothing was enrolled", { description: (error as Error).message });
      }
    });
  }

  return (
    <div className="space-y-4">
      {blocker && (
        <p className="rounded-sm bg-warn-soft px-3 py-2 text-[12px] text-warn">{blocker}</p>
      )}

      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-[13px] font-medium">Who goes in</h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
            Leave everything blank to consider every prospect with an email address. The two search
            boxes look through the vertical and every column of your sheet at once, so you can
            select on something written in the research rather than only on a column.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Research contains"
            hint="Plain words, or a regular expression."
          >
            <input
              value={match}
              onChange={(event) => setMatch(event.target.value)}
              placeholder="unavailable|temporarily down"
              className={cn(inputClass, "font-mono text-[12px]")}
            />
          </Field>

          <Field
            label="But not"
            hint="Checked after the one on the left. Use it to throw out the opposite case."
          >
            <input
              value={exclude}
              onChange={(event) => setExclude(event.target.value)}
              placeholder="payments again|now accepting"
              className={cn(inputClass, "font-mono text-[12px]")}
            />
          </Field>

          <Field label="Grade" hint="A goes first whatever you pick.">
            <select
              value={grade}
              onChange={(event) => setGrade(event.target.value)}
              className={inputClass}
            >
              <option value="">Any</option>
              <option value="A">A only</option>
              <option value="B">B only</option>
              <option value="C">C only</option>
            </select>
          </Field>

          <Field label="Stop after" hint="Optional. Useful for a first small batch.">
            <input
              type="number"
              min={1}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              placeholder="no limit"
              className={cn(inputClass, "nums")}
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={runPreview}
          disabled={pending}
          className={cn(buttonClass("secondary", "md"), "active:scale-[0.97]")}
        >
          {pending && !preview ? "Checking..." : "Show me who"}
        </button>
      </Card>

      {preview && !preview.error && (
        <div className="rise space-y-4">
          <Card className="p-4">
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
              <span className="text-[13px]">
                <span className="nums text-[19px]">{preview.eligible}</span> would be enrolled
              </span>
              <span className="text-[12px] text-muted">
                out of {preview.matched.length} matched, from {preview.considered} with an email
              </span>
            </div>

            {preview.eligible > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={commit}
                  disabled={pending || !canSend}
                  className={cn(buttonClass("primary", "md"), "active:scale-[0.97]")}
                >
                  {pending ? "Enrolling..." : `Enrol ${preview.eligible}`}
                </button>
                <span className="text-[12px] text-muted">
                  They become drafts. Nothing leaves until you approve them.
                </span>
              </div>
            )}
          </Card>

          {preview.sample && (
            <Card className="p-4">
              <button
                type="button"
                onClick={() => setShowSample((open) => !open)}
                className="flex w-full items-baseline justify-between text-left"
              >
                <span className="text-[13px] font-medium">
                  What {preview.sample.company} would receive
                </span>
                <span className="text-[11px] text-muted">{showSample ? "hide" : "show"}</span>
              </button>

              {showSample && (
                <div className="rise mt-3 rounded-sm border border-line bg-sunken/40 px-3 py-2.5">
                  <div className="text-[13px] font-medium">{preview.sample.subject}</div>
                  <p className="mt-2 whitespace-pre-wrap font-mono text-[12px] leading-[1.65] text-muted">
                    {preview.sample.body}
                  </p>
                </div>
              )}
            </Card>
          )}

          {preview.blocked.length > 0 && (
            <Card className="p-4">
              <h3 className="text-[13px] font-medium text-warn">
                {preview.blocked.length} cannot be sent to
              </h3>
              <p className="mt-0.5 text-[12px] text-muted">
                These are left out. Fix the template or the data and check again.
              </p>
              <ul className="mt-2 space-y-1">
                {preview.blocked.slice(0, 25).map((row, index) => (
                  <li key={`${row.company}-${index}`} className="text-[12px]">
                    <span className="font-medium">{row.company}</span>{" "}
                    <span className="text-muted">{row.reason}</span>
                  </li>
                ))}
              </ul>
              {preview.blocked.length > 25 && (
                <p className="mt-1.5 text-[11px] text-faint">
                  and {preview.blocked.length - 25} more
                </p>
              )}
            </Card>
          )}

          {preview.ineligible.length > 0 && <Skipped rows={preview.ineligible} />}

          {preview.matched.length > 0 && <Matched rows={preview.matched} />}
        </div>
      )}
    </div>
  );
}

/** Reasons, grouped, because 108 rows of "suppressed" is not worth reading. */
function Skipped({ rows }: { rows: { company: string; reason: string }[] }) {
  const [open, setOpen] = useState(false);

  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.reason.split(/[:.]/)[0].trim();
    groups.set(key, [...(groups.get(key) ?? []), row.company]);
  }

  return (
    <Card className="p-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-baseline justify-between text-left"
      >
        <span className="text-[13px] font-medium">{rows.length} skipped</span>
        <span className="text-[11px] text-muted">{open ? "hide" : "show"}</span>
      </button>

      <ul className="mt-2 space-y-1">
        {[...groups.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([reason, companies]) => (
            <li key={reason} className="text-[12px]">
              <span className="nums mr-2 inline-block w-8 text-right text-muted">
                {companies.length}
              </span>
              {reason}
              {open && (
                <span className="ml-1 text-[11px] text-faint">
                  {companies.slice(0, 12).join(", ")}
                  {companies.length > 12 ? ` and ${companies.length - 12} more` : ""}
                </span>
              )}
            </li>
          ))}
      </ul>
    </Card>
  );
}

/** The matched text itself, so a bad pattern is visible before it is used. */
function Matched({ rows }: { rows: { company: string; email: string; excerpt: string }[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Card className="p-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-baseline justify-between text-left"
      >
        <span className="text-[13px] font-medium">Why each one matched</span>
        <span className="text-[11px] text-muted">{open ? "hide" : "show"}</span>
      </button>

      {open && (
        <ul className="mt-2 max-h-80 space-y-1.5 overflow-y-auto">
          {rows.map((row) => (
            <li key={row.email} className="text-[12px]">
              <span className="font-medium">{row.company}</span>
              <span className="ml-1.5 font-mono text-[11px] text-faint">{row.email}</span>
              {row.excerpt && (
                <p className="mt-0.5 font-mono text-[11px] leading-relaxed text-muted">
                  ...{row.excerpt}...
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
