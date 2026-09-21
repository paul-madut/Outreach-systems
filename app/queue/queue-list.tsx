"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import type { QueueRow } from "@/lib/queries";
import type { LintFinding } from "@/lib/template/lint";
import {
  approveMessages,
  cancelMessage,
  resolveUncertain,
  retryFailed,
  saveDraft,
} from "../actions";
import { cn } from "@/lib/utils";
import { Badge, Card, StatusBadge, buttonClass, formatWhen } from "../ui";

/**
 * The review queue.
 *
 * This is the screen that gets used every day, and the job on it is repetitive:
 * read an email, decide, move on. So it is built to be driven from the
 * keyboard, shows the whole message without opening anything, and acknowledges
 * every action immediately.
 *
 * Approving is optimistic. The row lifts out under your cursor and the toast
 * confirms afterwards, because waiting on a round trip for something that
 * almost always succeeds makes bulk review feel broken. A failure puts the row
 * back with the reason attached.
 */
export function QueueList({ rows }: { rows: QueueRow[] }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [findings, setFindings] = useState<Map<number, LintFinding[]>>(new Map());
  /** Approved locally and already removed from view, ahead of the server. */
  const [settled, setSettled] = useState<Set<number>>(new Set());
  const [pending, startTransition] = useTransition();

  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const visible = useMemo(() => rows.filter((row) => !settled.has(row.id)), [rows, settled]);
  const drafts = useMemo(() => visible.filter((row) => row.status === "draft"), [visible]);
  const allSelected = drafts.length > 0 && drafts.every((row) => selected.has(row.id));
  const current = visible[Math.min(cursor, visible.length - 1)];

  const approve = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;

      // Out of the list immediately. The list is long and the answer is almost
      // always yes, so waiting on the server makes bulk review feel stuck.
      setSettled((done) => new Set([...done, ...ids]));
      setSelected(new Set());

      startTransition(async () => {
        const result = await approveMessages(ids);

        if (result.blocked.length > 0) {
          const blockedIds = result.blocked.map((entry) => entry.messageId);
          setSettled((done) => {
            const next = new Set(done);
            for (const id of blockedIds) next.delete(id);
            return next;
          });
          setFindings(new Map(result.blocked.map((entry) => [entry.messageId, entry.findings])));
        }

        if (result.approved > 0) {
          toast.success(
            `${result.approved} queued to send`,
            result.blocked.length > 0
              ? { description: `${result.blocked.length} held back, see below.` }
              : { description: "They go out at their own times, inside the sending window." }
          );
        }
        if (result.blocked.length > 0 && result.approved === 0) {
          toast.error(`${result.blocked.length} cannot send yet`, {
            description: "The reason is on each one.",
          });
        }
      });
    },
    []
  );

  const cancel = useCallback((id: number, company: string) => {
    setSettled((done) => new Set([...done, id]));
    startTransition(async () => {
      await cancelMessage(id);
      toast(`Cancelled ${company}`, { description: "It will not be sent." });
    });
  }, []);

  // --- keyboard ------------------------------------------------------------

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (visible.length === 0) return;

      const move = (delta: number) => {
        event.preventDefault();
        setCursor((index) => {
          const next = Math.max(0, Math.min(visible.length - 1, index + delta));
          rowRefs.current.get(visible[next]?.id)?.scrollIntoView({
            block: "nearest",
            behavior: "smooth",
          });
          return next;
        });
      };

      switch (event.key) {
        case "j":
        case "ArrowDown":
          return move(1);
        case "k":
        case "ArrowUp":
          return move(-1);
        case "x":
          if (current?.status === "draft") {
            event.preventDefault();
            setSelected((set) => {
              const next = new Set(set);
              if (next.has(current.id)) next.delete(current.id);
              else next.add(current.id);
              return next;
            });
          }
          return;
        case "a":
          if (current?.status === "draft") {
            event.preventDefault();
            approve([current.id]);
          }
          return;
        case "A":
          event.preventDefault();
          setSelected(allSelected ? new Set() : new Set(drafts.map((row) => row.id)));
          return;
        case "e":
          if (current?.status === "draft") {
            event.preventDefault();
            setEditing(current.id);
          }
          return;
        case "c":
          if (current && (current.status === "draft" || current.status === "scheduled")) {
            event.preventDefault();
            cancel(current.id, current.company);
          }
          return;
        case "Enter":
          if (selected.size > 0) {
            event.preventDefault();
            approve([...selected]);
          }
          return;
        case "Escape":
          setSelected(new Set());
          setEditing(null);
          return;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, current, drafts, allSelected, selected, approve, cancel]);

  if (visible.length === 0) {
    return (
      <Card className="px-6 py-12 text-center">
        <p className="text-sm font-medium">All clear.</p>
        <p className="mx-auto mt-1.5 max-w-md text-[13px] text-muted">
          Everything here has been dealt with.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-2.5">
      {drafts.length > 0 && (
        <Card className="sticky top-[53px] z-20 flex flex-wrap items-center gap-3 px-4 py-2.5">
          <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() =>
                setSelected(allSelected ? new Set() : new Set(drafts.map((row) => row.id)))
              }
              className="size-3.5 accent-[var(--color-accent)]"
            />
            Select all {drafts.length}
          </label>

          <button
            type="button"
            disabled={selected.size === 0 || pending}
            onClick={() => approve([...selected])}
            className={buttonClass("primary")}
          >
            Approve{selected.size > 0 ? ` ${selected.size}` : ""}
            <kbd className="ml-1 font-mono opacity-60">↵</kbd>
          </button>

          <p className="text-[11px] text-muted">
            Approving queues a message. It still waits for its own send time.
          </p>

          <span className="ml-auto hidden text-[11px] text-faint sm:block">
            <kbd className="font-mono">j</kbd> <kbd className="font-mono">k</kbd> move ·{" "}
            <kbd className="font-mono">a</kbd> approve · <kbd className="font-mono">?</kbd> all keys
          </span>
        </Card>
      )}

      {visible.map((row, index) => (
        <MessageCard
          key={row.id}
          row={row}
          index={index}
          focused={index === cursor}
          selected={selected.has(row.id)}
          editing={editing === row.id}
          findings={findings.get(row.id)}
          registerRef={(node) => {
            if (node) rowRefs.current.set(row.id, node);
            else rowRefs.current.delete(row.id);
          }}
          onFocus={() => setCursor(index)}
          onToggle={() =>
            setSelected((set) => {
              const next = new Set(set);
              if (next.has(row.id)) next.delete(row.id);
              else next.add(row.id);
              return next;
            })
          }
          onApprove={() => approve([row.id])}
          onCancel={() => cancel(row.id, row.company)}
          onEdit={() => setEditing(editing === row.id ? null : row.id)}
          onResolve={(outcome) =>
            startTransition(async () => {
              await resolveUncertain(row.id, outcome);
              toast.success(
                outcome === "sent" ? "Recorded as sent" : "Back in the queue",
                {
                  description:
                    outcome === "sent"
                      ? "The follow-up will be scheduled from now."
                      : "It will send again at the next opportunity.",
                }
              );
            })
          }
          onRetry={() =>
            startTransition(async () => {
              await retryFailed(row.id);
              toast.success("Queued to try again");
            })
          }
          onSaved={(next) => setFindings((map) => new Map(map).set(row.id, next))}
          onCloseEditor={() => setEditing(null)}
        />
      ))}
    </div>
  );
}

interface MessageCardProps {
  row: QueueRow;
  index: number;
  focused: boolean;
  selected: boolean;
  editing: boolean;
  findings?: LintFinding[];
  registerRef: (node: HTMLDivElement | null) => void;
  onFocus: () => void;
  onToggle: () => void;
  onApprove: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onResolve: (outcome: "sent" | "requeue") => void;
  onRetry: () => void;
  onSaved: (findings: LintFinding[]) => void;
  onCloseEditor: () => void;
}

function MessageCard({
  row,
  index,
  focused,
  selected,
  editing,
  findings,
  registerRef,
  onFocus,
  onToggle,
  onApprove,
  onCancel,
  onEdit,
  onResolve,
  onRetry,
  onSaved,
  onCloseEditor,
}: MessageCardProps) {
  const isDraft = row.status === "draft";

  return (
    <div
      ref={registerRef}
      onMouseEnter={onFocus}
      className="rise"
      style={{ animationDelay: `${Math.min(index, 8) * 25}ms` }}
    >
      <Card
        className={cn(
          "px-4 py-3 transition-[border-color,background-color] duration-150 ease-[var(--ease-out-quick)]",
          // The cursor is a left rule rather than a glow, so it reads at a
          // glance in a dense list without adding colour that means nothing.
          focused && "border-l-2 border-l-accent",
          selected && "bg-accent-soft/40"
        )}
      >
        <div className="flex items-start gap-3">
          {isDraft && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              className="mt-1 size-3.5 shrink-0 accent-[var(--color-accent)]"
              aria-label={`Select the message to ${row.company}`}
            />
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">{row.company}</span>
              <StatusBadge status={row.status} />
              <Badge>step {row.stepNumber}</Badge>
              <span className="text-[11px] text-muted">{row.campaign}</span>
              <span className="nums ml-auto text-[11px] text-faint">
                {formatWhen(row.scheduledAt)}
              </span>
            </div>

            <div className="mt-1 font-mono text-[11px] text-muted">{row.toEmail}</div>

            <div className="mt-3 rounded-sm border border-line bg-sunken/40 px-3 py-2.5">
              <div className="text-[13px] font-medium">{row.subject}</div>
              {/*
                Monospace, full text. These are plain text emails, and
                monospace shows the line breaks and spacing the recipient
                will actually see. Clamping would mean opening an editor on
                every single one just to read it.
              */}
              <p
                className={cn(
                  "mt-2 whitespace-pre-wrap font-mono text-[12px] leading-[1.65] text-muted",
                  !isDraft && "line-clamp-3"
                )}
              >
                {row.body}
              </p>
            </div>

            {row.error && (
              <p className="mt-2 rounded-sm bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
                {row.error}
              </p>
            )}

            {findings && findings.length > 0 && (
              <ul className="mt-2 space-y-1">
                {findings.map((finding, position) => (
                  <li
                    key={position}
                    className={cn(
                      "rounded-sm px-2.5 py-1.5 text-[12px]",
                      finding.severity === "block"
                        ? "bg-danger-soft text-danger"
                        : "bg-warn-soft text-warn"
                    )}
                  >
                    <span className="font-medium">
                      {finding.severity === "block" ? "Blocked. " : "Worth a look. "}
                    </span>
                    {finding.message}
                    {finding.excerpt && (
                      <span className="ml-1 font-mono opacity-80">{finding.excerpt}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <Actions
              row={row}
              focused={focused}
              onApprove={onApprove}
              onCancel={onCancel}
              onEdit={onEdit}
              onResolve={onResolve}
              onRetry={onRetry}
            />

            {editing && (
              <DraftEditor row={row} onSaved={onSaved} onClose={onCloseEditor} />
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function Actions({
  row,
  focused,
  onApprove,
  onCancel,
  onEdit,
  onResolve,
  onRetry,
}: {
  row: QueueRow;
  focused: boolean;
  onApprove: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onResolve: (outcome: "sent" | "requeue") => void;
  onRetry: () => void;
}) {
  // The key hints only appear on the row the cursor is on, so the list stays
  // quiet but the shortcut is discoverable exactly where it would be used.
  const hint = (key: string) =>
    focused ? <kbd className="ml-1 font-mono text-[10px] opacity-50">{key}</kbd> : null;

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      {row.status === "draft" && (
        <>
          <button type="button" onClick={onApprove} className={buttonClass("primary")}>
            Approve{hint("a")}
          </button>
          <button type="button" onClick={onEdit} className={buttonClass("secondary")}>
            Edit{hint("e")}
          </button>
          <button type="button" onClick={onCancel} className={buttonClass("ghost")}>
            Cancel{hint("c")}
          </button>
        </>
      )}

      {row.status === "uncertain" && (
        <>
          <span className="mr-1 text-[12px] text-warn">
            Check your Sent folder, then say which happened:
          </span>
          <button
            type="button"
            onClick={() => onResolve("sent")}
            className={buttonClass("secondary")}
          >
            It did send
          </button>
          <button
            type="button"
            onClick={() => onResolve("requeue")}
            className={buttonClass("secondary")}
          >
            It did not, send it
          </button>
        </>
      )}

      {row.status === "failed" && (
        <button type="button" onClick={onRetry} className={buttonClass("secondary")}>
          Try again
        </button>
      )}

      {row.status === "scheduled" && (
        <button type="button" onClick={onCancel} className={buttonClass("ghost")}>
          Cancel{hint("c")}
        </button>
      )}
    </div>
  );
}

function DraftEditor({
  row,
  onSaved,
  onClose,
}: {
  row: QueueRow;
  onSaved: (findings: LintFinding[]) => void;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState(row.subject);
  const [body, setBody] = useState(row.body);
  const [pending, startTransition] = useTransition();

  const dirty = subject !== row.subject || body !== row.body;
  const words = body.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="mt-3 space-y-2 rounded-sm border border-line-strong bg-raised/40 p-3">
      <label className="block">
        <span className="mb-1 block text-[11px] text-muted">Subject</span>
        <input
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          className="w-full rounded-sm border border-line bg-surface px-2 py-1.5 font-mono text-[12px]"
        />
      </label>

      <label className="block">
        <span className="mb-1 flex items-center justify-between text-[11px] text-muted">
          Body
          <span className={cn("nums", words > 120 && "text-warn")}>{words} words</span>
        </span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={14}
          className="w-full resize-y rounded-sm border border-line bg-surface px-2 py-1.5 font-mono text-[12px] leading-[1.65]"
        />
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending || !dirty}
          onClick={() =>
            startTransition(async () => {
              const next = await saveDraft(row.id, subject, body);
              onSaved(next);
              toast.success("Saved", {
                description: next.some((f) => f.severity === "block")
                  ? "Still something blocking it, see below."
                  : "Ready to approve.",
              });
              onClose();
            })
          }
          className={buttonClass("primary")}
        >
          {pending ? "Saving..." : "Save"}
        </button>
        <button type="button" onClick={onClose} className={buttonClass("ghost")}>
          {dirty ? "Discard" : "Close"}
        </button>
        <span className="text-[11px] text-faint">
          Saving re-runs the checks on what you wrote.
        </span>
      </div>
    </div>
  );
}
