import { describe, expect, it } from "vitest";
import type { FieldEvent } from "@/lib/compose-ai/events";
import { FieldStream } from "@/lib/compose-ai/fields";

type Seen = { text: Record<string, string>; done: string[] };
const must = (ok: boolean, why: string) => { if (!ok) throw new Error(why); }; // cheaper than expect() inside the big split loops

/** Feed the parts as consecutive chunks (then end()), checking the per-call rules; returns every event in order. */
function run(parts: string[], end = true): FieldEvent[] {
  const s = new FieldStream(), all: FieldEvent[] = [];
  for (const part of [...parts, ...(end ? [null] : [])]) {
    const ev = part === null ? s.end() : s.push(part);
    const seen = new Set<string>();
    for (const e of ev) if ("delta" in e) {
      must(e.delta !== "", "empty delta");
      must(!seen.has(e.field), "two deltas for " + e.field + " in one call");
      seen.add(e.field);
    }
    all.push(...ev);
  }
  return all;
}

/** Fold events into each field's text and the order the fields finished in. */
function fold(ev: FieldEvent[]): Seen {
  const out: Seen = { text: {}, done: [] };
  for (const e of ev) {
    must(!out.done.includes(e.field), "event after done for " + e.field);
    if ("delta" in e) out.text[e.field] = (out.text[e.field] ?? "") + e.delta; else out.done.push(e.field);
  }
  return out;
}
const read = (...parts: string[]) => fold(run(parts));
const chars = (s: string) => s.split("");

const FENCE = "```";
const RICH = String.raw`Sure, here is the draft:
${FENCE}json
{ "subject" : "Hello \"Ana\" — 25% off 🎉",
  "meta": {"t": ["a}", "b\"]", {"x": "}"}], "n": 1},
  "text": "Hi {{first_name}},\n\tcafé 😀 raw 😀 back\\slash \/ done\r\n",
  "count": -12.5e3, "ok": true, "off": false, "none": null,
  "list": [1, [2, "]"], {"k": "v"}],
  "vars": {"first_name": "Ana", "data.company": "Acme \"Co\"", "empty": "", "n": 7, "o": {"z": "}"}},
  "tail": "end"}
${FENCE}
Bye {"subject": "NO"}`;
const RICH_SEEN: Seen = {
  text: {
    subject: 'Hello "Ana" — 25% off 🎉',
    text: "Hi {{first_name}},\n\tcafé 😀 raw 😀 back\\slash / done\r\n",
    count: "-12.5e3", ok: "true", off: "false",
    "var:first_name": "Ana", "var:data.company": 'Acme "Co"', "var:n": "7", tail: "end",
  },
  done: ["subject", "text", "count", "ok", "off", "none", "var:first_name", "var:data.company", "var:empty", "var:n", "tail"],
};

describe("FieldStream: one chunk", () => {
  it("streams subject and text, then closes each field", () => {
    expect(run(['{"subject":"Hi","text":"a\\nb"}'])).toEqual([
      { field: "subject", delta: "Hi" }, { field: "subject", done: true },
      { field: "text", delta: "a\nb" }, { field: "text", done: true },
    ]);
  });
  it("names the strings inside vars var:<key>, keeping flat keys like data.company", () => {
    expect(run(['{"subject":"","vars":{"first_name":"Ana","data.company":"Acme"}}'])).toEqual([
      { field: "subject", done: true },
      { field: "var:first_name", delta: "Ana" }, { field: "var:first_name", done: true },
      { field: "var:data.company", delta: "Acme" }, { field: "var:data.company", done: true },
    ]);
  });
  it("gives an empty string value only its done event, and an empty vars object nothing", () => {
    expect(run(['{"text":"","vars":{},"html":"<p>x</p>"}'])).toEqual([
      { field: "text", done: true }, { field: "html", delta: "<p>x</p>" }, { field: "html", done: true },
    ]);
  });
  it("reads the rich sample", () => expect(read(RICH)).toEqual(RICH_SEEN));
});

describe("FieldStream: any chunking", () => {
  it("streams as it grows: a delta per call, never an empty one", () => {
    const s = new FieldStream();
    expect(s.push('{"subject":"He')).toEqual([{ field: "subject", delta: "He" }]);
    expect(s.push("llo, ")).toEqual([{ field: "subject", delta: "llo, " }]);
    expect(s.push("")).toEqual([]);
    expect(s.push('you"')).toEqual([{ field: "subject", delta: "you" }, { field: "subject", done: true }]);
    expect(s.push(',"text":"x"}')).toEqual([{ field: "text", delta: "x" }, { field: "text", done: true }]);
  });
  it("char by char gives the one-shot result", () => expect(fold(run(chars(RICH)))).toEqual(RICH_SEEN));
  it("every 1-way split point gives the one-shot result", () => {
    for (let i = 0; i <= RICH.length; i++) expect(fold(run([RICH.slice(0, i), RICH.slice(i)]))).toEqual(RICH_SEEN);
  });
  it("every 2-way split (three chunks) gives the one-shot result", () => {
    const want = JSON.stringify(RICH_SEEN), bad: number[][] = [];
    for (let i = 0; i <= RICH.length; i++) for (let j = i; j <= RICH.length; j++) {
      if (JSON.stringify(fold(run([RICH.slice(0, i), RICH.slice(i, j), RICH.slice(j)]))) !== want) bad.push([i, j]);
    }
    expect(bad).toEqual([]);
  });
});

describe("FieldStream: escapes and unicode", () => {
  const text = (json: string) => read(`{"text":"${json}"}`).text.text;
  it("decodes every JSON escape", () => {
    expect(text(String.raw`\n\t\r\b\f\"\\\/`)).toBe('\n\t\r\b\f"\\/');
    expect(text(String.raw`Aéé€`)).toBe("Aéé€");
  });
  it("an unknown escape yields the char itself", () => expect(text(String.raw`a\qb\-c`)).toBe("aqb-c"));
  it("keeps raw unicode and emoji, even when a chunk cuts the pair", () => {
    expect(text("é€😀 ok")).toBe("é€😀 ok");
    const [hi, lo] = ["😀".slice(0, 1), "😀".slice(1)];
    expect(read('{"text":"a' + hi, lo + 'b"}').text.text).toBe("a😀b");
  });
  it("joins an escaped surrogate pair split across chunks, at every point", () => {
    const src = String.raw`{"text":"x😀y"}`;
    for (let i = 0; i <= src.length; i++) expect(read(src.slice(0, i), src.slice(i)).text.text).toBe("x😀y");
    expect(read(String.raw`{"text":"\ud83d`, String.raw`\ude00"}`).text.text).toBe("😀");
  });
  it("turns a lone surrogate into U+FFFD", () => {
    expect(text(String.raw`a\ud83db`)).toBe("a�b");        // high, then a normal char
    expect(text(String.raw`a\ud83dA`)).toBe("a�A");    // high, then a non-low escape
    expect(text(String.raw`a\ud83d😀`)).toBe("a�😀"); // high, then a whole pair
    expect(text(String.raw`a\ude00b`)).toBe("a�b");        // low alone
    expect(text(String.raw`a\ud83d`)).toBe("a�");          // high at the closing quote
  });
  it("reads a broken \\u escape as U+FFFD and carries on", () => expect(text(String.raw`a\u12zb`)).toBe("a�zb"));
  it("splits an escape at any boundary, mid-\\uXXXX included", () => {
    const src = String.raw`{"text":"é\n\"€"}`;
    for (let i = 0; i <= src.length; i++) expect(read(src.slice(0, i), src.slice(i)).text.text).toBe('é\n"€');
  });
});

describe("FieldStream: keys", () => {
  it("reads a key split anywhere, mid-key and mid-escape included", () => {
    const src = String.raw`{"subject":"A","text":"B"}`;
    for (let i = 0; i <= src.length; i++) {
      expect(read(src.slice(0, i), src.slice(i))).toEqual({ text: { subject: "A", text: "B" }, done: ["subject", "text"] });
    }
    expect(read(...chars(src)).done).toEqual(["subject", "text"]);
  });
  it("emits nothing for a key that has not finished", () => {
    const s = new FieldStream();
    expect(s.push('{"subj')).toEqual([]);
    expect(s.push('ect":')).toEqual([]);
    expect(s.push(' "Hi"')).toEqual([{ field: "subject", delta: "Hi" }, { field: "subject", done: true }]);
  });
});

describe("FieldStream: around the object", () => {
  it("ignores a fence and a chatty preface, and everything after the closing brace", () => {
    const seen = read('Sure! Here is a draft:\n```json\n{"subject":"S","text":"T"}\n```\nHope it helps {"subject":"X"} }');
    expect(seen).toEqual({ text: { subject: "S", text: "T" }, done: ["subject", "text"] });
  });
  it("ignores later chunks once the object is closed", () => {
    const s = new FieldStream();
    s.push('{"text":"a"}');
    expect(s.push('{"text":"b"}')).toEqual([]);
    expect(s.end()).toEqual([]);
  });
  it("reads nothing from text with no object", () => expect(run(["no json here", " at all"])).toEqual([]));
});

describe("FieldStream: prose that has braces of its own", () => {
  const OBJ = JSON.stringify({ subject: "Hi", text: "a\nb" });
  const want = { text: { subject: "Hi", text: "a\nb" }, done: ["subject", "text"] };
  it("skips template braces before the object", () => {
    expect(read("Here is the email for {{ first_name }}:\n" + OBJ)).toEqual(want);
    expect(read("Use {first_name} and { } and {}: " + OBJ)).toEqual(want);
  });
  it("skips a quoted jinja expression, and a brace pair that never gets a colon", () => {
    expect(read('Hi {{ "Name" | upper }}, {"x" is not json}. ' + OBJ)).toEqual(want);
    expect(read('see {"a"} then ' + OBJ)).toEqual(want);
  });
  it("still reads an object whose first key is spaced out or on the next line", () => {
    expect(read('{\n  "subject" :\n "Hi", "text": "a\\nb"}')).toEqual(want);
  });
  it("gives the same result however the prose is chunked", () => {
    const text = 'Draft for {{ first_name }}: {"x" nope} ' + OBJ;
    for (let i = 0; i <= text.length; i++) expect(read(text.slice(0, i), text.slice(i))).toEqual(want);
  });
});

describe("FieldStream: other values", () => {
  it("skips arrays and objects whatever the strings inside them hold", () => {
    const src = String.raw`{"a":{"x":"}","y":["]","\"}","\\"],"z":{"q":"{"}},"b":["{",[1,"]"],{"k":"}"}],"text":"kept"}`;
    expect(read(src)).toEqual({ text: { text: "kept" }, done: ["text"] });
    expect(read(...chars(src))).toEqual({ text: { text: "kept" }, done: ["text"] });
  });
  it("streams numbers, true and false as one delta, null as done only", () => {
    expect(run(['{"n":-12.5e3,"t":true,"f":false,"z":null}'])).toEqual([
      { field: "n", delta: "-12.5e3" }, { field: "n", done: true },
      { field: "t", delta: "true" }, { field: "t", done: true },
      { field: "f", delta: "false" }, { field: "f", done: true },
      { field: "z", done: true },
    ]);
  });
  it("holds a literal back until it ends, whatever the chunking", () => {
    const s = new FieldStream();
    expect(s.push('{"n": 12')).toEqual([]);
    expect(s.push("3.5 ")).toEqual([{ field: "n", delta: "123.5" }, { field: "n", done: true }]);
    expect(s.push('}')).toEqual([]);
    expect(read(...chars('{"n":42,"t": true }')).text).toEqual({ n: "42", t: "true" });
  });
  it("treats a vars that is not an object as an ordinary field", () => {
    expect(read('{"vars":"x"}')).toEqual({ text: { vars: "x" }, done: ["vars"] });
    expect(read('{"vars":[1],"text":"t"}')).toEqual({ text: { text: "t" }, done: ["text"] });
  });
  it("does not nest vars inside vars", () => {
    expect(read('{"vars":{"vars":{"a":"b"},"c":"d"}}')).toEqual({ text: { "var:c": "d" }, done: ["var:c"] });
  });
  it("lets a number or null inside vars be a var field too", () => {
    expect(read('{"vars":{"n":3,"z":null,"s":"x"}}')).toEqual({ text: { "var:n": "3", "var:s": "x" }, done: ["var:n", "var:z", "var:s"] });
  });
});

describe("FieldStream.end()", () => {
  it("closes a string cut off mid-value, flushing what was pending", () => {
    const s = new FieldStream();
    expect(s.push('{"subject":"Done","text":"half a li')).toEqual([
      { field: "subject", delta: "Done" }, { field: "subject", done: true }, { field: "text", delta: "half a li" },
    ]);
    expect(s.end()).toEqual([{ field: "text", done: true }]);
  });
  it("keeps a high surrogate that was waiting as U+FFFD, and drops a half-read escape", () => {
    expect(read(String.raw`{"text":"ok\ud83d`).text.text).toBe("ok�");
    expect(read(String.raw`{"text":"ok\u00`)).toEqual({ text: { text: "ok" }, done: ["text"] });
    expect(read('{"text":"ok\\')).toEqual({ text: { text: "ok" }, done: ["text"] });
  });
  it("flushes a literal in progress", () => {
    expect(run(['{"n":12'])).toEqual([{ field: "n", delta: "12" }, { field: "n", done: true }]);
    expect(run(['{"z":null'])).toEqual([{ field: "z", done: true }]);
  });
  it("emits nothing when no string or literal is open", () => {
    for (const src of ["", "{", '{"a', '{"a"', '{"a":', '{"a":[1,', '{"a":"b"', '{"a":"b"}']) {
      const s = new FieldStream();
      s.push(src);
      expect(s.end()).toEqual([]);
    }
  });
  it("is idempotent", () => {
    const s = new FieldStream();
    s.push('{"text":"cut');
    expect(s.end()).toEqual([{ field: "text", done: true }]);
    expect(s.end()).toEqual([]);
    expect(s.push('off"}')).toEqual([]);
  });
});

describe("FieldStream: malformed input", () => {
  it("never throws, whatever the chunking", () => {
    const junk = ['{"a" "b"}', '{,,"a":,"b":}', '{"a":"\\', '{"a":{"b":', '{{{"a":"x"}}}', '{"a":tru"e"}', '{"\\u12', '{"a":[}]', "}}]]", '{"a":"\\ud83d\\u', '{"vars":{"a":}}'];
    for (const src of junk) {
      for (let i = 0; i <= src.length; i++) expect(() => run([src.slice(0, i), src.slice(i)])).not.toThrow();
      expect(() => run(chars(src))).not.toThrow();
    }
  });
  it("recovers a field after a missing value", () => {
    expect(read('{"a":,"text":"t"}')).toEqual({ text: { text: "t" }, done: ["text"] });
  });
});
