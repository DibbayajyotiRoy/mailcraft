"use client";
import { useMemo, type FormEvent } from "react";
import { tzGroups } from "@/app/(app)/contacts/attrs";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Select } from "@/components/ui/field";
import type { ApiError } from "@/lib/api";

/** One address that is not a contact yet, with the details typed for it. */
export type NewRow = { email: string; first_name: string; last_name: string; timezone: string };

/** The second step of "New email": the addresses that are not contacts yet get a name and a time zone, then the email goes out.
 *  Same grouped time zone list as the contact form. */
export function NewContactsStep({ rows, onRows, busy, error, onBack, onSubmit }: {
  rows: NewRow[]; onRows: (r: NewRow[]) => void; busy: boolean; error: ApiError | null; onBack: () => void; onSubmit: () => void;
}) {
  const zones = useMemo(() => tzGroups((Intl as any).supportedValuesOf?.("timeZone") ?? [], [Intl.DateTimeFormat().resolvedOptions().timeZone]), []);
  const set = (i: number, p: Partial<NewRow>) => onRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const many = rows.length > 1;
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }} className="grid gap-4">
      <p className="text-sm text-muted">
        {many ? "These addresses aren’t in your contacts yet." : "This address isn’t in your contacts yet."} Add {many ? "them" : "it"} here and the email is sent right after. Names and time zone are optional.
      </p>
      {rows.map((r, i) => (
        <fieldset key={r.email} className="grid gap-3 rounded-md border border-border p-3">
          <legend className="max-w-full break-all px-1 text-sm font-medium">{r.email}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name">{(a) => <Input {...a} autoComplete="off" autoFocus={i === 0} value={r.first_name} onChange={(e) => set(i, { first_name: e.target.value })} />}</Field>
            <Field label="Last name">{(a) => <Input {...a} autoComplete="off" value={r.last_name} onChange={(e) => set(i, { last_name: e.target.value })} />}</Field>
          </div>
          <Field label="Time zone" description="Used for quiet hours. Optional.">
            {(a) => (
              <Select {...a} value={r.timezone} onChange={(e) => set(i, { timezone: e.target.value })}>
                <option value="">Not set</option>
                {zones.map(([group, zs]) => <optgroup key={group} label={group}>{zs.map(([z, l]) => <option key={group + z} value={z}>{l}</option>)}</optgroup>)}
              </Select>
            )}
          </Field>
        </fieldset>
      ))}
      {error && <ErrorState error={error} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onBack} disabled={busy}>Back</Button>
        <Button type="submit" loading={busy}>{many ? `Create ${rows.length} contacts and send` : "Create contact and send"}</Button>
      </div>
    </form>
  );
}
