"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { useActionState, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { ApiError } from "@/lib/api";
import { Button, SubmitButton } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { saveContact, type FormState } from "./actions";
import { ATTR_TYPES, EMAIL_RE, buildProps, isTimeZone, rowsFromProps, tzGroups, type AttrRow, type AttrType } from "./attrs";
import type { Contact } from "./util";

type Errs = Partial<Record<"email" | "timezone", string>>;

/** Which visible field an API error belongs to (the API names `field` for some, only the message for others). */
function errField(e?: ApiError): "email" | "timezone" | undefined {
  if (!e) return undefined;
  if (e.field === "email" || e.field === "timezone") return e.field;
  return e.field ? undefined : /time ?zone/i.test(e.message) ? "timezone" : /\bemail\b/i.test(e.message) ? "email" : undefined;
}

function AttributeRows({ rows, setRows, errors }: { rows: AttrRow[]; setRows: (r: AttrRow[]) => void; errors: Record<number, string> }) {
  const set = (i: number, patch: Partial<AttrRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Attributes</legend>
      <p className="-mt-1 mb-1 text-xs text-muted">Anything else you know about them, like plan or company. Segments and templates can use these.</p>
      {rows.map((r, i) => {
        const n = i + 1, eid = `attr-err-${i}`;
        return (
          <div key={i} role="group" aria-label={`Attribute ${n}`} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[minmax(0,1fr)_6.5rem_minmax(0,1.2fr)_auto] sm:items-start sm:border-0 sm:p-0">
            <Input name="attr_key" aria-label={`Attribute ${n} name`} placeholder="name, e.g. plan" value={r.key} autoComplete="off" spellCheck={false}
              aria-invalid={errors[i] ? true : undefined} aria-describedby={errors[i] ? eid : undefined} onChange={(e) => set(i, { key: e.target.value })} />
            <Select name="attr_type" aria-label={`Attribute ${n} type`} value={r.type}
              onChange={(e) => { const type = e.target.value as AttrType; set(i, { type, value: type === "boolean" && r.value !== "true" && r.value !== "false" ? "true" : r.value }); }}>
              {ATTR_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
            {r.type === "boolean" ? (
              <Select name="attr_value" aria-label={`Attribute ${n} value`} value={r.value} onChange={(e) => set(i, { value: e.target.value })}><option value="true">Yes</option><option value="false">No</option></Select>
            ) : (
              <Input name="attr_value" aria-label={`Attribute ${n} value`} placeholder={r.type === "json" ? '["a","b"]' : "value"} value={r.value} mono={r.type === "json"}
                aria-invalid={errors[i] ? true : undefined} aria-describedby={errors[i] ? eid : undefined} onChange={(e) => set(i, { value: e.target.value })} />
            )}
            <Button variant="ghost" size="icon" aria-label={`Remove attribute ${n}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 aria-hidden /></Button>
            {errors[i] && <p id={eid} className="text-xs font-medium text-bad sm:col-span-4">{errors[i]}</p>}
          </div>
        );
      })}
      <div><Button variant="secondary" size="sm" onClick={() => setRows([...rows, { key: "", type: "text", value: "" }])}><Plus aria-hidden />Add attribute</Button></div>
    </fieldset>
  );
}

function Body({ contact, close }: { contact?: Contact; close: () => void }) {
  const router = useRouter();
  const editing = !!contact?.id;
  const [state, act] = useActionState<FormState, FormData>(saveContact, {});
  const [rows, setRows] = useState<AttrRow[]>(() => rowsFromProps(contact?.properties));
  const [local, setLocal] = useState<{ errs: Errs; attrs: Record<number, string> }>({ errs: {}, attrs: {} });
  const tz = useMemo(() => tzGroups((Intl as any).supportedValuesOf?.("timeZone") ?? [], [contact?.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone]), [contact?.timezone]);
  const initial = useMemo(() => Object.keys(contact?.properties ?? {}), [contact]);

  useEffect(() => {
    if (!state.ok) return;
    toast.success(state.ok);
    close();
    if (!editing && state.id) router.push(`/contacts/${state.id}`);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    const d = new FormData(ev.currentTarget), errs: Errs = {};
    if (!editing && !EMAIL_RE.test(String(d.get("email") ?? "").trim())) errs.email = "Enter an email address like ana@example.com.";
    const tz = String(d.get("timezone") ?? "").trim();
    if (tz && !isTimeZone(tz)) errs.timezone = "Use a time zone name like Europe/Berlin.";
    const attrs = buildProps(rows, initial).errors;
    setLocal({ errs, attrs });
    if (Object.keys(errs).length || Object.keys(attrs).length) ev.preventDefault();
  }

  const mapped = errField(state.error);
  const serverErr = (k: "email" | "timezone") => (mapped === k && state.error ? <>{state.error.message}{state.error.hint ? ` ${state.error.hint}` : ""}{state.error.code === "already_exists" && state.id && <> <Link className="underline" href={`/contacts/${state.id}`}>Open contact</Link></>}</> : undefined);
  const attrErrors = state.attrErrors ?? local.attrs;

  return (
    <form action={act} onSubmit={onSubmit} noValidate className="grid gap-4">
      {contact?.id && <input type="hidden" name="id" value={contact.id} />}
      <input type="hidden" name="initial_keys" value={JSON.stringify(initial)} />
      <Field label="Email" description={editing ? "The address can't be changed. To use another one, add a new contact." : undefined} error={local.errs.email ?? serverErr("email")}>
        {(a) => <Input {...a} name="email" type="email" required={!editing} readOnly={editing} defaultValue={contact?.email} placeholder="ana@example.com" autoComplete="off" spellCheck={false} autoFocus={!editing} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name">{(a) => <Input {...a} name="first_name" defaultValue={contact?.first_name ?? ""} autoComplete="off" />}</Field>
        <Field label="Last name">{(a) => <Input {...a} name="last_name" defaultValue={contact?.last_name ?? ""} autoComplete="off" />}</Field>
      </div>
      <Field label="Time zone" description="Used for quiet hours. Optional." error={local.errs.timezone ?? serverErr("timezone")}>
        {(a) => <Select {...a} name="timezone" defaultValue={contact?.timezone ?? ""}>
          <option value="">Not set</option>
          {tz.map(([group, zs]) => <optgroup key={group} label={group}>{zs.map(([z, l]) => <option key={group + z} value={z}>{l}</option>)}</optgroup>)}
        </Select>}
      </Field>
      <AttributeRows rows={rows} setRows={setRows} errors={attrErrors} />
      {state.error && !mapped && <ErrorState error={state.error} />}
      <div className="flex justify-end gap-2">
        <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
        <SubmitButton>{editing ? "Save changes" : "Add contact"}</SubmitButton>
      </div>
    </form>
  );
}

/** Add (no `contact`) or edit (`contact`) dialog; `children` is the trigger button. */
export function ContactDialog({ contact, children }: { contact?: Contact; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent title={contact ? "Edit contact" : "Add a contact"} description={contact ? contact.email : "Add one person. To add many at once, import a CSV."} className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        <Body contact={contact} close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

export const AddContact = ({ label = "Add contact" }: { label?: string }) => <ContactDialog><Button><Plus aria-hidden />{label}</Button></ContactDialog>;
