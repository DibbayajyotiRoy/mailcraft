"use client";
import { DropdownMenu as M } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuLabel = ({ className, ...p }: ComponentProps<typeof M.Label>) => <M.Label className={cn("px-2 py-1.5 text-xs text-muted", className)} {...p} />;
export const DropdownMenuSeparator = () => <M.Separator className="-mx-1 my-1 h-px bg-border" />;

export function DropdownMenuContent({ className, align = "end", ...p }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content align={align} sideOffset={6} className={cn("z-50 min-w-44 rounded-md border border-border bg-bg p-1 shadow-pop data-[state=open]:animate-pop-in", className)} {...p} />
    </M.Portal>
  );
}
export function DropdownMenuItem({ className, destructive, ...p }: ComponentProps<typeof M.Item> & { destructive?: boolean }) {
  return <M.Item className={cn("flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[highlighted]:bg-surface-2 pointer-coarse:min-h-11 [&_svg]:size-4", destructive && "text-bad", className)} {...p} />;
}
