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
// [name, path, action?]  action = open a dialog/tab before the capture
const ROUTES = [
  ["overview", "/"], ["overview-30d", "/?range=30d"],
  ["emails", "/emails"], ["emails-bounced", "/emails?status=bounced"], ["emails-nomatch", "/emails?q=zzzz"], ["emails-peek", "/emails?open=em_02"],
  ["email-detail", "/emails/em_00"], ["email-bounce", "/emails/em_02"], ["email-pending", "/emails/em_07"],
  ["approvals", "/approvals"],
  ["templates", "/templates"], ["template-detail", "/templates/t2"], ["template-lint", "/templates/t2", click("tab", /Lint/)],
  ["template-variables", "/templates/t2", click("tab", /Variables/)], ["template-import", "/templates", click("button", "Import template")],
  ["automations", "/automations"], ["automation-confirm", "/automations", click("switch", /.*/)],
  ["automation-detail", "/automations/a1"], ["automation-runs", "/automations/a1", click("tab", /Runs/)], ["automation-settings", "/automations/a1", click("tab", "Settings")],
  ["contacts", "/contacts"], ["contact-drawer", "/contacts", click("button", "ana@example.com")], ["segments", "/contacts?tab=segments"],
  ["domains", "/domains"], ["keys", "/keys"], ["keys-create", "/keys", click("button", /Create (your first )?key|New key|Create/)],
  ["settings", "/settings"], ["notfound", "/nope"], ["design", "/dev/design"],
].filter(([n]) => n.includes(only));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let bad = 0;
const report = (msg) => { bad++; console.error(`  ! ${msg}`); };

async function run(mode, w, h) {
  const dark = mode === "dark";
  const ctx = await browser.newContext({ colorScheme: dark ? "dark" : "light", forcedColors: mode === "forced" ? "active" : "none", reducedMotion: mode === "reduced" ? "reduce" : "no-preference", viewport: { width: w, height: h } });
  const theme = { name: "mc_theme", value: dark ? "dark" : "light", url: base };
  const page = await ctx.newPage();
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
