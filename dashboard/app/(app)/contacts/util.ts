import { ruleWords } from "@/lib/rules";

export type Contact = {
  id?: string; email: string; name?: string; first_name?: string | null; last_name?: string | null; status?: string; timezone?: string | null;
  properties?: Record<string, unknown>; created_at?: string; suppressed?: boolean; suppression_reason?: string | null; lists?: ListRef[];
};
export type ListOrigin = "manual" | "import" | "source";
/** The lists a contact is on (GET /v1/contacts). */
export type ListRef = { id: string; name: string; origin: ListOrigin };
/** GET /v1/lists */
export type ListItem = { id: string; name: string; description?: string | null; origin: ListOrigin; source_id?: string | null; detached?: boolean; member_count: number; created_at?: string };
/** Lists a person can put contacts on by hand: not one a contact source fills. */
export const pickableLists = (lists: ListItem[]) => lists.filter((l) => !(l.origin === "source" && !l.detached));
export const originLabel = (l: Pick<ListItem, "origin" | "detached">) => (l.origin === "source" ? (l.detached ? "Source (detached)" : "Contact source") : l.origin === "import" ? "CSV import" : "Manual");
export type Segment = { id: string; name: string; filter?: unknown; member_count?: number; members?: number; count?: number };

/** GET /v1/contacts/{id}/activity */
export type Activity = {
  events: { id: string; name: string; properties?: Record<string, unknown>; received_at: string }[];
  emails: { id: string; subject: string; status: string; stream: string; created_at: string }[];
  runs: { id: string; automation_id: string; automation: string; state: string; current_step?: string | null; started_at: string }[];
  topics: { key: string; name: string; opted_in: boolean }[];
  segments: { id: string; name: string }[];
};

export const fullName = (c: Contact) => c.name ?? [c.first_name, c.last_name].filter(Boolean).join(" ");
export const isSuppressed = (c: Contact) => !!c.suppressed || c.status === "suppressed";
export const initials = (c: Contact) => (fullName(c) || c.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
export const memberCount = (s: Segment): number | null => s.member_count ?? s.members ?? s.count ?? null;
export const segmentRule = (s: Segment): string => ruleWords(s.filter) ?? (s.filter ? "Custom filter" : "A manual list: you add the members");
