import { cn } from "@/lib/cn";

export type StepStat = { entered: number; completed: number; failed: number; active: number; exited: number };
export const NO_STAT: StepStat = { entered: 0, completed: 0, failed: 0, active: 0, exited: 0 };
const ITEMS: [keyof StepStat, string][] = [["entered", "Entered"], ["active", "Active"], ["completed", "Completed"], ["exited", "Exited"], ["failed", "Failed"]];

/** Per-step counts over every run (GET /v1/automations/{id} `stats`). Failed turns red only when it is non-zero; the word stays either way. */
export function StepStats({ stat = NO_STAT, className }: { stat?: StepStat; className?: string }) {
  return (
    <div role="group" aria-label="Contacts at this step" className={className}>
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
        {ITEMS.map(([k, label]) => (
          <div key={k} className="flex items-baseline gap-1">
            <dt className="text-muted">{label}</dt>
            <dd className={cn("font-medium tabular-nums", k === "failed" && stat[k] > 0 && "text-bad")}>{stat[k]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
