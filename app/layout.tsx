import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { getDb } from "@/lib/db";
import { getHealth } from "@/lib/queries";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Outreach",
  description: "Cold outreach, run locally",
};

const NAV = [
  { href: "/", label: "Campaigns" },
  { href: "/queue", label: "Queue" },
  { href: "/inbox", label: "Inbox" },
  { href: "/prospects", label: "Prospects" },
  { href: "/settings", label: "Settings" },
];

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The health banner.
 *
 * A worker that has quietly stopped looks exactly like a quiet day. Showing
 * when it last ran, next to how much is waiting, is what makes the difference
 * visible without having to go and read a log.
 */
async function HealthBanner() {
  const health = getHealth(getDb());

  const problems: string[] = [];
  for (const mailbox of health.pausedMailboxes) {
    problems.push(`Mailbox "${mailbox.label}" is paused. ${mailbox.reason ?? ""}`.trim());
  }
  if (health.uncertain > 0) {
    problems.push(
      `${health.uncertain} message${health.uncertain === 1 ? "" : "s"} with an unknown outcome need a decision.`
    );
  }

  return (
    <div className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-5 py-2 text-xs text-muted">
        <span className="nums">
          last send <span className="text-ink">{timeAgo(health.lastSendAt)}</span>
        </span>
        <span className="nums">
          last poll <span className="text-ink">{timeAgo(health.lastPollAt)}</span>
        </span>
        <span className="nums">
          due now <span className="text-ink">{health.dueNow}</span>
        </span>
        <span className="nums">
          drafts <span className="text-ink">{health.drafts}</span>
        </span>
      </div>
      {problems.length > 0 && (
        <div className="border-t border-line bg-warn-soft">
          <div className="mx-auto max-w-6xl px-5 py-2 text-xs text-warn">
            {problems.map((problem) => (
              <div key={problem}>{problem}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3">
            <span className="text-sm font-semibold tracking-tight">Outreach</span>
            <nav className="flex gap-4 text-sm text-muted">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="hover:text-ink">
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <HealthBanner />
        <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-6">{children}</main>
      </body>
    </html>
  );
}
