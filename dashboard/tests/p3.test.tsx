import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const automationState = vi.fn(async (_fd: FormData) => {});
vi.mock("@/lib/actions", () => ({ automationState: (fd: FormData) => automationState(fd), importTemplate: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/templates/actions", () => ({ publishTemplate: vi.fn() }));

import { AutomationToggle, nextAction } from "@/app/(app)/automations/AutomationToggle";
import { StepFlow } from "@/app/(app)/automations/[id]/StepFlow";
import { RunsTable, duration } from "@/app/(app)/automations/[id]/RunsTable";
import { AutomationsList } from "@/app/(app)/automations/AutomationsList";
import { ruleWords } from "@/lib/rules";
import { validateImport } from "@/app/(app)/templates/ImportTemplate";
import { TemplatesView } from "@/app/(app)/templates/TemplatesView";
import { templateVariables, lintSummary } from "@/app/(app)/templates/[id]/util";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ContactsView } from "@/app/(app)/contacts/ContactsView";
import { segmentRule } from "@/app/(app)/contacts/util";

beforeEach(() => automationState.mockClear());

describe("automation state machine", () => {
  it("maps each status to the right transition", () => {
    expect(nextAction("draft")).toBe("publish");
    expect(nextAction("active")).toBe("pause");
    expect(nextAction("paused")).toBe("resume");
  });
  it.each([["draft", "publish", "Publish"], ["active", "pause", "Pause"], ["paused", "resume", "Resume"]])("%s switch asks first, then submits %s", async (status, action, label) => {
    render(<AutomationToggle id="a1" name="welcome" status={status} from="/automations" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(automationState).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() => expect(automationState).toHaveBeenCalledTimes(1));
    const fd = automationState.mock.calls[0][0] as FormData;
    expect([fd.get("id"), fd.get("action"), fd.get("from")]).toEqual(["a1", action, "/automations"]);
  });
  it("cancel does not submit", async () => {
    render(<AutomationToggle id="a1" name="welcome" status="active" from="/automations" />);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(automationState).not.toHaveBeenCalled();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });
});

describe("automations list", () => {
  it("empty state explains how to create with a copyable command", () => {
    render(<AutomationsList automations={[]} />);
    expect(screen.getByText(/mailcraft automations import/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy import command/ })).toBeTruthy();
  });
});

describe("step flow", () => {
  const a = { trigger: "signed_up", steps: [
    { key: "mail", type: "send_email", config: { template: "welcome", mode: "llm", custom_instructions: "Be brief." } },
    { key: "w", type: "delay", config: { duration: "2d" } },
    { key: "x", type: "send_email", config: { template: "plain", mode: "llm" } },
  ] };
  it("renders trigger first, LLM slots and read-only extra instructions", () => {
    render(<StepFlow automation={a} slots={{ welcome: [{ name: "intro", max_len: 240, fallback: "Thanks" }] }} />);
    const items = screen.getAllByRole("listitem").filter((li) => li.parentElement?.getAttribute("aria-label") === "Automation steps");
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain("“signed_up”");
    expect(screen.getByText("intro")).toBeTruthy();
    expect(screen.getByText("Be brief.")).toBeTruthy();
    expect(screen.getByText("Wait 2 days")).toBeTruthy();
    expect(screen.getByText(/None. Workspace instructions apply/)).toBeTruthy();
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("runs", () => {
  it("shows state badges and durations", () => {
    render(<RunsTable runs={[{ id: "run_0123456789ABCDEF", status: "failed", contact: "a@b.c", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:02:00Z" }]} />);
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("2m")).toBeTruthy();
    expect(duration("2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z")).toBe("30s");
  });
  it("empty state has a copyable track command", () => {
    render(<RunsTable runs={[]} event="signed_up" />);
    expect(screen.getByText(/events track signed_up/)).toBeTruthy();
  });
});

describe("rules in words", () => {
  it("handles and/or/not/cmp", () => {
    expect(ruleWords({ and: [{ field: "contact.plan", op: "eq", value: "pro" }, { not: { field: "contact.x", op: "exists" } }] })).toBe("plan is “pro” AND NOT x exists");
    expect(ruleWords({ or: [{ field: "contact.n", op: "gt", value: 3 }, { field: "c", op: "in", value: ["a", "b"] }] })).toBe("n is greater than 3 OR c is one of “a”, “b”");
    expect(ruleWords(undefined)).toBeNull();
    expect(segmentRule({ id: "s", name: "x" })).toMatch(/manual list/);
  });
});

describe("templates", () => {
  it("validates imports before submit", () => {
    expect(validateImport("", "html", "")).toEqual({ name: "Give the template a name.", content: "Paste the template or choose a file." });
    expect(validateImport("a", "json", "{oops").content).toBe("This is not valid JSON.");
    expect(validateImport("a", "json", "{}")).toEqual({});
  });
  it("derives variables from source and summarizes lint", () => {
    expect(templateVariables({ subject: "Hi {{ first_name }}", html: "<p>{{amount}} {{ first_name }}</p>" })).toEqual(["first_name", "amount"]);
    expect(templateVariables({ variables: ["a"] })).toEqual(["a"]);
    expect(lintSummary([{ message: "m", severity: "error" }, { message: "w", severity: "warning" }])).toEqual({ errors: 1, warnings: 1 });
  });
  const rows = [{ id: "1", name: "Welcome", status: "published", version: 2, published_version: 1 }, { id: "2", name: "Receipt", status: "draft" }];
  it("searches, toggles table view and flags unpublished changes", () => {
    render(<TemplatesView templates={rows} />);
    expect(screen.getByText("unpublished changes")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search templates"), { target: { value: "rec" } });
    expect(screen.queryByText("Welcome")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search templates"), { target: { value: "zzz" } });
    expect(screen.getByText("No templates match")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search templates"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "Table view" }));
    expect(screen.getByRole("table")).toBeTruthy();
  });
});

describe("contacts", () => {
  const contacts = [
    { id: "c1", email: "ana@example.com", first_name: "Ana", properties: { plan: "pro" } },
    { id: "c2", email: "bad@example.com", suppressed: true, suppression_reason: "hard_bounce" },
  ];
  it("search is a server-side GET form and each row opens the contact page", () => {
    render(<TooltipProvider><ContactsView contacts={contacts} segments={[]} contactsError={null} segmentsError={null} tab="contacts" search="ana" /></TooltipProvider>);
    const box = screen.getByLabelText("Search contacts") as HTMLInputElement;
    expect([box.name, box.value, box.form?.method, box.form?.getAttribute("action")]).toEqual(["q", "ana", "get", "/contacts"]);
    expect(screen.getByRole("link", { name: "ana@example.com" }).getAttribute("href")).toBe("/contacts/c1");
  });
  it("marks suppressed contacts", () => {
    render(<TooltipProvider><ContactsView contacts={contacts} segments={[]} contactsError={null} segmentsError={null} tab="contacts" /></TooltipProvider>);
    expect(screen.getByText("suppressed")).toBeTruthy();
  });
  it("segments tab shows counts and rule words, and offers edit and delete; manual lists live on the Lists tab", () => {
    render(<TooltipProvider><ContactsView contacts={[]} segments={[{ id: "s", name: "Pro", member_count: 1284, filter: { field: "properties.plan", op: "eq", value: "pro" } }, { id: "m", name: "VIPs" }]} contactsError={null} segmentsError={null} tab="segments" /></TooltipProvider>);
    expect(screen.getByText("1,284")).toBeTruthy();
    expect(screen.getByText("plan is “pro”")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Pro" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete Pro" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add contacts to Pro" })).toBeNull(); // rule-based: members come from the rules
    expect(screen.queryByRole("button", { name: "Delete VIPs" })).toBeNull(); // a manual segment is a list now
  });
  it("empty states point at the UI, not curl", () => {
    render(<TooltipProvider><ContactsView contacts={[]} segments={[]} contactsError={null} segmentsError={null} tab="contacts" /></TooltipProvider>);
    expect(screen.getByRole("button", { name: /Add your first contact/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Import CSV/ })).toBeTruthy();
  });
});
