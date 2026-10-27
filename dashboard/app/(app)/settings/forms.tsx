"use client";
// Per-card forms for Settings. Each saves on its own (never one giant form), shows a dirty hint, toasts on success.
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { SubmitButton } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { ErrorState } from "@/components/ui/error-state";
import { toast } from "@/components/ui/toast";
import { savePolicy, saveGeneral, saveProvider, type Result } from "./actions";

type Act = (p: Result, d: FormData) => Promise<Result>;

/** A titled card that is its own <form>: footer = dirty hint + Save. Result toast + inline error. */
export function SettingsForm({ id, title, description, action, canEdit = true, children }: {
  id: string; title: string; description: string; action: Act; canEdit?: boolean; children: ReactNode;
}) {
  const [s, act] = useActionState(action, {} as Result);
  const [dirty, setDirty] = useState(false);
  const shown = useRef<Result>(undefined);
  useEffect(() => {
    if (s.ok && shown.current !== s) { shown.current = s; toast.success(s.ok); setDirty(false); }
  }, [s]);
  return (
    <Card id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20">
      <form action={act} onChange={() => setDirty(true)}>
        <CardHeader title={<span id={`${id}-h`}>{title}</span>} description={description} />
        <CardBody className="grid gap-4">
          <fieldset disabled={!canEdit} className="grid min-w-0 gap-4 border-0 p-0">{children}</fieldset>
          {!canEdit && <p className="text-sm text-muted">Changing this needs an admin key.</p>}
          {s.error && <ErrorState error={{ code: "not_saved", message: s.error }} />}
        </CardBody>
        <CardFooter>
          <span aria-live="polite" className="mr-auto text-xs text-muted">
            {dirty ? "Unsaved changes" : s.ok ? <span className="inline-flex items-center gap-1 text-ok"><Check aria-hidden className="size-3.5" />Saved</span> : ""}
          </span>
          <SubmitButton disabled={!canEdit}>Save</SubmitButton>
        </CardFooter>
      </form>
    </Card>
  );
}

export function GeneralCard({ from, replyTo, canEdit }: { from: string; replyTo: string; canEdit: boolean }) {
  return (
    <SettingsForm id="general" title="General" description="Defaults for emails that do not set their own sender." action={saveGeneral} canEdit={canEdit}>
      <Field label="Default From" description="Must be on a verified domain, e.g. Acme <hello@mail.acme.com>.">
        {(a) => <Input {...a} name="default_from" defaultValue={from} placeholder="Acme <hello@mail.example.com>" autoComplete="off" />}
      </Field>
      <Field label="Default Reply-To" description="Where replies go. Leave empty to reply to the From address.">
        {(a) => <Input {...a} name="reply_to" type="email" defaultValue={replyTo} placeholder="support@example.com" autoComplete="off" />}
      </Field>
    </SettingsForm>
  );
}

export const KINDS = [["openrouter", "OpenRouter"], ["openai", "OpenAI-compatible"], ["ollama", "Ollama (local)"]] as const;

export function ProviderCard({ kind, model, baseUrl, keySet, canEdit }: { kind: string; model: string; baseUrl: string; keySet: boolean; canEdit: boolean }) {
  const [k, setK] = useState(kind || "openrouter");
  const known = KINDS.some(([v]) => v === k);
  return (
    <SettingsForm id="llm" title="LLM provider" description="Writes the copy when an agent asks for an AI-drafted email. The key is write-only: it is never shown again." action={saveProvider} canEdit={canEdit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider">
          {(a) => (
            <Select {...a} name="kind" value={k} onChange={(e) => setK(e.target.value)}>
              {!known && <option value={k}>{k}</option>}
              {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Model" description="Leave empty for the provider's default.">
          {(a) => <Input {...a} name="model" mono defaultValue={model} placeholder="anthropic/claude-sonnet-4" autoComplete="off" />}
        </Field>
      </div>
      <Field label="Base URL" description={k === "openrouter" ? "Optional. OpenRouter's address is built in." : "Where the provider's API lives."}>
        {(a) => <Input {...a} name="base_url" type="url" mono defaultValue={baseUrl} placeholder={k === "ollama" ? "http://localhost:11434" : "https://api.example.com/v1"} autoComplete="off" />}
      </Field>
      <Field label={<span className="inline-flex items-center gap-2">API key {keySet && <span className="inline-flex items-center gap-1 rounded-full bg-ok-bg px-2 text-xs text-ok"><Check aria-hidden className="size-3" />Key set</span>}</span>}
        description={keySet ? "Leave blank to keep the stored key. Type a new one to replace it." : "Not set yet. Paste the provider's key."}>
        {(a) => <Input {...a} name="api_key" type="password" mono autoComplete="new-password" placeholder={keySet ? "••••••••••••" : "sk-…"} />}
      </Field>
    </SettingsForm>
  );
}

export const POLICIES = [
  ["auto", "Send automatically", "Emails go out as soon as they pass the safety checks."],
  ["needs_approval", "Hold for approval", "A person approves each email in Approvals before it is sent."],
  ["blocked", "Block", "Nothing is sent by default. Keys with their own policy are unaffected."],
] as const;

export function PolicyCard({ send, keys, canEdit }: { send: string; keys: { name?: string; key_id: string; policy?: { send?: string } }[]; canEdit: boolean }) {
  const [v, setV] = useState(send || "auto");
  const cur = POLICIES.find(([p]) => p === v) ?? POLICIES[0];
  return (
    <SettingsForm id="policy" title="Send policy" description="What happens to an email when its key has no policy of its own." action={savePolicy} canEdit={canEdit}>
      <Field label="Default for sending">
        {(a) => <Select {...a} name="send" value={v} onChange={(e) => setV(e.target.value)}>{POLICIES.map(([p, l]) => <option key={p} value={p}>{l}</option>)}</Select>}
      </Field>
      <p className="rounded-md bg-surface-2 px-3 py-2 text-sm" data-testid="policy-plain">
        In plain words: <strong>{cur[1].toLowerCase()}.</strong> {cur[2]}
      </p>
      {keys.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-sm font-medium">Keys with their own policy</h3>
          <ul className="grid gap-1 text-sm">
            {keys.map((k) => (
              <li key={k.key_id} className="flex items-center justify-between gap-3 rounded-sm border border-border px-3 py-1.5">
                <span className="truncate">{k.name ?? k.key_id}</span>
                <span className="text-muted">{POLICIES.find(([p]) => p === k.policy?.send)?.[1] ?? "Uses the default"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-muted">Agents can propose changes to these; a person approves them.</p>
        </div>
      )}
    </SettingsForm>
  );
}
