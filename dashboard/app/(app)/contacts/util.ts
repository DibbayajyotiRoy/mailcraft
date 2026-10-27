import { ruleWords } from "../_p3/rules";

export type Contact = {
  id?: string; email: string; name?: string; first_name?: string | null; last_name?: string | null; status?: string; timezone?: string | null;
  properties?: Record<string, unknown>; created_at?: string; suppressed?: boolean; suppression_reason?: string | null;
  topics?: (string | { name?: string; topic?: string; subscribed?: boolean; status?: string })[];
};
export type Segment = { id: string; name: string; filter?: unknown; member_count?: number; members?: number; count?: number; description?: string };

export const fullName = (c: Contact) => c.name ?? [c.first_name, c.last_name].filter(Boolean).join(" ");
export const isSuppressed = (c: Contact) => !!c.suppressed || c.status === "suppressed";
export const initials = (c: Contact) => (fullName(c) || c.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
export const memberCount = (s: Segment): number | null => s.member_count ?? s.members ?? s.count ?? null;
export const segmentRule = (s: Segment): string => ruleWords(s.filter) ?? (s.filter ? "Custom filter" : "No filter: members are added manually");

export function matches(c: Contact, q: string): boolean {
  const n = q.trim().toLowerCase();
  return !n || c.email.toLowerCase().includes(n) || fullName(c).toLowerCase().includes(n);
}

export function topicList(c: Contact): { name: string; subscribed: boolean }[] {
  return (c.topics ?? []).map((t) => typeof t === "string" ? { name: t, subscribed: true }
    : { name: t.name ?? t.topic ?? "topic", subscribed: t.subscribed ?? t.status !== "unsubscribed" });
}
