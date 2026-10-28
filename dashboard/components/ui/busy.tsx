"use client";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { cn } from "@/lib/cn";

/**
 * A wait of 2s or more: a 20px thinking orb beside its label. The orb follows `data-theme` / prefers-color-scheme and draws a still
 * frame under prefers-reduced-motion by itself (thinking-orbs 0.3.x), so neither is wired here. It is decorative: the label says it.
 */
export function Busy({ state, label, className }: { state: OrbState; label: string; className?: string }) {
  return (
    <span role="status" aria-live="polite" className={cn("inline-flex items-center gap-2 text-sm text-muted", className)}>
      <ThinkingOrb state={state} size={20} aria-hidden />
      {label}
    </span>
  );
}
