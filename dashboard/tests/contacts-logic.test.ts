import { describe, expect, it } from "vitest";
import { buildProps, coerce, infer, rowsFromProps } from "@/app/(app)/contacts/attrs";
import { CSV_EXAMPLE, MAX_ROWS, parseCsv, readContacts } from "@/app/(app)/contacts/csv";
import { condToRule, fromRule, newCond, parseEmails, toRule, type Builder } from "@/app/(app)/contacts/segmentRules";
import { ruleWords } from "@/lib/rules";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded commas and newlines, CRLF, CR, a BOM and a missing final newline", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r"two\nlines",z')).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["two\nlines", "z"]]);
  });
  it("skips blank lines but keeps empty cells", () => {
    expect(parseCsv("a,b,c\n\n1,,3\n\n")).toEqual([["a", "b", "c"], ["1", "", "3"]]);
  });
  it("detects ; and tab delimiters from the header", () => {
    expect(parseCsv("email;name\nana@x.co;Ana")).toEqual([["email", "name"], ["ana@x.co", "Ana"]]);
    expect(parseCsv("email\tname\nana@x.co\tAna")).toEqual([["email", "name"], ["ana@x.co", "Ana"]]);
  });
  it("is not fooled by a quote in the middle of a cell", () => {
    expect(parseCsv('5" pipe,ok')).toEqual([['5" pipe', "ok"]]);
  });
});

describe("readContacts", () => {
  it("the shipped example parses clean, with typed attributes", () => {
    const r = readContacts(CSV_EXAMPLE);
    expect(r.error).toBeUndefined();
    expect(r.invalid).toEqual([]);
    expect(r.rows[0]).toEqual({ line: 2, contact: { email: "ana@example.com", first_name: "Ana", last_name: "Silva", timezone: "America/Sao_Paulo", properties: { plan: "pro", seats: 5 } } });
    expect(r.rows[1].contact).toEqual({ email: "ben@example.com", first_name: "Ben", timezone: "Europe/Berlin", properties: { plan: "free", seats: 1 } });
  });
  it("needs an email column, accepts common aliases and header casing", () => {
    expect(readContacts("name\nAna").error).toMatch(/No email column/);
    expect(readContacts("").error).toMatch(/empty/);
    const r = readContacts("E-Mail,First Name,Company Name\nana@x.co,Ana,Acme Inc");
    expect(r.rows[0].contact).toEqual({ email: "ana@x.co", first_name: "Ana", properties: { company_name: "Acme Inc" } });
  });
  it("reports bad, empty and duplicate rows by row number and keeps the good ones", () => {
    const r = readContacts("email,tz\nana@x.co,Europe/Berlin\nnope,\n,\nANA@x.co,\nbob@x.co,Mars/Base");
    expect(r.rows.map((x) => x.line)).toEqual([2]);
    expect(r.invalid).toEqual([
      { line: 3, email: "nope", message: "Not a valid email address." },
      { line: 4, message: "No email." },
      { line: 5, email: "ANA@x.co", message: "Same address as row 2." },
      { line: 6, email: "bob@x.co", message: "Mars/Base is not a time zone name like Europe/Berlin." },
    ]);
  });
  it("rejects duplicate columns and files over the row cap", () => {
    expect(readContacts("email,plan,Plan\na@x.co,1,2").error).toMatch(/Two columns are called plan/);
    expect(readContacts("email\n" + "a@x.co\n".repeat(3), 2).error).toMatch(/over the limit of 2/);
    expect(MAX_ROWS).toBe(5000);
  });
  it("leaves blank cells out instead of sending empty strings", () => {
    expect(readContacts("email,first_name,plan\na@x.co,,\n").rows[0].contact).toEqual({ email: "a@x.co" });
  });
});

describe("attributes", () => {
  it("infers types for CSV cells without mangling ids", () => {
    expect([infer("42"), infer("-1.5"), infer("TRUE"), infer("02134"), infer("+4915"), infer("12345678901234567890"), infer("  "), infer("pro")]).toEqual([42, -1.5, true, "02134", "+4915", "12345678901234567890", undefined, "pro"]);
  });
  it("coerces by the chosen type and explains failures", () => {
    expect(coerce("3", "number")).toEqual({ value: 3 });
    expect(coerce("", "number")).toEqual({ error: "Enter a number." });
    expect(coerce("true", "boolean")).toEqual({ value: true });
    expect(coerce('["a"]', "json")).toEqual({ value: ["a"] });
    expect(coerce("[", "json")).toEqual({ error: "Not valid JSON." });
    expect(coerce("007", "text")).toEqual({ value: "007" });
  });
  it("builds properties, deleting removed keys with null and flagging bad rows", () => {
    const rows = [{ key: "plan", type: "text" as const, value: "pro" }, { key: "seats", type: "number" as const, value: "5" }, { key: "", type: "text" as const, value: "" }];
    expect(buildProps(rows, ["plan", "old"])).toEqual({ props: { plan: "pro", seats: 5, old: null }, errors: {} });
    const bad = buildProps([{ key: "a.b", type: "text", value: "x" }, { key: "email", type: "text", value: "x" }, { key: "n", type: "number", value: "x" }, { key: "n", type: "text", value: "y" }, { key: "", type: "text", value: "orphan" }]);
    expect(Object.keys(bad.errors)).toEqual(["0", "1", "2", "3", "4"]);
    expect(bad.errors[0]).toMatch(/letters, numbers/);
  });
  it("round-trips existing properties into rows", () => {
    expect(rowsFromProps({ a: "x", n: 2, b: false, t: ["x"] })).toEqual([
      { key: "a", type: "text", value: "x" }, { key: "n", type: "number", value: "2" }, { key: "b", type: "boolean", value: "false" }, { key: "t", type: "json", value: '["x"]' },
    ]);
  });
});

describe("segment rule builder", () => {
  const c = (o: Partial<ReturnType<typeof newCond>>) => ({ ...newCond("attr"), ...o });
  it("compiles each condition kind to the backend rule model", () => {
    const rule = (x: ReturnType<typeof newCond>) => { const r = condToRule(x); return "rule" in r ? r.rule : r.error; };
    expect(rule(c({ key: "plan", op: "eq", value: "pro" }))).toEqual({ field: "properties.plan", op: "eq", value: "pro" });
    expect(rule(c({ key: "seats", op: "gte", vtype: "number", value: "5" }))).toEqual({ field: "properties.seats", op: "gte", value: 5 });
    expect(rule(c({ key: "beta", op: "eq", vtype: "boolean", value: "true" }))).toEqual({ field: "properties.beta", op: "eq", value: true });
    expect(rule(c({ key: "plan", op: "unset" }))).toEqual({ field: "properties.plan", op: "exists", value: false });
    expect(rule({ ...newCond("field"), key: "email", op: "contains", value: "@acme.com" })).toEqual({ field: "email", op: "contains", value: "@acme.com" });
    expect(rule({ ...newCond("created"), op: "gt", value: "2026-01-31" })).toEqual({ field: "created_at", op: "gt", value: "2026-01-31" });
    expect(rule({ ...newCond("topic"), key: "digest", op: "unsubscribed" })).toEqual({ field: "topic:digest", op: "eq", value: false });
    const ev = { ...newCond("event"), key: "login" };
    expect(rule({ ...ev, op: "atleast", value: "3" })).toEqual({ field: "event_count:login", op: "gte", value: 3 });
    expect(rule({ ...ev, op: "never" })).toEqual({ field: "event_count:login", op: "eq", value: 0 });
    expect(rule({ ...ev, op: "within", value: "30" })).toEqual({ field: "days_since:login", op: "lte", value: 30 });
    expect(rule({ ...ev, op: "notwithin", value: "30" })).toEqual({ or: [{ field: "days_since:login", op: "exists", value: false }, { field: "days_since:login", op: "gt", value: 30 }] });
  });
  it("says what is missing instead of producing a rule", () => {
    const err = (x: ReturnType<typeof newCond>) => { const r = condToRule(x); return "error" in r ? r.error : null; };
    expect(err(c({ key: "", value: "x" }))).toBe("Name the attribute.");
    expect(err(c({ key: "plan", value: "" }))).toBe("Enter a value.");
    expect(err(c({ key: "seats", vtype: "number", value: "many" }))).toBe("Enter a number.");
    expect(err({ ...newCond("event"), key: "login", op: "within", value: "1.5" })).toMatch(/whole number of days/);
    expect(err({ ...newCond("event"), key: "login", op: "atleast", value: "0" })).toMatch(/1 or more/);
    expect(err({ ...newCond("created"), op: "gt", value: "" })).toBe("Pick a date.");
  });
  it("joins with all / any and unwraps a single condition", () => {
    const a = c({ key: "plan", op: "eq", value: "pro" }), b = c({ key: "seats", op: "gt", vtype: "number", value: "2" });
    expect(toRule({ match: "and", conds: [a] }).rule).toEqual({ field: "properties.plan", op: "eq", value: "pro" });
    expect(toRule({ match: "or", conds: [a, b] }).rule).toEqual({ or: [{ field: "properties.plan", op: "eq", value: "pro" }, { field: "properties.seats", op: "gt", value: 2 }] });
    expect(toRule({ match: "and", conds: [] })).toEqual({ rule: null, errors: {} });
    expect(toRule({ match: "and", conds: [a, c({ key: "" })] })).toEqual({ rule: null, errors: { 1: "Name the attribute." } });
  });
  it("round-trips whatever the builder can express, and refuses the rest", () => {
    const b: Builder = { match: "or", conds: [
      c({ key: "plan", op: "eq", value: "pro" }), c({ key: "seats", op: "lte", vtype: "number", value: "9" }), c({ key: "x", op: "set" }),
      { ...newCond("field"), key: "timezone", op: "neq", value: "UTC" }, { ...newCond("created"), op: "lt", value: "2026-02-01" }, { ...newCond("topic"), key: "digest", op: "subscribed" },
      { ...newCond("event"), key: "login", op: "atleast", value: "2" }, { ...newCond("event"), key: "login", op: "never" },
      { ...newCond("event"), key: "login", op: "within", value: "7" }, { ...newCond("event"), key: "login", op: "notwithin", value: "30" },
    ] };
    expect(fromRule(toRule(b).rule)).toEqual(b);
    const one: Builder = { match: "and", conds: [{ ...newCond("event"), key: "login", op: "notwithin", value: "30" }] };
    expect(fromRule(toRule(one).rule)).toEqual(one);
    expect(fromRule(null)).toEqual({ match: "and", conds: [] });
    for (const odd of [{ not: { field: "email", op: "eq", value: "a" } }, { field: "properties.p", op: "in", value: ["a"] }, { and: [{ and: [{ field: "email", op: "eq", value: "a" }] }] }, { field: "contact.plan", op: "eq", value: "pro" }, { and: [] }, { nope: 1 }])
      expect(fromRule(odd)).toBeNull();
  });
  it("describes event rules in words", () => {
    expect(ruleWords({ field: "event_count:login", op: "gte", value: 3 })).toBe("login happened at least 3 times");
    expect(ruleWords({ field: "days_since:login", op: "lte", value: 7 })).toBe("login happened in the last 7 days");
    expect(ruleWords({ or: [{ field: "days_since:login", op: "exists", value: false }, { field: "days_since:login", op: "gt", value: 30 }] })).toBe("login has not happened in the last 30 days");
    expect(ruleWords({ field: "topic:digest", op: "eq", value: false })).toBe("unsubscribed from digest");
  });
});

describe("parseEmails", () => {
  it("splits on newlines, commas and semicolons, dedupes case-insensitively, and reports junk", () => {
    expect(parseEmails("a@x.co, B@y.org\nA@X.co;nope  c@z.io")).toEqual({ emails: ["a@x.co", "B@y.org", "c@z.io"], bad: ["nope"] });
  });
});
