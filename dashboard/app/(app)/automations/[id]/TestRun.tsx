"use client";
import { useActionState, useId, useState } from "react";
import { Play } from "lucide-react";
import { Button, SubmitButton } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { startTestRun, type TestRunState } from "../actions";
import { RunProgress } from "./RunProgress";

/** "Test run": one contact, right now, on drafts too. The key's env decides whether mail leaves the sandbox. */
export function TestRun({ id, name, env, liveEnabled, contacts, types }: { id: string; name: string; env: "test" | "live"; liveEnabled: boolean; contacts: string[]; types: Record<string, string> }) {
  const [s, act] = useActionState(startTestRun, {} as TestRunState);
  const [done, setDone] = useState<string | null>(null);
  const list = useId(), real = env === "live" && liveEnabled;
  const showing = s.run && s.run.run_id !== done;
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="secondary"><Play aria-hidden />Test run</Button></DialogTrigger>
      <DialogContent title={`Test ${name}`} className="max-w-xl max-h-[90dvh] overflow-y-auto"
        description="Starts one run for one contact right now, even while this is a draft. Entry rules do not apply.">
        {showing ? (
          <div className="grid gap-4">
            <RunProgress key={s.run!.run_id} automation={id} run={s.run!.run_id} types={types} />
            <div className="flex justify-end"><Button variant="secondary" onClick={() => setDone(s.run!.run_id)}>Test another contact</Button></div>
          </div>
        ) : (
          <form action={act} className="grid gap-4">
            <input type="hidden" name="id" value={id} />
            <p role="note" className={real ? "rounded-md bg-warn-bg px-3 py-2 text-sm text-warn" : "rounded-md bg-surface-2 px-3 py-2 text-sm text-muted"}>
              {real ? <>You are using a <strong>live key</strong>, so this sends a real email to the address below. The kill switch, suppressions and approvals still apply.</>
                : env === "test" ? <>You are using a <strong className="text-fg">test key</strong>: emails stay in the sandbox and nothing is delivered. Find them in Emails.</>
                : <>Your workspace has not gone live yet, so emails stay in the sandbox and nothing is delivered.</>}
            </p>
            <Field label="Contact email" error={s.error && !s.run ? s.error.message : undefined} description={s.error?.hint}>
              {(a) => <><Input {...a} name="email" type="email" required list={list} autoComplete="off" placeholder="you@example.com" /><datalist id={list}>{contacts.map((c) => <option key={c} value={c} />)}</datalist></>}
            </Field>
            <Field label="Event properties" description='Optional JSON for the event that starts the run, like {"plan": "pro"}. Filters and $event.x read it.'>
              {(a) => <Textarea {...a} name="properties" mono rows={3} placeholder="{}" />}
            </Field>
            {real && <label className="flex items-start gap-2 text-sm"><input type="checkbox" required className="mt-0.5 size-4 accent-[var(--accent)]" />I understand this can send a real email to this address.</label>}
            <div className="flex justify-end"><SubmitButton><Play aria-hidden />Start test run</SubmitButton></div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A past run's log, from the Runs table. */
export function RunPeek({ id, run, label, types }: { id: string; run: string; label: string; types: Record<string, string> }) {
  return (
    <Dialog>
      <DialogTrigger asChild><Button size="sm" variant="ghost" aria-label={`View run ${label}`}>View</Button></DialogTrigger>
      <DialogContent title="Run log" description={label} className="max-w-xl max-h-[90dvh] overflow-y-auto"><RunProgress automation={id} run={run} types={types} /></DialogContent>
    </Dialog>
  );
}
