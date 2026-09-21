import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "@/lib/db";
import { listMailboxes, listMergeFields } from "@/lib/queries";
import { Empty, LinkButton, PageHeading } from "../../ui";
import { NewCampaignForm, type Starter } from "./new-campaign-form";

export const dynamic = "force-dynamic";

/**
 * The templates already written on disk, offered as starting points.
 *
 * Copy for these campaigns is drafted in files and reviewed there, so a blank
 * textarea would mean pasting it in by hand every time and risking a stale
 * copy. Reading the folder means the wording in the app is the wording that
 * was actually reviewed.
 */
function starters(): Starter[] {
  const root = resolve(process.cwd(), "templates");
  const found: Starter[] = [];

  let folders: string[];
  try {
    folders = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  for (const folder of folders) {
    try {
      const body = readFileSync(resolve(root, folder, "step1.txt"), "utf8").trimEnd();
      let footer: string | null = null;
      try {
        footer = readFileSync(resolve(root, folder, "footer.txt"), "utf8").trim();
      } catch {
        footer = null;
      }
      found.push({ name: folder, body, footer });
    } catch {
      // A folder without a step1.txt is not a starting point.
    }
  }

  return found;
}

export default function NewCampaignPage() {
  const db = getDb();
  const mailboxes = listMailboxes(db);
  const fields = listMergeFields(db);

  if (mailboxes.length === 0) {
    return (
      <>
        <PageHeading title="New campaign" />
        <Empty
          title="There is no mailbox to send from."
          hint="Store an app-specific password in the Keychain, then register the mailbox. A campaign has to belong to one."
          action={<LinkButton href="/settings" size="md">Settings</LinkButton>}
          command={'pnpm mailbox add --label payments --provider icloud --from "You <you@icloud.com>"'}
        />
      </>
    );
  }

  return (
    <>
      <PageHeading
        title="New campaign"
        subtitle="Nothing sends from this until you activate it and approve the drafts, so it is safe to get wrong."
      />
      <NewCampaignForm mailboxes={mailboxes} fields={fields} starters={starters()} />
    </>
  );
}
