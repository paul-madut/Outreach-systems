import { cn } from "@/lib/utils";

/** Small shared pieces. Deliberately plain: this is a tool, not a product page. */

export function PageHeading({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-line bg-surface", className)}>{children}</div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <Card className="px-5 py-10 text-center">
      <p className="text-sm text-ink">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{hint}</p>}
    </Card>
  );
}

/**
 * Status colour is meaning, not decoration. The same status is the same colour
 * everywhere, so the queue can be scanned without reading the words.
 */
const TONES = {
  neutral: "bg-raised text-muted",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
} as const;

export type Tone = keyof typeof TONES;

export const STATUS_TONE: Record<string, Tone> = {
  // messages
  draft: "neutral",
  scheduled: "info",
  sending: "info",
  sent: "ok",
  uncertain: "warn",
  failed: "danger",
  cancelled: "neutral",
  // enrollments and campaigns
  active: "ok",
  paused: "warn",
  archived: "neutral",
  replied: "ok",
  bounced: "danger",
  stopped: "neutral",
  completed: "neutral",
  // inbound
  reply: "ok",
  auto_reply: "neutral",
  bounce: "danger",
  unsubscribe: "warn",
  unmatched: "info",
};

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
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
        TONES[tone]
      )}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status.replace("_", " ")}</Badge>;
}

export function Stat({ label, value, tone }: { label: string; value: number; tone?: Tone }) {
  return (
    <div>
      <div className={cn("nums text-xl font-semibold", tone === "danger" && "text-danger", tone === "warn" && "text-warn")}>
        {value}
      </div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "-";
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "border-b border-line px-3 py-2 text-left text-xs font-medium text-muted",
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
