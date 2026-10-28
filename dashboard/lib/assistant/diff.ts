// Line diff for proposal cards: LCS over lines, unchanged runs collapsed to 2 lines of context. Pure; no dependencies.
export type Row = { t: "+" | "-" | " " | "…"; s: string };

export function diffLines(before: string, after: string, ctx = 2): Row[] {
  const a = before ? before.split("\n") : [], b = after ? after.split("\n") : [];
  if (a.length * b.length > 4_000_000) return [{ t: "-", s: `(${a.length} lines)` }, { t: "+", s: `(${b.length} lines, too large to diff here)` }];
  const L: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const rows: Row[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ t: " ", s: a[i] }); i++; j++; }
    else if (j < b.length && (i === a.length || L[i][j + 1] >= L[i + 1][j])) rows.push({ t: "+", s: b[j++] });
    else rows.push({ t: "-", s: a[i++] });
  }
  const keep = rows.map((r) => r.t !== " ");
  const near = (k: number) => { for (let d = -ctx; d <= ctx; d++) if (keep[k + d]) return true; return false; };
  const out: Row[] = [];
  let skipped = 0;
  rows.forEach((r, k) => {
    if (r.t !== " " || near(k)) { if (skipped) out.push({ t: "…", s: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` }); skipped = 0; out.push(r); } else skipped++;
  });
  if (skipped && out.length) out.push({ t: "…", s: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return out;
}
export const diffStat = (rows: Row[]) => ({ add: rows.filter((r) => r.t === "+").length, del: rows.filter((r) => r.t === "-").length });
