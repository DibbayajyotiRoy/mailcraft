"use client";
import { ToggleGroup } from "radix-ui";
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SegmentOption<T extends string> = { value: T; label: string; icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }> };

/** Single-choice toggle group (role=radiogroup, roving tabindex, arrow keys). `iconOnly` shows the icon and keeps `label` as the accessible name.
 *  Use for view/device/theme/width switches; use Tabs for content panels and links for routes. */
export function SegmentedControl<T extends string>({ label, value, onValueChange, options, iconOnly, className }: {
  label: string; value: T; onValueChange: (v: T) => void; options: SegmentOption<T>[]; iconOnly?: boolean; className?: string;
}): ReactNode {
  return (
    <ToggleGroup.Root type="single" value={value} onValueChange={(v) => v && onValueChange(v as T)} aria-label={label}
      className={cn("inline-flex gap-0.5 rounded-md border border-border-strong bg-surface p-0.5", className)}>
      {options.map(({ value: v, label: l, icon: Icon }) => (
        <ToggleGroup.Item key={v} value={v} aria-label={iconOnly ? l : undefined}
          className={cn("relative grid h-7 place-items-center rounded-sm text-xs font-medium text-muted transition-colors duration-[var(--dur-fast)] after:absolute after:-inset-0.5 after:content-[''] hover:text-fg " +
            "data-[state=on]:bg-bg data-[state=on]:text-fg data-[state=on]:shadow-[0_0_0_1px_var(--border-strong)] forced-colors:data-[state=on]:bg-[Highlight] forced-colors:data-[state=on]:text-[HighlightText] pointer-coarse:h-10", iconOnly ? "w-8 pointer-coarse:w-10" : "min-w-10 px-2.5")}>
          {Icon && <Icon aria-hidden className="size-4" />}
          {!iconOnly && l}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
