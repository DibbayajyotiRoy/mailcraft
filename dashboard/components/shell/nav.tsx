"use client";
import { Activity, CheckSquare, Globe, KeyRound, Layers, Mail, Megaphone, Settings, Users, Workflow, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

type Item = { href: string; label: string; icon: LucideIcon; badge?: "approvals" };
export const NAV_GROUPS: { label: string; items: Item[] }[] = [
  { label: "Monitor", items: [{ href: "/", label: "Overview", icon: Activity }, { href: "/emails", label: "Emails", icon: Mail }, { href: "/approvals", label: "Approvals", icon: CheckSquare, badge: "approvals" }] },
  { label: "Build", items: [{ href: "/templates", label: "Templates", icon: Layers }, { href: "/broadcasts", label: "Broadcasts", icon: Megaphone }, { href: "/automations", label: "Automations", icon: Workflow }, { href: "/contacts", label: "Contacts", icon: Users }] },
  { label: "Setup", items: [{ href: "/domains", label: "Domains", icon: Globe }, { href: "/keys", label: "API keys", icon: KeyRound }, { href: "/settings", label: "Settings", icon: Settings }] },
];

/** Grouped nav with aria-current + accent bar on the active item. Used by the sidebar and the mobile drawer. */
export function Nav({ pending = 0, onNavigate, label = "Main" }: { pending?: number; onNavigate?: () => void; label?: string }) {
  const path = usePathname();
  const active = (h: string) => (h === "/" ? path === "/" : path === h || path.startsWith(`${h}/`));
  return (
    <nav aria-label={label} className="grid gap-5">
      {NAV_GROUPS.map((g) => (
        <div key={g.label}>
          <h2 className="px-3 pb-1 text-xs font-medium text-muted">{g.label}</h2>
          <ul className="grid gap-0.5">
            {g.items.map(({ href, label: l, icon: Icon, badge }) => {
              const on = active(href);
              return (
                <li key={href}>
                  <Link href={href} onClick={onNavigate} aria-current={on ? "page" : undefined}
                    className={cn("relative flex h-8 items-center gap-2.5 rounded-sm px-3 text-sm font-medium text-muted transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 hover:text-fg pointer-coarse:h-11",
                      on && "bg-accent-soft text-fg before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent before:content-['']")}>
                    <Icon aria-hidden className="size-4" />
                    <span className="flex-1">{l}</span>
                    {badge === "approvals" && pending > 0 && <span className="rounded-full bg-warn-bg px-1.5 text-xs text-warn" aria-label={`${pending} pending`}>{pending}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
