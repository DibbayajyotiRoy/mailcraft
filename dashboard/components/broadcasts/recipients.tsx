"use client";
import { Download, FileSpreadsheet, Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/copy";
import { Field, Input } from "@/components/ui/field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { EXAMPLE_CSV, headerKey, recipientsFromCsv, recipientsFromGrid, type Parsed } from "@/lib/csv";

const SHOWN_ISSUES = 20;

/** Counts, columns and problem rows for a parsed list, shared by both tabs. */
export function Summary({ p }: { p: Parsed }) {
  if (p.error) return <p role="alert" className="rounded-md border border-bad/40 bg-bad-bg p-3 text-sm text-bad">{p.error}</p>;
  return (
    <div className="grid gap-3" role="status" aria-label="Recipients summary">
      <p className="text-sm">
        <strong className="tabular-nums">{p.recipients.length}</strong> {p.recipients.length === 1 ? "recipient" : "recipients"} ready
        {p.issues.length > 0 && <>, <strong className="tabular-nums text-bad">{p.issues.length}</strong> invalid</>}
        {p.duplicates > 0 && <>, <strong className="tabular-nums">{p.duplicates}</strong> {p.duplicates === 1 ? "duplicate" : "duplicates"} removed</>}
        <span className="text-muted"> · {p.rows} {p.rows === 1 ? "row" : "rows"} read</span>
      </p>
      {p.columns.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">Extra columns:
          {p.columns.map((c) => <Badge key={c} tone="neutral" size="sm"><code>{`{{ data.${c} }}`}</code></Badge>)}
        </p>
      )}
      {p.issues.length > 0 && (
        <details className="text-sm" open={p.issues.length <= 5}>
          <summary className="inline-flex h-7 cursor-pointer items-center text-bad underline underline-offset-2 pointer-coarse:h-11">Why {p.issues.length} {p.issues.length === 1 ? "row was" : "rows were"} left out</summary>
          <Table caption="Invalid rows" className="mt-2">
            <THead><TR><TH>Row</TH><TH>Email</TH><TH>Reason</TH></TR></THead>
            <TBody>
              {p.issues.slice(0, SHOWN_ISSUES).map((i) => (
                <TR key={i.row}><TD label="Row" num>{i.row}</TD><TD label="Email" className="font-mono text-xs [overflow-wrap:anywhere]">{i.email || "(empty)"}</TD><TD label="Reason">{i.reason}</TD></TR>
              ))}
            </TBody>
          </Table>
          {p.issues.length > SHOWN_ISSUES && <p className="mt-1 text-xs text-muted">and {p.issues.length - SHOWN_ISSUES} more</p>}
        </details>
      )}
    </div>
  );
}

const exampleHref = `data:text/csv;charset=utf-8,${encodeURIComponent(EXAMPLE_CSV)}`;

export function CsvTab({ parsed, fileName, onParsed }: { parsed: Parsed | null; fileName: string; onParsed: (p: Parsed | null, name: string) => void }) {
  const [over, setOver] = useState(false);
  async function read(f?: File) {
    if (!f) return;
    onParsed(recipientsFromCsv(await f.text()), f.name);
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="grid content-start gap-4">
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); read(e.dataTransfer.files[0]); }}
          className={cn("grid gap-3 rounded-lg border border-dashed border-border-strong p-4 transition-colors duration-[var(--dur-fast)]", over && "border-accent bg-accent-soft")}>
          <p className="flex items-center gap-2 text-sm"><Upload aria-hidden className="size-4 text-muted" />Drag a .csv file here, or choose one.</p>
          <Field label="CSV file" description="The first row must be a header. Up to 5000 rows.">
            {(a) => <Input {...a} type="file" accept=".csv,text/csv,text/plain" onChange={(e) => read(e.target.files?.[0])} />}
          </Field>
          {fileName && <p className="flex items-center gap-2 text-sm text-muted"><FileSpreadsheet aria-hidden className="size-4" /><span className="truncate">{fileName}</span></p>}
        </div>
        {parsed && <Summary p={parsed} />}
      </div>
      <Card className="self-start">
        <CardHeader title="CSV format" description="One recipient per line, with a header row." />
        <CardBody className="grid gap-3">
          <CodeBlock language="csv" code={EXAMPLE_CSV.trimEnd()} />
          <a href={exampleHref} download="example.csv" className={cn(buttonVariants({ variant: "secondary" }), "justify-self-start")}><Download aria-hidden />Download example.csv</a>
          <ul className="grid list-disc gap-1 pl-5 text-xs text-muted">
            <li><code>email</code> is required; <code>first_name</code> and <code>last_name</code> are optional.</li>
            <li>Any other column is usable as <code>{"{{ data.company }}"}</code> (column <code>company</code>). Spaces and capitals in a header become <code>_</code> and lower case.</li>
            <li>Wrap a value that contains a comma in double quotes. Excel and Google Sheets exports work as they are.</li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

type Grid = Record<string, string>[];
const emptyRow = (): Record<string, string> => ({ email: "", first_name: "", last_name: "" });

/** Editable table for a handful of recipients (quick tests). `state` lives in the parent so switching tabs keeps it. */
export function TypeTab({ rows, fields, onChange }: { rows: Grid; fields: string[]; onChange: (rows: Grid, fields: string[], p: Parsed) => void }) {
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState("");
  const emit = (r: Grid, f: string[]) => onChange(r, f, recipientsFromGrid(r, f));
  const set = (i: number, k: string, v: string) => emit(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)), fields);
  function addField() {
    const k = headerKey(name);
    if (!k) return setNameErr("Give the field a name, like company.");
    if (["email", "first_name", "last_name", ...fields].includes(k)) return setNameErr(`“${k}” is already a column.`);
    setNameErr(""); setName("");
    emit(rows, [...fields, k]);
  }
  const cols = [{ k: "email", label: "Email" }, { k: "first_name", label: "First name" }, { k: "last_name", label: "Last name" }, ...fields.map((f) => ({ k: f, label: f }))];
  return (
    <div className="grid gap-4">
      <Table caption="Recipients" stack>
        <THead><TR>{cols.map((c) => <TH key={c.k}>{c.label}</TH>)}<TH><span className="sr-only">Remove</span></TH></TR></THead>
        <TBody>
          {rows.map((r, i) => (
            <TR key={i}>
              {cols.map((c) => (
                <TD key={c.k} label={c.label} className="min-w-36 max-md:before:w-24 max-md:before:content-[attr(data-label)] max-md:[&>input]:min-w-0 max-md:[&>input]:flex-1">
                  <Input aria-label={`${c.label}, recipient ${i + 1}`} value={r[c.k] ?? ""} onChange={(e) => set(i, c.k, e.target.value)}
                    inputMode={c.k === "email" ? "email" : undefined} autoComplete="off" className="max-md:text-left" />
                </TD>
              ))}
              <TD label="Remove" className="w-12">
                <Button variant="ghost" size="icon" aria-label={`Remove recipient ${i + 1}`} onClick={() => emit(rows.length > 1 ? rows.filter((_, j) => j !== i) : [emptyRow()], fields)}><Trash2 aria-hidden /></Button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <Button variant="secondary" onClick={() => emit([...rows, emptyRow()], fields)}><Plus aria-hidden />Add recipient</Button>
        <form className="flex flex-wrap items-start gap-2" onSubmit={(e) => { e.preventDefault(); addField(); }}>
          <Field label="New field" error={nameErr} description="Use it as {{ data.name }}" className="w-48">
            {(a) => <Input {...a} value={name} onChange={(e) => setName(e.target.value)} placeholder="company" autoComplete="off" />}
          </Field>
          <Button type="submit" variant="secondary" className="mt-[1.625rem]">Add field</Button>
        </form>
      </div>
    </div>
  );
}

/** Both input methods under tabs; the visible tab is the one that counts. */
export function RecipientsStep({ onActive }: { onActive: (p: Parsed | null) => void }) {
  const [tab, setTab] = useState("csv");
  const [csv, setCsv] = useState<Parsed | null>(null);
  const [file, setFile] = useState("");
  const [grid, setGrid] = useState<{ rows: Grid; fields: string[]; p: Parsed | null }>({ rows: [emptyRow(), emptyRow(), emptyRow()], fields: [], p: null });
  const pick = (t: string, c = csv, g = grid.p) => { setTab(t); onActive(t === "csv" ? c : g); };
  return (
    <Tabs value={tab} onValueChange={(t) => pick(t)}>
      <TabsList aria-label="How to add recipients"><TabsTrigger value="csv">Upload CSV</TabsTrigger><TabsTrigger value="type">Type recipients</TabsTrigger></TabsList>
      <TabsContent value="csv">
        <CsvTab parsed={csv} fileName={file} onParsed={(p, n) => { setCsv(p); setFile(n); onActive(p); }} />
      </TabsContent>
      <TabsContent value="type">
        <TypeTab rows={grid.rows} fields={grid.fields} onChange={(rows, fields, p) => { setGrid({ rows, fields, p }); onActive(p); }} />
        {grid.p && <div className="mt-4"><Summary p={grid.p} /></div>}
      </TabsContent>
    </Tabs>
  );
}
