import { describe, expect, it } from "vitest";
import { headerKey, parseCsv, recipientsFromCsv, recipientsFromGrid, varsOf } from "@/lib/csv";

describe("parseCsv (RFC 4180)", () => {
  it("splits rows and fields", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("handles CRLF, bare CR, no trailing newline and blank lines", () => {
    expect(parseCsv("a,b\r\n1,2\r\n\r\n3,4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    expect(parseCsv("a\r1\r2")).toEqual([["a"], ["1"], ["2"]]);
  });
  it("strips a UTF-8 BOM", () => {
    expect(parseCsv("﻿email,name\nx@y.co,Ann")[0]).toEqual(["email", "name"]);
  });
  it("reads quoted fields: commas, escaped quotes and line breaks inside quotes", () => {
    expect(parseCsv('a,b\n"Doe, Jane","say ""hi"""\n"two\nlines",x\n')).toEqual([["a", "b"], ["Doe, Jane", 'say "hi"'], ["two\nlines", "x"]]);
  });
  it("keeps empty fields, including a trailing one", () => {
    expect(parseCsv("a,b,c\n1,,\n,2,")).toEqual([["a", "b", "c"], ["1", "", ""], ["", "2", ""]]);
  });
});

describe("recipientsFromCsv", () => {
  const csv = "Email,First Name,last_name,Company Name,2nd Choice\nada@example.com,Ada,Lovelace,Analytical Engines,x\n";
  it("maps email / first_name / last_name and turns other columns into data", () => {
    const p = recipientsFromCsv(csv);
    expect(p.error).toBeUndefined();
    expect(p.recipients).toEqual([{ email: "ada@example.com", first_name: "Ada", last_name: "Lovelace", data: { company_name: "Analytical Engines", _2nd_choice: "x" } }]);
    expect(p.columns).toEqual(["company_name", "_2nd_choice"]);
  });
  it("requires a header row with an email column", () => {
    expect(recipientsFromCsv("name,company\nAda,Acme\n").error).toMatch(/no “email” column.*name, company/);
    expect(recipientsFromCsv("").error).toMatch(/empty/);
  });
  it("reports invalid rows with their row number, and removes duplicates case-insensitively", () => {
    const p = recipientsFromCsv("email\nada@example.com\nnot-an-email\n\nADA@example.com\n,\nb@c.co\n");
    expect(p.recipients.map((r) => r.email)).toEqual(["ada@example.com", "b@c.co"]);
    expect(p.duplicates).toBe(1);
    expect(p.issues).toEqual([{ row: 3, email: "not-an-email", reason: "Not a valid email address" }, { row: 5, email: "", reason: "No email address" }]);
  });
  it("leaves blank cells out and survives short rows", () => {
    const p = recipientsFromCsv("email,first_name,company\na@b.co,,\nc@d.co\n");
    expect(p.recipients).toEqual([{ email: "a@b.co" }, { email: "c@d.co" }]);
  });
  it("refuses duplicate columns and oversized files", () => {
    expect(recipientsFromCsv("email,Email\na@b.co,a@b.co").error).toMatch(/Two columns/);
    expect(recipientsFromCsv("email\n" + Array.from({ length: 5001 }, (_, i) => `u${i}@x.co`).join("\n")).error).toMatch(/over the limit/);
  });
  it("normalises header names", () => {
    expect([" First Name ", "E-mail", "3d"].map(headerKey)).toEqual(["first_name", "e_mail", "_3d"]);
  });
});

describe("recipientsFromGrid and varsOf", () => {
  it("ignores blank rows and keeps row numbers", () => {
    const p = recipientsFromGrid([{ email: "a@b.co", first_name: "A", company: "Acme" }, { email: "", first_name: "", last_name: "" }, { email: "bad" }], ["company"]);
    expect(p.recipients).toEqual([{ email: "a@b.co", first_name: "A", data: { company: "Acme" } }]);
    expect(p.issues).toEqual([{ row: 3, email: "bad", reason: "Not a valid email address" }]);
  });
  it("mirrors the API: blank values are left out of the variables", () => {
    expect(varsOf({ email: "a@b.co", first_name: " ", last_name: "L", data: { c: "1", d: " " } })).toEqual({ email: "a@b.co", last_name: "L", data: { c: "1" } });
  });
});
