import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn() } }));
import { ComposeEmail } from "@/components/emails/compose";
import { askableVars, composeBody, nestVars, parseRecipients, type Compose } from "@/lib/compose";

const base: Compose = { from: "dev@example.com", to: "a@x.co", subject: "Hi", stream: "transactional", mode: "text", text: "Hello", html: "", template: "", vars: {} };

describe("composeBody", () => {
  it("splits and de-duplicates recipients", () => {
    expect(parseRecipients("a@x.co, B@x.co;\n a@X.co ,")).toEqual(["a@x.co", "B@x.co"]);
  });
  it("builds a text, html or template body", () => {
    expect(composeBody(base)).toEqual({ body: { from: "dev@example.com", to: ["a@x.co"], stream: "transactional", subject: "Hi", text: "Hello" } });
    expect(composeBody({ ...base, mode: "html", html: "<p>x</p>" })).toMatchObject({ body: { html: "<p>x</p>" } });
    const t = composeBody({ ...base, mode: "template", subject: "", template: "t1", vars: { first_name: "Ada", "data.company": "Acme", blank: " " } });
    expect(t).toEqual({ body: { from: "dev@example.com", to: ["a@x.co"], stream: "transactional", template: { id: "t1", variables: { first_name: "Ada", data: { company: "Acme" } } } } });
  });
  it("reports what is missing, per field", () => {
    expect(composeBody({ ...base, from: "", to: "nope", subject: "" })).toEqual({ errors: { from: "Enter the address this is sent from.", to: "“nope” is not an email address.", subject: "Add a subject." } });
    expect(composeBody({ ...base, mode: "template" })).toEqual({ errors: { content: "Choose a template." } });
  });
  it("only asks for variables the platform does not fill in", () => {
    expect(askableVars(["first_name", "unsubscribe_url", "workspace.name", { name: "amount" }])).toEqual(["first_name", "amount"]);
    expect(nestVars({ "a.b": "1", c: "2" })).toEqual({ a: { b: "1" }, c: "2" });
  });
});

describe("ComposeEmail", () => {
  const open = (send = vi.fn()) => {
    render(<ComposeEmail defaultFrom="dev@example.com" templates={[{ id: "t1", name: "Welcome", variables: ["first_name"] }]} send={send} />);
    fireEvent.click(screen.getByRole("button", { name: "New email" }));
    return send;
  };
  it("prefills From and sends through the action", async () => {
    const send = open(vi.fn().mockResolvedValue({ id: "em_1", status: "queued" }));
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("dev@example.com");
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "ada@example.com, grace@example.com" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hello" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hi there" } });
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ from: "dev@example.com", to: ["ada@example.com", "grace@example.com"], stream: "transactional", subject: "Hello", text: "Hi there" }));
  });
  it("shows the API error with its hint and stays open", async () => {
    const send = open(vi.fn().mockResolvedValue({ error: { code: "domain_not_verified", message: "cannot send from example.com: domain is not verified", hint: "add it with POST /v1/domains" } }));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hello" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    expect((await screen.findByRole("alert")).textContent).toContain("domain_not_verified");
    expect(screen.getByRole("alert").textContent).toContain("Hint: add it with POST /v1/domains");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("blocks an empty form without calling the API", () => {
    const send = open();
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    expect(screen.getByText("Add at least one recipient.")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });
  it("template mode asks for the template's variables", () => {
    open();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Use a template" }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "t1" } });
    expect(screen.getByLabelText("first_name")).toBeTruthy();
  });
});
