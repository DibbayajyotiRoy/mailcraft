import { describe, expect, it } from "vitest";
import { diffLines, diffStat, type Row } from "@/lib/assistant/diff";

const lines = (n: number, prefix = "l") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const text = (xs: string[]) => xs.join("\n");
const kinds = (rows: Row[]) => rows.map((r) => r.t).join("");

describe("diffLines", () => {
  it("returns nothing for identical text (all context collapses away)", () => {
    expect(diffLines("a\nb\nc", "a\nb\nc")).toEqual([]);
    expect(diffLines("", "")).toEqual([]);
  });

  it("treats empty before/after as no lines (not one empty line)", () => {
    expect(diffLines("", "a\nb")).toEqual([{ t: "+", s: "a" }, { t: "+", s: "b" }]);
    expect(diffLines("a\nb", "")).toEqual([{ t: "-", s: "a" }, { t: "-", s: "b" }]);
  });

  it("shows a replaced line as one add and one remove", () => {
    const rows = diffLines("a\nb\nc", "a\nB\nc");
    expect(rows.filter((r) => r.t === "+")).toEqual([{ t: "+", s: "B" }]);
    expect(rows.filter((r) => r.t === "-")).toEqual([{ t: "-", s: "b" }]);
    expect(rows.filter((r) => r.t === " ").map((r) => r.s)).toEqual(["a", "c"]);
  });

  it("collapses unchanged runs to 2 lines of context with a counted ellipsis row", () => {
    const before = lines(10), after = [...before];
    after[4] = "five";
    const rows = diffLines(text(before), text(after));
    // l1,l2 are 3+ lines from the change, so they fold; l3,l4 are context; l6,l7 are context; l8..l10 fold
    expect(rows.map((r) => `${r.t}${r.s}`)).toEqual([
      "…2 unchanged lines", " l3", " l4", "+five", "-l5", " l6", " l7", "…3 unchanged lines",
    ]);
  });

  it("says '1 unchanged line' in the singular", () => {
    // change at line 4 of 6: only l1 is further than 2 lines away; l5,l6 are within context
    const before = lines(6), after = [...before];
    after[3] = "X";
    const rows = diffLines(text(before), text(after));
    expect(rows[0]).toEqual({ t: "…", s: "1 unchanged line" });
    expect(rows.some((r) => r.t === "…" && r.s === "1 unchanged line")).toBe(true);
    expect(rows.filter((r) => r.t === "…")).toHaveLength(1);
  });

  it("does not emit a leading ellipsis when the change is at the top, nor a trailing one when at the bottom", () => {
    const head = diffLines(text(["X", ...lines(8)]), text(["Y", ...lines(8)]));
    expect(head[0].t).not.toBe("…");
    expect(head[head.length - 1]).toEqual({ t: "…", s: "6 unchanged lines" });
    const tail = diffLines(text([...lines(8), "X"]), text([...lines(8), "Y"]));
    expect(tail[0]).toEqual({ t: "…", s: "6 unchanged lines" });
    expect(tail[tail.length - 1].t).not.toBe("…");
  });

  it("keeps two nearby changes in one hunk without an ellipsis between them", () => {
    // changes 4 lines apart (3 unchanged lines between): each is within 2 of the next change's context
    const before = lines(12), after = [...before];
    after[3] = "A";
    after[7] = "B";
    const rows = diffLines(text(before), text(after));
    // only the head (l1) and the tail (l11, l12) fold; l5..l7 between the two changes stay
    expect(rows.map((r) => r.t === "…" ? r.t : r.t + r.s)).toEqual(
      ["…", " l2", " l3", "+A", "-l4", " l5", " l6", " l7", "+B", "-l8", " l9", " l10", "…"]);
    expect(rows[0].s).toBe("1 unchanged line");
    expect(rows[rows.length - 1].s).toBe("2 unchanged lines");
  });

  it("folds the gap between two far-apart changes", () => {
    const before = lines(20), after = [...before];
    after[1] = "A";
    after[17] = "B";
    const rows = diffLines(text(before), text(after));
    const gap = rows.filter((r) => r.t === "…");
    expect(gap.length).toBeGreaterThanOrEqual(1);
    // l7..l14 sit more than 2 lines from either change
    expect(rows.map((r) => r.s)).not.toContain("l9");
    expect(diffStat(rows)).toEqual({ add: 2, del: 2 });
  });

  it("honours the ctx argument (0 = changes only, 1 = one line around them)", () => {
    const before = lines(9), after = [...before];
    after[4] = "X";
    const none = diffLines(text(before), text(after), 0);
    expect(kinds(none)).toBe("…+-…");
    expect(none.filter((r) => r.t === " ")).toEqual([]);
    const one = diffLines(text(before), text(after), 1);
    expect(one.filter((r) => r.t === " ").map((r) => r.s)).toEqual(["l4", "l6"]);
    const wide = diffLines(text(before), text(after), 99);
    expect(wide.some((r) => r.t === "…")).toBe(false);
    expect(wide).toHaveLength(9 + 1);
  });

  it("handles pure insertions and deletions in the middle", () => {
    expect(diffLines("a\nc", "a\nb\nc")).toEqual([{ t: " ", s: "a" }, { t: "+", s: "b" }, { t: " ", s: "c" }]);
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([{ t: " ", s: "a" }, { t: "-", s: "b" }, { t: " ", s: "c" }]);
  });

  it("rebuilds both sides exactly from the rows when nothing is folded", () => {
    const a = "one\ntwo\nthree\nfour\nfive", b = "zero\none\nthree\nfour\nsix\nseven";
    const rows = diffLines(a, b, 99);
    expect(rows.filter((r) => r.t !== "+").map((r) => r.s).join("\n")).toBe(a);
    expect(rows.filter((r) => r.t !== "-").map((r) => r.s).join("\n")).toBe(b);
  });

  it("is case and whitespace sensitive (a re-indented line is a change)", () => {
    expect(diffStat(diffLines("a\n  b", "a\n    b"))).toEqual({ add: 1, del: 1 });
    expect(diffStat(diffLines("Hello", "hello"))).toEqual({ add: 1, del: 1 });
  });

  it("shows removing a trailing newline as a removed empty line", () => {
    expect(diffLines("a\n", "a")).toEqual([{ t: " ", s: "a" }, { t: "-", s: "" }]);
  });

  it("refuses to run the O(n*m) table on very large inputs and summarises instead", () => {
    const big = text(Array.from({ length: 2001 }, () => "x"));
    expect(diffLines(big, big)).toEqual([{ t: "-", s: "(2001 lines)" }, { t: "+", s: "(2001 lines, too large to diff here)" }]);
    // one side empty never hits the guard however long the other is
    expect(diffLines("", big)).toHaveLength(2001);
  });
});

describe("diffStat", () => {
  it("counts only + and - rows (context and ellipsis rows are free)", () => {
    const rows: Row[] = [{ t: "…", s: "3 unchanged lines" }, { t: " ", s: "a" }, { t: "+", s: "b" }, { t: "+", s: "c" }, { t: "-", s: "d" }, { t: "…", s: "1 unchanged line" }];
    expect(diffStat(rows)).toEqual({ add: 2, del: 1 });
  });
  it("is zero for no rows", () => {
    expect(diffStat([])).toEqual({ add: 0, del: 0 });
  });
  it("agrees with the line counts of a real diff", () => {
    const rows = diffLines(text(lines(30)), text([...lines(30).slice(0, 10), "new1", "new2", ...lines(30).slice(12)]));
    expect(diffStat(rows)).toEqual({ add: 2, del: 2 });
  });
  it("counts a whole-file add and a whole-file delete", () => {
    expect(diffStat(diffLines("", text(lines(5))))).toEqual({ add: 5, del: 0 });
    expect(diffStat(diffLines(text(lines(5)), ""))).toEqual({ add: 0, del: 5 });
  });
});
