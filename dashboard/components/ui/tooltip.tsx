"use client";
import { Tooltip as T } from "radix-ui";
import type { ReactNode } from "react";

export const TooltipProvider = ({ children }: { children: ReactNode }) => <T.Provider delayDuration={300}>{children}</T.Provider>;

/** Wraps a focusable child (keyboard reachable). Do not put essential info only in a tooltip. */
export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-pop data-[state=delayed-open]:animate-pop-in">{content}</T.Content>
      </T.Portal>
    </T.Root>
  );
}
