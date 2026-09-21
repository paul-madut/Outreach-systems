"use client";

import { useState, useTransition } from "react";
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
import { Badge, Card, StatusBadge, formatWhen } from "../ui";

/**
 * The review queue.
 *
 * Bulk approve is the common path, so it is the default action. Editing one
 * message is a click away rather than a separate page, because the usual edit
 * is a single line and bouncing through a detail view for that is friction.
 */
export function QueueList({ rows }: { rows: QueueRow[] }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openId, setOpenId] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<Map<number, LintFinding[]>>(new Map());
  const [pending, startTransition] = useTransition();

  const drafts = rows.filter((row) => row.status === "draft");
  const allDraftsSelected = drafts.length > 0 && drafts.every((row) => selected.has(row.id));

  function toggle(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function approve(ids: number[]) {
    startTransition(async () => {
      const result = await approveMessages(ids);
      setBlocked(new Map(result.blocked.map((b) => [b.messageId, b.findings])));
      setSelected(new Set());
    });
  }

  return (
    <div className="space-y-3">
      {drafts.length > 0 && (
        <Card className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
          <label className="flex items-center gap-2 text-muted">
            <input
              type="checkbox"
              checked={allDraftsSelected}
              onChange={() =>
                setSelected(allDraftsSelected ? new Set() : new Set(drafts.map((r) => r.id)))
              }
            />
            Select all {drafts.length} draft{drafts.length === 1 ? "" : "s"}
          </label>

          <button
            type="button"
            disabled={selected.size === 0 || pending}
            onClick={() => approve([...selected])}
            className="rounded bg-ink px-3 py-1 text-xs text-canvas disabled:opacity-40"
          >
            {pending ? "Approving..." : `Approve ${selected.size || ""}`.trim()}
          </button>

          <span className="text-xs text-muted">
            Approving moves a message into the send queue. Nothing leaves before its scheduled time.
          </span>
        </Card>
      )}

      {rows.map((row) => {
        const findings = blocked.get(row.id);
        const isOpen = openId === row.id;

        return (
          <Card key={row.id} className="px-4 py-3">
            <div className="flex items-start gap-3">
              {row.status === "draft" && (
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(row.id)}
                  onChange={() => toggle(row.id)}
                />
              )}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{row.company}</span>
                  <StatusBadge status={row.status} />
                  <Badge>step {row.stepNumber}</Badge>
                  <span className="text-xs text-muted">{row.campaign}</span>
                </div>

                <div className="mt-1 text-xs text-muted">
                  {row.toEmail} · {formatWhen(row.scheduledAt)}
                </div>

                <div className="mt-2 text-sm font-medium">{row.subject}</div>

                {/*
                  A draft is shown in full. The job on this screen is to read
                  the email and decide, and clamping it to two lines means
                  opening the editor for every single one just to see what it
                  says. Anything already sent or scheduled is not being read,
                  so those stay short.
                */}
                <p
                  className={cn(
                    "mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted",
                    row.status !== "draft" && "line-clamp-2"
                  )}
                >
                  {row.body}
                </p>

                {row.error && (
                  <p className="mt-2 rounded bg-warn-soft px-2 py-1 text-xs text-warn">
                    {row.error}
                  </p>
                )}

                {findings && findings.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {findings.map((finding, index) => (
                      <li
                        key={index}
                        className={
                          finding.severity === "block"
                            ? "rounded bg-danger-soft px-2 py-1 text-xs text-danger"
                            : "rounded bg-warn-soft px-2 py-1 text-xs text-warn"
                        }
                      >
                        {finding.message}
                        {finding.excerpt && (
                          <span className="ml-1 opacity-80">{finding.excerpt}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-2 flex flex-wrap gap-3 text-xs">
                  {row.status === "draft" && (
                    <>
                      <button
                        type="button"
                        className="text-muted underline-offset-2 hover:text-ink hover:underline"
                        onClick={() => setOpenId(isOpen ? null : row.id)}
                      >
                        {isOpen ? "Close" : "Edit"}
                      </button>
                      <button
                        type="button"
                        className="text-muted underline-offset-2 hover:text-ink hover:underline"
                        onClick={() => approve([row.id])}
                      >
                        Approve
                      </button>
                    </>
                  )}

                  {row.status === "uncertain" && (
                    <>
                      <span className="text-warn">
                        Check the Sent folder, then say which happened:
                      </span>
                      <button
                        type="button"
                        className="text-muted underline-offset-2 hover:text-ink hover:underline"
                        onClick={() =>
                          startTransition(() => resolveUncertain(row.id, "sent").then(() => {}))
                        }
                      >
                        It was sent
                      </button>
                      <button
                        type="button"
                        className="text-muted underline-offset-2 hover:text-ink hover:underline"
                        onClick={() =>
                          startTransition(() => resolveUncertain(row.id, "requeue").then(() => {}))
                        }
                      >
                        Send it again
                      </button>
                    </>
                  )}

                  {row.status === "failed" && (
                    <button
                      type="button"
                      className="text-muted underline-offset-2 hover:text-ink hover:underline"
                      onClick={() => startTransition(() => retryFailed(row.id).then(() => {}))}
                    >
                      Retry
                    </button>
                  )}

                  {(row.status === "draft" || row.status === "scheduled") && (
                    <button
                      type="button"
                      className="text-muted underline-offset-2 hover:text-danger hover:underline"
                      onClick={() => startTransition(() => cancelMessage(row.id).then(() => {}))}
                    >
                      Cancel
                    </button>
                  )}
                </div>

                {isOpen && <DraftEditor row={row} onDone={() => setOpenId(null)} />}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function DraftEditor({ row, onDone }: { row: QueueRow; onDone: () => void }) {
  const [subject, setSubject] = useState(row.subject);
  const [body, setBody] = useState(row.body);
  const [findings, setFindings] = useState<LintFinding[]>([]);
  const [pending, startTransition] = useTransition();

  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <input
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
        className="w-full rounded border border-line bg-canvas px-2 py-1 text-sm"
        placeholder="Subject"
      />
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={12}
        className="w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-xs"
      />

      {findings.length > 0 && (
        <ul className="space-y-1">
          {findings.map((finding, index) => (
            <li
              key={index}
              className={
                finding.severity === "block"
                  ? "rounded bg-danger-soft px-2 py-1 text-xs text-danger"
                  : "rounded bg-warn-soft px-2 py-1 text-xs text-warn"
              }
            >
              {finding.message}
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-3 text-xs">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setFindings(await saveDraft(row.id, subject, body));
            })
          }
          className="rounded bg-ink px-3 py-1 text-canvas disabled:opacity-40"
        >
          {pending ? "Saving..." : "Save"}
        </button>
        <button type="button" onClick={onDone} className="text-muted hover:text-ink">
          Done
        </button>
      </div>
    </div>
  );
}
