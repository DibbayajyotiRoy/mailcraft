import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatEvent } from "@/lib/assistant/types";

vi.mock("next/navigation", () => ({ usePathname: () => "/templates/t2", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("bot-avatars", () => ({ BotAvatar: (p: any) => <canvas data-avatar={p.state ?? "default"} data-paused={p.paused ? "1" : undefined} /> }));
vi.mock("border-beam", () => ({ BorderBeam: (p: any) => <div data-beam={p.size} data-active={String(p.active)} data-theme={p.theme}>{p.children}</div> }));
import { AssistantLauncher } from "@/components/assistant/AssistantPanel";

const enc = new TextEncoder();
const ndjson = (evs: ChatEvent[], hold?: (signal?: AbortSignal | null) => Promise<void>, signal?: AbortSignal | null) => new Response(new ReadableStream({
  async start(c) {
    for (const e of evs) { c.enqueue(enc.encode(JSON.stringify(e) + "\n")); await new Promise((r) => setTimeout(r, 1)); }
    if (hold) await hold(signal).catch(() => { c.error(new DOMException("aborted", "AbortError")); return; });
    try { c.close(); } catch { /* already errored by an abort */ }
  },
}), { status: 200 });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const PROPOSAL = { id: "p1", kind: "template", title: 'Update template "Receipt"', summary: "Saves a new draft version.", risk: "safe", warnings: [], diff: { label: "Source (mjml)", before: "a\nb\nc", after: "a\nB\nc" }, expires_at: Date.now() + 600_000 } as const;
const STATUS = { configured: true, model: { chain: ["nvidia/nemotron-3-ultra-550b-a55b:free"], source: "openrouter" }, key: { limit_remaining: 41 }, requests_today: 3 };
let status: unknown = STATUS, chat: (init: RequestInit) => Response = () => ndjson([{ type: "done", stats: { model: "m", prompt: 1, completion: 1, rounds: 1, ttft_ms: 1, total_ms: 2, est_input: 1 } }]), apply: (b: any) => Response = () => json({ result: { status: "completed", label: "Done" } });
let calls: { url: string; body?: any }[] = [];

beforeEach(() => {
  sessionStorage.clear(); calls = []; status = STATUS;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url === "/api/assistant/status") return json(status);
    if (url === "/api/assistant/mentions") return json({ template: ["welcome", "receipt"], list: ["Webinar"], automation: ["welcome-signups"] });
    if (url === "/api/assistant/apply") return apply(body);
    return chat(init!);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = async () => { render(<AssistantLauncher />); fireEvent.click(screen.getByRole("button", { name: "Assistant" })); return screen.findByRole("dialog"); };
const turn = (evs: ChatEvent[]) => { chat = () => ndjson(evs); };
const done: ChatEvent = { type: "done", stats: { model: "nvidia/nemotron-3-ultra-550b-a55b:free", prompt: 1200, completion: 80, rounds: 2, ttft_ms: 900, total_ms: 4200, est_input: 1000 } };
const ask = async (t: string) => { const box = await screen.findByLabelText("Message the assistant"); fireEvent.change(box, { target: { value: t } }); fireEvent.click(screen.getByRole("button", { name: "Send message" })); };

test("opens from the header button and from Cmd/Ctrl+K; page-aware starter prompts; focus lands in the composer", async () => {
  render(<AssistantLauncher />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const dlg = await screen.findByRole("dialog");
  expect(within(dlg).getByRole("heading", { name: "Assistant" })).toBeTruthy();
  expect(within(dlg).getByRole("button", { name: "Fix the lint errors in this template" })).toBeTruthy(); // on /templates/t2
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Message the assistant")));
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("no OPENROUTER key: explains how to enable it and disables the composer", async () => {
  status = { configured: false };
  await open();
  expect(await screen.findByText("The assistant is off")).toBeTruthy();
  expect(screen.getByText(/OPENROUTER_API_KEY=/)).toBeTruthy();
  expect((screen.getByLabelText("Message the assistant") as HTMLTextAreaElement).disabled).toBe(true);
});

test("a rejected (paid) model override is shown in the panel, not swallowed", async () => {
  status = { configured: true, model: { error: { message: 'MAILCRAFT_ASSISTANT_MODEL "x/paid" is not an allowed model.', hint: "Unset it or pick a free one." } } };
  await open();
  expect(await screen.findByText("The assistant cannot start")).toBeTruthy();
  expect(screen.getByText(/x\/paid/)).toBeTruthy();
});

test("a turn streams: live phase with the orb, beam active, then text, collapsed steps, follow-up chips and the usage line", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  chat = () => ndjson([
    { type: "phase", phase: "reading", label: "Reading templates…" },
    { type: "tool", id: "c1", name: "list", label: "Reading templates…", status: "running" },
    { type: "tool", id: "c1", name: "list", label: "Read 3 templates", status: "done" },
    { type: "text", delta: "You have **three** templates." }, { type: "text", delta: "\nNEXT: Fix the lint errors | Send one to my Webinar list" },
  ], () => gate);
  await open();
  await ask("what templates do I have?");
  expect((await screen.findAllByText("Reading templates…")).length).toBeGreaterThan(0); // the orb label and the running step row
  expect(document.querySelector("[data-orb=searching]")).toBeTruthy(); // phase "reading" -> searching orb
  expect(document.querySelector("[data-beam=line]")!.getAttribute("data-active")).toBe("true");
  expect(document.querySelector("[data-avatar=working]")).toBeTruthy(); // header avatar follows the real status
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  await act(async () => { release(); });
  await act(async () => { chat = () => ndjson([]); });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
  expect(screen.getByText("three").tagName).toBe("STRONG");
  expect(screen.getByText("Used 1 tool")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Fix the lint errors" })).toBeTruthy(); // NEXT line became a chip, not text
  expect(screen.queryByText(/NEXT:/)).toBeNull();
  expect(document.querySelector("[data-beam=line]")!.getAttribute("data-active")).toBe("false");
  expect(document.querySelector("[data-avatar=default]")).toBeTruthy();
  expect(calls.find((c) => c.url === "/api/assistant")!.body).toMatchObject({ page: { path: "/templates/t2" }, messages: [{ role: "user", content: "what templates do I have?" }] });
});

test("usage line shows tokens, requests and times of the last turn", async () => {
  turn([{ type: "text", delta: "ok" }, done]);
  await open();
  await ask("hi");
  expect(await screen.findByText(/1\.2k in \/ 80 out/)).toBeTruthy();
  expect(screen.getByText(/first token 0\.9s/)).toBeTruthy();
  expect(screen.getByText(/4\.2s total/)).toBeTruthy();
  expect(screen.getByText(/41 left on the key/)).toBeTruthy();
});

test("Apply sends only the proposal id to the execute route, then shows the task row with a link", async () => {
  turn([{ type: "proposal", proposal: PROPOSAL as any }, { type: "text", delta: "Review the card." }, done]);
  apply = () => json({ result: { status: "completed", label: 'Update template "Receipt"', href: "/templates/t2" } });
  await open();
  await ask("fix the greeting");
  const card = await screen.findByRole("region", { name: 'Update template "Receipt"' });
  expect(within(card).getByText("+1")).toBeTruthy(); // diff stat
  expect(calls.some((c) => c.url === "/api/assistant/apply")).toBe(false); // nothing executes until Apply
  fireEvent.click(within(card).getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(within(card).getByText("Completed")).toBeTruthy());
  const ap = calls.filter((c) => c.url === "/api/assistant/apply");
  expect(ap).toHaveLength(1);
  expect(ap[0].body).toEqual({ id: "p1", action: "apply", confirmed: false });
  expect(within(card).getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/templates/t2");
});

test("Cancel drops the proposal and never calls apply", async () => {
  turn([{ type: "proposal", proposal: PROPOSAL as any }, done]);
  await open();
  await ask("fix the greeting");
  const card = await screen.findByRole("region", { name: 'Update template "Receipt"' });
  fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(within(card).getByText(/Cancelled/)).toBeTruthy());
  expect(calls.filter((c) => c.url === "/api/assistant/apply").map((c) => c.body.action)).toEqual(["cancel"]);
});

test("a live send asks 'This will email N real people' first and only then applies with confirmed:true", async () => {
  const live = { ...PROPOSAL, id: "p2", kind: "broadcast", risk: "sends", title: "Broadcast to Webinar", confirm: "This will email 3 real people.", diff: undefined } as any;
  turn([{ type: "proposal", proposal: live }, done]);
  apply = () => json({ result: { status: "queued", label: "Broadcast to Webinar", href: "/broadcasts/b9", detail: "Queued for sending." } });
  await open();
  await ask("send it");
  const card = await screen.findByRole("region", { name: "Broadcast to Webinar" });
  fireEvent.click(within(card).getByRole("button", { name: "Apply" }));
  const alert = await screen.findByRole("alertdialog");
  expect(within(alert).getByText("This will email 3 real people.")).toBeTruthy();
  expect(calls.some((c) => c.url === "/api/assistant/apply")).toBe(false);
  fireEvent.click(within(alert).getByRole("button", { name: "Yes, apply it" }));
  await waitFor(() => expect(within(card).getByText("Queued")).toBeTruthy());
  expect(calls.find((c) => c.url === "/api/assistant/apply")!.body).toEqual({ id: "p2", action: "apply", confirmed: true });
});

test("an apply refused by the API (approval, scope, kill switch) is shown as a failed task, not as success", async () => {
  turn([{ type: "proposal", proposal: PROPOSAL as any }, done]);
  apply = () => json({ result: { status: "failed", label: "Save draft failed", error: { code: "forbidden_scope", message: "This key cannot manage templates.", hint: "Use a key with the manage scope." } } });
  await open();
  await ask("fix");
  const card = await screen.findByRole("region", { name: 'Update template "Receipt"' });
  fireEvent.click(within(card).getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(within(card).getByText("Failed")).toBeTruthy());
  expect(within(card).getByText(/cannot manage templates/)).toBeTruthy();
});

test("Edit puts a follow-up into the composer instead of applying", async () => {
  turn([{ type: "proposal", proposal: PROPOSAL as any }, done]);
  await open();
  await ask("fix");
  const card = await screen.findByRole("region", { name: 'Update template "Receipt"' });
  fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
  expect((screen.getByLabelText("Message the assistant") as HTMLTextAreaElement).value).toContain('Change the proposal "Update template "Receipt"": ');
  expect(calls.some((c) => c.url === "/api/assistant/apply")).toBe(false);
});

test("a server error (503 not configured) becomes a readable alert", async () => {
  chat = () => json({ code: "not_configured", message: "The assistant is not enabled.", hint: "Set OPENROUTER_API_KEY on the dashboard server." }, 503);
  await open();
  await ask("hi");
  expect((await screen.findByRole("alert")).textContent).toContain("Set OPENROUTER_API_KEY");
});

test("Stop aborts the request and keeps what streamed", async () => {
  chat = (init) => ndjson([{ type: "text", delta: "Working on it" }], (s) => new Promise((_, rej) => s?.addEventListener("abort", () => rej(new Error("abort")))), init.signal);
  await open();
  await ask("long task");
  await screen.findByText("Working on it");
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
  expect(screen.getByText("Working on it")).toBeTruthy();
});

test("the conversation survives a reload (sessionStorage) and Clear wipes it", async () => {
  turn([{ type: "text", delta: "Hello again" }, done]);
  const first = render(<AssistantLauncher />);
  fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
  await ask("hi");
  await screen.findByText("Hello again");
  await screen.findByRole("button", { name: "Send message" }); // turn finished: the conversation is saved when idle
  first.unmount();
  render(<AssistantLauncher />);
  fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
  expect(await screen.findByText("Hello again")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear conversation" }));
  await waitFor(() => expect(screen.queryByText("Hello again")).toBeNull());
  expect(JSON.parse(sessionStorage.getItem("mailcraft.assistant.v1") ?? "[]")).toEqual([]);
});

test("earlier turns are sent as text plus a one-line note, never raw tool output", async () => {
  turn([{ type: "tool", id: "c1", name: "list", label: "Read 3 templates", status: "done" }, { type: "proposal", proposal: PROPOSAL as any }, { type: "text", delta: "Done." }, done]);
  await open();
  await ask("first");
  await screen.findByText("Done.");
  turn([{ type: "text", delta: "second reply" }, done]);
  await ask("second");
  await screen.findByText("second reply");
  const sent = calls.filter((c) => c.url === "/api/assistant").at(-1)!.body.messages;
  expect(sent[1]).toMatchObject({ role: "assistant", content: "Done.", note: expect.stringContaining("Read 3 templates") });
  expect(sent[1].note).toContain("proposed (not applied)");
  expect(JSON.stringify(sent)).not.toContain("untrusted");
});
