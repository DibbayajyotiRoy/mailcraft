// The From addresses the API derives from connected mailboxes (GET /v1/senders), and small helpers around them.
export type Sender = {
  address: string; display_name?: string | null; kind?: "login" | "alias" | "domain"; status?: string;
  transport?: string | null; transport_id?: string | null; is_default?: boolean;
};

/** "Acme Support <support@example.com>" or just the address. */
export const senderLabel = (s: Sender) => (s.display_name ? `${s.display_name} <${s.address}>` : s.address);

/** The bare address of "Name <a@b.c>" or "a@b.c", lowercased. */
export const addressOf = (from: string) => (/<([^>]+)>\s*$/.exec(from)?.[1] ?? from).trim().toLowerCase();

export const findSender = (senders: Sender[], from: string) => senders.find((s) => s.address.toLowerCase() === addressOf(from));

/** Sender rows grouped by the transport they send through, in list order. Addresses with no transport go under "". */
export function byTransport(senders: Sender[]): [string, Sender[]][] {
  const m = new Map<string, Sender[]>();
  for (const s of senders) m.set(s.transport_id ?? "", [...(m.get(s.transport_id ?? "") ?? []), s]);
  return [...m];
}

export const STATUS_LABEL: Record<string, string> = { ready: "ready", needs_domain: "needs domain", transport_missing: "no transport" };

/** What the From control starts on: the workspace default, else the only connected address. */
export const initialFrom = (defaultFrom: string | null | undefined, senders: Sender[]) =>
  defaultFrom || (senders.length === 1 ? senders[0].address : "");

/** The senders list as the pages need it: a failed call degrades to "type the address yourself". */
export const sendersOf = (r: { data: unknown }): Sender[] => (Array.isArray(r.data) ? (r.data as Sender[]) : []);
