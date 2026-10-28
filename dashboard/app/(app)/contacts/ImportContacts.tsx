"use client";
import { Download, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/copy";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import type { ApiError } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { importContactsChunk, previewImportChunk, type ListTarget } from "./actions";
import { ContactDiff, type PreviewRow, type PreviewSummary } from "./ContactDiff";
import { CSV_EXAMPLE, MAX_ROWS, readContacts } from "./csv";
import { pickableLists, type ListItem } from "./util";

const CHUNK = 500;
/** The preview keeps this many rows to show; its counts cover the whole file. */
const KEEP = 1000;
const MAX_BYTES = 4 * 1024 * 1024;
type Done = { imported: number; failed: { line: number; email: string; message: string }[]; error?: ApiError };

export function downloadExample() {
  const url = URL.createObjectURL(new Blob([CSV_EXAMPLE], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "example.csv" });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

type Preview = { summary: PreviewSummary; rows: PreviewRow[]; list: { name: string; exists: boolean } | null; error?: ApiError };
const EMPTY: PreviewSummary = { new: 0, update: 0, unchanged: 0, skipped: 0 };
const today = () => new Date().toISOString().slice(0, 10);

function Body({ lists }: { lists: ListItem[] }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  // "" = no list, "new" = a list named below, otherwise an existing list's id
  const choices = pickableLists(lists);
  const [pick, setPick] = useState("new");
  const [newName, setNewName] = useState("");
  const [named, setNamed] = useState(false);
  const [preview, setPreview] = useState<Preview | "checking" | null>(null);
  const [fileErr, setFileErr] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const parsed = useMemo(() => (text.trim() ? readContacts(text) : null), [text]);

  // The list's default display name is the file's name without its extension (a pasted CSV gets the date).
  const suggested = fileName ? fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() : `Import ${today()}`;
  const listName = named ? newName.trim() : suggested;
  const target: ListTarget = pick === "" ? null : pick === "new" ? (listName ? { name: listName } : null) : { id: pick };
  const nameMissing = pick === "new" && !listName; // "New list…" with no name would import into no list at all
  const targetKey = JSON.stringify(target);

  async function onFile(f?: File) {
    setFileErr("");
    if (!f) return;
    if (f.size > MAX_BYTES) return setFileErr(`That file is ${(f.size / 1048576).toFixed(1)} MB; the limit is 4 MB. Split it.`);
    setFileName(f.name);
    setText(await f.text());
  }

  // Before anything is written: ask the server what each row would do. Re-asked when the file or the target list changes.
  useEffect(() => {
    if (!parsed || parsed.error || !parsed.rows.length) { setPreview(null); return; }
    let stale = false;
    setPreview("checking");
    const t = setTimeout(async () => {
      const all = parsed.rows, summary = { ...EMPTY }, rows: PreviewRow[] = [];
      let list: Preview["list"] = null;
      for (let i = 0; i < all.length && !stale; i += CHUNK) {
        const slice = all.slice(i, i + CHUNK);
        const r = await previewImportChunk(slice.map((x) => x.contact), target);
        if (r.error) { if (!stale) setPreview({ summary, rows, list, error: r.error }); return; }
        list = r.list;
        for (const x of r.rows) {
          summary[x.status]++;
          if (rows.length < KEEP) rows.push({ ...x, line: slice[x.index ?? 0]?.line });
        }
      }
      if (!stale) setPreview({ summary, rows, list });
    }, 350);
    return () => { stale = true; clearTimeout(t); };
  }, [parsed, targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    if (!parsed?.rows.length) return;
    const all = parsed.rows, out: Done = { imported: 0, failed: [] };
    setProgress(0);
    for (let i = 0; i < all.length; i += CHUNK) {
      const slice = all.slice(i, i + CHUNK);
      const r = await importContactsChunk(slice.map((x) => x.contact), target);
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
          <p className="mt-0.5">People who were already contacts were updated, not duplicated.{target && <> Everyone imported is on <strong>{target.id ? choices.find((l) => l.id === target.id)?.name : target.name}</strong>.</>}</p>
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
      {ok > 0 && (
        <fieldset className="grid gap-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">Add to a list</legend>
          <p className="-mt-1 text-sm text-muted">Everyone in the file, new or already a contact, goes on this list. It keeps imports grouped and lets you send to just them.</p>
          <Field label="List">
            {(a) => (
              <Select {...a} value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="new">New list…</option>
                {choices.length > 0 && <optgroup label="Existing lists">{choices.map((l) => <option key={l.id} value={l.id}>{l.name} ({formatNumber(l.member_count)})</option>)}</optgroup>}
                <option value="">Do not add to a list</option>
              </Select>
            )}
          </Field>
          {pick === "new" && <Field label="New list name" description="Shown on each contact and in the Lists tab. You can rename it later." error={nameMissing ? "Give the list a name, or choose Do not add to a list." : undefined}>{(a) => <Input {...a} value={named ? newName : suggested} maxLength={100} autoComplete="off" onChange={(e) => { setNamed(true); setNewName(e.target.value); }} />}</Field>}
        </fieldset>
      )}
      {parsed && !parsed.error && (
        <div className="grid gap-3" role="status" aria-live="polite">
          <p className="text-sm"><strong>{formatNumber(ok)}</strong> ready to import{parsed.invalid.length > 0 && <>, <strong className="text-bad">{formatNumber(parsed.invalid.length)}</strong> will be skipped</>}.
            {parsed.columns.length > 0 && <span className="text-muted"> Columns: {parsed.columns.join(", ")}.</span>}</p>
          {preview === "checking" && <p className="text-sm text-muted">Checking what would change…</p>}
          {preview && preview !== "checking" && (preview.error
            ? <ErrorState error={preview.error} />
            : <ContactDiff caption="What the import would change" rows={preview.rows} summary={preview.summary} listName={preview.list?.name}
                sample={preview.rows.length >= KEEP && ok > KEEP ? `Showing the first ${formatNumber(KEEP)} rows. The counts cover all ${formatNumber(ok)}.` : undefined} />)}
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
        <Button disabled={!ok || progress !== null || nameMissing} onClick={run}>{progress !== null ? `Importing ${formatNumber(progress)} of ${formatNumber(ok)}` : `Import ${ok ? formatNumber(ok) : ""} ${ok === 1 ? "contact" : "contacts"}`}</Button>
      </div>
    </div>
  );
}

export function ImportContacts({ lists = [] }: { lists?: ListItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="secondary"><Upload aria-hidden />Import CSV</Button></DialogTrigger>
      <DialogContent title="Import contacts from CSV" className="max-h-[calc(100dvh-2rem)] max-w-4xl overflow-y-auto">
        <Body lists={lists} />
      </DialogContent>
    </Dialog>
  );
}
