import type { LucideIcon } from "lucide-react";
import { Inbox, SearchX, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

const V = { "first-use": Inbox, "no-results": SearchX, error: TriangleAlert } as const;

export function EmptyState({ variant = "first-use", icon, title, description, action, className }: {
  variant?: keyof typeof V; icon?: LucideIcon; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string;
}) {
  const Icon = icon ?? V[variant];
  return (
    <div className={cn("flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong px-6 py-12 text-center", className)}>
      <span aria-hidden className={cn("grid size-10 place-items-center rounded-md", variant === "error" ? "bg-bad-bg text-bad" : "bg-accent-soft text-accent")}><Icon className="size-5" /></span>
      <h3 className="text-md font-medium">{title}</h3>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}
