"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Toaster } from "sonner";
import { cn } from "@/lib/utils";
import { STATUS, buttonClass } from "../ui";

/**
 * The frame around every page: navigation, keyboard shortcuts, the status
 * legend, and toasts.
 *
 * All of it exists to answer "what can I do here" without asking. The counts
 * live in the nav so the work is visible from anywhere, the legend explains
 * every status in plain words, and the shortcut sheet is one keypress away.
 */

export interface NavCounts {
  drafts: number;
  due: number;
  needsLook: number;
  unreadInbox: number;
}

const NAV = [
  { href: "/", label: "Overview", key: "1" },
  { href: "/queue", label: "Queue", key: "2", count: "drafts" as const },
  { href: "/campaigns", label: "Campaigns", key: "3" },
  { href: "/inbox", label: "Inbox", key: "4", count: "unreadInbox" as const },
  { href: "/prospects", label: "Prospects", key: "5" },
  { href: "/settings", label: "Settings", key: "6" },
];

export function Chrome({
  counts,
  children,
}: {
  counts: NavCounts;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showLegend, setShowLegend] = useState(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Never hijack a key while something is being typed.
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "?") {
        event.preventDefault();
        setShowShortcuts((open) => !open);
        return;
      }
      if (event.key === "Escape") {
        setShowShortcuts(false);
        setShowLegend(false);
        return;
      }

      const item = NAV.find((entry) => entry.key === event.key);
      if (item) {
        event.preventDefault();
        router.push(item.href);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-1 px-5 py-2.5">
          <Link href="/" className="display mr-4 text-[15px] tracking-tight">
            Outreach
          </Link>

          <nav className="flex items-center gap-0.5">
            {NAV.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              const count = item.count ? counts[item.count] : 0;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "group relative flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-[13px]",
                    "transition-colors duration-150 ease-[var(--ease-out-quick)]",
                    active ? "bg-raised text-ink" : "text-muted hover:bg-raised/60 hover:text-ink"
                  )}
                >
                  {item.label}
                  {count > 0 && (
                    <span className="nums rounded-full bg-accent px-1.5 text-[10px] leading-[15px] text-white">
                      {count}
                    </span>
                  )}
                  <kbd className="pointer-events-none absolute -bottom-px left-1/2 hidden -translate-x-1/2 text-[9px] text-faint group-hover:block">
                    {item.key}
                  </kbd>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowLegend(true)}
              className={buttonClass("ghost")}
              title="What the statuses mean"
            >
              Legend
            </button>
            <button
              type="button"
              onClick={() => setShowShortcuts(true)}
              className={buttonClass("ghost")}
              title="Keyboard shortcuts"
            >
              <kbd className="font-mono">?</kbd>
            </button>
          </div>
        </div>
      </header>

      {children}

      {showShortcuts && <ShortcutSheet onClose={() => setShowShortcuts(false)} />}
      {showLegend && <LegendSheet onClose={() => setShowLegend(false)} />}

      <Toaster
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast:
              "!rounded-md !border !border-line !bg-surface !text-ink !text-[13px] !font-sans",
            description: "!text-muted",
          },
        }}
      />
    </>
  );
}

function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-sunken/60 p-6 pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
      style={{ animation: "rise 140ms var(--ease-out-quick) both" }}
    >
      <div
        className="w-full max-w-lg rounded-md border border-line bg-surface"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-baseline justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="display text-lg">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className={buttonClass("ghost")}>
            Esc
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

const SHORTCUTS: { keys: string; what: string; where: string }[] = [
  { keys: "1 - 6", what: "Jump between pages", where: "Anywhere" },
  { keys: "?", what: "This list", where: "Anywhere" },
  { keys: "j / k", what: "Next and previous message", where: "Queue" },
  { keys: "x", what: "Select the message you are on", where: "Queue" },
  { keys: "a", what: "Approve it", where: "Queue" },
  { keys: "e", what: "Edit it", where: "Queue" },
  { keys: "c", what: "Cancel it", where: "Queue" },
  { keys: "A", what: "Select every draft", where: "Queue" },
  { keys: "Enter", what: "Approve everything selected", where: "Queue" },
  { keys: "Esc", what: "Close, or clear the selection", where: "Anywhere" },
];

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Keyboard" subtitle="Review runs faster without the mouse." onClose={onClose}>
      <dl className="space-y-1">
        {SHORTCUTS.map((shortcut) => (
          <div
            key={shortcut.keys}
            className="flex items-center gap-3 rounded-sm px-2 py-1.5 text-[13px] hover:bg-raised"
          >
            <dt className="w-20 shrink-0">
              <kbd className="rounded-xs border border-line-strong bg-raised px-1.5 py-0.5 font-mono text-[11px]">
                {shortcut.keys}
              </kbd>
            </dt>
            <dd className="flex-1">{shortcut.what}</dd>
            <dd className="text-[11px] text-faint">{shortcut.where}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}

const LEGEND_GROUPS = [
  { title: "A message", keys: ["draft", "scheduled", "sent", "uncertain", "failed", "cancelled"] },
  { title: "A prospect in a campaign", keys: ["active", "replied", "bounced", "stopped", "completed"] },
  { title: "Something that arrived", keys: ["reply", "auto_reply", "bounce", "unsubscribe", "unmatched"] },
];

function LegendSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet
      title="What the statuses mean"
      subtitle="Each one means exactly this, everywhere in the app."
      onClose={onClose}
    >
      <div className="space-y-5">
        {LEGEND_GROUPS.map((group) => (
          <div key={group.title}>
            <h3 className="mb-2 text-[11px] uppercase tracking-wide text-faint">{group.title}</h3>
            <dl className="space-y-2">
              {group.keys.map((key) => {
                const meta = STATUS[key];
                return (
                  <div key={key} className="flex gap-3">
                    <dt className="w-24 shrink-0 pt-px">
                      <span className="text-[11px] font-medium">
                        <span aria-hidden className="mr-1 opacity-70">
                          {meta.glyph}
                        </span>
                        {meta.label}
                      </span>
                    </dt>
                    <dd className="flex-1 text-[13px] leading-relaxed text-muted">{meta.means}</dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
