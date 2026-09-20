#!/usr/bin/env tsx
/**
 * Seed a demo database so the dashboard can be looked at without sending
 * anything. Uses OUTREACH_DB, so it never touches the real database unless
 * you point it there.
 */
import { getDb } from "@/lib/db";
import { createCampaign, createMailbox, setCampaignStatus, upsertStep } from "@/lib/campaign";
import { enrollContacts, approveDrafts } from "@/lib/enroll";
import { runSendTick } from "@/lib/worker/send-tick";
import { applyInbound, buildSentLookup } from "@/lib/worker/poll-mailbox";
import { getMailbox } from "@/lib/campaign";
import type { FetchedMessage } from "@/lib/mail/imap";

async function main() {
  const db = getDb();


  const mailboxId = createMailbox(db, {
    label: "payments", fromName: "Paul Madut", fromEmail: "paul@paymentswithpaul.com",
    provider: "icloud", keychainService: "icloud-smtp-outreach",
    keychainAccount: "paul.madut@icloud.com", timezone: "UTC",
    dailyCap: 20, minGapSeconds: 0, gapJitterSeconds: 0,
  });

  const campaignId = createCampaign(db, {
    mailboxId, name: "high-risk payments", timezone: "UTC",
    windowStart: "00:00", windowEnd: "23:59", sendDays: [1,2,3,4,5,6,7], newPerDay: 20,
    footerTemplate: "Reply and I will not email again.\n123 Example St, Ottawa ON",
  });
  upsertStep(db, { campaignId, stepNumber: 1, subjectTemplate: "Quick question",
    bodyTemplate: "Your site says {{payment_methods_today}}.\n\nThat means every order is manual." });
  upsertStep(db, { campaignId, stepNumber: 2, delayDays: 3, subjectTemplate: "x",
    bodyTemplate: "Following up on {{company}}." });
  setCampaignStatus(db, campaignId, "active");

  const stores = [
    ["Otie's Botanicals","otiesbotanicals.com","kratom","A","support@otiesbotanicals.com","Bitcoin, Ethereum (10% off)"],
    ["Blinker Cart Shop","blinkercartshop.com","thc vapes","A","sale@blinkercartshop.com","BTC, LTC, Zelle, Venmo"],
    ["Bulk THCa Supply","bulkthcasupply.com","thca wholesale","A","support@bulkthcasupply.com","Bank wire only"],
    ["Canada Kratom Store","canadakratomstore.com","kratom","B","support@canadakratomstore.com","Interac e-Transfer, COD"],
    ["Quantum Exotics","quantumexotics.com","thca","C",null,"Zelle, Cash App, Venmo"],
  ];

  for (const [company, domain, vertical, grade, email, payments] of stores) {
    const p = db.prepare(
      "insert into prospects (company,company_key,domain,vertical,grade,custom) values (?,?,?,?,?,?)"
    ).run(company, domain!.split(".")[0], domain, vertical, grade,
          JSON.stringify({ payment_methods_today: payments }));
    db.prepare("insert into contacts (prospect_id,email,channel,channel_detail) values (?,?,?,?)")
      .run(p.lastInsertRowid, email, email ? "email" : "phone", email ? null : "phone only: (727-424-8504)");
  }

  const result = enrollContacts(db, campaignId);
  console.log(`enrolled ${result.enrolled}, drafted ${result.drafted}, skipped ${result.skipped.length}`);

  // Approve and "send" two of them through a stub so there is history to look at.
  const drafts = db.prepare("select id from messages where status='draft' limit 2").all() as {id:number}[];
  approveDrafts(db, drafts.map(d => d.id));
  db.prepare("update messages set scheduled_at = ? where status='scheduled'").run(new Date(Date.now()-60000).toISOString());

  const sent = await runSendTick(db, { limit: 2, sender: async () => ({ response: "250 queued" }) });
  console.log(`sent ${sent.sent}, follow-ups ${sent.followUpsCreated}`);

  // One reply and one bounce, so the inbox has something in it.
  const sentRows = db.prepare("select id,message_id,to_email from messages where status='sent'").all() as
    {id:number; message_id:string; to_email:string}[];
  const mailbox = getMailbox(db, mailboxId);
  const lookup = buildSentLookup(db, mailboxId);
  const blank = { mailbox:"payments", fetched:0, replies:0, autoReplies:0, bounces:0,
    unsubscribes:0, unmatched:0, stopped:0, suppressed:0, notes:[] as string[] };

  if (sentRows[0]) {
    applyInbound(db, mailbox, {
      uid:1, folder:"INBOX", receivedAt:new Date(),
      headers:{ from:`Owner <${sentRows[0].to_email}>`, subject:"Re: Quick question",
        messageId:"<r1@store.com>", inReplyTo:sentRows[0].message_id },
      text:"What would this cost?", raw:"",
    } as FetchedMessage, lookup, { ...blank });
  }
  if (sentRows[1]) {
    applyInbound(db, mailbox, {
      uid:2, folder:"INBOX", receivedAt:new Date(),
      headers:{ from:"MAILER-DAEMON@store.com", subject:"Delivery Status Notification (Failure)",
        messageId:"<b1@store.com>", contentType:"multipart/report; report-type=delivery-status",
        returnPath:"<>", references:[sentRows[1].message_id] },
      text:"Address not found",
      raw:`Final-Recipient: rfc822; ${sentRows[1].to_email}\nAction: failed\nStatus: 5.1.1\nMessage-ID: ${sentRows[1].message_id}`,
    } as FetchedMessage, lookup, { ...blank });
  }

  console.log("demo database ready");
}

main();
