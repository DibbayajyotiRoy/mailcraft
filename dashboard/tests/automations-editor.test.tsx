import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveAutomation = vi.fn(async (_p: unknown, _d: FormData): Promise<{ error?: any }> => ({}));
const runDetail = vi.fn();
const startTestRun = vi.fn();
vi.mock("@/app/(app)/automations/actions", () => ({
  saveAutomation: (p: unknown, d: FormData) => saveAutomation(p, d), runDetail: (a: string, r: string) => runDetail(a, r), startTestRun: (p: unknown, d: FormData) => startTestRun(p, d), archiveAutomation: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { Editor } from "@/app/(app)/automations/editor/Editor";
import { fromAutomation } from "@/app/(app)/automations/editor/model";
import { presetById } from "@/app/(app)/automations/editor/presets";
import { RunsTable } from "@/app/(app)/automations/[id]/RunsTable";
import { RunProgress } from "@/app/(app)/automations/[id]/RunProgress";
import { TestRun } from "@/app/(app)/automations/[id]/TestRun";
import { StepFlow } from "@/app/(app)/automations/[id]/StepFlow";

// Radix's Switch / ToggleGroup measure with ResizeObserver, which jsdom does not have.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const options = {
  templates: [{ id: "11111111-1111-4111-8111-111111111111", alias: "welcome", name: "Welcome", published: true }, { id: "22222222-2222-4222-8222-222222222222", alias: "winback", name: "Win-back", published: false }],
  segments: ["vip"], events: ["signed_up", "logged_in"], senders: ["hello@example.com"],
};
const names = () => screen.getAllByRole("article").map((a) => a.getAttribute("aria-label")).filter((l) => l?.startsWith("step"));

beforeEach(() => { saveAutomation.mockClear(); runDetail.mockReset(); startTestRun.mockReset(); });
afterEach(cleanup);

describe("automation editor", () => {
  it("lists the steps in order with the trigger first", () => {
    render(<Editor mode="new" initial={presetById("nudge")!.build(["winback"])} options={options} />);
    expect(names()).toEqual(["step 1, Wait for event", "step 2, Send email"]);
    expect(screen.getByRole("heading", { name: "Trigger" })).toBeTruthy();
    expect((screen.getByLabelText("Event name") as HTMLInputElement).value).toBe("signed_up");
  });

  it("moves a step with the buttons, announces it and keeps focus on a move button", async () => {
    render(<Editor mode="new" initial={presetById("nudge")!.build([])} options={options} />);
    const up1 = screen.getByRole("button", { name: "Move step 1, Wait for event up" }) as HTMLButtonElement;
    expect(up1.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move step 1, Wait for event down" }));
    expect(names()).toEqual(["step 1, Send email", "step 2, Wait for event"]);
    expect(document.body.textContent).toContain("Moved Wait for activated to step 2 of 2.");
    await waitFor(() => expect((document.activeElement as HTMLElement).getAttribute("data-move")).toMatch(/^wait_event_1:/));
    expect((screen.getByRole("button", { name: "Move step 2, Wait for event down" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("deletes a step", () => {
    render(<Editor mode="new" initial={presetById("nudge")!.build([])} options={options} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete step 2, Send email" }));
    expect(names()).toEqual(["step 1, Wait for event"]);
  });

  it("will not submit with problems, and shows them where they are", () => {
    render(<Editor mode="new" initial={presetById("welcome")!.build([])} options={options} />);
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    expect(saveAutomation).not.toHaveBeenCalled();
    expect(within(screen.getByRole("article", { name: "step 1, Send email" })).getByText("Choose a template.")).toBeTruthy();
    expect(screen.getByText("1 thing to fix before saving.")).toBeTruthy();
  });

  it("submits the definition and the chosen intent once it is valid", async () => {
    render(<Editor mode="new" initial={presetById("welcome")!.build([])} options={options} />);
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "welcome" } });
    expect((screen.getByRole("option", { name: /winback/ }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await waitFor(() => expect(saveAutomation).toHaveBeenCalledTimes(1));
    const fd = saveAutomation.mock.calls[0][1];
    expect(fd.get("intent")).toBe("publish");
    expect(JSON.parse(String(fd.get("definition")))).toMatchObject({ name: "welcome", steps: [{ type: "trigger", config: { event: "signed_up" } }, { type: "send_email", config: { template: "welcome" } }] });
  });

  it("puts an API refusal on the step it names and keeps everything typed", async () => {
    saveAutomation.mockResolvedValueOnce({ error: { code: "invalid_request", message: "automation `welcome`: step `email_1`: template `welcome` does not exist or has no published version", hint: "Publish the template first." } });
    render(<Editor mode="new" initial={presetById("welcome")!.build(["welcome"])} options={options} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    const step = await screen.findByRole("article", { name: "step 1, Send email" });
    await waitFor(() => expect(within(step).getByRole("alert").textContent).toContain("does not exist"));
    expect(screen.getByText(/Publish the template first/)).toBeTruthy();
    expect((screen.getByLabelText("Event name") as HTMLInputElement).value).toBe("signed_up");
  });

  it("AI writing: guidance appears with the switch and counts characters", () => {
    render(<Editor mode="new" initial={presetById("welcome")!.build(["welcome"])} options={options} />);
    expect(screen.queryByLabelText("Writing guidance for this step")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: /Write with AI/ }));
    fireEvent.change(screen.getByLabelText("Writing guidance for this step"), { target: { value: "Be brief." } });
    expect(screen.getByText(/9 \/ 1,000/)).toBeTruthy();
  });

  it("editing a live automation keeps the name fixed and asks before saving a new version", async () => {
    const live = { name: "welcome", status: "active", current_version: 2, steps: [{ key: "t", type: "trigger", config: { event: "signed_up" }, next: "m" }, { key: "m", type: "send_email", config: { template: "welcome" } }] };
    render(<Editor mode="edit" id="a1" status="active" version={2} initial={fromAutomation(live)} options={options} stats={{ m: { entered: 10, active: 2, completed: 7, exited: 1, failed: 0 } }} />);
    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByRole("note").textContent).toContain("version 3");
    const step = screen.getByRole("article", { name: "step 1, Send email" });
    expect(within(step).getByText("Entered").nextSibling?.textContent).toBe("10");
    fireEvent.click(screen.getByRole("button", { name: "Save new version" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("finish on version 2");
    expect(saveAutomation).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save new version" }));
    await waitFor(() => expect(saveAutomation).toHaveBeenCalledTimes(1));
    expect(saveAutomation.mock.calls[0][1].get("intent")).toBe("save");
  });

  it("a step that names its template by id shows the alias and keeps working", async () => {
    const byId = { name: "b", steps: [{ key: "t", type: "trigger", config: { event: "e" }, next: "m" }, { key: "m", type: "send_email", config: { template: "11111111-1111-4111-8111-111111111111" } }] };
    render(<Editor mode="edit" id="b" status="draft" version={1} initial={fromAutomation(byId)} options={options} />);
    expect((screen.getByLabelText("Template") as HTMLSelectElement).value).toBe("welcome");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(saveAutomation).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(saveAutomation.mock.calls[0][1].get("definition"))).steps[1].config.template).toBe("11111111-1111-4111-8111-111111111111");
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "welcome" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(saveAutomation).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(saveAutomation.mock.calls[1][1].get("definition"))).steps[1].config.template).toBe("welcome");
  });

  it("a branch step offers only forward targets", () => {
    const a = { name: "b", steps: [
      { key: "t", type: "trigger", config: { event: "e" }, next: "c" },
      { key: "c", type: "condition", config: { rule: { field: "contact.plan", op: "eq", value: "free" } }, next: { true: "x", false: "z" } },
      { key: "x", type: "delay", config: { duration: "1d" }, next: "z" },
      { key: "z", type: "exit" },
    ] };
    render(<Editor mode="new" initial={fromAutomation(a)} options={options} />);
    const no = screen.getByLabelText("If no") as HTMLSelectElement;
    expect(no.value).toBe("to:z");
    expect([...no.options].map((o) => o.textContent)).toEqual(["Continue to step 2: Wait 1d", "End the journey", "Jump to step 3: End"]);
  });
});

describe("run views", () => {
  const detail = { id: "r1", state: "waiting", current_step: "w", next_wake_at: "2099-01-01T00:00:00Z", started_at: "2026-10-28T10:00:00Z", contact_email: "you@example.com", test: true, steps: [
    { step_key: "m", result: { decision: "enqueued", email_id: "em_9", status: "queued", subject: "Welcome aboard" }, at: "2026-10-28T10:00:01Z" },
    { step_key: "w", result: { waiting_for: "activated", until: "2099-01-01T00:00:00Z" }, at: "2026-10-28T10:00:02Z" },
  ] };

  it("RunProgress shows the log with a link to the email it queued", async () => {
    runDetail.mockResolvedValue({ data: detail, error: null });
    render(<RunProgress automation="a1" run="r1" types={{ m: "send_email", w: "wait_for_event" }} />);
    await screen.findByRole("list", { name: "Run log" });
    expect(screen.getByText("test run")).toBeTruthy();
    expect(screen.getByText(/Email queued: “Welcome aboard”/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "view" }).getAttribute("href")).toBe("/emails/em_9");
    expect(screen.getByText(/Waiting for “activated”/)).toBeTruthy();
    expect(runDetail).toHaveBeenCalledTimes(1); // parked on a timer: no more polling
  });

  it("RunProgress surfaces an API error with a retry", async () => {
    runDetail.mockResolvedValue({ data: null, error: { code: "not_found", message: "run not found" } });
    render(<RunProgress automation="a1" run="r1" types={{}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("run not found");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("Test run explains the key: sandbox for a test key, a confirmation for a live one", async () => {
    const { unmount } = render(<TestRun id="a1" name="welcome" env="test" liveEnabled={false} contacts={["ana@example.com"]} types={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    expect((await screen.findByRole("note")).textContent).toContain("nothing is delivered");
    expect(screen.queryByLabelText(/I understand/)).toBeNull();
    unmount();
    render(<TestRun id="a1" name="welcome" env="live" liveEnabled contacts={[]} types={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    expect((await screen.findByRole("note")).textContent).toContain("real email");
    expect((screen.getByLabelText(/I understand/) as HTMLInputElement).required).toBe(true);
  });

  it("RunsTable reads the API's state/contact_email/ended_at and marks test runs", () => {
    render(<RunsTable id="a1" types={{}} runs={[{ id: "run_1111111111111111", state: "exited", contact_email: "ana@example.com", started_at: "2026-10-28T10:00:00Z", ended_at: "2026-10-28T12:00:00Z", test: true, exit_reason: "goal" }]} />);
    expect(screen.getByText("ana@example.com")).toBeTruthy();
    expect(screen.getByText("exited")).toBeTruthy();
    expect(screen.getByText("test")).toBeTruthy();
    expect(screen.getByText("goal")).toBeTruthy();
    expect(screen.getByText("2h")).toBeTruthy();
    expect(screen.getByRole("button", { name: /View run ana@example.com/ })).toBeTruthy();
  });

  it("StepFlow shows per-step counts when given stats", () => {
    const a = { steps: [{ key: "t", type: "trigger", config: { event: "e" }, next: "d" }, { key: "d", type: "delay", config: { duration: "1d" } }] };
    render(<StepFlow automation={a} slots={{}} stats={{ t: { entered: 5, active: 0, completed: 5, exited: 0, failed: 0 }, d: { entered: 5, active: 2, completed: 2, exited: 0, failed: 1 } }} />);
    const groups = screen.getAllByRole("group", { name: "Contacts at this step" });
    expect(groups).toHaveLength(2);
    expect(within(groups[1]).getByText("Failed").nextSibling?.textContent).toBe("1");
  });
});
