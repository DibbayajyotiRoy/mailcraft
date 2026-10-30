import { describe, expect, test } from "vitest";
import { normalizeDraftEdits, resetDraft } from "@/lib/assistant/draft";

describe("normalizeDraftEdits", () => {
  test("passes through normal instructions", () => {
    const prev = { original: "<p>x</p>", current: "<p>x</p>", edits: [{ instruction: "shorten", applied: true }] };
    const r = normalizeDraftEdits(prev, ["remove footer"]);
    expect(r.instructions).toEqual(["remove footer"]);
    expect(r.reset).toBe(false);
    expect(r.undo).toBe(false);
  });

  test("detects undo", () => {
    const prev = { original: "<p>x</p>", current: "<p>y</p>", edits: [{ instruction: "a", applied: true }, { instruction: "b", applied: true }] };
    const r = normalizeDraftEdits(prev, ["undo the last change"]);
    expect(r.instructions).toEqual(["a"]);
    expect(r.undo).toBe(true);
  });

  test("detects reset", () => {
    const prev = { original: "<p>x</p>", current: "<p>y</p>", edits: [{ instruction: "a", applied: true }] };
    const r = normalizeDraftEdits(prev, ["start from the template again"]);
    expect(r.reset).toBe(true);
  });
});

describe("resetDraft", () => {
  test("returns original HTML with a reset edit", () => {
    const s = resetDraft("<p>original</p>");
    expect(s.current).toBe("<p>original</p>");
    expect(s.edits[0].instruction).toBe("start from the template again");
  });
});

