"use client";

import { useMemo, useState } from "react";
import type { MergeField } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Card, buttonClass } from "../ui";

/** Shared form pieces for creating and editing a campaign. */

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-[12px] font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-sm border border-line bg-surface px-2.5 py-1.5 text-[13px] " +
  "transition-colors duration-150 ease-[var(--ease-out-quick)] " +
  "hover:border-line-strong focus:border-accent focus:outline-none";

const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

/**
 * Which weekdays may send.
 *
 * Deselecting everything is prevented here rather than reported after saving,
 * because a campaign with no send days accepts enrollments and then silently
 * never sends them, which looks exactly like the worker being broken.
 */
export function DayPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (days: number[]) => void;
}) {
  return (
    <div className="flex gap-1">
      {DAYS.map((day) => {
        const on = value.includes(day.value);
        const last = on && value.length === 1;

        return (
          <button
            key={day.value}
            type="button"
            title={last ? "At least one day has to stay selected." : undefined}
            onClick={() => {
              if (last) return;
              onChange(
                on
                  ? value.filter((d) => d !== day.value)
                  : [...value, day.value].sort((a, b) => a - b)
              );
            }}
            className={cn(
              "rounded-sm border px-2 py-1 text-[12px]",
              "transition-[background-color,border-color,transform] duration-150 ease-[var(--ease-out-quick)]",
              "active:scale-[0.97]",
              on
                ? "border-ink bg-ink text-canvas"
                : "border-line text-muted hover:border-line-strong hover:text-ink",
              last && "cursor-not-allowed opacity-80"
            )}
          >
            {day.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The fields a template can use, with how many prospects actually have each.
 *
 * The fill rate is the whole point. A field only 3 of 152 prospects have will
 * fail to render for everyone else, and that is a thing you want to know while
 * writing the email, not at enrollment after it is written. Clicking one
 * copies it, because retyping `{{verbatim_quote_the_hook_first}}` by hand is
 * how typos get into every message at once.
 */
export function MergeFields({
  fields,
  used,
}: {
  fields: MergeField[];
  used: Set<string>;
}) {
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return fields.filter((field) => !needle || field.key.includes(needle));
  }, [fields, query]);

  async function copy(key: string) {
    const token = `{{${key}}}`;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
    } catch {
      // Clipboard access can be refused; the token is on screen either way.
    }
  }

  return (
    <Card className="p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-[12px] font-medium">Fields you can use</h3>
        <span className="text-[11px] text-faint">click to copy</span>
      </div>

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter"
        className={cn(inputClass, "mb-2 py-1 text-[12px]")}
      />

      <ul className="max-h-[420px] space-y-px overflow-y-auto">
        {shown.map((field) => {
          const rate = field.total > 0 ? field.filled / field.total : 0;
          const thin = rate < 0.9;

          return (
            <li key={field.key}>
              <button
                type="button"
                onClick={() => copy(field.key)}
                title={field.example ? `e.g. ${field.example}` : field.source}
                className={cn(
                  "group flex w-full items-baseline gap-2 rounded-sm px-1.5 py-1 text-left",
                  "transition-colors duration-150 hover:bg-raised"
                )}
              >
                <span
                  className={cn(
                    "font-mono text-[11px]",
                    used.has(field.key) ? "text-accent" : "text-ink"
                  )}
                >
                  {copied === field.key ? "copied" : field.key}
                </span>
                <span
                  className={cn(
                    "nums ml-auto shrink-0 text-[10px]",
                    thin ? "text-warn" : "text-faint"
                  )}
                >
                  {field.filled}/{field.total}
                </span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="px-1.5 py-2 text-[11px] text-muted">Nothing matches.</li>
        )}
      </ul>

      <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-muted">
        A field that not everyone has will stop those prospects from being enrolled, and they are
        listed by name before anything is sent. Wrap it in{" "}
        <code className="font-mono">{"{{#field}}...{{/field}}"}</code> to include that part only
        when there is a value.
      </p>
    </Card>
  );
}

/** A subject and body pair, with live word count and field highlighting. */
export function StepFields({
  subject,
  body,
  onSubject,
  onBody,
  maxWords,
}: {
  subject: string;
  body: string;
  onSubject: (value: string) => void;
  onBody: (value: string) => void;
  maxWords: number;
}) {
  const words = body.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="space-y-3">
      <Field label="Subject" hint="Follow-ups reuse step 1's subject with Re: in front.">
        <input
          value={subject}
          onChange={(event) => onSubject(event.target.value)}
          placeholder="Quick question about {{company_short}}"
          className={cn(inputClass, "font-mono text-[12px]")}
        />
      </Field>

      <Field label="Body">
        <textarea
          value={body}
          onChange={(event) => onBody(event.target.value)}
          rows={16}
          spellCheck
          placeholder={"Might not be relevant {{first_name}}, but ..."}
          className={cn(inputClass, "resize-y font-mono text-[12px] leading-[1.65]")}
        />
        <span className="mt-1 flex items-center justify-between text-[11px] text-muted">
          <span>Plain text. Line breaks land exactly as you type them.</span>
          <span className={cn("nums", words > maxWords && "text-warn")}>
            {words} words{words > maxWords ? `, over ${maxWords}` : ""}
          </span>
        </span>
      </Field>
    </div>
  );
}

export function SubmitButton({
  pending,
  children,
  pendingLabel,
  disabled,
}: {
  pending: boolean;
  children: React.ReactNode;
  pendingLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className={cn(buttonClass("primary", "md"), "active:scale-[0.97]")}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
