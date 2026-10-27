import { cn } from "@/lib/cn";

/** `on` = kill switch engaged (sending paused). null = unknown. Wrap in a button/trigger for the action. */
export function KillSwitchPill({ on, className }: { on: boolean | null; className?: string }) {
  const [text, cls] = on === null ? ["Status unknown", "bg-surface-2 text-muted"] : on ? ["Sending paused", "bg-bad-bg text-bad"] : ["Sending on", "bg-ok-bg text-ok"];
  return (
    <span role="status" data-ui="kill-pill" className={cn("inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium", cls, className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      <span className="sr-only">Kill switch: </span>{text}
    </span>
  );
}
