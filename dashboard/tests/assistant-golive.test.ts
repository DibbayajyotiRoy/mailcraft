// A send the workspace is not approved for becomes a go-live request proposal (not a failed step), failed steps get short
// human labels, and template sends carry the variables the assistant drafted (placeholders block Apply, a re-proposal replaces).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Msg } from "@/components/assistant/useAssistant";
import { supersede, toHistory } from "@/components/assistant/useAssistant";
import { errorLabel, goLiveNext, isGoLive } from "@/lib/assistant/errors";
import { runTurn } from "@/lib/assistant/loop";
import { resetScores } from "@/lib/assistant/models";
import { estTokens, system } from "@/lib/assistant/prompt";
import { applyProposal, peekProposal } from "@/lib/assistant/proposals";
import { toolsFor } from "@/lib/assistant/tools";
import type { ChatEvent, Proposal } from "@/lib/assistant/types";
import { API, apiFail, calls, ctx, fakeWorld, MUTATING, text, TEMPLATES, un } from "./assistant-kit";

process.env.MAILCRAFT_ASSISTANT_BASE_URL = "http://or.test/api/v1";
beforeEach(() => { resetScores(); (globalThis as any).__mcReads?.clear(); (globalThis as any).__mcProposals?.clear(); });
afterEach(() => vi.unstubAllGlobals());

async function turn(content: string, over: Partial<Parameters<typeof runTurn>[0]> = {}) {
  const ev: ChatEvent[] = [];
  for await (const e of runTurn({ history: [{ role: "user", content }], path: "/", ctx: ctx(), key: "or-key", chain: ["m1:free"], firstTokenMs: 2000, ...over })) ev.push(e);
  return ev;
}
const proposals = (ev: ChatEvent[]) => ev.filter((e): e is Extract<ChatEvent, { type: "proposal" }> => e.type === "proposal").map((e) => e.proposal);
const tools = (ev: ChatEvent[]) => ev.filter((e): e is Extract<ChatEvent, { type: "tool" }> => e.type === "tool" && e.status !== "running");

// What emails.rs plan() answers for a live key on a workspace nobody approved (rule go_live; the JSON has no rule field).
const GO_LIVE_403 = () => new Response(JSON.stringify({ ok: false, error: { code: "blocked_by_policy", message: "this workspace is not approved for live sending", hint: "request go-live (POST /v1/go-live-requests); a human approves it. Use a mc_test_ key meanwhile" } }), { status: 403 });
const POLICY_403 = () => apiFail(403, "blocked_by_policy", "this key's policy blocks sending");
const SEND = { to: ["bipul@example.com"], from: "partner@example.com", subject: "Hello", text: "Hi Bipul" };
const emailWorld = (send: () => Response, extra: Record<string, (b: any, q: URLSearchParams) => Response | unknown> = {}, turns = 1) =>
  fakeWorld(Array.from({ length: turns }).flatMap(() => [calls(["propose_email", SEND]), text("ok")]), { "POST /v1/emails": send, "GET /v1/senders": () => [], "GET /v1/approvals": () => [], ...extra });

// ---- the go-live gate ------------------------------------------------------------------------------------------------------

test("isGoLive matches the real go_live 403 (code + message/hint, or a rule field) and nothing else", () => {
  expect(isGoLive({ code: "blocked_by_policy", message: "this workspace is not approved for live sending" })).toBe(true);
  expect(isGoLive({ code: "blocked_by_policy", message: "x", hint: "request go-live (POST /v1/go-live-requests)" })).toBe(true);
  expect(isGoLive({ code: "blocked_by_policy", message: "x", rule: "go_live" })).toBe(true);
  expect(isGoLive({ code: "blocked_by_policy", message: "this key's policy blocks sending", hint: "an admin can change the key policy; agents may propose changes via POST /v1/policy/proposals" })).toBe(false);
  expect(isGoLive({ code: "blocked_by_policy", message: "this key may only send from its own domain" })).toBe(false);
  expect(isGoLive({ code: "domain_not_verified", message: "not approved for live sending" })).toBe(false);
  expect(isGoLive(undefined)).toBe(false);
});

test("propose_email blocked by go-live is not a failure: it returns a go_live proposal that keeps the send", async () => {
  const w = emailWorld(GO_LIVE_403);
  const ev = await turn("send this mail to bipul@example.com through partner@example.com");
  const [p] = proposals(ev);
  expect(p).toMatchObject({
    kind: "go_live", title: "Request go-live approval", risk: "safe", key: "go_live",
    summary: "This workspace can't send real mail until a person approves going live. Apply asks for that approval; it then appears in Approvals.",
    pending: { kind: "email", what: expect.stringContaining("bipul@example.com"), args: SEND },
  });
  expect(p.confirm).toBeUndefined();
  expect(p.waiting).toBeUndefined();
  expect(tools(ev)[0]).toMatchObject({ status: "done", label: "Prepared: Request go-live approval" }); // the step is not an error
  expect(w.rec.filter(MUTATING)).toEqual([]); // nothing was requested yet
  const fed = un(w.orBodies[1].messages.at(-1).content);
  expect(fed).toMatchObject({ status: "proposal_shown_to_user", reason: "go_live_required" });
  expect(fed.note).toMatch(/Never suggest test keys/);
  expect(fed.note).toContain(goLiveNext("email"));
});

test("propose_broadcast blocked by go-live gets the same go_live proposal", async () => {
  fakeWorld([calls(["propose_broadcast", { template: "welcome", from: "Acme <hi@acme.test>", emails: ["ana@example.com"] }]), text("ok")], {
    "GET /v1/templates/welcome": () => TEMPLATES[0], "POST /v1/broadcasts": GO_LIVE_403, "GET /v1/approvals": () => [],
  });
  const [p] = proposals(await turn("send the welcome template to ana@example.com"));
  expect(p).toMatchObject({ kind: "go_live", title: "Request go-live approval", pending: { kind: "broadcast", what: expect.stringContaining("1 address") } });
});

test("other policy blocks stay errors, with a short label and the full message in the detail", async () => {
  emailWorld(POLICY_403);
  const ev = await turn("send it");
  expect(proposals(ev)).toEqual([]);
  expect(tools(ev)[0]).toMatchObject({ status: "error", label: "Blocked by a send policy", detail: "this key's policy blocks sending" });
});

test("Apply requests go-live with a note naming the send, and the result is a pending approval linking to Approvals", async () => {
  const w = emailWorld(GO_LIVE_403, { "POST /v1/go-live-requests": () => ({ approval_id: "ap_9", status: "pending" }) });
  const [p] = proposals(await turn("send this mail to bipul@example.com through partner@example.com"));
  const r = await applyProposal("sid-1", p.id, { base: API, key: "k" }, false);
  const post = w.rec.filter(MUTATING);
  expect(post.map((x) => `${x.method} ${x.url}`)).toEqual(["POST /v1/go-live-requests"]);
  expect(post[0].body.note).toMatch(/bipul@example\.com/);
  expect(r).toEqual({ status: "pending_approval", label: "Go-live approval requested", href: "/approvals", hrefLabel: "Open Approvals", detail: 'Approve it in Approvals, then say "send it now" and I\'ll prepare the email again.' });
  expect(peekProposal("sid-1", p.id)).toBeUndefined(); // one-shot
});

test("a go-live request already waiting: the card says so, links to Approvals and makes no second request", async () => {
  const w = emailWorld(GO_LIVE_403, { "GET /v1/approvals": () => [{ id: "ap_3", kind: "email", status: "pending" }, { id: "ap_4", kind: "go_live", status: "pending" }] });
  const ev = await turn("send it");
  const [p] = proposals(ev);
  expect(w.rec.find((x) => x.url.startsWith("/v1/approvals"))!.url).toBe("/v1/approvals?status=pending&limit=50");
  expect(p).toMatchObject({ kind: "go_live", waiting: true, title: "Waiting for go-live approval" });
  expect(un(w.orBodies[1].messages.at(-1).content).reason).toBe("go_live_request_already_pending");
  const r = await applyProposal("sid-1", p.id, { base: API, key: "k" }, false); // even a stray apply cannot create a duplicate
  expect(r).toMatchObject({ status: "pending_approval", href: "/approvals" });
  expect(w.rec.filter(MUTATING)).toEqual([]);
});

test("decided or unrelated approvals do not count as a pending go-live request", async () => {
  emailWorld(GO_LIVE_403, { "GET /v1/approvals": () => [{ id: "a", kind: "go_live", status: "approved" }, { id: "b", kind: "email", status: "pending" }] });
  expect(proposals(await turn("send it"))[0].waiting).toBeUndefined();
});

test("if Approvals cannot be read, the request is still offered", async () => {
  emailWorld(GO_LIVE_403, { "GET /v1/approvals": () => apiFail(403, "forbidden_scope", "no") });
  expect(proposals(await turn("send it"))[0]).toMatchObject({ kind: "go_live", title: "Request go-live approval" });
});

test("a newer go-live card replaces the older pending one", async () => {
  emailWorld(GO_LIVE_403, {}, 2);
  const first = proposals(await turn("send it"))[0];
  const second = proposals(await turn("send it now"))[0];
  expect(peekProposal("sid-1", first.id)).toBeUndefined();
  expect(peekProposal("sid-1", second.id)).toBeDefined();
});

// ---- the prompt ------------------------------------------------------------------------------------------------------------------

test("the system prompt: go-live is proposed (never test keys), approving it is out of scope, and variables are drafted, not asked for", () => {
  const sys = system("live", "/", "2026-10-28");
  expect(sys).toMatch(/needs go-live approval.*go-live request for the user to Apply/);
  expect(sys).toMatch(/Never suggest test keys unless the user asks/);
  expect(sys).toMatch(/approving go-live \(a person does that\)/);
  expect(sys).not.toMatch(/kill switch, go-live,/); // go-live is no longer simply out of scope
  expect(sys).toMatch(/fill every variable yourself/i);
  expect(sys).toMatch(/Never ask the user to fill variables/);
  expect(sys).toMatch(/Optional variables may be empty/);
  expect(sys).toContain("[add signup link]");
});

// ---- labels for failed steps -----------------------------------------------------------------------------------------------------------

test("known error codes get a short human label; unknown ones none", () => {
  expect(errorLabel({ code: "blocked_by_policy", message: "this workspace is not approved for live sending" })).toBe("Needs go-live approval");
  expect(errorLabel({ code: "domain_not_verified", message: "cannot send from x.test: domain is not verified" })).toBe("Domain not verified");
  expect(errorLabel({ code: "transport_missing", message: "x" })).toBe("Sender not ready");
  expect(errorLabel({ code: "kill_switch_active", message: "x" })).toBe("Kill switch is on");
  expect(errorLabel({ code: "something_new", message: "x" })).toBeUndefined();
  expect(errorLabel({ message: "x" })).toBeUndefined();
});

test("a failed step shows the short label, never a clipped message; the full message and hint are in the detail", async () => {
  const msg = "cannot send from acme-mail.example.com: domain is not verified, so nothing can leave through it yet and the record is missing";
  fakeWorld([calls(["propose_email", SEND]), text("ok")], { "POST /v1/emails": () => apiFail(422, "domain_not_verified", msg) });
  const t = tools(await turn("send it"))[0];
  expect(t).toMatchObject({ status: "error", label: "Domain not verified", detail: msg });
  expect(t.label).not.toContain("…");
  fakeWorld([calls(["propose_email", SEND]), text("ok")], { "POST /v1/emails": () => apiFail(500, "weird", msg) });
  expect(tools(await turn("send it"))[0]).toMatchObject({ status: "error", label: "Preparing the email preview failed", detail: msg });
});

// ---- template sends: drafted variables -------------------------------------------------------------------------------------------------------

const TPL = { template: { id: "welcome", variables: { first_name: "Bipul", signup_link: "[add signup link]", benefit_4: "" } } };
const tplWorld = (over: Record<string, (b: any) => Response | unknown> = {}, turns = 1) => fakeWorld(Array.from({ length: turns }).flatMap(() => [calls(["propose_email", { to: ["bipul@example.com"], from: "partner@example.com", ...TPL }]), text("ok")]), {
  "POST /v1/emails": () => ({ dry_run: true, status: "queued", rendered: { subject: "", html: null, text: null }, lint: [{ rule: "template_rendered_by_worker", severity: "info", message: "rendered at send time" }] }),
  "POST /v1/templates/welcome/preview": (b: any) => ({ subject: `Welcome ${b.variables.first_name}`, html: `<p>Hi ${b.variables.first_name}, join: ${b.variables.signup_link}</p>`, variables: ["first_name", "signup_link", "benefit_4"], lint: [] }),
  "GET /v1/senders": () => [], ...over,
});

test("a template send is previewed with every drafted variable and the card lists them, gaps first", async () => {
  const w = tplWorld();
  const [p] = proposals(await turn("send the welcome template to bipul@example.com"));
  expect(w.rec.find((r) => r.url === "/v1/templates/welcome/preview")!.body).toEqual({ variables: TPL.template.variables });
  expect(p.variables).toEqual([
    { name: "signup_link", value: "[add signup link]", placeholder: true },
    { name: "first_name", value: "Bipul" },
    { name: "benefit_4", value: "" },
  ]);
  expect(p.preview).toEqual({ subject: "Welcome Bipul", html: "<p>Hi Bipul, join: [add signup link]</p>" }); // the real render, not the dry run's empty one
  expect(p.title).toContain("Welcome Bipul");
  expect(p.warnings.join(" ")).toMatch(/Needs a real value before it can be sent: signup_link/);
  expect(p.lint).toEqual([]);
  expect(p.key).toBe("send:bipul@example.com");
  const fed = un(w.orBodies[1].messages.at(-1).content);
  expect(fed.variables).toMatchObject({ first_name: "Bipul", signup_link: "[add signup link]" });
  expect(fed.placeholders).toEqual(["signup_link"]);
  expect(fed.hint).toMatch(/never ask them to fill variables/);
});

test("Apply is refused while a placeholder is left, and the proposal stays so a corrected one can replace it", async () => {
  const w = tplWorld();
  const [p] = proposals(await turn("send the welcome template to bipul@example.com"));
  const r = await applyProposal("sid-1", p.id, { base: API, key: "k" }, false);
  expect(r).toMatchObject({ status: "failed", error: { code: "placeholder_values", message: expect.stringContaining("signup_link") } });
  expect(w.rec.filter(MUTATING)).toEqual([]);
  expect(peekProposal("sid-1", p.id)).toBeDefined();
});

test("with real values the send goes out with exactly the drafted variables", async () => {
  const w = fakeWorld([calls(["propose_email", { to: ["bipul@example.com"], from: "partner@example.com", template: { id: "welcome", variables: { first_name: "Bipul", signup_link: "https://example.com/start", benefit_4: "" } } }]), text("ok")], {
    "POST /v1/emails": (b: any) => (b.dry_run ? { dry_run: true, rendered: {}, lint: [] } : { id: "e1", status: "queued" }),
    "POST /v1/templates/welcome/preview": () => ({ subject: "Welcome", html: "<p>ok</p>", variables: ["first_name", "signup_link", "benefit_4"], lint: [] }), "GET /v1/senders": () => [],
  });
  const [p] = proposals(await turn("send it"));
  expect(p.variables!.some((v) => v.placeholder)).toBe(false);
  expect(await applyProposal("sid-1", p.id, { base: API, key: "k" }, false)).toMatchObject({ status: "queued" });
  expect(w.rec.filter(MUTATING)[0].body).toMatchObject({ to: ["bipul@example.com"], template: { id: "welcome", variables: { first_name: "Bipul", signup_link: "https://example.com/start", benefit_4: "" } } });
});

test("a value the template never uses is flagged, and a template that will not render goes back to the model with what to do", async () => {
  tplWorld({ "POST /v1/templates/welcome/preview": () => ({ subject: "S", html: "<p>x</p>", variables: ["first_name"], lint: [] }) });
  const [p] = proposals(await turn("send it"));
  expect(p.warnings.join(" ")).toMatch(/does not use: signup_link, benefit_4/);

  const w = tplWorld({ "POST /v1/templates/welcome/preview": () => apiFail(422, "template_render_failed", "variable render failed: undefined value benefit_4") });
  const ev = await turn("send it");
  expect(proposals(ev)).toEqual([]);
  expect(tools(ev)[0]).toMatchObject({ status: "error", label: "Template does not render" });
  const err = JSON.parse(w.orBodies[1].messages.at(-1).content).error;
  expect(err.message).toMatch(/undefined value benefit_4/);
  expect(err.hint).toMatch(/Give every variable a value/);
});

test("a broadcast to explicit addresses can carry shared data columns, flagged the same way", async () => {
  const w = fakeWorld([calls(["propose_broadcast", { template: "welcome", from: "Acme <hi@acme.test>", emails: ["ana@example.com"], data: { offer: "[add offer]", city: "Oslo" } }]), text("ok")], {
    "GET /v1/templates/welcome": () => TEMPLATES[0], "GET /v1/senders": () => [],
    "POST /v1/broadcasts": () => ({ queued: 1, skipped: [] }), "POST /v1/broadcasts/preview": () => ({ subject: "S", html: "<p>x</p>" }),
  });
  const [p] = proposals(await turn("send the welcome template to ana@example.com"));
  expect(p.variables).toEqual([{ name: "data.offer", value: "[add offer]", placeholder: true }, { name: "data.city", value: "Oslo" }]);
  expect(w.rec.find((r) => r.url === "/v1/broadcasts")!.body.recipients).toEqual([{ email: "ana@example.com", data: { offer: "[add offer]", city: "Oslo" } }]);
  expect((await applyProposal("sid-1", p.id, { base: API, key: "k" }, false)).error?.code).toBe("placeholder_values");
});

// ---- a re-proposal replaces the earlier card ------------------------------------------------------------------------------------------------

test("a re-proposal to the same recipients replaces the stored older one (it can no longer be applied)", async () => {
  tplWorld({}, 2);
  const first = proposals(await turn("send the welcome template to bipul@example.com"))[0];
  const second = proposals(await turn("make it friendlier"))[0];
  expect(second.key).toBe(first.key);
  expect(peekProposal("sid-1", first.id)).toBeUndefined();
  expect((await applyProposal("sid-1", first.id, { base: API, key: "k" }, false)).error?.code).toBe("proposal_expired");
  expect(peekProposal("sid-1", second.id)).toBeDefined();
});

const prop = (id: string, key?: string, over: Partial<Proposal> = {}): Proposal => ({ id, kind: "email", title: `T ${id}`, summary: "s", risk: "sends", warnings: [], expires_at: Date.now() + 1e5, key, ...over });
const bot = (id: string, cards: Msg["cards"]): Msg => ({ id, role: "assistant", text: "", steps: [], cards });

test("supersede marks older pending cards with the same key as replaced, across messages; applied, other-key and the new card are untouched", () => {
  const msgs = [
    bot("m1", [{ proposal: prop("a", "send:x"), state: "pending" }, { proposal: prop("b", "send:y"), state: "pending" }, { proposal: prop("c", "send:x"), state: "applied" }]),
    bot("m2", [{ proposal: prop("n", "send:x"), state: "pending" }]),
  ];
  const out = supersede(msgs, prop("n", "send:x"));
  expect(out[0].cards.map((c) => c.state)).toEqual(["replaced", "pending", "applied"]);
  expect(out[1].cards[0].state).toBe("pending");
  expect(supersede(msgs, prop("z"))).toBe(msgs); // no key: nothing to replace
});

test("history: a go-live request tells the model what to prepare again; a replaced card says nothing", () => {
  const gl = prop("g", "go_live", { kind: "go_live", title: "Request go-live approval", pending: { kind: "email", what: "email to bipul@example.com from partner@example.com", args: {} } });
  const note = (state: Msg["cards"][number]["state"]) => toHistory([bot("m", [{ proposal: gl, state }])])[0].note;
  expect(note("applied")).toBe("applied: Request go-live approval (once a person approves go-live, prepare it again: email to bipul@example.com from partner@example.com)");
  expect(note("pending")).toContain("proposed (not applied): Request go-live approval");
  expect(note("replaced")).toBeUndefined();
});

// ---- the send details are read for the model, not asked of the user -------------------------------------------------------------------------------

const SOURCE = "<mjml><mj-body><mj-text>Hi {{ first_name }}, join {{ signup_link }}. " + "More words. ".repeat(400) + "</mj-text></mj-body></mjml>";
const ctxRoutes = {
  "GET /v1/templates/welcome": () => ({ ...TEMPLATES[0], source: SOURCE, variables: ["first_name", "signup_link", "benefit_4"] }),
  "GET /v1/contacts/bipul%40example.com": () => ({ email: "bipul@example.com", first_name: "Bipul", last_name: "Das", properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`prop${i}`, "x".repeat(100)])) }),
  "GET /v1/senders": () => [{ address: "partner@example.com", display_name: "Acme Partnerships", is_default: false, status: "ready" }],
  "GET /v1/account/status": () => ({ name: "Acme" }),
};

test("@template plus an address: the send details are prefetched into the prompt, compactly, with no extra round", async () => {
  const w = fakeWorld([text("Drafting.")], ctxRoutes);
  await turn("Send @template:welcome to bipul@example.com from partner@example.com");
  const sys: string = w.orBodies[0].messages[0].content;
  const at = sys.indexOf("Send details (already read)");
  expect(at).toBeGreaterThan(0);
  const packed = un(sys.slice(at).replace(/^[^<]*/, ""));
  expect(packed).toMatchObject({ template: { variables: ["first_name", "signup_link", "benefit_4"] }, contacts: [{ email: "bipul@example.com", known: true, first_name: "Bipul" }], sender: { name: "Acme Partnerships" }, workspace: "Acme" });
  expect(packed.contacts).toHaveLength(1); // the From address is not a recipient
  expect(sys.slice(at).length).toBeLessThan(1500);
  expect(estTokens(w.orBodies[0].messages) + estTokens(w.orBodies[0].tools ?? [])).toBeLessThan(4000); // inside the existing per-turn budget
  expect(w.orBodies).toHaveLength(1);
});

test("without a template mention nothing is prefetched; the model can ask with send_context in a single call", async () => {
  const w = fakeWorld([calls(["send_context", { template: "welcome", to: ["bipul@example.com"], from: "partner@example.com" }]), text("ok")], ctxRoutes);
  await turn("send the welcome template to bipul@example.com");
  expect(w.orBodies[0].messages[0].content).not.toContain("Send details");
  expect(w.orBodies[0].tools.map((t: any) => t.function.name)).toContain("send_context");
  const fed = un(w.orBodies[1].messages.at(-1).content);
  expect(fed.sender).toEqual({ address: "partner@example.com", name: "Acme Partnerships" });
  expect(JSON.stringify(fed).length).toBeLessThan(1300);
});

test("send_context stays out of the core tool set (it costs tokens every turn otherwise)", () => {
  expect(toolsFor([]).map((t) => t.function.name)).not.toContain("send_context");
});

test("a follow-up like 'make it friendlier' still gets propose_email while a send card is waiting, and the model is told the values on it", async () => {
  const note = 'tools: Prepared: Send "Welcome Bipul" to bipul@example.com; proposed (not applied): Send "Welcome Bipul" to bipul@example.com [values: signup_link=[add signup link]; first_name=Bipul]';
  const w = fakeWorld([text("Friendlier version coming.")]);
  await turn("", { history: [{ role: "user", content: "send the welcome template to bipul@example.com" }, { role: "assistant", content: "Drafted.", note }, { role: "user", content: "make it friendlier" }] });
  expect(w.orBodies[0].tools.map((t: any) => t.function.name)).toContain("propose_email");
  expect(w.orBodies[0].messages.find((m: any) => /Drafted/.test(m.content)).content).toContain("signup_link=[add signup link]");
  const w2 = fakeWorld([text("ok")]);
  await turn("", { history: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello", note: "tools: Read 3 templates" }, { role: "user", content: "make it friendlier" }] });
  expect(w2.orBodies[0].tools.map((t: any) => t.function.name)).not.toContain("propose_email");
});

test("history: a waiting template-send card carries its values so the model can change them", () => {
  const p = prop("s", "send:x", { title: 'Send "Hi" to a@example.com', variables: [{ name: "signup_link", value: "[add signup link]", placeholder: true }, { name: "first_name", value: "Bipul" }] });
  expect(toHistory([bot("m", [{ proposal: p, state: "pending" }])])[0].note).toBe('proposed (not applied): Send "Hi" to a@example.com [values: signup_link=[add signup link]; first_name=Bipul]');
  expect(toHistory([bot("m", [{ proposal: p, state: "applied" }])])[0].note).toBe('applied: Send "Hi" to a@example.com');
});
