import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/actions", () => ({ login: vi.fn(), setKill: vi.fn(), saveInstructions: vi.fn() }));
vi.mock("@/app/(app)/settings/actions", () => ({ saveGeneral: vi.fn(), saveProvider: vi.fn(), savePolicy: vi.fn(), addRelay: vi.fn(), testTransport: vi.fn(), gmailStart: vi.fn() }));
import { LoginForm } from "@/app/login/login-form";
import { PolicyCard, ProviderCard } from "@/app/(app)/settings/forms";
import { KillSwitchCard } from "@/app/(app)/settings/safety";
import { DeliveryCard } from "@/app/(app)/settings/delivery";

describe("LoginForm", () => {
  it("toggles key visibility", () => {
    render(<LoginForm defaultBase="http://x" />);
    const k = screen.getByLabelText("API key") as HTMLInputElement;
    expect(k.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show API key" }));
    expect(k.type).toBe("text");
  });
  it("puts a key error under the key field in human words, code small", () => {
    render(<LoginForm defaultBase="http://x" err="unauthenticated|bad|" />);
    expect(screen.getByLabelText("API key").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/not accepted/)).toBeTruthy();
  });
  it("opens the URL disclosure when the URL is the problem", () => {
    const { container } = render(<LoginForm defaultBase="http://x" err="unreachable|Cannot reach|check it" />);
    expect(container.querySelector("details")?.open).toBe(true);
  });
});

describe("Settings cards", () => {
  it("provider shows a write-only 'Key set' indicator and never a key value", () => {
    render(<ProviderCard kind="openrouter" model="" baseUrl="" keySet canEdit />);
    expect(screen.getByText("Key set")).toBeTruthy();
    expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe("");
  });
  it("policy explains the chosen default in plain words", () => {
    render(<PolicyCard send="auto" keys={[]} canEdit />);
    fireEvent.change(screen.getByLabelText("Default for sending"), { target: { value: "needs_approval" } });
    expect(screen.getByTestId("policy-plain").textContent).toContain("approves each email");
  });
  it("kill switch: engage asks first; release is disabled without admin", () => {
    const { unmount } = render(<KillSwitchCard on={false} admin />);
    fireEvent.click(screen.getByRole("button", { name: "Pause all sending" }));
    expect(screen.getByRole("alertdialog").textContent).toContain("stops immediately");
    unmount();
    render(<KillSwitchCard on admin={false} />);
    expect((screen.getByRole("button", { name: /Release/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("delivery lists transports with a test button each", () => {
    render(<DeliveryCard path={{ kind: "smtp-relay", detail: "postmark" }} transports={[{ id: "t1", kind: "smtp-relay", name: "Postmark", status: "active" }]} canEdit />);
    expect(screen.getByRole("button", { name: "Test Postmark" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add relay/ })).toBeTruthy();
  });
});
