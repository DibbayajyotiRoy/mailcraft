// Assistant handles file attachments: CSV imports, HTML/MJML/text as email body, and JSON/HTML/MJML as template drafts.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runTurn } from "@/lib/assistant/loop";
import { resetScores } from "@/lib/assistant/models";
import { applyProposal, peekProposal } from "@/lib/assistant/proposals";
import type { Attachment, ChatEvent } from "@/lib/assistant/types";
import { API, calls, ctx, env, fakeWorld, MUTATING, text } from "./assistant-kit";

process.env.MAILCRAFT_ASSISTANT_BASE_URL = "http://or.test/api/v1";
beforeEach(() => { resetScores(); (globalThis as any).__mcReads?.clear(); (globalThis as any).__mcProposals?.clear(); });
afterEach(() => vi.unstubAllGlobals());

async function turn(content: string, attachments: Attachment[] = [], over: Partial<Parameters<typeof runTurn>[0]> = {}) {
  const ev: ChatEvent[] = [];
  for await (const e of runTurn({ history: [{ role: "user", content, attachments }], path: "/", ctx: ctx({ attachments }), key: "or-key", chain: ["m1:free"], firstTokenMs: 2000, ...over })) ev.push(e);
  return ev;
}
const proposals = (ev: ChatEvent[]) => ev.filter((e): e is Extract<ChatEvent, { type: "proposal" }> => e.type === "proposal").map((e) => e.proposal);

const csvAttachment: Attachment = {
  kind: "csv", name: "list.csv", count: 2, columns: ["email", "first_name"],
  summary: "2 contacts",
  rows: [{ email: "a@example.com", first_name: "Alice" }, { email: "b@example.com", first_name: "Bob" }],
};

const htmlAttachment: Attachment = { kind: "html", name: "body.html", content: "<h1>Hi {{ first_name }}</h1>" };

test("propose_import dry-runs the attached CSV and stores the import call", async () => {
  const w = fakeWorld([calls(["propose_import", { list_name: "Newsletter" }]), text("ok")], {
    "POST /v1/contacts/import": (b) => b.dry_run ? env({ dry_run: true, summary: { new: 2, update: 0, unchanged: 0, skipped: 0 }, list: { id: "l1", name: "Newsletter", exists: false }, rows: [{ index: 0, email: "a@example.com", status: "new" }, { index: 1, email: "b@example.com", status: "new" }] }) : env({ imported: 2, failed: [], list_id: "l1" }),
  });
  const ev = await turn("import this csv into Newsletter", [csvAttachment]);
  const [p] = proposals(ev);
  expect(p.kind).toBe("import");
  expect(p.title).toContain("Newsletter");
  expect(p.import?.summary).toEqual({ new: 2, update: 0, unchanged: 0, skipped: 0 });
  expect(w.rec.filter(MUTATING)).toEqual([]); // dry run only

  const r = await applyProposal("sid-1", p.id, { base: API, key: "mc_test_key" }, true);
  expect(r.status).toBe("completed");
  const mut = w.rec.filter(MUTATING);
  expect(mut).toHaveLength(1);
  expect(mut[0].body).toMatchObject({ contacts: [{ email: "a@example.com" }, { email: "b@example.com" }], list_name: "Newsletter" });
});

test("propose_email_body sends an attached HTML file", async () => {
  const w = fakeWorld([calls(["propose_email_body", { to: ["a@example.com"], from: "hello@example.com" }]), text("ok")], {
    "POST /v1/emails": (b) => env({ status: "queued", id: "e1" }),
    "GET /v1/senders": () => [],
  });
  const ev = await turn("send this html to a@example.com", [htmlAttachment]);
  const [p] = proposals(ev);
  expect(p.kind).toBe("email_body");
  expect(p.preview?.html).toBe("<h1>Hi {{ first_name }}</h1>");
});

test("propose_template_import saves an attached HTML file as a template draft", async () => {
  const w = fakeWorld([calls(["propose_template_import", { name: "Welcome draft" }]), text("ok")], {
    "POST /v1/content/lint": () => env({ lint: [] }),
    "POST /v1/templates/import": () => env({ id: "t-new", alias: "welcome-draft", name: "Welcome draft" }),
  });
  const ev = await turn("save this html as a template named Welcome draft", [htmlAttachment]);
  const [p] = proposals(ev);
  expect(p.kind).toBe("template");
  expect(p.title).toContain("Welcome draft");
});
