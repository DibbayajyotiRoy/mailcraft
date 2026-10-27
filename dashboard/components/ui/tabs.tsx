"use client";
import { Tabs as T } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const Tabs = T.Root;
export const TabsContent = ({ className, ...p }: ComponentProps<typeof T.Content>) => <T.Content className={cn("mt-4 focus-visible:outline-offset-4", className)} {...p} />;
export const TabsList = ({ className, ...p }: ComponentProps<typeof T.List>) => <T.List className={cn("flex gap-1 overflow-x-auto border-b border-border", className)} {...p} />;
export const TabsTrigger = ({ className, ...p }: ComponentProps<typeof T.Trigger>) => (
  <T.Trigger data-ui="tab" className={cn("h-9 shrink-0 px-3 text-sm font-medium text-muted transition-colors duration-[var(--dur-base)] hover:text-fg data-[state=active]:text-fg data-[state=active]:shadow-[inset_0_-2px_0_var(--accent)] pointer-coarse:h-11", className)} {...p} />
);
