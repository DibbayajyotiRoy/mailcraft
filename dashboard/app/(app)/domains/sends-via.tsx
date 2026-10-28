"use client";
import { useActionState, useEffect, useRef } from "react";
import { SubmitButton } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { bindTransport, type Result } from "./sends-via-actions";

export type TransportOpt = { id: string; name?: string; kind: string; is_default?: boolean };

/** "Sends via": which transport mail from this domain uses (the default unless a mailbox address or the request says otherwise). */
export function SendsVia({ id, domain, transportId, transports }: { id: string; domain: string; transportId?: string | null; transports: TransportOpt[] }) {
  const [s, act] = useActionState(bindTransport, {} as Result);
  const shown = useRef<Result>(undefined);
  useEffect(() => { if (s.ok && shown.current !== s) { shown.current = s; toast.success(s.ok); } }, [s]);
  const def = transports.find((t) => t.is_default);
  return (
    <form action={act} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
      <input type="hidden" name="id" value={id} />
      <Field label="Sends via" description={`Mail from ${domain} goes through this transport. A mailbox address always uses its own mailbox.`}>
        {(a) => (
          <Select {...a} name="transport_id" defaultValue={transportId ?? ""} disabled={!transports.length}>
            <option value="">{def ? `Workspace default (${def.name ?? def.kind})` : "Workspace default"}</option>
            {transports.map((t) => <option key={t.id} value={t.id}>{t.name ?? t.kind}</option>)}
          </Select>
        )}
      </Field>
      <SubmitButton variant="secondary" disabled={!transports.length} aria-label={`Save transport for ${domain}`}>Save</SubmitButton>
      {s.error && <p role="alert" className="text-sm font-medium text-bad sm:col-span-2">{s.error}</p>}
    </form>
  );
}
