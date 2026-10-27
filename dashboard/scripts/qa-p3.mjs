// P3 QA: axe + screenshots of Templates / Automations / Contacts against a running dev server + scripts/mock-api-p3.mjs
//   node scripts/qa-p3.mjs <baseUrl> <shotsDir>
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const [base, dir = "shots"] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext();
await ctx.addCookies([{ name: "mc_key", value: "mc_test_x", url: base }, { name: "mc_base", value: process.env.MOCK_API || "http://localhost:18080", url: base }]);
const PAGES = [
  ["templates", "/templates"], ["template-detail", "/templates/t2"], ["template-lint", "/templates/t2", async (p) => p.getByRole("tab", { name: /Lint/ }).click()],
  ["template-variables", "/templates/t2", async (p) => p.getByRole("tab", { name: /Variables/ }).click()],
  ["template-import", "/templates", async (p) => p.getByRole("button", { name: "Import template" }).click()],
  ["automations", "/automations"], ["automation-confirm", "/automations", async (p) => p.getByRole("switch").first().click()],
  ["automation-detail", "/automations/a1"], ["automation-runs", "/automations/a1", async (p) => p.getByRole("tab", { name: /Runs/ }).click()],
  ["automation-settings", "/automations/a1", async (p) => p.getByRole("tab", { name: "Settings" }).click()],
  ["contacts", "/contacts"], ["contact-drawer", "/contacts", async (p) => p.getByRole("button", { name: "ana@example.com" }).click()],
  ["segments", "/contacts?tab=segments"],
];
let bad = 0;
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: w, height: h });
  for (const [name, path, act] of PAGES) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    if (act) { await act(page); await page.waitForTimeout(400); }
    const r = await new AxeBuilder({ page }).exclude("iframe").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const hard = r.violations.filter((v) => ["serious", "critical"].includes(v.impact));
    console.log(`axe ${name}@${w}: ${r.violations.length} violations, ${hard.length} serious/critical`);
    for (const v of r.violations) console.error(`  ${v.impact} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0].target.join(" ")}`);
    bad += hard.length;
    await page.screenshot({ path: `${dir}/${name}-${w}.png`, fullPage: !act });
  }
  await page.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
