import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...p }: ComponentProps<"section">) {
  return <section className={cn("rounded-lg border border-border bg-surface", className)} {...p} />;
}
export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex items-start justify-between gap-4 border-b border-border px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="text-md font-semibold leading-6">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
export const CardBody = ({ className, ...p }: ComponentProps<"div">) => <div className={cn("p-4", className)} {...p} />;
export const CardFooter = ({ className, ...p }: ComponentProps<"footer">) => <footer className={cn("flex items-center justify-end gap-2 border-t border-border px-4 py-3", className)} {...p} />;
