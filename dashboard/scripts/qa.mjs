// Visual + a11y QA against a running dashboard and scripts/mock-api.mjs:
//   node scripts/qa.mjs <baseUrl> [shotsDir] [--no-shots] [--modes=light,dark,forced,reduced] [--widths=1440,390] [--only=substr[,substr...]]
// Every route x mode x width: load + short wait (not networkidle), axe WCAG 2.2 AA (iframes excluded: sandboxed email previews),
// exit 1 on any serious/critical violation, horizontal page overflow or console page error.
// Screenshots are taken for the light and dark modes only.
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
const [base, dir = "shots"] = args.filter((a) => !a.startsWith("--"));
const MODES = flag("modes", "light,dark,forced,reduced").split(",");
const WIDTHS = flag("widths", "1440,390").split(",").map(Number);
const only = flag("only", "").split(",").filter(Boolean); // substrings of route names, any one matches
const shots = !args.includes("--no-shots");
const API = process.env.MOCK_API || "http://localhost:18080";
if (shots) mkdirSync(dir, { recursive: true });

const click = (role, name, nth) => async (p) => { const l = p.getByRole(role, { name }); await (nth ? l.nth(nth) : l.first()).click(); };
const CSV = "email,first_name,last_name,company\nada@example.com,Ada,Lovelace,Analytical Engines\ngrace@example.com,Grace,Hopper,Navy\nlinus@example.com,,Torvalds,\n";
const upload = async (p) => { await p.getByLabel("CSV file").setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) }); await p.waitForTimeout(300); };
const toContent = async (p) => { await upload(p); await p.getByRole("button", { name: /^Content/ }).click(); await p.waitForTimeout(2200); };
const toReview = async (p) => { await toContent(p); await p.getByRole("button", { name: /^Review/ }).click(); await p.waitForTimeout(1500); };
const wait = (ms) => (p) => p.waitForTimeout(ms);
const seq = (...acts) => async (p) => { for (const a of acts) await a(p); };
const edit = (text) => async (p) => { await p.getByRole("textbox", { name: /source$/ }).fill(text); await p.waitForTimeout(1000); }; // past the 600ms preview debounce
const previewPane = async (p) => { const b = p.getByRole("radio", { name: "Preview", exact: true }); if (await b.isVisible()) await b.click(); }; // the Code/Preview switch exists below 1024px only
// Assistant panel: needs the dashboard started with OPENROUTER_API_KEY=mock and MAILCRAFT_ASSISTANT_BASE_URL=<mock-api>/openrouter/api/v1.
const fresh = async (p) => { await p.evaluate(() => sessionStorage.clear()); await p.reload({ waitUntil: "load" }); await p.waitForTimeout(300); };
const openAssistant = async (p) => { await fresh(p); await p.getByRole("button", { name: "Assistant" }).click(); await p.getByRole("dialog").waitFor(); await p.waitForTimeout(500); };
const ask = (text) => async (p) => { await openAssistant(p); await p.getByLabel("Message the assistant").fill(text); await p.getByRole("button", { name: "Send message" }).click(); await p.getByRole("button", { name: "Send message" }).waitFor({ timeout: 20000 }); await p.waitForTimeout(500); };
const typeInto = (text) => async (p) => { await openAssistant(p); await p.getByLabel("Message the assistant").pressSequentially(text); await p.waitForTimeout(500); };
const dlg = (p) => p.getByRole("dialog");
const inDlg = (role, name) => async (p) => { await dlg(p).getByRole(role, { name }).first().click(); };
const fillIn = (label, value) => async (p) => { await dlg(p).getByLabel(label, { exact: true }).fill(value); };
// The CSV import dialog: a paste that exercises every diff status (new, update, unchanged, skipped by the server, skipped by the browser) and the list step.
const IMPORT_CSV = "email,first_name,last_name,timezone,plan,seats\nana@example.com,Ana,Silva-Costa,Europe/Berlin,pro,6\nben@example.com,Ben,,,free,\nnia@example.com,Nia,Okoro,Africa/Lagos,pro,3\nomar@example.com,Omar,,,free,1\nbad@example.com,Bo,,,free,1\nnot-an-email,X,,,free,2\n";
const pasteImport = async (p) => { await click("button", "Import CSV")(p); await p.getByLabel("Or paste the CSV").fill(IMPORT_CSV); await p.waitForTimeout(1400); }; // 350ms debounce + the dry run + the 700ms settle animation
const pickList = (value) => async (p) => { await p.getByLabel("List", { exact: true }).selectOption(value); await p.waitForTimeout(1400); };
const tick = (email) => async (p) => { await p.getByRole("checkbox", { name: `Select ${email}` }).check(); };
const filterRows = (name) => async (p) => { await p.getByRole("radio", { name }).click(); await p.waitForTimeout(900); };
/** Opens New email and types into To (and waits out the 250ms suggestion debounce). */
const composeTo = async (p, text, open = true) => { if (open) await click("button", "New email")(p); await p.getByRole("dialog").getByRole("combobox", { name: "To" }).pressSequentially(text); await p.waitForTimeout(450); };
// "Write with AI" in the New email dialog: needs the same dashboard start as the assistant routes (OPENROUTER_API_KEY=mock, MAILCRAFT_ASSISTANT_BASE_URL=<mock-api>/openrouter/api/v1).
// In the mock, `qa:hold` stalls the stream mid-body (the "writing" state stays on screen) and `qa:fail` answers 429.
const AI_BOX = "What should this email say?";
const aiOpen = async (p, template) => {
  await click("button", "New email")(p);
  if (template) { await dlg(p).getByRole("tab", { name: "Use a template" }).click(); await dlg(p).getByLabel("Template", { exact: true }).selectOption(template); }
  await dlg(p).getByRole("button", { name: "Write with AI" }).click();
  await dlg(p).getByLabel(AI_BOX).waitFor();
};
const aiPrompt = async (p) => { await aiOpen(p); for (const t of ["Friendly", "Short", "Formal"]) await dlg(p).getByRole("button", { name: t, exact: true }).waitFor(); };
const aiWrite = (prompt, until, template) => async (p) => { await aiOpen(p, template); await dlg(p).getByLabel(AI_BOX).fill(prompt); await dlg(p).getByLabel(AI_BOX).press("Enter"); await until(p); };
// [name, path, action?]  action = open a dialog/tab before the capture
const ROUTES = [
  ["overview", "/"], ["overview-30d", "/?range=30d"],
  ["emails", "/emails"], ["email-compose", "/emails", click("button", "New email")], ["emails-bounced", "/emails?status=bounced"], ["emails-nomatch", "/emails?q=zzzz"], ["emails-peek", "/emails?open=em_02"],
  ["email-detail", "/emails/em_00"], ["email-bounce", "/emails/em_02"], ["email-pending", "/emails/em_07"],
  ["approvals", "/approvals"],
  ["templates", "/templates"], ["template-detail", "/templates/t2"], ["template-lint", "/templates/t2", click("tab", /Lint/)],
  ["template-variables", "/templates/t2", click("tab", /Variables/)], ["template-import", "/templates", click("button", "Import template")],
  ["personalization", "/templates/t2", click("button", "Personalization")],
  ["broadcasts", "/broadcasts"], ["broadcast-new", "/broadcasts/new"], ["broadcast-typed", "/broadcasts/new", click("tab", "Type recipients")], ["broadcast-csv", "/broadcasts/new", upload],
  ["broadcast-content", "/broadcasts/new", toContent], ["broadcast-review", "/broadcasts/new", toReview],
  ["broadcast-confirm", "/broadcasts/new", async (p) => { await toReview(p); await p.getByRole("button", { name: /^Send to 3/ }).click(); }],
  ["broadcast-detail", "/broadcasts/b1"], ["broadcast-bounced", "/broadcasts/b1?status=bounced"], ["broadcast-pending", "/broadcasts/b3"],
  ["template-versions", "/templates/t2", click("tab", /Versions/)], ["template-source", "/templates/t2", click("tab", "Source")],
  ["template-settings", "/templates/t2", click("button", "Template settings")], ["template-discard", "/templates/t2", seq(click("tab", /Versions/), click("button", "Discard draft"))],
  ["template-new", "/templates", click("button", "New template")], ["template-new-html", "/templates", seq(click("button", "New template"), click("radio", "Paste HTML"))],
  ["template-edit-html", "/templates/t2?edit=1"], ["template-edit-html-preview", "/templates/t2?edit=1", previewPane],
  ["template-edit-mjml", "/templates/t1?edit=1"], ["template-edit-json", "/templates/t3?edit=1"],
  ["template-edit-lint", "/templates/t2?edit=1", seq(edit('<html><body><h1>Hi {{ first_name }}</h1><img src="http://x.test/a.png"><a href="http://x.test">Go</a></body></html>'), previewPane)],
  ["template-edit-error", "/templates/t2?edit=1", seq(edit("<p>BROKEN</p>"), previewPane)],
  ["template-edit-guard", "/templates/t2?edit=1", seq(edit("<p>unsaved</p>"), click("link", "Templates"))],
  ["automations", "/automations"], ["automation-confirm", "/automations", click("switch", /.*/)],
  ["automations-archived", "/automations?archived=1"], ["automation-new", "/automations/new"], ["automation-new-welcome", "/automations/new?preset=welcome"], ["automation-new-nudge", "/automations/new?preset=nudge"],
  ["automation-new-errors", "/automations/new?preset=blank", click("button", "Save as draft")], ["automation-add-step", "/automations/new?preset=welcome", click("button", "Add step")],
  ["automation-edit", "/automations/a1/edit"], ["automation-edit-paused", "/automations/a2/edit"], ["automation-duplicate", "/automations/new?from=a1"], ["automation-archived", "/automations/a4"],
  ["automation-test-run", "/automations/a1", async (p) => { await p.getByRole("button", { name: "Test run" }).click(); await p.getByLabel("Contact email").fill("you@example.com"); await p.getByRole("button", { name: "Start test run" }).click(); await p.getByRole("list", { name: "Run log" }).waitFor(); }],
  ["automation-test-form", "/automations/a1", click("button", "Test run")],
  ["automation-run-log", "/automations/a1", async (p) => { await p.getByRole("tab", { name: /Runs/ }).click(); await p.getByRole("button", { name: /View run ana@example.com/ }).first().click(); await p.getByRole("list", { name: "Run log" }).waitFor(); }],
  // Flow view: the toggle is clicked so 390px shows the chart too (it defaults to Steps below 1024px).
  ["automation-flow", "/automations/a1", click("radio", "Flow")], ["automation-flow-steps", "/automations/a1", click("radio", "Steps")],
  ["automation-flow-branches", "/automations/a5", click("radio", "Flow")], ["automation-flow-wait", "/automations/a2", click("radio", "Flow")], ["automation-flow-trigger-only", "/automations/a3", click("radio", "Flow")],
  ["automation-flow-jump", "/automations/a5", async (p) => { await click("radio", "Flow")(p); await p.getByRole("button", { name: /trial-offer/ }).click(); await p.waitForTimeout(600); }],
  ["automation-flow-zoom", "/automations/a5", async (p) => { await click("radio", "Flow")(p); await click("button", "Zoom in")(p); await click("button", "Zoom in")(p); }],
  ["automation-edit-preview", "/automations/a5/edit"],
  ["automation-detail", "/automations/a1"], ["automation-runs", "/automations/a1", click("tab", /Runs/)], ["automation-settings", "/automations/a1", click("tab", "Settings")],
  ["contacts", "/contacts"], ["segments", "/contacts?tab=segments"], ["contacts-error", "/contacts?err=" + encodeURIComponent("invalid_state|automation(s) still use this segment: welcome|change or delete those automations first")],
  ["contact-detail", "/contacts/c1"], ["contact-suppressed", "/contacts/c3"], ["contact-notfound", "/contacts/zzz"],
  ["contact-add", "/contacts", click("button", "Add contact")], ["contact-add-attrs", "/contacts", async (p) => { await click("button", "Add contact")(p); await click("button", "Add attribute")(p); await click("button", "Add attribute")(p); }],
  ["contact-add-invalid", "/contacts", async (p) => { await click("button", "Add contact")(p); await p.getByLabel("Email").fill("nope"); await p.getByRole("button", { name: "Add contact" }).last().click(); }],
  ["contact-edit", "/contacts/c1", click("button", "Edit")], ["contact-track", "/contacts/c1", click("button", "Track event")],
  ["contact-delete", "/contacts/c1", click("button", "Delete contact")], ["contact-suppress", "/contacts/c1", click("button", "Suppress")], ["contact-unsuppress", "/contacts/c3", click("button", "Remove suppression")],
  ["contacts-import", "/contacts", click("button", "Import CSV")],
  ["contacts-import-preview", "/contacts", async (p) => { await click("button", "Import CSV")(p); await p.getByLabel("Or paste the CSV").fill("email,first_name,plan,seats\nnew@example.com,Nia,pro,3\nbad@example.com,Bo,free,1\nnot-an-email,X,free,2\nnew@example.com,Dup,pro,1"); await p.waitForTimeout(1400); }],
  ["segment-new", "/contacts?tab=segments", click("button", "New segment")],
  ["segment-new-conditions", "/contacts?tab=segments", async (p) => { await click("button", "New segment")(p); await p.getByLabel("Name", { exact: true }).fill("Dormant pros"); await p.getByLabel("Condition 1 attribute name").fill("plan"); await p.getByLabel("Condition 1 value", { exact: true }).fill("pro"); await click("button", "Add condition")(p); await p.getByLabel("Condition 2 type").selectOption("event"); await p.getByLabel("Condition 2 event name").fill("login"); await p.getByLabel("Condition 2 operator").selectOption("notwithin"); await p.getByLabel("Condition 2 number of days").fill("30"); await p.waitForTimeout(900); }],
  ["segment-edit", "/contacts?tab=segments", click("button", "Edit Pro customers")], ["segment-edit-json", "/contacts?tab=segments", click("button", "Edit EU or UK")],
  ["segment-delete", "/contacts?tab=lists", click("button", "Delete Nudged")], ["segment-members", "/contacts?tab=lists", click("button", "Add contacts to Nudged")],
  // contact sources (Settings)
  ["sources", "/settings#sources"],
  ["source-add", "/settings", click("button", "Add source")],
  ["source-add-test-ok", "/settings", seq(click("button", "Add source"), fillIn("Name", "Acme CRM"), fillIn("URL", "http://crm.internal:8080/contacts"), fillIn("API key", "sk_test_123"), inDlg("button", "Test connection"))],
  ["source-add-test-fail", "/settings", seq(click("button", "Add source"), fillIn("Name", "Acme CRM"), fillIn("URL", "http://refused.internal/contacts"), fillIn("API key", "sk_test_123"), inDlg("button", "Test connection"))],
  ["source-add-conflict", "/settings", seq(click("button", "Add source"), fillIn("Name", "Acme app"), fillIn("URL", "http://crm.internal:8080/contacts"), fillIn("API key", "sk_test_123"), fillIn("List name", "Acme app users"), async (p) => { await dlg(p).getByRole("button", { name: "Add source" }).click(); })],
  ["source-edit", "/settings", click("button", "Edit Acme app")],
  ["source-test", "/settings", click("button", "Test connection Acme app")],
  ["source-sync", "/settings", seq(click("button", "Sync now Acme app"), wait(600))],
  ["source-sync-error", "/settings", seq(click("button", "Sync now Billing system"), wait(600))],
  ["source-preview", "/settings", seq(click("button", /^Preview the next sync of Acme app/), wait(1400))],
  ["source-preview-new", "/settings", seq(click("button", /^Preview the next sync of Marketing site/), wait(1400))],
  ["source-preview-filter", "/settings", seq(click("button", /^Preview the next sync of Acme app/), wait(1000), filterRows(/^Updates/))],
  ["source-preview-error", "/settings", seq(click("button", /^Preview the next sync of Billing system/), wait(600))],
  ["source-delete", "/settings", click("button", "Delete Acme app")],
  ["source-delete-list", "/settings", seq(click("button", "Delete Marketing site"), async (p) => { await dlg(p).getByRole("checkbox").check(); })],
  // lists
  ["contacts-list", "/contacts?list=l1"], ["contacts-list-manual", "/contacts?list=l5"], ["contacts-list-empty", "/contacts?list=l3"], ["contacts-list-search", "/contacts?list=l1&q=ana"],
  ["lists", "/contacts?tab=lists"], ["list-new", "/contacts?tab=lists", click("button", "New list")],
  ["list-new-conflict", "/contacts?tab=lists", seq(click("button", "New list"), fillIn("Display name", "Beta testers"), async (p) => { await dlg(p).getByRole("button", { name: "Create list" }).click(); })],
  ["list-edit", "/contacts?tab=lists", click("button", "Edit Webinar Oct 2026")], ["list-edit-source", "/contacts?tab=lists", click("button", "Edit Acme app users")],
  ["list-delete", "/contacts?tab=lists", click("button", "Delete Webinar Oct 2026")], ["list-delete-detached", "/contacts?tab=lists", click("button", "Delete Old CRM")],
  ["list-tooltip", "/contacts?tab=lists", async (p) => { await p.locator("span[tabindex='0']:has(button[disabled])").first().focus(); await p.waitForTimeout(300); }],
  ["badges-more", "/contacts", async (p) => { await p.locator("span[tabindex='0']:has-text('+1')").first().focus(); await p.waitForTimeout(300); }],
  // add contacts to a list
  ["contacts-bulk", "/contacts", tick("ana@example.com")],
  ["contacts-bulk-add", "/contacts", seq(tick("ana@example.com"), tick("ben@example.com"), click("button", "Add to list"))],
  ["contacts-bulk-add-new", "/contacts", seq(tick("ben@example.com"), click("button", "Add to list"), async (p) => { await dlg(p).getByLabel("List", { exact: true }).selectOption("new"); })],
  ["contacts-bulk-add-conflict", "/contacts", seq(tick("ben@example.com"), click("button", "Add to list"), async (p) => { await dlg(p).getByLabel("List", { exact: true }).selectOption("new"); await dlg(p).getByLabel("New list name").fill("Nudged"); await dlg(p).getByRole("button", { name: /^Add 1 contact/ }).click(); })],
  ["contacts-list-bulk", "/contacts?list=l5", tick("ana@example.com")],
  ["contact-lists-add", "/contacts/c3", click("button", "Add to list")],
  // import into a list, with the diff preview
  ["contacts-import-list", "/contacts", pasteImport],
  ["contacts-import-list-existing", "/contacts", seq(pasteImport, pickList("l4"))],
  ["contacts-import-list-none", "/contacts", seq(pasteImport, pickList(""))],
  ["contacts-import-list-filter", "/contacts", seq(pasteImport, filterRows(/^Updates/))],
  ["contacts-import-list-skipped", "/contacts", seq(pasteImport, filterRows(/^Skipped/))],
  ["contacts-import-list-done", "/contacts", seq(pasteImport, click("button", /^Import 5 contacts/), wait(600))],
  ["domains", "/domains"], ["keys", "/keys"], ["keys-create", "/keys", click("button", /Create (your first )?key|New key|Create/)],
  ["assistant-empty", "/", openAssistant], ["assistant-email-page", "/emails/em_02", openAssistant],
  ["assistant-automation", "/", ask("Set up a welcome email for new signups")], ["assistant-fix-template", "/", ask("Fix the lint errors in the promo template")],
  ["assistant-broadcast", "/", ask("Send the welcome template to my webinar list")], ["assistant-chat", "/", ask("hello")],
  ["assistant-slash", "/", typeInto("/")], ["assistant-mention", "/", typeInto("send @")],
  ["settings", "/settings"], ["settings-senders-edit", "/settings", click("button", /Edit addresses of dev@example.com/)], ["settings-senders-connect", "/settings", click("button", "Connect a mailbox")],
  ["email-compose-other-from", "/emails", async (p) => { await click("button", "New email")(p); await p.getByRole("dialog").getByLabel("From", { exact: true }).selectOption({ label: "Other address…" }); }],
  ["email-compose-suggest", "/emails", async (p) => { await composeTo(p, "an"); await p.getByRole("option", { name: /Ana Silva/ }).waitFor(); await p.keyboard.press("ArrowDown"); }],
  ["email-compose-chips", "/emails", async (p) => { await composeTo(p, "ana@example.com,"); await p.getByRole("dialog").getByLabel("To", { exact: true }).fill("nope,"); await p.waitForTimeout(200); }],
  ["email-compose-suppressed", "/emails", async (p) => { await composeTo(p, "bounce"); await p.getByRole("option", { name: /bounce@example.com/ }).click(); }],
  ["email-compose-new-contacts", "/emails", async (p) => { await composeTo(p, "new@example.com,"); await composeTo(p, "newer@example.com,", false); const d = p.getByRole("dialog"); await d.getByLabel("Subject").fill("Hello"); await d.getByLabel("Message", { exact: true }).fill("Hi there"); await d.getByRole("button", { name: "Send email" }).click(); await d.getByRole("button", { name: "Create 2 contacts and send" }).waitFor(); }],
  ["email-compose-ai-prompt", "/emails", aiPrompt],
  ["email-compose-ai-writing", "/emails", aiWrite("Invite Ana to Thursday's demo qa:hold", (p) => p.getByText("Writing body…").first().waitFor())],
  ["email-compose-ai-template-writing", "/emails", aiWrite("Invite Ana to Thursday's demo qa:hold", (p) => p.getByText(/^Filling /).first().waitFor(), "t2")], // t2 "Receipt" has two variables (first_name, amount)
  ["email-compose-ai-done", "/emails", aiWrite("Invite Ana to Thursday's demo", (p) => p.getByRole("button", { name: "Regenerate" }).waitFor())],
  ["email-compose-ai-error", "/emails", aiWrite("qa:fail", (p) => p.getByRole("alert").filter({ hasText: /\S/ }).first().waitFor())], // not the empty Next route announcer
  ["notfound", "/nope"], ["design", "/dev/design"],
].filter(([n]) => !only.length || only.some((o) => n.includes(o)));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let bad = 0;
const report = (msg) => { bad++; console.error(`  ! ${msg}`); };

async function run(mode, w, h) {
  const dark = mode === "dark";
  const ctx = await browser.newContext({ colorScheme: dark ? "dark" : "light", forcedColors: mode === "forced" ? "active" : "none", reducedMotion: mode === "reduced" ? "reduce" : "no-preference", viewport: { width: w, height: h } });
  const theme = { name: "mc_theme", value: dark ? "dark" : "light", url: base };
  const page = await ctx.newPage();
  page.setDefaultTimeout(Number(process.env.QA_TIMEOUT || 30000)); // raise on a busy machine
  let at = "login"; // the route being loaded, named in page errors
  page.on("pageerror", (e) => report(`${mode}@${w} ${at} pageerror: ${e.message.slice(0, 120)}`));
  const snap = async (name) => { if (shots && (mode === "light" || mode === "dark")) await page.screenshot({ path: `${dir}/${name}-${mode}-${w}.png`, fullPage: true }); };
  const axe = async (name) => {
    const r = await new AxeBuilder({ page }).exclude("iframe").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const hard = r.violations.filter((v) => ["serious", "critical"].includes(v.impact));
    console.log(`${name.padEnd(20)} ${mode.padEnd(8)} ${String(w).padStart(4)}  ${r.violations.length} violations, ${hard.length} serious/critical`);
    for (const v of r.violations) console.error(`  ${hard.includes(v) ? "!" : "-"} ${v.impact} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0].target.join(" ")}`);
    bad += hard.length;
  };

  // Login is the one unauthenticated route.
  if (!only.length || only.some((o) => "login".includes(o))) {
    await ctx.addCookies([theme]);
    await page.goto(base + "/login", { waitUntil: "load" }); await page.waitForTimeout(300);
    await axe("login"); await snap("login");
    await page.goto(base + "/login?err=" + encodeURIComponent("unauthenticated|Bad key|Check the key"), { waitUntil: "load" }); await page.waitForTimeout(300);
    await snap("login-error");
  }
  await ctx.addCookies([theme, { name: "mc_key", value: "mc_test_x", url: base }, { name: "mc_base", value: API, url: base }]);
  for (const [name, path, act] of ROUTES) {
    at = name;
    await page.goto(base + path, { waitUntil: "load", timeout: 30000 }).catch((e) => report(`${name} goto: ${e.message.slice(0, 80)}`));
    await page.waitForTimeout(450);
    if (act) { await act(page).catch((e) => report(`${name} action: ${e.message.split("\n")[0].slice(0, 100)}`)); await page.waitForTimeout(450); }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) report(`${name} ${mode}@${w}: horizontal overflow ${overflow}px`);
    await axe(name); await snap(name);
  }
  await ctx.close();
}

for (const mode of MODES) for (const w of WIDTHS) await run(mode, w, w > 600 ? 900 : 844);
await browser.close();
console.log(bad ? `FAIL: ${bad} problem(s)` : "PASS: 0 serious/critical");
process.exit(bad ? 1 : 0);
