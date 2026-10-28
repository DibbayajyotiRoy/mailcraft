import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasPlaceholders, VariablesSection } from "@/components/assistant/VariablesSection";
import type { Proposal } from "@/lib/assistant/types";

afterEach(cleanup);

type Vars = NonNullable<Proposal["variables"]>;
const plain: Vars = [{ name: "first_name", value: "Ada" }, { name: "company", value: "Example Inc" }];
const rows = (): HTMLElement[] => Array.from(screen.getByRole("region", { name: "Variables" }).querySelectorAll("dl > div"));
const many = (n: number): Vars => Array.from({ length: n }, (_, i) => ({ name: `v${i}`, value: `value ${i}` }));

describe("VariablesSection", () => {
  it("is a named region with a Variables heading", () => {
    render(<VariablesSection variables={plain} />);
    expect(screen.getByRole("region", { name: "Variables" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Variables" })).toBeTruthy();
  });

  it("renders one name = value row per variable, as text", () => {
    render(<VariablesSection variables={[...plain, { name: "note", value: "<b>hi</b>" }]} />);
    expect(rows().map((r) => r.textContent)).toEqual(["first_name=Ada", "company=Example Inc", "note=<b>hi</b>"]);
    expect(screen.getByRole("region", { name: "Variables" }).querySelector("b")).toBeNull();
  });

  it("shows an empty value as a muted (empty)", () => {
    render(<VariablesSection variables={[{ name: "plan", value: "" }]} />);
    const el = screen.getByText("(empty)");
    expect(el.className).toContain("text-muted");
    expect(rows()[0].textContent).toBe("plan=(empty)");
  });

  it("the pencil calls onTweak with the exact prefill", () => {
    const onTweak = vi.fn();
    render(<VariablesSection variables={plain} onTweak={onTweak} />);
    fireEvent.click(screen.getByRole("button", { name: "Change company" }));
    expect(onTweak).toHaveBeenCalledOnce();
    expect(onTweak).toHaveBeenCalledWith("Change company to ");
    expect(screen.getAllByRole("button", { name: /^Change / })).toHaveLength(2);
  });

  it("renders no pencil without onTweak", () => {
    render(<VariablesSection variables={plain} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("flags a placeholder row and the alert names its value and variable", () => {
    render(<VariablesSection variables={[{ name: "first_name", value: "Ada" }, { name: "signup_link", value: "[add signup link]", placeholder: true }]} />);
    const [ok, flagged] = rows();
    expect(within(flagged).getByText("needs a value")).toBeTruthy();
    expect(flagged.className).toContain("text-warn");
    expect(flagged.className).toContain("bg-warn-bg");
    expect(within(ok).queryByText("needs a value")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Replace [add signup link] before sending: tell me what to use, e.g. “change signup_link to …”.");
  });

  it("joins several placeholders with commas", () => {
    render(<VariablesSection variables={[{ name: "a", value: "[add a]", placeholder: true }, { name: "b", value: "[add b]", placeholder: true }]} />);
    expect(screen.getByRole("alert").textContent).toContain("Replace [add a], [add b] before sending");
    expect(screen.getAllByText("needs a value")).toHaveLength(2);
  });

  it("shows no alert when nothing is a placeholder", () => {
    render(<VariablesSection variables={plain} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("needs a value")).toBeNull();
  });

  it("hasPlaceholders", () => {
    expect(hasPlaceholders(undefined)).toBe(false);
    expect(hasPlaceholders([])).toBe(false);
    expect(hasPlaceholders(plain)).toBe(false);
    expect(hasPlaceholders([...plain, { name: "x", value: "[add x]", placeholder: true }])).toBe(true);
  });

  it("folds past 8 rows behind Show all N, and back", () => {
    render(<VariablesSection variables={many(8)} />);
    expect(rows()).toHaveLength(8);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    cleanup();
    render(<VariablesSection variables={many(11)} />);
    expect(rows()).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Show all 11" }));
    expect(rows()).toHaveLength(11);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(rows()).toHaveLength(8);
  });

  it("wraps long values instead of overflowing", () => {
    render(<VariablesSection variables={[{ name: "url", value: "https://example.com/" + "a".repeat(200) }]} />);
    expect(screen.getByText(/^https:\/\/example\.com\/a+$/).className).toContain("break-words");
  });
});
