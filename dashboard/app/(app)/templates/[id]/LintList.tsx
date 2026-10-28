import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { lintSummary, type Lint } from "./util";

/** Compact lint results for the editor; errors first. Same wording as the Lint tab. */
export function LintList({ lint }: { lint: Lint[] }) {
  const sum = lintSummary(lint);
  return (
    <section aria-label="Lint results" className="rounded-lg border border-border">
      <h3 className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-medium">
        Lint
        {sum.errors > 0 && <Badge tone="bad" size="sm">{sum.errors} {sum.errors === 1 ? "error" : "errors"}</Badge>}
        {sum.warnings > 0 && <Badge tone="warn" size="sm">{sum.warnings} {sum.warnings === 1 ? "warning" : "warnings"}</Badge>}
      </h3>
      {!lint.length ? (
        <p className="flex items-center gap-2 px-3 py-3 text-sm text-ok"><CircleCheck aria-hidden className="size-4" />All checks passed.</p>
      ) : (
        <ul className="max-h-48 divide-y divide-border overflow-y-auto" tabIndex={0} aria-label="Lint issues">
          {[...lint].sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error")).map((l, i) => {
            const err = l.severity === "error";
            return (
              <li key={i} className="flex gap-2.5 px-3 py-2">
                {err ? <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" /> : <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />}
                <div className="min-w-0">
                  <p className="text-sm"><span className="sr-only">{err ? "Error: " : "Warning: "}</span>{l.message}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">{l.rule && <code>{l.rule}</code>}{l.path && <code>{l.path}</code>}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
