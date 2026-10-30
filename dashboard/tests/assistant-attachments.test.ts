import { describe, expect, test } from "vitest";
import { MAX_FILE_BYTES, parseFile } from "@/lib/assistant/attachments";

function file(name: string, content: string, type = "text/plain") {
  const blob = new Blob([content]);
  return { name, type, size: blob.size, text: async () => content };
}

describe("parseFile", () => {
  test("parses a valid CSV with email column", async () => {
    const f = file("contacts.csv", "email,first_name,last_name\na@example.com,Alice,Smith\nb@example.com,Bob,Jones\n");
    const r = await parseFile(f);
    expect("kind" in r && r.kind === "csv").toBe(true);
    if ("kind" in r && r.kind === "csv") {
      expect(r.count).toBe(2);
      expect(r.columns).toEqual(["email", "first_name", "last_name"]);
      expect(r.rows[0]).toEqual({ email: "a@example.com", first_name: "Alice", last_name: "Smith" });
      expect(r.summary).toContain("2 contacts");
      expect(r.summary).not.toContain("a@example.com"); // masked
    }
  });

  test("strips a UTF-8 BOM from the CSV header", async () => {
    const f = file("bom.csv", "\uFEFFemail,first_name\na@example.com,Alice\n");
    const r = await parseFile(f);
    expect("kind" in r && r.kind === "csv").toBe(true);
    if ("kind" in r && r.kind === "csv") {
      expect(r.columns).toEqual(["email", "first_name"]);
      expect(r.count).toBe(1);
    }
  });

  test("rejects CSV without email column", async () => {
    const f = file("bad.csv", "name\nAlice\n");
    const r = await parseFile(f);
    expect("kind" in r).toBe(false);
    if (!("kind" in r)) expect(r.reason).toBe("parse");
  });


  test("rejects oversized files", async () => {
    const f = file("big.csv", "x\n" + "y\n".repeat(1_000_000));
    Object.defineProperty(f, "size", { value: MAX_FILE_BYTES + 1 });
    const r = await parseFile(f);
    expect("kind" in r).toBe(false);
    if (!("kind" in r)) expect(r.reason).toBe("too_large");
  });

  test("parses HTML by extension", async () => {
    const f = file("body.html", "<h1>Hi</h1>");
    const r = await parseFile(f);
    expect("kind" in r && r.kind === "html").toBe(true);
    if ("kind" in r && r.kind === "html") expect(r.content).toBe("<h1>Hi</h1>");
  });

  test("parses MJML by extension", async () => {
    const f = file("body.mjml", "<mjml><mj-body></mj-body></mjml>");
    const r = await parseFile(f);
    expect("kind" in r && r.kind === "mjml").toBe(true);
  });

  test("parses JSON by extension", async () => {
    const f = file("tmpl.json", '{"version":1,"subject":"Hi","blocks":[]}', "application/json");
    const r = await parseFile(f);
    expect("kind" in r && r.kind === "json").toBe(true);
    if ("kind" in r && r.kind === "json") expect(r.content).toEqual({ version: 1, subject: "Hi", blocks: [] });
  });

  test("falls back to text for .txt", async () => {
    const f = file("note.txt", "Hello world");
    const r = await parseFile(f);
    expect("kind" in r && r.kind === "text").toBe(true);
  });
});
