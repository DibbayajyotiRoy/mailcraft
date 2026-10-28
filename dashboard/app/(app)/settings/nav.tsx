"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

export const SECTIONS = [["general", "General"], ["delivery", "Delivery"], ["llm", "LLM provider"], ["ai-writing", "AI writing"], ["policy", "Send policy"], ["kill-switch", "Kill switch"]] as const;

/** Sticky left list on desktop, scrolling chip row on mobile. Plain in-page anchors (work without JS); the current section is marked aria-current. */
export function SettingsNav() {
  const [cur, setCur] = useState<string>(SECTIONS[0][0]);
  useEffect(() => {
    const io = new IntersectionObserver((es) => { const v = es.find((e) => e.isIntersecting); if (v) setCur(v.target.id); }, { rootMargin: "-20% 0px -70% 0px" });
    SECTIONS.forEach(([id]) => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);
  return (
    <nav aria-label="Settings sections" className="sticky top-14 z-10 -mx-4 overflow-x-auto bg-bg px-4 py-2 lg:top-6 lg:mx-0 lg:self-start lg:px-0 lg:py-0">
      <ul className="flex gap-1 lg:flex-col">
        {SECTIONS.map(([id, label]) => (
          <li key={id} className="shrink-0">
            <a href={`#${id}`} aria-current={cur === id ? "location" : undefined}
              className={cn("flex h-9 items-center whitespace-nowrap rounded-sm px-3 text-sm font-medium text-muted transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 hover:text-fg pointer-coarse:h-11",
                cur === id && "bg-accent-soft text-fg")}>{label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
