"use client";
import Link from "next/link";
import { Zap } from "lucide-react";
import { useActionState, useState } from "react";
import type { ApiError } from "@/lib/api";
import { Button, SubmitButton } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Textarea } from "@/components/ui/field";
import { trackEvent, type TrackState } from "./actions";

const fieldMsg = (e: ApiError | undefined, f: string) => (e?.field === f ? `${e.message}${e.hint ? ` ${e.hint}` : ""}` : undefined);

function Body({ email, events, automations }: { email: string; events: string[]; automations: Record<string, string> }) {
  const [state, act] = useActionState<TrackState, FormData>(trackEvent, {});
  const r = state.result;
  const rest = state.error && !["name", "properties"].includes(state.error.field ?? "") ? state.error : null;
  return (
    <form action={act} className="grid gap-4">
      <input type="hidden" name="email" value={email} />
      <Field label="Event name" description="Automations start when an event with their trigger name arrives." error={fieldMsg(state.error, "name")}>
        {(a) => <><Input {...a} name="name" list="track-events" required maxLength={128} placeholder="signed_up" autoComplete="off" spellCheck={false} autoFocus /><datalist id="track-events">{events.map((e) => <option key={e} value={e} />)}</datalist></>}
      </Field>
      <Field label="Properties" description="Optional JSON object sent with the event." error={fieldMsg(state.error, "properties")}>
        {(a) => <Textarea {...a} name="properties" mono rows={3} placeholder='{"plan":"pro"}' spellCheck={false} />}
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="dry_run" className="mt-1 size-4 accent-[var(--accent)]" />
        <span><span className="font-medium">Dry run</span><span className="block text-xs text-muted">Only show which automations would start. Nothing is recorded or sent.</span></span>
      </label>
      {rest && <ErrorState error={rest} />}
      {r && (
        <div role="status" className="rounded-lg border border-ok/40 bg-ok-bg p-3 text-sm text-ok">
          <p className="font-medium">{r.dry ? "Dry run: nothing was recorded." : r.duplicate ? "Already recorded: this exact event was seen before." : "Event recorded."}</p>
          {r.triggered.length ? (
            <ul className="mt-1 list-disc pl-5">
              {r.triggered.map((t) => <li key={t.id}>{r.dry ? "Would start " : "Started "}<Link className="underline" href={`/automations/${t.id}`}>{t.name ?? automations[t.id] ?? t.id}</Link></li>)}
            </ul>
          ) : <p className="mt-1">No active automation listens for this event.</p>}
          {r.inactive.length > 0 && <p className="mt-1">Not active, so not started: {r.inactive.map((a) => `${a.name} (${a.status})`).join(", ")}.</p>}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <DialogClose asChild><Button variant="secondary">{r ? "Close" : "Cancel"}</Button></DialogClose>
        <SubmitButton>Send event</SubmitButton>
      </div>
    </form>
  );
}

/** Fires a test event for one contact: the quickest way to watch an automation start. */
export function TrackEvent({ email, events, automations }: { email: string; events: string[]; automations: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="secondary"><Zap aria-hidden />Track event</Button></DialogTrigger>
      <DialogContent title="Track an event" description={<>For <span className="font-mono text-xs">{email}</span></>} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <Body email={email} events={events} automations={automations} />
      </DialogContent>
    </Dialog>
  );
}
