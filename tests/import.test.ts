import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { parseJson } from "@/lib/db";
import { CsvParseError, parseCsv } from "@/lib/import/parse-csv";
import { autoMap, contactSlots, detectTarget, validateMapping } from "@/lib/import/mapping";
import { commitImport, lastMappingFor, stageRow } from "@/lib/import/commit";
import { addSuppression } from "@/lib/suppressions";
import { createTestDb } from "./helpers/db";

/** The payments sheet: one contact per row, drafts written into the sheet. */
const PAYMENTS_HEADERS = [
  "Grade", "Store", "Domain", "Vertical", "Country", "Email", "Channel", "Platform",
  "Payment methods today", "Finding URL", "Verbatim quote (the hook)", "Second URL",
  "Second quote", "Cost signal", "Why it matters to an underwriter", "Found by lane",
  "Review before contacting", "Extra pain point found (agent fills)",
  "Angle chosen (agent fills)", "Subject (agent fills)", "Body (agent fills)",
  "Status", "Date sent",
];

/** The fintech sheet: two contacts per row, no domain column. */
const FINTECH_HEADERS = [
  "Score", "Company", "Type", "Segment", "HQ", "Why it fits Paul", "Role title",
  "Apply / role URL", "Location fit", "Base salary", "Meets $70k",
  "Contact 1", "C1 title", "C1 LinkedIn", "C1 email",
  "Contact 2", "C2 title", "C2 LinkedIn", "C2 email",
  "Applied?", "Reached out?",
];

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

describe("parseCsv", () => {
  it("keeps a multi-line quoted body intact", () => {
    // The Body column holds real drafts with blank lines and commas in them.
    const csv =
      'Store,Body\n' +
      '"Otie\'s","Hello,\n\nYour FAQ says ""High Risk"".\n\nBest,\nPaul"\n';

    const parsed = parseCsv(csv);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].Body).toContain("\n\n");
    expect(parsed.rows[0].Body).toContain('"High Risk"');
  });

  it("strips a BOM so the first header still matches its rule", () => {
    const parsed = parseCsv("﻿Company,Email\nAcme,a@b.com\n");
    expect(parsed.headers[0]).toBe("Company");
  });

  it("drops rows that are only separators", () => {
    const parsed = parseCsv("Company,Email\nAcme,a@b.com\n,,\n,\n");
    expect(parsed.rows).toHaveLength(1);
  });

  it("keeps duplicate headers distinguishable", () => {
    const parsed = parseCsv("Email,Email\na@b.com,c@d.com\n");
    expect(parsed.headers).toEqual(["Email", "Email (2)"]);
    expect(parsed.warnings.some((w) => w.includes("Duplicate column"))).toBe(true);
  });

  it("refuses a file with no rows", () => {
    expect(() => parseCsv("")).toThrow(CsvParseError);
  });
});

describe("detectTarget", () => {
  it("maps the payments sheet's identity columns", () => {
    expect(detectTarget("Store")).toEqual({ kind: "prospect", field: "company" });
    expect(detectTarget("Domain")).toEqual({ kind: "prospect", field: "domain" });
    expect(detectTarget("Vertical")).toEqual({ kind: "prospect", field: "vertical" });
    expect(detectTarget("Grade")).toEqual({ kind: "prospect", field: "grade" });
    expect(detectTarget("Email")).toEqual({ kind: "contact", slot: 1, field: "email" });
    expect(detectTarget("Channel")).toEqual({ kind: "contact", slot: 1, field: "channel" });
  });

  it("maps the fintech sheet's two contact slots", () => {
    expect(detectTarget("Contact 1")).toEqual({ kind: "contact", slot: 1, field: "name" });
    expect(detectTarget("C1 email")).toEqual({ kind: "contact", slot: 1, field: "email" });
    expect(detectTarget("C1 title")).toEqual({ kind: "contact", slot: 1, field: "title" });
    expect(detectTarget("C1 LinkedIn")).toEqual({ kind: "contact", slot: 1, field: "linkedin" });
    expect(detectTarget("Contact 2")).toEqual({ kind: "contact", slot: 2, field: "name" });
    expect(detectTarget("C2 email")).toEqual({ kind: "contact", slot: 2, field: "email" });
  });

  it("gives drafts stable merge-field names", () => {
    // So a step's templates can be {{subject}} and {{body}} regardless of how
    // a given sheet words its header.
    expect(detectTarget("Subject (agent fills)")).toEqual({
      kind: "prospect_custom",
      key: "subject",
    });
    expect(detectTarget("Body (agent fills)")).toEqual({
      kind: "prospect_custom",
      key: "body",
    });
  });

  it("does not treat a page URL as the company domain", () => {
    // Every fintech row's apply URL is on ashbyhq.com or greenhouse.io. Reading
    // one as the domain would merge unrelated companies into one prospect.
    expect(detectTarget("Apply / role URL")).toEqual({
      kind: "prospect_custom",
      key: "apply_role_url",
    });
    expect(detectTarget("Finding URL")).toEqual({
      kind: "prospect_custom",
      key: "finding_url",
    });
    expect(detectTarget("Second URL")).toEqual({
      kind: "prospect_custom",
      key: "second_url",
    });
  });

  it("maps the hold column", () => {
    expect(detectTarget("Review before contacting")).toEqual({
      kind: "prospect",
      field: "hold_reason",
    });
  });

  it("keeps any unrecognised column as a merge field", () => {
    expect(detectTarget("Payment methods today")).toEqual({
      kind: "prospect_custom",
      key: "payment_methods_today",
    });
    expect(detectTarget("Why it matters to an underwriter")).toEqual({
      kind: "prospect_custom",
      key: "why_it_matters_to_an_underwriter",
    });
  });
});

describe("autoMap", () => {
  it("maps every payments column with nothing ignored", () => {
    const mapping = autoMap(PAYMENTS_HEADERS);
    expect(Object.keys(mapping)).toHaveLength(PAYMENTS_HEADERS.length);
    expect(Object.values(mapping).every((t) => t.kind !== "ignore")).toBe(true);
    expect(contactSlots(mapping)).toEqual([1]);
    expect(validateMapping(mapping).filter((p) => p.severity === "block")).toEqual([]);
  });

  it("maps every fintech column and finds both contact slots", () => {
    const mapping = autoMap(FINTECH_HEADERS);
    expect(Object.keys(mapping)).toHaveLength(FINTECH_HEADERS.length);
    expect(contactSlots(mapping)).toEqual([1, 2]);
    expect(validateMapping(mapping).filter((p) => p.severity === "block")).toEqual([]);
  });

  it("warns that the fintech sheet has no domain to dedupe on", () => {
    const problems = validateMapping(autoMap(FINTECH_HEADERS));
    expect(problems.some((p) => p.severity === "warn" && p.message.includes("domain"))).toBe(true);
  });

  it("blocks a mapping with no company and no domain", () => {
    const problems = validateMapping(autoMap(["Notes", "Status"]));
    expect(problems.some((p) => p.severity === "block")).toBe(true);
  });

  it("does not let the job opening claim the contact's title", () => {
    // "Role title" in the fintech sheet is the job Paul would apply to. When it
    // claimed contact.title, the real "C1 title" was pushed out to a merge
    // field and every contact imported with no title at all.
    const mapping = autoMap(FINTECH_HEADERS);
    expect(mapping["C1 title"]).toEqual({ kind: "contact", slot: 1, field: "title" });
    expect(mapping["C2 title"]).toEqual({ kind: "contact", slot: 2, field: "title" });
    expect(mapping["Role title"]).toEqual({ kind: "prospect_custom", key: "role_title" });
  });

  it("lets a slot-prefixed header win over a bare one whatever the column order", () => {
    const mapping = autoMap(["Company", "Title", "C1 title", "C1 email"]);
    expect(mapping["C1 title"]).toEqual({ kind: "contact", slot: 1, field: "title" });
    expect(mapping["Title"]).toEqual({ kind: "prospect_custom", key: "title" });
  });

  it("does not let a second column claim a field the first already owns", () => {
    const mapping = autoMap(["Company", "Store"]);
    expect(mapping.Company).toEqual({ kind: "prospect", field: "company" });
    expect(mapping.Store).toEqual({ kind: "prospect_custom", key: "store" });
  });
});

describe("stageRow", () => {
  it("splits a fintech row into two contacts", () => {
    const mapping = autoMap(FINTECH_HEADERS);
    const staged = stageRow(
      {
        Company: "Dakota",
        Segment: "Stablecoins and on-chain payments",
        "Contact 1": "Ryan Bozarth",
        "C1 title": "Co-Founder & CEO",
        "C1 email": "ryan@dakota.xyz",
        "Contact 2": "Corey Wendling",
        "C2 title": "CTO",
        "C2 email": "corey@dakota.xyz",
      },
      mapping
    );

    expect(staged.company).toBe("Dakota");
    expect(staged.contacts).toHaveLength(2);
    expect(staged.contacts[0]).toMatchObject({ email: "ryan@dakota.xyz", name: "Ryan Bozarth" });
    expect(staged.contacts[1]).toMatchObject({ email: "corey@dakota.xyz", name: "Corey Wendling" });
  });

  it("parses the channel column into an enum plus its payload", () => {
    const mapping = autoMap(PAYMENTS_HEADERS);
    const staged = stageRow(
      { Store: "Explicit SARMS", Channel: "phone only: (860-329-7187)" },
      mapping
    );

    expect(staged.contacts[0].channel).toBe("phone");
    expect(staged.contacts[0].channelDetail).toContain("860-329-7187");
  });

  it("folds vertical casing and normalises the domain", () => {
    const mapping = autoMap(PAYMENTS_HEADERS);
    const staged = stageRow(
      { Store: "Otie's", Domain: "https://www.OtiesBotanicals.com/faq", Vertical: "Kratom" },
      mapping
    );

    expect(staged.domain).toBe("otiesbotanicals.com");
    expect(staged.vertical).toBe("kratom");
  });
});

describe("commitImport", () => {
  const paymentsMapping = () => autoMap(PAYMENTS_HEADERS);

  function paymentsRow(overrides: Record<string, string> = {}) {
    return {
      Grade: "A",
      Store: "Otie's Botanicals",
      Domain: "otiesbotanicals.com",
      Vertical: "kratom",
      Email: "support@otiesbotanicals.com",
      Channel: "email",
      "Payment methods today": "Bitcoin, Ethereum",
      "Subject (agent fills)": "Quick question",
      "Body (agent fills)": "Hello,\n\nYour FAQ says...",
      ...overrides,
    };
  }

  it("creates a prospect and its contact", () => {
    const report = commitImport(db, [paymentsRow()], paymentsMapping());

    expect(report).toMatchObject({
      rows: 1,
      prospectsCreated: 1,
      contactsCreated: 1,
      skipped: 0,
    });

    const prospect = db.prepare("select * from prospects").get() as {
      company: string;
      domain: string;
      vertical: string;
      grade: string;
      custom: string;
    };
    expect(prospect.domain).toBe("otiesbotanicals.com");
    expect(prospect.grade).toBe("A");

    // The draft and the research both land as merge fields.
    const custom = parseJson<Record<string, string>>(prospect.custom, {});
    expect(custom.subject).toBe("Quick question");
    expect(custom.payment_methods_today).toBe("Bitcoin, Ethereum");
  });

  it("updates rather than duplicates when the same sheet is imported again", () => {
    // This is the case that matters: Paul keeps expanding these sheets in
    // Claude Code and re-exporting the whole tab.
    commitImport(db, [paymentsRow()], paymentsMapping());
    const second = commitImport(db, [paymentsRow(), paymentsRow({
      Store: "New Store",
      Domain: "newstore.com",
      Email: "hi@newstore.com",
    })], paymentsMapping());

    expect(second.prospectsCreated).toBe(1);
    expect(second.prospectsUpdated).toBe(1);

    const counts = db.prepare("select count(*) as n from prospects").get() as { n: number };
    expect(counts.n).toBe(2);
  });

  it("does not let a blank cell erase something already stored", () => {
    // The tool learns things the sheet does not know. A hold set by hand, or a
    // grade, must survive a re-import of a row whose cell is empty.
    commitImport(db, [paymentsRow({ "Review before contacting": "looks like a scam" })], paymentsMapping());
    commitImport(db, [paymentsRow({ "Review before contacting": "", Grade: "" })], paymentsMapping());

    const prospect = db.prepare("select grade, hold_reason from prospects").get() as {
      grade: string;
      hold_reason: string;
    };
    expect(prospect.hold_reason).toBe("looks like a scam");
    expect(prospect.grade).toBe("A");
  });

  it("merges new custom columns into an existing prospect", () => {
    commitImport(db, [paymentsRow()], paymentsMapping());

    // A column added to the sheet later has to arrive without losing the old ones.
    const extended = autoMap([...PAYMENTS_HEADERS, "New Research Column"]);
    commitImport(
      db,
      [{ ...paymentsRow(), "New Research Column": "fresh finding" }],
      extended
    );

    const prospect = db.prepare("select custom from prospects").get() as { custom: string };
    const custom = parseJson<Record<string, string>>(prospect.custom, {});
    expect(custom.new_research_column).toBe("fresh finding");
    expect(custom.payment_methods_today).toBe("Bitcoin, Ethereum");
  });

  it("dedupes a contact on email even when the company row changes", () => {
    commitImport(db, [paymentsRow()], paymentsMapping());
    commitImport(db, [paymentsRow({ Store: "Otie's Botanicals LLC" })], paymentsMapping());

    const contacts = db.prepare("select count(*) as n from contacts").get() as { n: number };
    expect(contacts.n).toBe(1);
  });

  it("keeps a contact-form-only prospect reachable but unsendable", () => {
    // Nineteen payments prospects have no email. Dropping their contact row
    // would leave the company in the database with no recorded way in.
    const report = commitImport(
      db,
      [paymentsRow({ Email: "", Channel: "contact form only" })],
      paymentsMapping()
    );

    expect(report.prospectsCreated).toBe(1);
    const contact = db.prepare("select email, channel from contacts").get() as {
      email: string | null;
      channel: string;
    };
    expect(contact.email).toBeNull();
    expect(contact.channel).toBe("contact_form");
  });

  it("creates no contact when there is no way in at all", () => {
    commitImport(
      db,
      [paymentsRow({ Email: "", Channel: "no contact found" })],
      paymentsMapping()
    );

    const contacts = db.prepare("select count(*) as n from contacts").get() as { n: number };
    expect(contacts.n).toBe(0);
  });

  it("skips a row with no company and no domain", () => {
    const report = commitImport(db, [paymentsRow({ Store: "", Domain: "" })], paymentsMapping());
    expect(report.skipped).toBe(1);
    expect(report.perRow[0].notes[0]).toContain("nothing to key on");
  });

  it("flags a suppressed contact instead of silently importing it", () => {
    addSuppression(db, "domain", "otiesbotanicals.com", "Already contacted");
    const report = commitImport(db, [paymentsRow()], paymentsMapping());

    expect(report.suppressed).toBe(1);
    expect(report.perRow[0].notes.join(" ")).toContain("suppressed");
  });

  it("counts prospects put on hold", () => {
    const report = commitImport(
      db,
      [paymentsRow({ "Review before contacting": "unverified claims" })],
      paymentsMapping()
    );
    expect(report.onHold).toBe(1);
  });

  it("merges two rows in one file that name the same company", () => {
    const report = commitImport(db, [paymentsRow(), paymentsRow()], paymentsMapping());
    expect(report.prospectsCreated).toBe(1);
    const counts = db.prepare("select count(*) as n from prospects").get() as { n: number };
    expect(counts.n).toBe(1);
  });

  it("writes nothing on a dry run", () => {
    const report = commitImport(db, [paymentsRow()], paymentsMapping(), { dryRun: true });
    expect(report.prospectsCreated).toBe(1);

    const counts = db.prepare("select count(*) as n from prospects").get() as { n: number };
    expect(counts.n).toBe(0);
  });

  it("saves the mapping so the next export of the same tab reuses it", () => {
    commitImport(db, [paymentsRow()], paymentsMapping(), {
      label: "High risk tab 1",
      sourceName: "high-risk-tab1.csv",
    });

    const reused = lastMappingFor(db, "high-risk-tab1.csv");
    expect(reused?.Store).toEqual({ kind: "prospect", field: "company" });
    expect(lastMappingFor(db, "never-seen.csv")).toBeNull();
  });
});

describe("fintech sheet end to end", () => {
  it("imports two contacts per row and dedupes on company when there is no domain", () => {
    const mapping = autoMap(FINTECH_HEADERS);
    const row = {
      Score: "147",
      Company: "Dakota",
      Type: "Startup",
      Segment: "Stablecoins and on-chain payments",
      HQ: "Fully remote",
      "Why it fits Paul": "Payments back-end work",
      "Role title": "Senior Software Engineer, Payments",
      "Apply / role URL": "https://jobs.ashbyhq.com/dakota/f4901f42",
      "Contact 1": "Ryan Bozarth",
      "C1 title": "Co-Founder & CEO",
      "C1 email": "ryan@dakota.xyz",
      "Contact 2": "Corey Wendling",
      "C2 title": "CTO",
      "C2 email": "corey@dakota.xyz",
    };

    const first = commitImport(db, [row], mapping);
    expect(first.prospectsCreated).toBe(1);
    expect(first.contactsCreated).toBe(2);

    // Re-importing the same tab after expanding it must not duplicate Dakota.
    const second = commitImport(db, [row], mapping);
    expect(second.prospectsCreated).toBe(0);
    expect(second.prospectsUpdated).toBe(1);
    expect(second.contactsCreated).toBe(0);
    expect(second.contactsUpdated).toBe(2);

    const prospect = db.prepare("select company_key, domain, custom from prospects").get() as {
      company_key: string;
      domain: string | null;
      custom: string;
    };
    expect(prospect.domain).toBeNull();
    expect(prospect.company_key).toBe("dakota");

    // The apply URL is research, not identity.
    const custom = parseJson<Record<string, string>>(prospect.custom, {});
    expect(custom.apply_role_url).toContain("ashbyhq.com");
  });

  it("does not store a shared inbox as a person's name", () => {
    // Real values from the fintech sheet. Storing these as names means a
    // template using {{first_name}} sends "Hi Squads," or "Hi Verafin,".
    const mapping = autoMap(FINTECH_HEADERS);
    const report = commitImport(
      db,
      [
        {
          Company: "Squads",
          "Contact 1": "Squads Talent",
          "C1 title": "Published talent inbox",
          "C1 email": "talent@sqds.io",
        },
        {
          Company: "Nasdaq Verafin",
          "Contact 1": "Verafin general enquiries",
          "C1 title": "Company email published on the Verafin site",
          "C1 email": "info@verafin.com",
        },
      ],
      mapping
    );

    const contacts = db
      .prepare("select email, name, custom from contacts order by id")
      .all() as { email: string; name: string | null; custom: string }[];

    expect(contacts.map((c) => c.name)).toEqual([null, null]);

    // The label is not lost, just moved out of the name field.
    expect(parseJson<Record<string, string>>(contacts[0].custom, {}).contact_label).toBe(
      "Squads Talent"
    );
    expect(report.perRow[0].notes.join(" ")).toContain("shared inbox");
  });

  it("still stores a real person's name", () => {
    const mapping = autoMap(FINTECH_HEADERS);
    commitImport(
      db,
      [
        {
          Company: "Dakota",
          "Contact 1": "Ryan Bozarth",
          "C1 title": "Co-Founder & CEO",
          "C1 email": "ryan@dakota.xyz",
        },
      ],
      mapping
    );

    const contact = db.prepare("select name from contacts").get() as { name: string };
    expect(contact.name).toBe("Ryan Bozarth");
  });

  it("keeps two companies apart even though they share an ATS host", () => {
    const mapping = autoMap(FINTECH_HEADERS);
    commitImport(
      db,
      [
        { Company: "Dakota", "Apply / role URL": "https://jobs.ashbyhq.com/dakota/x", "C1 email": "a@dakota.xyz" },
        { Company: "Bastion", "Apply / role URL": "https://jobs.ashbyhq.com/bastion/y", "C1 email": "b@bastion.xyz" },
      ],
      mapping
    );

    const counts = db.prepare("select count(*) as n from prospects").get() as { n: number };
    expect(counts.n).toBe(2);
  });
});
