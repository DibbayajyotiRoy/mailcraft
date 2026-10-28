// A tolerant streaming reader for ONE JSON object, as a model writes it token by token (no React, no server imports):
//   {"subject":"Hi","text":"a\nb"}   or   {"subject":"","vars":{"first_name":"Ana","data.company":"Acme"}}
// Everything before the object (a ```json fence, a chatty preface, even prose with braces like "{{ first_name }}") and after its
// closing `}` is ignored. The object starts at the first `{` that is followed by a JSON key and a colon.
// A top-level string value streams as { field: key, delta } and ends with { field: key, done: true }; strings inside the
// top-level "vars" object are fields named "var:<key>". number/true/false stream as one delta of their raw text, null as
// done only, any other array/object value is skipped. A malformed stream never throws: end() closes whatever was open.
import type { FieldEvent } from "./events";

type State = "pre" | "open" | "key" | "keystr" | "colon" | "value" | "str" | "lit" | "skip" | "end";
const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }; // \" \\ \/ and unknown escapes yield the char itself

export class FieldStream {
  private state: State = "pre";
  private ev: FieldEvent[] = [];
  private text = "";            // the string (or literal) being read: a key, or a value not yet emitted
  private key = "";
  private field = "";
  private inVars = false;       // inside the top-level "vars" object
  private esc: "" | "\\" | "u" = ""; // escape in progress (also used while skipping)
  private hex = "";             // the digits of a \uXXXX read so far
  private hi = "";              // a high surrogate waiting for its low half
  private depth = 0;            // nesting of a skipped value
  private inStr = false;        // inside a string of a skipped value
  private armed = false;       // a `"key":` has been seen: the object is real, not prose

  push(chunk: string): FieldEvent[] {
    this.ev = [];
    for (let i = 0; i < chunk.length; i++) this.feed(chunk[i]); // one UTF-16 unit at a time, so any split is fine
    if (this.state === "str") this.flush();
    return this.ev;
  }

  /** The stream is over (maybe cut short): finish a string or literal in progress. Safe to call again. */
  end(): FieldEvent[] {
    this.ev = [];
    if (this.state === "str") this.closeStr();
    else if (this.state === "lit") this.endLit();
    this.state = "end";
    return this.ev;
  }

  private feed(c: string): void {
    switch (this.state) {
      case "pre": if (c === "{") this.state = "open"; break;
      case "open": // a `{` is the object only if a JSON key follows
        if (/\s/.test(c)) break;
        if (c === '"') this.state = "keystr"; else { this.state = "pre"; this.feed(c); }
        break;
      case "key": // after `{` or a finished value; commas and whitespace (and anything odd) are skipped
        if (c === '"') this.state = "keystr";
        else if (c === "}") { if (this.inVars) this.inVars = false; else this.state = "end"; }
        break;
      case "colon":
        if (c === ":") { this.armed = true; this.state = "value"; }
        else if (!this.armed && !/\s/.test(c)) { this.state = "pre"; this.feed(c); } // `{ "x" | upper }` in prose, not an object
        break;
      case "value": this.value(c); break;
      case "keystr": case "str": this.str(c); break;
      case "lit":
        if (/[\s,}]/.test(c)) { this.endLit(); this.feed(c); } else this.text += c;
        break;
      case "skip": this.skip(c); break;
    }
  }

  private value(c: string): void {
    if (/\s/.test(c)) return;
    this.field = this.inVars ? "var:" + this.key : this.key;
    if (c === '"') this.state = "str";
    else if (c === "{" && !this.inVars && this.key === "vars") { this.inVars = true; this.state = "key"; }
    else if (c === "{" || c === "[") { this.state = "skip"; this.depth = 1; this.inStr = false; }
    else if (c === "," || c === "}") { this.state = "key"; this.feed(c); } // a missing value
    else { this.state = "lit"; this.text = c; }
  }

  private str(c: string): void {
    if (this.esc === "u") {
      if (/[0-9a-f]/i.test(c)) {
        this.hex += c;
        if (this.hex.length === 4) { this.esc = ""; this.put(String.fromCharCode(parseInt(this.hex, 16))); }
        return;
      }
      this.esc = ""; this.put("�"); // a broken \u escape; c is read as ordinary text below
    } else if (this.esc) {
      this.esc = "";
      if (c === "u") { this.esc = "u"; this.hex = ""; } else this.put(ESC[c] ?? c);
      return;
    }
    if (c === "\\") this.esc = "\\";
    else if (c === '"') this.closeStr();
    else this.put(c);
  }

  /** Append one UTF-16 unit, pairing surrogates (even across \u escapes and chunks); a lone one becomes U+FFFD. */
  private put(u: string): void {
    const code = u.charCodeAt(0);
    const low = code >= 0xdc00 && code <= 0xdfff;
    if (this.hi) {
      if (low) { this.text += this.hi + u; this.hi = ""; return; }
      this.text += "�"; this.hi = "";
    }
    if (code >= 0xd800 && code <= 0xdbff) this.hi = u;
    else this.text += low ? "�" : u;
  }

  private closeStr(): void {
    if (this.hi) { this.text += "�"; this.hi = ""; }
    if (this.state === "keystr") { this.key = this.text; this.state = "colon"; }
    else { this.flush(); this.ev.push({ field: this.field, done: true }); this.state = "key"; }
    this.text = "";
    this.esc = "";
  }

  private flush(): void {
    if (this.text) this.ev.push({ field: this.field, delta: this.text });
    this.text = "";
  }

  private endLit(): void {
    if (this.text !== "null") this.flush(); // null is done only
    this.text = "";
    this.ev.push({ field: this.field, done: true });
    this.state = "key";
  }

  private skip(c: string): void {
    if (this.inStr) { if (this.esc) this.esc = ""; else if (c === "\\") this.esc = "\\"; else if (c === '"') this.inStr = false; }
    else if (c === '"') this.inStr = true;
    else if (c === "{" || c === "[") this.depth++;
    else if ((c === "}" || c === "]") && --this.depth === 0) this.state = "key";
  }
}
