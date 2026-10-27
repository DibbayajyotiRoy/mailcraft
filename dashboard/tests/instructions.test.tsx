import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/actions", () => ({ saveInstructions: vi.fn() }));
import { InstructionsForm, MAX, PRESETS, previewText } from "@/components/Instructions";

describe("InstructionsForm", () => {
  it("counts characters live and blocks save when over the limit", () => {
    render(<InstructionsForm initial="" />);
    const ta = screen.getByLabelText("Custom instructions") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(screen.getByTestId("count").textContent).toBe("5");
    fireEvent.change(ta, { target: { value: "x".repeat(MAX + 1) } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(ta.getAttribute("aria-invalid")).toBe("true");
  });
  it("presets fill the textarea", () => {
    render(<InstructionsForm initial="" />);
    fireEvent.click(screen.getByRole("button", { name: "Concise and technical" }));
    expect((screen.getByLabelText("Custom instructions") as HTMLTextAreaElement).value).toBe(PRESETS[1].text);
    expect(PRESETS).toHaveLength(3);
  });
  it("explains safety rules and toggles the preview", () => {
    render(<InstructionsForm initial="Be brief." />);
    expect(screen.getByText(/cannot override/).textContent).toContain("unsubscribe");
    const b = screen.getByRole("button", { name: "Preview with a sample email" });
    fireEvent.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("pre")?.textContent).toBe(previewText("Be brief."));
  });
});
