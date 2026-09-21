import { describe, expect, it } from "vitest";
import { selectContacts } from "@/lib/enroll/select";
import { createTestDb } from "./helpers/db";
import type { Db } from "@/lib/db";

/**
 * Who a filter picks.
 *
 * Both the dashboard and `pnpm campaign enroll` route through this, so a
 * mistake here emails the wrong people from either entry point. The case that
 * matters most is the exclude pattern: a search for stores whose card payments
 * are down also finds the store announcing it is taking cards again, which is
 * the single worst recipient for that email.
 */

interface Row {
  company: string;
  research: string;
  grade?: string;
  channel?: string;
  email?: string | null;
  vertical?: string | null;
}

function seed(db: Db, rows: Row[]): void {
  for (const [index, row] of rows.entries()) {
    const prospect = db
      .prepare(
        "insert into prospects (company, company_key, vertical, grade, custom) values (?, ?, ?, ?, ?)"
      )
      .run(
        row.company,
        row.company.toLowerCase().replace(/\W+/g, "-"),
        row.vertical ?? null,
        row.grade ?? "B",
        JSON.stringify({ "Trouble sign": row.research })
      );

    db.prepare(
      "insert into contacts (prospect_id, email, channel) values (?, ?, ?)"
    ).run(
      prospect.lastInsertRowid,
      row.email === undefined ? `support${index}@store.com` : row.email,
      row.channel ?? "email"
    );
  }
}

describe("selectContacts", () => {
  it("returns every emailable contact when no filter is given", () => {
    const db = createTestDb();
    seed(db, [
      { company: "Alpha", research: "cards off" },
      { company: "Beta", research: "crypto only" },
    ]);

    const result = selectContacts(db);

    expect(result.error).toBeNull();
    expect(result.contacts).toHaveLength(2);
    expect(result.considered).toBe(2);
  });

  it("skips contacts with no email address", () => {
    const db = createTestDb();
    seed(db, [
      { company: "Alpha", research: "cards off" },
      { company: "Phone Only", research: "cards off", channel: "phone", email: null },
      { company: "Form Only", research: "cards off", channel: "contact_form", email: null },
    ]);

    const result = selectContacts(db);

    expect(result.contacts.map((contact) => contact.company)).toEqual(["Alpha"]);
  });

  it("searches every imported column, not just the vertical", () => {
    const db = createTestDb();
    seed(db, [
      { company: "Down Store", research: "checkout temporarily unavailable" },
      { company: "Fine Store", research: "all good" },
    ]);

    const result = selectContacts(db, { match: "unavailable" });

    expect(result.contacts.map((contact) => contact.company)).toEqual(["Down Store"]);
  });

  it("excludes the opposite case, which the match alone would catch", () => {
    const db = createTestDb();
    seed(db, [
      { company: "Down Store", research: "card payments unavailable right now" },
      { company: "Recovered", research: "card payments unavailable last month, accepting cards again" },
    ]);

    const both = selectContacts(db, { match: "unavailable" });
    expect(both.contacts).toHaveLength(2);

    const narrowed = selectContacts(db, {
      match: "unavailable",
      exclude: "cards again|accepting cards",
    });
    expect(narrowed.contacts.map((contact) => contact.company)).toEqual(["Down Store"]);
  });

  it("matches without regard to case", () => {
    const db = createTestDb();
    seed(db, [{ company: "Shouty", research: "CHECKOUT UNAVAILABLE" }]);

    expect(selectContacts(db, { match: "unavailable" }).contacts).toHaveLength(1);
  });

  it("puts grade A first, so the best prospects take the earliest slots", () => {
    const db = createTestDb();
    seed(db, [
      { company: "Cee", research: "x", grade: "C" },
      { company: "Ay", research: "x", grade: "A" },
      { company: "Bee", research: "x", grade: "B" },
    ]);

    expect(selectContacts(db).contacts.map((contact) => contact.company)).toEqual([
      "Ay",
      "Bee",
      "Cee",
    ]);
  });

  it("applies the limit after ordering, so a small batch is the best prospects", () => {
    const db = createTestDb();
    seed(db, [
      { company: "Cee", research: "x", grade: "C" },
      { company: "Ay", research: "x", grade: "A" },
      { company: "Bee", research: "x", grade: "B" },
    ]);

    const result = selectContacts(db, { limit: 2 });

    expect(result.contacts.map((contact) => contact.company)).toEqual(["Ay", "Bee"]);
  });

  it("filters by grade", () => {
    const db = createTestDb();
    seed(db, [
      { company: "Ay", research: "x", grade: "A" },
      { company: "Bee", research: "x", grade: "B" },
    ]);

    const result = selectContacts(db, { grade: "A" });

    expect(result.contacts.map((contact) => contact.company)).toEqual(["Ay"]);
    // `considered` counts what the grade filter left, not the whole table.
    expect(result.considered).toBe(1);
  });

  it("reports a bad pattern instead of throwing", () => {
    const db = createTestDb();
    seed(db, [{ company: "Alpha", research: "x" }]);

    const result = selectContacts(db, { match: "(unclosed" });

    expect(result.error).toBeTruthy();
    expect(result.contacts).toEqual([]);
  });

  it("returns the matched text, so a wrong pattern is visible before it is used", () => {
    const db = createTestDb();
    seed(db, [
      {
        company: "Down Store",
        research: "Their checkout says payments are temporarily unavailable while they move",
      },
    ]);

    const [contact] = selectContacts(db, { match: "temporarily unavailable" }).contacts;

    expect(contact.excerpt).toContain("temporarily unavailable");
  });

  it("searches the vertical as well as the custom columns", () => {
    const db = createTestDb();
    seed(db, [
      { company: "Kratom Co", research: "nothing useful", vertical: "kratom" },
      { company: "Peptide Co", research: "nothing useful", vertical: "peptides" },
    ]);

    const result = selectContacts(db, { match: "kratom" });

    expect(result.contacts.map((contact) => contact.company)).toEqual(["Kratom Co"]);
  });
});
