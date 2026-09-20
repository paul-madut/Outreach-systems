/**
 * Consumer mailbox domains.
 *
 * Two places need this. Domain-level reply matching must not fire on these, or
 * one gmail.com prospect replying would stop an unrelated gmail.com prospect's
 * sequence. Domain-level suppression must refuse them outright, because
 * suppressing "gmail.com" would retire every consumer address at once.
 */
const FREEMAIL_DOMAINS = new Set([
  "aol.com",
  "boxbe.com",
  "comcast.net",
  "duck.com",
  "fastmail.com",
  "gmail.com",
  "googlemail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "hey.com",
  "hotmail.co.uk",
  "hotmail.com",
  "hotmail.fr",
  "icloud.com",
  "inbox.com",
  "live.com",
  "live.co.uk",
  "mac.com",
  "mail.com",
  "mail.ru",
  "me.com",
  "msn.com",
  "outlook.com",
  "outlook.co.uk",
  "pm.me",
  "proton.me",
  "protonmail.ch",
  "protonmail.com",
  "qq.com",
  "rocketmail.com",
  "sbcglobal.net",
  "shaw.ca",
  "sympatico.ca",
  "telus.net",
  "tutanota.com",
  "verizon.net",
  "web.de",
  "yahoo.ca",
  "yahoo.co.uk",
  "yahoo.com",
  "yandex.com",
  "yandex.ru",
  "ymail.com",
  "zoho.com",
]);

export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain.trim().toLowerCase().replace(/^www\./, ""));
}

export function freemailDomains(): string[] {
  return [...FREEMAIL_DOMAINS];
}
