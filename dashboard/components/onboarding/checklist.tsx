import Link from "next/link";
import { Check } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";

export type SetupStep = { id: string; title: string; why: string; href: string; cta: string; done: boolean; time?: string };

/** "Get set up" card. Steps are derived by the caller from API state; the first undone step is highlighted as the next action. */
export function SetupChecklist({ steps, title = "Get set up" }: { steps: SetupStep[]; title?: string }) {
  const n = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.id;
  return (
    <Card aria-labelledby="setup-title">
      <CardHeader title={<span id="setup-title">{title}</span>} description={`${n} of ${steps.length} done`} />
      <CardBody>
        <div role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={n}
          className="mb-4 h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-base)]" style={{ width: `${(n / steps.length) * 100}%` }} />
        </div>
        <ol className="grid gap-3">
          {steps.map((s, i) => (
            <li key={s.id} className="flex items-start gap-3">
              <span aria-hidden className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-xs font-medium",
                s.done ? "border-ok bg-ok-bg text-ok" : "border-border-strong text-muted")}>{s.done ? <Check className="size-3.5" /> : i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium", s.done && "text-muted line-through")}>{s.title}{s.done && <span className="sr-only"> (done)</span>}</p>
                {!s.done && <p className="text-sm text-muted">{s.why}{s.time && ` About ${s.time}.`}</p>}
              </div>
              {!s.done && <Link href={s.href} className={buttonVariants({ variant: s.id === next ? "primary" : "secondary", size: "sm" })}>{s.cta}</Link>}
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}
