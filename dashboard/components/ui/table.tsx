import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Semantic table. `stack` (default) collapses rows into labelled cards below 768px: give each TD a `label`. */
export function Table({ className, stack = true, caption, children, ...p }: ComponentProps<"table"> & { stack?: boolean; caption?: string }) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border">
      <table data-stack={stack || undefined} className={cn("w-full border-collapse text-sm", className)} {...p}>
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}
export const THead = ({ className, ...p }: ComponentProps<"thead">) => <thead className={cn("bg-surface md:sticky md:top-0", className)} {...p} />;
export const TBody = (p: ComponentProps<"tbody">) => <tbody {...p} />;
export const TR = ({ className, ...p }: ComponentProps<"tr">) => <tr className={cn("border-b border-border last:border-0 hover:bg-surface-2 transition-colors duration-[var(--dur-fast)]", className)} {...p} />;
export const TH = ({ className, ...p }: ComponentProps<"th">) => <th scope="col" className={cn("h-9 border-b border-border-strong px-3 text-left text-xs font-medium text-muted", className)} {...p} />;
export const TD = ({ className, label, num, ...p }: ComponentProps<"td"> & { label?: string; num?: boolean }) =>
  <td data-label={label} className={cn("h-10 px-3 align-middle max-md:h-auto max-md:px-0", num && "text-right tabular-nums", className)} {...p} />;
