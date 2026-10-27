// Visual + a11y QA against a running dev server and mock API:
//   node scripts/qa.mjs <baseUrl> <shotsDir> [--no-shots]
// Axe (WCAG 2.2 AA tags) on /dev/design and two real pages; exits 1 on serious/critical violations.
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const [base, dir = "shots"] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext();
await ctx.addCookies([{ name: "mc_key", value: "mc_test_x", url: base }, { name: "mc_base", value: process.env.MOCK_API || "http://localhost:18080", url: base }]);
const PAGES = [["design", "/dev/design"], ["overview", "/"], ["emails", "/emails"], ["domains", "/domains"], ["keys", "/keys"]];
const AXE_PAGES = new Set(["design", "overview", "domains", "keys"]);
let bad = 0;
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: w, height: h });
  for (const [name, path] of PAGES) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    if (w === 1440 || name === "design") {
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      const hard = r.violations.filter((v) => ["serious", "critical"].includes(v.impact));
      if (AXE_PAGES.has(name)) console.log(`axe ${name}@${w}: ${r.violations.length} violations, ${hard.length} serious/critical`);
      for (const v of hard) { bad++; console.error(`  ${v.impact} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0].target.join(" ")}`); }
    }
    if (!process.argv.includes("--no-shots")) await page.screenshot({ path: `${dir}/${name}-${w}.png`, fullPage: name === "design" });
  }
  await page.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
