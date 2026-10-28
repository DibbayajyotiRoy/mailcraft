"use client";
import { Download, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/copy";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { ApiError } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { importContactsChunk } from "./actions";
import { CSV_EXAMPLE, MAX_ROWS, readContacts } from "./csv";

const CHUNK = 500;
const MAX_BYTES = 4 * 1024 * 1024;
type Done = { imported: number; failed: { line: number; email: string; message: string }[]; error?: ApiError };

export function downloadExample() {
  const url = URL.createObjectURL(new Blob([CSV_EXAMPLE], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "example.csv" });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function Body() {
  const [text, setText] = useState("");
  const [fileErr, setFileErr] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const parsed = useMemo(() => (text.trim() ? readContacts(text) : null), [text]);

  async function onFile(f?: File) {
    setFileErr("");
    if (!f) return;
    if (f.size > MAX_BYTES) return setFileErr(`That file is ${(f.size / 1048576).toFixed(1)} MB; the limit is 4 MB. Split it.`);
    setText(await f.text());
  }

  async function run() {
    if (!parsed?.rows.length) return;
    const all = parsed.rows, out: Done = { imported: 0, failed: [] };
    setProgress(0);
    for (let i = 0; i < all.length; i += CHUNK) {
      const slice = all.slice(i, i + CHUNK);
      const r = await importContactsChunk(slice.map((x) => x.contact));
      out.imported += r.imported;
      for (const x of r.failed) out.failed.push({ line: slice[x.index]?.line ?? 0, email: x.email, message: x.message });
      if (r.error) { out.error = r.error; break; }
      setProgress(Math.min(all.length, i + CHUNK));
    }
    setProgress(null);
    setDone(out);
  }

  if (done) {
    return (
      <div className="grid gap-4">
        <div role="status" className={`rounded-lg border p-3 text-sm ${done.imported ? "border-ok/40 bg-ok-bg text-ok" : "border-border bg-surface-2"}`}>
          <p className="font-medium">{formatNumber(done.imported)} {done.imported === 1 ? "contact" : "contacts"} imported{done.failed.length ? `, ${formatNumber(done.failed.length)} skipped` : ""}.</p>
          <p className="mt-0.5">People who were already contacts were updated, not duplicated.</p>
        </div>
        {done.error && <ErrorState error={done.error} />}
        {done.failed.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-medium">Skipped rows</h3>
            <ul className="max-h-40 overflow-y-auto rounded-md border border-border p-2 text-sm">
              {done.failed.slice(0, 50).map((x) => <li key={x.line}><span className="text-muted">Row {x.line}:</span> {x.email} <span className="text-bad">{x.message}</span></li>)}
              {done.failed.length > 50 && <li className="text-muted">and {done.failed.length - 50} more</li>}
            </ul>
          </div>
        )}
        <div className="flex justify-end"><DialogClose asChild><Button>Done</Button></DialogClose></div>
      </div>
    );
  }

  const ok = parsed && !parsed.error ? parsed.rows.length : 0;
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">CSV format</h3>
        <p className="text-sm text-muted">
          First row is a header. <code>email</code> is required; <code>first_name</code>, <code>last_name</code> and <code>timezone</code> fill those fields, and every other column becomes an attribute.
          Numbers and true/false keep their type. Up to {formatNumber(MAX_ROWS)} rows. Existing contacts are updated.
        </p>
        <CodeBlock language="csv" code={CSV_EXAMPLE} />
        <div><Button variant="secondary" size="sm" onClick={downloadExample}><Download aria-hidden />Download example.csv</Button></div>
      </div>
      <Field label="CSV file" error={fileErr || undefined}>{(a) => <Input {...a} type="file" accept=".csv,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} />}</Field>
      <Field label="Or paste the CSV">{(a) => <Textarea {...a} mono rows={5} value={text} spellCheck={false} placeholder={CSV_EXAMPLE} onChange={(e) => setText(e.target.value)} />}</Field>
      {parsed?.error && <ErrorState error={{ code: "invalid_csv", message: parsed.error }} />}
      {parsed && !parsed.error && (
        <div className="grid gap-3" role="status" aria-live="polite">
          <p className="text-sm"><strong>{formatNumber(ok)}</strong> ready to import{parsed.invalid.length > 0 && <>, <strong className="text-bad">{formatNumber(parsed.invalid.length)}</strong> will be skipped</>}.
            {parsed.columns.length > 0 && <span className="text-muted"> Columns: {parsed.columns.join(", ")}.</span>}</p>
          {ok > 0 && (
            <Table caption="First rows to import" stack={false}>
              <THead><TR><TH>Row</TH><TH>Email</TH><TH>Name</TH><TH>Attributes</TH></TR></THead>
              <TBody>{parsed.rows.slice(0, 5).map(({ line, contact: c }) => (
                <TR key={line}><TD className="tabular-nums text-muted">{line}</TD><TD className="font-mono text-xs">{c.email}</TD><TD>{[c.first_name, c.last_name].filter(Boolean).join(" ") || <span className="text-subtle">-</span>}</TD><TD className="max-w-48 truncate text-muted">{Object.keys(c.properties ?? {}).join(", ") || "-"}</TD></TR>
              ))}</TBody>
            </Table>
          )}
          {parsed.invalid.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Rows that will be skipped</h3>
              <ul className="max-h-32 overflow-y-auto rounded-md border border-border p-2 text-sm">
                {parsed.invalid.slice(0, 20).map((x) => <li key={x.line}><span className="text-muted">Row {x.line}:</span> {x.email && <span className="font-mono text-xs">{x.email} </span>}<span className="text-bad">{x.message}</span></li>)}
                {parsed.invalid.length > 20 && <li className="text-muted">and {parsed.invalid.length - 20} more</li>}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <DialogClose asChild><Button variant="secondary" disabled={progress !== null}>Cancel</Button></DialogClose>
        <Button disabled={!ok || progress !== null} onClick={run}>{progress !== null ? `Importing ${formatNumber(progress)} of ${formatNumber(ok)}` : `Import ${ok ? formatNumber(ok) : ""} ${ok === 1 ? "contact" : "contacts"}`}</Button>
      </div>
    </div>
  );
}

export function ImportContacts() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="secondary"><Upload aria-hidden />Import CSV</Button></DialogTrigger>
      <DialogContent title="Import contacts from CSV" className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
        <Body />
      </DialogContent>
    </Dialog>
  );
}
