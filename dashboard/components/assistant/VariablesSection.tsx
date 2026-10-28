"use client";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import type { Proposal } from "@/lib/assistant/types";

type Vars = NonNullable<Proposal["variables"]>;
const FOLD = 8;

/** True when any variable still holds a stand-in a person must replace (Apply is blocked until then). */
export const hasPlaceholders = (v?: Proposal["variables"]) => !!v?.some((x) => x.placeholder);

/** What a template send will fill in: name = value per variable, stand-ins flagged, a pencil that prefills a "change X to " message. */
export function VariablesSection({ variables, onTweak }: { variables: Vars; onTweak?: (draft: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? variables : variables.slice(0, FOLD), open = variables.filter((v) => v.placeholder);
  return (
    <section aria-label="Variables" className="space-y-1.5">
      <h4 className="text-xs font-medium text-muted">Variables</h4>
      <dl className="space-y-1 text-sm">
        {shown.map((v) => (
          <div key={v.name} className={cn("flex items-start gap-2 rounded-md px-2.5 py-1", v.placeholder ? "bg-warn-bg text-warn" : "bg-surface-2")}>
            <dt className="shrink-0 font-mono text-xs leading-6">{v.name}</dt>
            <dd className="flex min-w-0 flex-1 items-start gap-2">
              <span aria-hidden className={cn("leading-6", !v.placeholder && "text-muted")}>=</span>
              <span className={cn("min-w-0 flex-1 break-words leading-6", !v.value && "text-muted")}>{v.value || "(empty)"}</span>
              {v.placeholder && <Badge size="sm" tone="warn" className="mt-0.5 shrink-0">needs a value</Badge>}
              {onTweak && (
                <button type="button" aria-label={`Change ${v.name}`} onClick={() => onTweak(`Change ${v.name} to `)}
                  className="-my-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-bg hover:text-fg pointer-coarse:size-11">
                  <Pencil aria-hidden className="size-3.5" />
                </button>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {variables.length > FOLD && <button type="button" onClick={() => setAll(!all)} className="text-xs text-accent underline underline-offset-2">{all ? "Show less" : `Show all ${variables.length}`}</button>}
      {open.length > 0 && (
        <p role="alert" className="break-words rounded-md bg-warn-bg px-3 py-2 text-sm text-warn">
          Replace {open.map((v) => v.value).join(", ")} before sending: tell me what to use, e.g. “change {open[0].name} to …”.
        </p>
      )}
    </section>
  );
}
