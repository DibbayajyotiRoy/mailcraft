import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The beam and the avatar are canvas/animation libraries: replace them with probes that expose the props they were given.
vi.mock("border-beam", async () => {
  const { createElement } = await import("react");
  return { BorderBeam: (p: Record<string, unknown>) => createElement("div", { "data-testid": "beam", "data-active": String(p.active), "data-size": String(p.size), "data-theme": String(p.theme), "data-variant": String(p.colorVariant) }, p.children as never) };
});
vi.mock("bot-avatars", async () => {
  const { createElement } = await import("react");
  return { BotAvatar: () => createElement("span", { "data-testid": "bot" }) };
});

import { Composer, COMMANDS, token } from "@/components/assistant/Composer";
import { Markdown, splitNext } from "@/components/assistant/Markdown";
import { ProposalCard, TaskRow } from "@/components/assistant/ProposalCard";
import { Steps } from "@/components/assistant/Steps";
import { reduce, toHistory, type Card, type Msg, type Step } from "@/components/assistant/useAssistant";
import type { ApplyResult, ChatEvent, DoneStats, Phase, Proposal } from "@/lib/assistant/types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.removeAttribute("data-theme"); });

/* ------------------------------------------------------------------ Markdown */

describe("Markdown", () => {
  const html = (text: string) => render(<Markdown text={text} />).container;

  it("never renders raw HTML: tags come out as literal text", () => {
    const c = html('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n<b>bold?</b> <a href="https://evil.test">x</a>');
    expect(c.querySelector("script, img, b, a, iframe")).toBeNull();
    expect(c.textContent).toContain("<script>alert(1)</script>");
    expect(c.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(c.textContent).toContain("<b>bold?</b>");
  });

  it("keeps HTML inert inside bold, code, list items, headings and fenced code too", () => {
    const c = html("**<i>x</i>** and `<u>y</u>`\n\n- <svg onload=alert(1)>\n1. <iframe src=//evil.test>\n\n# <h1>big</h1>\n\n```\n<script>z</script>\n```");
    expect(c.querySelector("i, u, svg, iframe, h1, script")).toBeNull();
    expect(c.querySelector("strong")!.textContent).toBe("<i>x</i>");
    expect(c.querySelector("p code")!.textContent).toBe("<u>y</u>");
    expect(c.querySelector("pre code")!.textContent).toBe("<script>z</script>");
    expect(c.textContent).toContain("<svg onload=alert(1)>");
    expect(c.textContent).toContain("<h1>big</h1>");
  });

  it("does not let link text smuggle markup either", () => {
    const c = html("[<img src=x onerror=alert(1)>](https://example.com/a)");
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("a")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it.each([
    ["javascript:void0"], ["JaVaScRiPt:alert"], ["data:text/html;base64,PHNjcmlwdD4="], ["vbscript:x"],
    ["//evil.test/x"], ["mailto:a@b.c"], ["&#106;avascript:alert"], ["ftp://x.test/f"], ["relative/path"], ["#frag"],
  ])("drops the href of [x](%s) but keeps the link text", (href) => {
    const c = html(`before [click me](${href}) after`);
    expect(c.querySelector("a, [href]")).toBeNull();
    expect(c.querySelector("p")!.textContent).toBe("before click me after");
  });

  it("drops a javascript: link whose payload has parentheses (no anchor, no href; the link text survives)", () => {
    const c = html("[click me](javascript:alert(document.cookie))");
    expect(c.querySelector("a, [href]")).toBeNull();
    expect(c.textContent).toContain("click me");
  });

  it("does not make a link out of text that merely looks like one (space in the URL)", () => {
    const c = html("[x](javascript:alert 1) and [y](https://ok.test/a b)");
    expect(c.querySelector("a")).toBeNull();
  });

  it("keeps a closing parenthesis that belongs to the URL", () => {
    const c = html("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))");
    expect(c.querySelector("a")!.getAttribute("href")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(c.textContent).toBe("Foo");
  });

  it("never emits an href that is not http(s) or a single-slash path, whatever mix is given", () => {
    const c = html("[a](javascript:1) [b](https://ok.test) [c](/templates) [d](//cdn.test) [e](http://ok.test/x) [f](data:x)");
    const hrefs = [...c.querySelectorAll("[href]")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://ok.test", "/templates", "http://ok.test/x"]);
  });

  it("opens external links in a new tab with noopener noreferrer", () => {
    const a = html("[docs](https://example.com/docs?a=1)").querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/docs?a=1");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders internal paths as in-app links (no target)", () => {
    const a = html("[open it](/broadcasts/b_1)").querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/broadcasts/b_1");
    expect(a.hasAttribute("target")).toBe(false);
  });

  it("renders paragraphs, line breaks, bold, inline code and lists", () => {
    const c = html("first line\nsecond line\n\n**Bold** and `code`\n\n- one\n- two\n\n1. a\n2. b");
    const [p1, p2] = c.querySelectorAll("p");
    expect(p1.querySelectorAll("br")).toHaveLength(1);
    expect(p2.querySelector("strong")!.textContent).toBe("Bold");
    expect(p2.querySelector("code")!.textContent).toBe("code");
    expect([...c.querySelectorAll("ul li")].map((l) => l.textContent)).toEqual(["one", "two"]);
    expect([...c.querySelectorAll("ol li")].map((l) => l.textContent)).toEqual(["a", "b"]);
  });

  it("renders fenced code verbatim, including an unterminated fence", () => {
    expect(html("```\nconst a = **1**;\n  indented\n```").querySelector("pre code")!.textContent).toBe("const a = **1**;\n  indented");
    expect(html("```\nstill streaming").querySelector("pre code")!.textContent).toBe("still streaming");
  });

  it("turns # headings into a semibold paragraph without the hashes", () => {
    const p = html("## Summary").querySelector("p")!;
    expect(p.textContent).toBe("Summary");
    expect(p.className).toContain("font-semibold");
  });

  it("renders empty text as an empty container", () => {
    expect(html("").firstElementChild!.children).toHaveLength(0);
  });
});

describe("splitNext", () => {
  it("strips a trailing NEXT line and returns the suggestions", () => {
    expect(splitNext("All set.\nNEXT: Send a test | Edit the subject")).toEqual({ body: "All set.", next: ["Send a test", "Edit the subject"] });
  });
  it("trims blank lines before the marker and whitespace after the list", () => {
    expect(splitNext("Done.\n\n  NEXT:  a |  b  \n")).toEqual({ body: "Done.", next: ["a", "b"] });
  });
  it("strips wrapping quotes and backticks from each suggestion", () => {
    expect(splitNext("x\nNEXT: \"Send it\" | 'Cancel' | `Edit`").next).toEqual(["Send it", "Cancel", "Edit"]);
  });
  it("keeps at most 3 suggestions and drops empty ones", () => {
    expect(splitNext("x\nNEXT: a | b | c | d | e").next).toEqual(["a", "b", "c"]);
    expect(splitNext("x\nNEXT: a || | b |").next).toEqual(["a", "b"]);
  });
  it("leaves text without a marker untouched", () => {
    expect(splitNext("Nothing to suggest.")).toEqual({ body: "Nothing to suggest.", next: [] });
  });
  it("hides an empty or still-streaming marker with no suggestions", () => {
    expect(splitNext("Done.\nNEXT:")).toEqual({ body: "Done.", next: [] });
    expect(splitNext("Done.\nNEXT:   ")).toEqual({ body: "Done.", next: [] });
    expect(splitNext("Done.\nNEXT").body).toBe("Done.");
  });
  it("only treats the final line as the marker", () => {
    const t = "NEXT: a | b\nbut then more text";
    expect(splitNext(t)).toEqual({ body: t, next: [] });
  });
  it("does not cut a sentence that merely contains the word NEXT:", () => {
    const t = "Your NEXT: billing date is May 1";
    expect(splitNext(t)).toEqual({ body: t, next: [] });
    expect(splitNext("Done.\nYour NEXT: step is yours")).toEqual({ body: "Done.\nYour NEXT: step is yours", next: [] });
  });
  it("holds back a partly streamed marker so the panel never flashes it", () => {
    for (const tail of ["N", "NE", "NEX", "NEXT"]) expect(splitNext(`Done.\n${tail}`)).toEqual({ body: "Done.", next: [] });
    expect(splitNext("Done.\nNo more to say")).toEqual({ body: "Done.\nNo more to say", next: [] });
  });
  it("is case sensitive", () => {
    expect(splitNext("x\nnext: a | b")).toEqual({ body: "x\nnext: a | b", next: [] });
  });
  it("splits only on the pipe, keeping commas and colons inside a suggestion", () => {
    expect(splitNext("x\nNEXT: Add Ann, Bob | Why: bounced").next).toEqual(["Add Ann, Bob", "Why: bounced"]);
  });
});

/* ------------------------------------------------------------------ useAssistant reduce / toHistory */

const stats: DoneStats = { model: "m", prompt: 1, completion: 2, rounds: 1, ttft_ms: 3, total_ms: 4, est_input: 5 };
const proposal = (over: Partial<Proposal> = {}): Proposal => ({ id: "p1", kind: "template", title: "Welcome template", summary: "Adds a welcome template", risk: "safe", warnings: [], expires_at: Date.now() + 3_600_000, ...over });
const bot = (over: Partial<Msg> = {}): Msg => ({ id: "m1", role: "assistant", text: "", steps: [], cards: [], ...over });
const step = (id: string, over: Partial<Step> = {}): Step => ({ id, name: "list_templates", label: `Read ${id}`, status: "done", ...over });
const cardOf = (state: Card["state"], title: string): Card => ({ proposal: proposal({ id: title, title }), state });

describe("reduce", () => {
  it("appends text deltas in order", () => {
    const m = (["Hel", "lo ", "there"] as const).reduce((acc, delta) => reduce(acc, { type: "text", delta }), bot());
    expect(m.text).toBe("Hello there");
  });

  it("adds a tool step, then updates the same step in place when its status changes", () => {
    let m = reduce(bot(), { type: "tool", id: "t1", name: "list_templates", label: "Reading templates", status: "running" });
    m = reduce(m, { type: "tool", id: "t2", name: "get_list", label: "Reading lists", status: "running" });
    m = reduce(m, { type: "tool", id: "t1", name: "list_templates", label: "Read 4 templates", status: "done", detail: "4 found" });
    expect(m.steps).toEqual([
      { id: "t1", name: "list_templates", label: "Read 4 templates", status: "done", detail: "4 found" },
      { id: "t2", name: "get_list", label: "Reading lists", status: "running", detail: undefined },
    ]);
  });

  it("adds a proposal as a pending card, keeping earlier ones", () => {
    let m = reduce(bot(), { type: "proposal", proposal: proposal({ id: "a" }) });
    m = reduce(m, { type: "proposal", proposal: proposal({ id: "b" }) });
    expect(m.cards.map((c) => [c.proposal.id, c.state])).toEqual([["a", "pending"], ["b", "pending"]]);
  });

  it("records an error with its hint and the done stats", () => {
    let m = reduce(bot(), { type: "error", code: "rate_limited", message: "Slow down", hint: "Wait a minute" });
    expect(m.error).toEqual({ code: "rate_limited", message: "Slow down", hint: "Wait a minute" });
    m = reduce(m, { type: "done", stats });
    expect(m.stats).toBe(stats);
    expect(m.error).toBeDefined();
  });

  it("ignores phase events (they are panel state, not message state) by returning the same object", () => {
    const m = bot({ text: "x" });
    expect(reduce(m, { type: "phase", phase: "reading", label: "Reading…" })).toBe(m);
  });

  it("does not mutate the message it was given", () => {
    const m = Object.freeze(bot({ steps: Object.freeze([step("a")]) as never, cards: Object.freeze([]) as never }));
    const events: ChatEvent[] = [
      { type: "text", delta: "x" }, { type: "tool", id: "a", name: "n", label: "l", status: "error" },
      { type: "tool", id: "z", name: "n", label: "l", status: "running" }, { type: "proposal", proposal: proposal() }, { type: "done", stats },
    ];
    for (const e of events) expect(() => reduce(m, e)).not.toThrow();
    expect(m.text).toBe("");
    expect(m.steps).toHaveLength(1);
  });
});

describe("toHistory", () => {
  const user = (text: string): Msg => ({ id: "u", role: "user", text, steps: [], cards: [] });

  it("maps role and text, with no note key when there is nothing to note", () => {
    const h = toHistory([user("hi"), bot({ text: "hello" })]);
    expect(h).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
    expect(h[0]).not.toHaveProperty("note");
  });

  it("notes the tools used, by label, capped at the first 6", () => {
    const steps = Array.from({ length: 8 }, (_, i) => step(`s${i + 1}`));
    expect(toHistory([bot({ steps })])[0].note).toBe("tools: Read s1; Read s2; Read s3; Read s4; Read s5; Read s6");
  });

  it("notes applied, cancelled and still-pending proposals, and says pending ones were NOT applied", () => {
    const note = toHistory([bot({ cards: [cardOf("applied", "A"), cardOf("cancelled", "B"), cardOf("pending", "C")] })])[0].note;
    expect(note).toBe("applied: A; cancelled: B; proposed (not applied): C");
  });

  it("leaves out proposals that are mid-apply or failed (their outcome is not settled or not a change)", () => {
    expect(toHistory([bot({ cards: [cardOf("applying", "A"), cardOf("failed", "B")] })])[0]).not.toHaveProperty("note");
  });

  it("puts tools first and joins everything with '; '", () => {
    const note = toHistory([bot({ steps: [step("a")], cards: [cardOf("applied", "T")] })])[0].note;
    expect(note).toBe("tools: Read a; applied: T");
  });

  it("never carries raw tool detail into the history", () => {
    const m = bot({ steps: [step("a", { detail: "SECRET-ROW-DATA" })], cards: [{ proposal: proposal({ summary: "SECRET-SUMMARY", diff: { label: "x", before: "SECRET-BEFORE", after: "y" } }), state: "applied" }] });
    expect(JSON.stringify(toHistory([m]))).not.toMatch(/SECRET/);
  });
});

/* ------------------------------------------------------------------ ProposalCard / TaskRow */

const props = () => ({ onApply: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn() });
const show = (p: Proposal, state: Card["state"] = "pending", result?: ApplyResult) => {
  const fns = props();
  const view = render(<ProposalCard card={{ proposal: p, state, result }} {...fns} />);
  return { ...fns, ...view };
};

describe("ProposalCard buttons", () => {
  it("Apply calls onApply(false) once, with no dialog", () => {
    const { onApply, onCancel, onEdit } = show(proposal());
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(false);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("with proposal.confirm, Apply opens the dialog and does not apply yet", async () => {
    const { onApply } = show(proposal({ risk: "sends", confirm: "This emails 120 people on the live key." }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText("Please confirm")).toBeTruthy();
    expect(within(dlg).getByText("This emails 120 people on the live key.")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("confirming the dialog calls onApply(true), exactly once and never onApply(false)", async () => {
    const { onApply, onCancel } = show(proposal({ risk: "sends", confirm: "Sure?" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Yes, apply it" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(true);
    expect(onCancel).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("cancelling the confirm dialog closes it without applying and without cancelling the proposal", async () => {
    const { onApply, onCancel } = show(proposal({ risk: "sends", confirm: "Sure?" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onApply).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  });

  it("Cancel calls only onCancel and never onApply", () => {
    const { onApply, onCancel, onEdit } = show(proposal());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("Cancel on a confirm-gated proposal does not open the dialog or apply", () => {
    const { onApply, onCancel } = show(proposal({ risk: "sends", confirm: "Sure?" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Edit calls only onEdit", () => {
    const { onApply, onCancel, onEdit } = show(proposal());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("while applying, Apply shows busy and all three buttons are disabled", () => {
    const { onApply, onCancel, onEdit } = show(proposal({ confirm: "Sure?" }), "applying");
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply.getAttribute("aria-busy")).toBe("true");
    for (const name of ["Apply", "Edit", "Cancel"]) {
      const b = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      fireEvent.click(b);
    }
    expect(onApply).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("Applying…")).toBeTruthy();
  });

  it("says what Apply does not do yet", () => {
    show(proposal());
    expect(screen.getByText("Nothing changes until you apply.")).toBeTruthy();
  });
});

describe("ProposalCard states", () => {
  it("a pending proposal past its expiry shows the expired note and no buttons", () => {
    show(proposal({ expires_at: Date.now() - 1000 }));
    expect(screen.getByText(/This proposal expired/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("a pending proposal flips to expired on its own when the time comes", () => {
    vi.useFakeTimers();
    try {
      show(proposal({ expires_at: Date.now() + 5000 }));
      expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
      act(() => { vi.advanceTimersByTime(5100); });
      expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
      expect(screen.getByText(/This proposal expired/)).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("a proposal that has not expired offers the buttons and no expired note", () => {
    show(proposal({ expires_at: Date.now() + 60_000 }));
    expect(screen.queryByText(/expired/)).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  });

  it("expiry only applies to pending cards: an applied one past its expiry still shows its result", () => {
    show(proposal({ expires_at: Date.now() - 1000 }), "applied", { status: "completed", label: "Template created" });
    expect(screen.queryByText(/expired/)).toBeNull();
    expect(screen.getByText("Template created")).toBeTruthy();
  });

  it("a cancelled card says nothing was changed and has no buttons", () => {
    show(proposal(), "cancelled");
    expect(screen.getByText("Cancelled. Nothing was changed.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("applied and failed cards show the result as a task row and no buttons", () => {
    show(proposal(), "failed", { status: "failed", label: "Not created", error: { code: "x", message: "Name taken." } });
    expect(screen.getByRole("status").textContent).toContain("Not created");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("an applied card without a result renders no task row", () => {
    show(proposal(), "applied");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the section with the title and labels the kind (with a sends marker only for risky ones)", () => {
    const { unmount } = show(proposal({ kind: "broadcast", risk: "sends", title: "Spring sale" }));
    const sec = screen.getByRole("region", { name: "Spring sale" });
    expect(within(sec).getByText("Broadcast · sends email")).toBeTruthy();
    unmount();
    show(proposal({ kind: "automation_state", title: "Pause it" }));
    expect(screen.getByText("Automation")).toBeTruthy();
    expect(screen.queryByText(/sends email/)).toBeNull();
  });
});

describe("ProposalCard details", () => {
  it("lists warnings, items and (at most 6) lint findings", () => {
    show(proposal({
      warnings: ["Unsubscribe link missing"], items: ["a@x.test", "b@x.test"],
      lint: Array.from({ length: 8 }, (_, i) => ({ sev: i === 0 ? "error" : "warning", msg: `lint ${i + 1}` })),
    }));
    expect(screen.getByText("Unsubscribe link missing")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Included items" })).getAllByRole("listitem")).toHaveLength(2);
    const lint = within(screen.getByRole("list", { name: "Lint" })).getAllByRole("listitem");
    expect(lint).toHaveLength(6);
    expect(lint[0].textContent).toContain("error");
  });

  it("shows the audience count, skipped reasons without underscores, and the schedule", () => {
    show(proposal({ kind: "broadcast", audience: { count: 120, skipped: [{ reason: "suppressed_address", n: 3 }], schedule: "over 2 hours" } }));
    expect(screen.getByText("Will receive it").nextElementSibling!.textContent).toBe("120");
    expect(screen.getByText("Skipped: suppressed address").nextElementSibling!.textContent).toBe("3");
    expect(screen.getByText("over 2 hours")).toBeTruthy();
  });

  it("a list proposal says 'Matches now' instead", () => {
    show(proposal({ kind: "list", audience: { count: 7, skipped: [] } }));
    expect(screen.getByText("Matches now")).toBeTruthy();
    expect(screen.queryByText("Will receive it")).toBeNull();
  });

  it("diff: shows +/- totals, marks changed rows for screen readers and folds long diffs behind 'Show all'", () => {
    const before = Array.from({ length: 30 }, (_, i) => `old${i}`).join("\n"), after = Array.from({ length: 30 }, (_, i) => `new${i}`).join("\n");
    show(proposal({ diff: { label: "Subject", before, after } }));
    expect(screen.getByText("+30")).toBeTruthy();
    expect(screen.getByText("−30")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Subject changes" });
    expect(region.children).toHaveLength(14);
    expect(within(region).getAllByText("(added)")).toHaveLength(14);
    fireEvent.click(screen.getByRole("button", { name: "Show all 60 lines" }));
    expect(region.children).toHaveLength(60);
    expect(within(region).getAllByText("(removed)")).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(region.children).toHaveLength(14);
  });

  it("diff: a short diff has no 'Show all' button, and unchanged stretches fold into a counted row", () => {
    const before = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n"), after = before.replace("l6", "L6");
    show(proposal({ diff: { label: "Body", before, after } }));
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    expect(screen.getByText("4 unchanged lines")).toBeTruthy();
    expect(screen.getByText("3 unchanged lines")).toBeTruthy();
  });
});

describe("ProposalCard preview", () => {
  const withPreview = () => proposal({ preview: { subject: "Hello Ann", html: '<p>Hi</p><script>parent.document.title="pwned"</script>' } });

  it("is collapsed by default: no iframe is mounted until it is opened", () => {
    const { container } = show(withPreview());
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: /Show preview/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it('renders the email in an iframe with sandbox="" (no scripts, forms or same-origin) via srcdoc', () => {
    const { container } = show(withPreview());
    fireEvent.click(screen.getByRole("button", { name: /Show preview/ }));
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("title")).toBe("Email preview");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.hasAttribute("src")).toBe(false);
    expect(frame.getAttribute("srcdoc")).toContain("<p>Hi</p>");
    expect(screen.getByText("Hello Ann")).toBeTruthy();
    // the email's markup is only an attribute value: nothing from it lands in the host document
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByText("Hi")).toBeNull();
  });

  it("hides the iframe again on a second click", () => {
    const { container } = show(withPreview());
    fireEvent.click(screen.getByRole("button", { name: /Show preview/ }));
    fireEvent.click(screen.getByRole("button", { name: /Hide preview/ }));
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("shows '(none)' for an empty subject", () => {
    show(proposal({ preview: { subject: "", html: "<p>x</p>" } }));
    fireEvent.click(screen.getByRole("button", { name: /Show preview/ }));
    expect(screen.getByText("(none)")).toBeTruthy();
  });
});

describe("TaskRow", () => {
  const row = (r: ApplyResult) => render(<TaskRow r={r} />);

  it.each([
    ["completed", "Completed", "bg-ok-bg"],
    ["queued", "Queued", "bg-info-bg"],
    ["pending_approval", "Waiting for approval", "bg-warn-bg"],
    ["failed", "Failed", "bg-bad-bg"],
  ] as const)("%s shows a '%s' pill in the matching tone", (status, label, tone) => {
    row({ status, label: "Did the thing" });
    const pill = screen.getByText(label);
    expect(pill.className).toContain(tone);
    expect(screen.getByRole("status").textContent).toContain("Did the thing");
  });

  it("links 'Open' to href when there is one, and has no link otherwise", () => {
    const { unmount } = row({ status: "completed", label: "Broadcast queued", href: "/broadcasts/b_9", detail: "120 recipients" });
    const a = screen.getByRole("link", { name: "Open" });
    expect(a.getAttribute("href")).toBe("/broadcasts/b_9");
    expect(screen.getByText("120 recipients")).toBeTruthy();
    unmount();
    row({ status: "completed", label: "Done" });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows a failure's message with its hint, in the error colour", () => {
    row({ status: "failed", label: "Not sent", error: { code: "kill_switch", message: "Sending is paused.", hint: "Resume it in Settings." } });
    const p = screen.getByText("Sending is paused. Resume it in Settings.");
    expect(p.className).toContain("text-bad");
  });

  it("shows a failure's message alone when there is no hint", () => {
    row({ status: "failed", label: "Not sent", error: { code: "x", message: "Nope." } });
    expect(screen.getByText("Nope.")).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ Steps */

describe("Steps", () => {
  const phase = (p: Phase, label = `${p}…`) => ({ phase: p, label });
  const orb = (c: HTMLElement) => c.querySelector("canvas")!.getAttribute("data-orb");

  it.each([
    ["thinking", "working"],
    ["reading", "searching"],
    ["writing", "composing"],
  ] as const)("phase %s drives the %s orb, with the real label beside it", (p, state) => {
    const { container } = render(<Steps steps={[]} running phase={phase(p, "Doing the phase…")} />);
    expect(orb(container)).toBe(state);
    expect(screen.getByRole("status").textContent).toBe("Doing the phase…");
  });

  it("before any phase arrives it thinks", () => {
    const { container } = render(<Steps steps={[]} running phase={null} />);
    expect(orb(container)).toBe("working");
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });

  it("follows the phase as it changes", () => {
    const { container, rerender } = render(<Steps steps={[]} running phase={phase("thinking")} />);
    rerender(<Steps steps={[]} running phase={phase("reading", "Reading templates…")} />);
    expect(orb(container)).toBe("searching");
    rerender(<Steps steps={[]} running phase={phase("writing", "Drafting…")} />);
    expect(orb(container)).toBe("composing");
  });

  it("renders nothing when idle with no steps", () => {
    const { container } = render(<Steps steps={[]} running={false} phase={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("has no toggle until there are steps, and no orb once the turn is over", () => {
    const { container, rerender } = render(<Steps steps={[]} running phase={phase("thinking")} />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<Steps steps={[step("a")]} running={false} phase={null} />);
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.getByRole("button", { name: /Used 1 tool/ })).toBeTruthy();
  });

  it("while running with steps the list is open and the toggle shows no 'Used' text", () => {
    render(<Steps steps={[step("a"), step("b")]} running phase={phase("reading")} />);
    const t = screen.getByRole("button", { name: /Hide steps/ });
    expect(t.getAttribute("aria-expanded")).toBe("true");
    expect(t.textContent).not.toMatch(/Used/);
    expect(screen.getByText("Read a")).toBeTruthy();
  });

  it("after the turn it collapses to 'Used N tools' and expands on click", () => {
    const { container } = render(<Steps steps={[step("a"), step("b"), step("c")]} running={false} phase={null} />);
    const t = screen.getByRole("button", { name: /Used 3 tools/ });
    expect(t.textContent).toContain("Used 3 tools");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(t.getAttribute("aria-controls")!)!;
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(panel.className).toContain("grid-rows-[0fr]");
    fireEvent.click(t);
    expect(t.getAttribute("aria-expanded")).toBe("true");
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    expect(panel.className).toContain("grid-rows-[1fr]");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(t);
    expect(t.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses by itself when the turn finishes", () => {
    const steps = [step("a"), step("b")];
    const { rerender } = render(<Steps steps={steps} running phase={phase("reading")} />);
    expect(screen.getByRole("button", { name: /Hide steps/ }).getAttribute("aria-expanded")).toBe("true");
    rerender(<Steps steps={steps} running={false} phase={null} />);
    const t = screen.getByRole("button", { name: /Used 2 tools/ });
    expect(t.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a list the user collapsed during the run collapsed", () => {
    render(<Steps steps={[step("a")]} running phase={phase("reading")} />);
    fireEvent.click(screen.getByRole("button", { name: /Hide steps/ }));
    expect(screen.getByRole("button", { name: /Show steps/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("uses singular 'tool' for one and counts failures", () => {
    const { rerender } = render(<Steps steps={[step("a")]} running={false} phase={null} />);
    expect(screen.getByRole("button").textContent).toContain("Used 1 tool");
    expect(screen.getByRole("button").textContent).not.toContain("tools");
    rerender(<Steps steps={[step("a"), step("b", { status: "error" }), step("c", { status: "error" })]} running={false} phase={null} />);
    expect(screen.getByRole("button").textContent).toContain("Used 3 tools, 2 failed");
  });

  it("shows each step's label and tool name, and a failed step in the error colour", () => {
    render(<Steps steps={[step("a", { name: "get_list", label: "Read the VIP list" }), step("b", { status: "error", label: "Could not read lists" })]} running={false} phase={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Used 2 tools/ }));
    expect(screen.getByText("get_list")).toBeTruthy();
    expect(screen.getByText("Read the VIP list").className).toContain("text-fg");
    expect(screen.getByText("Could not read lists").className).toContain("text-bad");
  });

  it("a step with detail is a toggle that reveals the detail; one without is plain text", () => {
    render(<Steps steps={[step("a", { detail: "3 templates found" }), step("b")]} running={false} phase={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Used 2 tools/ }));
    const row = screen.getByRole("button", { name: /Read a/ });
    expect(screen.queryByText("3 templates found")).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("3 templates found")).toBeTruthy();
    fireEvent.click(row);
    expect(screen.queryByText("3 templates found")).toBeNull();
    expect(screen.queryByRole("button", { name: /Read b/ })).toBeNull();
  });

  it("detail rows are not tabbable while the list is collapsed", () => {
    render(<Steps steps={[step("a", { detail: "d" })]} running={false} phase={null} />);
    const row = screen.getByRole("button", { name: /Read a/, hidden: true });
    expect(row.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(screen.getByRole("button", { name: /Used 1 tool/ }));
    expect(screen.getByRole("button", { name: /Read a/ }).getAttribute("tabindex")).toBe("0");
  });
});

/* ------------------------------------------------------------------ Composer */

describe("token", () => {
  it("reads a /command only at the very start", () => {
    expect(token("/", 1)).toEqual({ kind: "slash", query: "", start: 0 });
    expect(token("/fix", 4)).toEqual({ kind: "slash", query: "fix", start: 0 });
    expect(token("/Fix-Template", 13)).toEqual({ kind: "slash", query: "fix-template", start: 0 });
    expect(token("hello /fix", 10)).toBeNull();
    expect(token(" /fix", 5)).toBeNull();
  });

  it("closes the slash menu once a space or other character follows the command word", () => {
    expect(token("/fix template", 13)).toBeNull();
    expect(token("/fix!", 5)).toBeNull();
  });

  it("reads an @mention at the start or after whitespace", () => {
    expect(token("@", 1)).toEqual({ kind: "at", query: "", start: 0 });
    expect(token("hi @tem", 7)).toEqual({ kind: "at", query: "tem", start: 3 });
    expect(token("a\n@b", 4)).toEqual({ kind: "at", query: "b", start: 2 });
    expect(token("a\t@B", 4)).toEqual({ kind: "at", query: "b", start: 2 });
  });

  it("allows the typed type: prefix, dots, dashes and colons in a mention", () => {
    expect(token("@template:welcome-v2.1", 22)).toEqual({ kind: "at", query: "template:welcome-v2.1", start: 0 });
  });

  it("does not treat an @ glued to a word (an email address) as a mention", () => {
    expect(token("ann@example", 11)).toBeNull();
    expect(token("hi@tem", 6)).toBeNull();
  });

  it("stops at the caret: text after it is ignored, and a caret past the word ends it", () => {
    expect(token("/fix more", 4)).toEqual({ kind: "slash", query: "fix", start: 0 });
    expect(token("/fix more", 9)).toBeNull();
    expect(token("hi @te there", 6)).toEqual({ kind: "at", query: "te", start: 3 });
    expect(token("hi @te there", 12)).toBeNull();
  });

  it("is null for plain text and for an empty draft", () => {
    expect(token("", 0)).toBeNull();
    expect(token("just text", 9)).toBeNull();
    expect(token("1/2", 3)).toBeNull();
  });
});

const MENTIONS = { template: ["welcome", "receipt"], list: ["vip"], automation: ["onboarding"] };

function media(reduce: boolean, dark: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduced-motion") ? reduce : q.includes("dark") ? dark : false, media: q, addEventListener() {}, removeEventListener() {} }));
}

type Extra = Partial<ComponentProps<typeof Composer>> & { initial?: string; outer?: (e: unknown) => void };
function Harness({ initial = "", outer, ...p }: Extra) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div onKeyDown={outer}>
      <Composer busy={false} onSend={() => {}} onStop={() => {}} {...p} draft={draft} setDraft={setDraft} inputRef={ref} />
    </div>
  );
}
const box = () => screen.getByRole("textbox", { name: "Message the assistant" }) as HTMLTextAreaElement;
const typeIn = (value: string) => fireEvent.change(box(), { target: { value } });

describe("Composer", () => {
  beforeEach(() => {
    media(false, false);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => MENTIONS })));
  });

  describe("slash menu", () => {
    it("opens on '/', listing every command, and closes on plain text", () => {
      render(<Harness />);
      expect(screen.queryByRole("listbox")).toBeNull();
      typeIn("/");
      const lb = screen.getByRole("listbox", { name: "Commands" });
      expect(within(lb).getAllByRole("option").map((o) => o.querySelector("span")!.textContent)).toEqual(COMMANDS.map((c) => c.label));
      typeIn("hello");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("filters by prefix of the command key", () => {
      render(<Harness />);
      typeIn("/b");
      expect(screen.getAllByRole("option").map((o) => o.querySelector("span")!.textContent)).toEqual(["/broadcast", "/bounce"]);
      typeIn("/fix");
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });

    it("says 'No matches' (and has no listbox) when nothing fits", () => {
      render(<Harness />);
      typeIn("/zzz");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(screen.getByText("No matches")).toBeTruthy();
    });

    it("starts on the first option; ArrowDown moves the highlight and aria-activedescendant", () => {
      render(<Harness />);
      typeIn("/");
      const opts = () => screen.getAllByRole("option");
      expect(opts()[0].getAttribute("aria-selected")).toBe("true");
      expect(box().getAttribute("aria-activedescendant")).toBe(opts()[0].id);
      fireEvent.keyDown(box(), { key: "ArrowDown" });
      expect(opts().map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false", "false"]);
      expect(box().getAttribute("aria-activedescendant")).toBe(opts()[1].id);
    });

    it("ArrowDown then Enter inserts the second command's text and sends nothing", async () => {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} />);
      typeIn("/");
      fireEvent.keyDown(box(), { key: "ArrowDown" });
      fireEvent.keyDown(box(), { key: "Enter" });
      expect(box().value).toBe(COMMANDS[1].insert);
      expect(onSend).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    });

    it("ArrowUp wraps from the first option to the last, ArrowDown from the last to the first", () => {
      render(<Harness />);
      typeIn("/");
      fireEvent.keyDown(box(), { key: "ArrowUp" });
      expect(screen.getAllByRole("option")[COMMANDS.length - 1].getAttribute("aria-selected")).toBe("true");
      fireEvent.keyDown(box(), { key: "ArrowDown" });
      expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    });

    it("Enter and Tab are both swallowed by the menu (default prevented)", () => {
      render(<Harness />);
      typeIn("/");
      expect(fireEvent.keyDown(box(), { key: "Tab" })).toBe(false);
      expect(box().value).toBe(COMMANDS[0].insert);
    });

    it("clicking an option inserts it", () => {
      render(<Harness />);
      typeIn("/");
      fireEvent.click(screen.getByRole("option", { name: /\/bounce/ }));
      expect(box().value).toBe(COMMANDS[4].insert);
    });

    it("resets the highlight to the first option when the query changes", () => {
      render(<Harness />);
      typeIn("/");
      fireEvent.keyDown(box(), { key: "ArrowDown" });
      fireEvent.keyDown(box(), { key: "ArrowDown" });
      typeIn("/b");
      expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    });

    it("announces the number of suggestions", () => {
      render(<Harness />);
      typeIn("/b");
      expect(screen.getByText("2 suggestions, use the arrow keys")).toBeTruthy();
      typeIn("/fix");
      expect(screen.getByText("1 suggestion, use the arrow keys")).toBeTruthy();
    });
  });

  describe("@ menu", () => {
    it("opens on '@', loads the mentions, and lists templates, then lists, then automations", async () => {
      render(<Harness />);
      typeIn("@");
      const opts = await screen.findAllByRole("option");
      expect(screen.getByRole("listbox", { name: "Mentions" })).toBeTruthy();
      expect(opts.map((o) => o.textContent)).toEqual(["welcometemplate", "receipttemplate", "viplist", "onboardingautomation"]);
      // the mentions list is cached at module level, so the fetch may have happened in an earlier test: only its URL is checked
      for (const [url] of vi.mocked(fetch).mock.calls) expect(url).toBe("/api/assistant/mentions");
    });

    it("ArrowDown then Enter inserts @type:name and keeps the text before it", async () => {
      render(<Harness />);
      typeIn("Send @");
      await screen.findAllByRole("option");
      fireEvent.keyDown(box(), { key: "ArrowDown" });
      fireEvent.keyDown(box(), { key: "Enter" });
      expect(box().value).toBe("Send @template:receipt ");
      await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    });

    it("filters by substring, ignoring a typed type: prefix", async () => {
      render(<Harness />);
      typeIn("@list:v");
      const opts = await screen.findAllByRole("option");
      expect(opts.map((o) => o.textContent)).toEqual(["viplist"]);
      typeIn("@ON");
      expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["onboardingautomation"]);
    });

    it("does not open for an @ inside a word (an email address)", () => {
      render(<Harness />);
      typeIn("ann@exam");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(screen.queryByText("No matches")).toBeNull();
    });

    it("stays closed when the caret is before the @", () => {
      render(<Harness initial="hi @te" />);
      box().setSelectionRange(2, 2);
      fireEvent.select(box());
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });

  describe("Escape", () => {
    it("closes only the menu: the draft stays and the event does not reach parents", () => {
      const outer = vi.fn();
      render(<Harness outer={outer} />);
      typeIn("/");
      expect(screen.getByRole("listbox")).toBeTruthy();
      const notPrevented = fireEvent.keyDown(box(), { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(box().value).toBe("/");
      expect(notPrevented).toBe(false);
      expect(outer).not.toHaveBeenCalled();
    });

    it("also closes the 'No matches' note, and typing again brings the menu back", () => {
      render(<Harness />);
      typeIn("/zzz");
      fireEvent.keyDown(box(), { key: "Escape" });
      expect(screen.queryByText("No matches")).toBeNull();
      typeIn("/zzzz");
      expect(screen.getByText("No matches")).toBeTruthy();
    });

    it("with no menu open, Escape is left alone so the panel can close", () => {
      const outer = vi.fn();
      render(<Harness outer={outer} initial="hello" />);
      expect(fireEvent.keyDown(box(), { key: "Escape" })).toBe(true);
      expect(outer).toHaveBeenCalledTimes(1);
    });

    it("after Escape, Enter sends the draft instead of picking from the closed menu", () => {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} />);
      typeIn("/fix");
      fireEvent.keyDown(box(), { key: "Escape" });
      fireEvent.keyDown(box(), { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith("/fix");
    });
  });

  describe("sending", () => {
    it("Enter sends the draft and clears it", () => {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} />);
      typeIn("hello there");
      expect(fireEvent.keyDown(box(), { key: "Enter" })).toBe(false);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith("hello there");
      expect(box().value).toBe("");
    });

    it("Shift+Enter neither sends nor is prevented (it types a newline)", () => {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} />);
      typeIn("hello");
      expect(fireEvent.keyDown(box(), { key: "Enter", shiftKey: true })).toBe(true);
      expect(onSend).not.toHaveBeenCalled();
      expect(box().value).toBe("hello");
    });

    it("Enter while an IME is composing does not send", () => {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} />);
      typeIn("こんにちは");
      fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
      expect(onSend).not.toHaveBeenCalled();
    });

    it("does not send an empty or whitespace-only draft", () => {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} />);
      fireEvent.keyDown(box(), { key: "Enter" });
      typeIn("  \n ");
      fireEvent.keyDown(box(), { key: "Enter" });
      expect(onSend).not.toHaveBeenCalled();
    });

    it("does not send while a turn is running, and keeps the draft", () => {
      const onSend = vi.fn();
      render(<Harness busy onSend={onSend} initial="queued thought" />);
      fireEvent.keyDown(box(), { key: "Enter" });
      expect(onSend).not.toHaveBeenCalled();
      expect(box().value).toBe("queued thought");
    });

    it("the Send button is disabled for an empty draft and sends on click otherwise", () => {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} />);
      const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      typeIn("hi");
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      expect(onSend).toHaveBeenCalledWith("hi");
    });

    it("while busy the Send button is replaced by Stop, which calls onStop", () => {
      const onStop = vi.fn();
      render(<Harness busy onStop={onStop} />);
      expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("a disabled composer does not send", () => {
      const onSend = vi.fn();
      render(<Harness disabled onSend={onSend} initial="hi" />);
      expect(box().disabled).toBe(true);
      fireEvent.keyDown(box(), { key: "Enter" });
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe("border beam", () => {
    const beam = () => screen.getByTestId("beam");

    it("is the line style around the form", () => {
      render(<Harness />);
      expect(beam().getAttribute("data-size")).toBe("line");
      expect(beam().contains(box())).toBe(true);
    });

    it("is inactive when idle and active while busy", () => {
      const { rerender } = render(<Harness />);
      expect(beam().getAttribute("data-active")).toBe("false");
      rerender(<Harness busy />);
      expect(beam().getAttribute("data-active")).toBe("true");
      expect(beam().getAttribute("data-size")).toBe("line");
      rerender(<Harness busy={false} />);
      expect(beam().getAttribute("data-active")).toBe("false");
    });

    it("stays off under prefers-reduced-motion even while busy", () => {
      media(true, false);
      render(<Harness busy />);
      expect(beam().getAttribute("data-active")).toBe("false");
    });

    it("follows the page theme: the explicit data-theme, else the OS setting", () => {
      const { unmount } = render(<Harness busy />);
      expect(beam().getAttribute("data-theme")).toBe("light");
      unmount();
      media(false, true);
      const second = render(<Harness busy />);
      expect(beam().getAttribute("data-theme")).toBe("dark");
      second.unmount();
      media(false, true);
      document.documentElement.dataset.theme = "light";
      render(<Harness busy />);
      expect(beam().getAttribute("data-theme")).toBe("light");
    });
  });

  it("labels the textbox, wires the combobox attributes, and shows the model chip", () => {
    render(<Harness model="meta-llama/llama-3.3-70b-instruct:free" />);
    expect(box().getAttribute("aria-autocomplete")).toBe("list");
    expect(box().getAttribute("aria-haspopup")).toBe("listbox");
    expect(box().hasAttribute("aria-controls")).toBe(false);
    typeIn("/");
    expect(box().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(screen.getByText("llama-3.3-70b-instruct · free")).toBeTruthy();
  });

  it("falls back to 'free model' when no model is known", () => {
    render(<Harness />);
    expect(screen.getByText("free model · free")).toBeTruthy();
  });
});
