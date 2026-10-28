import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn(), push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push, refresh: vi.fn() }) }));

import { EmailFilters } from "@/components/emails/email-filters";
import { ApprovalsInbox, type Approval } from "@/components/emails/approvals-inbox";
import { EmailTrail } from "@/components/emails/trail";
import { MessagePreview } from "@/components/monitor/message-preview";
import { TrendChart } from "@/components/overview/trend-chart";
import { delta, emailsHref, explainDiagnostic, filterEmails, gap, rangeFor, splitSeries } from "@/components/monitor/helpers";

afterEach(() => { replace.mockReset(); push.mockReset(); vi.useRealTimers(); });

describe("helpers", () => {
  it("delta tone depends on whether up is good", () => {
    expect(delta(110, 100, true)).toEqual({ text: "+10%", tone: "ok" });
    expect(delta(110, 100, false)).toEqual({ text: "+10%", tone: "bad" });
    expect(delta(0, 0, true)).toBeUndefined();
  });
  it("gap formats", () => { expect(gap("2026-01-01T00:00:00Z", "2026-01-01T00:00:01.200Z")).toBe("+1.2s"); expect(gap("2026-01-01T00:00:00Z", "2026-01-01T00:03:04Z")).toBe("+3m 04s"); });
  it("splitSeries compares the trailing window to the one before", () => {
    const d = Array.from({ length: 4 }, (_, i) => ({ date: String(i), sent: i, delivered: 0, bounced: 0, complained: 0 }));
    const s = splitSeries(d, 2); expect(s.cur.map((x) => x.sent)).toEqual([2, 3]); expect(s.prev.map((x) => x.sent)).toEqual([0, 1]);
    expect(rangeFor("nope").key).toBe("7d");
  });
  it("explains SMTP codes", () => { expect(explainDiagnostic("5.1.1").tip).toMatch(/suppressed/); expect(explainDiagnostic(null, "452 4.2.2 full").title).toMatch(/retry/); });
  it("filters by text and date and builds hrefs", () => {
    const rows = [{ id: "a", subject: "Hello", to_addr: "x@y.com", created_at: "2026-10-01T10:00:00Z" }, { id: "b", subject: "Bye", to_addr: "z@y.com", created_at: "2026-10-05T10:00:00Z" }];
    expect(filterEmails(rows, { q: "HELLO" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterEmails(rows, { from: "2026-10-03" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterEmails(rows, { to: "2026-10-01" }).map((r) => r.id)).toEqual(["a"]);
    expect(emailsHref({ status: "sent", cursor: "9" }, { q: "a" }, true)).toBe("/emails?status=sent&q=a");
  });
});

describe("EmailFilters", () => {
  it("debounces search into a soft URL replace and resets paging", () => {
    vi.useFakeTimers();
    render(<EmailFilters query={{ cursor: "25", status: "sent" }} debounceMs={100} />);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "bob" } });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "bobby" } });
    expect(replace).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(120); });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toBe("/emails?status=sent&q=bobby");
  });
  it("status select and clear", () => {
    render(<EmailFilters query={{ q: "x" }} />);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "bounced" } });
    expect(replace.mock.calls[0][0]).toBe("/emails?q=x&status=bounced");
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(replace.mock.calls[1][0]).toBe("/emails");
  });
});

const A = (i: number): Approval => ({ id: `ap${i}`, kind: "email", status: "pending", created_at: "2026-10-01T10:00:00Z", payload: { to: `u${i}@x.com`, preview: { subject: `Subject ${i}`, text: "body" } } });

describe("ApprovalsInbox", () => {
  it("J/K move the selection", () => {
    render(<ApprovalsInbox approvals={[A(1), A(2)]} canDecide decide={vi.fn()} />);
    const detail = () => screen.getByRole("region", { name: "Approval detail" }).querySelector("h2")!.textContent;
    expect(detail()).toBe("Subject 1");
    fireEvent.keyDown(window, { key: "j" });
    expect(detail()).toBe("Subject 2");
    fireEvent.keyDown(window, { key: "k" });
    expect(detail()).toBe("Subject 1");
  });
  it("A opens a confirm dialog and confirming sends the decision", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalsInbox approvals={[A(1)]} canDecide decide={decide} />);
    fireEvent.keyDown(window, { key: "a" });
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toMatch(/Approve this email/);
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" }).at(-1)!);
    await waitFor(() => expect(decide).toHaveBeenCalled());
    const fd = decide.mock.calls[0][0] as FormData;
    expect([fd.get("id"), fd.get("decision")]).toEqual(["ap1", "approve"]);
  });
  it("R opens the reject dialog with an optional reason that is sent along", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalsInbox approvals={[{ ...A(1), payload: { to: "u@x.com", preview: { subject: "S", html: "<b>rendered</b>" } } }]} canDecide decide={decide} />);
    expect(screen.getByTitle("Preview of S").getAttribute("srcdoc")).toBe("<b>rendered</b>");
    fireEvent.keyDown(window, { key: "r" });
    const reason = await screen.findByLabelText(/Reason/);
    fireEvent.change(reason, { target: { value: "  looks like phishing " } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1)!);
    await waitFor(() => expect(decide).toHaveBeenCalled());
    const fd = decide.mock.calls[0][0] as FormData;
    expect([fd.get("decision"), fd.get("reason")]).toEqual(["reject", "looks like phishing"]);
  });
  it("non-admin sees a message and cannot decide", () => {
    render(<ApprovalsInbox approvals={[A(1)]} canDecide={false} decide={vi.fn()} />);
    expect(screen.getByText(/Only an admin key/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "r" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("auto-advances when the decided item leaves the list", () => {
    const { rerender } = render(<ApprovalsInbox approvals={[A(1), A(2), A(3)]} canDecide decide={vi.fn()} />);
    fireEvent.keyDown(window, { key: "j" });
    rerender(<ApprovalsInbox approvals={[A(1), A(3)]} canDecide decide={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Approval detail" }).querySelector("h2")!.textContent).toBe("Subject 3");
  });
});

describe("EmailTrail", () => {
  it("shows gaps and a bounce diagnostic with advice", () => {
    render(<EmailTrail status="bounced" events={[
      { type: "queued", occurred_at: "2026-10-01T10:00:00Z" },
      { type: "bounced", enhanced_code: "5.1.1", diagnostic: "550 user unknown", occurred_at: "2026-10-01T10:00:03.400Z" },
    ]} />);
    expect(screen.getByText("+3.4s")).toBeTruthy();
    expect(screen.getByText("5.1.1")).toBeTruthy();
    expect(screen.getByText(/What to do/)).toBeTruthy();
  });
});

describe("MessagePreview", () => {
  it("iframe is fully sandboxed and has no body fallback", () => {
    const { container, rerender } = render(<MessagePreview html="<p>x</p>" title="t" />);
    expect(container.querySelector("iframe")!.getAttribute("sandbox")).toBe("");
    rerender(<MessagePreview title="t" />);
    expect(screen.getByText(/No body available/)).toBeTruthy();
  });
});

describe("TrendChart", () => {
  const days = [{ date: "2026-10-01", sent: 10, delivered: 8, bounced: 1, complained: 0 }, { date: "2026-10-02", sent: 20, delivered: 18, bounced: 2, complained: 0 }];
  it("legend toggles series and table view lists rows", () => {
    const { container } = render(<TrendChart days={days} label="Volume" />);
    expect(container.querySelectorAll("rect").length).toBe(5);
    fireEvent.click(screen.getByRole("button", { name: "Bounced" }));
    expect(container.querySelectorAll("rect").length).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "View as table" }));
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });
});
