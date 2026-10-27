import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Size it to the final content so there is no layout shift. Static under reduced motion (global rule). */
export function Skeleton({ className, ...p }: ComponentProps<"div">) {
  return <div aria-hidden data-ui="skeleton" className={cn("animate-shimmer rounded-sm bg-[linear-gradient(90deg,var(--surface-2)_25%,var(--surface-3)_50%,var(--surface-2)_75%)] bg-[length:200%_100%]", className)} {...p} />;
}
