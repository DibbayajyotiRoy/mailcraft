// Accessibility of "Write with AI" in the New email dialog: axe in four states, then the focus, naming, live-region and tab-order contracts.
// The helpers below are copied from compose-ai.test.tsx on purpose: this file must not depend on, or break with, that one.
import axe from "axe-core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn() } }));
// The beam is an animation library (and wants matchMedia, which jsdom lacks): a probe stands in for it.
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

function setup() {
  const send = vi.fn().mockResolvedValue({ id: "em_1", status: "queued" });
  render(<ComposeEmail defaultFrom="hello@acme.test" senders={SENDERS} templates={TEMPLATES} send={send} />);
  fireEvent.click(screen.getByRole("button", { name: "New email" }));
}
const dialog = () => screen.getByRole("dialog");
const box = (label: string) => within(dialog()).getByLabelText(label) as HTMLInputElement;
const btn = (name: string) => within(dialog()).getByRole("button", { name });
const ask = (text = "Invite Ana to the demo") => {
  fireEvent.click(btn("Write with AI"));
  const q = within(dialog()).getByLabelText("What should this email say?");
  fireEvent.change(q, { target: { value: text } });
  return q;
};
const run = (s: ReturnType<typeof stream>) => { fireEvent.keyDown(ask(), { key: "Enter" }); return waitFor(() => expect(s.calls).toBe(1)); };
const region = () => dialog().querySelector("[data-ai-live]") as HTMLElement;
const useTemplate = () => {
  fireEvent.mouseDown(within(dialog()).getByRole("tab", { name: "Use a template" }), { button: 0, ctrlKey: false });
  fireEvent.change(box("Template"), { target: { value: "t1" } });
};

/** Serious and critical axe violations in the dialog. Only color-contrast is off: jsdom has no layout or computed colours to judge it by. */
async function seriousViolations() {
  const r = await axe.run(dialog(), { rules: { "color-contrast": { enabled: false } } });
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.help} @ ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

describe("Write with AI: axe, no serious or critical violations", () => {
  it("prompt row open, a tone chip pressed", async () => {
    setup(); ask();
    fireEvent.click(btn("Friendly"));
    expect(await seriousViolations()).toEqual([]);
  });

  it("mid-stream: subject done, body writing", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup(); await run(s);
    await s.feed(subj("Thursday demo"), done("subject"), subj("Hi A", "text"));
    expect(dialog().querySelector('[data-ai-phase="writing"]')).toBeTruthy();
    expect(dialog().querySelector('[data-live-field="text"][data-streaming="true"]')).toBeTruthy();
    expect(await seriousViolations()).toEqual([]);
  });

  it("done: Regenerate and Undo AI shown", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup(); await run(s);
    await s.feed(subj("Thursday demo"), done("subject"), subj("Hi Ana", "text"), done("text"), FINAL);
    btn("Regenerate"); btn("Undo AI");
    expect(await seriousViolations()).toEqual([]);
  });

  it("error alert, with what was written kept", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup(); await run(s);
    await s.feed(subj("Thursday"), { error: { code: "upstream_error", message: "provider reset", hint: "Try again" } });
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("provider reset");
    expect(await seriousViolations()).toEqual([]);
  });

  it("error alert in the prompt row, nothing written", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "not_configured", message: "Write with AI is not enabled.", hint: "Set OPENROUTER_API_KEY on the dashboard server." }, { status: 503 })));
    setup();
    fireEvent.keyDown(ask(), { key: "Enter" });
    await within(dialog()).findByRole("alert");
    expect(await seriousViolations()).toEqual([]);
  });

  it("template mode mid-stream, with the Variables list", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup(); useTemplate(); await run(s);
    await s.feed(done("subject"), subj("An", "var:first_name"), done("var:first_name"), subj("$1", "var:amount"));
    expect(within(dialog()).getByRole("list", { name: "Variables" })).toBeTruthy();
    expect(await seriousViolations()).toEqual([]);
  });
});

describe("Write with AI: focus", () => {
  it("moves to Stop when a run starts, and to Regenerate when it ends", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    const q = ask(); q.focus();
    expect(document.activeElement).toBe(q);
    fireEvent.keyDown(q, { key: "Enter" });
    await waitFor(() => expect(document.activeElement).toBe(btn("Stop")));
    await s.feed(subj("Thursday demo"), done("subject"), subj("Hi Ana", "text"), done("text"), FINAL);
    await waitFor(() => expect(document.activeElement).toBe(btn("Regenerate")));
  });

  it("moves to Regenerate after Stop as well", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup(); await run(s);
    await s.feed(subj("Thursday demo"), done("subject"), subj("Hi A", "text"));
    await waitFor(() => expect(document.activeElement).toBe(btn("Stop")));
    fireEvent.click(btn("Stop"));
    await waitFor(() => expect(document.activeElement).toBe(btn("Regenerate")));
  });

  it("stays on the field the user moved to when the run ends", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup(); await run(s);
    await waitFor(() => expect(document.activeElement).toBe(btn("Stop")));
    await s.feed(subj("Thursday demo"), done("subject"), subj("Hi", "text"));
    const message = box("Message");
    message.focus();
    expect(document.activeElement).toBe(message);
    await s.feed(subj(" Ana", "text"), done("text"), FINAL);
    expect(dialog().querySelector('[data-ai-phase="done"]')).toBeTruthy();
    expect(document.activeElement).toBe(message);
  });

  it("lands back in the prompt when a run fails with nothing written", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "not_configured", message: "Write with AI is not enabled." }, { status: 503 })));
    setup();
    const q = ask(); q.focus();
    fireEvent.keyDown(q, { key: "Enter" });
    await within(dialog()).findByRole("alert");
    await waitFor(() => expect(dialog().contains(document.activeElement) && document.activeElement !== dialog()).toBe(true));
    expect(document.activeElement).toBe(within(dialog()).getByLabelText("What should this email say?"));
  });
});

describe("Write with AI: roles, names and the live region", () => {
  it("tone chips are toggle buttons in a group named Tone", () => {
    setup(); ask();
    const group = within(dialog()).getByRole("group", { name: "Tone" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((b) => b.textContent)).toEqual(["Friendly", "Short", "Formal"]);
    for (const b of chips) { expect(b.tagName).toBe("BUTTON"); expect(b.getAttribute("type")).toBe("button"); expect(b.getAttribute("aria-pressed")).toBe("false"); }
    fireEvent.click(chips[1]);
    expect(chips.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    fireEvent.click(chips[2]); // one tone at a time
    expect(chips.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    fireEvent.click(chips[2]);
    expect(chips.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
  });

  it("Stop, Regenerate and Undo AI have accessible names (the icons are decorative)", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup(); await run(s);
    await s.feed(subj("Thursday demo"), done("subject"), subj("Hi A", "text"));
    const stop = within(dialog()).getByRole("button", { name: "Stop" }); // string name = exact match: no stray words from an icon
    expect(stop.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    await s.feed(done("text"), FINAL);
    for (const name of ["Regenerate", "Undo AI"]) {
      const b = within(dialog()).getByRole("button", { name });
      expect(b.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("the status row's timer is inside an aria-hidden container, so a screen reader never reads it", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup(); await run(s);
    await s.feed(subj("Thursday"));
    const status = dialog().querySelector('[data-ai-phase="writing"]') as HTMLElement;
    const timer = within(status).getByText(/^\d+\.\ds$/);
    const hidden = timer.closest('[aria-hidden="true"]');
    expect(hidden).toBeTruthy();
    expect(status.contains(hidden)).toBe(true);
    const clone = status.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    expect(clone.textContent).not.toMatch(/\d+\.\ds/);
    expect(within(status).getByRole("button", { name: "Stop" })).toBeTruthy(); // Stop is not swallowed by the hidden container
  });

  it("exactly one polite live region is exposed, it carries [data-ai-live], and it speaks on field completion only", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup();
    // Scoped to the Write with AI block: the recipient picker has its own (empty) match-count status. The Busy label inside the block is a role=status too, but it sits under aria-hidden: only the exposed ones count.
    const exposed = () => [...region().parentElement!.querySelectorAll('[aria-live="polite"], [role="status"]')].filter((n) => !n.closest('[aria-hidden="true"]'));
    expect(dialog().querySelectorAll("[data-ai-live]")).toHaveLength(1);
    expect(region().getAttribute("aria-live")).toBe("polite");
    expect(exposed()).toEqual([region()]);

    const spoken: string[] = [];
    new MutationObserver(() => spoken.push(region().textContent ?? "")).observe(region(), { childList: true, characterData: true, subtree: true });

    await run(s);
    expect(exposed()).toEqual([region()]);
    expect(spoken).toEqual([]); // starting is not announced; the Stop button taking focus says enough

    await s.feed(subj("Thurs"));
    await s.feed(subj("day demo"));
    expect(spoken).toEqual([]); // tokens do not talk to a screen reader
    await s.feed(done("subject"));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).not.toBe("");

    await s.feed(subj("Hi Ana,\n\n", "text"));
    await s.feed(subj("See you at 3.", "text"));
    expect(spoken).toHaveLength(1);
    expect(exposed()).toEqual([region()]);

    await s.feed(done("text"));
    expect(spoken).toHaveLength(2);
    await s.feed(FINAL);
    expect(spoken).toHaveLength(3); // the end of the run
    expect(spoken.every((t) => t !== "")).toBe(true);
    expect(new Set(spoken).size).toBe(3); // each announcement is different, none repeats
    expect(dialog().querySelectorAll("[data-ai-live]")).toHaveLength(1);
    expect(exposed()).toEqual([region()]);
  });

  it("the live region is not a second voice for errors: the alert carries them", async () => {
    const s = stream(); vi.stubGlobal("fetch", s.fetch);
    setup(); await run(s);
    await s.feed(subj("Thursday"), { error: { code: "upstream_error", message: "provider reset", hint: "Try again" } });
    const alert = await within(dialog()).findByRole("alert");
    expect(alert.contains(region())).toBe(false);
    expect(region().textContent).not.toContain("provider reset");
  });
});

describe("Write with AI: keyboard order", () => {
  it("Tab from the prompt textarea reaches the tone chips, then Cancel, then Write", () => {
    setup();
    const q = ask();
    // No positive tabindex anywhere in the dialog, so Tab follows document order.
    expect(dialog().querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toHaveLength(0);
    const tabbable = [...dialog().querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")]
      .filter((n) => !n.hasAttribute("disabled") && n.getAttribute("tabindex") !== "-1" && !n.closest('[hidden], [inert], [aria-hidden="true"]') && (n as HTMLInputElement).type !== "hidden");
    const at = tabbable.indexOf(q);
    expect(at).toBeGreaterThanOrEqual(0);
    const name = (n: HTMLElement) => n.getAttribute("aria-label") ?? n.textContent;
    expect(tabbable.slice(at + 1, at + 6).map(name)).toEqual(["Friendly", "Short", "Formal", "Cancel", "Write"]);
  });
});
