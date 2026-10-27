import { cn } from "@/lib/cn";

/** Live (red) / Test (amber). Text + dot, never colour alone. */
export function EnvChip({ env, className }: { env: "live" | "test"; className?: string }) {
  return (
    <span data-ui="env-chip" className={cn("inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-surface px-2 text-xs font-medium", className)}>
      <span aria-hidden className={cn("size-2 rounded-full", env === "live" ? "bg-live" : "bg-test")} />
      <span className="sr-only">Environment: </span>{env === "live" ? "Live" : "Test"}
    </span>
  );
}
