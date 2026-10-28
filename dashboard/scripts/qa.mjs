// Visual + a11y QA against a running dashboard and scripts/mock-api.mjs:
//   node scripts/qa.mjs <baseUrl> [shotsDir] [--no-shots] [--modes=light,dark,forced,reduced] [--widths=1440,390] [--only=substr]
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
const only = flag("only", "");
const shots = !args.includes("--no-shots");
const API = process.env.MOCK_API || "http://localhost:18080";
if (shots) mkdirSync(dir, { recursive: true });

const click = (role, name, nth) => async (p) => { const l = p.getByRole(role, { name }); await (nth ? l.nth(nth) : l.first()).click(); };
const CSV = "email,first_name,last_name,company\nada@example.com,Ada,Lovelace,Analytical Engines\ngrace@example.com,Grace,Hopper,Navy\nlinus@example.com,,Torvalds,\n";
const upload = async (p) => { await p.getByLabel("CSV file").setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) }); await p.waitForTimeout(300); };
const toContent = async (p) => { await upload(p); await p.getByRole("button", { name: /^Content/ }).click(); await p.waitForTimeout(2200); };
const toReview = async (p) => { await toContent(p); await p.getByRole("button", { name: /^Review/ }).click(); await p.waitForTimeout(1500); };
const seq = (...acts) => async (p) => { for (const a of acts) await a(p); };
const edit = (text) => async (p) => { await p.getByRole("textbox", { name: /source$/ }).fill(text); await p.waitForTimeout(1000); }; // past the 600ms preview debounce
const previewPane = async (p) => { const b = p.getByRole("radio", { name: "Preview", exact: true }); if (await b.isVisible()) await b.click(); }; // the Code/Preview switch exists below 1024px only
// Assistant panel: needs the dashboard started with OPENROUTER_API_KEY=mock and MAILCRAFT_ASSISTANT_BASE_URL=<mock-api>/openrouter/api/v1.
const fresh = async (p) => { await p.evaluate(() => sessionStorage.clear()); await p.reload({ waitUntil: "load" }); await p.waitForTimeout(300); };
const openAssistant = async (p) => { await fresh(p); await p.getByRole("button", { name: "Assistant" }).click(); await p.getByRole("dialog").waitFor(); await p.waitForTimeout(500); };
const ask = (text) => async (p) => { await openAssistant(p); await p.getByLabel("Message the assistant").fill(text); await p.getByRole("button", { name: "Send message" }).click(); await p.getByRole("button", { name: "Send message" }).waitFor({ timeout: 20000 }); await p.waitForTimeout(500); };
const typeInto = (text) => async (p) => { await openAssistant(p); await p.getByLabel("Message the assistant").pressSequentially(text); await p.waitForTimeout(500); };
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
  ["automation-detail", "/automations/a1"], ["automation-runs", "/automations/a1", click("tab", /Runs/)], ["automation-settings", "/automations/a1", click("tab", "Settings")],
  ["contacts", "/contacts"], ["segments", "/contacts?tab=segments"], ["contacts-error", "/contacts?err=" + encodeURIComponent("invalid_state|automation(s) still use this segment: welcome|change or delete those automations first")],
  ["contact-detail", "/contacts/c1"], ["contact-suppressed", "/contacts/c3"], ["contact-notfound", "/contacts/zzz"],
  ["contact-add", "/contacts", click("button", "Add contact")], ["contact-add-attrs", "/contacts", async (p) => { await click("button", "Add contact")(p); await click("button", "Add attribute")(p); await click("button", "Add attribute")(p); }],
  ["contact-add-invalid", "/contacts", async (p) => { await click("button", "Add contact")(p); await p.getByLabel("Email").fill("nope"); await p.getByLabel("Time zone").fill("Mars/Base"); await p.getByRole("button", { name: "Add contact" }).last().click(); }],
  ["contact-edit", "/contacts/c1", click("button", "Edit")], ["contact-track", "/contacts/c1", click("button", "Track event")],
  ["contact-delete", "/contacts/c1", click("button", "Delete contact")], ["contact-suppress", "/contacts/c1", click("button", "Suppress")], ["contact-unsuppress", "/contacts/c3", click("button", "Remove suppression")],
  ["contacts-import", "/contacts", click("button", "Import CSV")],
  ["contacts-import-preview", "/contacts", async (p) => { await click("button", "Import CSV")(p); await p.getByLabel("Or paste the CSV").fill("email,first_name,plan,seats\nnew@example.com,Nia,pro,3\nbad@example.com,Bo,free,1\nnot-an-email,X,free,2\nnew@example.com,Dup,pro,1"); await p.waitForTimeout(200); }],
  ["segment-new", "/contacts?tab=segments", click("button", "New segment")],
  ["segment-new-conditions", "/contacts?tab=segments", async (p) => { await click("button", "New segment")(p); await p.getByLabel("Name").fill("Dormant pros"); await p.getByLabel("Condition 1 attribute name").fill("plan"); await p.getByLabel("Condition 1 value").fill("pro"); await click("button", "Add condition")(p); await p.getByLabel("Condition 2 type").selectOption("event"); await p.getByLabel("Condition 2 event name").fill("login"); await p.getByLabel("Condition 2 operator").selectOption("notwithin"); await p.getByLabel("Condition 2 number of days").fill("30"); await p.waitForTimeout(900); }],
  ["segment-edit", "/contacts?tab=segments", click("button", "Edit Pro customers")], ["segment-edit-json", "/contacts?tab=segments", click("button", "Edit EU or UK")],
  ["segment-delete", "/contacts?tab=segments", click("button", "Delete Nudged")], ["segment-members", "/contacts?tab=segments", click("button", "Add contacts to Nudged")],
  ["domains", "/domains"], ["keys", "/keys"], ["keys-create", "/keys", click("button", /Create (your first )?key|New key|Create/)],
  ["assistant-empty", "/", openAssistant], ["assistant-email-page", "/emails/em_02", openAssistant],
  ["assistant-automation", "/", ask("Set up a welcome email for new signups")], ["assistant-fix-template", "/", ask("Fix the lint errors in the promo template")],
  ["assistant-broadcast", "/", ask("Send the welcome template to my webinar list")], ["assistant-chat", "/", ask("hello")],
  ["assistant-slash", "/", typeInto("/")], ["assistant-mention", "/", typeInto("send @")],
  ["settings", "/settings"], ["settings-senders-edit", "/settings", click("button", /Edit addresses of dev@example.com/)], ["settings-senders-connect", "/settings", click("button", "Connect a mailbox")],
  ["email-compose-other-from", "/emails", async (p) => { await click("button", "New email")(p); await p.getByRole("dialog").getByLabel("From", { exact: true }).selectOption({ label: "Other address…" }); }],
  ["notfound", "/nope"], ["design", "/dev/design"],
].filter(([n]) => n.includes(only));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let bad = 0;
const report = (msg) => { bad++; console.error(`  ! ${msg}`); };

async function run(mode, w, h) {
  const dark = mode === "dark";
  const ctx = await browser.newContext({ colorScheme: dark ? "dark" : "light", forcedColors: mode === "forced" ? "active" : "none", reducedMotion: mode === "reduced" ? "reduce" : "no-preference", viewport: { width: w, height: h } });
  const theme = { name: "mc_theme", value: dark ? "dark" : "light", url: base };
  const page = await ctx.newPage();
  page.setDefaultTimeout(Number(process.env.QA_TIMEOUT || 30000)); // raise on a busy machine
  page.on("pageerror", (e) => report(`${mode}@${w} pageerror: ${e.message.slice(0, 120)}`));
  const snap = async (name) => { if (shots && (mode === "light" || mode === "dark")) await page.screenshot({ path: `${dir}/${name}-${mode}-${w}.png`, fullPage: true }); };
  const axe = async (name) => {
    const r = await new AxeBuilder({ page }).exclude("iframe").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const hard = r.violations.filter((v) => ["serious", "critical"].includes(v.impact));
    console.log(`${name.padEnd(20)} ${mode.padEnd(8)} ${String(w).padStart(4)}  ${r.violations.length} violations, ${hard.length} serious/critical`);
    for (const v of r.violations) console.error(`  ${hard.includes(v) ? "!" : "-"} ${v.impact} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0].target.join(" ")}`);
    bad += hard.length;
  };

  // Login is the one unauthenticated route.
  if (!only || "login".includes(only)) {
    await ctx.addCookies([theme]);
    await page.goto(base + "/login", { waitUntil: "load" }); await page.waitForTimeout(300);
    await axe("login"); await snap("login");
    await page.goto(base + "/login?err=" + encodeURIComponent("unauthenticated|Bad key|Check the key"), { waitUntil: "load" }); await page.waitForTimeout(300);
    await snap("login-error");
  }
  await ctx.addCookies([theme, { name: "mc_key", value: "mc_test_x", url: base }, { name: "mc_base", value: API, url: base }]);
  for (const [name, path, act] of ROUTES) {
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
