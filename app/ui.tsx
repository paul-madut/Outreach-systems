import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The design system.
 *
 * Two rules run through all of it.
 *
 * A status is never communicated by colour alone. Every one carries a glyph,
 * so it survives being colourblind, printed, or glanced at in peripheral
 * vision. That matters here because the statuses are not decorative: one of
 * them means "this may or may not have reached a real person".
 *
 * Nothing is lit that does not mean something. No gradients, no shadows for
 * depth's sake, hairline rules instead of borders with weight.
 */

// ------------------------------------------------------------------ status

const TONES = {
  neutral: {
    text: "text-muted",
    soft: "bg-raised text-muted",
    dot: "bg-faint",
  },
  ok: { text: "text-ok", soft: "bg-ok-soft text-ok", dot: "bg-ok" },
  warn: { text: "text-warn", soft: "bg-warn-soft text-warn", dot: "bg-warn" },
  danger: { text: "text-danger", soft: "bg-danger-soft text-danger", dot: "bg-danger" },
  info: { text: "text-info", soft: "bg-info-soft text-info", dot: "bg-info" },
} as const;

export type Tone = keyof typeof TONES;

/**
 * Every status in the app, in one place, with what it means in plain words.
 *
 * The explanation is not documentation: it is rendered in the interface, on
 * hover and in the legend, because "uncertain" is not self-evident and
 * guessing wrong about it costs a prospect.
 */
export const STATUS: Record<
  string,
  { tone: Tone; glyph: string; label: string; means: string }
> = {
  draft: {
    tone: "neutral",
    glyph: "○",
    label: "draft",
    means: "Written and checked, waiting for you to approve it. Nothing sends until you do.",
  },
  scheduled: {
    tone: "info",
    glyph: "◷",
    label: "scheduled",
    means: "Approved and queued. It will go out at its own time, inside the sending window.",
  },
  sending: {
    tone: "info",
    glyph: "◐",
    label: "sending",
    means: "The worker has this one in hand right now.",
  },
  sent: { tone: "ok", glyph: "●", label: "sent", means: "Accepted by the mail server." },
  uncertain: {
    tone: "warn",
    glyph: "◍",
    label: "unknown",
    means:
      "The connection dropped mid-send, so this may or may not have arrived. It will never be resent on its own. Check your Sent folder and tell it which happened.",
  },
  failed: {
    tone: "danger",
    glyph: "✕",
    label: "failed",
    means: "Rejected, and retried as far as it is going to be. Nothing was delivered.",
  },
  cancelled: {
    tone: "neutral",
    glyph: "–",
    label: "cancelled",
    means: "Stopped before sending, usually because the prospect replied or opted out.",
  },
  // enrollments and campaigns
  active: { tone: "ok", glyph: "●", label: "active", means: "Running." },
  paused: {
    tone: "warn",
    glyph: "‖",
    label: "paused",
    means: "Nothing will send from this until you resume it.",
  },
  archived: { tone: "neutral", glyph: "–", label: "archived", means: "Kept for the record." },
  replied: {
    tone: "ok",
    glyph: "↩",
    label: "replied",
    means: "A human answered. Remaining follow-ups were cancelled.",
  },
  bounced: {
    tone: "danger",
    glyph: "⤺",
    label: "bounced",
    means: "The address rejected it permanently. It is now on the suppression list.",
  },
  stopped: {
    tone: "neutral",
    glyph: "■",
    label: "stopped",
    means: "Ended early, by an opt-out or by hand.",
  },
  completed: {
    tone: "neutral",
    glyph: "✓",
    label: "finished",
    means: "Every step was sent and nobody replied.",
  },
  // inbound
  reply: { tone: "ok", glyph: "↩", label: "reply", means: "A person wrote back." },
  auto_reply: {
    tone: "neutral",
    glyph: "⟳",
    label: "auto",
    means:
      "A robot wrote back: a helpdesk ticket receipt or an out-of-office. The sequence deliberately keeps going.",
  },
  bounce: { tone: "danger", glyph: "⤺", label: "bounce", means: "Delivery failed." },
  unsubscribe: {
    tone: "warn",
    glyph: "⊘",
    label: "opt-out",
    means: "They asked to stop. The address is suppressed permanently.",
  },
  unmatched: {
    tone: "info",
    glyph: "?",
    label: "unmatched",
    means: "Arrived in the mailbox but could not be tied to anything you sent.",
  },
};

export function StatusBadge({
  status,
  size = "sm",
}: {
  status: string;
  size?: "sm" | "xs";
}) {
  const meta = STATUS[status] ?? {
    tone: "neutral" as Tone,
    glyph: "·",
    label: status,
    means: "",
  };

  return (
    <span
      title={meta.means}
      className={cn(
        "inline-flex select-none items-center gap-1 rounded-xs font-medium",
        TONES[meta.tone].soft,
        size === "xs" ? "px-1 py-px text-[10px]" : "px-1.5 py-0.5 text-[11px]"
      )}
    >
      <span aria-hidden className="leading-none opacity-80">
        {meta.glyph}
      </span>
      {meta.label}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-xs px-1.5 py-0.5 text-[11px] font-medium",
        TONES[tone].soft
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={cn("inline-block size-1.5 rounded-full", TONES[tone].dot)} />;
}

// ----------------------------------------------------------------- surfaces

export function Card({
  children,
  className,
  interactive,
}: {
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-line bg-surface",
        interactive &&
          "transition-colors duration-150 ease-[var(--ease-out-quick)] hover:border-line-strong",
        className
      )}
    >
      {children}
    </div>
  );
}

export function PageHeading({
  title,
  subtitle,
  right,
  back,
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  /** A way back up, shown above the title where a breadcrumb belongs. */
  back?: { href: string; label: string };
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {back && (
          <Link
            href={back.href}
            className="group mb-1 inline-flex items-center gap-1 text-xs text-muted hover:text-ink"
          >
            <span className="inline-block transition-transform duration-150 ease-[var(--ease-out-quick)] group-hover:-translate-x-0.5">
              &larr;
            </span>
            {back.label}
          </Link>
        )}
        <h1 className="display text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

// ------------------------------------------------------------------ buttons

const BUTTON_BASE =
  "inline-flex select-none items-center justify-center gap-1.5 rounded-sm font-medium " +
  "transition-[transform,background-color,border-color,opacity] duration-150 " +
  "ease-[var(--ease-out-quick)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40";

const BUTTON_VARIANTS = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-raised",
  ghost: "text-muted hover:bg-raised hover:text-ink",
  danger: "border border-line-strong bg-surface text-danger hover:bg-danger-soft",
} as const;

const BUTTON_SIZES = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-[13px]",
} as const;

export function buttonClass(
  variant: keyof typeof BUTTON_VARIANTS = "secondary",
  size: keyof typeof BUTTON_SIZES = "sm"
): string {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size]);
}

export function LinkButton({
  href,
  children,
  variant = "secondary",
  size = "sm",
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  className?: string;
}) {
  return (
    <Link href={href} className={cn(buttonClass(variant, size), className)}>
      {children}
    </Link>
  );
}

// ------------------------------------------------------------------- tables

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse text-[13px]">{children}</table>
    </div>
  );
}

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "border-b border-line bg-raised/60 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted",
        className
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cn("border-b border-line px-3 py-2 align-top", className)}>{children}</td>;
}

// ------------------------------------------------------------------- pieces

export function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number | string;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <div title={hint}>
      <div className={cn("nums text-[19px] leading-tight", tone && TONES[tone].text)}>{value}</div>
      <div className="mt-0.5 text-[11px] text-muted">{label}</div>
    </div>
  );
}

/**
 * Empty states carry the next action.
 *
 * An empty screen that only says "nothing here" makes you go and ask someone
 * what to do. Every one of these says what the screen is for and gives the
 * exact step that fills it.
 */
export function Empty({
  title,
  hint,
  action,
  command,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  command?: string;
}) {
  return (
    <Card className="px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-muted">{hint}</p>}
      {command && (
        <code className="mx-auto mt-3 block w-fit rounded-sm bg-sunken px-2.5 py-1.5 font-mono text-xs text-muted">
          {command}
        </code>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </Card>
  );
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
