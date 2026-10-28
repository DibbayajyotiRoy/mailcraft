import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn() } }));
// The beam is an animation library that needs matchMedia, which jsdom lacks.
vi.mock("border-beam", () => ({ BorderBeam: ({ children }: { children: unknown }) => children }));
vi.mock("@/lib/actions", () => ({ verifyDomain: vi.fn(), rotateDkim: vi.fn(), deleteDomain: vi.fn() }));
vi.mock("@/app/(app)/settings/actions", () => ({ addRelay: vi.fn(), testTransport: vi.fn(), gmailStart: vi.fn() }));
vi.mock("@/app/(app)/settings/senders-actions", () => ({ setDefaultFrom: vi.fn(), saveAddresses: vi.fn() }));
vi.mock("@/app/(app)/domains/sends-via-actions", () => ({ bindTransport: vi.fn() }));
import { FromPicker } from "@/components/emails/from-picker";
import { ComposeEmail } from "@/components/emails/compose";
import { SendersCard } from "@/app/(app)/settings/senders";
import { mailboxFields } from "@/app/(app)/settings/addresses";
import { DomainCard } from "@/app/(app)/domains/domain-card";
import { byTransport, findSender, initialFrom, senderLabel, type Sender } from "@/lib/senders";

const senders: Sender[] = [
  { address: "dev@example.com", display_name: "Acme Developers", kind: "login", transport_id: "tr2", transport: "dev@example.com", status: "ready", is_default: true },
  { address: "partner@example.com", display_name: "Acme Partnerships", kind: "alias", transport_id: "tr2", transport: "dev@example.com", status: "ready" },
  { address: "support@example.com", display_name: null, kind: "alias", transport_id: "tr2", transport: "dev@example.com", status: "ready" },
  { address: "hello@other.test", kind: "domain", transport_id: "tr1", transport: "postmark", status: "needs_domain" },
];

describe("sender helpers", () => {
  it("labels, finds by bare address (case and display-name insensitive) and groups by transport", () => {
    expect(senderLabel(senders[0])).toBe("Acme Developers <dev@example.com>");
    expect(senderLabel(senders[2])).toBe("support@example.com");
    expect(findSender(senders, "Someone <PARTNER@example.com>")?.address).toBe("partner@example.com");
    expect(byTransport(senders).map(([id, rows]) => [id, rows.length])).toEqual([["tr2", 3], ["tr1", 1]]);
    expect(initialFrom("", [senders[0]])).toBe("dev@example.com");
    expect(initialFrom("", senders)).toBe("");
    expect(initialFrom("a@b.co", senders)).toBe("a@b.co");
  });
});

describe("FromPicker", () => {
  const Harness = ({ value = "", onChange = vi.fn(), s = senders, emptyLabel }: { value?: string; onChange?: (v: string) => void; s?: Sender[]; emptyLabel?: string }) =>
    <FromPicker aria-label="From" senders={s} value={value} onChange={onChange} emptyLabel={emptyLabel} />;

  it("offers each connected address with its display name and what it still needs", () => {
    render(<Harness />);
    const opts = within(screen.getByLabelText("From")).getAllByRole("option").map((o) => o.textContent);
    expect(opts).toEqual(["Choose a sender", "Acme Developers <dev@example.com>", "Acme Partnerships <partner@example.com>", "support@example.com", "hello@other.test (needs domain)", "Other address…"]);
  });
  it("picks a sender by its bare address", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "partner@example.com" } });
    expect(onChange).toHaveBeenCalledWith("partner@example.com");
    expect(screen.queryByLabelText("Other From address")).toBeNull();
  });
  it("selects the current value, even when it carries a display name", () => {
    render(<Harness value="Anything <dev@example.com>" />);
    expect((screen.getByLabelText("From") as HTMLSelectElement).value).toBe("dev@example.com");
  });
  it("'Other address…' reveals a text box for an address on a verified domain", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: (screen.getByRole("option", { name: "Other address…" }) as HTMLOptionElement).value } });
    expect(onChange).toHaveBeenLastCalledWith("");
    fireEvent.change(screen.getByLabelText("Other From address"), { target: { value: "x@verified.test" } });
    expect(onChange).toHaveBeenLastCalledWith("x@verified.test");
  });
  it("starts in typing mode for an address that is not connected", () => {
    render(<Harness value="x@verified.test" />);
    expect((screen.getByLabelText("Other From address") as HTMLInputElement).value).toBe("x@verified.test");
  });
  it("can lead with an empty choice, and is a plain input with nothing connected", () => {
    const { unmount } = render(<Harness emptyLabel="First verified domain" />);
    expect(screen.getByRole("option", { name: "First verified domain" })).toBeTruthy();
    unmount();
    const onChange = vi.fn();
    render(<Harness s={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "me@verified.test" } });
    expect(onChange).toHaveBeenCalledWith("me@verified.test");
  });
});

describe("New email", () => {
  it("sends from the picked sender's bare address (the API adds its display name)", async () => {
    const send = vi.fn().mockResolvedValue({ id: "em_1", status: "queued" });
    render(<ComposeEmail defaultFrom="dev@example.com" senders={senders} templates={[]} send={send} />);
    fireEvent.click(screen.getByRole("button", { name: "New email" }));
    expect((screen.getByLabelText("From") as HTMLSelectElement).value).toBe("dev@example.com");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "support@example.com" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hi" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ from: "support@example.com", to: ["ada@example.com"], stream: "transactional", subject: "Hi", text: "Hello" }));
  });
});

describe("mailboxFields", () => {
  it("turns the form rows into aliases and a display-name map, skipping blanks", () => {
    const d = new FormData();
    d.set("login_name", " Acme Developers ");
    d.append("alias_address", "Partner@Example.com"); d.append("alias_name", "Acme Partnerships");
    d.append("alias_address", "  "); d.append("alias_name", "ignored");
    d.append("alias_address", "support@example.com"); d.append("alias_name", "");
    expect(mailboxFields(d, "dev@example.com")).toEqual({
      aliases: ["partner@example.com", "support@example.com"],
      display_names: { "dev@example.com": "Acme Developers", "partner@example.com": "Acme Partnerships" },
    });
  });
});

describe("SendersCard", () => {
  it("lists the senders by the mailbox they send through, with status and the default", () => {
    render(<SendersCard senders={senders} defaultFrom="dev@example.com" canEdit />);
    const mailbox = screen.getByRole("list", { name: "Senders via dev@example.com" });
    const rows = within(mailbox).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Acme Developers");
    expect(rows[0].textContent).toContain("default");
    expect(rows[1].textContent).toContain("alias");
    expect(within(rows[2]).getByText("ready")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Senders via postmark" })).getByText("needs domain")).toBeTruthy();
    expect((screen.getByLabelText("Default From") as HTMLSelectElement).value).toBe("dev@example.com");
  });
  it("edits a mailbox's aliases and display names in one dialog", () => {
    render(<SendersCard senders={senders} defaultFrom="" canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Edit addresses of dev@example.com" }));
    const dlg = screen.getByRole("dialog");
    expect((within(dlg).getByLabelText("Display name for dev@example.com") as HTMLInputElement).value).toBe("Acme Developers");
    expect((within(dlg).getByLabelText("Alias 1 address") as HTMLInputElement).value).toBe("partner@example.com");
    expect((within(dlg).getByLabelText("Alias 1 display name") as HTMLInputElement).value).toBe("Acme Partnerships");
    expect((within(dlg).getByLabelText("Alias 2 address") as HTMLInputElement).value).toBe("support@example.com");
    fireEvent.click(within(dlg).getByRole("button", { name: "Add address" }));
    expect(within(dlg).getByLabelText("Alias 3 address")).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove alias 1" }));
    expect((within(dlg).getByLabelText("Alias 1 address") as HTMLInputElement).value).toBe("support@example.com");
  });
  it("connecting a mailbox asks for the login and shows its address rows", () => {
    render(<SendersCard senders={senders} defaultFrom="" canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a mailbox" }));
    const dlg = screen.getByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText("Mailbox address (username)"), { target: { value: "ops@example.com" } });
    expect(within(dlg).getByText("ops@example.com")).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Add address" }));
    expect(within(dlg).getByLabelText("Alias 1 address")).toBeTruthy();
  });
  it("with nothing connected, says how to get a sender", () => {
    render(<SendersCard senders={[]} defaultFrom="" canEdit />);
    expect(screen.getByText("No sender addresses yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect a mailbox" })).toBeTruthy();
  });
  it("is read-only without an admin key", () => {
    render(<SendersCard senders={senders} defaultFrom="" canEdit={false} />);
    expect(screen.queryByRole("button", { name: /Edit addresses/ })).toBeNull();
    expect((screen.getByLabelText("Default From") as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("DomainCard", () => {
  const transports = [{ id: "tr1", kind: "smtp-relay", name: "postmark", is_default: true }, { id: "tr2", kind: "smtp-relay", name: "dev@example.com" }];
  it("lets you choose what the domain sends via, and lists its senders", () => {
    render(<DomainCard d={{ id: "d3", name: "example.com", status: "not_started", transport_id: "tr2", relay_senders: ["dev@example.com", "partner@example.com", "support@example.com"], relay_sender: "dev@example.com", records: [] }} transports={transports} senders={senders} />);
    const via = screen.getByLabelText("Sends via") as HTMLSelectElement;
    expect(via.value).toBe("tr2");
    expect(within(via).getAllByRole("option").map((o) => o.textContent)).toEqual(["Workspace default (postmark)", "postmark", "dev@example.com"]);
    expect(screen.getByText("Verified via relay")).toBeTruthy();
    expect(screen.getByText(/dev@example.com, partner@example.com, support@example.com/)).toBeTruthy();
    const here = within(screen.getByRole("list", { name: "Senders on example.com" })).getAllByRole("listitem");
    expect(here.map((r) => r.textContent)).toEqual(["Acme Developers <dev@example.com>ready", "Acme Partnerships <partner@example.com>ready", "support@example.comready"]);
  });
  it("defaults to the workspace default and points to Settings when there are no senders", () => {
    render(<DomainCard d={{ id: "d1", name: "mail.other.test", status: "verified", records: [] }} transports={transports} senders={senders} />);
    expect((screen.getByLabelText("Sends via") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings#senders");
  });
});
