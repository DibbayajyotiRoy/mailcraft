// Pure helpers behind the contact-aware To field of the "New email" dialog (no React, no server imports: unit-tested).
import type { ApiError } from "@/lib/api";
import { isEmail } from "@/lib/compose";

/** What the dialog needs of a contact: enough to label a chip, prefill first_name and refuse a suppressed one. */
export type ContactHit = { id?: string; email: string; first_name?: string | null; last_name?: string | null; suppressed?: boolean; suppression_reason?: string | null };
export type NewContact = { email: string; first_name?: string; last_name?: string; timezone?: string };
/** The three contact calls the dialog makes (server actions in the app, stubs in tests). */
export type ContactsApi = {
  /** GET /v1/contacts?q=…&limit=8 */
  search: (q: string) => Promise<ContactHit[]>;
  /** Exact lookup by email: `contact: null` and no `error` means "not a contact yet". */
  find: (email: string) => Promise<{ contact: ContactHit | null; error?: ApiError }>;
  /** PUT /v1/contacts */
  create: (c: NewContact) => Promise<{ error?: ApiError }>;
};

/** A chip in the To field. `contact` is set once the address is known to be an existing contact: picked from the suggestions, or found by the exact lookup at send time. */
export type Recipient = { email: string; contact?: ContactHit };

export const contactName = (c: ContactHit) => [c.first_name, c.last_name].filter(Boolean).join(" ");

/** Typed or pasted text -> addresses: commas, semicolons and newlines separate; "a@x.co b@x.co" splits on the space only when every part has an @ (so "Ada Lovelace" stays one search). */
export function splitAddresses(s: string): string[] {
  return s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).flatMap((x) => { const w = x.split(/\s+/); return w.length > 1 && w.every((p) => p.includes("@")) ? w : [x]; });
}

/** Appends addresses, skipping case-insensitive duplicates. `known` supplies the contact behind an address that came from a suggestion. */
export function addRecipients(list: Recipient[], emails: string[], known: ContactHit[] = []): Recipient[] {
  const out = [...list], seen = new Set(list.map((r) => r.email.toLowerCase()));
  for (const email of emails) {
    const k = email.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push({ email, contact: known.find((h) => h.email.toLowerCase() === k) }); }
  }
  return out;
}

export const isSuppressed = (c?: ContactHit) => !!c?.suppressed;

/** Why the chips can't be sent as they are, or undefined. */
export function recipientProblem(list: Recipient[]): string | undefined {
  const bad = list.find((r) => !isEmail(r.email));
  if (bad) return `“${bad.email}” is not an email address.`;
  const sup = list.filter((r) => isSuppressed(r.contact));
  if (!sup.length) return undefined;
  const reason = sup.length === 1 && sup[0].contact?.suppression_reason ? ` (${sup[0].contact.suppression_reason.replace(/_/g, " ")})` : "";
  return `${sup.map((r) => r.email).join(", ")} ${sup.length > 1 ? "are" : "is"} suppressed${reason}, so mailcraft won’t send to ${sup.length > 1 ? "them" : "it"}. Remove ${sup.length > 1 ? "them" : "it"} to continue.`;
}

/** With exactly one recipient who is a contact, their first name fills a blank first_name template variable. */
export function prefillVars(vars: Record<string, string>, asked: string[], list: Recipient[]): Record<string, string> {
  const first = list.length === 1 ? list[0].contact?.first_name : undefined;
  return first && asked.includes("first_name") && vars.first_name === undefined ? { ...vars, first_name: first } : vars;
}
