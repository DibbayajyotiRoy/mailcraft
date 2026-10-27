import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActionError, ErrorBanner, Preview, RecordsTable, StatusBadge } from "@/components/ui";

describe("ui", () => {
  it("StatusBadge shows text and tone", () => {
    render(<StatusBadge status="not_started" />);
    const b = screen.getByText("not started");
    expect(b.className).toContain("warn");
  });
  it("ErrorBanner shows code, message, hint as an alert", () => {
    render(<ErrorBanner error={{ code: "forbidden", message: "agent keys cannot decide", hint: "use an admin key" }} />);
    const a = screen.getByRole("alert");
    expect(a.textContent).toContain("forbidden");
    expect(a.textContent).toContain("use an admin key");
  });
  it("ActionError parses the redirect query", () => {
    render(<ActionError err="bad|Broken|try later" />);
    expect(screen.getByRole("alert").textContent).toContain("try later");
  });
  it("RecordsTable renders a badge per record", () => {
    render(<RecordsTable records={[
      { type: "TXT", name: "a", value: "v=spf1", status: "verified" },
      { type: "MX", name: "b", value: "mx.x", priority: 10, status: "failed" },
    ]} />);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("verified")).toBeTruthy();
    expect(screen.getByText("10 mx.x")).toBeTruthy();
  });
  it("Preview iframe is fully sandboxed", () => {
    render(<Preview title="p" html="<script>1</script>" />);
    expect(screen.getByTitle("p").getAttribute("sandbox")).toBe("");
  });
});
