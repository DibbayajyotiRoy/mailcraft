import type { components } from "./schema.js";

export type SendEmail = components["schemas"]["SendEmail"];
export type SendResult = components["schemas"]["SendResult"];
export type CreateKey = components["schemas"]["CreateKey"];
export type KeyPolicy = components["schemas"]["KeyPolicy"];
export type CreateBroadcast = components["schemas"]["CreateBroadcast"];
/** A From address you can pick (`GET /v1/senders`); derived from what is connected, read-only. */
export type Sender = components["schemas"]["Sender"];
export type BroadcastRecipient = components["schemas"]["BroadcastRecipient"];
export type BroadcastResult = components["schemas"]["BroadcastResult"];
export type Broadcast = components["schemas"]["Broadcast"];
export type BroadcastDetail = components["schemas"]["BroadcastDetail"];
export type PatchTemplate = components["schemas"]["PatchTemplate"];
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
export type DryRun = { dry_run: true; status: string; stream: string; policy_decisions: Obj[]; rendered: { subject?: string; html?: string; text?: string; headers: Obj }; lint: Obj[]; would_send_via: string; /** name of the transport this send would use */ transport?: string | null };
export type BatchItem = { ok: true; data: SendResult } | { ok: false; error: ApiError };
export type Approval = { id: string; kind: "email" | "go_live" | "policy_change"; status: "pending" | "approved" | "rejected" | "expired"; subject_id: string | null; requested_by: string | null; payload: Obj; decided_by_key: string | null; decided_at: string | null; created_at: string };
export type ApiKey = { id: string; name: string; prefix: string; env: "test" | "live"; scopes: string[]; domain_id: string | null; policy: KeyPolicy; recipient_allowlist: string[] | null; daily_send_cap: number | null; minute_send_cap: number | null; paused: boolean; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; created_at: string };
export type CreatedKey = { id: string; name: string; env: "test" | "live"; scopes: string[]; token: string; prefix: string };
export type KillSwitch = { on: boolean; paused_keys: string[] };
export type AccountStatus = { workspace: string; kill_switch: boolean; live_enabled: boolean; pending_approvals: number; key: { id: string; name: string; env: "test" | "live"; scopes: string[] } };
export type AuditRow = { id: number; at: string; actor_type: string; actor_id: string | null; action: string; args: Obj; decision: string; approval_id: string | null };

// Bodies the spec leaves untyped for the routes below; shapes taken from the handlers in crates/mailcraft-api.
export type DnsRecord = { record: string; type: string; name: string; value: string; priority?: number; status: string; checked_at?: string | null; detail?: string | null; /** what DNS returned at that name, when the record is wrong */ found?: string | null };
export type Domain = { id: string; name: string; status: "not_started" | "pending" | "verified" | "failed"; records: DnsRecord[]; stream?: string; last_checked_at?: string | null; /** an address a mailbox relay logs in as or sends as on this domain: sends from it need no records */ relay_sender?: string; /** every such address (`relay_sender` is the first) */ relay_senders?: string[]; /** sends from this domain go through this transport; null = the workspace default */ transport_id?: string | null };
export type TransportAddresses = { id: string; aliases: string[]; display_names: Record<string, string> };
export type Template = { id: string; name: string; alias?: string; subject?: string; preheader?: string; html?: string; mjml?: string; text?: string; status?: string; version?: number; published_version?: number | null; warnings?: string[]; /** GET only: the author's own html/mjml, else the block tree as JSON text */ source_format?: "html" | "mjml" | "json"; source?: string; template?: Obj };
export type TemplateVersion = { version: number; source_format: string; created_at: string; published_at: string | null; published: boolean };
export type TemplatePreview = { subject: string; html: string; text: string; lint: Obj[]; variables?: string[]; warnings?: string[] };
/** Render unsaved content (nothing is stored) instead of the saved `version`. */
export type PreviewDraft = { version?: number; html?: string; mjml?: string; content?: unknown; format?: "html" | "mjml" | "json"; subject?: string; preheader?: string };
export type Contact = { id: string; email: string; first_name?: string | null; last_name?: string | null; timezone?: string | null; properties?: Obj; suppressed?: boolean; suppression_reason?: string | null };
export type ContactInput = { first_name?: string; last_name?: string; timezone?: string; properties?: Obj };
export type ContactImportResult = { imported: number; failed: { index: number; email: string; error: { code: string; message: string } }[] };
export type ContactActivity = { events: Obj[]; emails: Obj[]; runs: Obj[]; topics: Obj[]; segments: Obj[] };
export type Segment = { id: string; name: string; filter: Obj | null; member_count?: number };
export type SegmentPreview = { count: number; sample: { email: string; first_name: string | null; last_name: string | null }[] };
export type EventResult = { event_id: string; contact_id: string; triggered_automations: { id: string; run_id: string }[]; would_send: Obj[] };
export type EventName = { name: string; count: number; last_seen_at: string };
export type Automation = { id: string; name: string; status?: string; trigger: Obj; steps: Obj[] } & Obj;
export type AutomationRun = { id: string; version: number; contact_id: string; contact_email: string; state: string; current_step: string | null; next_wake_at: string | null; started_at: string; ended_at: string | null; exit_reason: string | null; test: boolean };
export type AutomationRunDetail = AutomationRun & { steps: { step_key: string; result: Obj; at: string }[] };
export type TestRunStarted = { run_id: string; automation_id: string; contact_id: string; env: "test" | "live"; status: "started" };
export type Transport = { id: string; kind: string; name: string; label: string; is_default: boolean; daily_cap: number | null; status: string; from?: string | null; detail?: Obj; created_at: string };
export type CreateTransport = { kind: "smtp-relay" | "ses"; preset?: "postmark" | "mailgun" | "resend" | "brevo" | "smtp2go" | "ses"; name?: string; label?: "test" | "low-volume" | "production"; daily_cap?: number; is_default?: boolean; /** write-only credentials; `mailbox_sender: true` (needs `username`) sends as the mailbox address, for Zoho / Gmail / Outlook relays */ config: Obj & { mailbox_sender?: boolean; /** with mailbox_sender: other addresses the mailbox sends as */ aliases?: string[]; /** `{ address: name }` for the login and each alias */ display_names?: Record<string, string> } };

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
    /** `q` is a case-insensitive substring of to / from / subject (or an exact id); `from` / `to` bound created_at (YYYY-MM-DD or RFC 3339). */
    list: (q: Page & { status?: string; stream?: "transactional" | "marketing"; env?: "test" | "live"; q?: string; from?: string; to?: string } = {}) => this.get<Email[]>("/v1/emails", q),
    events: (id: string) => this.get<EmailEvent[]>(`/v1/emails/${enc(id)}/events`),
    cancel: (id: string, o?: Opts) => this.send<{ id: string; status: "cancelled" }>("POST", `/v1/emails/${enc(id)}/cancel`, {}, o),
  };
  broadcasts = {
    /** One template to many recipients (up to 5000), paced under the daily cap. Test keys sandbox it. 202 queued | pending_approval (poll approvals.get, never decide); with dry_run:true the 200 body lists `queued`, `skipped` and `schedule` and nothing is stored. */
    create: (b: CreateBroadcast, o?: Opts) => this.send<BroadcastResult>("POST", "/v1/broadcasts", b, o),
    list: (q: Page = {}) => this.get<Broadcast[]>("/v1/broadcasts", q),
    /** The broadcast with counts and its recipients' status, paginated by email id (`nextCursor`). */
    get: (id: string, q: Page & { status?: string } = {}) => this.get<BroadcastDetail>(`/v1/broadcasts/${enc(id)}`, q),
    /** Render the template for one recipient exactly as it would be sent; nothing is stored. */
    preview: (p: { template_id: string; recipient: BroadcastRecipient; subject?: string; stream?: "transactional" | "marketing" }) => this.send<{ subject: string; html: string; text: string }>("POST", "/v1/broadcasts/preview", p),
  };
  domains = {
    create: (d: { domain: string; stream?: "transactional" | "marketing" }, o?: Opts) => this.send<Domain>("POST", "/v1/domains", d, o),
    verify: (id: string) => this.send<Domain>("POST", `/v1/domains/${enc(id)}/verify`),
    list: (q: Page = {}) => this.get<Domain[]>("/v1/domains", q),
    get: (id: string) => this.get<Domain>(`/v1/domains/${enc(id)}`),
    /** Bind the domain to a transport; `null` unbinds it (the workspace default is used). Needs manage. */
    update: (id: string, d: { transport_id: string | null }, o?: Opts) => this.send<Domain>("PATCH", `/v1/domains/${enc(id)}`, d, o),
    remove: (id: string) => this.request<Obj>("DELETE", `/v1/domains/${enc(id)}`),
  };
  /** The From addresses you can pick: connected mailbox logins and aliases. Read-only; derived. */
  senders = { list: () => this.get<Sender[]>("/v1/senders") };
  /** Delivery paths. Credentials in `config` are write-only. */
  transports = {
    create: (t: CreateTransport, o?: Opts) => this.send<Transport>("POST", "/v1/transports", t, o),
    list: () => this.get<Transport[]>("/v1/transports"),
    /** Always 200; `ok:false` carries the reason. */
    test: (id: string) => this.send<{ id: string; kind: string; ok: boolean; detail: string }>("POST", `/v1/transports/${enc(id)}/test`),
    /** Mailbox relays only (400 otherwise). A field you send replaces the stored one. Needs manage. */
    update: (id: string, t: { aliases?: string[]; display_names?: Record<string, string> }, o?: Opts) => this.send<TransportAddresses>("PATCH", `/v1/transports/${enc(id)}`, t, o),
    remove: (id: string) => this.request<Obj>("DELETE", `/v1/transports/${enc(id)}`),
  };
  templates = {
    create: (t: Omit<Template, "id"> & { stream?: "transactional" | "marketing"; content?: unknown; format?: "html" | "mjml" | "json" }, o?: Opts) => this.send<Template>("POST", "/v1/templates", t, o),
    /** `id` is a uuid or alias. Newest version, with `source_format` + `source` (what an editor opens) and the block tree in `template`. */
    get: (id: string) => this.get<Template>(`/v1/templates/${enc(id)}`),
    list: (q: Page = {}) => this.get<Template[]>("/v1/templates", q),
    /** Rename, change alias / stream, and/or add a new draft version. Changing `alias` breaks sends and automations that name the old one (409 template_exists when taken). */
    update: (id: string, t: PatchTemplate, o?: Opts) => this.send<Template>("PATCH", `/v1/templates/${enc(id)}`, t, o),
    /** Makes `version` (default newest) the one sends use. */
    publish: (id: string, o?: Opts & { version?: number }) => this.send<Template>("POST", `/v1/templates/${enc(id)}/publish`, o?.version == null ? {} : { version: o.version }, o),
    /** Renders a saved `version` (default newest), or the unsaved content in `draft` (nothing is stored). Undefined variable -> 422 template_render_failed. */
    preview: (id: string, variables: Obj = {}, draft: PreviewDraft = {}) => this.send<TemplatePreview>("POST", `/v1/templates/${enc(id)}/preview`, { variables, ...draft }),
    /** Version history, newest first; `published` marks the live one. */
    versions: (id: string) => this.get<TemplateVersion[]>(`/v1/templates/${enc(id)}/versions`),
    version: (id: string, version: number) => this.get<TemplateVersion & { id: string; alias: string; subject: string; preheader: string | null; source_format: string; source: string; template: Obj }>(`/v1/templates/${enc(id)}/versions/${version}`),
    /** Copies an older version into a new draft; history is kept, publish the draft to go live. */
    restore: (id: string, version: number, o?: Opts) => this.send<{ id: string; alias: string; version: number; restored_from: number; published_version: number | null }>("POST", `/v1/templates/${enc(id)}/versions/${version}/restore`, {}, o),
    /** Deletes the never-published versions newer than the published one (409 no_draft | no_published_version). Irreversible. */
    discardDraft: (id: string) => this.request<{ id: string; alias: string; discarded: number; version: number; published_version: number }>("DELETE", `/v1/templates/${enc(id)}/draft`),
    import: (t: { format: "html" | "mjml" | "json"; name: string; content: string }, o?: Opts) => this.send<Template>("POST", "/v1/templates/import", t, o),
    export: (id: string, format: "html" | "mjml" | "json" = "html") => this.get<{ format: string; content: string }>(`/v1/templates/${enc(id)}/export`, { format }),
  };
  contacts = {
    upsert: (c: { email: string } & ContactInput, o?: Opts) => this.send<Contact>("PUT", "/v1/contacts", c, o),
    get: (idOrEmail: string) => this.get<Contact>(`/v1/contacts/${enc(idOrEmail)}`),
    /** `q` is a case-insensitive substring of email, first or last name. */
    list: (q: Page & { q?: string } = {}) => this.get<Contact[]>("/v1/contacts", q),
    /** Omitted fields stay; "" clears first_name / last_name / timezone; `properties` merges shallowly and null deletes a key. */
    update: (idOrEmail: string, c: ContactInput, o?: Opts) => this.send<Contact>("PATCH", `/v1/contacts/${enc(idOrEmail)}`, c, o),
    remove: (idOrEmail: string) => this.request<Obj>("DELETE", `/v1/contacts/${enc(idOrEmail)}`),
    /** Latest events, emails, automation runs, topics and segments of one contact (newest first, 25 each). */
    activity: (idOrEmail: string) => this.get<ContactActivity>(`/v1/contacts/${enc(idOrEmail)}/activity`),
    /** Upsert up to 5000 contacts. A bad row is skipped and listed in `failed` with its zero-based `index`; the rest are imported. */
    import: (contacts: ({ email: string } & ContactInput)[], o?: Opts) => this.send<ContactImportResult>("POST", "/v1/contacts/import", { contacts }, o),
  };
  segments = {
    create: (s: { name: string; filter?: Obj }, o?: Opts) => this.send<Segment>("POST", "/v1/segments", s, o),
    list: () => this.get<Segment[]>("/v1/segments"),
    /** Who a filter matches right now: the count and the 5 newest matches. Stores nothing. */
    preview: (filter: Obj) => this.send<SegmentPreview>("POST", "/v1/segments/preview", { filter }),
    /** Full replace. Omit `filter` to make it a manual list. 409 when another segment has the name. */
    update: (id: string, s: { name: string; filter?: Obj | null }, o?: Opts) => this.send<Segment>("PUT", `/v1/segments/${enc(id)}`, s, o),
    /** 409 invalid_state while an automation still names the segment. */
    remove: (id: string) => this.request<{ id: string; deleted: true }>("DELETE", `/v1/segments/${enc(id)}`),
    addMembers: (id: string, emails: string[], o?: Opts) => this.send<Obj>("POST", `/v1/segments/${enc(id)}/members`, { emails }, o),
  };
  events = {
    /** Event names tracked in the last 90 days with counts, newest first. */
    names: () => this.get<EventName[]>("/v1/events/names"),
    track: (e: { name: string; contact: { email: string }; properties?: Obj; contact_properties?: Obj; dry_run?: boolean }, o?: Opts) => this.send<EventResult>("POST", "/v1/events", e, o),
  };
  automations = {
    create: (a: Omit<Automation, "id">, o?: Opts) => this.send<Automation>("POST", "/v1/automations", a, o),
    get: (id: string) => this.get<Automation>(`/v1/automations/${enc(id)}`),
    /** Archived automations are hidden unless `status: "archived"`. */
    list: (q: Page & { status?: "draft" | "active" | "paused" | "archived" } = {}) => this.get<Automation[]>("/v1/automations", q),
    /** @deprecated No PATCH route on main: POST `create` with an existing name stores the next version. */
    update: (id: string, a: Partial<Automation>, o?: Opts) => this.send<Automation>("PATCH", `/v1/automations/${enc(id)}`, a, o),
    publish: (id: string, o?: Opts) => this.send<Automation>("POST", `/v1/automations/${enc(id)}/publish`, {}, o),
    pause: (id: string, o?: Opts) => this.send<Automation>("POST", `/v1/automations/${enc(id)}/pause`, {}, o),
    resume: (id: string, o?: Opts) => this.send<Automation>("POST", `/v1/automations/${enc(id)}/resume`, {}, o),
    /** Draft or paused only (409 invalid_state otherwise). */
    archive: (id: string, o?: Opts) => this.send<Automation>("POST", `/v1/automations/${enc(id)}/archive`, {}, o),
    /** Back to draft; publish again to go live. */
    unarchive: (id: string, o?: Opts) => this.send<Automation>("POST", `/v1/automations/${enc(id)}/unarchive`, {}, o),
    /** Start a run for one contact now, whatever the status, skipping the entry rule (contact created if new). A test key keeps mail in the sandbox; a live key sends for real. 202; poll `run`. */
    test: (id: string, t: { email: string; first_name?: string; properties?: Obj; contact_properties?: Obj }, o?: Opts) => this.send<TestRunStarted>("POST", `/v1/automations/${enc(id)}/test`, t, o),
    /** One run with its step log. */
    run: (id: string, runId: string) => this.get<AutomationRunDetail>(`/v1/automations/${enc(id)}/runs/${enc(runId)}`),
    /** @deprecated No such route on main. `test` starts a real run for one contact. */
    simulate: (id: string, event: Obj = {}) => this.send<Obj>("POST", `/v1/automations/${enc(id)}/simulate`, { event }),
    runs: (id: string, q: Page & { status?: "active" | "waiting" | "completed" | "exited" | "failed" } = {}) => this.get<AutomationRun[]>(`/v1/automations/${enc(id)}/runs`, q),
  };
  approvals = {
    list: (q: { status?: Approval["status"]; limit?: number } = {}) => this.get<Approval[]>("/v1/approvals", q),
    get: (id: string) => this.get<Approval>(`/v1/approvals/${enc(id)}`),
    /** Needs an admin key; agent keys get 403 forbidden_scope. */
    decide: (id: string, decision: "approve" | "reject", reason?: string) => this.send<{ id: string; status: "approved" | "rejected" }>("POST", `/v1/approvals/${enc(id)}/decide`, { decision, reason }),
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
