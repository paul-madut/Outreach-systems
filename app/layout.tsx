import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from "next/font/google";
import { getDb } from "@/lib/db";
import { getHealth } from "@/lib/queries";
import { Chrome } from "./components/chrome";
import { HealthBar } from "./components/health-bar";
import "./globals.css";

/**
 * Instrument Serif appears only on page titles, which gives the tool one
 * distinct voice without costing anything in readability. Plex Sans carries
 * the interface, and Plex Mono carries every number, address and email body:
 * monospace is a functional choice there, because these are plain text emails
 * and monospace makes line breaks and spacing visible while proofreading.
 */
const display = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
});

const sans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Outreach",
  description: "Cold outreach, run locally",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const health = getHealth(getDb());

  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable} h-full antialiased`}
    >
      {/*
        suppressHydrationWarning on body: browser extensions inject attributes
        into the DOM before React hydrates, which produces a mismatch warning
        that has nothing to do with this app.
      */}
      <body className="flex min-h-full flex-col font-sans" suppressHydrationWarning>
        <Chrome
          counts={{
            drafts: health.drafts,
            due: health.dueNow,
            needsLook: health.uncertain + health.failed,
            unreadInbox: health.unhandledReplies,
          }}
        >
          <HealthBar health={health} />
          <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-7">{children}</main>
        </Chrome>
      </body>
    </html>
  );
}
