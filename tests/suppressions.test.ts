import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import type { Db } from "@/lib/db";
import {
  FreemailSuppressionError,
  addSuppression,
  findSuppression,
  isSuppressed,
  parseDomainList,
  seedDomainSuppressions,
} from "@/lib/suppressions";
import { createTestDb } from "./helpers/db";

const EXCLUDE_LIST =
  "/Users/paulmadut/Desktop/peptide-outreach/research/exclude_master.txt";

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

describe("parseDomainList", () => {
  it("keeps the last entry when there is no trailing newline", () => {
    // The real file ends without a newline, so `wc -l` says 341 for 342
    // domains. A loader that trusts the line count drops the last one.
    const text = "first.com\nsecond.com\nthird.com";
    expect(parseDomainList(text)).toEqual(["first.com", "second.com", "third.com"]);
  });

  it("handles a trailing newline just as well", () => {
    expect(parseDomainList("a.com\nb.com\n")).toEqual(["a.com", "b.com"]);
  });

  it("skips blanks and comments", () => {
    const text = "# excluded stores\na.com\n\n   \nb.com\n# note\n";
    expect(parseDomainList(text)).toEqual(["a.com", "b.com"]);
  });

  it("normalises and dedupes", () => {
    const text = "https://www.A.com/page\na.com\nB.COM\n";
    expect(parseDomainList(text)).toEqual(["a.com", "b.com"]);
  });

  it("drops lines that are not domains", () => {
    expect(parseDomainList("a.com\nnot a domain\nlocalhost\nb.com")).toEqual([
      "a.com",
      "b.com",
    ]);
  });
});

describe("addSuppression", () => {
  it("adds and normalises an email", () => {
    expect(addSuppression(db, "email", "  Support@Store.COM ")).toBe(true);
    expect(isSuppressed(db, "support@store.com")).toBe(true);
  });

  it("is idempotent", () => {
    expect(addSuppression(db, "domain", "store.com")).toBe(true);
    expect(addSuppression(db, "domain", "store.com")).toBe(false);
  });

  it("refuses to suppress a consumer mailbox domain", () => {
    // Blocking gmail.com at the domain level would retire every personal
    // address in the database at once.
    expect(() => addSuppression(db, "domain", "gmail.com")).toThrow(FreemailSuppressionError);
    expect(() => addSuppression(db, "domain", "ICLOUD.COM")).toThrow(FreemailSuppressionError);
  });

  it("still allows suppressing an individual consumer address", () => {
    expect(addSuppression(db, "email", "someone@gmail.com")).toBe(true);
    expect(isSuppressed(db, "someone@gmail.com")).toBe(true);
    expect(isSuppressed(db, "another@gmail.com")).toBe(false);
  });

  it("ignores unparsable values", () => {
    expect(addSuppression(db, "email", "contact form only")).toBe(false);
    expect(addSuppression(db, "domain", "")).toBe(false);
  });
});

describe("findSuppression", () => {
  it("matches an exact address", () => {
    addSuppression(db, "email", "support@store.com", "Asked to stop");
    const hit = findSuppression(db, "Support@Store.com");
    expect(hit?.kind).toBe("email");
    expect(hit?.reason).toBe("Asked to stop");
  });

  it("matches the whole domain", () => {
    addSuppression(db, "domain", "store.com", "Already a client");
    const hit = findSuppression(db, "anyone@store.com");
    expect(hit?.kind).toBe("domain");
  });

  it("returns null for an address that is clear", () => {
    expect(findSuppression(db, "new@prospect.com")).toBeNull();
  });
});

describe("seedDomainSuppressions", () => {
  it("reports what it added and skips duplicates on a second run", () => {
    const text = "a.com\nb.com\nc.com";

    const first = seedDomainSuppressions(db, text, "test");
    expect(first).toMatchObject({ parsed: 3, added: 3, alreadyPresent: 0, refused: [] });

    const second = seedDomainSuppressions(db, text, "test");
    expect(second).toMatchObject({ parsed: 3, added: 0, alreadyPresent: 3 });
  });

  it("records refusals instead of failing the whole load", () => {
    const report = seedDomainSuppressions(db, "store.com\ngmail.com\nother.com", "test");
    expect(report.added).toBe(2);
    expect(report.refused).toEqual(["gmail.com"]);
  });
});

// Runs only on Paul's machine, where the real list exists.
describe.skipIf(!existsSync(EXCLUDE_LIST))("the real exclude list", () => {
  it("parses all 342 entries, including the last one with no trailing newline", () => {
    const text = readFileSync(EXCLUDE_LIST, "utf8");
    const report = seedDomainSuppressions(db, text, "exclude_master.txt");

    expect(report.parsed).toBe(342);

    // The specific entry a line-count loader loses.
    expect(isSuppressed(db, "anyone@yourkratom.com")).toBe(true);
    // And the first, to prove the range is covered.
    expect(isSuppressed(db, "anyone@7ohofficial.com")).toBe(true);
  });

  it("refuses the two consumer domains the list contains", () => {
    // The real list has gmail.com and outlook.com in it. Honouring those as
    // domain blocks would suppress every consumer address at once, including
    // real prospects: the research data has stores whose only published
    // contact is a Gmail address. They are reported, not silently dropped.
    const text = readFileSync(EXCLUDE_LIST, "utf8");
    const report = seedDomainSuppressions(db, text, "exclude_master.txt");

    expect(report.refused.sort()).toEqual(["gmail.com", "outlook.com"]);
    expect(report.added).toBe(340);

    // A store reachable only at a Gmail address stays contactable.
    expect(isSuppressed(db, "sarmsasiastore@gmail.com")).toBe(false);
  });
});
