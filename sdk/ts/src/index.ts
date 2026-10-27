import type { components } from "./schema.js";

export type SendEmail = components["schemas"]["SendEmail"];
export type SendResult = components["schemas"]["SendResult"];
export type CreateKey = components["schemas"]["CreateKey"];
export type KeyPolicy = components["schemas"]["KeyPolicy"];
export type ApiError = { code: string; message: string; field?: string; hint?: string; doc_url?: string; retryable: boolean };
export type Result<T> =
  | { data: T; error: null; requestId?: string; nextCursor?: string | null }
  | { data: null; error: ApiError; requestId?: string };

type Obj = Record<string, unknown>;
type Page = { limit?: number; cursor?: string };
type Opts = { idempotencyKey?: string };

// Response bodies the spec leaves untyped ("description" only); shapes taken from crates/mailcraft-api
// and pinned by docs/contract/fixtures.json. Ids are plain UUIDs.
export type Email = { id: string; status: string; stream: string; env: "test" | "live"; from_addr: string; to_addr: string; subject: string; tags: Obj[]; policy_decisions: Obj[]; scheduled_at: string | null; attempts: number; last_error: string | null; sent_at: string | null; created_at: string };
export type EmailEvent = { type: string; enhanced_code: string | null; diagnostic: string | null; occurred_at: string };
export type DryRun = { dry_run: true; status: string; stream: string; policy_decisions: Obj[]; rendered: { subject?: string; html?: string; text?: string; headers: Obj }; lint: Obj[]; would_send_via: string };
export type BatchItem = { ok: true; data: SendResult } | { ok: false; error: ApiError };
export type Approval = { id: string; kind: "email" | "go_live" | "policy_change"; status: "pending" | "approved" | "rejected" | "expired"; subject_id: string | null; requested_by: string | null; payload: Obj; decided_by_key: string | null; decided_at: string | null; created_at: string };
export type ApiKey = { id: string; name: string; prefix: string; env: "test" | "live"; scopes: string[]; domain_id: string | null; policy: KeyPolicy; recipient_allowlist: string[] | null; daily_send_cap: number | null; minute_send_cap: number | null; paused: boolean; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; created_at: string };
export type CreatedKey = { id: string; name: string; env: "test" | "live"; scopes: string[]; token: string; prefix: string };
export type KillSwitch = { on: boolean; paused_keys: string[] };
export type AccountStatus = { workspace: string; kill_switch: boolean; live_enabled: boolean; pending_approvals: number; key: { id: string; name: string; env: "test" | "live"; scopes: string[] } };
export type AuditRow = { id: number; at: string; actor_type: string; actor_id: string | null; action: string; args: Obj; decision: string; approval_id: string | null };

// Types below are NOT on main yet; they follow docs/ASSUMED-ENDPOINTS.md.
export type DnsRecord = { record: string; type: string; name: string; value: string; priority?: number; status: string };
export type Domain = { id: string; name: string; status: "not_started" | "pending" | "verified" | "failed"; records: DnsRecord[] };
export type Template = { id: string; name: string; subject?: string; html?: string; mjml?: string; text?: string; status?: string };
export type Contact = { id: string; email: string; properties?: Obj };
export type EventResult = { event_id: string; contact_id: string; triggered_automations: { id: string; run_id: string }[]; would_send: Obj[] };
export type Automation = { id: string; name: string; status?: string; trigger: Obj; steps: Obj[] } & Obj;

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
    /** 202 -> SendResult (status queued | pending_approval + approval_id); with dry_run:true the 200 body is a DryRun. */
    send: (e: SendEmail, o?: Opts) => this.send<SendResult & Partial<DryRun>>("POST", "/v1/emails", e, o),
    batch: (emails: SendEmail[], o?: Opts) => this.send<BatchItem[]>("POST", "/v1/emails/batch", { emails }, o),
    get: (id: string) => this.get<Email>(`/v1/emails/${enc(id)}`),
    list: (q: Page & { status?: string } = {}) => this.get<Email[]>("/v1/emails", q),
    events: (id: string) => this.get<EmailEvent[]>(`/v1/emails/${enc(id)}/events`),
    cancel: (id: string, o?: Opts) => this.send<{ id: string; status: "cancelled" }>("POST", `/v1/emails/${enc(id)}/cancel`, {}, o),
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
    list: (q: { status?: Approval["status"]; limit?: number } = {}) => this.get<Approval[]>("/v1/approvals", q),
    get: (id: string) => this.get<Approval>(`/v1/approvals/${enc(id)}`),
    /** Needs an admin key; agent keys get 403 forbidden_scope. */
    decide: (id: string, decision: "approve" | "reject") => this.send<{ id: string; status: "approved" | "rejected" }>("POST", `/v1/approvals/${enc(id)}/decide`, { decision }),
  };
  keys = {
    /** Admin scope. `data.token` is the secret, shown once. */
    create: (k: CreateKey, o?: Opts) => this.send<CreatedKey>("POST", "/v1/keys", k, o),
    list: () => this.get<ApiKey[]>("/v1/keys"),
    revoke: (id: string) => this.request<{ id: string; revoked: true }>("DELETE", `/v1/keys/${enc(id)}`),
  };
  /** Engage needs manage (or admin); disengage needs admin. Omit keyId for the whole workspace. */
  killSwitch = {
    get: () => this.get<KillSwitch>("/v1/kill-switch"),
    set: (on: boolean, keyId?: string, o?: Opts) => this.send<{ on: boolean; key_id: string | null }>("POST", "/v1/kill-switch", { on, key_id: keyId }, o),
  };
  settings = {
    /** `get` needs read; `set`/`clear` need an admin key (agent keys get 403). Max 2,000 chars, trimmed. */
    instructions: {
      get: async (): Promise<Result<{ custom_instructions: string | null }>> => {
        const r = await this.get<{ custom_instructions?: string | null }>("/v1/settings");
        return r.error ? r : { ...r, data: { custom_instructions: r.data.custom_instructions ?? null } };
      },
      set: (text: string) => this.send<Obj>("PUT", "/v1/settings", { custom_instructions: text }),
      clear: () => this.send<Obj>("PUT", "/v1/settings", { custom_instructions: "" }),
    },
  };
  account = { status: () => this.get<AccountStatus>("/v1/account/status") };
  goLive = { request: (note?: string, o?: Opts) => this.send<{ approval_id: string; status: "pending" }>("POST", "/v1/go-live-requests", { note }, o) };
  policy = { propose: (keyId: string, policy: KeyPolicy, o?: Opts) => this.send<{ approval_id: string; status: "pending" }>("POST", "/v1/policy/proposals", { key_id: keyId, policy }, o) };
  audit = { list: (q: { limit?: number; before?: number } = {}) => this.get<AuditRow[]>("/v1/audit", q) };
}

const enc = encodeURIComponent;
