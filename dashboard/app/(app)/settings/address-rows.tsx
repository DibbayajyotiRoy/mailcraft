"use client";
import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";

export type Row = { address: string; name: string };

/** "Addresses this mailbox sends as": the login (always one) and any provider "send mail as" aliases, each with an
 *  optional display name. Plain inputs named login_name / alias_address / alias_name, read by `mailboxFields`. */
export function AddressRows({ login, loginName = "", aliases = [] }: { login: string; loginName?: string; aliases?: Row[] }) {
  const n = useRef(aliases.length);
  const [rows, setRows] = useState(() => aliases.map((r, i) => ({ ...r, key: i })));
  return (
    <fieldset className="grid gap-2 border-0 p-0">
      <legend className="mb-1 text-sm font-medium">Addresses this mailbox sends as</legend>
      <p className="text-xs text-muted">The login is always one. Add the &ldquo;send mail as&rdquo; aliases you set up with the provider. The display name is what recipients see in From.</p>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem]">
        <span className="min-w-0 truncate font-mono text-[12.5px]" title={login}>{login || "the username above"}</span>
        <Input name="login_name" defaultValue={loginName} placeholder="Display name (optional)" aria-label={`Display name for ${login || "the login"}`} autoComplete="off" />
        <span aria-hidden className="hidden sm:block" />
      </div>
      {rows.map((r, i) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem]">
          <Input name="alias_address" type="email" mono defaultValue={r.address} placeholder="support@example.com" aria-label={`Alias ${i + 1} address`} autoComplete="off" />
          <Input name="alias_name" defaultValue={r.name} placeholder="Display name (optional)" aria-label={`Alias ${i + 1} display name`} autoComplete="off" />
          <Button variant="ghost" size="icon" aria-label={`Remove alias ${i + 1}`} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}><X aria-hidden /></Button>
        </div>
      ))}
      <div><Button variant="secondary" size="sm" onClick={() => setRows([...rows, { address: "", name: "", key: n.current++ }])}><Plus aria-hidden />Add address</Button></div>
    </fieldset>
  );
}
