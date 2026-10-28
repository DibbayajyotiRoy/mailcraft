// The go-live card, the waiting card and the template-send card (variables, filled preview, placeholders block Apply, replaced).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatEvent, Proposal } from "@/lib/assistant/types";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("bot-avatars", () => ({ BotAvatar: () => <canvas /> }));
vi.mock("border-beam", () => ({ BorderBeam: (p: any) => <div>{p.children}</div> }));
import { AssistantLauncher } from "@/components/assistant/AssistantPanel";
import { ProposalCard } from "@/components/assistant/ProposalCard";

const enc = new TextEncoder();
const ndjson = (evs: ChatEvent[]) => new Response(new ReadableStream({ async start(c) { for (const e of evs) { c.enqueue(enc.encode(JSON.stringify(e) + "\n")); await new Promise((r) => setTimeout(r, 1)); } c.close(); } }), { status: 200 });
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const done: ChatEvent = { type: "done", stats: { model: "m", prompt: 1, completion: 1, rounds: 1, ttft_ms: 1, total_ms: 1, est_input: 1 } };

const base = { summary: "s", risk: "safe" as const, warnings: [] as string[], expires_at: Date.now() + 600_000 };
const GO_LIVE: Proposal = { ...base, id: "g1", kind: "go_live", key: "go_live", title: "Request go-live approval", summary: "This workspace can't send real mail until a person approves going live. Apply asks for that approval; it then appears in Approvals.", items: ["email to bipul@example.com"], pending: { kind: "email", what: "email to bipul@example.com", args: {} } };
const WAITING: Proposal = { ...GO_LIVE, id: "g2", title: "Waiting for go-live approval", waiting: true };
const SEND = (id: string, signup: string, extra: Partial<Proposal> = {}): Proposal => ({
  ...base, id, kind: "email", risk: "sends", key: "send:bipul@example.com", title: `Send "Welcome Bipul" to bipul@example.com`, items: ["bipul@example.com"],
  variables: signup.startsWith("[")
    ? [{ name: "signup_link", value: signup, placeholder: true }, { name: "first_name", value: "Bipul" }, { name: "benefit_4", value: "" }]
    : [{ name: "first_name", value: "Bipul" }, { name: "signup_link", value: signup }, { name: "benefit_4", value: "" }],
  preview: { subject: "Welcome Bipul", html: `<p>Hi Bipul, join ${signup}</p>` }, ...extra,
});

let chat: () => Response = () => ndjson([done]), apply: (b: any) => Response = () => json({ result: { status: "completed", label: "Done" } });
let calls: { url: string; body?: any }[] = [];
beforeEach(() => {
  sessionStorage.clear(); calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url === "/api/assistant/status") return json({ configured: true, model: { chain: ["m:free"], source: "openrouter" } });
    if (url === "/api/assistant/apply") return apply(body);
    return chat();
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = async () => { render(<AssistantLauncher />); fireEvent.click(screen.getByRole("button", { name: "Assistant" })); return screen.findByRole("dialog"); };
const ask = async (t: string) => { const box = await screen.findByLabelText("Message the assistant"); fireEvent.change(box, { target: { value: t } }); fireEvent.click(screen.getByRole("button", { name: "Send message" })); };
const props = () => ({ onApply: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn() });

// ---- go-live ----------------------------------------------------------------------------------------------------------------------------

test("go-live card: titled, explained, Apply is a normal one-click apply (no extra confirm), then the task row says Waiting for approval and links to Approvals", async () => {
  chat = () => ndjson([{ type: "proposal", proposal: GO_LIVE }, done]);
  apply = () => json({ result: { status: "pending_approval", label: "Go-live approval requested", href: "/approvals", hrefLabel: "Open Approvals", detail: 'Approve it in Approvals, then say "send it now" and I\'ll prepare the email again.' } });
  await open();
  await ask("send this mail to bipul@example.com through partner@example.com");
  const card = await screen.findByRole("region", { name: "Request go-live approval" });
  expect(within(card).getByText("Go-live approval")).toBeTruthy(); // kind badge
  expect(within(card).getByText(/can't send real mail until a person approves going live/)).toBeTruthy();
  expect(within(card).getByText("email to bipul@example.com")).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(within(card).getByText("Waiting for approval")).toBeTruthy());
  expect(calls.find((c) => c.url === "/api/assistant/apply")!.body).toEqual({ id: "g1", action: "apply", confirmed: false });
  expect(within(card).getByRole("link", { name: "Open Approvals" }).getAttribute("href")).toBe("/approvals");
  expect(within(card).getByText(/then say "send it now"/)).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "Apply" })).toBeNull();
});

test("a go-live request already waiting: the card says so, links to Approvals, offers no Apply and never expires", () => {
  render(<ProposalCard card={{ proposal: { ...WAITING, expires_at: Date.now() - 1000 }, state: "pending" }} {...props()} />);
  expect(screen.getByRole("status").textContent).toContain("A go-live request is already waiting");
  expect(screen.getByText("Waiting for approval")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open Approvals" }).getAttribute("href")).toBe("/approvals");
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText(/expired/)).toBeNull();
});

// ---- template sends ---------------------------------------------------------------------------------------------------------------------

test("a template send lists every variable, shows the filled preview, and invites changes in chat", () => {
  render(<ProposalCard card={{ proposal: SEND("s1", "https://example.com/start"), state: "pending" }} {...props()} />);
  const vars = screen.getByRole("region", { name: "Variables" });
  expect(within(vars).getByText("first_name")).toBeTruthy();
  expect(within(vars).getByText("Bipul")).toBeTruthy();
  expect(within(vars).getByText("https://example.com/start")).toBeTruthy();
  expect(within(vars).getByText("(empty)")).toBeTruthy(); // an optional variable left empty
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Show preview/ }));
  const frame = screen.getByTitle("Email preview") as HTMLIFrameElement;
  expect(frame.getAttribute("sandbox")).toBe(""); // inert
  expect(frame.getAttribute("srcdoc")).toBe("<p>Hi Bipul, join https://example.com/start</p>");
  expect(screen.getByText("Want changes? Just say what to change.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(false);
});

test("a placeholder value blocks Apply with a clear message naming it", () => {
  const p = props();
  render(<ProposalCard card={{ proposal: SEND("s2", "[add signup link]"), state: "pending" }} {...p} />);
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(p.onApply).not.toHaveBeenCalled();
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("[add signup link]");
  expect(alert.textContent).toContain("change signup_link to");
  expect(screen.getByText("needs a value")).toBeTruthy();
  const apply = screen.getByRole("button", { name: "Apply" });
  expect(document.getElementById(apply.getAttribute("aria-describedby")!)!.textContent).toBe("Replace the placeholder values first."); // the reason reaches assistive tech too
});

test("the pencil next to a variable pre-fills the composer with 'Change <var> to '", async () => {
  chat = () => ndjson([{ type: "proposal", proposal: SEND("s3", "[add signup link]") }, done]);
  await open();
  await ask("send the welcome template to bipul@example.com");
  fireEvent.click(await screen.findByRole("button", { name: "Change signup_link" }));
  await waitFor(() => expect((screen.getByLabelText("Message the assistant") as HTMLTextAreaElement).value).toBe("Change signup_link to "));
});

test("asking for a change: the new proposal replaces the old card, which shows Replaced and loses its buttons", async () => {
  chat = () => ndjson([{ type: "proposal", proposal: SEND("old", "[add signup link]") }, done]);
  await open();
  await ask("send the welcome template to bipul@example.com");
  const old = await screen.findByRole("region", { name: /Welcome Bipul/ });
  chat = () => ndjson([{ type: "proposal", proposal: SEND("new", "https://example.com/start") }, done]);
  await ask("change signup_link to https://example.com/start");
  await waitFor(() => expect(screen.getAllByRole("region", { name: /Welcome Bipul/ })).toHaveLength(2));
  expect(within(old).getByText("Replaced by a newer proposal.")).toBeTruthy();
  expect(within(old).queryByRole("button", { name: "Apply" })).toBeNull();
  expect(within(old).queryByRole("button", { name: "Change signup_link" })).toBeNull(); // no editing a dead card
  const fresh = screen.getAllByRole("region", { name: /Welcome Bipul/ })[1];
  expect(within(fresh).getByRole("button", { name: "Apply" })).toBeTruthy();
  expect(within(fresh).queryByText("Replaced by a newer proposal.")).toBeNull();
  expect(calls.some((c) => c.url === "/api/assistant/apply")).toBe(false);
});
