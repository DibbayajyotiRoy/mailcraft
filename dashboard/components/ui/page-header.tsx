import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-1 text-xs text-muted">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-center gap-1">
            {it.href ? <Link data-ui="link" href={it.href} className="hover:text-fg hover:underline">{it.label}</Link> : <span aria-current="page" className="text-fg">{it.label}</span>}
            {i < items.length - 1 && <ChevronRight aria-hidden className="size-3" />}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Every page: breadcrumb (detail pages) -> title -> one-line description -> right-aligned primary action. */
export function PageHeader({ title, description, action, breadcrumb, className }: {
  title: ReactNode; description?: ReactNode; action?: ReactNode; breadcrumb?: { label: string; href?: string }[]; className?: string;
}) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-border pb-4", className)}>
      <div className="min-w-0">
        {breadcrumb && <Breadcrumb items={breadcrumb} />}
        <h1 className="text-lg font-semibold tracking-[-.01em]">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}
