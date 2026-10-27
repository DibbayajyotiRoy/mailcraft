"use client";
import { useState } from "react";
import { Eye, EyeOff, TriangleAlert } from "lucide-react";
import { login } from "@/lib/actions";
import { Button, SubmitButton } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

/** `err` is the `code|message|hint` the login action redirects back with; shown under the field it concerns. */
export function LoginForm({ err, defaultBase }: { err?: string; defaultBase: string }) {
  const [code, message, hint] = err ? err.split("|") : [];
  const [show, setShow] = useState(false);
  const urlProblem = code === "invalid_url" || code === "unreachable" || code === "bad_response";
  const human = code === "unauthenticated" || code === "forbidden" || code?.startsWith("http_40") ? "That API key was not accepted. Check it is complete and has not been revoked." : message;
  const detail = (
    <span className="grid gap-0.5">
      <span className="inline-flex items-center gap-1.5"><TriangleAlert aria-hidden className="size-3.5 shrink-0" />{human}</span>
      {hint && <span className="font-normal">{hint}</span>}
      <span className="font-mono text-[11px] font-normal opacity-80">{code}</span>
    </span>
  );
  return (
    <form action={login} className="grid gap-4">
      <Field label="API key" description="Starts with mc_test_ or mc_live_." error={err && !urlProblem ? detail : undefined}>
        {(a) => (
          <div className="relative">
            <Input {...a} name="key" type={show ? "text" : "password"} mono required autoFocus autoComplete="off" spellCheck={false} placeholder="mc_test_…" className="pr-10" />
            <Button variant="ghost" size="icon" className="absolute right-0 top-0 h-full" aria-label={show ? "Hide API key" : "Show API key"} aria-pressed={show} onClick={() => setShow(!show)}>
              {show ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            </Button>
          </div>
        )}
      </Field>
      <details open={urlProblem} className="group text-sm">
        <summary className="inline-flex min-h-6 cursor-pointer list-none items-center text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">Self-hosted? Use a custom API URL</summary>
        <div className="mt-3">
          <Field label="API base URL" error={err && urlProblem ? detail : undefined}>
            {(a) => <Input {...a} name="base" type="url" mono required defaultValue={defaultBase} />}
          </Field>
        </div>
      </details>
      {/* base is required by the action; when the disclosure is closed its input is still in the DOM, so it submits the default. */}
      <SubmitButton size="lg" className="w-full">Sign in</SubmitButton>
    </form>
  );
}
