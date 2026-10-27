import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import { parseErr } from "@/lib/err";

describe("ui", () => {
  it("StatusBadge shows text and tone", () => {
    render(<StatusBadge status="not_started" />);
    const b = screen.getByText("not started");
    expect(b.className).toContain("warn");
  });
  it("ErrorState shows message, code and hint as an alert", () => {
    render(<ErrorState error={{ code: "forbidden", message: "agent keys cannot decide", hint: "use an admin key" }} />);
    const a = screen.getByRole("alert");
    expect(a.textContent).toContain("forbidden");
    expect(a.textContent).toContain("agent keys cannot decide");
    expect(a.textContent).toContain("use an admin key");
  });
  it("parseErr reads the redirect query", () => {
    expect(parseErr("bad|Broken|try later")).toEqual({ code: "bad", message: "Broken", hint: "try later" });
    expect(parseErr(undefined)).toBeNull();
  });
});
