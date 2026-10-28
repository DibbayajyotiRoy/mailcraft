import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn() } }));
// The beam is an animation library: a probe that shows whether it was asked to run.
vi.mock("border-beam", async () => {
  const { createElement } = await import("react");
  return { BorderBeam: (p: Record<string, unknown>) => createElement("div", { "data-beam": String(p.size), "data-active": String(p.active) }, p.children as never) };
});
import { ComposeEmail } from "@/components/emails/compose";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const TEMPLATES = [{ id: "t1", name: "Receipt", variables: ["first_name", "amount", "unsubscribe_url"] }];
const SENDERS = [{ address: "hello@acme.test", display_name: "Acme", status: "ready" }];

/** A /api/compose/write response the test feeds by hand, event by event, and that errors on abort like a real fetch. */
function stream() {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  const s = {
    signal: undefined as AbortSignal | undefined, req: undefined as any, calls: 0,
    feed: (...evs: unknown[]) => act(async () => { ctl.enqueue(enc.encode(evs.map((e) => JSON.stringify(e) + "\n").join(""))); await new Promise((r) => setTimeout(r, 8)); }),
    end: () => act(async () => { ctl.close(); await new Promise((r) => setTimeout(r, 8)); }),
    fetch: vi.fn(async (_u: string, init: RequestInit) => {
      s.calls++; s.signal = init.signal ?? undefined; s.req = JSON.parse(String(init.body));
      init.signal?.addEventListener("abort", () => { try { ctl.error(new DOMException("aborted", "AbortError")); } catch { /* already closed */ } });
      return new Response(body, { status: 200 });
    }),
  };
  return s;
}
const subj = (v: string, f = "subject") => ({ field: f, delta: v }), done = (f: string) => ({ field: f, done: true });
const FINAL = { done: true, usage: { tokens: 405, prompt: 310, completion: 95, ms: 3100, model: "nvidia/nemotron-3-ultra:free" } };

function setup(opts: { send?: ReturnType<typeof vi.fn>; contacts?: boolean } = {}) {
  const send = opts.send ?? vi.fn().mockResolvedValue({ id: "em_1", status: "queued" });
  const contacts = opts.contacts ? { search: vi.fn(async () => [{ id: "c1", email: "ana@example.com", first_name: "Ana", last_name: "Silva" }]), find: vi.fn(async () => ({ contact: null })), create: vi.fn() } : undefined;
  render(<ComposeEmail defaultFrom="hello@acme.test" senders={SENDERS} templates={TEMPLATES} send={send} contacts={contacts} />);
  fireEvent.click(screen.getByRole("button", { name: "New email" }));
  return send;
}
const dialog = () => screen.getByRole("dialog");
const box = (label: string) => within(dialog()).getByLabelText(label) as HTMLInputElement;
const live = (f: string) => dialog().querySelector(`[data-live-field="${f}"]`) as HTMLElement;
const beamOn = () => [...dialog().querySelectorAll("[data-live-field]")].filter((n) => n.querySelector("[data-beam][data-active=true]")).map((n) => n.getAttribute("data-live-field"));
const carets = () => [...dialog().querySelectorAll("[data-live-field] [data-caret]")].map((n) => n.closest("[data-live-field]")!.getAttribute("data-live-field"));
const ask = (text = "Invite Ana to the demo") => {
  fireEvent.click(within(dialog()).getByRole("button", { name: "Write with AI" }));
  const q = within(dialog()).getByLabelText("What should this email say?");
  fireEvent.change(q, { target: { value: text } });
  return q;
};
const announce = () => dialog().querySelector("[data-ai-live]")!.textContent;

describe("Write with AI", () => {
  it("opens a prompt row with optional tone chips; Enter starts, Shift+Enter does not", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    expect(within(dialog()).queryByLabelText("What should this email say?")).toBeNull();
    const q = ask();
    const friendly = within(dialog()).getByRole("button", { name: "Friendly" });
    expect(within(dialog()).getAllByRole("button", { pressed: false }).map((b) => b.textContent)).toEqual(expect.arrayContaining(["Friendly", "Short", "Formal"]));
    fireEvent.click(friendly);
    expect(friendly.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(q, { key: "Enter", shiftKey: true });
    expect(s.calls).toBe(0);
    fireEvent.keyDown(q, { key: "Enter" });
    await waitFor(() => expect(s.calls).toBe(1));
    expect(s.req).toEqual({ prompt: "Invite Ana to the demo", tone: "friendly", mode: "text", fromName: "Acme", names: [], count: 0 });
  });

  it("sends contact names, never addresses, and the sender's display name", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup({ contacts: true });
    const to = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(to, { target: { value: "an" } });
    fireEvent.click(await screen.findByRole("option", { name: /Ana Silva/ }));
    fireEvent.keyDown(ask(), { key: "Enter" });
    await waitFor(() => expect(s.calls).toBe(1));
    expect(s.req).toMatchObject({ names: ["Ana Silva"], count: 1, fromName: "Acme" });
    expect(JSON.stringify(s.req)).not.toContain("@example.com");
  });

  it("fills subject, then the body, as the stream arrives; the beam and the caret follow the field being written", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    fireEvent.change(box("Subject"), { target: { value: "old subject" } });
    fireEvent.keyDown(ask(), { key: "Enter" });
    await waitFor(() => expect(s.calls).toBe(1));
    expect(within(dialog()).getByText("Thinking…")).toBeTruthy(); // nothing written yet: no beam, no caret
    expect(beamOn()).toEqual([]); expect(carets()).toEqual([]);
    expect(within(dialog()).getByRole("button", { name: "Send email" }).hasAttribute("disabled")).toBe(true); // a half-written draft cannot be sent

    await s.feed(subj("Thurs"));
    expect(box("Subject").value).toBe("Thurs"); // the first delta replaced the old value
    expect(within(dialog()).getByText("Writing subject…")).toBeTruthy();
    expect(beamOn()).toEqual(["subject"]); expect(carets()).toEqual(["subject"]);
    expect(live("subject").querySelector("[data-beam]")!.getAttribute("data-beam")).toBe("line");
    expect(box("Subject").readOnly).toBe(true); // the field being written is not editable mid-token
    expect(box("Message").readOnly).toBe(false); // every other field is

    await s.feed(subj("day demo"), done("subject"));
    expect(box("Subject").value).toBe("Thursday demo");
    expect(announce()).toBe("Subject written");
    expect(within(dialog()).getByText("Writing body…")).toBeTruthy();
    expect(beamOn()).toEqual(["text"]); expect(carets()).toEqual(["text"]);
    expect(box("Subject").readOnly).toBe(false);

    await s.feed(subj("Hi Ana,\n\n", "text"));
    await s.feed(subj("See you at 3.", "text"));
    expect(box("Message").value).toBe("Hi Ana,\n\nSee you at 3.");
    expect(announce()).toBe("Subject written"); // tokens do not talk to a screen reader

    await s.feed(done("text"), FINAL);
    expect(announce()).toMatch(/^Done\./);
    expect(beamOn()).toEqual([]); expect(carets()).toEqual([]);
    expect(within(dialog()).getByText(/Written by AI · 405 tokens · 3\.1s · nemotron-3-ultra/)).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Regenerate" })).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Undo AI" })).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Send email" }).hasAttribute("disabled")).toBe(false);
  });

  it("the live caret mirrors the text so it sits at its end, and the timer is hidden from screen readers", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    fireEvent.keyDown(ask(), { key: "Enter" });
    await s.feed(subj("Hello", "subject"));
    const status = within(dialog()).getByText("Writing subject…").closest("[aria-hidden=true]")!;
    expect(status.textContent).toMatch(/\d+\.\ds/);
    await s.feed(done("subject"), subj("Line one\nLine two", "text"));
    const mirror = live("text").querySelector("[aria-hidden=true]")!;
    expect(mirror.textContent!.startsWith("Line one\nLine two")).toBe(true);
    expect(mirror.querySelector("[data-caret]")).toBeTruthy();
    expect(mirror.className).toContain("invisible"); // layout only: the textarea shows the text, the mirror the caret
  });

  it("template mode ticks each variable as it completes, and never asks for platform variables", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    fireEvent.mouseDown(within(dialog()).getByRole("tab", { name: "Use a template" }), { button: 0, ctrlKey: false });
    fireEvent.change(box("Template"), { target: { value: "t1" } });
    fireEvent.keyDown(ask("Thank Ana for the payment"), { key: "Enter" });
    await waitFor(() => expect(s.calls).toBe(1));
    expect(s.req).toMatchObject({ mode: "template", template: "t1" });
    const list = () => within(within(dialog()).getByRole("list", { name: "Variables" })).getAllByRole("listitem").map((li) => `${li.textContent}`);
    expect(list()).toEqual(["first_namewaiting", "amountwaiting"]);

    await s.feed(done("subject"), subj("An", "var:first_name"));
    expect(within(dialog()).getByText("Filling first_name…")).toBeTruthy();
    expect(beamOn()).toEqual(["var:first_name"]);
    expect(list()).toEqual(["first_namewriting", "amountwaiting"]);
    await s.feed(subj("a", "var:first_name"), done("var:first_name"), subj("$12", "var:amount"));
    expect(box("first_name").value).toBe("Ana");
    expect(list()).toEqual(["first_namedone", "amountwriting"]);
    expect(announce()).toBe("first_name filled");
    expect(beamOn()).toEqual(["var:amount"]);
    await s.feed(done("var:amount"), FINAL);
    expect(list()).toEqual(["first_namedone", "amountdone"]);
    expect(box("amount").value).toBe("$12");
    expect(within(dialog()).getByRole("list", { name: "Variables" }).querySelectorAll("svg.text-ok")).toHaveLength(2); // two ticks
  });

  it("Stop cancels the request and keeps what was written; the user can go on editing", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    fireEvent.keyDown(ask(), { key: "Enter" });
    await s.feed(subj("Thursday demo"), done("subject"), subj("Hi A", "text"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stop" }));
    expect(s.signal!.aborted).toBe(true);
    await waitFor(() => expect(dialog().querySelector('[data-ai-phase="stopped"]')!.textContent).toContain("Stopped. What was written is kept."));
    expect(announce()).toBe("Stopped. What was written is kept.");
    expect(box("Subject").value).toBe("Thursday demo");
    expect(box("Message").value).toBe("Hi A");
    expect(beamOn()).toEqual([]); expect(carets()).toEqual([]);
    expect(box("Message").readOnly).toBe(false);
    fireEvent.change(box("Message"), { target: { value: "Hi Ana, see you." } });
    expect(box("Message").value).toBe("Hi Ana, see you.");
    expect(within(dialog()).getByRole("button", { name: "Send email" }).hasAttribute("disabled")).toBe(false);
  });

  it("Undo AI puts back exactly what was there before, even after a Regenerate", async () => {
    const s1 = stream(); vi.stubGlobal("fetch", s1.fetch);
    setup();
    fireEvent.change(box("Subject"), { target: { value: "My subject" } });
    fireEvent.change(box("Message"), { target: { value: "My own words" } });
    fireEvent.keyDown(ask("Be nice", ), { key: "Enter" });
    await s1.feed(subj("AI one"), done("subject"), subj("AI body one", "text"), done("text"), FINAL);
    expect(box("Message").value).toBe("AI body one");

    const s2 = stream(); vi.stubGlobal("fetch", s2.fetch);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(s2.calls).toBe(1));
    expect(s2.req.prompt).toBe("Be nice"); // the same request again
    await s2.feed(subj("AI two"), done("subject"), subj("AI body two", "text"), done("text"), FINAL);
    expect(box("Subject").value).toBe("AI two");

    fireEvent.click(within(dialog()).getByRole("button", { name: "Undo AI" }));
    expect(box("Subject").value).toBe("My subject");
    expect(box("Message").value).toBe("My own words");
    expect(within(dialog()).queryByRole("button", { name: "Undo AI" })).toBeNull();
    expect(within(dialog()).getByLabelText("What should this email say?")).toBeTruthy(); // back to the prompt row, ready for another go
  });

  it("Undo restores a variable that had no value by clearing it", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    fireEvent.mouseDown(within(dialog()).getByRole("tab", { name: "Use a template" }), { button: 0, ctrlKey: false });
    fireEvent.change(box("Template"), { target: { value: "t1" } });
    fireEvent.keyDown(ask(), { key: "Enter" });
    await s.feed(subj("Ana", "var:first_name"), done("var:first_name"), FINAL);
    expect(box("first_name").value).toBe("Ana");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Undo AI" }));
    expect(box("first_name").value).toBe("");
  });

  it("an error keeps what was written and offers Regenerate; with nothing written it returns to the prompt", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    fireEvent.keyDown(ask(), { key: "Enter" });
    await s.feed(subj("Thursday"), { error: { code: "upstream_error", message: "provider reset", hint: "Try again" } });
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("provider reset");
    expect(box("Subject").value).toBe("Thursday");
    expect(within(dialog()).getByRole("button", { name: "Regenerate" })).toBeTruthy();
    expect(beamOn()).toEqual([]);
    // A draft that stopped early may be cut off: Send waits until the user has edited it (or regenerated).
    const sendBtn = () => within(dialog()).getByRole("button", { name: "Send email" });
    expect(sendBtn().hasAttribute("disabled")).toBe(true);
    expect(within(dialog()).getByText(/may be cut off/)).toBeTruthy();
    fireEvent.change(box("Subject"), { target: { value: "Thursday demo" } });
    expect(sendBtn().hasAttribute("disabled")).toBe(false);

    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "not_configured", message: "Write with AI is not enabled.", hint: "Set OPENROUTER_API_KEY on the dashboard server." }, { status: 503 })));
    setup();
    fireEvent.keyDown(ask(), { key: "Enter" });
    const alert = await within(dialog()).findByRole("alert");
    expect(alert.textContent).toContain("Set OPENROUTER_API_KEY");
    expect(within(dialog()).getByLabelText("What should this email say?")).toBeTruthy(); // still there to edit and retry
  });

  it("template mode without a template says so and calls nobody", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    setup();
    fireEvent.mouseDown(within(dialog()).getByRole("tab", { name: "Use a template" }), { button: 0, ctrlKey: false });
    fireEvent.keyDown(ask(), { key: "Enter" });
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("Choose a template first");
    expect(f).not.toHaveBeenCalled();
  });

  it("nothing sends by itself: Send goes through the normal path with the AI's values, and only when pressed", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    const send = setup();
    fireEvent.change(box("To"), { target: { value: "ana@example.com" } });
    fireEvent.keyDown(ask(), { key: "Enter" });
    await s.feed(subj("Thursday demo"), done("subject"), subj("Hi Ana", "text"), done("text"), FINAL);
    await new Promise((r) => setTimeout(r, 30));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send email" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ from: "hello@acme.test", to: ["ana@example.com"], stream: "transactional", subject: "Thursday demo", text: "Hi Ana" }));
  });

  it("Enter in a field while the draft is writing does not send it", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    const send = setup();
    fireEvent.change(box("To"), { target: { value: "ana@example.com" } });
    fireEvent.keyDown(ask(), { key: "Enter" });
    await s.feed(subj("Thurs"));
    fireEvent.submit(dialog().querySelector("form")!);
    await new Promise((r) => setTimeout(r, 20));
    expect(send).not.toHaveBeenCalled();
  });

  it("closing the dialog cancels the request", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    fireEvent.keyDown(ask(), { key: "Enter" });
    await s.feed(subj("Thurs"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(s.signal!.aborted).toBe(true);
  });
});

describe("Write with AI under prefers-reduced-motion", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: /prefers-reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {} }));
  });
  it("text still streams, but the beam stays off and the caret does not blink", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    fireEvent.keyDown(ask(), { key: "Enter" });
    await s.feed(subj("Thursday"));
    expect(box("Subject").value).toBe("Thursday");
    expect(live("subject").getAttribute("data-streaming")).toBe("true"); // it is still the field being written…
    expect(beamOn()).toEqual([]); // …but nothing animates around it
    const caret = live("subject").querySelector("[data-caret]")!;
    expect(caret.getAttribute("data-caret")).toBe("still");
    expect(caret.className).not.toContain("animate-caret");
  });
  it("without the preference the caret blinks and the beam runs", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    fireEvent.keyDown(ask(), { key: "Enter" });
    await s.feed(subj("Thursday"));
    expect(live("subject").querySelector("[data-caret]")!.className).toContain("animate-caret");
    expect(beamOn()).toEqual(["subject"]);
  });
});
