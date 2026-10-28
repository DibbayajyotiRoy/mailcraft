import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ release: [] as ((v?: unknown) => void)[] }));
const hold = (v?: unknown) => new Promise((res) => gate.release.push(() => res(v)));
vi.mock("@/lib/actions", () => ({ verifyDomain: () => hold() }));
vi.mock("@/app/(app)/settings/actions", () => ({ addRelay: vi.fn(), gmailStart: vi.fn(), testTransport: () => hold({ ok: "Connected" }) }));

import { VerifyForm } from "@/app/(app)/domains/verify-form";
import { TestButton } from "@/app/(app)/settings/delivery";
import { Busy } from "@/components/ui/busy";

afterEach(() => { cleanup(); gate.release.length = 0; });

describe("Busy", () => {
  it("is a polite status with the label and a decorative 20px orb in the requested state", () => {
    render(<Busy state="searching" label="Checking DNS…" />);
    const s = screen.getByRole("status");
    expect(s.textContent).toBe("Checking DNS…");
    expect(s.getAttribute("aria-live")).toBe("polite");
    const orb = s.querySelector("canvas")!;
    expect(orb.getAttribute("data-orb")).toBe("searching");
    expect(orb.getAttribute("data-size")).toBe("20");
    expect(orb.getAttribute("aria-hidden")).toBe("true");
    // theme and reduced motion are the orb's own (auto theme, still frame): nothing here overrides them
    expect(orb.hasAttribute("data-theme")).toBe(false);
    expect(orb.hasAttribute("data-paused")).toBe(false);
  });
});

describe("TestButton", () => {
  it("shows the connecting orb only while the test runs, then the result", async () => {
    render(<TestButton id="t1" label="Postmark" />);
    expect(screen.queryByText("Testing connection…")).toBeNull();
    await act(async () => { fireEvent.submit(screen.getByRole("button", { name: "Test Postmark" }).closest("form")!); });
    const busy = screen.getByText("Testing connection…");
    expect(busy.getAttribute("role")).toBe("status");
    expect(busy.querySelector("canvas")!.getAttribute("data-orb")).toBe("connecting");
    await act(async () => { gate.release[0](); });
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.queryByText("Testing connection…")).toBeNull();
  });
});

describe("VerifyForm", () => {
  it("shows the searching orb only while DNS is being checked", async () => {
    render(<VerifyForm id="d1" name="example.com" primary />);
    expect(screen.queryByText("Checking DNS…")).toBeNull();
    await act(async () => { fireEvent.submit(screen.getByRole("button", { name: /Verify now/ }).closest("form")!); });
    expect(screen.getByText("Checking DNS…").querySelector("canvas")!.getAttribute("data-orb")).toBe("searching");
    await act(async () => { gate.release[0](); });
    expect(screen.queryByText("Checking DNS…")).toBeNull();
  });
});
