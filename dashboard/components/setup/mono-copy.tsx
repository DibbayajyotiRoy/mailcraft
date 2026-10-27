import { cn } from "@/lib/cn";
import { CopyButton } from "@/components/ui/copy";

/** Wrapped mono value + copy button (page-local: ui/CopyField scrolls sideways, this wraps so long DNS values stay readable at 390px). */
export function MonoCopy({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn("flex items-start gap-1 rounded-sm border border-border bg-surface-2 pl-3", className)}>
      <code className="min-w-0 flex-1 select-all py-1.5 text-[12.5px] leading-5 [overflow-wrap:anywhere]">{value}</code>
      <CopyButton value={value} label={`Copy ${label}`} />
    </div>
  );
}
