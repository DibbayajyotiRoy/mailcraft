// WCAG AA contrast gate for app/tokens.css. Exit 1 if any pair is below its threshold.
import { readFileSync } from "node:fs";
const css = readFileSync(new URL("../app/tokens.css", import.meta.url), "utf8");
const blocks = [...css.matchAll(/(:root(?::not\(\[data-theme="light"\]\))?|\[data-theme="dark"\])\s*\{([^}]*)\}/g)];
const vars = (b) => Object.fromEntries([...b[2].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]));
const themes = { light: vars(blocks[0]), dark: vars(blocks.find((b) => b[1].includes("not"))), "dark (forced)": vars(blocks.find((b) => b[1].includes('"dark"'))) };

const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };

// [foreground, background, minimum, why]; 4.5 = text, 3 = UI component / large text
const text = (fg, bg) => [fg, bg, 4.5];
const PAIRS = [
  ...["bg", "surface", "surface-2", "surface-3"].flatMap((s) => [text("fg", s), text("fg-muted", s), text("fg-subtle", s)]),
  text("accent", "bg"), text("accent", "surface"), text("accent", "accent-soft"), text("accent-fg", "accent"),
  text("ok", "bg"), text("ok", "ok-bg"), text("on-ok", "ok"),
  text("warn", "bg"), text("warn", "warn-bg"),
  text("bad", "bg"), text("bad", "bad-bg"), text("on-bad", "bad"),
  text("info", "bg"), text("info", "info-bg"),
  ["input-border", "bg", 3], ["input-border", "surface", 3], ["input-border", "surface-2", 3],
  ["accent", "bg", 3], ["live", "bg", 3], ["live", "surface", 3], ["test", "bg", 3], ["test", "surface", 3],
  ["ok", "surface", 3], ["warn", "surface", 3], ["bad", "surface", 3], ["info", "surface", 3],
];
let bad = 0, n = 0;
for (const [name, t] of Object.entries(themes)) for (const [f, b, min] of PAIRS) {
  if (!t[f] || !t[b]) { console.error(`${name}: missing token ${!t[f] ? f : b}`); bad++; continue; }
  n++; const r = ratio(t[f], t[b]);
  if (r < min) { console.error(`FAIL ${name}: ${f} ${t[f]} on ${b} ${t[b]} = ${r.toFixed(2)} < ${min}`); bad++; }
}
console.log(`${n} pairs checked, ${bad} failing`);
process.exit(bad ? 1 : 0);
