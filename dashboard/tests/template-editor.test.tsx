import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn(), push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/actions", () => ({ createKey: vi.fn(), importTemplate: vi.fn() }));
const actions = vi.hoisted(() => ({
  saveTemplate: vi.fn(async (_i: any): Promise<any> => ({ version: 4, warnings: [] })),
  updateTemplateDetails: vi.fn(async (_i: any): Promise<any> => ({})),
  publishTemplate: vi.fn(), discardDraft: vi.fn(), restoreVersion: vi.fn(),
  createTemplate: vi.fn(async (_p: unknown, _d: FormData): Promise<any> => ({})),
}));
vi.mock("@/app/(app)/templates/actions", () => actions);

import { toast } from "@/components/ui/toast";
import { CodeArea } from "@/app/(app)/templates/[id]/CodeArea";
import { DraftState } from "@/app/(app)/templates/[id]/DraftState";
import { TemplateEditor } from "@/app/(app)/templates/[id]/TemplateEditor";
import { VersionsPanel } from "@/app/(app)/templates/[id]/VersionsPanel";
import { NewTemplate } from "@/app/(app)/templates/NewTemplate";
import { BLANK_MJML, contentBody, indentEdit, isUnpublished, nest, sampleVariables, sourceOf } from "@/app/(app)/templates/[id]/util";

const tpl = (over: object = {}) => ({
  id: "t1", alias: "welcome", name: "Welcome", stream: "transactional", status: "published", version: 3, published_version: 2,
  subject: "Hi {{ first_name }}", preheader: "", source_format: "html", source: "<p>Hello {{ first_name }} {{ amount }}</p>", variables: ["first_name", "amount"], ...over,
});
const PREVIEW = { subject: "Hi Ana", html: "<p>saved</p>", lint: [], variables: ["first_name", "amount"] };
const ok = (data: object) => ({ json: async () => ({ data, error: null }) });
let fetchMock: ReturnType<typeof vi.fn>;

function editor(t = tpl(), extra: Partial<Parameters<typeof TemplateEditor>[0]> = {}) {
  const onClose = vi.fn();
  render(<TemplateEditor template={t} values={{}} onValuesChange={vi.fn()} initial={{ preview: PREVIEW }} onClose={onClose} {...extra} />);
  return { onClose, box: () => screen.getByLabelText(/source$/) as HTMLTextAreaElement };
}
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => {
  fetchMock = vi.fn(async () => ok({ ...PREVIEW, html: "<p>live</p>" }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("editor helpers", () => {
  it("Tab inserts two spaces at the caret, indents a selection and outdents with Shift+Tab", () => {
    expect(indentEdit("ab", 1, 1, false)).toMatchObject({ from: 1, to: 1, text: "  ", selStart: 3 });
    const sel = indentEdit("a\nb\nc", 0, 3, false); // selects "a\nb"
    expect(sel).toMatchObject({ from: 0, to: 3, text: "  a\n  b" });
    expect(indentEdit("  a\n  b", 0, 7, true).text).toBe("a\nb");
    expect(indentEdit("   x", 4, 4, true).text).toBe(" x"); // removes at most two
    expect(indentEdit("a\nb", 0, 2, false).text).toBe("  a"); // a selection ending at a line start leaves that line alone
  });
  it("sends subject only where the source does not own it, and preheader only where it renders", () => {
    const d = { body: "<p>x</p>", subject: "S", preheader: "P" };
    expect(contentBody({ format: "json", ...d })).toEqual({ format: "json", content: "<p>x</p>" });
    expect(contentBody({ format: "mjml", ...d })).toEqual({ format: "mjml", content: "<p>x</p>", subject: "S", preheader: "P" });
    expect(contentBody({ format: "html", ...d })).toMatchObject({ preheader: "P" });
    expect(contentBody({ format: "html", ...d, body: "<!DOCTYPE html><html></html>" })).not.toHaveProperty("preheader");
  });
  it("fills the preview values: typed value, else [name] for your variables, platform ones left to the server", () => {
    expect(sampleVariables(["amount", "first_name", "order.id"], { order: "x", "order.id": "42" })).toEqual({ amount: "[amount]", order: { id: "42" } });
    expect(nest({ "a.b": "1", "a.c": "2" })).toEqual({ a: { b: "1", c: "2" } });
  });
  it("opens the author's source, falling back to the block tree; knows a draft from a live version", () => {
    expect(sourceOf(tpl())).toEqual({ format: "html", text: "<p>Hello {{ first_name }} {{ amount }}</p>" });
    expect(sourceOf({ template: { version: 1, blocks: [] } })).toMatchObject({ format: "json" });
    expect([isUnpublished({ version: 3, published_version: 2 }), isUnpublished({ version: 2, published_version: 2 }), isUnpublished({ version: 1, published_version: null })]).toEqual([true, false, true]);
  });
  it("blank starter is MJML with a subject and a merge field", () => {
    expect(BLANK_MJML).toContain("<mj-title>");
    expect(BLANK_MJML).toContain("{{ first_name }}");
  });
});

describe("code box", () => {
  it("shows a line count and indents on Tab; Esc then Tab leaves the box", () => {
    let v = "a\nb";
    const { rerender } = render(<CodeArea value={v} onChange={(n) => (v = n)} label="HTML source" />);
    expect(screen.getByTestId("gutter").textContent).toBe("1\n2");
    expect(screen.getByTestId("code-status").textContent).toContain("2 lines");
    const ta = screen.getByLabelText("HTML source") as HTMLTextAreaElement;
    ta.setSelectionRange(0, 0);
    expect(fireEvent.keyDown(ta, { key: "Tab" })).toBe(false); // default prevented: focus stays, spaces inserted
    expect(v).toBe("  a\nb");
    rerender(<CodeArea value={v} onChange={(n) => (v = n)} label="HTML source" />);
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(fireEvent.keyDown(ta, { key: "Tab" })).toBe(true); // browser moves focus
    expect(v).toBe("  a\nb");
  });
});

describe("TemplateEditor", () => {
  it("opens the template in its own source format with subject and the unpublished-draft state", () => {
    const { box } = editor();
    expect(box().value).toBe("<p>Hello {{ first_name }} {{ amount }}</p>");
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Hi {{ first_name }}");
    expect(screen.getByText("Draft v3 unpublished")).toBeTruthy();
    expect(screen.getByText("Live:").textContent).toContain("v2");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.getByRole("button", { name: "Save draft" }).hasAttribute("disabled")).toBe(true);
  });

  it("Save adds a draft: sends the source with subject + preheader, clears the dirty state", async () => {
    const { box } = editor();
    type(box(), "<p>Edited</p>");
    type(screen.getByLabelText("Subject"), "New subject");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" }).hasAttribute("disabled")).toBe(true); // save first
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(actions.saveTemplate).toHaveBeenCalledTimes(1));
    expect(actions.saveTemplate.mock.calls[0][0]).toEqual({ id: "t1", draft: { format: "html", body: "<p>Edited</p>", subject: "New subject", preheader: "" } });
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("draft v4"));
    expect(refresh).toHaveBeenCalled();
  });

  it("Ctrl/Cmd+S saves and swallows the browser's own save", async () => {
    const { box } = editor();
    type(box(), "<p>Edited</p>");
    const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true, bubbles: true });
    act(() => { document.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(actions.saveTemplate).toHaveBeenCalledTimes(1));
    type(box(), "<p>Again</p>");
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "S", metaKey: true, cancelable: true, bubbles: true })); });
    await waitFor(() => expect(actions.saveTemplate).toHaveBeenCalledTimes(2));
  });

  it("shows the API's error and stays dirty when the save fails", async () => {
    actions.saveTemplate.mockResolvedValueOnce({ error: { code: "invalid_request", message: "mjml: no <mj-body>" } });
    const { box } = editor(tpl({ source_format: "mjml", source: "<mjml></mjml>" }));
    type(box(), "<mjml><mj-body></mj-body></mjml> ");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect((await screen.findByText("mjml: no <mj-body>"))).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(toast.error).toHaveBeenCalled();
  });

  describe("unsaved-changes guard", () => {
    it("asks the browser before unloading only while there are unsaved edits", () => {
      const { box } = editor();
      const unload = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
      expect(unload()).toBe(false);
      type(box(), "<p>Edited</p>");
      expect(unload()).toBe(true);
      type(box(), tpl().source); // back to what is saved
      expect(unload()).toBe(false);
    });

    it("confirms before an in-app link navigates; Keep editing stays, Discard leaves", async () => {
      render(<a href="/emails" onClick={(e) => e.preventDefault()}>Emails</a>); // jsdom cannot navigate
      const { box } = editor();
      fireEvent.click(screen.getByText("Emails")); // clean: no guard
      expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
      type(box(), "<p>Edited</p>");
      fireEvent.click(screen.getByText("Emails"));
      expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(push).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText("Emails"));
      fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
      expect(push).toHaveBeenCalledWith("/emails");
    });

    it("Close asks first when dirty, and closes at once when clean", async () => {
      const { box, onClose } = editor();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      type(box(), "<p>Edited</p>");
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
      expect(onClose).toHaveBeenCalledTimes(2);
    });
  });

  describe("live preview", () => {
    it("renders once, after typing pauses, with the latest text and the sample values", async () => {
      vi.useFakeTimers();
      const { box } = editor(tpl(), { values: { amount: "$5" } });
      expect(fetchMock).not.toHaveBeenCalled(); // the saved version arrived rendered
      type(box(), "<p>a</p>");
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      type(box(), "<p>ab</p>");
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      type(box(), "<p>abc {{ amount }}</p>");
      await act(async () => { await vi.advanceTimersByTimeAsync(599); });
      expect(fetchMock).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/templates/t1/preview");
      expect(JSON.parse(init.body as string)).toEqual({ variables: { amount: "$5" }, format: "html", content: "<p>abc {{ amount }}</p>", subject: "Hi {{ first_name }}", preheader: "" });
      expect((screen.getByTitle("Live template preview") as HTMLIFrameElement).getAttribute("srcdoc")).toBe("<p>live</p>");
    });

    it("updates lint from the response and keeps the last good render when the text does not compile", async () => {
      vi.useFakeTimers();
      const { box } = editor();
      fetchMock.mockResolvedValueOnce(ok({ ...PREVIEW, html: "<p>v2</p>", lint: [{ rule: "image_missing_alt", severity: "warning", message: "image has no alt text", path: "blocks[0]" }] }));
      type(box(), "<img src='https://x.test/a.png'>");
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(screen.getByText("image has no alt text")).toBeTruthy();
      fetchMock.mockResolvedValueOnce({ json: async () => ({ data: null, error: { code: "template_render_failed", message: "mjml compile failed" } }) });
      type(box(), "<img src='https://x.test/a.png'><");
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(screen.getByText("mjml compile failed")).toBeTruthy();
      expect((screen.getByTitle("Live template preview") as HTMLIFrameElement).getAttribute("srcdoc")).toBe("<p>v2</p>");
    });

    it("block JSON is checked in the browser: bad JSON disables Save and sends nothing", async () => {
      vi.useFakeTimers();
      const { box } = editor(tpl({ source_format: "json", source: '{"version":1,"subject":"S","blocks":[]}' }));
      expect(screen.queryByLabelText("Subject")).toBeNull(); // the JSON owns subject and preheader
      type(box(), '{"version":1,');
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByText(/This is not valid JSON/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save draft" }).hasAttribute("disabled")).toBe(true);
      type(box(), '{"version":1,"subject":"T","blocks":[]}');
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({ format: "json", content: '{"version":1,"subject":"T","blocks":[]}' });
    });

    it("switches the preview width between desktop and mobile", () => {
      editor();
      const frame = screen.getByTitle("Live template preview") as HTMLIFrameElement;
      expect(frame.style.width).toBe("100%");
      fireEvent.click(screen.getByRole("radio", { name: "Mobile" }));
      expect(frame.style.width).toBe("375px");
    });
  });
});

describe("draft and versions", () => {
  it("Discard draft only appears with a live version to fall back to, and asks first", async () => {
    const { unmount } = render(<DraftState template={tpl()} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(await screen.findByText("Discard the draft?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" })); // the dialog's confirm button (the page behind it is inert)
    await waitFor(() => expect(actions.discardDraft).toHaveBeenCalledTimes(1));
    expect((actions.discardDraft.mock.calls[0][0] as unknown as FormData).get("id")).toBe("t1");
    unmount();
    render(<DraftState template={tpl({ version: 2, published_version: 2 })} />);
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
    expect(screen.queryByText(/unpublished/)).toBeNull();
  });

  it("lists versions and restores an old one (not the newest)", async () => {
    const versions = [
      { version: 3, source_format: "html", created_at: "2026-10-27T10:00:00Z", published_at: null, published: false },
      { version: 2, source_format: "html", created_at: "2026-10-26T10:00:00Z", published_at: "2026-10-26T11:00:00Z", published: true },
      { version: 1, source_format: "mjml", created_at: "2026-10-25T10:00:00Z", published_at: null, published: false },
    ];
    render(<VersionsPanel template={tpl()} versions={versions} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("Draft")).toBeTruthy();
    expect(within(rows[1]).getByText("Live")).toBeTruthy();
    expect(within(rows[0]).queryByRole("button", { name: /Restore/ })).toBeNull();
    fireEvent.click(within(rows[2]).getByRole("button", { name: "Restore v1" }));
    await waitFor(() => expect(actions.restoreVersion).toHaveBeenCalledTimes(1));
    const fd = actions.restoreVersion.mock.calls[0][0] as unknown as FormData;
    expect([fd.get("id"), fd.get("version")]).toEqual(["t1", "1"]);
  });
});

describe("New template", () => {
  const open = () => { render(<NewTemplate />); fireEvent.click(screen.getByRole("button", { name: "New template" })); };

  it("blank start needs only a name and asks the server for an MJML starter", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Create and edit" }));
    expect(await screen.findByText("Give the template a name.")).toBeTruthy();
    expect(actions.createTemplate).not.toHaveBeenCalled();
    type(screen.getByLabelText("Name"), "Welcome");
    fireEvent.click(screen.getByRole("button", { name: "Create and edit" }));
    await waitFor(() => expect(actions.createTemplate).toHaveBeenCalledTimes(1));
    const fd = actions.createTemplate.mock.calls[0][1];
    expect([fd.get("name"), fd.get("start"), fd.get("content")]).toEqual(["Welcome", "blank", null]);
  });

  it("paste HTML / MJML require the pasted source", async () => {
    open();
    type(screen.getByLabelText("Name"), "Receipt");
    fireEvent.click(screen.getByRole("radio", { name: "Paste HTML" }));
    fireEvent.click(screen.getByRole("button", { name: "Create and edit" }));
    expect(await screen.findByText("Paste the template or choose a file.")).toBeTruthy();
    expect(actions.createTemplate).not.toHaveBeenCalled();
    type(screen.getByLabelText("HTML"), "<p>Hi</p>");
    fireEvent.click(screen.getByRole("button", { name: "Create and edit" }));
    await waitFor(() => expect(actions.createTemplate).toHaveBeenCalledTimes(1));
    const fd = actions.createTemplate.mock.calls[0][1];
    expect([fd.get("start"), fd.get("content")]).toEqual(["html", "<p>Hi</p>"]);
    fireEvent.click(screen.getByRole("radio", { name: "Paste MJML" }));
    expect(screen.getByLabelText("MJML")).toBeTruthy();
  });

  it("shows the server's refusal (e.g. the alias is taken) inside the dialog", async () => {
    actions.createTemplate.mockResolvedValueOnce({ error: { code: "template_exists", message: "a template with alias `welcome` already exists" } });
    open();
    type(screen.getByLabelText("Name"), "Welcome");
    fireEvent.click(screen.getByRole("button", { name: "Create and edit" }));
    expect(await screen.findByText(/already exists/)).toBeTruthy();
  });
});
