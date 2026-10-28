import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/automations/actions", () => ({ saveAutomation: vi.fn(async () => ({})), runDetail: vi.fn(), startTestRun: vi.fn(), archiveAutomation: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { Editor } from "@/app/(app)/automations/editor/Editor";
import { presetById } from "@/app/(app)/automations/editor/presets";
import { FlowView } from "@/app/(app)/automations/flow/FlowView";
import { Flowchart } from "@/app/(app)/automations/flow/Flowchart";
import { buildFlow } from "@/app/(app)/automations/flow/flow";
import { StepFlow } from "@/app/(app)/automations/[id]/StepFlow";

// Radix's ToggleGroup and Switch measure with ResizeObserver; jsdom has neither it nor scrollIntoView.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const scrollIntoView = vi.fn();
Element.prototype.scrollIntoView = scrollIntoView;

const stat = (entered: number, active: number, completed: number, exited: number, failed: number) => ({ entered, active, completed, exited, failed });
const automation = {
  trigger: { event: "signed_up" },
  steps: [
    { key: "start", type: "trigger", config: { event: "signed_up" }, next: "mail" },
    { key: "mail", type: "send_email", config: { template: "welcome", mode: "llm", from: "hello@example.com" }, next: "check" },
    { key: "check", type: "condition", config: { rule: { field: "contact.plan", op: "eq", value: "free" } }, next: { true: "nudge", false: "end" } },
    { key: "nudge", type: "send_email", config: { template: "winback", mode: "static" }, next: "end" },
    { key: "end", type: "exit", config: { reason: "done" } },
  ],
};
const stats = { start: stat(10, 0, 10, 0, 0), mail: stat(10, 1, 7, 0, 2), check: stat(7, 0, 7, 0, 0), nudge: stat(4, 0, 4, 0, 0), end: stat(7, 0, 7, 0, 0) };
const media = (matches: (q: string) => boolean) => { window.matchMedia = ((q: string) => ({ matches: matches(q), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia; };
const view = () => render(<FlowView automation={automation} stats={stats} steps={<StepFlow automation={automation} slots={{}} stats={stats} />} />);
const nodes = (bs: HTMLElement[]) => bs.map((b) => b.getAttribute("data-node")).filter(Boolean); // the zoom buttons have none
const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLButtonElement;

beforeEach(() => { localStorage.clear(); scrollIntoView.mockClear(); delete (window as any).matchMedia; });
afterEach(cleanup);

describe("Flowchart", () => {
  it("makes every step a button with its full text, in reading order, and describes where it leads and its counts", () => {
    render(<Flowchart graph={buildFlow(automation, stats)} />);
    const list = screen.getByRole("list", { name: /Steps, in the order/ });
    const buttons = within(list).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("data-node"))).toEqual(["start", "mail", "check", "nudge", "end"]); // Yes branch before No
    const mail = buttons[1];
    expect(mail.textContent).toContain("Send email, AI-written.");
    expect(mail.textContent).toContain("welcome");
    expect(mail.textContent).toContain("From hello@example.com");
    const desc = (b: HTMLElement) => b.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent).join(" ");
    expect(desc(mail)).toContain("10 entered, 1 active, 7 completed, 2 failed, 0 exited.");
    expect(desc(buttons[2])).toContain("Yes: Send email winback. No: Run ends.");
    // the failing step is marked by more than colour: the word and a count
    expect(within(mail).getByText("Failed").parentElement!.textContent).toContain("2");
  });

  it("draws a missing branch as a 'Run ends' item that is not a button", () => {
    const g = buildFlow({ steps: [{ key: "t", type: "trigger", config: { event: "x" }, next: "w" }, { key: "w", type: "wait_for_event", config: { event: "y", timeout: "1d" }, next: { timeout: "m" } }, { key: "m", type: "delay", config: { duration: "1d" } }] });
    render(<Flowchart graph={g} />);
    expect(nodes(screen.getAllByRole("button"))).toEqual(["t", "w", "m"]);
    expect(screen.getByText("Run ends")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Run ends/ })).toBeNull();
  });

  it("calls onSelect with the step key on click, and shows no counts without stats", () => {
    const onSelect = vi.fn();
    render(<Flowchart graph={buildFlow(automation)} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /winback/ }));
    expect(onSelect).toHaveBeenCalledWith("nudge");
    expect(screen.queryByText("Entered")).toBeNull();
  });

  it("zooms with the buttons and returns to fit", () => {
    render(<Flowchart graph={buildFlow(automation)} />);
    const pct = () => screen.getByText(/%$/).textContent;
    expect(pct()).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(pct()).toBe("80%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(pct()).toBe("125%");
    fireEvent.click(screen.getByRole("button", { name: "Fit to width" }));
    expect(pct()).toBe("100%");
  });
});

describe("Flowchart accessibility details", () => {
  it("keeps focus on a zoom button that has reached its limit, and does not say a kind twice", () => {
    render(<Flowchart graph={buildFlow({ steps: [{ key: "t", type: "trigger", config: { event: "x" }, next: "d" }, { key: "d", type: "delay", config: { duration: "2d" } }] })} />);
    const out = screen.getByRole("button", { name: "Zoom out" });
    out.focus();
    for (let i = 0; i < 6; i++) fireEvent.click(out); // 100% down to the 40% floor
    expect(screen.getByText(/%$/).textContent).toBe("40%");
    expect(out.getAttribute("aria-disabled")).toBe("true");
    expect(out.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(out);
    fireEvent.click(out); // a click at the limit does nothing
    expect(screen.getByText(/%$/).textContent).toBe("40%");
    const wait = screen.getByRole("button", { name: /Wait 2 days/ });
    expect(wait.textContent).toContain("Wait 2 days");
    expect(wait.textContent?.match(/Wait/g)).toHaveLength(1);
  });
});

describe("FlowView toggle", () => {
  it("shows the flow by default on a wide screen, and switches to the steps and remembers it", () => {
    media((q) => q.includes("1024"));
    view();
    expect(radio("Flow").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("list", { name: /Steps, in the order/ })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Automation steps" })).toBeNull();
    fireEvent.click(radio("Steps"));
    expect(screen.getByRole("list", { name: "Automation steps" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: /Steps, in the order/ })).toBeNull();
    expect(radio("Steps").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("mc_automation_view")).toBe("steps");
  });

  it("starts on the steps below 1024px, without saving that as a choice", () => {
    media(() => false);
    view();
    expect(radio("Steps").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("list", { name: "Automation steps" })).toBeTruthy();
    expect(localStorage.getItem("mc_automation_view")).toBeNull();
  });

  it("honours a remembered 'steps' everywhere, a remembered 'flow' only on a wide screen, and ignores junk", () => {
    media(() => false);
    localStorage.setItem("mc_automation_view", "flow");
    view();
    expect(radio("Steps").getAttribute("aria-checked")).toBe("true"); // phones get the list whatever a desktop saved
    cleanup();
    media((q) => q.includes("1024"));
    view();
    expect(radio("Flow").getAttribute("aria-checked")).toBe("true");
    cleanup();
    localStorage.setItem("mc_automation_view", "steps");
    view();
    expect(radio("Steps").getAttribute("aria-checked")).toBe("true");
    cleanup();
    localStorage.setItem("mc_automation_view", "sideways");
    view();
    expect(radio("Flow").getAttribute("aria-checked")).toBe("true");
  });

  it("works when storage is blocked", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    media((q) => q.includes("1024"));
    view();
    fireEvent.click(radio("Steps"));
    expect(screen.getByRole("list", { name: "Automation steps" })).toBeTruthy();
    get.mockRestore(); set.mockRestore();
  });

  it("opens the step you click in the list: switches to it, scrolls there and focuses it", () => {
    media((q) => q.includes("1024"));
    view();
    fireEvent.click(screen.getByRole("button", { name: /From hello@example.com/ }));
    const li = document.getElementById("step-mail")!;
    expect(screen.getByRole("list", { name: "Automation steps" })).toBeTruthy();
    expect(li).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(document.activeElement).toBe(li);
    expect(localStorage.getItem("mc_automation_view")).toBeNull(); // a jump is not a preference
    // the target is named, and the move is announced
    expect(li.getAttribute("aria-label")).toBe("Send email mail");
    expect(screen.getByRole("status").textContent).toBe("Showing Send email welcome in the step list.");
  });

  it("does not animate the jump when reduced motion is asked for", () => {
    media((q) => q.includes("1024") || q.includes("reduce"));
    view();
    fireEvent.click(screen.getByRole("button", { name: /winback/ }));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
  });
});

describe("editor preview", () => {
  const options = { templates: [], segments: [], events: [], senders: [] };
  const draft = () => presetById("nudge")!.build(["winback"]);

  it("is not rendered below 1400px", () => {
    media(() => false);
    render(<Editor mode="new" initial={draft()} options={options} />);
    expect(screen.queryByRole("region", { name: "Flow preview" })).toBeNull();
  });

  it("draws the draft beside the form, follows edits, and a click jumps to that step's card", async () => {
    media((q) => q.includes("1400"));
    render(<Editor mode="new" initial={draft()} options={options} />);
    const preview = screen.getByRole("region", { name: "Flow preview" });
    expect(nodes(within(preview).getAllByRole("button"))).toEqual(["trigger", "wait_event_1", "email_1"]);
    expect(within(preview).getByText("Run ends")).toBeTruthy(); // the "event" outcome ends the run
    // an edit shows up
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "trial_started" } });
    expect(within(preview).getByRole("button", { name: /trial_started/ })).toBeTruthy();
    // a click lands on the step's own card
    fireEvent.click(within(preview).getByRole("button", { name: /Wait for event/ }));
    const card = document.getElementById("step-wait_event_1")!;
    expect(card.tagName).toBe("ARTICLE");
    expect(document.activeElement).toBe(card);
    fireEvent.click(within(preview).getByRole("button", { name: /Trigger/ }));
    expect(document.activeElement).toBe(document.getElementById("step-trigger"));
    await act(async () => {});
  });
});
