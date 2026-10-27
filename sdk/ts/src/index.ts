import type { components } from "./schema.js";

export type SendEmail = components["schemas"]["SendEmail"];
export type ApiError = { code: string; message: string; field?: string; hint?: string; doc_url?: string; retryable: boolean };
export type Result<T> =
  | { data: T; error: null; requestId?: string; nextCursor?: string | null }
  | { data: null; error: ApiError; requestId?: string };

type Obj = Record<string, unknown>;
type Page = { limit?: number; cursor?: string };
type Opts = { idempotencyKey?: string };

// Types below are NOT in openapi.yaml yet; they follow docs/ASSUMED-ENDPOINTS.md.
export type Email = { id: string; from: string; to: string[]; subject: string; status: string; stream: string; created_at: string; last_event?: string; events?: Obj[]; policy_decisions?: Obj[]; rendered?: { html: string; text: string } };
export type SendResult = { id: string; status: "queued" | "pending_approval" | "blocked_by_policy"; stream: string; policy_decisions: { rule: string; decision: string }[]; recipients: { email: string; id: string }[]; rendered?: Obj; lint?: Obj[]; would_send_via?: string };
export type DnsRecord = { record: string; type: string; name: string; value: string; priority?: number; status: string };
export type Domain = { id: string; name: string; status: "not_started" | "pending" | "verified" | "failed"; records: DnsRecord[] };
export type Template = { id: string; name: string; subject?: string; html?: string; mjml?: string; text?: string; status?: string };
export type Contact = { id: string; email: string; properties?: Obj };
export type EventResult = { event_id: string; contact_id: string; triggered_automations: { id: string; run_id: string }[]; would_send: Obj[] };
export type Automation = { id: string; name: string; status?: string; trigger: Obj; steps: Obj[] } & Obj;
export type Approval = { id: string; kind: string; status: string; payload: Obj; requested_by?: string };
export type ApiKey = { id: string; prefix: string; scopes: string[]; env: "test" | "live" } & Obj;

export class Mailcraft {
  private base: string;
  private fetchFn: typeof fetch;
  constructor(private apiKey: string, o: { baseUrl?: string; fetch?: typeof fetch } = {}) {
    this.base = (o.baseUrl ?? "http://localhost:8080").replace(/\/$/, "");
    this.fetchFn = o.fetch ?? ((...a) => fetch(...a));
  }

  /** Never throws for API or network errors; returns {data, error}. */
  async request<T>(method: string, path: string, o: { body?: unknown; query?: Obj; idempotencyKey?: string } = {}): Promise<Result<T>> {
    const qs = new URLSearchParams(Object.entries(o.query ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    if (o.idempotencyKey) headers["Idempotency-Key"] = o.idempotencyKey;
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path + (qs ? "?" + qs : ""), { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    } catch (e) {
      return { data: null, error: { code: "network_error", message: (e as Error).message, retryable: true } };
    }
    let env: any;
    try { env = await res.json(); } catch { env = undefined; }
    if (env?.ok === true) return { data: env.data as T, error: null, requestId: env.request_id, nextCursor: env.next_cursor };
    const error: ApiError = env?.error ?? { code: "bad_response", message: `HTTP ${res.status}`, retryable: res.status >= 500 };
    return { data: null, error, requestId: env?.request_id };
  }

  private get = <T>(p: string, query?: Obj) => this.request<T>("GET", p, { query });
  private send = <T>(m: string, p: string, body?: unknown, o?: Opts) => this.request<T>(m, p, { body: body ?? {}, idempotencyKey: o?.idempotencyKey });

  emails = {
    send: (e: SendEmail, o?: Opts) => this.send<SendResult>("POST", "/v1/emails", e, o),
    get: (id: string) => this.get<Email>(`/v1/emails/${enc(id)}`),
    list: (q: Page & { status?: string; to?: string; since?: string } = {}) => this.get<Email[]>("/v1/emails", q),
    cancel: (id: string, o?: Opts) => this.send<Email>("POST", `/v1/emails/${enc(id)}/cancel`, {}, o),
  };
  domains = {
    create: (d: { domain: string; stream?: "transactional" | "marketing" }, o?: Opts) => this.send<Domain>("POST", "/v1/domains", d, o),
    verify: (id: string) => this.send<Domain>("POST", `/v1/domains/${enc(id)}/verify`),
    list: (q: Page = {}) => this.get<Domain[]>("/v1/domains", q),
    get: (id: string) => this.get<Domain>(`/v1/domains/${enc(id)}`),
    remove: (id: string) => this.request<Obj>("DELETE", `/v1/domains/${enc(id)}`),
  };
  templates = {
    create: (t: Omit<Template, "id">, o?: Opts) => this.send<Template>("POST", "/v1/templates", t, o),
    get: (id: string) => this.get<Template>(`/v1/templates/${enc(id)}`),
    list: (q: Page = {}) => this.get<Template[]>("/v1/templates", q),
    update: (id: string, t: Partial<Template>, o?: Opts) => this.send<Template>("PATCH", `/v1/templates/${enc(id)}`, t, o),
    publish: (id: string, o?: Opts) => this.send<Template>("POST", `/v1/templates/${enc(id)}/publish`, {}, o),
    preview: (id: string, variables: Obj = {}) => this.send<{ subject: string; html: string; text: string; lint: Obj[] }>("POST", `/v1/templates/${enc(id)}/preview`, { variables }),
    import: (t: { format: "html" | "mjml" | "json"; name: string; content: string }, o?: Opts) => this.send<Template>("POST", "/v1/templates/import", t, o),
    export: (id: string, format: "html" | "mjml" | "json" = "html") => this.get<{ format: string; content: string }>(`/v1/templates/${enc(id)}/export`, { format }),
  };
  contacts = {
    upsert: (c: { email: string; properties?: Obj }, o?: Opts) => this.send<Contact>("PUT", "/v1/contacts", c, o),
    get: (idOrEmail: string) => this.get<Contact>(`/v1/contacts/${enc(idOrEmail)}`),
    list: (q: Page = {}) => this.get<Contact[]>("/v1/contacts", q),
    update: (idOrEmail: string, c: { properties?: Obj }, o?: Opts) => this.send<Contact>("PATCH", `/v1/contacts/${enc(idOrEmail)}`, c, o),
    remove: (idOrEmail: string) => this.request<Obj>("DELETE", `/v1/contacts/${enc(idOrEmail)}`),
  };
  events = {
    track: (e: { name: string; contact: { email: string }; properties?: Obj; contact_properties?: Obj; dry_run?: boolean }, o?: Opts) => this.send<EventResult>("POST", "/v1/events", e, o),
  };
  automations = {
    create: (a: Omit<Automation, "id">, o?: Opts) => this.send<Automation>("POST", "/v1/automations", a, o),
    get: (id: string) => this.get<Automation>(`/v1/automations/${enc(id)}`),
    list: (q: Page = {}) => this.get<Automation[]>("/v1/automations", q),
    update: (id: string, a: Partial<Automation>, o?: Opts) => this.send<Automation>("PATCH", `/v1/automations/${enc(id)}`, a, o),
    publish: (id: string, o?: Opts) => this.send<Automation>("POST", `/v1/automations/${enc(id)}/publish`, {}, o),
    pause: (id: string, o?: Opts) => this.send<Automation>("POST", `/v1/automations/${enc(id)}/pause`, {}, o),
    resume: (id: string, o?: Opts) => this.send<Automation>("POST", `/v1/automations/${enc(id)}/resume`, {}, o),
    simulate: (id: string, event: Obj = {}) => this.send<Obj>("POST", `/v1/automations/${enc(id)}/simulate`, { event }),
    runs: (id: string, q: Page & { status?: string } = {}) => this.get<Obj[]>(`/v1/automations/${enc(id)}/runs`, q),
  };
  approvals = {
    list: (q: Page & { status?: string } = {}) => this.get<Approval[]>("/v1/approvals", q),
    get: (id: string) => this.get<Approval>(`/v1/approvals/${enc(id)}`),
  };
  keys = { list: (q: Page = {}) => this.get<ApiKey[]>("/v1/keys", q) };
  killSwitch = { get: () => this.get<{ on: boolean; since?: string; by?: string }>("/v1/kill-switch") };
}

const enc = encodeURIComponent;
