import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push }) }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn() } }));
import { Personalization } from "@/components/Personalization";
import { NewBroadcast } from "@/components/broadcasts/new-broadcast";
import { RecipientsStep } from "@/components/broadcasts/recipients";
import type { Parsed } from "@/lib/csv";
import { EXAMPLE, PERSONALIZATION } from "@/lib/personalization";

// jsdom's File has no .text()
(File.prototype as any).text ??= function (this: File) { return new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(this); }); };

beforeEach(() => { push.mockClear(); Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } }); });

const csvFile = (text: string) => new File([text], "people.csv", { type: "text/csv" });

describe("recipients editor", () => {
  const setup = () => { const seen: (Parsed | null)[] = []; render(<RecipientsStep onActive={(p) => seen.push(p)} />); return seen; };

  it("types recipients into a table, adds and removes rows and custom fields", () => {
    const seen = setup();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Type recipients" }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByLabelText("Email, recipient 1"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("First name, recipient 1"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Add recipient" }));
    expect(screen.getByLabelText("Email, recipient 4")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New field"), { target: { value: "Company Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    fireEvent.change(screen.getByLabelText("company_name, recipient 1"), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText("Email, recipient 2"), { target: { value: "nope" } });
    const last = seen.at(-1)!;
    expect(last.recipients).toEqual([{ email: "ada@example.com", first_name: "Ada", data: { company_name: "Acme" } }]);
    expect(last.issues).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Recipients summary" }).textContent).toMatch(/1 recipient ready, 1 invalid/);
    expect(screen.getByText("{{ data.company_name }}")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove recipient 2" }));
    expect(seen.at(-1)!.issues).toHaveLength(0);
    // a name that is taken is refused
    fireEvent.change(screen.getByLabelText("New field"), { target: { value: "email" } });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    expect(screen.getByText("“email” is already a column.")).toBeTruthy();
  });

  it("reads a dropped or chosen CSV and shows counts, invalid rows and duplicates", async () => {
    const seen = setup();
    const file = csvFile("email,first_name,company\nada@example.com,Ada,Acme\nbad,Bob,X\nADA@example.com,Ada,Acme\n");
    fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
    await waitFor(() => expect(seen.at(-1)?.recipients).toHaveLength(1));
    expect(screen.getByRole("status", { name: "Recipients summary" }).textContent).toMatch(/1 recipient ready, 1 invalid, 1 duplicate removed/);
    expect(screen.getByText("people.csv")).toBeTruthy();
    expect(screen.getByText("Not a valid email address")).toBeTruthy();
    // drag and drop goes through the same reader
    const zone = screen.getByText(/Drag a .csv file here/).closest("div")!;
    await act(async () => { fireEvent.drop(zone, { dataTransfer: { files: [csvFile("name\nx\n")] } }); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/no “email” column/));
    expect(seen.at(-1)!.recipients).toHaveLength(0);
  });

  it("explains the CSV format with a copyable example and a download link", () => {
    setup();
    const dl = screen.getByRole("link", { name: /Download example.csv/ });
    expect(dl.getAttribute("download")).toBe("example.csv");
    expect(decodeURIComponent(dl.getAttribute("href")!)).toContain("email,first_name,last_name,company\nada@example.com,Ada,Lovelace,Analytical Engines");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(screen.getByText(/usable as/).textContent).toContain("{{ data.company }}");
  });
});

describe("Personalization", () => {
  it("shows every supported snippet with a copy button, plus the example sentence", async () => {
    render(<Personalization />);
    fireEvent.click(screen.getByRole("button", { name: /Personalization/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(EXAMPLE)).toBeTruthy();
    for (const s of PERSONALIZATION.flatMap((g) => g.items)) expect(within(dialog).getByRole("button", { name: `Copy ${s.code}` })).toBeTruthy();
    expect(within(dialog).getByText('{{ first_name | default("there") }}')).toBeTruthy();
    expect(within(dialog).getByText("{{ unsubscribe_url }}")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy example sentence" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(EXAMPLE));
  });
});

describe("NewBroadcast", () => {
  const templates = [{ id: "t1", name: "Welcome", subject: "Hi", status: "published" }];
  const plan = { dry_run: true, queued: 2, skipped: [], schedule: { daily_cap: 50, transport_daily_cap: 50, spacing_seconds: 1728, first_at: new Date().toISOString(), last_at: new Date(Date.now() + 864e5).toISOString() } };
  const make = () => {
    const actions = {
      preview: vi.fn().mockImplementation(async (_d, r) => ({ data: { subject: `Hello ${r.first_name}`, html: `<p>Hi ${r.first_name}</p>`, text: `Hi ${r.first_name}` } })),
      create: vi.fn().mockImplementation(async (_d, _r, dry) => ({ data: dry ? plan : { id: "b9", status: "queued", queued: 2, skipped: [] } })),
      sendTest: vi.fn().mockResolvedValue({ id: "em_1" }),
    };
    render(<NewBroadcast templates={templates} defaultFrom="dev@spicrawl.com" actions={actions} />);
    return actions;
  };
  async function toContent() {
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Type recipients" }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByLabelText("Email, recipient 1"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("First name, recipient 1"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email, recipient 2"), { target: { value: "grace@example.com" } });
    fireEvent.change(screen.getByLabelText("First name, recipient 2"), { target: { value: "Grace" } });
    fireEvent.click(screen.getByRole("button", { name: "Content" }));
  }

  it("cannot continue without a valid recipient", () => {
    make();
    expect((screen.getByRole("button", { name: "Content" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Add at least one valid recipient to continue.")).toBeTruthy();
  });

  it("previews the first recipient, switches recipient, then reviews, tests and sends after a confirmation", async () => {
    const a = make();
    await toContent();
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("dev@spicrawl.com");
    await waitFor(() => expect(a.preview).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(a.preview.mock.calls[0][1]).toMatchObject({ email: "ada@example.com", first_name: "Ada" });
    expect(await screen.findByText("Hello Ada")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Preview as"), { target: { value: "1" } });
    expect(await screen.findByText("Hello Grace", {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Personalization/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(a.create).toHaveBeenCalledWith(expect.objectContaining({ template_id: "t1" }), expect.any(Array), true), { timeout: 2000 });
    expect(await screen.findByText(/Paced at/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Send test to"), { target: { value: "me@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(a.sendTest).toHaveBeenCalledWith(expect.objectContaining({ to: ["me@example.com"], subject: "Hello Ada", template: { id: "t1", variables: { email: "ada@example.com", first_name: "Ada", data: {} } } })));

    fireEvent.click(screen.getByRole("button", { name: "Send to 2 recipients" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toContain("Send to 2 recipients?");
    expect(a.create).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), false);
    fireEvent.click(within(dlg).getByRole("button", { name: "Send to 2 recipients" }));
    await waitFor(() => expect(a.create).toHaveBeenCalledWith(expect.anything(), expect.any(Array), false));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/broadcasts/b9"));
  });

  it("shows the queuing orb beside the Send button while the broadcast is being created", async () => {
    const a = make();
    let finish!: (v: unknown) => void;
    a.create.mockImplementation((_d, _r, dry) => dry ? Promise.resolve({ data: plan }) : new Promise((res) => { finish = res; }));
    await toContent();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByText(/Paced at/, {}, { timeout: 2000 });
    expect(screen.queryByText("Queuing 2 emails…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send to 2 recipients" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Send to 2 recipients" }));
    const busy = await screen.findByText("Queuing 2 emails…");
    expect(busy.getAttribute("role")).toBe("status");
    expect(busy.querySelector("canvas")!.getAttribute("data-orb")).toBe("working");
    expect(busy.closest("button")).toBeNull(); // beside the button, not inside it
    await act(async () => finish({ data: { id: "b9", status: "queued", queued: 2, skipped: [] } }));
    await waitFor(() => expect(screen.queryByText("Queuing 2 emails…")).toBeNull());
    expect(push).toHaveBeenCalledWith("/broadcasts/b9");
  });

  it("shows the API error and does not leave the page when sending fails", async () => {
    const a = make();
    a.create.mockImplementation(async (_d, _r, dry) => (dry ? { data: plan } : { error: { code: "kill_switch_active", message: "the kill switch is engaged", hint: "a human must disengage it" } }));
    await toContent();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByText(/Paced at/, {}, { timeout: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "Send to 2 recipients" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Send to 2 recipients" }));
    expect((await screen.findByRole("alert")).textContent).toContain("kill_switch_active");
    expect(push).not.toHaveBeenCalled();
  });
});
