import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/actions", () => ({
  createKey: vi.fn(async () => ({ secret: "mc_test_SECRET123" })), revokeKey: vi.fn(), deleteDomain: vi.fn(), rotateDkim: vi.fn(), verifyDomain: vi.fn(), addDomain: vi.fn(),
}));
import { CreateKey } from "@/app/(app)/keys/create-key";
import { DnsRecordRow } from "@/app/(app)/domains/records";
import { Meter } from "@/app/(app)/domains/domain-card";
import { MonoCopy } from "@/components/setup/mono-copy";
import { TypeNameConfirm } from "@/components/setup/type-name-confirm";
import { SetupChecklist } from "@/components/onboarding/checklist";

const writeText = vi.fn(async () => {});
beforeEach(() => { writeText.mockClear(); Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true }); });

describe("setup", () => {
  it("MonoCopy copies the exact value", async () => {
    render(<MonoCopy value="v=spf1 include:x ~all" label="SPF value" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy SPF value" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("v=spf1 include:x ~all"));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });
  it("DnsRecordRow shows both copy fields, status and a failed diagnostic", () => {
    render(<ul><DnsRecordRow r={{ record: "SPF", type: "TXT", name: "a.example.com", value: "v=spf1", status: "failed", found: "v=spf1 include:other.com" }} /></ul>);
    expect(screen.getByRole("button", { name: "Copy SPF name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy SPF value" })).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("v=spf1 include:other.com")).toBeTruthy();
  });
  it("Meter reports 2 of 4", () => {
    render(<Meter done={2} total={4} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("2 of 4 verified");
  });
  it("one-time secret cannot be dismissed until the stored box is ticked", async () => {
    render(<CreateKey />);
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "CI" } });
    await act(async () => { fireEvent.click(screen.getByRole("dialog").querySelector("button[type=submit]")!); });
    expect(await screen.findByText(/You won.t see this again/)).toBeTruthy();
    expect(screen.getByText("mc_test_SECRET123")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByText("mc_test_SECRET123")).toBeTruthy(); // Esc did not close it
    const done = screen.getByRole("button", { name: "Done" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /stored/ }));
    expect(done.disabled).toBe(false);
    fireEvent.click(done);
    await waitFor(() => expect(screen.queryByText("mc_test_SECRET123")).toBeNull());
  });
  it("TypeNameConfirm enables the action only for the exact name", () => {
    render(<TypeNameConfirm open onOpenChange={() => {}} title="Revoke" description="d" expected="CI" confirmLabel="Revoke key" action={() => {}} fields={{ id: "k" }} />);
    const b = screen.getByRole("button", { name: "Revoke key" }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "CI" } });
    expect(b.disabled).toBe(false);
  });
  it("SetupChecklist counts done steps and only offers actions for open ones", () => {
    render(<SetupChecklist steps={[{ id: "a", title: "A", why: "w", href: "/a", cta: "Do A", done: true }, { id: "b", title: "B", why: "w", href: "/b", cta: "Do B", done: false }]} />);
    expect(screen.getByText("1 of 2 done")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Do A" })).toBeNull();
    expect(screen.getByRole("link", { name: "Do B" }).getAttribute("href")).toBe("/b");
  });
});
